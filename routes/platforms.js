const express = require('express');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const telegram = require('../services/telegram');
const baileys = require('../services/whatsapp_baileys');
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
    const r = await query(
      'SELECT platform FROM platform_connections WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    const row = r.rows[0];
    if (row?.platform === 'whatsapp_baileys') {
      try { await baileys.disconnectSession(req.params.id); } catch (e) { console.error('[baileys] disconnect on delete', e.message); }
    }
    await query('DELETE FROM platform_connections WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp-baileys/start', requireAuth, async (req, res) => {
  try {
    const placeholderAccount = `baileys-pending-${Date.now()}`;
    const r = await query(
      `INSERT INTO platform_connections (user_id, platform, account_label, access_token, account_id, extra, connected_at, active)
       VALUES ($1, 'whatsapp_baileys', $2, 'baileys', $3, NULL, $4, 1)
       RETURNING id`,
      [req.session.userId, req.body?.account_label || 'WhatsApp', placeholderAccount, Date.now()]
    );
    const id = r.rows[0].id;
    const connR = await query('SELECT * FROM platform_connections WHERE id = $1', [id]);
    baileys.startSession(connR.rows[0], handleIncomingMessage)
      .catch(e => console.error('[baileys] start failed:', e.message));
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[baileys/start]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/whatsapp-baileys/:id/qr', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id FROM platform_connections WHERE id = $1 AND user_id = $2 AND platform = 'whatsapp_baileys'`,
      [req.params.id, req.session.userId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json(baileys.getStatus(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp-baileys/:id/logout', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id FROM platform_connections WHERE id = $1 AND user_id = $2 AND platform = 'whatsapp_baileys'`,
      [req.params.id, req.session.userId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    await baileys.disconnectSession(req.params.id);
    await query('UPDATE platform_connections SET active = 0 WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
