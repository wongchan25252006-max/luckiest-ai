const { db } = require('../database');
const TelegramBot = require('node-telegram-bot-api');
const { transcribe } = require('./transcription');

const bots = new Map();

function getConnection(userId) {
  return db.prepare(
    `SELECT * FROM platform_connections WHERE user_id = ? AND platform = 'telegram' AND active = 1 LIMIT 1`
  ).get(userId);
}

function getBot(userId, token) {
  const t = token || getConnection(userId)?.access_token;
  if (!t) return null;
  if (bots.has(t)) return bots.get(t);
  const bot = new TelegramBot(t, { polling: false });
  bots.set(t, bot);
  return bot;
}

async function downloadFile(bot, fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('telegram file download failed');
  return Buffer.from(await res.arrayBuffer());
}

function startPollingForConnection(conn, onMessage) {
  const bot = new TelegramBot(conn.access_token, { polling: true });
  bots.set(conn.access_token, bot);

  bot.on('message', async (msg) => {
    try {
      const customerName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ');
      const customerHandle = msg.from?.username ? '@' + msg.from.username : null;
      let profilePic = null;
      try {
        const photos = await bot.getUserProfilePhotos(msg.from.id, { limit: 1 });
        if (photos?.photos?.length) {
          const small = photos.photos[0].slice(-1)[0];
          const file = await bot.getFile(small.file_id);
          profilePic = `https://api.telegram.org/file/bot${conn.access_token}/${file.file_path}`;
        }
      } catch {}

      const payload = {
        userId: conn.user_id,
        platform: 'telegram',
        externalId: String(msg.chat.id),
        customerName, customerHandle, profilePic
      };

      if (msg.voice || msg.audio) {
        const fileId = (msg.voice || msg.audio).file_id;
        let transcript = null;
        try {
          const buf = await downloadFile(bot, fileId);
          transcript = await transcribe(buf, 'voice.ogg');
        } catch (e) { console.error('[telegram] voice fetch failed', e.message); }
        await onMessage({
          ...payload,
          body: transcript || '[voice message]',
          mediaType: 'voice', transcript
        });
      } else if (msg.photo) {
        const last = msg.photo.slice(-1)[0];
        const file = await bot.getFile(last.file_id);
        const url = `https://api.telegram.org/file/bot${conn.access_token}/${file.file_path}`;
        await onMessage({ ...payload, body: msg.caption || '[photo]', mediaType: 'image', mediaUrl: url });
      } else {
        await onMessage({ ...payload, body: msg.text || msg.caption || '' });
      }
    } catch (err) {
      console.error('[telegram] handler error', err.message);
    }
  });
  bot.on('polling_error', (err) => console.error('[telegram] polling error', err.message));
  console.log(`[telegram] polling started for user ${conn.user_id}`);
}

async function sendMessage({ userId, externalId, body }) {
  const bot = getBot(userId);
  if (!bot) throw new Error('No Telegram bot connected');
  await bot.sendMessage(externalId, body);
}

async function sendVoice({ userId, externalId, audioBuffer }) {
  const bot = getBot(userId);
  if (!bot) throw new Error('No Telegram bot connected');
  await bot.sendVoice(externalId, audioBuffer);
}

async function publishPost({ userId, caption, imagePath, videoPath }) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('No Telegram bot connected');
  const channelId = conn.extra ? JSON.parse(conn.extra).channel_id : null;
  if (!channelId) throw new Error('Set a Telegram channel_id in the connection extras');
  const bot = getBot(userId, conn.access_token);
  if (videoPath) {
    await bot.sendVideo(channelId, videoPath, { caption });
  } else if (imagePath) {
    await bot.sendPhoto(channelId, imagePath, { caption });
  } else {
    await bot.sendMessage(channelId, caption);
  }
}

function bootstrapAll(onMessage) {
  const conns = db.prepare(
    `SELECT * FROM platform_connections WHERE platform = 'telegram' AND active = 1`
  ).all();
  for (const c of conns) {
    try { startPollingForConnection(c, onMessage); }
    catch (e) { console.error('[telegram] bootstrap failed', e.message); }
  }
}

module.exports = { sendMessage, sendVoice, publishPost, getConnection, startPollingForConnection, bootstrapAll };
