// REST-API: Registrierung, Login, Profil, Meldungen, Moderation.
import express from 'express';
import { db, nowIso } from './db.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  requireAuth,
  requireModerator,
} from './auth.js';
import { config } from './config.js';

export const apiRouter = express.Router();

// Berechnet das Alter in vollen Jahren aus einem Geburtsdatum (YYYY-MM-DD).
function ageFromBirthdate(birthdate) {
  const b = new Date(birthdate);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    isModerator: !!u.is_moderator,
  };
}

function setSessionCookie(res, token) {
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

// --- Konfiguration fuer den Client -----------------------------------------

apiRouter.get('/config', (req, res) => {
  res.json({ iceServers: config.iceServers });
});

// --- Registrierung ---------------------------------------------------------

apiRouter.post('/auth/register', (req, res) => {
  const { username, email, password, birthdate, ageConfirmed } = req.body || {};

  if (!username || !email || !password || !birthdate) {
    return res.status(400).json({ error: 'Bitte alle Felder ausfuellen.' });
  }
  if (String(username).length < 3 || String(username).length > 24) {
    return res
      .status(400)
      .json({ error: 'Benutzername: 3 bis 24 Zeichen.' });
  }
  if (String(password).length < 8) {
    return res
      .status(400)
      .json({ error: 'Passwort muss mindestens 8 Zeichen haben.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Ungueltige E-Mail-Adresse.' });
  }

  const age = ageFromBirthdate(birthdate);
  if (age === null) {
    return res.status(400).json({ error: 'Ungueltiges Geburtsdatum.' });
  }
  // Kernregel der 18+-Plattform: Zugang nur ab 18 Jahren.
  if (age < 18) {
    return res.status(403).json({
      error:
        'Diese Plattform ist ausschliesslich fuer Personen ab 18 Jahren.',
    });
  }
  if (!ageConfirmed) {
    return res
      .status(400)
      .json({ error: 'Bitte bestaetige, dass du mindestens 18 Jahre alt bist.' });
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO users (username, email, password_hash, birthdate, age_confirmed, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`
      )
      .run(
        String(username).trim(),
        String(email).trim().toLowerCase(),
        hashPassword(String(password)),
        birthdate,
        nowIso()
      );
    const user = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(result.lastInsertRowid);
    const token = createSession(user.id);
    setSessionCookie(res, token);
    res.json({ user: publicUser(user), token });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res
        .status(409)
        .json({ error: 'Benutzername oder E-Mail bereits vergeben.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Serverfehler bei der Registrierung.' });
  }
});

// --- Login -----------------------------------------------------------------

apiRouter.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'E-Mail und Passwort erforderlich.' });
  }
  const user = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(String(email).trim().toLowerCase());

  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Falsche Zugangsdaten.' });
  }
  if (user.is_banned) {
    return res.status(403).json({ error: 'Dieses Konto wurde gesperrt.' });
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ user: publicUser(user), token });
});

// --- Logout ----------------------------------------------------------------

apiRouter.post('/auth/logout', (req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  res.clearCookie('session');
  res.json({ ok: true });
});

// --- Aktuelles Profil ------------------------------------------------------

apiRouter.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: publicUser(req.user) });
});

// --- Meldung erstellen -----------------------------------------------------

apiRouter.post('/report', requireAuth, (req, res) => {
  const { reportedUsername, reason, details } = req.body || {};
  if (!reason) {
    return res.status(400).json({ error: 'Grund erforderlich.' });
  }
  let reportedId = null;
  if (reportedUsername) {
    const reported = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(String(reportedUsername).trim());
    reportedId = reported?.id ?? null;
  }
  db.prepare(
    `INSERT INTO reports (reporter_id, reported_id, reason, details, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    req.user.id,
    reportedId,
    String(reason).slice(0, 100),
    details ? String(details).slice(0, 1000) : null,
    nowIso()
  );
  res.json({ ok: true });
});

// --- Moderation ------------------------------------------------------------

apiRouter.get('/mod/reports', requireAuth, requireModerator, (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, ru.username AS reporter_name, tu.username AS reported_name
       FROM reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users tu ON tu.id = r.reported_id
       WHERE r.status = 'open'
       ORDER BY r.created_at DESC
       LIMIT 200`
    )
    .all();
  res.json({ reports: rows });
});

apiRouter.post('/mod/ban', requireAuth, requireModerator, (req, res) => {
  const { username } = req.body || {};
  const target = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(String(username || '').trim());
  if (!target) return res.status(404).json({ error: 'Nutzer nicht gefunden.' });
  db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(target.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  db.prepare(
    "UPDATE reports SET status = 'actioned' WHERE reported_id = ?"
  ).run(target.id);
  res.json({ ok: true });
});

apiRouter.post('/mod/dismiss', requireAuth, requireModerator, (req, res) => {
  const { reportId } = req.body || {};
  db.prepare("UPDATE reports SET status = 'reviewed' WHERE id = ?").run(
    Number(reportId)
  );
  res.json({ ok: true });
});
