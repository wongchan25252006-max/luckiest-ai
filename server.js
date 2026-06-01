require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const { seedAdmin, ensureSubscription, db } = require('./database');
const telegram = require('./services/telegram');
const scheduler = require('./services/scheduler');
const { handleIncomingMessage } = require('./services/messaging');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

if (isProd) app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

const uploadDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/platforms', require('./routes/platforms'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/scheduler', require('./routes/scheduler'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/manager', require('./routes/manager'));
app.use('/api/billing', require('./routes/billing'));
app.use('/webhooks', require('./routes/webhooks'));

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  if (req.session.role === 'admin') return res.redirect('/admin.html');
  res.redirect('/dashboard.html');
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message });
});

seedAdmin();
for (const u of db.prepare(`SELECT id FROM users WHERE role = 'user'`).all()) ensureSubscription(u.id);
scheduler.start();
telegram.bootstrapAll(handleIncomingMessage);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`\nLuckiest-AI running on port ${PORT}`);
  console.log(`Public URL: ${publicUrl}`);
  console.log(`Admin: ${process.env.ADMIN_EMAIL || 'admin@luckiest.ai'}\n`);
});
