// Zentrale Konfiguration. Liest Werte aus Umgebungsvariablen (.env optional).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Minimaler .env-Loader (ohne externe Abhaengigkeit), damit eine lokale
// .env-Datei beim Start eingelesen wird.
const envPath = path.join(rootDir, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const config = {
  rootDir,
  port: Number(process.env.PORT) || 3000,
  authSecret: process.env.AUTH_SECRET || 'unsicherer-entwicklungs-schluessel',
  dbPath: path.join(rootDir, 'data', 'myla2.db'),
  // ICE-Server fuer WebRTC. STUN hilft beim NAT-Durchstich; TURN ist optional.
  iceServers: buildIceServers(),
};

function buildIceServers() {
  const servers = [];
  const stun = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (stun.length) servers.push({ urls: stun });

  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }
  return servers;
}

if (config.authSecret === 'unsicherer-entwicklungs-schluessel') {
  console.warn(
    '[WARN] AUTH_SECRET ist nicht gesetzt. Nur fuer Entwicklung verwenden!'
  );
}
