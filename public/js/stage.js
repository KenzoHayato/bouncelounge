// The main stage: a person (Stage 3), a shared screen (Stage 4), or a shared link (Stage 5).
const Stage = (() => {
  const g = id => document.getElementById(id);
  let cur = null; // the link on stage: { key, apply(sync), destroy(), until, playing, pending }
  const loaders = {};

  // ---- link helpers ----
  function loadYT(){
    if (window.YT && YT.Player) return Promise.resolve();
    return loaders.yt = loaders.yt || new Promise((res, rej) => {
      window.onYouTubeIframeAPIReady = res;
      const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = rej;
      document.head.appendChild(s); setTimeout(rej, 10000);
    }).catch(e => { loaders.yt = null; throw e; });
  }
  function loadVimeo(){
    if (window.Vimeo && Vimeo.Player) return Promise.resolve();
    return loaders.vimeo = loaders.vimeo || new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'https://player.vimeo.com/api/player.js'; s.onload = res; s.onerror = rej;
      document.head.appendChild(s); setTimeout(rej, 10000);
    }).catch(e => { loaders.vimeo = null; throw e; });
  }
  const safeUrl = u => /^https?:\/\//i.test(u) ? u : '#';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };

  function bar(link, opts, withOpen){
    const b = el('div', 'link-bar');
    if (withOpen){
      const a = el('a', 'btn', 'Open in new tab');
      a.href = safeUrl(link.url); a.target = '_blank'; a.rel = 'noopener noreferrer';
      b.appendChild(a);
    }
    const c = el('button', 'btn', 'Clear stage'); c.type = 'button'; c.onclick = opts.onClear;
    b.appendChild(c);
    return b;
  }
  function card(view, link, opts, reason){
    view.replaceChildren();
    const c = el('div', 'link-card');
    const art = el('div', 'stage-art'); art.innerHTML = icon('link');
    let host = link.url; try { host = new URL(link.url).hostname; } catch (e) {}
    const a = el('a', 'btn primary', 'Open in new tab');
    a.href = safeUrl(link.url); a.target = '_blank'; a.rel = 'noopener noreferrer';
    c.append(art, el('h2', '', host), el('p', '', reason), el('p', 'url', link.url), a);
    view.append(c, bar(link, opts, false));
  }

  // YouTube: iframe API, play/pause/seek are shared
  function buildYouTube(link, e, opts, view){
    const host = el('div', 'yt-host'); view.append(host, bar(link, opts, true));
    loadYT().then(() => {
      if (cur !== e) return;
      const emit = playing => { e.playing = playing; if (Date.now() > e.until) opts.onSync({ playing, time: p.getCurrentTime() }); };
      const p = new YT.Player(host, {
        videoId: link.videoId, width: '100%', height: '100%', playerVars: { rel: 0, playsinline: 1 },
        events: {
          onReady: () => { e.ready = true; if (e.pending) e.apply(e.pending); },
          onStateChange: ev => { if (ev.data === 1) emit(true); else if (ev.data === 2) emit(false); },
          onError: () => { if (cur === e) card(view, link, opts, 'This video cannot be played here. Open it on YouTube instead.'); },
        },
      });
      e.apply = s => {
        if (!e.ready){ e.pending = s; return; }
        e.until = Date.now() + 1500; e.playing = s.playing; // ignore the events our own change causes
        if (Math.abs(p.getCurrentTime() - s.time) > 1.5) p.seekTo(s.time, true);
        if (s.playing) p.playVideo(); else p.pauseVideo();
      };
      e.destroy = () => p.destroy();
    }).catch(() => { if (cur === e) card(view, link, opts, 'The video player could not load. Open it in a new tab instead.'); });
  }

  // Vimeo: player.js SDK
  function buildVimeo(link, e, opts, view){
    const host = el('div', 'yt-host'); view.append(host, bar(link, opts, true));
    loadVimeo().then(() => {
      if (cur !== e) return;
      const p = new Vimeo.Player(host, { url: `https://vimeo.com/${link.videoId}${link.hash ? '/' + link.hash : ''}` });
      const emit = (playing, time) => { e.playing = playing; if (Date.now() > e.until) opts.onSync({ playing, time }); };
      p.on('play', d => emit(true, d.seconds));
      p.on('pause', d => emit(false, d.seconds));
      p.on('seeked', d => emit(e.playing, d.seconds));
      e.apply = s => {
        e.until = Date.now() + 1500; e.playing = s.playing;
        p.getCurrentTime().then(t => { if (Math.abs(t - s.time) > 1.5) return p.setCurrentTime(s.time); }).catch(() => {});
        (s.playing ? p.play() : p.pause()).catch(() => {});
      };
      e.destroy = () => p.destroy();
      p.ready().then(() => { if (cur === e && e.pending) e.apply(e.pending); })
        .catch(() => { if (cur === e) card(view, link, opts, 'This video cannot be played here. Open it on Vimeo instead.'); });
    }).catch(() => { if (cur === e) card(view, link, opts, 'The video player could not load. Open it in a new tab instead.'); });
  }

  // Any other website: shown only if the server found that it allows embedding
  function buildFrame(link, view, opts){
    const f = document.createElement('iframe');
    f.src = safeUrl(link.url); f.title = 'Shared page'; f.referrerPolicy = 'no-referrer'; f.allow = 'fullscreen';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation');
    view.append(f, bar(link, opts, true));
  }

  function destroyLink(){ if (cur){ try { cur.destroy(); } catch (e) {} cur = null; g('linkView').replaceChildren(); } }
  function hideLink(){ destroyLink(); g('linkView').classList.add('hidden'); }

  function showLink(link, opts){
    const v = g('stageVideo');
    v.classList.add('hidden'); if (v.srcObject) v.srcObject = null;
    ['stageAvatar', 'stageMsg', 'stopShareBtn', 'stageName'].forEach(i => g(i).classList.add('hidden'));
    g('linkView').classList.remove('hidden');
    if (cur && cur.key === link.url) return; // already showing this link
    destroyLink();
    const view = g('linkView');
    const e = cur = { key: link.url, apply(){}, destroy(){}, until: 0, playing: false, ready: false, pending: link.sync };
    if (link.kind === 'youtube') buildYouTube(link, e, opts, view);
    else if (link.kind === 'vimeo') buildVimeo(link, e, opts, view);
    else if (link.embeddable && !(location.protocol === 'https:' && link.url.startsWith('http:'))) buildFrame(link, view, opts);
    else card(view, link, opts, 'This site does not allow other pages to show it, so open it in a new tab.');
  }
  const applySync = s => { if (cur) cur.apply(s); };

  // ---- people and screens ----
  function showPerson({ stream, name, color, camOn, mirror }){
    hideLink();
    const v = g('stageVideo'), av = g('stageAvatar');
    const showVideo = !!(camOn && stream && stream.getVideoTracks().length);
    g('stageMsg').classList.add('hidden');
    g('stopShareBtn').classList.add('hidden');
    g('stageName').classList.remove('hidden');
    v.muted = true; // sound comes from the person's tile, not from the stage
    v.classList.remove('screen');
    if (v.srcObject !== stream) v.srcObject = stream || null;
    v.classList.toggle('mirror', !!mirror);
    v.classList.toggle('hidden', !showVideo);
    av.classList.toggle('hidden', showVideo);
    av.textContent = name[0].toUpperCase();
    av.style.background = color;
    g('stageName').textContent = name;
    if (showVideo && v.paused) v.play().catch(() => {});
  }

  function showScreen({ stream, name, mine, canStop, stopLabel }){
    hideLink();
    const v = g('stageVideo');
    const showVideo = !mine && !!stream; // the sharer sees a calm card instead of their own screen (no hall of mirrors)
    g('stageAvatar').classList.add('hidden');
    g('stageName').classList.remove('hidden');
    if (showVideo){
      if (v.srcObject !== stream) v.srcObject = stream;
      v.muted = false; // screen audio is played from the stage
      v.classList.add('screen'); v.classList.remove('mirror');
      if (v.paused) v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    } else {
      v.srcObject = null;
    }
    v.classList.toggle('hidden', !showVideo);
    g('stageMsg').classList.toggle('hidden', showVideo);
    g('stageMsgTitle').textContent = mine ? 'You are sharing your screen' : `Getting ${name}'s screen...`;
    g('stageMsgText').textContent = mine ? 'Everyone can see it on the main stage.' : '';
    g('stageName').textContent = mine ? 'You are presenting' : `${name} is presenting`;
    const btn = g('stopShareBtn');
    btn.classList.toggle('hidden', !canStop);
    btn.textContent = stopLabel;
  }
  return { showPerson, showScreen, showLink, applySync };
})();
