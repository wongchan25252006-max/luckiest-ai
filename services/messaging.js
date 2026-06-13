const { query } = require('../database');
const { generateReply } = require('./ai');
const { notify } = require('./notifications');
const facebook = require('./facebook');
const instagram = require('./instagram');
const whatsapp = require('./whatsapp');
const telegram = require('./telegram');
const whatsappBaileys = require('./whatsapp_baileys');

const senders = {
  facebook: facebook.sendMessage,
  instagram: instagram.sendMessage,
  whatsapp: whatsapp.sendMessage,
  whatsapp_baileys: whatsappBaileys.sendMessage,
  telegram: telegram.sendMessage
};

async function findOrCreateConversation({ userId, platform, externalId, customerName, customerHandle, profilePic }) {
  const existing = await query(
    'SELECT * FROM conversations WHERE user_id = $1 AND platform = $2 AND external_id = $3',
    [userId, platform, externalId]
  );
  let conv = existing.rows[0];

  if (!conv) {
    // New contacts are saved with AI OFF by default — the admin must
    // explicitly opt them in (via the dashboard or `/cmd ai on <phone>`)
    // before the AI starts replying on their behalf.
    const ins = await query(
      `INSERT INTO conversations (user_id, platform, external_id, customer_name, customer_handle, profile_pic, ai_enabled, last_message_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8) RETURNING *`,
      [userId, platform, externalId, customerName || null, customerHandle || null, profilePic || null, Date.now(), Date.now()]
    );
    conv = ins.rows[0];

    await notify({
      userId,
      conversationId: conv.id,
      type: 'new_contact',
      title: `New contact: ${customerName || customerHandle || 'unknown'}`,
      body: `First time messaging you on ${platform}. AI is OFF — turn it on from the dashboard or send "/cmd ai on ${externalId}" to your own WhatsApp.`
    });
    return { conv, isNew: true };
  }

  const updates = [];
  const params = [];
  if (customerName && customerName !== conv.customer_name) { params.push(customerName); updates.push(`customer_name = $${params.length}`); }
  if (profilePic && profilePic !== conv.profile_pic) { params.push(profilePic); updates.push(`profile_pic = $${params.length}`); }
  if (updates.length) {
    params.push(conv.id);
    await query(`UPDATE conversations SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    const r2 = await query('SELECT * FROM conversations WHERE id = $1', [conv.id]);
    conv = r2.rows[0];
  }
  return { conv, isNew: false };
}

async function handleIncomingMessage({
  userId, platform, externalId, customerName, customerHandle, profilePic,
  body, mediaType, mediaUrl, transcript, externalRef
}) {
  const effectiveBody = body || transcript || (mediaType ? `[${mediaType} message]` : '');
  if (!effectiveBody.trim() && !mediaType) return;

  const { conv } = await findOrCreateConversation({ userId, platform, externalId, customerName, customerHandle, profilePic });

  await query(
    `INSERT INTO messages (conversation_id, direction, sender, body, media_type, media_url, transcript, ai_generated, external_ref, created_at)
     VALUES ($1, 'inbound', $2, $3, $4, $5, $6, 0, $7, $8)`,
    [conv.id, customerName || customerHandle || 'customer', effectiveBody, mediaType || null, mediaUrl || null, transcript || null, externalRef || null, Date.now()]
  );
  await query('UPDATE conversations SET last_message_at = $1 WHERE id = $2', [Date.now(), conv.id]);

  if (!conv.ai_enabled || conv.status === 'human' || conv.status === 'resolved') {
    await notify({
      userId, conversationId: conv.id, type: 'new_message_off',
      title: `Message from ${customerName || customerHandle || 'customer'} (AI off)`,
      body: effectiveBody.slice(0, 200)
    });
    return;
  }

  if (mediaType === 'voice' && !transcript) {
    await query('UPDATE conversations SET needs_human = 1, status = $1 WHERE id = $2', ['needs_help', conv.id]);
    await notify({
      userId, conversationId: conv.id, type: 'voice_message',
      title: `Voice message from ${customerName || customerHandle || 'customer'}`,
      body: 'Could not transcribe (no transcription service configured). Listen and reply manually.'
    });
    return;
  }

  const { reply, needs_human, reason } = await generateReply({
    userId, conversationId: conv.id,
    incomingMessage: effectiveBody, customerName
  });

  if (needs_human) {
    await query('UPDATE conversations SET needs_human = 1, status = $1 WHERE id = $2', ['needs_help', conv.id]);
    await notify({
      userId, conversationId: conv.id, type: 'needs_help',
      title: `Customer needs help: ${customerName || customerHandle || 'unknown'}`,
      body: `Reason: ${reason || 'flagged by AI'}\nLast message: ${effectiveBody.slice(0, 200)}`
    });
  }

  if (reply && reply.trim()) {
    try {
      const sender = senders[platform];
      if (sender) await sender({ userId, externalId, body: reply, externalRef });
      await query(
        `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, created_at)
         VALUES ($1, 'outbound', 'ai', $2, 1, $3)`,
        [conv.id, reply, Date.now()]
      );
      await query('UPDATE conversations SET last_message_at = $1 WHERE id = $2', [Date.now(), conv.id]);
    } catch (err) {
      console.error(`[${platform}] send failed`, err.message);
      await notify({
        userId, conversationId: conv.id, type: 'send_failed',
        title: `Failed to send AI reply on ${platform}`,
        body: err.message
      });
    }
  }
}

async function handleIncomingComment({ userId, platform, postId, commentId, commenterName, commenterHandle, body }) {
  const { conv } = await findOrCreateConversation({
    userId, platform,
    externalId: `comment:${postId}:${commenterHandle || commentId}`,
    customerName: commenterName, customerHandle: commenterHandle
  });

  await query(
    `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, external_ref, created_at)
     VALUES ($1, 'inbound', $2, $3, 0, $4, $5)`,
    [conv.id, commenterName || commenterHandle || 'commenter', body, commentId, Date.now()]
  );
  await query('UPDATE conversations SET last_message_at = $1 WHERE id = $2', [Date.now(), conv.id]);

  if (!conv.ai_enabled) return;

  const { reply, needs_human, reason } = await generateReply({
    userId, conversationId: conv.id,
    incomingMessage: body, customerName: commenterName
  });

  if (needs_human) {
    await query('UPDATE conversations SET needs_human = 1, status = $1 WHERE id = $2', ['needs_help', conv.id]);
    await notify({
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
      await query(
        `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, external_ref, created_at)
         VALUES ($1, 'outbound', 'ai', $2, 1, $3, $4)`,
        [conv.id, reply, commentId, Date.now()]
      );
    } catch (err) {
      console.error(`[${platform}] comment reply failed`, err.message);
      await notify({
        userId, conversationId: conv.id, type: 'send_failed',
        title: `Failed to reply to comment on ${platform}`,
        body: err.message
      });
    }
  }
}

module.exports = { handleIncomingMessage, handleIncomingComment, findOrCreateConversation };
