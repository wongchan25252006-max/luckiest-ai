const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const facebook = require('../services/facebook');
const instagram = require('../services/instagram');
const whatsapp = require('../services/whatsapp');
const telegram = require('../services/telegram');

const senders = { facebook: facebook.sendMessage, instagram: instagram.sendMessage, whatsapp: whatsapp.sendMessage, telegram: telegram.sendMessage };

const router = express.Router();

router.get('/conversations', requireAuth, (req, res) => {
  const filter = req.query.filter;
  let sql = `SELECT c.*, (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body
             FROM conversations c WHERE user_id = ?`;
  const params = [req.session.userId];
  if (filter === 'needs_help') sql += ' AND needs_human = 1';
  if (filter === 'active') sql += ` AND status = 'active'`;
  sql += ' ORDER BY last_message_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  res.json({ conversations: rows });
});

router.get('/conversations/:id', requireAuth, (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!conv) return res.status(404).json({ error: 'not found' });
  const messages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(conv.id);
  res.json({ conversation: conv, messages });
});

router.post('/conversations/:id/reply', requireAuth, async (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!conv) return res.status(404).json({ error: 'not found' });
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });

  try {
    const sender = senders[conv.platform];
    if (sender) await sender({ userId: req.session.userId, externalId: conv.external_id, body });
    db.prepare(
      `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, created_at)
       VALUES (?, 'outbound', 'human', ?, 0, ?)`
    ).run(conv.id, body, Date.now());
    db.prepare(`UPDATE conversations SET last_message_at = ?, needs_human = 0, status = 'active' WHERE id = ?`)
      .run(Date.now(), conv.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:id/status', requireAuth, (req, res) => {
  const { status, needs_human } = req.body || {};
  const allowed = ['active', 'needs_help', 'human', 'resolved'];
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'bad status' });
  const updates = [];
  const params = [];
  if (status) { updates.push('status = ?'); params.push(status); }
  if (typeof needs_human === 'boolean') { updates.push('needs_human = ?'); params.push(needs_human ? 1 : 0); }
  if (!updates.length) return res.json({ ok: true });
  params.push(req.params.id, req.session.userId);
  db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  res.json({ ok: true });
});

router.get('/notifications', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100`
  ).all(req.session.userId);
  res.json({ notifications: rows });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.session.userId);
  res.json({ ok: true });
});

module.exports = router;
