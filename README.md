# BlankRoom — Anonymous Video + Text Chat

Omegle-style anonymous chat. No tracking. No logs. Chats disappear.

## Features
- 🎥 **Video chat** (WebRTC via SimplePeer) — no permission loop
- 💬 **1v1 text chat** with typing indicators
- 👥 **Group chat rooms** (permanent + user-created)
- 📱 **Mobile optimised** — draggable PiP, touch-friendly controls
- 🔒 No IP logging, no message storage

## Quick Start (local)

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy to Render (free tier)

1. Push to GitHub
2. New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Environment: `NODE_ENV=production`

Done. No extra config needed — CORS is open, WebRTC uses public STUN/TURN.

## Deploy to Railway / Fly.io / Heroku

Same as above — just set `PORT` env var if needed (defaults to 3000).

## Environment Variables (optional)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Environment |

## File Structure

```
blankroom/
├── server.js          # Socket.IO + Express server
├── package.json
└── public/
    └── index.html     # Single-file frontend (CSS + JS inline)
```

## WebRTC Notes

- Uses Google STUN servers + OpenRelay TURN for NAT traversal
- SimplePeer handles offer/answer/ICE automatically
- No permission loop: permissions are requested once and reused
- Peer is destroyed cleanly on skip/end/disconnect
