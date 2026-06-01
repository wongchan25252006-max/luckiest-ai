const { db } = require('../database');

const GRAPH = 'https://graph.facebook.com/v21.0';

function getConnection(userId) {
  return db.prepare(
    `SELECT * FROM platform_connections WHERE user_id = ? AND platform = 'instagram' AND active = 1 LIMIT 1`
  ).get(userId);
}

async function sendMessage({ userId, externalId, body }) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('No Instagram connection');
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(conn.access_token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: externalId },
      message: { text: body }
    })
  });
  if (!res.ok) throw new Error(`Instagram send failed: ${res.status} ${await res.text()}`);
}

async function publishPost({ userId, caption, imageUrl }) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('No Instagram connection');
  if (!imageUrl) throw new Error('Instagram posts require an image');
  const igId = conn.account_id;
  const token = conn.access_token;

  const container = await fetch(`${GRAPH}/${igId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: token })
  });
  if (!container.ok) throw new Error(`IG container failed: ${await container.text()}`);
  const { id: creationId } = await container.json();

  const publish = await fetch(`${GRAPH}/${igId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: token })
  });
  if (!publish.ok) throw new Error(`IG publish failed: ${await publish.text()}`);
  return publish.json();
}

async function replyToComment({ userId, commentId, body }) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('No Instagram connection');
  const res = await fetch(`${GRAPH}/${commentId}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: body, access_token: conn.access_token })
  });
  if (!res.ok) throw new Error(`IG comment reply failed: ${await res.text()}`);
}

module.exports = { sendMessage, publishPost, replyToComment, getConnection };
