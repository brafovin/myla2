// Velura Frontend (Supabase + WebRTC).
// Auth, Matchmaking und Signaling laufen ueber Supabase; Video ist P2P (WebRTC).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const $ = (sel) => document.querySelector(sel);
const CFG = window.VELURA_CONFIG || {};

// Supabase-Client (Konfiguration aus config.js).
let supabase = null;
const configReady =
  CFG.supabaseUrl &&
  CFG.supabaseAnonKey &&
  !CFG.supabaseUrl.includes('DEIN-PROJEKT');
if (configReady) {
  supabase = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
}

const state = {
  user: null, // { id, displayName, isGuest, isModerator }
  iceServers: CFG.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
  lobby: null,
  room: null,
  roomId: null,
  onlineCh: null,
  pc: null,
  localStream: null,
  isInitiator: false,
  partnerName: null,
  partnerId: null,
  inCall: false,
  prefs: {
    camera: localStorage.getItem('velura_camera') !== '0',
    mic: localStorage.getItem('velura_mic') !== '0',
  },
  avatarEmoji: localStorage.getItem('velura_avatar') || '',
  avatarColor: localStorage.getItem('velura_avatar_color') || '',
  partnerAvatar: null,
  partnerCameraOn: true,
  makingOffer: false,
  ignoreOffer: false,
};

// ===========================================================================
// Avatare
// ===========================================================================

const AVATARS = ['😎', '🦊', '🐼', '🌹', '🔥', '🦋', '🐯', '👑', '🌙', '💎'];
const AVATAR_COLORS = [
  '#b03a5e', '#c1577a', '#9c3a6e', '#7d2b4d', '#a8456a',
  '#cf6f4a', '#b8553c', '#8e5a8c', '#5e3a6e', '#c2487f',
];

function colorFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initialsFor(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  const a = parts[0]?.[0] || '?';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

function myAvatar() {
  const name = state.user?.displayName || 'Gast';
  return {
    emoji: state.avatarEmoji || '',
    initials: initialsFor(name),
    color: state.avatarColor || colorFor(name),
  };
}

function renderAvatar(el, avatar) {
  if (!el) return;
  const a = avatar || {};
  el.style.background = a.color || 'var(--secondary)';
  el.textContent = a.emoji || a.initials || '?';
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
// App-Start
// ===========================================================================

async function startApp() {
  $('#topbar').classList.remove('hidden');
  $('#trust-bar').classList.remove('hidden');
  $('#app').classList.remove('hidden');

  if (!configReady) {
    showView('auth');
    $('#guest-error').textContent =
      'Supabase ist nicht konfiguriert. Bitte client/config.js ausfuellen.';
    return;
  }

  // Bestehende Sitzung laden.
  await postAuth();
  updateDeviceButtons();
}

// Laedt Profil nach Login/Sitzung und aktualisiert die Oberflaeche.
async function postAuth() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    state.user = null;
    renderAuthState();
    return;
  }
  const { data: prof } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (prof?.is_banned) {
    await supabase.auth.signOut();
    state.user = null;
    renderAuthState();
    $('#auth-error').textContent = 'Dieses Konto wurde gesperrt.';
    return;
  }
  state.user = {
    id: user.id,
    displayName: prof?.display_name || 'Gast',
    isGuest: !!prof?.is_guest,
    isModerator: !!prof?.is_moderator,
  };
  renderAuthState();
  subscribeOnline();
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
  if (loggedIn) refreshAvatarUI();
  if (!loggedIn) showView('auth');
  else showView('chat');
}

function showView(name) {
  for (const v of ['auth', 'chat', 'mod']) {
    $(`#${v}-view`).classList.toggle('hidden', v !== name);
  }
}

// Praesenz-Kanal fuer die Online-Anzeige.
function subscribeOnline() {
  if (state.onlineCh) return;
  const ch = supabase.channel('velura-online', {
    config: { presence: { key: state.user.id } },
  });
  ch.on('presence', { event: 'sync' }, () => {
    const n = Object.keys(ch.presenceState()).length;
    $('#online-count').textContent = `${n} online`;
  }).subscribe(async (status) => {
    if (status === 'SUBSCRIBED') await ch.track({ at: Date.now() });
  });
  state.onlineCh = ch;
}

