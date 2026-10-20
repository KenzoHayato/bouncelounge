// Stage 3: video + audio. People via Socket.IO, media via WebRTC (webrtc.js).
const code = (location.pathname.match(/[a-z]{3}-[a-z]{4}/) || ['unknown'])[0];
const $ = id => document.getElementById(id);
const COLORS = ['var(--peach)', 'var(--sage)', 'var(--rose)'];
const SLOTS = ['left', 'right', 'top', 'bottom'];
const state = { mic: true, cam: true, name: localStorage.getItem('bl-name') || '' };
const has = { mic: false, cam: false }; // which devices we actually got

let socket = null, myId = null, hostId = null, inRoom = false;
let localStream = null, lastSpeakerId = null, micId = '', camId = '';
const peers = new Map();   // id -> { id, name, mic, cam }
const streams = new Map(); // id -> MediaStream
const tiles = new Map();   // id -> { el, video, nameEl }
let share = null, screenStream = null, screenCapture = null, shareConfirmed = false; // share = { by, streamId } | null
let link = null, linkBusy = false; // link on the stage, or null
const seen = new Map();    // streamId -> MediaStream (every remote stream received)

const colorFor = id => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 3];

// ---------- Camera + mic ----------
const errors = [];
const tryGet = c => navigator.mediaDevices.getUserMedia(c).catch(e => { errors.push(e); return null; });

async function acquire(){
  if (localStream){ localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  errors.length = 0;
  if (!navigator.mediaDevices){
    has.mic = has.cam = false; state.mic = state.cam = false;
    $('pjNote').textContent = 'Camera and mic need a secure connection. Open the site on localhost or over https.';
    return paintAll();
  }
  const a = micId ? { deviceId: { exact: micId } } : true;
  const v = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 }, ...(camId ? { deviceId: { exact: camId } } : {}) };
  localStream = (await tryGet({ audio: a, video: v })) || (await tryGet({ video: v })) || (await tryGet({ audio: a }));
  has.mic = !!localStream && localStream.getAudioTracks().length > 0;
  has.cam = !!localStream && localStream.getVideoTracks().length > 0;
  if (!has.mic) state.mic = false;
  if (!has.cam) state.cam = false;

  const blocked = errors.some(e => e.name === 'NotAllowedError' || e.name === 'SecurityError');
  $('pjNote').textContent =
    !localStream && blocked ? 'Camera and mic are blocked. Allow them in your browser\'s site settings and reload. You can still join to watch and listen.' :
    !localStream ? 'No camera or mic found. You can still join to watch and listen.' :
    !has.cam ? 'No camera found, so you will join with audio only.' :
    !has.mic ? 'No microphone found, so you will join without sound.' : '';
  paintAll();
}

async function fillDevices(){
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, label, cur) => {
    sel.replaceChildren();
    const list = devs.filter(d => d.kind === kind && d.deviceId);
    list.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `${label} ${i + 1}`; sel.appendChild(o); });
    if (cur) sel.value = cur;
    sel.disabled = !list.length;
  };
  fill($('micSel'), 'audioinput', 'Microphone', localStream?.getAudioTracks()[0]?.getSettings().deviceId);
  fill($('camSel'), 'videoinput', 'Camera', localStream?.getVideoTracks()[0]?.getSettings().deviceId);
}

function applyTracks(){
  localStream?.getAudioTracks().forEach(t => { t.enabled = state.mic; });
  localStream?.getVideoTracks().forEach(t => { t.enabled = state.cam; });
}

function paintToggle(btn, on, onIcon, offIcon, label, available){
  setIcon(btn, on ? onIcon : offIcon);
  btn.classList.toggle('off', !on);
  btn.disabled = !available;
  btn.setAttribute('aria-label', available ? `${on ? 'Turn off' : 'Turn on'} ${label}` : `No ${label} found`);
  btn.title = btn.getAttribute('aria-label') + (label === 'microphone' ? ' (M)' : label === 'camera' ? ' (V)' : '');
}
function paintAll(){
  applyTracks();
  for (const [m, c] of [['pjMic', 'pjCam'], ['micBtn', 'camBtn']]){
    paintToggle($(m), state.mic, 'mic', 'micOff', 'microphone', has.mic);
    paintToggle($(c), state.cam, 'video', 'videoOff', 'camera', has.cam);
  }
  const pv = $('previewVideo'), showPv = has.cam && state.cam;
  if (pv.srcObject !== localStream) pv.srcObject = localStream;
  pv.classList.toggle('hidden', !showPv);
  $('previewMsg').textContent = showPv ? '' : has.cam ? 'Your camera is off' : 'No camera';
}

