const express = require('express');
const bcrypt = require('bcryptjs');
const { db, ensureSubscription } = require('../database');

const router = express.Router();

router.post('/signup', (req, res) => {
  const { email, password, full_name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'password too short' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, full_name, role, created_at) VALUES (?, ?, ?, 'user', ?)`
  ).run(email.toLowerCase(), hash, full_name || null, Date.now());

  db.prepare(`INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)`).run(info.lastInsertRowid, Date.now());
  ensureSubscription(info.lastInsertRowid);

  req.session.userId = info.lastInsertRowid;
  req.session.role = 'user';
  res.json({ ok: true, user: { id: info.lastInsertRowid, email, full_name, role: 'user' } });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  res.json({ ok: true, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'not logged in' });
  const user = db.prepare('SELECT id, email, full_name, role FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user });
});

module.exports = router;
