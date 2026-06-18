// Velura Frontend: Altersgate, Auth, Matchmaking, WebRTC, Chat, Moderation.

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
  // Geraete-Einstellungen (an/aus) - werden in localStorage gemerkt.
  prefs: {
    camera: localStorage.getItem('velura_camera') !== '0',
    mic: localStorage.getItem('velura_mic') !== '0',
  },
  // Zustaende fuer "Perfect Negotiation" (robuste WebRTC-Aushandlung).
  makingOffer: false,
  ignoreOffer: false,
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
  if (localStorage.getItem('velura_age_ok') === '1') {
    gate.classList.add('hidden');
    startApp();
    return;
  }
  $('#age-yes').addEventListener('click', () => {
    localStorage.setItem('velura_age_ok', '1');
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
  $('#trust-bar').classList.remove('hidden');
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
  updateDeviceButtons();
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

// Fordert die lokalen Medien gemaess den Einstellungen an. Kamera UND Mikro
// sind optional - sind beide aus, gibt es keinen lokalen Stream (reiner
// Zuschauer-/Text-Modus). Fehlende Berechtigung deaktiviert das Geraet.
async function acquireLocalMedia() {
  releaseLocalMedia();
  const want = { video: state.prefs.camera, audio: state.prefs.mic };
  if (!want.video && !want.audio) {
    state.localStream = null;
    updateLocalPreview();
    return null;
  }
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia(want);
  } catch {
    // Zugriff verweigert oder kein Geraet: Einstellungen entsprechend zuruecksetzen.
    state.prefs.camera = false;
    state.prefs.mic = false;
    persistPrefs();
    state.localStream = null;
    setStatus('Kein Kamera-/Mikrofonzugriff - du nimmst ohne Video/Ton teil.');
  }
  updateLocalPreview();
  return state.localStream;
}

function releaseLocalMedia() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
}

function persistPrefs() {
  localStorage.setItem('velura_camera', state.prefs.camera ? '1' : '0');
  localStorage.setItem('velura_mic', state.prefs.mic ? '1' : '0');
  updateDeviceButtons();
}

async function startPeerConnection() {
  teardownPeer();
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.pc = pc;
  state.makingOffer = false;
  state.ignoreOffer = false;

  await acquireLocalMedia();

  // "Perfect Negotiation": erlaubt spaeteres An-/Abschalten von Geraeten,
  // ohne dass die Aushandlung der beiden Seiten kollidiert.
  pc.addEventListener('negotiationneeded', async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      sendWs({ type: 'signal', data: { sdp: pc.localDescription } });
    } catch {
      /* ignore */
    } finally {
      state.makingOffer = false;
    }
  });
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

  // Vorhandene lokale Spuren senden ...
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) =>
      pc.addTrack(t, state.localStream)
    );
  }
  // ... und fuer fehlende Richtungen Empfangs-Transceiver anlegen, damit das
  // Video/der Ton des Partners auch dann ankommt, wenn wir selbst nichts senden.
  if (!state.localStream || !state.localStream.getVideoTracks().length) {
    pc.addTransceiver('video', { direction: 'recvonly' });
  }
  if (!state.localStream || !state.localStream.getAudioTracks().length) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
}

async function handleSignal(data) {
  const pc = state.pc;
  if (!pc) return;
  const polite = !state.isInitiator; // Initiator ist "unhoeflich".
  try {
    if (data.sdp) {
      const offerCollision =
        data.sdp.type === 'offer' &&
        (state.makingOffer || pc.signalingState !== 'stable');
      state.ignoreOffer = !polite && offerCollision;
      if (state.ignoreOffer) return;

      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription();
        sendWs({ type: 'signal', data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        if (!state.ignoreOffer) throw err;
      }
    }
  } catch {
    /* Aushandlungsfehler ignorieren - naechster Versuch folgt */
  }
}

// Schaltet ein Geraet (Kamera/Mikro) im laufenden Gespraech an oder aus.
// Beim Ausschalten wird die Spur gestoppt (Kamera-LED geht aus); beim
// Einschalten neu angefordert. Die Aushandlung laeuft automatisch.
async function toggleDevice(kind) {
  const prefKey = kind === 'video' ? 'camera' : 'mic';
  const turnOn = !state.prefs[prefKey];
  state.prefs[prefKey] = turnOn;
  persistPrefs();

  const pc = state.pc;
  if (!pc || !state.inCall) {
    // Ausserhalb eines Gespraechs nur die Vorschau aktualisieren.
    if (turnOn) await acquireLocalMedia();
    else updateLocalPreview();
    return;
  }

  if (turnOn) {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ [kind]: true });
      const track = media.getTracks()[0];
      if (!state.localStream) state.localStream = new MediaStream();
      state.localStream.addTrack(track);
      // Vorhandenen recvonly-Transceiver wiederverwenden, sonst neue Spur.
      const tx = pc
        .getTransceivers()
        .find((t) => t.receiver.track?.kind === kind && !t.sender.track);
      if (tx) {
        await tx.sender.replaceTrack(track);
        tx.direction = 'sendrecv';
      } else {
        pc.addTrack(track, state.localStream);
      }
    } catch {
      state.prefs[prefKey] = false;
      persistPrefs();
      setStatus('Geraet konnte nicht aktiviert werden.');
    }
  } else {
    const tracks =
      kind === 'video'
        ? state.localStream?.getVideoTracks() || []
        : state.localStream?.getAudioTracks() || [];
    for (const track of tracks) {
      const sender = pc.getSenders().find((s) => s.track === track);
      if (sender) await sender.replaceTrack(null);
      track.stop();
      state.localStream?.removeTrack(track);
    }
  }
  updateLocalPreview();
}

function updateLocalPreview() {
  const el = $('#local-video');
  const hasVideo = !!state.localStream?.getVideoTracks().length;
  el.srcObject = hasVideo ? state.localStream : null;
  $('#local-off')?.classList.toggle('hidden', hasVideo);
  updateDeviceButtons();
}

function updateDeviceButtons() {
  const cam = $('#cam-btn');
  const mic = $('#mic-btn');
  if (cam) {
    cam.classList.toggle('off', !state.prefs.camera);
    cam.textContent = state.prefs.camera ? '📷 Kamera an' : '🚫 Kamera aus';
  }
  if (mic) {
    mic.classList.toggle('off', !state.prefs.mic);
    mic.textContent = state.prefs.mic ? '🎤 Mikro an' : '🔇 Mikro aus';
  }
}

function teardownPeer() {
  if (state.pc) {
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
  releaseLocalMedia();
  updateLocalPreview();
  state.inCall = false;
}

// ===========================================================================
// Steuerung (Start / Weiter / Stop / Melden)
// ===========================================================================

function initControls() {
  $('#start-btn').addEventListener('click', async () => {
    state.inCall = true;
    setControlsActive(true);
    clearMessages();
    await openSignaling();
  });

  // Geraete-Schalter (funktionieren vor und waehrend eines Gespraechs).
  $('#cam-btn').addEventListener('click', () => toggleDevice('video'));
  $('#mic-btn').addEventListener('click', () => toggleDevice('audio'));

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
  const open = (e) => {
    e.preventDefault();
    modal.classList.remove('hidden');
  };
  $('#open-terms')?.addEventListener('click', open);
  $('#open-terms-2')?.addEventListener('click', open);
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
