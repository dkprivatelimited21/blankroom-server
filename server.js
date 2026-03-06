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

// More permissive allowed origins for Instagram/Twitter/etc
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://blankroom.vercel.app',
  'https://blankroom-server.onrender.com',
  FRONTEND_URL,
].filter((v, i, a) => v && a.indexOf(v) === i);

// ── SECURITY HEADERS (relaxed for embeds) ──
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", '*'],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", '*'],
        connectSrc: ["'self'", '*', 'wss:', 'ws:'],
        styleSrc: ["'self'", "'unsafe-inline'", '*'],
        fontSrc: ["'self'", '*'],
        imgSrc: ["'self'", 'data:', '*'],
        frameSrc: ["'self'", '*'],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// ── CORS (very permissive for Instagram embeds) ──
const corsOptions = {
  origin: true, // Allow all origins
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
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
  skip: (req) => req.path === '/health',
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
    origin: true, // Allow all origins
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
  pingInterval: 25000,
  allowEIO3: true, // Better compatibility
});

// ── IN-MEMORY STATE ──
const waitingQueue = [];
const activePairs = new Map();
const groupRooms = new Map();

// ── PERMANENT PRE-GROUPS ──
const PERMANENT_ROOMS = [
  'general',
  'random',
  'music',
  'gaming',
  'tech',
  'sports'
];

// Initialize permanent rooms
PERMANENT_ROOMS.forEach(room => {
  if (!groupRooms.has(room)) {
    groupRooms.set(room, new Set());
  }
});

// ── PER-SOCKET MESSAGE RATE LIMITER ──
const MSG_LIMIT = 20;
const MSG_WINDOW_MS = 10_000;

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
    .map(([name, members]) => ({ 
      name, 
      count: members.size,
      permanent: PERMANENT_ROOMS.includes(name)
    }));
}

// ── OMEGELE PAIRING ALGORITHM ──
function findBestMatch(socket) {
  if (waitingQueue.length === 0) return null;
  
  // No IP logging - we don't store IPs
  // Just match based on connection time (oldest first) with some randomization
  
  // 80% chance to match with oldest in queue (FIFO)
  // 20% chance to match randomly to prevent predictability
  let partnerIndex = 0;
  
  if (waitingQueue.length > 1 && Math.random() < 0.2) {
    // Random matching
    partnerIndex = Math.floor(Math.random() * waitingQueue.length);
  }
  
  const partner = waitingQueue[partnerIndex];
  
  // Remove from queue
  waitingQueue.splice(partnerIndex, 1);
  
  return partner;
}