// ===========================================================================
// Authentifizierung (Supabase)
// ===========================================================================

function ageFromBirthdate(birthdate) {
  const b = new Date(birthdate);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

function initAuth() {
  // Gast-Zugang: anonyme Anmeldung mit Nickname.
  $('#guest-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#guest-error').textContent = '';
    if (!supabase) return;
    const f = e.target;
    const nickname = f.nickname.value.trim();
    if (nickname.length < 2) {
      $('#guest-error').textContent = 'Nickname: mindestens 2 Zeichen.';
      return;
    }
    if (!f.ageConfirmed.checked) {
      $('#guest-error').textContent = 'Bitte 18+ bestaetigen.';
      return;
    }
    const { error } = await supabase.auth.signInAnonymously({
      options: {
        data: { display_name: nickname, is_guest: true, age_confirmed: true },
      },
    });
    if (error) {
      $('#guest-error').textContent =
        'Gast-Login fehlgeschlagen: ' + error.message;
      return;
    }
    await postAuth();
  });

  // Tabs (Login / Registrieren)
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
    $('#auth-error').textContent = '';
    const f = e.target;
    const { error } = await supabase.auth.signInWithPassword({
      email: f.email.value,
      password: f.password.value,
    });
    if (error) {
      $('#auth-error').textContent = 'Falsche Zugangsdaten.';
      return;
    }
    await postAuth();
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#auth-error').textContent = '';
    const f = e.target;
    const age = ageFromBirthdate(f.birthdate.value);
    if (age === null) {
      $('#auth-error').textContent = 'Ungueltiges Geburtsdatum.';
      return;
    }
    if (age < 18) {
      $('#auth-error').textContent =
        'Diese Plattform ist nur fuer Personen ab 18 Jahren.';
      return;
    }
    const { data, error } = await supabase.auth.signUp({
      email: f.email.value,
      password: f.password.value,
      options: {
        data: {
          display_name: f.username.value.trim(),
          is_guest: false,
          age_confirmed: true,
        },
      },
    });
    if (error) {
      $('#auth-error').textContent = 'Registrierung fehlgeschlagen: ' + error.message;
      return;
    }
    if (!data.session) {
      // E-Mail-Bestaetigung ist aktiv.
      $('#auth-error').textContent =
        'Bitte bestaetige deine E-Mail und melde dich anschliessend an.';
      return;
    }
    await postAuth();
  });

  $('#logout-btn').addEventListener('click', async () => {
    teardownCall();
    await leaveAll();
    await supabase.auth.signOut();
    state.user = null;
    renderAuthState();
  });
}

// ===========================================================================
// Matchmaking + Signaling (Supabase Realtime)
// ===========================================================================

// Lauscht auf Matches, bei denen WIR der wartende Teil (user_b) sind.
function subscribeLobby() {
  return new Promise((resolve) => {
    if (state.lobby) return resolve();
    const ch = supabase
      .channel('inbox-' + state.user.id)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'matches',
          filter: `user_b=eq.${state.user.id}`,
        },
        ({ new: row }) => onMatched(row.id, row.user_a, false)
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve();
      });
    state.lobby = ch;
  });
}

async function startMatching() {
  await subscribeLobby();
  setStatus('Suche einen zufaelligen Partner…');
  const { data, error } = await supabase.rpc('request_match');
  if (error) {
    setStatus('Matchmaking-Fehler: ' + error.message);
    return;
  }
  if (data) {
    // Sofort gepaart -> wir sind Initiator (user_a).
    await onMatched(data.id, data.user_b, true);
  } else {
    setStatus('Warte auf einen Partner…');
  }
}

async function onMatched(matchId, partnerId, initiator) {
  if (state.roomId === matchId) return; // Doppelte Benachrichtigung ignorieren.
  state.isInitiator = initiator;
  state.partnerId = partnerId;
  state.partnerAvatar = null;
  state.partnerCameraOn = true;
  updateRemoteAvatar();

  const { data: prof } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', partnerId)
    .single();
  state.partnerName = prof?.display_name || 'Partner';

  joinRoom(matchId);
  addSystemMessage(`Mit ${state.partnerName} verbunden.`);
  setStatus(`Verbunden mit ${state.partnerName}`);
  await startPeerConnection();
  sendMeta();
}

