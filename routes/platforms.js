const express = require('express');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const telegram = require('../services/telegram');
const { handleIncomingMessage } = require('../services/messaging');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, platform, account_label, account_id, active, connected_at
       FROM platform_connections WHERE user_id = $1 ORDER BY connected_at DESC`,
      [req.session.userId]
    );
    res.json({ connections: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/connect', requireAuth, async (req, res) => {
  try {
    const { platform, account_label, access_token, account_id, extra } = req.body || {};
    const valid = ['facebook', 'instagram', 'whatsapp', 'telegram'];
    if (!valid.includes(platform)) return res.status(400).json({ error: 'invalid platform' });
    if (!access_token) return res.status(400).json({ error: 'access_token required' });

    const extraJson = extra ? (typeof extra === 'string' ? extra : JSON.stringify(extra)) : null;
    const accountId = account_id || `${platform}-${Date.now()}`;

    const r = await query(
      `INSERT INTO platform_connections (user_id, platform, account_label, access_token, account_id, extra, connected_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (user_id, platform, account_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         account_label = EXCLUDED.account_label,
         extra = EXCLUDED.extra,
         active = 1,
         connected_at = EXCLUDED.connected_at
       RETURNING id`,
      [req.session.userId, platform, account_label || null, access_token, accountId, extraJson, Date.now()]
    );

    const newId = r.rows[0].id;

    if (platform === 'telegram') {
      const connR = await query('SELECT * FROM platform_connections WHERE id = $1', [newId]);
      const conn = connR.rows[0];
      try { telegram.startPollingForConnection(conn, handleIncomingMessage); }
      catch (e) { console.error('[telegram] start failed', e.message); }
    }

    res.json({ ok: true, id: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/disable', requireAuth, async (req, res) => {
  try {
    await query('UPDATE platform_connections SET active = 0 WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM platform_connections WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
