const { db } = require('../database');

const GRAPH = 'https://graph.facebook.com/v21.0';

function getConnection(userId, accountId = null) {
  if (accountId) {
    return db.prepare(
      `SELECT * FROM platform_connections WHERE user_id = ? AND platform = 'facebook' AND account_id = ? AND active = 1`
    ).get(userId, accountId);
  }
  return db.prepare(
    `SELECT * FROM platform_connections WHERE user_id = ? AND platform = 'facebook' AND active = 1 LIMIT 1`
  ).get(userId);
}

async function sendMessage({ userId, externalId, body }) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('No Facebook connection');
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(conn.access_token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: externalId },
      messaging_type: 'RESPONSE',
      message: { text: body }
    })
  });
  if (!res.ok) throw new Error(`Facebook send failed: ${res.status} ${await res.text()}`);
}

async function publishPost({ userId, caption, imageUrl }) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('No Facebook page connected');
  const endpoint = imageUrl ? `${GRAPH}/${conn.account_id}/photos` : `${GRAPH}/${conn.account_id}/feed`;
  const payload = imageUrl
    ? { url: imageUrl, caption, access_token: conn.access_token }
    : { message: caption, access_token: conn.access_token };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Facebook post failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function replyToComment({ userId, commentId, body }) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('No Facebook connection');
  const res = await fetch(`${GRAPH}/${commentId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: body, access_token: conn.access_token })
  });
  if (!res.ok) throw new Error(`Facebook comment reply failed: ${await res.text()}`);
}

module.exports = { sendMessage, publishPost, replyToComment, getConnection };
