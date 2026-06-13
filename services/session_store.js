const session = require('express-session');
const { client, query } = require('../database');

/*
 * Lightweight session store backed by the existing Turso (LibSQL) database.
 *
 * Why this matters: the default express-session memory store loses every
 * session on every restart/redeploy — which on Render means users get
 * silently logged out roughly every time the service redeploys, every time
 * it cold-starts, and every time the platform recycles a worker. Phones
 * keep the cookie but the server has no record of the session, so the user
 * sees a login screen they didn't expect.
 *
 * This store persists sessions in a `sessions` table. As long as the cookie
 * is alive (we set maxAge = 30 days in server.js), the user stays signed in
 * across deploys, country changes, browser switches — everywhere.
 */
class TursoSessionStore extends session.Store {
  constructor() {
    super();
    this.ready = this._ensureTable();
    // Sweep expired rows hourly so the table stays small
    this._sweepTimer = setInterval(() => this._sweep().catch(() => {}), 60 * 60 * 1000);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  async _ensureTable() {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);
  }

  async _sweep() {
    await query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
  }

  _expiresAt(session) {
    if (session && session.cookie && session.cookie.expires) {
      const t = new Date(session.cookie.expires).getTime();
      if (!isNaN(t)) return t;
    }
    // Fallback: 30 days from now
    return Date.now() + 30 * 24 * 60 * 60 * 1000;
  }

  get(sid, cb) {
    this.ready
      .then(() => query('SELECT data, expires_at FROM sessions WHERE sid = $1', [sid]))
      .then((r) => {
        const row = r.rows[0];
        if (!row) return cb(null, null);
        if (Number(row.expires_at) < Date.now()) {
          query('DELETE FROM sessions WHERE sid = $1', [sid]).catch(() => {});
          return cb(null, null);
        }
        try { cb(null, JSON.parse(row.data)); }
        catch (e) { cb(e); }
      })
      .catch(cb);
  }

  set(sid, sess, cb) {
    const data = JSON.stringify(sess);
    const exp = this._expiresAt(sess);
    this.ready
      .then(() =>
        query(
          `INSERT INTO sessions (sid, data, expires_at) VALUES ($1, $2, $3)
           ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
          [sid, data, exp]
        )
      )
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }

  destroy(sid, cb) {
    this.ready
      .then(() => query('DELETE FROM sessions WHERE sid = $1', [sid]))
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }

  touch(sid, sess, cb) {
    const exp = this._expiresAt(sess);
    this.ready
      .then(() => query('UPDATE sessions SET expires_at = $1 WHERE sid = $2', [exp, sid]))
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
}

module.exports = { TursoSessionStore };