// ── SOCKET CONNECTIONS ──
io.on('connection', (socket) => {
  // IMPORTANT: No IP logging! We don't store or log IP addresses
  console.log(`[+] ${socket.id} connected`);
  
  // Generate a simple session ID without any tracking info
  socket.sessionId = Math.random().toString(36).substring(2, 10);
  
  const canMsg = createMsgLimiter();

  // ─── 1v1 with Omegele algorithm ───
  socket.on('find_stranger', () => {
    leaveCurrentPair(socket);

    const partner = findBestMatch(socket);
    
    if (partner && partner.connected) {
      // Pair them
      activePairs.set(socket.id, partner.id);
      activePairs.set(partner.id, socket.id);
      
      socket.emit('paired', { 
        message: 'You are now chatting with a stranger.',
        timestamp: Date.now()
      });
      
      partner.emit('paired', { 
        message: 'You are now chatting with a stranger.',
        timestamp: Date.now()
      });
    } else {
      waitingQueue.push(socket);
      socket.emit('searching', { 
        message: 'Looking for someone to chat with...',
        position: waitingQueue.length
      });
    }
  });

  socket.on('send_message_1v1', (data) => {
    if (!canMsg()) { 
      socket.emit('rate_limited', { message: 'Slow down!' }); 
      return; 
    }
    
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;
    
    const partner = io.sockets.sockets.get(partnerId);
    if (!partner) return;
    
    const msg = filterMessage(data.message);
    partner.emit('message_1v1', { 
      from: 'stranger', 
      text: msg,
      timestamp: Date.now()
    });
    
    socket.emit('message_1v1', { 
      from: 'you', 
      text: msg,
      timestamp: Date.now()
    });
  });

  socket.on('skip_stranger', () => {
    // Skip current and find new one immediately
    leaveCurrentPair(socket);
    socket.emit('find_stranger');
  });

  socket.on('end_chat', () => {
    leaveCurrentPair(socket);
    socket.emit('chat_ended');
  });

  // ─── Group with permanent rooms ───
  socket.on('get_rooms', () => {
    socket.emit('rooms_list', getActiveRooms());
  });

  socket.on('join_room', (data) => {
    let roomName = String(data.room || '').trim().slice(0, 30);
    
    // If no room name provided or invalid, put in general
    if (!roomName || roomName === '__none__') {
      roomName = 'general';
    }
    
    // Leave current room if any
    if (socket.currentRoom) {
      exitRoom(socket);
    }
    
    // Join new room
    socket.join(roomName);
    socket.currentRoom = roomName;
    
    if (!groupRooms.has(roomName)) {
      groupRooms.set(roomName, new Set());
    }
    groupRooms.get(roomName).add(socket.id);

    const count = groupRooms.get(roomName).size;
    
    socket.emit('room_joined', { 
      room: roomName, 
      count,
      permanent: PERMANENT_ROOMS.includes(roomName)
    });
    
    // Welcome message
    socket.emit('room_message', {
      from: 'system',
      text: `Welcome to #${roomName}! There ${count === 1 ? 'is' : 'are'} ${count} user${count === 1 ? '' : 's'} here.`,
      timestamp: Date.now()
    });
    
    // Notify others
    socket.to(roomName).emit('room_message', {
      from: 'system',
      text: `${socket.nickname || 'Someone'} joined. (${count} in room)`,
      timestamp: Date.now()
    });
    
    io.emit('rooms_updated', getActiveRooms());
  });

  socket.on('send_message_group', (data) => {
    if (!socket.currentRoom) return;
    if (!canMsg()) { 
      socket.emit('rate_limited', { message: 'Slow down!' }); 
      return; 
    }
    
    const msg = filterMessage(data.message);
    
    io.to(socket.currentRoom).emit('room_message', {
      from: socket.nickname || 'Stranger',
      text: msg,
      selfId: socket.id,
      timestamp: Date.now()
    });
  });

  socket.on('set_nickname', (data) => {
    socket.nickname = String(data.nickname || '').slice(0, 20) || 'Stranger';
  });

  socket.on('report_user', (data) => {
    // Log without any identifying info
    console.log(`[REPORT] Reason: ${data.reason || 'none'}`);
    socket.emit('report_received', { message: 'Report submitted. Thank you.' });
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    
    // Remove from queue
    const qi = waitingQueue.indexOf(socket);
    if (qi !== -1) waitingQueue.splice(qi, 1);
    
    // Leave pair if any
    leaveCurrentPair(socket);
    
    // Leave room if any
    if (socket.currentRoom) exitRoom(socket);
  });

  // ── Helpers ──
  function leaveCurrentPair(sock) {
    const partnerId = activePairs.get(sock.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner && partner.connected) { 
        partner.emit('stranger_left'); 
        activePairs.delete(partnerId);
      }
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
      
      // Don't delete permanent rooms even if empty
      if (!PERMANENT_ROOMS.includes(name) && rm.size === 0) {
        groupRooms.delete(name);
      } else {
        io.to(name).emit('room_message', { 
          from: 'system', 
          text: `${sock.nickname || 'Someone'} left.`,
          timestamp: Date.now()
        });
      }
    }
    
    io.emit('rooms_updated', getActiveRooms());
  }
});

// ── START ──
server.listen(PORT, () => {
  console.log(`BlankRoom [${NODE_ENV}] on port ${PORT}`);
  console.log(`Permanent rooms: ${PERMANENT_ROOMS.join(', ')}`);
  console.log('CORS: All origins allowed for Instagram/Twitter compatibility');
  console.log('⚠ NO IP LOGGING - Privacy first!');
});