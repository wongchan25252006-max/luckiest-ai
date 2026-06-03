require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { db, seedAdmin, ensureSubscription } = require('./database');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

if (isProd) app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd }
}));

app.use(express.static(path.join(__dirname, 'public')));

seedAdmin();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Luckiest-AI running on port ${PORT}`);
  console.log(`Admin: ${process.env.ADMIN_EMAIL || 'admin@luckiest.ai'}`);
});