// Works out what kind of link was pasted, and whether a normal website allows being shown inside a page.
const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip){
  if (net.isIPv4(ip)){
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}

// Never let the server fetch addresses inside your own network
async function publicHost(u){
  const addrs = await dns.lookup(u.hostname, { all: true });
  return addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
}

// A site refuses embedding when it sends X-Frame-Options, or a CSP frame-ancestors that is not "*"
async function embeddable(u){
  try {
    for (let i = 0; i < 4; i++){
      if (!(await publicHost(u))) return false;
      const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(4000), headers: { 'user-agent': 'Mozilla/5.0 (Bounce Lounge link check)' } });
      res.body?.cancel?.();
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc){
        u = new URL(loc, u);
        if (!/^https?:$/.test(u.protocol)) return false;
        continue;
      }
      if (res.headers.get('x-frame-options')) return false;
      const m = (res.headers.get('content-security-policy') || '').match(/frame-ancestors\s+([^;]*)/i);
      if (m && !/(^|\s)\*(\s|$)/.test(m[1])) return false;
      return res.ok;
    }
  } catch (e) {}
  return false; // when unsure, show the safe link card
}

async function classify(raw){
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;

  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'music.youtube.com')
    id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1];
  if (id && /^[\w-]{11}$/.test(id)) return { kind: 'youtube', url: u.href, videoId: id };

  const vm = host === 'vimeo.com' && u.pathname.match(/^\/(\d+)(?:\/([a-f0-9]+))?/);
  if (vm) return { kind: 'vimeo', url: u.href, videoId: vm[1], hash: vm[2] || null };

  return { kind: 'web', url: u.href, embeddable: await embeddable(u) };
}

module.exports = { classify };
