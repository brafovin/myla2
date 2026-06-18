// Datenbankschicht auf Basis des eingebauten node:sqlite Moduls.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Schema. created_at/updated_at als ISO-Strings (UTC).
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    birthdate     TEXT    NOT NULL,           -- YYYY-MM-DD
    age_confirmed INTEGER NOT NULL DEFAULT 0, -- 18+ bestaetigt
    is_banned     INTEGER NOT NULL DEFAULT 0,
    is_moderator  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id  INTEGER,
    reported_id  INTEGER,
    reason       TEXT NOT NULL,
    details      TEXT,
    status       TEXT NOT NULL DEFAULT 'open', -- open | reviewed | actioned
    created_at   TEXT NOT NULL,
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reported_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

export function nowIso() {
  return new Date().toISOString();
}