function setMedia(){
  paintAll();
  if (!inRoom) return;
  const me = peers.get(myId);
  if (me){ me.mic = state.mic; me.cam = state.cam; }
  socket.emit('media-state', { mic: state.mic, cam: state.cam });
  renderPeople();
}

// ---------- Pre-join ----------
$('pjName').value = state.name;
fetch('/api/ice').then(r => r.json()).then(d => RTC.setIce(d.iceServers)).catch(() => {}); // STUN (and TURN, if configured)
$('joinBtn').disabled = true;
document.addEventListener('DOMContentLoaded', paintAll);
acquire().then(fillDevices).then(() => { $('joinBtn').disabled = false; });
navigator.mediaDevices?.addEventListener?.('devicechange', fillDevices);
$('micSel').onchange = () => { micId = $('micSel').value; acquire().then(fillDevices); };
$('camSel').onchange = () => { camId = $('camSel').value; acquire().then(fillDevices); };
$('pjMic').onclick = $('micBtn').onclick = () => { state.mic = !state.mic; setMedia(); };
$('pjCam').onclick = $('camBtn').onclick = () => { state.cam = !state.cam; setMedia(); };

$('joinBtn').onclick = () => {
  const n = $('pjName').value.trim();
  if (!n){ $('pjErr').textContent = 'Enter your name to join.'; $('pjName').focus(); return; }
  state.name = n; localStorage.setItem('bl-name', n);
  $('pjErr').textContent = ''; $('joinBtn').disabled = true;

  RTC.setLocal(localStream);
  RTC.init({
    send: (to, data) => socket.emit('signal', { to, data }),
    getId: () => myId,
    onTrack: (id, stream, track) => {
      seen.set(stream.id, stream);
      if (share && stream.id === share.streamId){ screenStream = stream; } // a shared screen, not a camera
      else {
        streams.set(id, stream); attach(id);
        if (track.kind === 'audio') Speaking.watch(id, stream);
      }
      renderStage();
    },
    onState: (id, s) => { if (s === 'failed') toast(`Could not connect to ${peers.get(id)?.name || 'a friend'}. Some networks need a TURN server.`); },
  });

  socket = io();
  socket.on('connect', () => socket.emit('join', { code, name: state.name, mic: state.mic, cam: state.cam }));
  socket.on('connect_error', () => { if (!inRoom){ $('pjErr').textContent = 'Could not reach the server. Is it running?'; $('joinBtn').disabled = false; } });
  socket.on('join-error', e => { $('pjErr').textContent = e.message; $('joinBtn').disabled = false; socket.disconnect(); });

  socket.on('joined', d => {
    myId = d.id; hostId = d.host;
    peers.clear(); d.peers.forEach(p => peers.set(p.id, p));
    RTC.closeAll(); // also covers reconnects: start fresh connections
    setShare(d.share); setLink(d.link || null);
    if (screenCapture && !(share && share.by === myId)){ endCapture(); toast('Screen sharing stopped because you reconnected.'); }
    if (localStream){ streams.set(myId, localStream); Speaking.watch(myId, localStream); }
    if (!inRoom){ inRoom = true; $('prejoin').classList.add('hidden'); $('room').classList.remove('hidden'); startRoom(); }
    renderPeople();
    d.peers.filter(p => p.id !== myId).forEach(p => RTC.connectTo(p.id));
  });
  socket.on('signal', ({ from, data }) => RTC.handleSignal(from, data));
  socket.on('peer-joined', p => { peers.set(p.id, p); renderPeople(); toast(`${p.name} joined`); });
  socket.on('peer-updated', p => { peers.set(p.id, p); renderPeople(); });
  socket.on('peer-left', ({ id, host, share: s }) => {
    const gone = peers.get(id); peers.delete(id); RTC.close(id); setShare(s || null);
    const hostChanged = hostId !== host; hostId = host;
    if (gone) toast(`${gone.name} left`);
    if (hostChanged && host === myId) toast('You are now the host.');
    renderPeople();
  });
  socket.on('share-changed', d => {
    const prev = share;
    setShare(d.by ? d : null);
    if (share && share.by === myId && screenCapture){ shareConfirmed = true; RTC.addScreen(screenCapture); }
    if (!share && screenCapture && shareConfirmed) endCapture(); // the host stopped our share
    if (share && share.by !== myId) toast(`${peers.get(share.by)?.name || 'Someone'} is sharing their screen`);
    if (!share && prev && prev.by !== myId) toast(`${peers.get(prev.by)?.name || 'Someone'} stopped sharing`);
  });
  socket.on('link-changed', d => {
    const prev = link;
    setLink(d);
    if (d && d.by !== myId) toast(`${d.name} put a link on the stage`);
    if (!d && prev) toast('The stage was cleared.');
  });
  socket.on('link-sync', s => Stage.applySync(s));
  socket.on('link-error', e => { linkBusy = false; toast(e.message); });
  socket.on('share-denied', e => { endCapture(); toast(e.message); });
  socket.on('disconnect', () => { if (inRoom) toast('Connection lost. Reconnecting...'); });
};

