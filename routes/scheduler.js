const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../database');
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

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM scheduled_posts WHERE user_id = ? ORDER BY scheduled_for DESC LIMIT 200`
  ).all(req.session.userId);
  res.json({ posts: rows.map(r => ({ ...r, platforms: JSON.parse(r.platforms || '[]') })) });
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

    const info = db.prepare(
      `INSERT INTO scheduled_posts (user_id, platforms, caption, media_path, media_type, scheduled_for, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(req.session.userId, JSON.stringify(platformsArr), finalCaption, mediaPath, mediaType, when, Date.now());

    res.json({ ok: true, id: info.lastInsertRowid, caption: finalCaption });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/caption', requireAuth, async (req, res) => {
  const caption = await generateCaption({ userId: req.session.userId, prompt: req.body?.prompt });
  res.json({ caption });
});

router.delete('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM scheduled_posts WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!post) return res.status(404).json({ error: 'not found' });
  if (post.media_path) {
    try { fs.unlinkSync(path.join(uploadDir, path.basename(post.media_path))); } catch {}
  }
  db.prepare('DELETE FROM scheduled_posts WHERE id = ?').run(post.id);
  res.json({ ok: true });
});

module.exports = router;
