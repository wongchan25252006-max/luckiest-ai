const cron = require('node-cron');
const path = require('path');
const { query } = require('../database');

const uploadDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const facebook = require('./facebook');
const instagram = require('./instagram');
const telegram = require('./telegram');
const { notify } = require('./notifications');

const publishers = {
  facebook: facebook.publishPost,
  instagram: instagram.publishPost,
  telegram: telegram.publishPost
};

async function processDuePosts() {
  const now = Date.now();
  const dueR = await query(
    `SELECT * FROM scheduled_posts WHERE status = 'pending' AND scheduled_for <= $1 LIMIT 25`,
    [now]
  );
  const due = dueR.rows;

  for (const post of due) {
    await query(`UPDATE scheduled_posts SET status = 'processing' WHERE id = $1`, [post.id]);
    const platforms = JSON.parse(post.platforms || '[]');
    const errors = [];
    const localPath = post.media_path ? path.join(uploadDir, path.basename(post.media_path)) : null;
    const publicBase = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
    const mediaUrl = post.media_path
      ? `${publicBase}/uploads/${path.basename(post.media_path)}`
      : null;
    const isVideo = post.media_type === 'video';

    for (const platform of platforms) {
      const pub = publishers[platform];
      if (!pub) { errors.push(`${platform}: unsupported`); continue; }
      try {
        await pub({
          userId: post.user_id,
          caption: post.caption || '',
          imageUrl: isVideo ? null : mediaUrl,
          videoUrl: isVideo ? mediaUrl : null,
          imagePath: isVideo ? null : localPath,
          videoPath: isVideo ? localPath : null
        });
      } catch (err) {
        errors.push(`${platform}: ${err.message}`);
      }
    }

    if (errors.length === platforms.length) {
      await query(`UPDATE scheduled_posts SET status = 'failed', error = $1 WHERE id = $2`, [errors.join(' | '), post.id]);
      await notify({
        userId: post.user_id, type: 'post_failed',
        title: `Scheduled post failed`, body: errors.join('\n')
      });
    } else {
      await query(
        `UPDATE scheduled_posts SET status = $1, posted_at = $2, error = $3 WHERE id = $4`,
        [errors.length ? 'partial' : 'posted', Date.now(), errors.join(' | ') || null, post.id]
      );
      await notify({
        userId: post.user_id, type: 'post_published',
        title: `Post published to ${platforms.filter(p => !errors.find(e => e.startsWith(p))).join(', ')}`,
        body: (post.caption || '').slice(0, 200)
      });
    }
  }
}

function start() {
  cron.schedule('* * * * *', () => {
    processDuePosts().catch(err => console.error('[scheduler] tick failed', err.message));
  });
  console.log('[scheduler] started (runs every minute)');
}

module.exports = { start, processDuePosts };
