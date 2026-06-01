const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.session.userId);
  res.json({ profile: profile || {} });
});

router.put('/', requireAuth, (req, res) => {
  const fields = ['bio', 'personality', 'tone', 'languages', 'business_info', 'faq', 'sample_messages', 'escalation_keywords'];
  const updates = {};
  for (const f of fields) if (f in req.body) updates[f] = req.body[f];

  const existing = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(req.session.userId);
  if (!existing) {
    db.prepare(`INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)`).run(req.session.userId, Date.now());
  }

  const keys = Object.keys(updates);
  if (keys.length) {
    const set = keys.map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE profiles SET ${set}, updated_at = @updated_at WHERE user_id = @user_id`).run({
      ...updates, updated_at: Date.now(), user_id: req.session.userId
    });
  }
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.session.userId);
  res.json({ profile });
});

module.exports = router;