// ---------- Room ----------
function makeTile(p){
  const el = document.createElement('div');
  el.className = 'tile' + (p.id === myId ? ' self' : '');
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = p.id === myId; // never play our own sound back
  const av = document.createElement('div');
  av.className = 'avatar'; av.style.background = colorFor(p.id); av.textContent = p.name[0].toUpperCase();
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  el.append(video, av, nameEl);
  return { el, video, nameEl };
}

function attach(id){
  const t = tiles.get(id), s = streams.get(id);
  if (t && s && t.video.srcObject !== s){ t.video.srcObject = s; t.video.play().catch(() => {}); }
}

function renderPeople(){
  const list = [...peers.values()].sort((a, b) => (a.id === myId ? -1 : b.id === myId ? 1 : 0));
  tiles.forEach((t, id) => {
    if (!peers.has(id)){ t.el.remove(); tiles.delete(id); streams.delete(id); Speaking.unwatch(id); }
  });
  list.forEach((p, i) => {
    let t = tiles.get(p.id);
    if (!t){ t = makeTile(p); tiles.set(p.id, t); }
    t.el.classList.toggle('cam-off', !p.cam);
    t.nameEl.replaceChildren();
    if (!p.mic) t.nameEl.insertAdjacentHTML('beforeend', icon('micOff'));
    t.nameEl.append(p.id === myId ? `${p.name} (you)` : p.name);
    const slot = $('slot-' + SLOTS[i % 4]);
    if (t.el.parentElement !== slot){ slot.appendChild(t.el); t.video.play().catch(() => {}); } // moving a video can pause it
    attach(p.id);
  });

  $('peopleTitle').textContent = `People (${list.length})`;
  const ul = $('peopleList'); ul.replaceChildren();
  list.forEach(p => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'avatar';
    dot.style.cssText = `width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:${colorFor(p.id)}`;
    dot.textContent = p.name[0].toUpperCase();
    li.append(dot, p.id === myId ? `${p.name} (you)` : p.name);
    if (p.id === hostId){ const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'host'; li.appendChild(b); }
    ul.appendChild(li);
  });
  renderStage();
}

// The stage shows the most recent speaker (not you). Alone in the room, it shows you.
function stageId(){
  const others = [...peers.keys()].filter(i => i !== myId);
  if (!others.length) return myId;
  return others.includes(lastSpeakerId) ? lastSpeakerId : others[0];
}
function renderStage(){
  if (share && peers.has(share.by)){
    const mine = share.by === myId;
    Stage.showScreen({ stream: screenStream, name: peers.get(share.by).name, mine,
      canStop: mine || hostId === myId, stopLabel: mine ? 'Stop sharing' : 'Stop their share' });
    return;
  }
  if (link){
    Stage.showLink(link, { onSync: s => socket.emit('link-sync', s), onClear: () => socket.emit('link-clear') });
    return;
  }
  const id = stageId(), p = peers.get(id);
  if (!p) return;
  Stage.showPerson({ stream: streams.get(id), name: p.name, color: colorFor(id), camOn: p.cam, mirror: id === myId });
}