function joinRoom(matchId) {
  leaveRoom();
  const room = supabase.channel('room:' + matchId, {
    config: { broadcast: { self: false } },
  });
  room
    .on('broadcast', { event: 'signal' }, ({ payload }) => handleSignal(payload))
    .on('broadcast', { event: 'chat' }, ({ payload }) =>
      addMessage(String(payload.text || '').slice(0, 2000), 'them')
    )
    .on('broadcast', { event: 'meta' }, ({ payload }) => applyMeta(payload))
    .on('broadcast', { event: 'bye' }, () => onPartnerLeft())
    .subscribe();
  state.room = room;
  state.roomId = matchId;
}

function leaveRoom() {
  if (state.room) {
    supabase.removeChannel(state.room);
    state.room = null;
  }
  state.roomId = null;
}

// Verlaesst Warteschlange, Raum und Lobby (z.B. bei Logout).
async function leaveAll() {
  roomSend('bye', {});
  leaveRoom();
  if (state.lobby) {
    supabase.removeChannel(state.lobby);
    state.lobby = null;
  }
  if (supabase && state.user) {
    await supabase.rpc('leave_queue').catch(() => {});
  }
}

function roomSend(event, payload) {
  if (state.room) {
    state.room.send({ type: 'broadcast', event, payload });
  }
}

function applyMeta(data) {
  state.partnerAvatar = data?.avatar || null;
  state.partnerCameraOn = data?.cameraOn !== false;
  updateRemoteAvatar();
}

function onPartnerLeft() {
  addSystemMessage('Partner hat den Chat verlassen.');
  state.partnerCameraOn = true;
  updateRemoteAvatar();
  teardownPeer();
  leaveRoom();
  setStatus('Partner weg. Klicke „Weiter" fuer einen neuen Chat.');
}

// ===========================================================================
// WebRTC
// ===========================================================================

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

  pc.addEventListener('negotiationneeded', async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      roomSend('signal', { sdp: pc.localDescription });
    } catch {
      /* ignore */
    } finally {
      state.makingOffer = false;
    }
  });
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) roomSend('signal', { candidate: e.candidate });
  });
  pc.addEventListener('track', (e) => {
    $('#remote-video').srcObject = e.streams[0];
  });
  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'disconnected'].includes(pc.connectionState)) {
      setStatus('Verbindung verloren.');
    }
  });

  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  }
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
  const polite = !state.isInitiator;
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
        roomSend('signal', { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        if (!state.ignoreOffer) throw err;
      }
    }
  } catch {
    /* Aushandlungsfehler ignorieren */
  }
}

