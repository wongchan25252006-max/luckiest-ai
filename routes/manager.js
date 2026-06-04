const express = require('express');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/contacts', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT c.id, c.platform, c.external_id, c.customer_name, c.customer_handle, c.profile_pic,
              c.ai_enabled, c.needs_human, c.status, c.last_message_at, c.created_at,
              (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body,
              (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_direction
       FROM conversations c
       WHERE c.user_id = $1
       ORDER BY c.last_message_at DESC LIMIT 500`,
      [req.session.userId]
    );
    res.json({ contacts: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/contacts/:id/ai', requireAuth, async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const r = await query(
      `UPDATE conversations SET ai_enabled = $1 WHERE id = $2 AND user_id = $3`,
      [enabled ? 1 : 0, req.params.id, req.session.userId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, ai_enabled: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/contacts/bulk-ai', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    await query(`UPDATE conversations SET ai_enabled = $1 WHERE user_id = $2`, [enabled ? 1 : 0, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
