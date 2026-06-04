const express = require('express');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const facebook = require('../services/facebook');
const instagram = require('../services/instagram');
const whatsapp = require('../services/whatsapp');
const telegram = require('../services/telegram');
const whatsappBaileys = require('../services/whatsapp_baileys');

const senders = {
  facebook: facebook.sendMessage,
  instagram: instagram.sendMessage,
  whatsapp: whatsapp.sendMessage,
  whatsapp_baileys: whatsappBaileys.sendMessage,
  telegram: telegram.sendMessage
};

const router = express.Router();

router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const filter = req.query.filter;
    let sql = `SELECT c.*, (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body
               FROM conversations c WHERE user_id = $1`;
    const params = [req.session.userId];
    if (filter === 'needs_help') sql += ' AND needs_human = 1';
    if (filter === 'active') sql += ` AND status = 'active'`;
    sql += ' ORDER BY last_message_at DESC LIMIT 200';
    const r = await query(sql, params);
    res.json({ conversations: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:id', requireAuth, async (req, res) => {
  try {
    const cR = await query('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    const conv = cR.rows[0];
    if (!conv) return res.status(404).json({ error: 'not found' });
    const mR = await query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id ASC', [conv.id]);
    res.json({ conversation: conv, messages: mR.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:id/reply', requireAuth, async (req, res) => {
  try {
    const cR = await query('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    const conv = cR.rows[0];
    if (!conv) return res.status(404).json({ error: 'not found' });
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });

    const sender = senders[conv.platform];
    if (sender) await sender({ userId: req.session.userId, externalId: conv.external_id, body });
    await query(
      `INSERT INTO messages (conversation_id, direction, sender, body, ai_generated, created_at)
       VALUES ($1, 'outbound', 'human', $2, 0, $3)`,
      [conv.id, body, Date.now()]
    );
    await query(
      `UPDATE conversations SET last_message_at = $1, needs_human = 0, status = 'active' WHERE id = $2`,
      [Date.now(), conv.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, needs_human } = req.body || {};
    const allowed = ['active', 'needs_help', 'human', 'resolved'];
    if (status && !allowed.includes(status)) return res.status(400).json({ error: 'bad status' });
    const updates = [];
    const params = [];
    if (status) { params.push(status); updates.push(`status = $${params.length}`); }
    if (typeof needs_human === 'boolean') { params.push(needs_human ? 1 : 0); updates.push(`needs_human = $${params.length}`); }
    if (!updates.length) return res.json({ ok: true });
    params.push(req.params.id);
    params.push(req.session.userId);
    await query(
      `UPDATE conversations SET ${updates.join(', ')} WHERE id = $${params.length - 1} AND user_id = $${params.length}`,
      params
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/notifications', requireAuth, async (req, res) => {
  try {
    const r = await query(`SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 100`, [req.session.userId]);
    res.json({ notifications: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await query('UPDATE notifications SET read = 1 WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await query('UPDATE notifications SET read = 1 WHERE user_id = $1', [req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
