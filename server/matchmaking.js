// Matchmaking + WebRTC-Signaling ueber WebSocket.
// Paart zwei wartende Nutzer zu einem Raum und leitet Signal-/Chat-Nachrichten
// zwischen ihnen weiter. "Next" verlaesst den Raum und stellt sich neu an.
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { getUserByToken } from './auth.js';

// Aktive Verbindungen: ws -> Client-Status
// Client: { ws, user, partner|null, roomId|null, state: 'idle'|'waiting'|'paired' }
const clients = new Map();

// Warteschlange (FIFO) von Clients, die einen Partner suchen.
const queue = [];

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function removeFromQueue(client) {
  const idx = queue.indexOf(client);
  if (idx !== -1) queue.splice(idx, 1);
}

// Versucht, zwei wartende Clients zu paaren.
function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    // Ungueltige/getrennte Eintraege ueberspringen.
    if (!a || a.state !== 'waiting' || a.ws.readyState !== a.ws.OPEN) {
      if (b) queue.unshift(b);
      continue;
    }
    if (!b || b.state !== 'waiting' || b.ws.readyState !== b.ws.OPEN) {
      if (a) queue.unshift(a);
      continue;
    }
    // Nicht mit sich selbst (gleicher Account, z.B. zweiter Tab) paaren.
    if (a.user.id === b.user.id) {
      queue.push(b);
      continue;
    }
    pair(a, b);
  }
}

function pair(a, b) {
  const roomId = crypto.randomUUID();
  a.partner = b;
  b.partner = a;
  a.roomId = b.roomId = roomId;
  a.state = b.state = 'paired';

  // a ist der Initiator und erstellt das WebRTC-Angebot.
  send(a.ws, { type: 'matched', initiator: true, partner: b.user.username });
  send(b.ws, { type: 'matched', initiator: false, partner: a.user.username });
}

// Loest die aktuelle Paarung; benachrichtigt optional den Partner.
function leaveRoom(client, notifyPartner = true) {
  const partner = client.partner;
  if (partner) {
    partner.partner = null;
    partner.roomId = null;
    partner.state = 'idle';
    if (notifyPartner) send(partner.ws, { type: 'partner_left' });
  }
  client.partner = null;
  client.roomId = null;
  if (client.state === 'paired') client.state = 'idle';
}

function enqueue(client) {
  leaveRoom(client);
  removeFromQueue(client);
  client.state = 'waiting';
  queue.push(client);
  send(client.ws, { type: 'waiting' });
  tryMatch();
}

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Token aus der Query (?token=...) ODER aus dem Session-Cookie lesen.
    let token = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      token = url.searchParams.get('token');
    } catch {
      /* ignore */
    }
    if (!token && req.headers.cookie) {
      const m = req.headers.cookie.match(/(?:^|;\s*)session=([^;]+)/);
      if (m) token = decodeURIComponent(m[1]);
    }
    const user = getUserByToken(token);
    if (!user || user.is_banned) {
      send(ws, { type: 'auth_error', error: 'Nicht angemeldet oder gesperrt.' });
      ws.close();
      return;
    }

    const client = {
      ws,
      user,
      partner: null,
      roomId: null,
      state: 'idle',
    };
    clients.set(ws, client);
    send(ws, { type: 'auth_ok', username: user.username });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handleMessage(client, msg);
    });

    ws.on('close', () => {
      removeFromQueue(client);
      leaveRoom(client);
      clients.delete(ws);
      tryMatch();
    });

    ws.on('error', () => {});
  });

  // Periodisches Aufraeumen toter Eintraege in der Warteschlange.
  setInterval(() => {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].ws.readyState !== queue[i].ws.OPEN) queue.splice(i, 1);
    }
  }, 30000).unref();

  return wss;
}

function handleMessage(client, msg) {
  switch (msg.type) {
    case 'queue':
      // Sucht (erneut) einen zufaelligen Partner.
      enqueue(client);
      break;

    case 'next':
      // Aktuellen Partner verlassen und neuen suchen.
      enqueue(client);
      break;

    case 'stop':
      // Chat komplett verlassen, nicht erneut anstellen.
      removeFromQueue(client);
      leaveRoom(client);
      client.state = 'idle';
      send(client.ws, { type: 'stopped' });
      break;

    case 'signal':
      // WebRTC-Signal (offer/answer/ICE) an den Partner weiterleiten.
      if (client.partner) {
        send(client.partner.ws, { type: 'signal', data: msg.data });
      }
      break;

    case 'chat':
      // Text-Chat an den Partner weiterleiten.
      if (client.partner && typeof msg.text === 'string') {
        send(client.partner.ws, {
          type: 'chat',
          text: msg.text.slice(0, 2000),
        });
      }
      break;

    default:
      break;
  }
}

export function onlineStats() {
  return { online: clients.size, waiting: queue.length };
}
