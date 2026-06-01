const express = require('express');
const { db } = require('../database');
const { handleIncomingMessage, handleIncomingComment } = require('../services/messaging');
const whatsapp = require('../services/whatsapp');
const { transcribe } = require('../services/transcription');

const router = express.Router();

function findUserForPage(pageId) {
  const conn = db.prepare(
    `SELECT user_id FROM platform_connections
     WHERE platform IN ('facebook', 'instagram') AND account_id = ? AND active = 1`
  ).get(pageId);
  return conn?.user_id;
}

function findUserForWhatsApp(phoneNumberId) {
  const conn = db.prepare(
    `SELECT user_id FROM platform_connections WHERE platform = 'whatsapp' AND account_id = ? AND active = 1`
  ).get(phoneNumberId);
  return conn?.user_id;
}

router.get('/meta', (req, res) => {
  const verify = process.env.META_VERIFY_TOKEN || 'luckiest-ai-verify';
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verify) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

router.post('/meta', async (req, res) => {
  res.sendStatus(200);
  const body = req.body || {};
  try {
    for (const entry of body.entry || []) {
      const pageId = entry.id;
      const userId = findUserForPage(pageId);
      if (!userId) continue;
      const platform = body.object === 'instagram' ? 'instagram' : 'facebook';

      for (const m of entry.messaging || []) {
        if (m.message && m.message.text) {
          await handleIncomingMessage({
            userId, platform,
            externalId: m.sender.id, body: m.message.text
          });
        }
      }

      for (const change of entry.changes || []) {
        if ((change.field === 'comments' || change.field === 'feed') && change.value) {
          const v = change.value;
          if (v.item === 'comment' || change.field === 'comments') {
            const commentId = v.comment_id || v.id;
            const postId = v.post_id || v.media?.id || (commentId ? commentId.split('_')[0] : '');
            const text = v.message || v.text;
            if (!text || !commentId) continue;
            const commenterName = v.from?.name || v.from?.username;
            const commenterHandle = v.from?.username ? '@' + v.from.username : null;
            await handleIncomingComment({
              userId, platform, postId, commentId,
              commenterName, commenterHandle, body: text
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[webhook/meta]', err.message);
  }
});

router.get('/whatsapp', (req, res) => {
  const verify = process.env.WHATSAPP_VERIFY_TOKEN || 'luckiest-ai-whatsapp';
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verify) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

router.post('/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        const userId = findUserForWhatsApp(phoneNumberId);
        if (!userId) continue;
        for (const msg of value.messages || []) {
          const profile = value.contacts?.[0]?.profile?.name;
          const base = { userId, platform: 'whatsapp', externalId: msg.from, customerName: profile, customerHandle: msg.from };

          if (msg.type === 'text') {
            await handleIncomingMessage({ ...base, body: msg.text.body });
          } else if (msg.type === 'audio' || msg.type === 'voice') {
            const mediaId = (msg.audio || msg.voice).id;
            let transcript = null;
            try {
              const buf = await whatsapp.downloadMedia({ userId, mediaId });
              transcript = await transcribe(buf, 'whatsapp.ogg');
            } catch (e) { console.error('[whatsapp] voice fetch failed', e.message); }
            await handleIncomingMessage({
              ...base, body: transcript || '[voice message]',
              mediaType: 'voice', transcript
            });
          } else if (msg.type === 'image') {
            await handleIncomingMessage({
              ...base,
              body: msg.image?.caption || '[image]',
              mediaType: 'image', mediaUrl: null
            });
          } else if (msg.type === 'button' || msg.type === 'interactive') {
            const text = msg.button?.text || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
            await handleIncomingMessage({ ...base, body: text });
          }
        }
      }
    }
  } catch (err) {
    console.error('[webhook/whatsapp]', err.message);
  }
});

module.exports = router;
