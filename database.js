const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'luckiest.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY,
  bio TEXT, personality TEXT, tone TEXT, languages TEXT,
  business_info TEXT, faq TEXT, sample_messages TEXT, escalation_keywords TEXT,
  updated_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  account_label TEXT, access_token TEXT, account_id TEXT, extra TEXT,
  connected_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, platform, account_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_name TEXT, customer_handle TEXT, profile_pic TEXT,
  last_message_at INTEGER,
  needs_human INTEGER NOT NULL DEFAULT 0,
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, platform, external_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  sender TEXT, body TEXT NOT NULL,
  media_type TEXT, media_url TEXT, transcript TEXT,
  ai_generated INTEGER NOT NULL DEFAULT 0,
  external_ref TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  conversation_id INTEGER,
  type TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platforms TEXT NOT NULL,
  caption TEXT,
  media_path TEXT, media_type TEXT,
  scheduled_for INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT, posted_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'trialing',
  amount_monthly INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  started_at INTEGER, current_period_end INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_posts(status, scheduled_for);
`);

function addColumn(table, column, type) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!info.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

addColumn('conversations', 'profile_pic', 'TEXT');
addColumn('conversations', 'ai_enabled', 'INTEGER NOT NULL DEFAULT 1');
addColumn('messages', 'media_type', 'TEXT');
addColumn('messages', 'media_url', 'TEXT');
addColumn('messages', 'transcript', 'TEXT');
addColumn('messages', 'external_ref', 'TEXT');
addColumn('scheduled_posts', 'media_path', 'TEXT');
addColumn('scheduled_posts', 'media_type', 'TEXT');

try {
  const oldCol = db.prepare(`PRAGMA table_info(scheduled_posts)`).all().find(c => c.name === 'image_path');
  if (oldCol) {
    db.exec(`UPDATE scheduled_posts SET media_path = image_path, media_type = 'image' WHERE media_path IS NULL AND image_path IS NOT NULL`);
  }
} catch {}

function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@luckiest.ai';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!existing) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(
      'INSERT INTO users (email, password_hash, full_name, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(email, hash, 'Platform Admin', 'admin', Date.now());
    console.log(`[init] Admin account created: ${email}`);
  }
}

function ensureSubscription(userId) {
  const existing = db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(userId);
  if (existing) return;
  db.prepare(
    `INSERT INTO subscriptions (user_id, plan, status, amount_monthly, currency, started_at, current_period_end, created_at)
     VALUES (?, 'free', 'trialing', 0, 'USD', ?, ?, ?)`
  ).run(userId, Date.now(), Date.now() + 14 * 86400_000, Date.now());
}

module.exports = { db, seedAdmin, ensureSubscription };
