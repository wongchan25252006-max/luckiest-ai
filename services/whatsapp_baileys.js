const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const { query } = require('../database');

/*
 * Where Baileys writes its multi-file auth state. In production on Render the
 * persistent disk is mounted at /var/data — by writing there, the WhatsApp
 * pairing survives redeploys and restarts. Locally it falls back to ./data.
 */
const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.NODE_ENV === 'production' ? '/var/data' : path.join(__dirname, '..', 'data'));
const SESS_ROOT = path.join(DATA_DIR, 'whatsapp-baileys');
try { fs.mkdirSync(SESS_ROOT, { recursive: true }); }
catch (e) { console.error('[baileys] could not create sess root:', e.message); }

const sessions = new Map();

// Per-connection reconnect backoff state
const backoff = new Map();
function nextBackoff(id) {
  const cur = backoff.get(id) || 1500;
  const next = Math.min(cur * 2, 60_000);
  backoff.set(id, next);
  return cur;
}
function resetBackoff(id) { backoff.delete(id); }

const sink = () => {};
function makeLogger() {
  const self = {
    level: 'silent',
    trace: sink, debug: sink, info: sink, warn: sink,
    error: (...a) => console.error('[baileys]', ...a),
    fatal: (...a) => console.error('[baileys-fatal]', ...a),
    child() { return self; }
  };
  return self;
}

function sessionDir(connectionId) {
  return path.join(SESS_ROOT, String(connectionId));
}

async function startSession(connection, onMessage) {
  const id = Number(connection.id);
  const existing = sessions.get(id);
  if (existing && existing.status !== 'disconnected' && existing.status !== 'logged_out') return existing;

  const entry = {
    sock: null, qrDataUrl: null, phone: null,
    status: 'connecting', userId: connection.user_id, connectionId: id
  };
  sessions.set(id, entry);

  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: makeLogger(),
    browser: Browsers.appropriate
      ? Browsers.appropriate('Luckiest AI')
      : ['Luckiest AI', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    // Keep the WebSocket alive — without this 408 timeouts are common.
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    defaultQueryTimeoutMs: 60_000
  });

  entry.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection: connState, lastDisconnect, qr } = update;

    if (qr) {
      try {
        entry.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
        entry.status = 'qr';
      } catch (e) { console.error('[baileys] qr encode failed:', e.message); }
    }

    if (connState === 'open') {
      entry.status = 'connected';
      entry.qrDataUrl = null;
      entry.phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      resetBackoff(id);
      try {
        await query(
          `UPDATE platform_connections SET account_id = $1, active = 1 WHERE id = $2`,
          [entry.phone || `baileys-${id}`, id]
        );
      } catch (e) { console.error('[baileys] update conn failed:', e.message); }
      console.log(`[baileys] connection ${id} OPEN as +${entry.phone}`);
    }

    if (connState === 'close') {
      const code =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.output?.payload?.statusCode ||
        lastDisconnect?.error?.data?.statusCode;
      const reason = lastDisconnect?.error?.message || '';
      console.log(`[baileys] connection ${id} CLOSE code=${code} reason="${reason}"`);
      entry.sock = null;
      entry.qrDataUrl = null;

      // Decide what to do based on the disconnect reason.
      // Reference: https://github.com/WhiskeySockets/Baileys/blob/master/src/Types/index.ts
      const LOGGED_OUT       = DisconnectReason.loggedOut;        // 401
      const CONN_LOST        = DisconnectReason.connectionLost;   // 408
      const CONN_CLOSED      = DisconnectReason.connectionClosed; // 428
      const CONN_REPLACED    = DisconnectReason.connectionReplaced; // 440 — another device opened the session
      const RESTART_REQUIRED = DisconnectReason.restartRequired;  // 515
      const TIMED_OUT        = DisconnectReason.timedOut;         // 408
      const BAD_SESSION      = DisconnectReason.badSession;
      const MULTI_DEVICE_MISMATCH = DisconnectReason.multideviceMismatch;

      const shouldWipeCreds =
        code === LOGGED_OUT ||
        code === BAD_SESSION ||
        code === MULTI_DEVICE_MISMATCH ||
        code === 401;

      const shouldStop = code === CONN_REPLACED || code === 440;

      if (shouldWipeCreds) {
        entry.status = 'logged_out';
        sessions.delete(id);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        try { await query(`UPDATE platform_connections SET active = 0 WHERE id = $1`, [id]); } catch {}
        return; // operator must re-scan QR via the dashboard
      }

      if (shouldStop) {
        // Owner is using the session somewhere else; do not fight for it
        entry.status = 'disconnected';
        sessions.delete(id);
        return;
      }

      // 408 timeouts, 428 connection closed, 515 restart required, or anything else
      // unknown — reconnect with exponential backoff so we don't hammer servers.
      entry.status = 'reconnecting';
      const delay = nextBackoff(id);
      console.log(`[baileys] connection ${id} reconnecting in ${delay}ms`);
      setTimeout(() => {
        startSession(connection, onMessage)
          .catch(e => console.error('[baileys] reconnect failed:', e.message));
      }, delay);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message) continue;
      const remoteJid = m.key.remoteJid || '';
      if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) continue;
      const msg = m.message;
      let body =
        msg.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        msg.videoMessage?.caption ||
        msg.documentMessage?.caption ||
        '';
      let mediaType = null;
      if (!body && msg.audioMessage)   { body = '[voice message]'; mediaType = 'voice'; }
      else if (!body && msg.imageMessage)   { body = '[image]';   mediaType = 'image'; }
      else if (!body && msg.videoMessage)   { body = '[video]';   mediaType = 'video'; }
      else if (!body && msg.stickerMessage) { body = '[sticker]'; mediaType = 'sticker'; }
      if (!body) continue;

      // ── /cmd handling ──────────────────────────────────────────────────
      // If the *owner* texts themselves with "/cmd ..." we treat that as a
      // command, not a customer message. Owner-from-me detection: m.key.fromMe
      // is true when the message was sent from the same number that owns this
      // Baileys session.
      const isOwner = !!m.key.fromMe;
      const trimmed = body.trim();
      if (trimmed.toLowerCase().startsWith('/cmd ') || trimmed.toLowerCase() === '/cmd') {
        if (!isOwner) {
          // A customer cannot run commands. Silently ignore — do not even
          // surface that the command syntax exists.
          continue;
        }
        try {
          const result = await handleOwnerCommand({
            userId: entry.userId,
            connectionId: id,
            rawText: trimmed
          });
          // Reply back to the same chat (owner is texting themselves on the
          // chat they typed the command into) so they see confirmation.
          try { await sock.sendMessage(remoteJid, { text: result }); }
          catch (e) { console.error('[baileys] cmd reply failed:', e.message); }
        } catch (e) {
          console.error('[baileys] command failed:', e.message);
          try { await sock.sendMessage(remoteJid, { text: '⚠ Command failed: ' + e.message }); } catch {}
        }
        continue;
      }

      // Skip ordinary fromMe messages (owner's own replies to customers).
      if (isOwner) continue;

      const phone = remoteJid.split('@')[0];
      const pushName = m.pushName || phone;
      try {
        await onMessage({
          userId: entry.userId,
          platform: 'whatsapp_baileys',
          externalId: phone,
          customerName: pushName,
          customerHandle: '+' + phone,
          body,
          mediaType
        });
      } catch (e) { console.error('[baileys] handleIncoming failed:', e.message); }
    }
  });

  return entry;
}

