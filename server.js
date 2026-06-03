const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(path.join(dataDir, 'luckiest.db'));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
  )`);
});

function seedAdmin() {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'ChangeMe!2026', 10);
  db.run(`INSERT OR IGNORE INTO users (email, password_hash, full_name, role, created_at)
    VALUES (?, ?, 'Admin', 'admin', ?)`,
    [process.env.ADMIN_EMAIL || 'admin@luckiest.ai', hash, Date.now()]);
}

function ensureSubscription() {}

module.exports = { db, seedAdmin, ensureSubscription };