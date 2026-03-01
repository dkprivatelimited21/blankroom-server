const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);

// ── ENV ──
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const NODE_ENV = process.env.NODE_ENV || 'development';

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  FRONTEND_URL,
].filter((v, i, a) => v && a.indexOf(v) === i); // unique, truthy

// ── SECURITY HEADERS ──
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.socket.io'],
        connectSrc: ["'self'", ...allowedOrigins, 'wss:', 'ws:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ── CORS ──
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / non-browser
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── HTTP RATE LIMITING ──
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => req.path === '/health', // don't throttle health checks
});
app.use(globalLimiter);

// ── BODY PARSING ──
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ── STATIC FILES ──
app.use(express.static(path.join(__dirname, 'public')));

// ── HEALTH CHECK ──
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    connections: io.engine.clientsCount,
    queue: waitingQueue.length,
    activePairs: activePairs.size / 2,
    rooms: groupRooms.size,
  });
});

// ── SOCKET.IO ──
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
  pingInterval: 25000,
});

// ── IN-MEMORY STATE ──
const waitingQueue = [];
const activePairs = new Map();
const groupRooms = new Map();

// ── PER-SOCKET MESSAGE RATE LIMITER ──
const MSG_LIMIT = 20;
const MSG_WINDOW_MS = 10_000; // 10 seconds

function createMsgLimiter() {
  let count = 0;
  let windowStart = Date.now();
  return () => {
    const now = Date.now();
    if (now - windowStart > MSG_WINDOW_MS) {
      count = 0;
      windowStart = now;
    }
    return ++count <= MSG_LIMIT;
  };
}

// ── PROFANITY FILTER ──
const badWords = [
  'fuck', 'shit', 'ass', 'bitch', 'dick', 'cock',
  'cunt', 'faggot', 'nigger', 'whore',
];
function filterMessage(msg) {
  let out = String(msg).slice(0, 500);
  for (const word of badWords) {
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    out = out.replace(re, '*'.repeat(word.length));
  }
  return out;
}

function getActiveRooms() {
  return [...groupRooms.entries()]
    .filter(([name]) => name !== '__none__')
    .map(([name, members]) => ({ name, count: members.size }));
}

// ── SOCKET CONNECTIONS ──
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`[+] ${socket.id} (${ip})`);

  const canMsg = createMsgLimiter();

  // ─── 1v1 ───
  socket.on('find_stranger', () => {
    leaveCurrentPair(socket);

    if (waitingQueue.length > 0) {
      const partner = waitingQueue.shift();
      if (!partner.connected) {
        waitingQueue.push(socket);
        socket.emit('searching');
        return;
      }
      activePairs.set(socket.id, partner.id);
      activePairs.set(partner.id, socket.id);
      socket.emit('paired', { message: 'You are now chatting with a stranger.' });
      partner.emit('paired', { message: 'You are now chatting with a stranger.' });
    } else {
      waitingQueue.push(socket);
      socket.emit('searching');
    }
  });

  socket.on('send_message_1v1', (data) => {
    if (!canMsg()) { socket.emit('rate_limited', { message: 'Slow down!' }); return; }
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;
    const partner = io.sockets.sockets.get(partnerId);
    if (!partner) return;
    const msg = filterMessage(data.message);
    partner.emit('message_1v1', { from: 'stranger', text: msg });
    socket.emit('message_1v1', { from: 'you', text: msg });
  });

  socket.on('end_chat', () => {
    leaveCurrentPair(socket);
    socket.emit('chat_ended');
  });

  // ─── Group ───
  socket.on('get_rooms', () => socket.emit('rooms_list', getActiveRooms()));

  socket.on('join_room', (data) => {
    const roomName = String(data.room || '').trim().slice(0, 30);
    if (socket.currentRoom) exitRoom(socket);
    if (!roomName || roomName === '__none__') return;

    socket.join(roomName);
    socket.currentRoom = roomName;
    if (!groupRooms.has(roomName)) groupRooms.set(roomName, new Set());
    groupRooms.get(roomName).add(socket.id);

    const count = groupRooms.get(roomName).size;
    socket.emit('room_joined', { room: roomName, count });
    io.to(roomName).emit('room_message', {
      from: 'system',
      text: `${socket.nickname || 'Someone'} joined. (${count} in room)`,
    });
    io.emit('rooms_updated', getActiveRooms());
  });

  socket.on('send_message_group', (data) => {
    if (!socket.currentRoom) return;
    if (!canMsg()) { socket.emit('rate_limited', { message: 'Slow down!' }); return; }
    const msg = filterMessage(data.message);
    io.to(socket.currentRoom).emit('room_message', {
      from: socket.nickname || 'Stranger',
      text: msg,
      selfId: socket.id,
    });
  });

  socket.on('set_nickname', (data) => {
    socket.nickname = String(data.nickname || '').slice(0, 20) || 'Stranger';
  });

  socket.on('report_user', (data) => {
    console.log(`[REPORT] ${socket.id} → ${data.targetId || '?'}: ${data.reason || 'none'}`);
    socket.emit('report_received');
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    const qi = waitingQueue.indexOf(socket);
    if (qi !== -1) waitingQueue.splice(qi, 1);
    leaveCurrentPair(socket);
    if (socket.currentRoom) exitRoom(socket);
  });

  // ── Helpers ──
  function leaveCurrentPair(sock) {
    const partnerId = activePairs.get(sock.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) { partner.emit('stranger_left'); activePairs.delete(partnerId); }
      activePairs.delete(sock.id);
    }
    const qi = waitingQueue.indexOf(sock);
    if (qi !== -1) waitingQueue.splice(qi, 1);
  }

  function exitRoom(sock) {
    const name = sock.currentRoom;
    if (!name) return;
    sock.leave(name);
    sock.currentRoom = null;
    const rm = groupRooms.get(name);
    if (rm) {
      rm.delete(sock.id);
      if (rm.size === 0) groupRooms.delete(name);
      else io.to(name).emit('room_message', { from: 'system', text: `${sock.nickname || 'Someone'} left.` });
    }
    io.emit('rooms_updated', getActiveRooms());
  }
});

// ── START ──
server.listen(PORT, () => {
  console.log(`BlankRoom [${NODE_ENV}] on port ${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
});
