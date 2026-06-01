const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const telegram = require('../services/telegram');
const { handleIncomingMessage } = require('../services/messaging');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT id, platform, account_label, account_id, active, connected_at
     FROM platform_connections WHERE user_id = ? ORDER BY connected_at DESC`
  ).all(req.session.userId);
  res.json({ connections: rows });
});

router.post('/connect', requireAuth, (req, res) => {
  const { platform, account_label, access_token, account_id, extra } = req.body || {};
  const valid = ['facebook', 'instagram', 'whatsapp', 'telegram'];
  if (!valid.includes(platform)) return res.status(400).json({ error: 'invalid platform' });
  if (!access_token) return res.status(400).json({ error: 'access_token required' });

  const extraJson = extra ? (typeof extra === 'string' ? extra : JSON.stringify(extra)) : null;

  try {
    const info = db.prepare(
      `INSERT INTO platform_connections (user_id, platform, account_label, access_token, account_id, extra, connected_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_id, platform, account_id) DO UPDATE SET
         access_token = excluded.access_token,
         account_label = excluded.account_label,
         extra = excluded.extra,
         active = 1,
         connected_at = excluded.connected_at`
    ).run(req.session.userId, platform, account_label || null, access_token, account_id || `${platform}-${Date.now()}`, extraJson, Date.now());

    if (platform === 'telegram') {
      const conn = db.prepare('SELECT * FROM platform_connections WHERE id = ?').get(info.lastInsertRowid);
      try { telegram.startPollingForConnection(conn, handleIncomingMessage); }
      catch (e) { console.error('[telegram] start failed', e.message); }
    }

    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/disable', requireAuth, (req, res) => {
  db.prepare('UPDATE platform_connections SET active = 0 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM platform_connections WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

module.exports = router;
