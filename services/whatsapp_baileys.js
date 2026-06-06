const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const { query } = require('../database');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SESS_ROOT = path.join(DATA_DIR, 'whatsapp-baileys');
if (!fs.existsSync(SESS_ROOT)) fs.mkdirSync(SESS_ROOT, { recursive: true });

const sessions = new Map();

const sink = () => {};
function makeLogger() {
  const self = {
    level: 'silent',
    trace: sink, debug: sink, info: sink, warn: sink,
    error: (...a) => console.error('[baileys]', ...a),
    fatal: (...a) => console.error('[baileys-fatal]', ...a),
    child() { return self; }
  };
  return self;
}

function sessionDir(connectionId) {
  return path.join(SESS_ROOT, String(connectionId));
}

async function startSession(connection, onMessage) {
  const id = Number(connection.id);
  const existing = sessions.get(id);
  if (existing && existing.status !== 'disconnected' && existing.status !== 'logged_out') return existing;

  const entry = { sock: null, qrDataUrl: null, phone: null, status: 'connecting', userId: connection.user_id, connectionId: id };
  sessions.set(id, entry);

  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: makeLogger(),
    browser: Browsers.appropriate ? Browsers.appropriate('Luckiest AI') : ['Luckiest AI', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false
  });

  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection: connState, lastDisconnect, qr } = update;

    if (qr) {
      try {
        entry.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
        entry.status = 'qr';
      } catch (e) { console.error('[baileys] qr encode failed:', e.message); }
    }

    if (connState === 'open') {
      entry.status = 'connected';
      entry.qrDataUrl = null;
      entry.phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      try {
        await query(
          `UPDATE platform_connections SET account_id = $1, active = 1 WHERE id = $2`,
          [entry.phone || `baileys-${id}`, id]
        );
      } catch (e) { console.error('[baileys] update conn failed:', e.message); }
      console.log(`[baileys] connection ${id} OPEN as +${entry.phone}`);
    }

    if (connState === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.payload?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      entry.status = loggedOut ? 'logged_out' : 'disconnected';
      entry.sock = null;
      entry.qrDataUrl = null;
      console.log(`[baileys] connection ${id} CLOSE code=${code} loggedOut=${loggedOut}`);
      if (loggedOut) {
        sessions.delete(id);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        try { await query(`UPDATE platform_connections SET active = 0 WHERE id = $1`, [id]); } catch {}
      } else {
        setTimeout(() => {
          startSession(connection, onMessage).catch(e => console.error('[baileys] reconnect failed:', e.message));
        }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const remoteJid = m.key.remoteJid || '';
      if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) continue;
      const phone = remoteJid.split('@')[0];
      const msg = m.message;
      let body = msg.conversation
        || msg.extendedTextMessage?.text
        || msg.imageMessage?.caption
        || msg.videoMessage?.caption
        || msg.documentMessage?.caption
        || '';
      let mediaType = null;
      if (!body && msg.audioMessage) { body = '[voice message]'; mediaType = 'voice'; }
      else if (!body && msg.imageMessage) { body = '[image]'; mediaType = 'image'; }
      else if (!body && msg.videoMessage) { body = '[video]'; mediaType = 'video'; }
      else if (!body && msg.stickerMessage) { body = '[sticker]'; mediaType = 'sticker'; }
      if (!body) continue;

      const pushName = m.pushName || phone;
      try {
        await onMessage({
          userId: entry.userId,
          platform: 'whatsapp_baileys',
          externalId: phone,
          customerName: pushName,
          customerHandle: '+' + phone,
          body,
          mediaType
        });
      } catch (e) { console.error('[baileys] handleIncoming failed:', e.message); }
    }
  });

  return entry;
}

function getSession(connectionId) {
  return sessions.get(Number(connectionId));
}

function getStatus(connectionId) {
  const entry = sessions.get(Number(connectionId));
  if (!entry) return { status: 'inactive' };
  return {
    status: entry.status,
    qr: entry.qrDataUrl,
    phone: entry.phone
  };
}

async function disconnectSession(connectionId) {
  const id = Number(connectionId);
  const entry = sessions.get(id);
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch {}
    try { entry.sock.end?.(); } catch {}
    sessions.delete(id);
  }
  try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); } catch {}
}

async function sendMessage({ userId, externalId, body }) {
  const r = await query(
    `SELECT * FROM platform_connections WHERE user_id = $1 AND platform = 'whatsapp_baileys' AND active = 1 LIMIT 1`,
    [userId]
  );
  const conn = r.rows[0];
  if (!conn) throw new Error('No WhatsApp (Baileys) connection');
  const entry = sessions.get(Number(conn.id));
  if (!entry || entry.status !== 'connected' || !entry.sock) throw new Error('WhatsApp socket not connected');
  const digits = String(externalId).replace(/\D/g, '');
  const jid = String(externalId).includes('@') ? externalId : `${digits}@s.whatsapp.net`;
  await entry.sock.sendMessage(jid, { text: body });
}

async function bootstrapAll(onMessage) {
  const r = await query(
    `SELECT * FROM platform_connections WHERE platform = 'whatsapp_baileys' AND active = 1`
  );
  for (const conn of r.rows) {
    try { await startSession(conn, onMessage); }
    catch (e) { console.error('[baileys] bootstrap', conn.id, e.message); }
  }
  console.log(`[baileys] bootstrap: ${r.rowCount} session(s)`);
}

module.exports = { startSession, getSession, getStatus, disconnectSession, sendMessage, bootstrapAll };
