/* BlankRoom — server.js */
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.options('*', cors({ origin: true, credentials: true }));

// ── PERMISSIVE HEADERS FOR WebRTC ─────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
    "media-src * blob: data:; connect-src * wss: ws: blob: data:; worker-src * blob:;"
  );
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: true, methods: ['GET','POST'], credentials: true },
  transports: ['websocket', 'polling'],
  pingTimeout: 25000,
  pingInterval: 10000,
  allowEIO3: true,
  maxHttpBufferSize: 5e6,
});

// ── STATE ─────────────────────────────────────────────────────────────────────
const textQueue  = [];
const videoQueue = [];
const textPairs  = new Map();
const videoPairs = new Map();
const groupRooms = new Map();

const PERMANENT_ROOMS = ['general','random','music','gaming','tech','sports','movies','art','science','philosophy'];
PERMANENT_ROOMS.forEach(r => groupRooms.set(r, new Set()));

// ── UTILS ─────────────────────────────────────────────────────────────────────
const BAD = ['fuck','shit','bitch','dick','cock','cunt','nigger','whore','pussy','bastard','slut'];
function filterMsg(msg) {
  let o = String(msg || '').slice(0, 500);
  for (const w of BAD) o = o.replace(new RegExp(`\\b${w}\\b`, 'gi'), '*'.repeat(w.length));
  return o;
}
function getActiveRooms() {
  PERMANENT_ROOMS.forEach(r => { if (!groupRooms.has(r)) groupRooms.set(r, new Set()); });
  return [...groupRooms.entries()]
    .filter(([n]) => n !== '__none__')
    .map(([n, m]) => ({ name: n, count: m.size, permanent: PERMANENT_ROOMS.includes(n) }));
}
function dequeue(queue, myId) {
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].id !== myId && queue[i].connected) { return queue.splice(i, 1)[0]; }
  }
  return null;
}
function removeQ(queue, id) {
  const i = queue.findIndex(s => s.id === id);
  if (i !== -1) queue.splice(i, 1);
}
function makeLimiter(max = 20, ms = 10000) {
  let c = 0, t = Date.now();
  return () => { if (Date.now() - t > ms) { c = 0; t = Date.now(); } return ++c <= max; };
}

