// Stage 2: rooms + signaling. Everything lives in memory (no database).
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { classify } = require('./links');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PEOPLE = 6;
const CODE_RE = /^[a-z]{3}-[a-z]{4}$/;

// code -> { host: socketId, peers: Map(socketId -> peer) }
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:code', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'room.html'))
);

// ICE servers for WebRTC: public STUN, plus an optional TURN server set through environment variables
app.get('/api/ice', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map(s => s.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.set('Cache-Control', 'no-store').json({ iceServers });
});

const cleanName = n => (typeof n === 'string' ? n.trim().slice(0, 24) : '') || 'Friend';
// What clients see of the link on stage. Playback time is worked out here, so viewers never depend on each other's clocks.
const viewLink = l => l && {
  kind: l.kind, url: l.url, videoId: l.videoId, hash: l.hash, embeddable: l.embeddable, by: l.by, name: l.name,
  sync: l.sync ? { playing: l.sync.playing, time: l.sync.time + (l.sync.playing ? (Date.now() - l.sync.at) / 1000 : 0) } : null,
};
const publicPeer = p => ({ id: p.id, name: p.name, mic: p.mic, cam: p.cam });

io.on('connection', socket => {
  let roomCode = null;
  const myPeer = () => (roomCode && rooms.get(roomCode)?.peers.get(socket.id)) || null;

  socket.on('join', ({ code, name, mic, cam } = {}) => {
    if (roomCode) return; // already in a room
    if (typeof code !== 'string' || !CODE_RE.test(code)) {
      return socket.emit('join-error', { message: 'That room code does not look right. It should be like abc-defg.' });
    }
    let room = rooms.get(code);
    if (!room) {
      room = { host: socket.id, peers: new Map(), share: null, link: null }; // first person in is the host
      rooms.set(code, room);
    }
    if (room.peers.size >= MAX_PEOPLE) {
      return socket.emit('join-error', { message: `This room is full (${MAX_PEOPLE} people max).` });
    }
    const peer = { id: socket.id, name: cleanName(name), mic: mic !== false, cam: cam !== false };
    room.peers.set(socket.id, peer);
    roomCode = code;
    socket.join(code);

    socket.emit('joined', {
      id: socket.id,
      host: room.host,
      share: room.share, // { by, streamId } while someone is sharing their screen
      link: viewLink(room.link),
      peers: [...room.peers.values()].map(publicPeer),
    });
    socket.to(code).emit('peer-joined', publicPeer(peer));
  });

  // Mic / camera on-off, so everyone sees who is muted
  socket.on('media-state', ({ mic, cam } = {}) => {
    const p = myPeer();
    if (!p) return;
    if (typeof mic === 'boolean') p.mic = mic;
    if (typeof cam === 'boolean') p.cam = cam;
    socket.to(roomCode).emit('peer-updated', publicPeer(p));
  });

  // WebRTC signaling relay (offers, answers, ICE). Used from Stage 3.
  socket.on('signal', ({ to, data } = {}) => {
    const room = rooms.get(roomCode);
    if (!room || !room.peers.has(to)) return; // only relay inside the same room
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // ---- Screen sharing: one share at a time ----
  const endShare = room => { room.share = null; io.to(roomCode).emit('share-changed', { by: null }); };

  socket.on('share-start', ({ streamId } = {}) => {
    const room = rooms.get(roomCode);
    if (!room || typeof streamId !== 'string' || streamId.length > 100) return;
    if (room.share && room.share.by !== socket.id) {
      const who = room.peers.get(room.share.by)?.name || 'Someone';
      return socket.emit('share-denied', { message: `${who} is already sharing. Ask them to stop first.` });
    }
    room.share = { by: socket.id, streamId };
    io.to(roomCode).emit('share-changed', room.share);
    if (room.link){ room.link = null; io.to(roomCode).emit('link-changed', null); } // a share takes over the stage
  });

  socket.on('share-stop', () => {
    const room = rooms.get(roomCode);
    if (room?.share?.by === socket.id) endShare(room);
  });

  // The host can stop anyone's share
  socket.on('host-stop-share', () => {
    const room = rooms.get(roomCode);
    if (room && room.host === socket.id && room.share) endShare(room);
  });

  // ---- Shared links: anyone can put one on the stage, anyone can clear it ----
  socket.on('link-set', async ({ url } = {}) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.share) return socket.emit('link-error', { message: 'Stop the screen share first, then put a link on the stage.' });
    const info = await classify(url);
    if (!info) return socket.emit('link-error', { message: 'That does not look like a web link. Try something like https://example.com' });
    const peer = room.peers.get(socket.id);
    if (rooms.get(roomCode) !== room || !peer) return;
    if (room.share) return socket.emit('link-error', { message: 'Someone started sharing a screen. Try again when they stop.' });
    room.link = { ...info, by: socket.id, name: peer.name, sync: info.kind === 'web' ? null : { playing: false, time: 0, at: Date.now() } };
    io.to(roomCode).emit('link-changed', viewLink(room.link));
  });

  socket.on('link-clear', () => {
    const room = rooms.get(roomCode);
    if (room?.link){ room.link = null; io.to(roomCode).emit('link-changed', null); }
  });

  // Play / pause / seek from YouTube and Vimeo players, relayed to everyone else
  socket.on('link-sync', ({ playing, time } = {}) => {
    const room = rooms.get(roomCode);
    if (!room?.link?.sync || typeof playing !== 'boolean' || !Number.isFinite(time)) return;
    room.link.sync = { playing, time, at: Date.now() };
    socket.to(roomCode).emit('link-sync', { playing, time });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.peers.delete(socket.id);
    if (room.share?.by === socket.id) room.share = null; // sharer left
    if (room.peers.size === 0) return rooms.delete(roomCode);
    if (room.host === socket.id) room.host = room.peers.keys().next().value; // promote next person
    io.to(roomCode).emit('peer-left', { id: socket.id, host: room.host, share: room.share });
  });
});

server.listen(PORT, () => console.log(`Bounce Lounge running at http://localhost:${PORT}`));