/*
 * Owner-side commands the account-holder can type from their own WhatsApp.
 * Format: /cmd <verb> ...
 *
 *   /cmd help
 *   /cmd ai on <phone>     →  turn AI on for that contact
 *   /cmd ai off <phone>    →  turn AI off for that contact
 *   /cmd ai on all         →  turn AI on for every contact
 *   /cmd ai off all        →  turn AI off for every contact
 *   /cmd change price to <amount> for <product>
 *                          →  record/update a price for the named product so
 *                             the AI quotes it correctly on the next reply
 *   /cmd price list        →  show current prices
 *   /cmd contacts          →  list the most recent contacts
 */
async function handleOwnerCommand({ userId, connectionId, rawText }) {
  const text = rawText.replace(/^\/cmd\s*/i, '').trim();
  if (!text || /^help$/i.test(text)) {
    return [
      '🤖 Luckiest-AI commands:',
      '',
      '/cmd ai on <phone>            turn AI on for that contact',
      '/cmd ai off <phone>           turn AI off for that contact',
      '/cmd ai on all                turn AI on for everyone',
      '/cmd ai off all               turn AI off for everyone',
      '/cmd change price to 50 for shoes',
      '/cmd price list',
      '/cmd contacts'
    ].join('\n');
  }

  // ai on/off <phone|all>
  let m = text.match(/^ai\s+(on|off)\s+(.+)$/i);
  if (m) {
    const onoff = m[1].toLowerCase() === 'on' ? 1 : 0;
    const target = m[2].trim();
    if (/^all$/i.test(target)) {
      await query('UPDATE conversations SET ai_enabled = $1 WHERE user_id = $2', [onoff, userId]);
      return `✓ AI ${onoff ? 'ON' : 'OFF'} for all contacts`;
    }
    const ext = target.replace(/\D/g, '');
    if (!ext) return '⚠ Need a phone number, e.g. /cmd ai on 2348012345678';
    const r = await query(
      `UPDATE conversations SET ai_enabled = $1
       WHERE user_id = $2 AND platform = 'whatsapp_baileys' AND external_id = $3`,
      [onoff, userId, ext]
    );
    if (!r.rowCount) return `⚠ No contact found for +${ext}. They have to message you first.`;
    return `✓ AI ${onoff ? 'ON' : 'OFF'} for +${ext}`;
  }

  // change price to <amount> for <product>
  m = text.match(/^change\s+price\s+to\s+([^\s]+(?:\s+[^\s]+)?)\s+for\s+(.+)$/i);
  if (m) {
    const amount = m[1].trim();
    const product = m[2].trim();
    return await upsertPrice(userId, product, amount);
  }

  if (/^price\s+list$/i.test(text)) {
    return await listPrices(userId);
  }

  if (/^contacts$/i.test(text)) {
    const r = await query(
      `SELECT customer_name, external_id, ai_enabled, status FROM conversations
       WHERE user_id = $1 AND platform = 'whatsapp_baileys'
       ORDER BY last_message_at DESC LIMIT 15`,
      [userId]
    );
    if (!r.rowCount) return 'No contacts yet.';
    return r.rows.map(c =>
      `• ${c.customer_name || '+' + c.external_id} — AI ${c.ai_enabled ? 'ON' : 'OFF'} (${c.status})`
    ).join('\n');
  }

  return '⚠ Unknown command. Try `/cmd help`.';
}

