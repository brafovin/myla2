// myla2 Frontend: Altersgate, Auth, Matchmaking, WebRTC, Chat, Moderation.

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  ws: null,
  pc: null,
  localStream: null,
  isInitiator: false,
  partnerName: null,
  partnerId: null,
  inCall: false,
};

// --- kleine API-Hilfen -----------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler');
  return data;
}

// ===========================================================================
// Altersgate
// ===========================================================================

function initAgeGate() {
  const gate = $('#age-gate');
  if (localStorage.getItem('myla2_age_ok') === '1') {
    gate.classList.add('hidden');
    startApp();
    return;
  }
  $('#age-yes').addEventListener('click', () => {
    localStorage.setItem('myla2_age_ok', '1');
    gate.classList.add('hidden');
    startApp();
  });
  $('#age-no').addEventListener('click', () => {
    window.location.href = 'https://www.google.com';
  });
}

// ===========================================================================
// App-Start: Konfiguration + aktueller Nutzer
// ===========================================================================

async function startApp() {
  $('#topbar').classList.remove('hidden');
  $('#app').classList.remove('hidden');

  try {
    const cfg = await api('/config');
    if (cfg.iceServers?.length) state.iceServers = cfg.iceServers;
  } catch {
    /* Standard-STUN behalten */
  }

  try {
    const { user } = await api('/me');
    state.user = user;
  } catch {
    state.user = null;
  }
  renderAuthState();
  pollStats();
  setInterval(pollStats, 15000);
}

async function pollStats() {
  try {
    const res = await fetch('/healthz');
    const data = await res.json();
    $('#online-count').textContent = `${data.online} online`;
  } catch {
    /* ignore */
  }
}

function renderAuthState() {
  const loggedIn = !!state.user;
  $('#auth-view').classList.toggle('hidden', loggedIn);
  $('#chat-view').classList.toggle('hidden', !loggedIn);
  $('#logout-btn').classList.toggle('hidden', !loggedIn);
  $('#current-user').textContent = loggedIn
    ? `${state.user.displayName}${state.user.isGuest ? ' (Gast)' : ''}`
    : '';
  $('#mod-link').classList.toggle('hidden', !state.user?.isModerator);
  if (!loggedIn) showView('auth');
}

function showView(name) {
  for (const v of ['auth', 'chat', 'mod']) {
    $(`#${v}-view`).classList.toggle('hidden', v !== name);
  }
}

// ===========================================================================
// Auth-Formulare
// ===========================================================================

function initAuth() {
  // Gast-Zugang: nur Nickname + 18+-Bestaetigung.
  $('#guest-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#guest-error').textContent = '';
    try {
      const { user } = await api('/auth/guest', {
        method: 'POST',
        body: JSON.stringify({
          nickname: f.nickname.value,
          ageConfirmed: f.ageConfirmed.checked,
        }),
      });
      state.user = user;
      renderAuthState();
    } catch (err) {
      $('#guest-error').textContent = err.message;
    }
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      $('#login-form').classList.toggle('hidden', !isLogin);
      $('#register-form').classList.toggle('hidden', isLogin);
      $('#auth-error').textContent = '';
    });
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { user } = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: f.email.value,
          password: f.password.value,
        }),
      });
      state.user = user;
      renderAuthState();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { user } = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username: f.username.value,
          email: f.email.value,
          password: f.password.value,
          birthdate: f.birthdate.value,
          ageConfirmed: f.ageConfirmed.checked,
        }),
      });
      state.user = user;
      renderAuthState();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    teardownCall();
    closeWs();
    state.user = null;
    renderAuthState();
  });
}

// ===========================================================================
// WebSocket / Matchmaking
// ===========================================================================

