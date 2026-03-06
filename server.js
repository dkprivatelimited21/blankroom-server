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

// ── SECURITY HEADERS (relaxed for embeds and WebRTC) ──
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", '*'],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", '*'],
        connectSrc: ["'self'", '*', 'wss:', 'ws:', 'blob:', 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'", '*'],
        fontSrc: ["'self'", '*'],
        imgSrc: ["'self'", 'data:', '*', 'blob:'],
        frameSrc: ["'self'", '*'],
        mediaSrc: ["'self'", '*', 'blob:', 'data:'],
        workerSrc: ["'self'", '*', 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// ── CORS (very permissive for Instagram embeds) ──
const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── HTTP RATE LIMITING ──
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
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
    textQueue: textWaitingQueue.length,
    videoQueue: videoWaitingQueue.length,
    activeTextPairs: textPairs.size / 2,
    activeVideoPairs: videoPairs.size / 2,
    rooms: groupRooms.size,
  });
});

// ── SOCKET.IO ──
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
  pingInterval: 25000,
  allowEIO3: true,
  maxHttpBufferSize: 1e8, // For large video signaling data
});

// ── IN-MEMORY STATE ──
const textWaitingQueue = [];
const videoWaitingQueue = [];
const textPairs = new Map();
const videoPairs = new Map();
const groupRooms = new Map();
const userInterests = new Map();
const videoSettings = new Map(); // Store video/audio preferences

// ── PERMANENT PRE-GROUPS ──
const PERMANENT_ROOMS = [
  'general',
  'random',
  'music',
  'gaming',
  'tech',
  'sports',
  'movies',
  'art',
  'science',
  'philosophy'
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
  'cunt', 'faggot', 'nigger', 'whore', 'pussy',
  'bastard', 'slut'
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
  PERMANENT_ROOMS.forEach(room => {
    if (!groupRooms.has(room)) {
      groupRooms.set(room, new Set());
    }
  });
  
  return [...groupRooms.entries()]
    .filter(([name]) => name !== '__none__')
    .map(([name, members]) => ({ 
      name, 
      count: members.size,
      permanent: PERMANENT_ROOMS.includes(name)
    }));
}

// ── ENHANCED MATCHING WITH INTERESTS ──
function findBestMatch(socket, queue, type = 'text') {
  if (queue.length === 0) return null;
  
  const userInterest = userInterests.get(socket.id) || [];
  let bestMatchIndex = 0;
  let bestScore = -1;
  
  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i];
    if (candidate.id === socket.id) continue; // Don't match with self
    
    const candidateInterest = userInterests.get(candidate.id) || [];
    
    // Calculate interest match score
    let score = 0;
    userInterest.forEach(interest => {
      if (candidateInterest.includes(interest)) score += 2;
    });
    
    // Time in queue bonus
    const timeInQueue = (Date.now() - (candidate.joinTime || Date.now())) / 1000;
    score += Math.min(timeInQueue * 0.1, 5); // Max 5 point bonus
    
    // Random factor to prevent predictability
    score += Math.random() * 2;
    
    if (score > bestScore) {
      bestScore = score;
      bestMatchIndex = i;
    }
  }
  
  const partner = queue[bestMatchIndex];
  queue.splice(bestMatchIndex, 1);
  
  return partner;
}

