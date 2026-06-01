const { db } = require('../database');

function notify({ userId, conversationId = null, type, title, body = '' }) {
  db.prepare(
    `INSERT INTO notifications (user_id, conversation_id, type, title, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, conversationId, type, title, body, Date.now());

  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all();
  for (const admin of admins) {
    if (admin.id === userId) continue;
    db.prepare(
      `INSERT INTO notifications (user_id, conversation_id, type, title, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(admin.id, conversationId, 'admin_' + type, '[Admin] ' + title, body, Date.now());
  }
  console.log(`[notify] ${type}: ${title}`);
}

module.exports = { notify };
