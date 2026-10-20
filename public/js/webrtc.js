// WebRTC mesh with "perfect negotiation": either side may renegotiate at any time (needed for screen sharing).
const RTC = (() => {
  let CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
  const conns = new Map(); // peerId -> { pc, queue, ready, making, ignore, passive, screenSenders }
  let local = null, screen = null, send = () => {}, onTrack = () => {}, onState = () => {}, getId = () => '';

  const init = o => { send = o.send; onTrack = o.onTrack; onState = o.onState || onState; getId = o.getId; };
  const setLocal = s => { local = s; };
  const setIce = list => { if (Array.isArray(list) && list.length) CONFIG = { iceServers: list }; };
  const sendSdp = (id, pc) => send(id, { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });

  function boost(sender){ // cap screen bitrate so a 5-person mesh does not choke the sharer's upload
    try {
      if (sender.track?.kind !== 'video') return;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 2500000;
      sender.setParameters(p).catch(() => {});
    } catch (e) {}
  }
  function addScreenTo(e){
    screen.getTracks().forEach(t => { const s = e.pc.addTrack(t, screen); e.screenSenders.push(s); boost(s); });
  }

  function create(id, passive){
    const pc = new RTCPeerConnection(CONFIG);
    const e = { pc, queue: [], ready: false, making: false, ignore: false, passive, screenSenders: [] };
    conns.set(id, e);
    if (local) local.getTracks().forEach(t => pc.addTrack(t, local));
    if (screen) addScreenTo(e);
    pc.onnegotiationneeded = async () => {
      if (e.passive && !e.ready) return; // we are answering their offer; our tracks ride along in the answer
      try {
        e.making = true;
        await pc.setLocalDescription();
        sendSdp(id, pc);
        e.screenSenders.forEach(boost);
      } catch (err){ console.error(err); } finally { e.making = false; }
    };
    pc.onicecandidate = ev => { if (ev.candidate) send(id, { candidate: ev.candidate.toJSON() }); };
    pc.ontrack = ev => onTrack(id, ev.streams[0] || new MediaStream([ev.track]), ev.track);
    pc.onconnectionstatechange = () => onState(id, pc.connectionState);
    return e;
  }

  function connectTo(id){
    if (conns.has(id)) return;
    const { pc } = create(id, false);
    // Even without a camera or mic of our own, we still want to receive theirs
    for (const kind of ['audio', 'video']){
      if (!local || !local.getTracks().some(t => t.kind === kind)) pc.addTransceiver(kind, { direction: 'recvonly' });
    }
  }

  async function handleSignal(from, data){
    try {
      const e = conns.get(from) || create(from, true);
      const pc = e.pc;
      if (data.sdp){
        const collision = data.sdp.type === 'offer' && (e.making || pc.signalingState !== 'stable');
        const polite = getId() < from;
        e.ignore = !polite && collision;
        if (e.ignore) return;
        await pc.setRemoteDescription(data.sdp);
        e.ready = true;
        for (const c of e.queue.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (data.sdp.type === 'offer'){
          await pc.setLocalDescription();
          sendSdp(from, pc);
        }
      } else if (data.candidate){
        if (e.ready) await pc.addIceCandidate(data.candidate).catch(err => { if (!e.ignore) console.error(err); });
        else e.queue.push(data.candidate);
      }
    } catch (err){ console.error('signal error', err); }
  }

  function addScreen(stream){ screen = stream; conns.forEach(addScreenTo); }
  function removeScreen(){
    conns.forEach(e => { e.screenSenders.forEach(s => { try { e.pc.removeTrack(s); } catch (x) {} }); e.screenSenders = []; });
    screen = null;
  }
  const close = id => { const e = conns.get(id); if (e){ e.pc.close(); conns.delete(id); } };
  const closeAll = () => [...conns.keys()].forEach(close);

  return { init, setLocal, setIce, connectTo, handleSignal, addScreen, removeScreen, close, closeAll };
})();