// Oeffnet die Signaling-Verbindung. Die Authentifizierung laeuft ueber das
// Session-Cookie, das der Browser beim WS-Handshake automatisch mitsendet.
function openSignaling() {
  closeWs();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener('message', (e) => handleWsMessage(JSON.parse(e.data)));
  ws.addEventListener('close', () => {
    setStatus('Getrennt. Klicke auf „Start", um neu zu verbinden.');
    resetControls();
  });
  ws.addEventListener('error', () => setStatus('Verbindungsfehler.'));
}

function closeWs() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      /* ignore */
    }
    state.ws = null;
  }
}

function sendWs(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

async function handleWsMessage(msg) {
  switch (msg.type) {
    case 'auth_ok':
      setStatus('Suche einen zufaelligen Partner…');
      sendWs({ type: 'queue' });
      break;
    case 'auth_error':
      setStatus('Anmeldung fuer Chat fehlgeschlagen.');
      break;
    case 'waiting':
      setStatus('Warte auf einen Partner…');
      break;
    case 'matched':
      state.isInitiator = msg.initiator;
      state.partnerName = msg.partner;
      state.partnerId = msg.partnerId;
      addSystemMessage(`Mit ${msg.partner} verbunden.`);
      setStatus(`Verbunden mit ${msg.partner}`);
      await startPeerConnection();
      break;
    case 'signal':
      await handleSignal(msg.data);
      break;
    case 'chat':
      addMessage(msg.text, 'them');
      break;
    case 'partner_left':
      addSystemMessage('Partner hat den Chat verlassen.');
      teardownPeer();
      setStatus('Partner weg. Klicke „Weiter" fuer einen neuen Chat.');
      break;
    case 'stopped':
      setStatus('Chat beendet.');
      break;
    default:
      break;
  }
}

// ===========================================================================
// WebRTC
// ===========================================================================

async function ensureLocalStream() {
  if (state.localStream) return state.localStream;
  state.localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
  $('#local-video').srcObject = state.localStream;
  return state.localStream;
}

async function startPeerConnection() {
  teardownPeer();
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.pc = pc;

  const stream = await ensureLocalStream();
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) sendWs({ type: 'signal', data: { candidate: e.candidate } });
  });
  pc.addEventListener('track', (e) => {
    $('#remote-video').srcObject = e.streams[0];
  });
  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'disconnected'].includes(pc.connectionState)) {
      setStatus('Verbindung verloren.');
    }
  });

  if (state.isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({ type: 'signal', data: { sdp: pc.localDescription } });
  }
}

async function handleSignal(data) {
  const pc = state.pc;
  if (!pc) return;
  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWs({ type: 'signal', data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch {
      /* ignore */
    }
  }
}

function teardownPeer() {
  if (state.pc) {
    state.pc.getSenders().forEach((s) => {
      try {
        s.track && s.track.stop;
      } catch {
        /* ignore */
      }
    });
    try {
      state.pc.close();
    } catch {
      /* ignore */
    }
    state.pc = null;
  }
  $('#remote-video').srcObject = null;
}

function teardownCall() {
  teardownPeer();
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
    $('#local-video').srcObject = null;
  }
  state.inCall = false;
}

// ===========================================================================
// Steuerung (Start / Weiter / Stop / Melden)
// ===========================================================================

function initControls() {
  $('#start-btn').addEventListener('click', async () => {
    try {
      await ensureLocalStream();
    } catch {
      setStatus('Kamera/Mikrofon-Zugriff noetig, um zu starten.');
      return;
    }
    state.inCall = true;
    setControlsActive(true);
    clearMessages();
    await openSignaling();
  });

  $('#next-btn').addEventListener('click', () => {
    teardownPeer();
    clearMessages();
    addSystemMessage('Suche neuen Partner…');
    sendWs({ type: 'next' });
  });

  $('#stop-btn').addEventListener('click', () => {
    sendWs({ type: 'stop' });
    teardownPeer();
    closeWs();
    resetControls();
    setStatus('Gestoppt. Klicke „Start", um wieder zu beginnen.');
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    sendWs({ type: 'chat', text });
    addMessage(text, 'me');
    input.value = '';
  });

  initReporting();
}

