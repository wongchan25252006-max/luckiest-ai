const express = require('express');
const { db, ensureSubscription } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const PLANS = {
  free:    { name: 'Free',    monthly: 0,    features: ['100 AI replies/mo', '1 platform', 'community support'] },
  starter: { name: 'Starter', monthly: 29,   features: ['2,000 AI replies/mo', 'all platforms', 'post scheduler'] },
  pro:     { name: 'Pro',     monthly: 79,   features: ['10,000 AI replies/mo', 'voice messages', 'auto comment replies', 'priority support'] },
  business:{ name: 'Business',monthly: 199,  features: ['unlimited replies', 'team seats', 'API access', 'dedicated success manager'] }
};

router.get('/plans', (req, res) => res.json({ plans: PLANS }));

router.get('/me', requireAuth, (req, res) => {
  ensureSubscription(req.session.userId);
  const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(req.session.userId);
  res.json({ subscription: sub, plan: PLANS[sub.plan] || PLANS.free });
});

router.post('/subscribe', requireAuth, (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'invalid plan' });
  ensureSubscription(req.session.userId);
  db.prepare(
    `UPDATE subscriptions SET plan = ?, status = 'active', amount_monthly = ?,
       started_at = COALESCE(started_at, ?),
       current_period_end = ?
     WHERE user_id = ?`
  ).run(plan, PLANS[plan].monthly, Date.now(), Date.now() + 30 * 86400_000, req.session.userId);
  res.json({ ok: true });
});

router.post('/cancel', requireAuth, (req, res) => {
  db.prepare(`UPDATE subscriptions SET status = 'canceled' WHERE user_id = ?`).run(req.session.userId);
  res.json({ ok: true });
});

module.exports = router;
