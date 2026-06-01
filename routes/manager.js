const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/contacts', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.platform, c.external_id, c.customer_name, c.customer_handle, c.profile_pic,
            c.ai_enabled, c.needs_human, c.status, c.last_message_at, c.created_at,
            (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body,
            (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_direction
     FROM conversations c
     WHERE c.user_id = ?
     ORDER BY c.last_message_at DESC LIMIT 500`
  ).all(req.session.userId);
  res.json({ contacts: rows });
});

router.post('/contacts/:id/ai', requireAuth, (req, res) => {
  const enabled = !!req.body?.enabled;
  const r = db.prepare(
    `UPDATE conversations SET ai_enabled = ? WHERE id = ? AND user_id = ?`
  ).run(enabled ? 1 : 0, req.params.id, req.session.userId);
  if (!r.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, ai_enabled: enabled });
});

router.post('/contacts/bulk-ai', requireAuth, (req, res) => {
  const { enabled } = req.body || {};
  db.prepare(`UPDATE conversations SET ai_enabled = ? WHERE user_id = ?`)
    .run(enabled ? 1 : 0, req.session.userId);
  res.json({ ok: true });
});

module.exports = router;