/*
 * Prices are kept in profiles.business_info under a marker block so that:
 *   - the AI sees them on every reply (it reads business_info), and
 *   - the owner can still write free-form business info above the marker.
 *
 * Block format:
 *   --- PRICES (auto) ---
 *   shoes: 50
 *   shipping: 10
 *   --- /PRICES ---
 */
const PRICE_BEGIN = '--- PRICES (auto) ---';
const PRICE_END   = '--- /PRICES ---';

async function _readPrices(userId) {
  const r = await query('SELECT business_info FROM profiles WHERE user_id = $1', [userId]);
  const info = r.rows[0]?.business_info || '';
  const start = info.indexOf(PRICE_BEGIN);
  const end   = info.indexOf(PRICE_END);
  const prices = new Map();
  if (start !== -1 && end !== -1 && end > start) {
    const block = info.slice(start + PRICE_BEGIN.length, end);
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      if (m) prices.set(m[1].trim().toLowerCase(), m[2].trim());
    }
  }
  return { info, prices, hasBlock: start !== -1 && end !== -1 };
}

async function upsertPrice(userId, product, amount) {
  await query(
    `INSERT INTO profiles (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const { info, prices, hasBlock } = await _readPrices(userId);
  const key = product.toLowerCase();
  prices.set(key, amount);

  const block = [
    PRICE_BEGIN,
    ...[...prices.entries()].map(([p, a]) => `${p}: ${a}`),
    PRICE_END
  ].join('\n');

  let next;
  if (hasBlock) {
    const start = info.indexOf(PRICE_BEGIN);
    const end   = info.indexOf(PRICE_END) + PRICE_END.length;
    next = info.slice(0, start) + block + info.slice(end);
  } else {
    next = (info ? info.trimEnd() + '\n\n' : '') + block;
  }
  await query(
    'UPDATE profiles SET business_info = $1, updated_at = $2 WHERE user_id = $3',
    [next, Date.now(), userId]
  );
  return `✓ Price saved — ${product}: ${amount}\nThe AI will now quote this on the next reply.`;
}

async function listPrices(userId) {
  const { prices } = await _readPrices(userId);
  if (!prices.size) return 'No prices saved. Try `/cmd change price to 50 for shoes`.';
  return ['💰 Current prices:', ...[...prices.entries()].map(([p, a]) => `• ${p}: ${a}`)].join('\n');
}

function getSession(connectionId) {
  return sessions.get(Number(connectionId));
}

function getStatus(connectionId) {
  const entry = sessions.get(Number(connectionId));
  if (!entry) return { status: 'inactive' };
  return { status: entry.status, qr: entry.qrDataUrl, phone: entry.phone };
}

async function disconnectSession(connectionId) {
  const id = Number(connectionId);
  const entry = sessions.get(id);
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch {}
    try { entry.sock.end?.(); } catch {}
    sessions.delete(id);
  }
  try { fs.rmSync(sessionDir(id), { recursive: true, force: true }); } catch {}
}

async function sendMessage({ userId, externalId, body }) {
  const r = await query(
    `SELECT * FROM platform_connections WHERE user_id = $1 AND platform = 'whatsapp_baileys' AND active = 1 LIMIT 1`,
    [userId]
  );
  const conn = r.rows[0];
  if (!conn) throw new Error('No WhatsApp (Baileys) connection');
  const entry = sessions.get(Number(conn.id));
  if (!entry || entry.status !== 'connected' || !entry.sock) throw new Error('WhatsApp socket not connected');
  const digits = String(externalId).replace(/\D/g, '');
  const jid = String(externalId).includes('@') ? externalId : `${digits}@s.whatsapp.net`;
  await entry.sock.sendMessage(jid, { text: body });
}

async function bootstrapAll(onMessage) {
  const r = await query(
    `SELECT * FROM platform_connections WHERE platform = 'whatsapp_baileys' AND active = 1`
  );
  for (const conn of r.rows) {
    try { await startSession(conn, onMessage); }
    catch (e) { console.error('[baileys] bootstrap', conn.id, e.message); }
  }
  console.log(`[baileys] bootstrap: ${r.rowCount} session(s)`);
}

module.exports = {
  startSession, getSession, getStatus, disconnectSession,
  sendMessage, bootstrapAll, handleOwnerCommand
};