async function toggleDevice(kind) {
  const prefKey = kind === 'video' ? 'camera' : 'mic';
  const turnOn = !state.prefs[prefKey];
  state.prefs[prefKey] = turnOn;
  persistPrefs();

  const pc = state.pc;
  if (!pc || !state.inCall) {
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
  if (kind === 'video') sendMeta();
}

function updateLocalPreview() {
  const el = $('#local-video');
  const hasVideo = !!state.localStream?.getVideoTracks().length;
  el.srcObject = hasVideo ? state.localStream : null;
  $('#local-off')?.classList.toggle('hidden', hasVideo);
  if (!hasVideo) renderAvatar($('#local-avatar'), myAvatar());
  updateDeviceButtons();
}

function updateRemoteAvatar() {
  const overlay = $('#remote-avatar');
  if (!overlay) return;
  const show = state.inCall && !!state.partnerName && !state.partnerCameraOn;
  overlay.classList.toggle('hidden', !show);
  if (show) {
    const fallback = {
      initials: initialsFor(state.partnerName),
      color: colorFor(state.partnerName),
    };
    renderAvatar($('#remote-avatar-circle'), state.partnerAvatar || fallback);
    $('#remote-avatar-name').textContent = state.partnerName;
  }
}

function sendMeta() {
  if (state.room) {
    roomSend('meta', { avatar: myAvatar(), cameraOn: state.prefs.camera });
  }
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
// Avatar-Editor
// ===========================================================================

function applyAvatarChange() {
  localStorage.setItem('velura_avatar', state.avatarEmoji);
  localStorage.setItem('velura_avatar_color', state.avatarColor);
  renderAvatar($('#avatar-preview'), myAvatar());
  updateLocalPreview();
  sendMeta();
}

function refreshAvatarUI() {
  const colorInput = $('#avatar-color');
  if (colorInput && !state.avatarColor) {
    colorInput.value = colorFor(state.user?.displayName || 'Gast');
  }
  renderAvatar($('#avatar-preview'), myAvatar());
  updateLocalPreview();
}

function initAvatarPicker() {
  const presets = $('#avatar-presets');
  AVATARS.forEach((emo) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-preset';
    b.textContent = emo;
    b.addEventListener('click', () => {
      state.avatarEmoji = emo;
      $('#avatar-emoji-input').value = emo;
      applyAvatarChange();
    });
    presets.appendChild(b);
  });

  const emojiInput = $('#avatar-emoji-input');
  emojiInput.value = state.avatarEmoji;
  emojiInput.addEventListener('input', () => {
    state.avatarEmoji = [...emojiInput.value].slice(0, 2).join('');
    applyAvatarChange();
  });

  const colorInput = $('#avatar-color');
  colorInput.value = state.avatarColor || colorFor(state.user?.displayName || 'Gast');
  colorInput.addEventListener('input', () => {
    state.avatarColor = colorInput.value;
    applyAvatarChange();
  });

  $('#avatar-clear').addEventListener('click', () => {
    state.avatarEmoji = '';
    state.avatarColor = '';
    emojiInput.value = '';
    colorInput.value = colorFor(state.user?.displayName || 'Gast');
    applyAvatarChange();
  });

  renderAvatar($('#avatar-preview'), myAvatar());
}

// ===========================================================================
// Steuerung (Start / Weiter / Stop / Melden)
// ===========================================================================

function initControls() {
  $('#start-btn').addEventListener('click', async () => {
    state.inCall = true;
    setControlsActive(true);
    clearMessages();
    await startMatching();
  });

  $('#cam-btn').addEventListener('click', () => toggleDevice('video'));
  $('#mic-btn').addEventListener('click', () => toggleDevice('audio'));

  $('#next-btn').addEventListener('click', async () => {
    roomSend('bye', {});
    leaveRoom();
    teardownPeer();
    clearMessages();
    addSystemMessage('Suche neuen Partner…');
    await startMatching();
  });

  $('#stop-btn').addEventListener('click', async () => {
    await leaveAll();
    teardownPeer();
    resetControls();
    setStatus('Gestoppt. Klicke „Start", um wieder zu beginnen.');
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || !state.room) return;
    roomSend('chat', { text });
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
      const { error } = await supabase.from('reports').insert({
        reporter_id: state.user.id,
        reported_id: state.partnerId,
        reason: f.reason.value,
        details: f.details.value || null,
      });
      if (error) throw error;
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
    const { data: reports, error } = await supabase.rpc('mod_open_reports');
    if (error) throw error;
    if (!reports.length) {
      list.innerHTML = '<p class="muted">Keine offenen Meldungen.</p>';
      return;
    }
    list.innerHTML = '';
    for (const r of reports) {
      const item = document.createElement('div');
      item.className = 'report-item';
      item.innerHTML = `
        <div class="meta">${new Date(r.created_at).toLocaleString('de-DE')}
        · von ${escapeHtml(r.reporter_name || '—')} gegen ${escapeHtml(r.reported_name || '—')}</div>
        <div><strong>${escapeHtml(r.reason)}</strong></div>
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
          await supabase.rpc('mod_ban_user', { target: r.reported_id });
          loadReports();
        });
        row.appendChild(banBtn);
      }

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'btn btn-ghost';
      dismissBtn.textContent = 'Verwerfen';
      dismissBtn.addEventListener('click', async () => {
        await supabase.rpc('mod_dismiss_report', { report_id: r.id });
        loadReports();
      });
      row.appendChild(dismissBtn);
      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
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
initAvatarPicker();
initControls();
initModeration();
initTerms();
