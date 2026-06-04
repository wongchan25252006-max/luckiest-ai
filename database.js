require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  return pool.query(text, params);
}

async function ensureSubscription(userId) {
  await pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, amount_monthly)
     VALUES ($1, 'free', 'trialing', 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
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
      updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'trialing',
      amount_monthly INTEGER NOT NULL DEFAULT 0,
      started_at BIGINT,
      current_period_end BIGINT,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS platform_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      account_label TEXT,
      access_token TEXT NOT NULL,
      account_id TEXT NOT NULL,
      extra TEXT,
      connected_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE (user_id, platform, account_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      customer_name TEXT,
      customer_handle TEXT,
      profile_pic TEXT,
      ai_enabled INTEGER NOT NULL DEFAULT 1,
      needs_human INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      last_message_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      UNIQUE (user_id, platform, external_id)
    );
  `);

  await pool.query(`
    DO $migrate$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'agent_id'
      ) THEN
        DROP TABLE messages CASCADE;
      END IF;
    END $migrate$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      sender TEXT,
      body TEXT,
      media_type TEXT,
      media_url TEXT,
      transcript TEXT,
      ai_generated INTEGER NOT NULL DEFAULT 0,
      external_ref TEXT,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platforms TEXT NOT NULL,
      caption TEXT,
      media_path TEXT,
      media_type TEXT,
      scheduled_for BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      posted_at BIGINT,
      error TEXT,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
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
    const result = await pool.query(
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

module.exports = { pool, query, ensureSubscription, initializeDatabase };
