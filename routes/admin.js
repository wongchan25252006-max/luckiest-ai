const express = require('express');
const { db } = require('../database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/users', requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.email, u.full_name, u.role, u.created_at,
       COALESCE(s.plan, 'free') AS plan,
       COALESCE(s.status, 'trialing') AS sub_status,
       COALESCE(s.amount_monthly, 0) AS mrr,
       (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversation_count,
       (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id AND c.needs_human = 1) AS pending_count,
       (SELECT COUNT(*) FROM platform_connections p WHERE p.user_id = u.id AND p.active = 1) AS platform_count
     FROM users u
     LEFT JOIN subscriptions s ON s.user_id = u.id
     ORDER BY u.created_at DESC`
  ).all();
  res.json({ users: rows });
});

router.get('/conversations', requireAdmin, (req, res) => {
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  const filter = req.query.filter;
  let sql = `SELECT c.*, u.email AS owner_email, u.full_name AS owner_name,
             (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body
             FROM conversations c JOIN users u ON u.id = c.user_id`;
  const where = [];
  const params = [];
  if (userId) { where.push('c.user_id = ?'); params.push(userId); }
  if (filter === 'needs_help') where.push('c.needs_human = 1');
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY c.last_message_at DESC LIMIT 200';
  res.json({ conversations: db.prepare(sql).all(...params) });
});

router.get('/conversations/:id', requireAdmin, (req, res) => {
  const conv = db.prepare(
    `SELECT c.*, u.email AS owner_email FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ?`
  ).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(conv.id);
  res.json({ conversation: conv, messages });
});

router.get('/notifications', requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT n.* FROM notifications n
     WHERE n.type LIKE 'admin_%' AND n.user_id = ?
     ORDER BY n.id DESC LIMIT 200`
  ).all(req.session.userId);
  res.json({ notifications: rows });
});

router.get('/stats', requireAdmin, (req, res) => {
  const totalMRR = db.prepare(
    `SELECT COALESCE(SUM(amount_monthly), 0) AS n FROM subscriptions WHERE status = 'active'`
  ).get().n;

  const stats = {
    users: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'user'`).get().n,
    active_subs: db.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'`).get().n,
    mrr: totalMRR,
    arr: totalMRR * 12,
    conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    ai_replies: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE ai_generated = 1').get().n,
    pending_help: db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE needs_human = 1').get().n,
    new_contacts_24h: db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE created_at > ?`).get(Date.now() - 86400_000).n,
    scheduled_pending: db.prepare(`SELECT COUNT(*) AS n FROM scheduled_posts WHERE status = 'pending'`).get().n,
    posts_published: db.prepare(`SELECT COUNT(*) AS n FROM scheduled_posts WHERE status = 'posted'`).get().n,
    platforms: db.prepare(`SELECT COUNT(*) AS n FROM platform_connections WHERE active = 1`).get().n
  };
  res.json({ stats });
});

module.exports = router;
