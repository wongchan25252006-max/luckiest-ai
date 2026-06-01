const { db } = require('../database');
const { generateReply } = require('./ai');
const { notify } = require('./notifications');
const facebook = require('./facebook');
const instagram = require('./instagram');
const whatsapp = require('./whatsapp');
const telegram = require('./telegram');

const senders = {
  facebook: facebook.sendMessage,
  instagram: instagram.sendMessage,
  whatsapp: whatsapp.sendMessage,
  telegram: telegram.sendMessage
};

function findOrCreateConversation({ userId, platform, externalId, customerName, customerHandle, profilePic }) {
  let conv = db.prepare(
    'SELECT * FROM conversations WHERE user_id = ? AND platform = ? AND external_id = ?'
  ).get(userId, platform, externalId);

  if (!conv) {
    const info = db.prepare(
      `INSERT INTO conversations (user_id, platform, external_id, customer_name, customer_handle, profile_pic, last_message_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, platform, externalId, customerName || null, customerHandle || null, profilePic || null, Date.now(), Date.now());
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);

    notify({
      userId,
      conversationId: conv.id,
      type: 'new_contact',
      title: `New contact: ${customerName || customerHandle || 'unknown'}`,
      body: `First time messaging you on ${platform}.`
    });
    return { conv, isNew: true };
  }

  const updates = [];
  const params = [];
  if (customerName && customerName !== conv.customer_name) { updates.push('customer_name = ?'); params.push(customerName); }
  if (profilePic && profilePic !== conv.profile_pic)       { updates.push('profile_pic = ?');   params.push(profilePic); }
  if (updates.length) {
    params.push(conv.id);
    db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id);
  }
  return { conv, isNew: false };
}

async function handleIncomingMessage({
  userId, platform, externalId, customerName, customerHandle, profilePic,
  body, mediaType, mediaUrl, transcript, externalRef
}) {
  const effectiveBody = body || transcript || (mediaType ? `[${mediaType} message]` : '');
  if (!effectiveBody.trim() && !mediaType) return;

  const { conv } = findOrCreateConversation({ userId, platform, externalId, customerName, customerHandle, profilePic });

  db.prepare(
    `INSERT INTO messages (conversation_id, direction, sender, body, media_type, media_url, transcript, ai_generated, external_ref, created_at)
     VALUES (?, 'inbound', ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(conv.id, customerName || customerHandle || 'customer', effectiveBody, mediaType || null, mediaUrl || null, transcript || null, externalRef || null, Date.now());

  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(Date.now(), conv.id);

  if (!conv.ai_enabled || conv.status === 'human' || conv.status === 'resolved') {
    notify({
      userId, conversationId: conv.id, type: 'new_message_off',
      title: `Message from ${customerName || customerHandle || 'customer'} (AI off)`,
      body: effectiveBody.slice(0, 200)
    });
    return;
  }

  if (mediaType === 'voice' && !transcript) {
    db.prepare('UPDATE conversations SET needs_human = 1, status = ? WHERE id = ?')
      .run('needs_help', conv.id);
    notify({
      userId, conversationId: conv.id, type: 'voice_message',
      title: `Voice message from ${customerName || customerHandle || 'customer'}`,
      body: `Could not transcribe (no transcription service configured). Listen and reply manually.`
    });
    return;
  }

  const { reply, needs_human, reason } = await generateReply({
    userId, conversationId: conv.id,
    incomingMessage: effectiveBody, customerName
  });

  if (needs_human) {
    db.prepare('UPDATE conversations SET needs_human = 1, status = ? WHERE id = ?')
      .run('needs_help', conv.id);
    notify({
      userId, conversationId: conv.id, type: 'needs_help',
      title: `Customer needs help: ${customerName || customerHandle || 'unknown'}`,
      body: `Reason: ${reason || 'flagged by AI'}\nLast message: ${effectiveBody.slice(0, 200)}`
    });
  }

  if (reply && reply.trim()) {
    try {
      const sender = senders[platform];
      if (sender) await sender({ userId, externalId, body: reply, externalRef });
      db.prepare(
        `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, created_at)
         VALUES (?, 'outbound', 'ai', ?, 1, ?)`
      ).run(conv.id, reply, Date.now());
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(Date.now(), conv.id);
    } catch (err) {
      console.error(`[${platform}] send failed`, err.message);
      notify({
        userId, conversationId: conv.id, type: 'send_failed',
        title: `Failed to send AI reply on ${platform}`,
        body: err.message
      });
    }
  }
}

async function handleIncomingComment({ userId, platform, postId, commentId, commenterName, commenterHandle, body }) {
  const conv = findOrCreateConversation({
    userId, platform,
    externalId: `comment:${postId}:${commenterHandle || commentId}`,
    customerName: commenterName, customerHandle: commenterHandle
  }).conv;

  db.prepare(
    `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, external_ref, created_at)
     VALUES (?, 'inbound', ?, ?, 0, ?, ?)`
  ).run(conv.id, commenterName || commenterHandle || 'commenter', body, commentId, Date.now());
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(Date.now(), conv.id);

  if (!conv.ai_enabled) return;

  const { reply, needs_human, reason } = await generateReply({
    userId, conversationId: conv.id,
    incomingMessage: body, customerName: commenterName
  });

  if (needs_human) {
    db.prepare('UPDATE conversations SET needs_human = 1, status = ? WHERE id = ?').run('needs_help', conv.id);
    notify({
      userId, conversationId: conv.id, type: 'comment_needs_help',
      title: `Comment needs your attention from ${commenterName || commenterHandle}`,
      body: `Reason: ${reason || 'flagged'}\nComment: ${body.slice(0, 200)}`
    });
  }

  if (reply && reply.trim()) {
    try {
      if (platform === 'instagram') {
        await instagram.replyToComment({ userId, commentId, body: reply });
      } else if (platform === 'facebook') {
        await facebook.replyToComment({ userId, commentId, body: reply });
      }
      db.prepare(
        `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, external_ref, created_at)
         VALUES (?, 'outbound', 'ai', ?, 1, ?, ?)`
      ).run(conv.id, reply, commentId, Date.now());
    } catch (err) {
      console.error(`[${platform}] comment reply failed`, err.message);
      notify({
        userId, conversationId: conv.id, type: 'send_failed',
        title: `Failed to reply to comment on ${platform}`,
        body: err.message
      });
    }
  }
}

module.exports = { handleIncomingMessage, handleIncomingComment, findOrCreateConversation };