Speaking.onChange((speaking, loudest) => {
  tiles.forEach((t, id) => t.el.classList.toggle('speaking', speaking.has(id)));
  if (loudest && loudest !== myId && loudest !== lastSpeakerId){ lastSpeakerId = loudest; renderStage(); }
});

// ---------- Shared links ----------
function setLink(l){ link = l; linkBusy = false; renderStage(); }
function initLinkPopover(){
  const pop = $('linkPop'), input = $('linkInput');
  const toggle = open => { pop.classList.toggle('hidden', !open); $('linkBtn').classList.toggle('active', open); if (open) input.focus(); };
  $('linkBtn').onclick = () => toggle(pop.classList.contains('hidden'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });
  pop.onsubmit = e => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url || linkBusy) return;
    linkBusy = true; input.value = ''; toggle(false);
    toast('Checking the link...');
    socket.emit('link-set', { url });
  };
}

// ---------- Screen sharing ----------
function setShare(s){
  if (share && (!s || s.streamId !== share.streamId)) seen.delete(share.streamId);
  share = s ? { by: s.by, streamId: s.streamId } : null;
  screenStream = share ? seen.get(share.streamId) || null : null;
  paintShare(); renderStage();
}
function paintShare(){
  const b = $('shareBtn'), mine = !!screenCapture;
  b.classList.toggle('active', mine);
  b.setAttribute('aria-label', mine ? 'Stop sharing your screen' : 'Share screen');
}
async function startShare(){
  if (screenCapture) return stopShare();
  if (share) return toast(`${peers.get(share.by)?.name || 'Someone'} is already sharing. Ask them to stop first.`);
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('This browser cannot share a screen. Try a laptop or desktop.');
  let s;
  try { s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: true }); }
  catch (e){ if (e.name !== 'NotAllowedError') toast('Could not start screen sharing.'); return; } // cancelled picker stays quiet
  screenCapture = s; shareConfirmed = false;
  s.getVideoTracks()[0].addEventListener('ended', stopShare); // the browser's own "Stop sharing" bar
  socket.emit('share-start', { streamId: s.id });
  paintShare();
}
function stopShare(){
  if (!screenCapture) return;
  socket.emit('share-stop');
  endCapture();
}
function endCapture(){
  if (!screenCapture) return;
  RTC.removeScreen();
  screenCapture.getTracks().forEach(t => t.stop());
  screenCapture = null; shareConfirmed = false;
  paintShare();
}

function startRoom(){
  $('roomCode').textContent = code;
  document.title = `${code} | Bounce Lounge`;
  if (!navigator.mediaDevices?.getDisplayMedia) $('shareBtn').classList.add('hidden'); // phones cannot share their screen
  document.querySelectorAll('.controls .icon-btn').forEach(b => { if (!b.title) b.title = b.getAttribute('aria-label'); });
  document.addEventListener('keydown', e => { // M = mic, V = camera
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'm' && has.mic){ state.mic = !state.mic; setMedia(); }
    else if (k === 'v' && has.cam){ state.cam = !state.cam; setMedia(); }
  });
  paintIcons(); applyTheme(document.documentElement.dataset.theme); paintAll();
  $('shareBtn').onclick = startShare;
  $('stopShareBtn').onclick = () => (share && share.by === myId ? stopShare() : socket.emit('host-stop-share'));
  initLinkPopover();
  $('peopleBtn').onclick = () => $('panel').classList.toggle('open');
  $('closePanel').onclick = () => $('panel').classList.remove('open');
  $('copyBtn').onclick = () => navigator.clipboard.writeText(location.href).then(() => toast('Invite link copied.'), () => toast('Copy failed. Copy the address bar instead.'));
  $('leaveBtn').onclick = () => {
    endCapture(); RTC.closeAll();
    localStream?.getTracks().forEach(t => t.stop());
    socket.disconnect();
    location.href = '/';
  };
}
