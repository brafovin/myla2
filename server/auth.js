// Authentifizierung: Passwort-Hashing (scrypt) und Session-Tokens (HMAC).
// Verwendet ausschliesslich node:crypto, keine externen Krypto-Pakete.
import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { config } from './config.js';

const SESSION_TTL_DAYS = 30;

// --- Passwoerter -----------------------------------------------------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, derived);
}

// --- Session-Tokens --------------------------------------------------------

function sign(value) {
  return crypto
    .createHmac('sha256', config.authSecret)
    .update(value)
    .digest('hex');
}

export function createSession(userId) {
  const random = crypto.randomBytes(24).toString('hex');
  const token = `${userId}.${random}.${sign(`${userId}.${random}`)}`;
  const created = nowIso();
  const expires = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, created, expires);
  return token;
}

export function getUserByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, random, sig] = parts;
  if (sign(`${userId}.${random}`) !== sig) return null; // gefaelscht

  const session = db
    .prepare('SELECT * FROM sessions WHERE token = ?')
    .get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
}

export function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// --- Express-Middleware ----------------------------------------------------

// Liest den Token aus Cookie oder Authorization-Header und haengt req.user an.
export function authMiddleware(req, res, next) {
  const token =
    req.cookies?.session ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  req.user = getUserByToken(token) || null;
  req.sessionToken = token || null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  if (req.user.is_banned) {
    return res.status(403).json({ error: 'Konto gesperrt' });
  }
  next();
}

export function requireModerator(req, res, next) {
  if (!req.user?.is_moderator) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  next();
}
