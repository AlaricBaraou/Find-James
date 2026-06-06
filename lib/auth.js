'use strict';

// Passwordless magic-link authentication. Anonymous by design: we store an
// email only to deliver the login link; everyone else sees a chosen nickname.
//
// Graceful: with no SMTP configured (and dev-echo off), auth is disabled and
// the rest of the app works exactly as before.

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const { collection } = require('./collection');

const TOKEN_TTL_MS = 15 * 60 * 1000; // magic link valid 15 min
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function setupAuth(app, opts) {
  const dataDir = opts.dataDir;
  const users = collection(dataDir, 'users');
  const sessions = collection(dataDir, 'sessions');
  const tokens = collection(dataDir, 'logintokens');

  const MAIL_FROM = process.env.MAIL_FROM || 'Search Map <no-reply@localhost>';
  const DEV_ECHO = process.env.AUTH_DEV_ECHO === '1' && process.env.NODE_ENV !== 'production';
  const PUBLIC_URL = process.env.PUBLIC_URL || ''; // optional override, e.g. https://site

  let transporter = null;
  if (process.env.MAIL_SMTP_URL) {
    try {
      transporter = nodemailer.createTransport(process.env.MAIL_SMTP_URL);
    } catch (e) {
      console.error('Invalid MAIL_SMTP_URL:', e.message);
    }
  }
  const enabled = Boolean(transporter) || DEV_ECHO;

  async function sendMail(to, subject, text) {
    if (!transporter) {
      console.log('[mail:noop] to=%s subject=%s\n%s', to, subject, text);
      return;
    }
    await transporter.sendMail({ from: MAIL_FROM, to, subject, text });
  }

  function baseUrl(req) {
    if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '');
    return req.protocol + '://' + req.get('host');
  }

  function cookieOpts(req) {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || process.env.COOKIE_SECURE === '1',
      maxAge: SESSION_TTL_MS,
      path: '/',
    };
  }

  // ---- Current user from session cookie ----
  function getUser(req) {
    const sid = req.cookies && req.cookies.sid;
    if (!sid) return null;
    const sess = sessions.find((s) => s.id === sid);
    if (!sess || sess.expiresAt < Date.now()) return null;
    return users.get(sess.userId);
  }
  function requireUser(req, res, next) {
    const u = getUser(req);
    if (!u) return res.status(401).json({ error: 'Sign in required.' });
    req.user = u;
    next();
  }

  // ---- Routes ----
  const reqLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

  app.post('/api/auth/request', reqLimiter, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Sign-in is not configured yet.' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });

    const raw = crypto.randomBytes(32).toString('hex');
    tokens.add({ id: crypto.randomUUID(), tokenHash: sha256(raw), email, expiresAt: Date.now() + TOKEN_TTL_MS, used: false });

    const link = baseUrl(req) + '/api/auth/verify?token=' + raw;
    try {
      await sendMail(
        email,
        '捜索マップ ログイン / Search Map sign-in',
        'このリンクで15分以内にログイン / Sign in within 15 minutes:\n\n' + link +
          '\n\n心当たりがなければ無視してください / If you did not request this, ignore it.'
      );
    } catch (e) {
      console.error('sendMail failed:', e.message);
      return res.status(502).json({ error: 'Could not send the email. Try again later.' });
    }
    const out = { ok: true };
    if (DEV_ECHO) out.devLink = link; // testing only; never set AUTH_DEV_ECHO in production
    res.json(out);
  });

  app.get('/api/auth/verify', (req, res) => {
    const raw = String(req.query.token || '');
    const rec = tokens.find((t) => t.tokenHash === sha256(raw));
    if (!rec || rec.used || rec.expiresAt < Date.now()) {
      return res.status(400).send('リンクが無効または期限切れです / Link invalid or expired.');
    }
    tokens.update(rec.id, { used: true });

    let user = users.find((u) => u.email === rec.email);
    if (!user) {
      user = users.add({ id: crypto.randomUUID(), email: rec.email, nickname: '', createdAt: new Date().toISOString() });
    }
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.add({ id: sid, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    res.cookie('sid', sid, cookieOpts(req));
    // New users land on a nickname prompt; returning users go home.
    res.redirect(user.nickname ? '/' : '/?setname=1');
  });

  app.get('/api/auth/me', (req, res) => {
    const u = getUser(req);
    res.json({ user: u ? { id: u.id, nickname: u.nickname, hasNickname: Boolean(u.nickname) } : null });
  });

  app.post('/api/auth/nickname', requireUser, (req, res) => {
    const nick = String((req.body && req.body.nickname) || '').trim().slice(0, 40);
    if (nick.length < 2) return res.status(400).json({ error: 'Nickname too short.' });
    users.update(req.user.id, { nickname: nick });
    res.json({ ok: true, nickname: nick });
  });

  app.post('/api/auth/logout', (req, res) => {
    const sid = req.cookies && req.cookies.sid;
    if (sid) sessions.remove(sid);
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  });

  return { enabled, getUser, requireUser, sendMail, users };
}

module.exports = { setupAuth };
