# Luckiest AI

An AI-powered social media management platform. Users sign up, describe themselves
(bio, tone, languages, business info, sample messages), connect their social
accounts, and a Claude-powered AI replies to DMs and comments **as them** — in
any language, including Nigerian Pidgin English. Admins see every conversation
and get notified when a customer needs a human.

## Features

- Email + password signup / login (session-based)
- Profile training page (bio, personality, tone, languages, FAQ, sample messages, escalation keywords)
- Platform connectors for **Facebook Pages, Instagram Business, WhatsApp Cloud API, Telegram Bots**
- AI auto-reply in the user's voice, matching the customer's language (English / Pidgin / Yoruba / French / etc.)
- Smart escalation: AI flags `needs_human=true` when it can't help, customer is angry, or hits user-defined keywords
- Unified inbox per user — human can take over any thread
- Notification feed (per user + mirrored to admin)
- **Admin dashboard** with platform-wide stats, alerts, every user, every conversation
- **Post scheduler**: upload image, write/AI-generate caption, pick time, choose platforms; cron publishes every minute

## Quick start

```bash
cd "C:\Users\ifean\Desktop\luckiest-ai"
npm install
copy .env.example .env
# edit .env — at minimum set ANTHROPIC_API_KEY
npm start
```

Open <http://localhost:3000>.

Default admin login (from `.env`):
- email: `admin@luckiest.ai`
- password: `ChangeMe!2026`

## Project layout

```
luckiest-ai/
  server.js              Express app entrypoint
  database.js            better-sqlite3 schema + admin seed
  middleware/auth.js     session guards
  services/
    ai.js                Claude prompt assembly + reply / caption generation
    messaging.js         inbound-message pipeline (save → AI → send → escalate)
    facebook.js          Page Messenger send + feed publish
    instagram.js         IG DM send + media publish + comment reply
    whatsapp.js          WhatsApp Cloud API send
    telegram.js          Bot polling + send + channel publish
    notifications.js     in-app notifications (mirrored to admins)
    scheduler.js         node-cron tick that publishes due posts
  routes/
    auth.js              signup / login / logout / me
    profile.js           GET/PUT the user's AI training data
    platforms.js         CRUD on platform connections
    messages.js          conversations, threads, manual replies, notifications
    scheduler.js         CRUD on scheduled posts + multer upload + AI caption
    admin.js             admin stats, users, conversations, alerts
    webhooks.js          Meta + WhatsApp inbound webhooks
  public/                static HTML/CSS/JS frontend (no build step)
  data/luckiest.db       SQLite database (auto-created)
  uploads/               scheduled-post images (auto-created)
```

## How the AI personalization works

Each user fills out a profile with bio, personality, tone, languages they speak,
business info, FAQ, and (most importantly) **sample messages they've actually
sent**. When a customer message arrives, the server builds a Claude system
prompt that includes all of this plus the conversation history, and asks Claude
to respond in JSON: `{reply, needs_human, reason}`. The reply is sent through
the matching platform SDK; `needs_human=true` flips the conversation to
"needs help" and notifies the user + admins.

The system prompt explicitly instructs Claude to **match the language and
dialect of the incoming message** — so a Pidgin message gets a Pidgin reply,
a French message a French reply.

## Webhooks

After deploying (or via ngrok in dev), register these URLs in your platform
dashboards:

- Meta (Facebook + Instagram): `https://your-domain/webhooks/meta`
  - Verify token: value of `META_VERIFY_TOKEN`
  - Subscribe to: `messages`, `messaging_postbacks`, `comments`
- WhatsApp Cloud API: `https://your-domain/webhooks/whatsapp`
  - Verify token: value of `WHATSAPP_VERIFY_TOKEN`
- Telegram: nothing to register — bots poll directly.

## Production notes

- The default session store is in-memory; for production swap in
  `connect-sqlite3` or Redis.
- `better-sqlite3` is single-writer; fine up to a few thousand users. Scale up
  to Postgres if you cross that.
- The scheduler runs every minute. For sub-minute precision use a different
  cron expression in `services/scheduler.js`.
- Set `PUBLIC_URL` to your real public origin so the scheduler can hand Instagram
  & Facebook the correct image URLs (they need to fetch them).
