require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { seedAdmin } = require('./database');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

app.use('/auth', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/billing', require('./routes/billing'));
app.use('/manager', require('./routes/manager'));
app.use('/messages', require('./routes/messages'));
app.use('/platforms', require('./routes/platforms'));
app.use('/profile', require('./routes/profile'));
app.use('/scheduler', require('./routes/scheduler'));
app.use('/webhooks', require('./routes/webhooks'));

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

seedAdmin();

try {
  const { handleIncomingMessage } = require('./services/messaging');
  const telegram = require('./services/telegram');
  telegram.bootstrapAll(handleIncomingMessage);
} catch (err) {
  console.error('[telegram] bootstrap failed:', err.message);
}

try {
  const scheduler = require('./services/scheduler');
  scheduler.start();
} catch (err) {
  console.error('[scheduler] start failed:', err.message);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Luckiest-AI running on port ' + PORT));
