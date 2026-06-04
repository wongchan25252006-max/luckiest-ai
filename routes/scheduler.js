const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { query } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { generateCaption } = require('../services/ai');

const router = express.Router();

const uploadDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype))
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM scheduled_posts WHERE user_id = $1 ORDER BY scheduled_for DESC LIMIT 200`,
      [req.session.userId]
    );
    res.json({ posts: r.rows.map(p => ({ ...p, platforms: JSON.parse(p.platforms || '[]') })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, upload.single('media'), async (req, res) => {
  try {
    const { caption, scheduled_for, platforms, auto_caption_prompt } = req.body;
    const platformsArr = Array.isArray(platforms)
      ? platforms
      : (platforms || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!platformsArr.length) return res.status(400).json({ error: 'select at least one platform' });
    if (!scheduled_for) return res.status(400).json({ error: 'scheduled_for required' });

    const when = new Date(scheduled_for).getTime();
    if (!Number.isFinite(when)) return res.status(400).json({ error: 'invalid date' });

    let finalCaption = caption || '';
    if (!finalCaption && auto_caption_prompt) {
      finalCaption = await generateCaption({ userId: req.session.userId, prompt: auto_caption_prompt });
    }
    if (!finalCaption && req.file) {
      finalCaption = await generateCaption({
        userId: req.session.userId,
        prompt: `Write a caption for this ${/^video/.test(req.file.mimetype) ? 'video' : 'photo'} I am about to post.`
      });
    }

    const mediaPath = req.file ? `uploads/${req.file.filename}` : null;
    const mediaType = req.file ? (/^video/.test(req.file.mimetype) ? 'video' : 'image') : null;

    const r = await query(
      `INSERT INTO scheduled_posts (user_id, platforms, caption, media_path, media_type, scheduled_for, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING id`,
      [req.session.userId, JSON.stringify(platformsArr), finalCaption, mediaPath, mediaType, when, Date.now()]
    );

    res.json({ ok: true, id: r.rows[0].id, caption: finalCaption });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/caption', requireAuth, async (req, res) => {
  try {
    const caption = await generateCaption({ userId: req.session.userId, prompt: req.body?.prompt });
    res.json({ caption });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const r = await query('SELECT * FROM scheduled_posts WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    const post = r.rows[0];
    if (!post) return res.status(404).json({ error: 'not found' });
    if (post.media_path) {
      try { fs.unlinkSync(path.join(uploadDir, path.basename(post.media_path))); } catch {}
    }
    await query('DELETE FROM scheduled_posts WHERE id = $1', [post.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
