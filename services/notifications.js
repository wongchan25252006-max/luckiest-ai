const { query } = require('../database');

async function notify({ userId, conversationId = null, type, title, body = '' }) {
  try {
    await query(
      `INSERT INTO notifications (user_id, conversation_id, type, title, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, conversationId, type, title, body, Date.now()]
    );

    const admins = await query(`SELECT id FROM users WHERE role = 'admin'`);
    for (const admin of admins.rows) {
      if (admin.id === userId) continue;
      await query(
        `INSERT INTO notifications (user_id, conversation_id, type, title, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [admin.id, conversationId, 'admin_' + type, '[Admin] ' + title, body, Date.now()]
      );
    }
    console.log(`[notify] ${type}: ${title}`);
  } catch (err) {
    console.error('[notify] failed:', err.message);
  }
}

module.exports = { notify };
