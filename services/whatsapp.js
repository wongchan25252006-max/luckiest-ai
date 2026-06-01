const { db } = require('../database');

const GRAPH = 'https://graph.facebook.com/v21.0';

function getConnection(userId) {
  return db.prepare(
    `SELECT * FROM platform_connections WHERE user_id = ? AND platform = 'whatsapp' AND active = 1 LIMIT 1`
  ).get(userId);
}

function tokenFor(userId) {
  const conn = getConnection(userId);
  return {
    phoneId: conn?.account_id || process.env.WHATSAPP_PHONE_NUMBER_ID,
    token: conn?.access_token || process.env.WHATSAPP_TOKEN
  };
}

async function sendMessage({ userId, externalId, body }) {
  const { phoneId, token } = tokenFor(userId);
  if (!phoneId || !token) throw new Error('WhatsApp not configured');
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: externalId, type: 'text', text: { body }
    })
  });
  if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status} ${await res.text()}`);
}

async function downloadMedia({ userId, mediaId }) {
  const { token } = tokenFor(userId);
  if (!token) throw new Error('WhatsApp not configured');
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!meta.ok) throw new Error('media metadata failed');
  const { url } = await meta.json();
  const file = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!file.ok) throw new Error('media download failed');
  return Buffer.from(await file.arrayBuffer());
}

async function publishPost() {
  throw new Error('WhatsApp does not support feed posts');
}

module.exports = { sendMessage, publishPost, downloadMedia, getConnection };