// ── CONNECTIONS ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);
  socket.emit('rooms_list', getActiveRooms());
  const canMsg = makeLimiter();

  function leaveText() {
    const pid = textPairs.get(socket.id);
    if (pid) { const p = io.sockets.sockets.get(pid); if (p) p.emit('stranger_left'); textPairs.delete(pid); }
    textPairs.delete(socket.id);
    removeQ(textQueue, socket.id);
  }
  function leaveVideo() {
    const pid = videoPairs.get(socket.id);
    if (pid) { const p = io.sockets.sockets.get(pid); if (p) p.emit('video_stranger_left'); videoPairs.delete(pid); }
    videoPairs.delete(socket.id);
    removeQ(videoQueue, socket.id);
  }
  function exitRoom(announce = true) {
    const name = socket.currentRoom;
    if (!name) return;
    socket.leave(name);
    socket.currentRoom = null;
    const rm = groupRooms.get(name);
    if (!rm) return;
    rm.delete(socket.id);
    if (!PERMANENT_ROOMS.includes(name) && rm.size === 0) groupRooms.delete(name);
    else if (announce && rm.size > 0) {
      io.to(name).emit('room_message', { from: 'system', text: `🍃 ${socket.nickname || 'Someone'} left.`, timestamp: Date.now() });
    }
    io.emit('rooms_updated', getActiveRooms());
  }

  // NICKNAME
  socket.on('set_nickname', ({ nickname }) => { socket.nickname = String(nickname || 'Stranger').slice(0, 20); });

  // TEXT 1v1
  socket.on('find_stranger', () => {
    leaveText();
    const p = dequeue(textQueue, socket.id);
    if (p) {
      textPairs.set(socket.id, p.id); textPairs.set(p.id, socket.id);
      socket.emit('paired', { timestamp: Date.now() });
      p.emit('paired', { timestamp: Date.now() });
    } else {
      textQueue.push(socket);
      socket.emit('searching', { timestamp: Date.now() });
    }
  });
  socket.on('send_message_1v1', ({ message }) => {
    if (!canMsg()) { socket.emit('rate_limited', { message: 'Slow down!' }); return; }
    const pid = textPairs.get(socket.id); if (!pid) return;
    const p = io.sockets.sockets.get(pid); if (!p) return;
    const msg = filterMsg(message); const ts = Date.now();
    socket.emit('message_1v1', { from: 'you', text: msg, timestamp: ts });
    p.emit('message_1v1', { from: 'stranger', text: msg, timestamp: ts });
  });
  socket.on('typing', ({ isTyping }) => {
    const pid = textPairs.get(socket.id);
    if (pid) { const p = io.sockets.sockets.get(pid); if (p) p.emit('partner_typing', { isTyping }); }
  });
  socket.on('end_chat', () => { leaveText(); socket.emit('chat_ended'); });

  // VIDEO 1v1
  socket.on('find_video_stranger', () => {
    leaveVideo();
    const p = dequeue(videoQueue, socket.id);
    if (p) {
      videoPairs.set(socket.id, p.id); videoPairs.set(p.id, socket.id);
      socket.emit('video_paired', { initiator: true, timestamp: Date.now() });
      p.emit('video_paired', { initiator: false, timestamp: Date.now() });
    } else {
      videoQueue.push(socket);
      socket.emit('video_searching', { message: 'Searching...', timestamp: Date.now() });
    }
  });
  // Relay signaling
  ['video_offer','video_answer','video_ice_candidate'].forEach(ev => {
    socket.on(ev, (data) => {
      const pid = videoPairs.get(socket.id);
      if (pid) { const p = io.sockets.sockets.get(pid); if (p) p.emit(ev, data); }
    });
  });
  socket.on('video_skip', () => {
    leaveVideo();
    const p = dequeue(videoQueue, socket.id);
    if (p) {
      videoPairs.set(socket.id, p.id); videoPairs.set(p.id, socket.id);
      socket.emit('video_paired', { initiator: true, timestamp: Date.now() });
      p.emit('video_paired', { initiator: false, timestamp: Date.now() });
    } else {
      videoQueue.push(socket);
      socket.emit('video_searching', { message: 'Searching for next...', timestamp: Date.now() });
    }
  });
  socket.on('video_end', () => { leaveVideo(); socket.emit('video_ended'); });
  ['video_toggle_audio','video_toggle_video'].forEach(ev => {
    socket.on(ev, (data) => {
      const pid = videoPairs.get(socket.id);
      if (pid) { const p = io.sockets.sockets.get(pid); if (p) p.emit(ev === 'video_toggle_audio' ? 'video_partner_toggle_audio' : 'video_partner_toggle_video', data); }
    });
  });

  // GROUP CHAT
  socket.on('get_rooms', () => socket.emit('rooms_list', getActiveRooms()));
  socket.on('join_room', ({ room }) => {
    let name = String(room || '').trim().slice(0, 30);
    if (!name || name === '__none__') return;
    if (socket.currentRoom) exitRoom(true);
    if (!groupRooms.has(name)) groupRooms.set(name, new Set());
    socket.join(name); socket.currentRoom = name; groupRooms.get(name).add(socket.id);
    const count = groupRooms.get(name).size;
    socket.emit('room_joined', { room: name, count, permanent: PERMANENT_ROOMS.includes(name) });
    socket.emit('room_message', { from: 'system', text: `✨ Welcome to #${name}! ${count} user${count !== 1 ? 's' : ''} here.`, timestamp: Date.now() });
    socket.to(name).emit('room_message', { from: 'system', text: `🌸 ${socket.nickname || 'Someone'} joined. (${count} in room)`, timestamp: Date.now() });
    io.emit('rooms_updated', getActiveRooms());
  });
  socket.on('send_message_group', ({ message }) => {
    if (!socket.currentRoom) return;
    if (!canMsg()) { socket.emit('rate_limited', { message: 'Slow down!' }); return; }
    const msg = filterMsg(message);
    io.to(socket.currentRoom).emit('room_message', { from: socket.nickname || 'Stranger', text: msg, selfId: socket.id, timestamp: Date.now() });
  });
  socket.on('leave_room', () => exitRoom(true));
  socket.on('group_typing', ({ isTyping }) => {
    if (socket.currentRoom) socket.to(socket.currentRoom).emit('room_typing', { nickname: socket.nickname || 'Someone', isTyping });
  });

  // REPORT
  socket.on('report_user', ({ reason }) => {
    console.log(`[REPORT] ${socket.id}: ${reason}`);
    socket.emit('report_received', { message: 'Report submitted. Thank you.' });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    leaveText(); leaveVideo();
    if (socket.currentRoom) exitRoom(false);
    io.emit('rooms_updated', getActiveRooms());
  });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', clients: io.engine.clientsCount }));

server.listen(PORT, () => console.log(`✨ BlankRoom on :${PORT}`));
