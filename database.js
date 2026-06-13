require('dotenv').config();
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN;
if (!url) throw new Error('TURSO_DATABASE_URL is required');

const client = createClient({ url, authToken });

function translatePlaceholders(sql) {
  return sql.replace(/\$(\d+)/g, '?');
}

async function query(text, params) {
  const sql = translatePlaceholders(text);
  const args = params || [];
  const result = await client.execute({ sql, args });
  return {
    rows: result.rows,
    rowCount: result.rows.length || result.rowsAffected || 0,
    lastInsertRowid: result.lastInsertRowid,
  };
}

const pool = { query };

async function ensureSubscription(userId) {
  await query(
    `INSERT INTO subscriptions (user_id, plan, status, amount_monthly)
     VALUES ($1, 'free', 'trialing', 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function initializeDatabase() {
  await client.execute('PRAGMA foreign_keys = ON');

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      bio TEXT,
      personality TEXT,
      tone TEXT,
      languages TEXT,
      business_info TEXT,
      faq TEXT,
      sample_messages TEXT,
      escalation_keywords TEXT,
      updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'trialing',
      amount_monthly INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      current_period_end INTEGER,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS platform_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      account_label TEXT,
      access_token TEXT NOT NULL,
      account_id TEXT NOT NULL,
      extra TEXT,
      connected_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE (user_id, platform, account_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      customer_name TEXT,
      customer_handle TEXT,
      profile_pic TEXT,
      ai_enabled INTEGER NOT NULL DEFAULT 0,
      needs_human INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      last_message_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      UNIQUE (user_id, platform, external_id)
    );
  `);

  const msgInfo = await client.execute('PRAGMA table_info(messages)');
  const hasAgentId = msgInfo.rows.some((r) => r.name === 'agent_id');
  if (hasAgentId) {
    await client.execute('DROP TABLE messages');
  }

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      sender TEXT,
      body TEXT,
      media_type TEXT,
      media_url TEXT,
      transcript TEXT,
      ai_generated INTEGER NOT NULL DEFAULT 0,
      external_ref TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platforms TEXT NOT NULL,
      caption TEXT,
      media_path TEXT,
      media_type TEXT,
      scheduled_for INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      posted_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_conv_user_last ON conversations(user_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_posts(status, scheduled_for);
  `);

  const email = (process.env.ADMIN_EMAIL || 'admin@luckiest.ai').toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    const result = await query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, hash, 'Luckiest Admin']
    );
    if (result.rowCount) await ensureSubscription(result.rows[0].id);
    console.log('[seedAdmin] admin ensured for ' + email);
  } else {
    console.warn('[seedAdmin] ADMIN_PASSWORD not set; skipping admin seed');
  }
  console.log('Database initialized');
}

module.exports = { client, pool, query, ensureSubscription, initializeDatabase };
