// Server-Einstiegspunkt: HTTP-API + statisches Frontend + WebSocket-Signaling.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { apiRouter } from './routes.js';
import { attachWebSocket, onlineStats } from './matchmaking.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '256kb' }));

// Minimaler Cookie-Parser (vermeidet zusaetzliche Abhaengigkeit).
app.use((req, res, next) => {
  const header = req.headers.cookie;
  req.cookies = {};
  if (header) {
    for (const pair of header.split(';')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      req.cookies[k] = decodeURIComponent(v);
    }
  }
  next();
});

app.use(authMiddleware);

app.get('/healthz', (req, res) => res.json({ ok: true, ...onlineStats() }));
app.use('/api', apiRouter);

// Statisches Frontend ausliefern.
const clientDir = path.resolve(__dirname, '..', 'client');
app.use(express.static(clientDir));

// SPA-Fallback: alle uebrigen Routen auf index.html.
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

const server = http.createServer(app);
attachWebSocket(server);

server.listen(config.port, () => {
  console.log(`myla2 laeuft auf http://localhost:${config.port}`);
});
