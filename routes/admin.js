const express = require('express');
const { query } = require('../database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/users', requireAdmin, async (req, res) => {
  try {
    const result = await query(
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
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('[admin/users]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations', requireAdmin, async (req, res) => {
  try {
    const userId = req.query.user_id ? Number(req.query.user_id) : null;
    const filter = req.query.filter;
    let sql = `SELECT c.*, u.email AS owner_email, u.full_name AS owner_name,
               (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body
               FROM conversations c JOIN users u ON u.id = c.user_id`;
    const where = [];
    const params = [];
    if (userId) { params.push(userId); where.push(`c.user_id = $${params.length}`); }
    if (filter === 'needs_help') where.push('c.needs_human = 1');
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY c.last_message_at DESC LIMIT 200';
    const result = await query(sql, params);
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error('[admin/conversations]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:id', requireAdmin, async (req, res) => {
  try {
    const cR = await query(
      `SELECT c.*, u.email AS owner_email FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [req.params.id]
    );
    const conv = cR.rows[0];
    if (!conv) return res.status(404).json({ error: 'not found' });
    const mR = await query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id ASC', [conv.id]);
    res.json({ conversation: conv, messages: mR.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/notifications', requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT n.* FROM notifications n
       WHERE n.type LIKE 'admin_%' AND n.user_id = $1
       ORDER BY n.id DESC LIMIT 200`,
      [req.session.userId]
    );
    res.json({ notifications: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', requireAdmin, async (req, res) => {
  try {
    async function count(sql, params = []) {
      const r = await query(sql, params);
      return Number(r.rows[0].n);
    }

    const totalMRR = await count(`SELECT COALESCE(SUM(amount_monthly), 0) AS n FROM subscriptions WHERE status = 'active'`);

    const stats = {
      users: await count(`SELECT COUNT(*) AS n FROM users WHERE role = 'user'`),
      active_subs: await count(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'`),
      mrr: totalMRR,
      arr: totalMRR * 12,
      conversations: await count('SELECT COUNT(*) AS n FROM conversations'),
      messages: await count('SELECT COUNT(*) AS n FROM messages'),
      ai_replies: await count('SELECT COUNT(*) AS n FROM messages WHERE ai_generated = 1'),
      pending_help: await count('SELECT COUNT(*) AS n FROM conversations WHERE needs_human = 1'),
      new_contacts_24h: await count(`SELECT COUNT(*) AS n FROM conversations WHERE created_at > $1`, [Date.now() - 86400000]),
      scheduled_pending: await count(`SELECT COUNT(*) AS n FROM scheduled_posts WHERE status = 'pending'`),
      posts_published: await count(`SELECT COUNT(*) AS n FROM scheduled_posts WHERE status = 'posted'`),
      platforms: await count(`SELECT COUNT(*) AS n FROM platform_connections WHERE active = 1`)
    };
    res.json({ stats });
  } catch (err) {
    console.error('[admin/stats]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
