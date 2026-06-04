const express = require('express');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const r = await query('SELECT * FROM profiles WHERE user_id = $1', [req.session.userId]);
    res.json({ profile: r.rows[0] || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/', requireAuth, async (req, res) => {
  try {
    const fields = ['bio', 'personality', 'tone', 'languages', 'business_info', 'faq', 'sample_messages', 'escalation_keywords'];
    const updates = {};
    for (const f of fields) if (f in req.body) updates[f] = req.body[f];

    const exR = await query('SELECT user_id FROM profiles WHERE user_id = $1', [req.session.userId]);
    if (!exR.rowCount) {
      await query(`INSERT INTO profiles (user_id, updated_at) VALUES ($1, $2)`, [req.session.userId, Date.now()]);
    }

    const keys = Object.keys(updates);
    if (keys.length) {
      const params = [];
      const set = keys.map(k => { params.push(updates[k]); return `${k} = $${params.length}`; });
      params.push(Date.now());
      set.push(`updated_at = $${params.length}`);
      params.push(req.session.userId);
      await query(`UPDATE profiles SET ${set.join(', ')} WHERE user_id = $${params.length}`, params);
    }
    const r = await query('SELECT * FROM profiles WHERE user_id = $1', [req.session.userId]);
    res.json({ profile: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