function setControlsActive(active) {
  $('#start-btn').classList.toggle('hidden', active);
  $('#next-btn').classList.toggle('hidden', !active);
  $('#stop-btn').classList.toggle('hidden', !active);
  $('#report-btn').classList.toggle('hidden', !active);
  $('#chat-input').disabled = !active;
  $('#chat-form button').disabled = !active;
}

function resetControls() {
  setControlsActive(false);
  state.inCall = false;
}

// ===========================================================================
// Chat-UI
// ===========================================================================

function addMessage(text, who) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  $('#messages').appendChild(div);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function addSystemMessage(text) {
  addMessage(text, 'system');
}

function clearMessages() {
  $('#messages').innerHTML = '';
}

function setStatus(text) {
  $('#status-banner').textContent = text;
}

// ===========================================================================
// Melden
// ===========================================================================

function initReporting() {
  const modal = $('#report-modal');
  $('#report-btn').addEventListener('click', () => modal.classList.remove('hidden'));
  $('#report-cancel').addEventListener('click', () => modal.classList.add('hidden'));
  $('#report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/report', {
        method: 'POST',
        body: JSON.stringify({
          reportedId: state.partnerId,
          reason: f.reason.value,
          details: f.details.value,
        }),
      });
      addSystemMessage('Meldung gesendet. Danke!');
    } catch (err) {
      addSystemMessage('Meldung fehlgeschlagen: ' + err.message);
    }
    modal.classList.add('hidden');
    f.reset();
  });
}

// ===========================================================================
// Moderation
// ===========================================================================

function initModeration() {
  $('#mod-link').addEventListener('click', async () => {
    showView('mod');
    await loadReports();
  });
}

async function loadReports() {
  const list = $('#reports-list');
  list.innerHTML = 'Lade…';
  try {
    const { reports } = await api('/mod/reports');
    if (!reports.length) {
      list.innerHTML = '<p class="muted">Keine offenen Meldungen.</p>';
      return;
    }
    list.innerHTML = '';
    for (const r of reports) {
      const item = document.createElement('div');
      item.className = 'report-item';
      item.innerHTML = `
        <div class="meta">#${r.id} · ${new Date(r.created_at).toLocaleString('de-DE')}
        · von ${escapeHtml(r.reporter_name || '—')} gegen ${escapeHtml(r.reported_name || '—')}</div>
        <div><strong>${r.reason}</strong></div>
        <div>${r.details ? escapeHtml(r.details) : ''}</div>
        <div class="row"></div>`;
      const row = item.querySelector('.row');

      if (r.reported_id) {
        const banBtn = document.createElement('button');
        banBtn.className = 'btn btn-danger';
        banBtn.textContent = `${r.reported_name || 'Nutzer'}${
          r.reported_guest ? ' (Gast)' : ''
        } sperren`;
        banBtn.addEventListener('click', async () => {
          await api('/mod/ban', {
            method: 'POST',
            body: JSON.stringify({ userId: r.reported_id }),
          });
          loadReports();
        });
        row.appendChild(banBtn);
      }

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'btn btn-ghost';
      dismissBtn.textContent = 'Verwerfen';
      dismissBtn.addEventListener('click', async () => {
        await api('/mod/dismiss', {
          method: 'POST',
          body: JSON.stringify({ reportId: r.id }),
        });
        loadReports();
      });
      row.appendChild(dismissBtn);
      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

// ===========================================================================
// Diverses
// ===========================================================================

function initTerms() {
  const modal = $('#terms-modal');
  $('#open-terms')?.addEventListener('click', (e) => {
    e.preventDefault();
    modal.classList.remove('hidden');
  });
  $('#terms-close').addEventListener('click', () => modal.classList.add('hidden'));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Bootstrap -------------------------------------------------------------

initAgeGate();
initAuth();
initControls();
initModeration();
initTerms();
