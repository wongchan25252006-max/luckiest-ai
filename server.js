require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { initializeDatabase } = require('./database');

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

function mount(prefix, modulePath) {
  try {
    app.use(prefix, require(modulePath));
    console.log(`[mount] ${prefix} -> ${modulePath}`);
  } catch (err) {
    console.error(`[mount] failed ${prefix} -> ${modulePath}:`, err.message);
  }
}

mount('/auth', './routes/auth');
mount('/admin', './routes/admin');
mount('/billing', './routes/billing');
mount('/manager', './routes/manager');
mount('/messages', './routes/messages');
mount('/platforms', './routes/platforms');
mount('/profile', './routes/profile');
mount('/scheduler', './routes/scheduler');
mount('/webhooks', './routes/webhooks');

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initializeDatabase();
    app.listen(PORT, () => console.log('Luckiest-AI running on port ' + PORT));
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();
