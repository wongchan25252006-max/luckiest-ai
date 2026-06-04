const express = require('express');
const { query, ensureSubscription } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const PLANS = {
  free:    { name: 'Free',    monthly: 0,    features: ['100 AI replies/mo', '1 platform', 'community support'] },
  starter: { name: 'Starter', monthly: 29,   features: ['2,000 AI replies/mo', 'all platforms', 'post scheduler'] },
  pro:     { name: 'Pro',     monthly: 79,   features: ['10,000 AI replies/mo', 'voice messages', 'auto comment replies', 'priority support'] },
  business:{ name: 'Business',monthly: 199,  features: ['unlimited replies', 'team seats', 'API access', 'dedicated success manager'] }
};

router.get('/plans', (req, res) => res.json({ plans: PLANS }));

router.get('/me', requireAuth, async (req, res) => {
  try {
    await ensureSubscription(req.session.userId);
    const r = await query('SELECT * FROM subscriptions WHERE user_id = $1', [req.session.userId]);
    const sub = r.rows[0];
    res.json({ subscription: sub, plan: PLANS[sub.plan] || PLANS.free });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!PLANS[plan]) return res.status(400).json({ error: 'invalid plan' });
    await ensureSubscription(req.session.userId);
    await query(
      `UPDATE subscriptions SET plan = $1, status = 'active', amount_monthly = $2,
         started_at = COALESCE(started_at, $3),
         current_period_end = $4
       WHERE user_id = $5`,
      [plan, PLANS[plan].monthly, Date.now(), Date.now() + 30 * 86400000, req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cancel', requireAuth, async (req, res) => {
  try {
    await query(`UPDATE subscriptions SET status = 'canceled' WHERE user_id = $1`, [req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
