const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../database');

const router = express.Router();

async function register(req, res) {
  try {
    const { email, password, full_name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'password too short' });

    const lowerEmail = email.toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [lowerEmail]);
    if (existing.rowCount) return res.status(409).json({ error: 'email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'user') RETURNING id, email, full_name, role`,
      [lowerEmail, hash, full_name || null]
    );
    const user = result.rows[0];
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, amount_monthly)
       VALUES ($1, 'free', 'trialing', 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );

    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ ok: true, user });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: err.message });
  }
}

router.post('/register', register);
router.post('/signup', register);

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ ok: true, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'not logged in' });
    const result = await pool.query(
      'SELECT id, email, full_name, role FROM users WHERE id = $1',
      [req.session.userId]
    );
    res.json({ user: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
