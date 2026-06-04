const express = require('express');
const { query } = require('../database');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    async function c(sql, params = []) {
      try { const r = await query(sql, params); return Number(r.rows[0].n); }
      catch { return 0; }
    }

    const userId = req.session?.userId;
    let stats;

    if (userId) {
      stats = {
        scope: 'user',
        messages: await c(
          `SELECT COUNT(*) AS n FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE c.user_id = $1`, [userId]),
        ai_replies: await c(
          `SELECT COUNT(*) AS n FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE c.user_id = $1 AND m.ai_generated = 1`, [userId]),
        conversations: await c(
          `SELECT COUNT(*) AS n FROM conversations WHERE user_id = $1`, [userId]),
        platforms: await c(
          `SELECT COUNT(*) AS n FROM platform_connections WHERE user_id = $1 AND active = 1`, [userId])
      };
    } else {
      stats = {
        scope: 'global',
        messages: await c('SELECT COUNT(*) AS n FROM messages'),
        ai_replies: await c('SELECT COUNT(*) AS n FROM messages WHERE ai_generated = 1'),
        conversations: await c('SELECT COUNT(*) AS n FROM conversations'),
        platforms: await c('SELECT COUNT(*) AS n FROM platform_connections WHERE active = 1')
      };
    }

    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