// ── SOCKET CONNECTIONS ──
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);
  
  socket.sessionId = Math.random().toString(36).substring(2, 10);
  socket.joinTime = Date.now();
  
  // Send initial data
  socket.emit('rooms_list', getActiveRooms());
  socket.emit('server_time', Date.now());
  
  const canMsg = createMsgLimiter();

  // ─── INTEREST MATCHING ───
  socket.on('set_interests', (data) => {
    const interests = Array.isArray(data.interests) ? data.interests : [];
    userInterests.set(socket.id, interests.slice(0, 5));
  });

  // ─── VIDEO CHAT HANDLING (OMEGELE STYLE) ───

  // Request camera/mic permissions and start video search
  socket.on('start_video_chat', async (data) => {
    const settings = data.settings || { video: true, audio: true };
    videoSettings.set(socket.id, settings);
    
    // Leave any existing video pair
    leaveCurrentPair(socket, 'video');
    
    socket.emit('video_permission_requested', { 
      message: 'Please allow camera and microphone access',
      settings 
    });
  });

  // User confirmed permissions, start searching
  socket.on('find_video_stranger', () => {
    leaveCurrentPair(socket, 'video');
    
    // Remove from queue if already there
    const existingIndex = videoWaitingQueue.findIndex(s => s.id === socket.id);
    if (existingIndex !== -1) videoWaitingQueue.splice(existingIndex, 1);
    
    const partner = findBestMatch(socket, videoWaitingQueue, 'video');
    
    if (partner && partner.connected) {
      // Create video pair
      videoPairs.set(socket.id, partner.id);
      videoPairs.set(partner.id, socket.id);
      
      // Get both users' settings
      const socketSettings = videoSettings.get(socket.id) || { video: true, audio: true };
      const partnerSettings = videoSettings.get(partner.id) || { video: true, audio: true };
      
      // Notify both users
      socket.emit('video_paired', { 
        message: 'Video partner found!',
        initiator: true,
        settings: partnerSettings,
        timestamp: Date.now()
      });
      
      partner.emit('video_paired', { 
        message: 'Video partner found!',
        initiator: false,
        settings: socketSettings,
        timestamp: Date.now()
      });
      
      console.log(`Video pair created: ${socket.id} <-> ${partner.id}`);
    } else {
      // Add to queue with timestamp
      socket.joinTime = Date.now();
      videoWaitingQueue.push(socket);
      
      socket.emit('video_searching', { 
        message: 'Looking for a video partner...',
        position: videoWaitingQueue.length,
        timestamp: Date.now()
      });
    }
  });

  // WebRTC Signaling
  socket.on('video_offer', (data) => {
    const partnerId = videoPairs.get(socket.id);
    if (!partnerId) return;
    
    const partner = io.sockets.sockets.get(partnerId);
    if (!partner) return;
    
    partner.emit('video_offer', {
      offer: data.offer,
      from: socket.id,
      timestamp: Date.now()
    });
  });

  socket.on('video_answer', (data) => {
    const partnerId = videoPairs.get(socket.id);
    if (!partnerId) return;
    
    const partner = io.sockets.sockets.get(partnerId);
    if (!partner) return;
    
    partner.emit('video_answer', {
      answer: data.answer,
      from: socket.id,
      timestamp: Date.now()
    });
  });

  socket.on('video_ice_candidate', (data) => {
    const partnerId = videoPairs.get(socket.id);
    if (!partnerId) return;
    
    const partner = io.sockets.sockets.get(partnerId);
    if (!partner) return;
    
    partner.emit('video_ice_candidate', {
      candidate: data.candidate,
      from: socket.id,
      timestamp: Date.now()
    });
  });

  // Video controls
  socket.on('video_toggle_audio', (data) => {
    const partnerId = videoPairs.get(socket.id);
    if (!partnerId) return;
    
    const partner = io.sockets.sockets.get(partnerId);
    if (!partner) return;
    
    const enabled = data.enabled !== false;
    partner.emit('video_partner_toggle_audio', { 
      enabled,
      timestamp: Date.now()
    });
  });

  socket.on('video_toggle_video', (data) => {
    const partnerId = videoPairs.get(socket.id);
    if (!partnerId) return;
    
    const partner = io.sockets.sockets.get(partnerId);
    if (!partner) return;
    
    const enabled = data.enabled !== false;
    partner.emit('video_partner_toggle_video', { 
      enabled,
      timestamp: Date.now()
    });
  });

  // Report inappropriate video behavior
  socket.on('video_report', (data) => {
    const partnerId = videoPairs.get(socket.id);
    if (partnerId) {
      console.log(`[VIDEO REPORT] User ${socket.id} reported ${partnerId}: ${data.reason}`);
      
      // Disconnect the pair
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        partner.emit('video_reported', { 
          message: 'Your partner has ended the chat due to inappropriate behavior.',
          timestamp: Date.now()
        });
      }
      
      // Remove pair
      videoPairs.delete(socket.id);
      videoPairs.delete(partnerId);
      
      socket.emit('video_report_submitted', { 
        message: 'Report submitted. Thank you for helping keep the community safe.',
        timestamp: Date.now()
      });
    }
  });

  // Skip current video partner
  socket.on('video_skip', () => {
    const partnerId = videoPairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        partner.emit('video_stranger_skipped', { 
          message: 'Stranger skipped to next partner',
          timestamp: Date.now()
        });
        videoPairs.delete(partnerId);
      }
      videoPairs.delete(socket.id);
    }
    
    // Start searching for new partner
    socket.emit('find_video_stranger');
  });

  // End video chat
  socket.on('video_end', () => {
    leaveCurrentPair(socket, 'video');
    socket.emit('video_ended', { 
      message: 'Video chat ended',
      timestamp: Date.now()
    });
  });

  // ─── TEXT 1v1 CHAT ───
  socket.on('find_stranger', () => {
    leaveCurrentPair(socket, 'text');

    const partner = findBestMatch(socket, textWaitingQueue, 'text');
    
    if (partner && partner.connected) {
      textPairs.set(socket.id, partner.id);
      textPairs.set(partner.id, socket.id);
      
      const myInterests = userInterests.get(socket.id) || [];
      const theirInterests = userInterests.get(partner.id) || [];
      const commonInterests = myInterests.filter(i => theirInterests.includes(i));
      
      socket.emit('paired', { 
        type: 'text',
        message: commonInterests.length > 0 
          ? `Matched! Common interests: ${commonInterests.join(', ')}`
          : 'You are now chatting with a stranger.',
        timestamp: Date.now(),
        commonInterests
      });
      
      partner.emit('paired', { 
        type: 'text',
        message: commonInterests.length > 0 
          ? `Matched! Common interests: ${commonInterests.join(', ')}`
          : 'You are now chatting with a stranger.',
        timestamp: Date.now(),
        commonInterests
      });
    } else {
      socket.joinTime = Date.now();
      textWaitingQueue.push(socket);
      socket.emit('searching', { 
        type: 'text',
        message: 'Looking for someone to chat with...',
        position: textWaitingQueue.length,
        timestamp: Date.now()
      });
    }
  });

  socket.on('send_message_1v1', (data) => {
    if (!canMsg()) { 
      socket.emit('rate_limited', { message: 'Slow down!' }); 
      return; 
    }
    
    const partnerId = textPairs.get(socket.id);
    if (!partnerId) return;
    
    const partner = io.sockets.sockets.get(partnerId);
    if (!partner) return;
    
    const msg = filterMessage(data.message);
    const messageId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    partner.emit('message_1v1', { 
      from: 'stranger', 
      text: msg,
      messageId,
      timestamp: Date.now()
    });
    
    socket.emit('message_1v1', { 
      from: 'you', 
      text: msg,
      messageId,
      timestamp: Date.now()
    });
  });

  // ─── TYPING INDICATOR ───
  socket.on('typing', (data) => {
    const { isTyping, chatType } = data;
    
    if (chatType === '1v1') {
      const partnerId = textPairs.get(socket.id);
      if (partnerId) {
        const partner = io.sockets.sockets.get(partnerId);
        if (partner) {
          partner.emit('partner_typing', { isTyping });
        }
      }
    } else if (chatType === 'group' && socket.currentRoom) {
      socket.to(socket.currentRoom).emit('room_typing', {
        userId: socket.id,
        nickname: socket.nickname || 'Someone',
        isTyping
      });
    }
  });

  // ─── GROUP CHAT ───
  socket.on('get_rooms', () => {
    socket.emit('rooms_list', getActiveRooms());
  });

  socket.on('join_room', (data) => {
    let roomName = String(data.room || '').trim().slice(0, 30);
    
    if (!roomName || roomName === '__none__') {
      roomName = 'general';
    }
    
    if (socket.currentRoom) {
      exitRoom(socket, true);
    }
    
    setTimeout(() => {
      if (!groupRooms.has(roomName)) {
        groupRooms.set(roomName, new Set());
      }
      
      socket.join(roomName);
      socket.currentRoom = roomName;
      groupRooms.get(roomName).add(socket.id);
      
      const count = groupRooms.get(roomName).size;
      
      socket.emit('room_joined', { 
        room: roomName, 
        count,
        permanent: PERMANENT_ROOMS.includes(roomName)
      });
      
      setTimeout(() => {
        socket.emit('room_message', {
          from: 'system',
          text: `✨ Welcome to #${roomName}! There ${count === 1 ? 'is' : 'are'} ${count} user${count === 1 ? '' : 's'} here.`,
          timestamp: Date.now(),
          type: 'welcome'
        });
      }, 100);
      
      socket.to(roomName).emit('room_message', {
        from: 'system',
        text: `🌸 ${socket.nickname || 'Someone'} joined. (${count} in room)`,
        timestamp: Date.now(),
        type: 'join'
      });
      
      io.emit('rooms_updated', getActiveRooms());
    }, 300);
  });

  socket.on('send_message_group', (data) => {
    if (!socket.currentRoom) return;
    if (!canMsg()) { 
      socket.emit('rate_limited', { message: 'Slow down!' }); 
      return; 
    }
    
    const msg = filterMessage(data.message);
    const messageId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    io.to(socket.currentRoom).emit('room_message', {
      from: socket.nickname || 'Stranger',
      text: msg,
      selfId: socket.id,
      messageId,
      timestamp: Date.now()
    });
  });

  socket.on('leave_room', (data) => {
    const smooth = data?.smooth !== false;
    exitRoom(socket, smooth);
  });

  socket.on('set_nickname', (data) => {
    socket.nickname = String(data.nickname || '').slice(0, 20) || 'Stranger';
  });

  // ─── REPORT USER ───
  socket.on('report_user', (data) => {
    console.log(`[REPORT] ${socket.id} reported: ${data.reason}`);
    socket.emit('report_received', { 
      message: 'Report submitted. Thank you for helping keep the community safe.',
      timestamp: Date.now()
    });
  });

  // ─── DISCONNECT ───
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    
    // Remove from queues
    const textIndex = textWaitingQueue.findIndex(s => s.id === socket.id);
    if (textIndex !== -1) textWaitingQueue.splice(textIndex, 1);
    
    const videoIndex = videoWaitingQueue.findIndex(s => s.id === socket.id);
    if (videoIndex !== -1) videoWaitingQueue.splice(videoIndex, 1);
    
    // Clean up interests and settings
    userInterests.delete(socket.id);
    videoSettings.delete(socket.id);
    
    // Leave pairs
    leaveCurrentPair(socket, 'text');
    leaveCurrentPair(socket, 'video');
    
    // Leave room
    if (socket.currentRoom) exitRoom(socket, false);
    
    io.emit('rooms_updated', getActiveRooms());
  });

  // ── HELPERS ──
  function leaveCurrentPair(sock, type) {
    if (type === 'video') {
      const partnerId = videoPairs.get(sock.id);
      if (partnerId) {
        const partner = io.sockets.sockets.get(partnerId);
        if (partner && partner.connected) { 
          partner.emit('video_stranger_left', { 
            message: 'Stranger disconnected.',
            timestamp: Date.now()
          }); 
          videoPairs.delete(partnerId);
        }
        videoPairs.delete(sock.id);
      }
      
      // Remove from video queue if present
      const videoIndex = videoWaitingQueue.findIndex(s => s.id === sock.id);
      if (videoIndex !== -1) videoWaitingQueue.splice(videoIndex, 1);
      
    } else {
      const partnerId = textPairs.get(sock.id);
      if (partnerId) {
        const partner = io.sockets.sockets.get(partnerId);
        if (partner && partner.connected) { 
          partner.emit('stranger_left', { 
            message: 'Stranger disconnected.',
            timestamp: Date.now()
          }); 
          textPairs.delete(partnerId);
        }
        textPairs.delete(sock.id);
      }
      
      const textIndex = textWaitingQueue.findIndex(s => s.id === sock.id);
      if (textIndex !== -1) textWaitingQueue.splice(textIndex, 1);
    }
  }

  function exitRoom(sock, smooth = true) {
    const name = sock.currentRoom;
    if (!name) return;
    
    if (smooth) {
      io.to(name).emit('room_message', { 
        from: 'system', 
        text: `👋 ${sock.nickname || 'Someone'} is leaving...`,
        timestamp: Date.now(),
        type: 'leave-pending'
      });
    }
    
    setTimeout(() => {
      sock.leave(name);
      sock.currentRoom = null;
      
      const rm = groupRooms.get(name);
      if (rm) {
        rm.delete(sock.id);
        
        if (!PERMANENT_ROOMS.includes(name) && rm.size === 0) {
          groupRooms.delete(name);
        } else {
          if (rm.size > 0) {
            io.to(name).emit('room_message', { 
              from: 'system', 
              text: `🍃 ${sock.nickname || 'Someone'} left.`,
              timestamp: Date.now(),
              type: 'leave'
            });
          }
        }
      }
      
      sock.emit('room_left', { 
        room: name,
        message: `You left #${name}`,
        timestamp: Date.now()
      });
      
      io.emit('rooms_updated', getActiveRooms());
    }, smooth ? 300 : 0);
  }
});

// ── START ──
server.listen(PORT, () => {
  console.log(`\n✨ BlankRoom [${NODE_ENV}] on port ${PORT}`);
  console.log(`📌 Permanent rooms: ${PERMANENT_ROOMS.join(', ')}`);
  console.log(`🎥 Video chat enabled (Omegle style)`);
  console.log(`🌐 CORS: All origins allowed`);
  console.log(`🔒 NO IP LOGGING - Privacy first!\n`);
});