const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

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
    bio TEXT,
    personality TEXT,
    tone TEXT,
    languages TEXT,
    business_info TEXT,
    faq TEXT,
    sample_messages TEXT,
    escalation_keywords TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'trialing',
    amount_monthly INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    started_at INTEGER,
    current_period_end INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS platform_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    account_label TEXT,
    access_token TEXT NOT NULL,
    account_id TEXT NOT NULL,
    extra TEXT,
    connected_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, platform, account_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    customer_name TEXT,
    customer_handle TEXT,
    profile_pic TEXT,
    ai_enabled INTEGER NOT NULL DEFAULT 1,
    needs_human INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    last_message_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, platform, external_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    sender TEXT,
    body TEXT,
    media_type TEXT,
    media_url TEXT,
    transcript TEXT,
    ai_generated INTEGER NOT NULL DEFAULT 0,
    external_ref TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    conversation_id INTEGER,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platforms TEXT NOT NULL,
    caption TEXT,
    media_path TEXT,
    media_type TEXT,
    scheduled_for INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    posted_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_user_last ON conversations(user_id, last_message_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_posts(status, scheduled_for);
`);

console.log('Database connected:', path.join(dataDir, 'luckiest.db'));

function ensureSubscription(userId) {
  const existing = db.prepare('SELECT user_id FROM subscriptions WHERE user_id = ?').get(userId);
  if (existing) return;
  const now = Date.now();
  db.prepare(
    `INSERT INTO subscriptions (user_id, plan, status, amount_monthly, started_at, current_period_end, created_at)
     VALUES (?, 'free', 'trialing', 0, ?, ?, ?)`
  ).run(userId, now, now + 30 * 86400_000, now);
}

function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@luckiest.ai').toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (existing) {
    if (existing.role !== 'admin') {
      db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(existing.id);
      console.log(`[seedAdmin] promoted ${email} to admin`);
    }
    ensureSubscription(existing.id);
    return;
  }

  if (!password) {
    console.warn('[seedAdmin] ADMIN_PASSWORD not set; admin user not created');
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, full_name, role, created_at) VALUES (?, ?, ?, 'admin', ?)`
  ).run(email, hash, 'Luckiest Admin', Date.now());
  db.prepare(`INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)`).run(info.lastInsertRowid, Date.now());
  ensureSubscription(info.lastInsertRowid);
  console.log(`[seedAdmin] admin user ${email} created`);
}

module.exports = { db, seedAdmin, ensureSubscription };
