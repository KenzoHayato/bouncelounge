// Stage 3: detects who is speaking by measuring each stream's volume in the browser.
const Speaking = (() => {
  const THRESHOLD = 0.035, HOLD = 700; // loudness cutoff, and ms to keep the glow after the last sound
  let ctx = null, cb = () => {};
  const meters = new Map();

  function watch(id, stream){
    unwatch(id);
    if (!stream.getAudioTracks().length) return;
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    const src = ctx.createMediaStreamSource(stream); src.connect(an);
    meters.set(id, { src, an, buf: new Uint8Array(an.fftSize), last: 0 });
  }
  function unwatch(id){ const m = meters.get(id); if (m){ m.src.disconnect(); meters.delete(id); } }

  setInterval(() => {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = performance.now(), speaking = new Set();
    let loudest = null, best = -1;
    meters.forEach((m, id) => {
      m.an.getByteTimeDomainData(m.buf);
      let sum = 0; for (const v of m.buf){ const x = (v - 128) / 128; sum += x * x; }
      const level = Math.sqrt(sum / m.buf.length);
      if (level > THRESHOLD) m.last = now;
      if (now - m.last < HOLD){ speaking.add(id); if (level >= best){ best = level; loudest = id; } }
    });
    cb(speaking, loudest);
  }, 150);

  return { watch, unwatch, onChange: f => { cb = f; } };
})();
