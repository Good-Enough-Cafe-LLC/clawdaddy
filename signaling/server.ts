import { createServer } from 'http';
import { Server, Socket } from 'socket.io';

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
  // Add connection timeout and ping settings
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_SERVERS           = 1000;
const MIN_ID_LENGTH         = 8;
const AUTH_HASH_REGEX       = /^[a-f0-9]{64}$/i;   // must be 64-char hex
const RATE_WINDOW_MS        = 60_000;               // 1 minute
const RATE_MAX_ATTEMPTS     = 10;                   // per IP per window
const SESSION_GRACE_MS      = 30_000;               // cleanup delay after ICE completes
const MAX_SESSION_AGE_MS    = 1_200_000;              // 2 minutes max session life
const RATE_LIMITER_CLEANUP_MS = 5 * 60_000;         // Clean up rate limiter every 5 minutes

// ─── Types ────────────────────────────────────────────────────────────────────
interface ServerInfo {
  socketId:  string;
  authHash:  string;
  lastSeen:  number;
}

interface SessionInfo {
  clientSocketId: string;
  serverId:       string;
  iceComplete:    boolean;
  createdAt:      number;
  cleanupTimer?:  ReturnType<typeof setTimeout>;
}

// Register as a persistent, connectable server node
interface RegisterServerPayload {
  role:     'server';
  serverId: string;   // min 8 chars
  authHash: string;   // 64-char hex — shared secret clients must know to connect
}

// Register as an ephemeral client session targeting a specific server
interface RegisterClientPayload {
  role:           'client';
  sessionId:      string;   // client-generated UUID for this handshake
  targetServerId: string;   // which server to connect to
  authHash:       string;   // must match the server's registered authHash
}

type RegisterPayload = RegisterServerPayload | RegisterClientPayload;

// Signals always carry a sessionId so the server can multiplex many clients
interface SignalPayload {
  sessionId:  string;
  signalData: RTCSessionDescriptionInit | RTCIceCandidateInit | { candidate: null };
}

// ─── State ────────────────────────────────────────────────────────────────────
const servers        = new Map<string, ServerInfo>();   // serverId  → ServerInfo
const sessions       = new Map<string, SessionInfo>();  // sessionId → SessionInfo
const socketToServer = new Map<string, string>();       // socketId  → serverId
const socketToSession = new Map<string, string>();       // socketId  → sessionId

// Rate limiting: IP → { count, windowStart }
const rateLimiter    = new Map<string, { count: number; windowStart: number }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────
const timestamp = () =>
  `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`;

function logState() {
  console.log(`${timestamp()} 📊 Servers: ${servers.size} | Sessions: ${sessions.size}`);
  for (const [id, info] of servers.entries()) {
    console.log(`   🖥  ${id} — socket: ${info.socketId.slice(0, 8)}...`);
  }
}

/** Returns true if this IP has exceeded the rate limit. */
function isRateLimited(ip: string): boolean {
  const now    = Date.now();
  const record = rateLimiter.get(ip);

  if (!record || now - record.windowStart > RATE_WINDOW_MS) {
    rateLimiter.set(ip, { count: 1, windowStart: now });
    return false;
  }

  record.count += 1;

  if (record.count > RATE_MAX_ATTEMPTS) {
    console.log(`${timestamp()} 🚦 Rate limit exceeded for IP: ${ip}`);
    return true;
  }

  return false;
}

/** Clean up old rate limiter entries */
function cleanupRateLimiter(): void {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [ip, record] of rateLimiter.entries()) {
    if (now - record.windowStart > RATE_WINDOW_MS) {
      rateLimiter.delete(ip);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`${timestamp()} 🧹 Cleaned up ${cleaned} stale rate limiter entries`);
  }
}

/** Validate a register payload's shared fields. */
function validateCommon(id: string, authHash: string, label: string): string | null {
  if (!id || id.length < MIN_ID_LENGTH) {
    return `${label} ID must be at least ${MIN_ID_LENGTH} characters`;
  }
  if (!AUTH_HASH_REGEX.test(authHash)) {
    return `${label} authHash must be a 64-character hex string`;
  }
  return null;
}

/** Schedule session deletion after the ICE grace period. */
function scheduleSessionCleanup(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || session.cleanupTimer) return;

  console.log(`${timestamp()} ⏳ Scheduling cleanup for session ${sessionId} in ${SESSION_GRACE_MS}ms`);

  session.cleanupTimer = setTimeout(() => {
    const sessionToClean = sessions.get(sessionId);
    if (sessionToClean) {
      // Notify server that client disconnected (if server still exists)
      const server = servers.get(sessionToClean.serverId);
      if (server) {
        io.to(server.socketId).emit('client_disconnected', { sessionId });
      }
      
      sessions.delete(sessionId);
      // Remove reverse-lookup
      for (const [sockId, sid] of socketToSession.entries()) {
        if (sid === sessionId) socketToSession.delete(sockId);
      }
      console.log(`${timestamp()} 🧹 Cleaned up session ${sessionId}`);
    }
  }, SESSION_GRACE_MS);
}

/** Periodic cleanup of stale sessions (safety net) */
function periodicSessionCleanup(): void {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [sessionId, session] of sessions.entries()) {
    // Clean up sessions older than MAX_SESSION_AGE_MS
    if (now - session.createdAt > MAX_SESSION_AGE_MS) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      sessions.delete(sessionId);
      // Clean up socket mapping
      for (const [sockId, sid] of socketToSession.entries()) {
        if (sid === sessionId) socketToSession.delete(sockId);
      }
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`${timestamp()} 🧹 Periodic cleanup removed ${cleaned} stale sessions`);
    logState();
  }
}

// ─── Connection handling ──────────────────────────────────────────────────────
io.on('connection', (socket: Socket) => {
  const ip = (
    socket.handshake.headers['x-forwarded-for'] as string | undefined
    ?? socket.handshake.address
  ).split(',')[0].trim();

  console.log(`${timestamp()} 🔌 Connected: ${socket.id} (${ip})`);

  // ── Register ──────────────────────────────────────────────────────────────
  socket.on('register', (payload: RegisterPayload) => {
    if (isRateLimited(ip)) {
      socket.emit('error', { code: 'RATE_LIMITED', message: 'Too many registration attempts.' });
      return;
    }

    if (!payload?.role) {
      socket.emit('error', { code: 'BAD_PAYLOAD', message: 'Missing role.' });
      return;
    }

    // ── Server registration ────────────────────────────────────────────────
    if (payload.role === 'server') {
      const { serverId, authHash } = payload;

      const err = validateCommon(serverId, authHash, 'Server');
      if (err) {
        socket.emit('error', { code: 'VALIDATION', message: err });
        return;
      }

      if (servers.size >= MAX_SERVERS && !servers.has(serverId)) {
        socket.emit('error', { code: 'CAPACITY', message: 'Switchboard is at capacity.' });
        return;
      }

      // Kick old socket if re-registering
      const existing = servers.get(serverId);
      if (existing) {
        console.log(`${timestamp()} 🔁 Re-registering server: ${serverId}`);
        const oldSocket = io.sockets.sockets.get(existing.socketId);
        if (oldSocket) {
          oldSocket.disconnect(true);
        }
        socketToServer.delete(existing.socketId);
      }

      servers.set(serverId, { socketId: socket.id, authHash, lastSeen: Date.now() });
      socketToServer.set(socket.id, serverId);

      console.log(`${timestamp()} ✅ Server registered: ${serverId}`);
      socket.emit('registered', { role: 'server', serverId });
      logState();
      return;
    }

    // ── Client registration ────────────────────────────────────────────────
    if (payload.role === 'client') {
      const { sessionId, targetServerId, authHash } = payload;

      const errSession = validateCommon(sessionId, authHash, 'Client');
      if (errSession) {
        socket.emit('error', { code: 'VALIDATION', message: errSession });
        return;
      }

      if (!targetServerId || targetServerId.length < MIN_ID_LENGTH) {
        socket.emit('error', { code: 'VALIDATION', message: 'Invalid targetServerId.' });
        return;
      }

      const server = servers.get(targetServerId);
      if (!server) {
        console.log(`${timestamp()} ❌ Server '${targetServerId}' not found. Available: ${Array.from(servers.keys()).join(', ')}`);
        socket.emit('error', { code: 'NOT_FOUND', message: `Server '${targetServerId}' not found.` });
        return;
      }

      // Auth check — client must know the server's shared secret
      if (server.authHash !== authHash) {
        console.log(`${timestamp()} ❌ Auth failed for client targeting ${targetServerId}`);
        socket.emit('error', { code: 'AUTH_FAILED', message: 'Invalid authHash.' });
        return;
      }

      if (sessions.has(sessionId)) {
        socket.emit('error', { code: 'DUPLICATE_SESSION', message: `Session '${sessionId}' already exists.` });
        return;
      }

      sessions.set(sessionId, {
        clientSocketId: socket.id,
        serverId:       targetServerId,
        iceComplete:    false,
        createdAt:      Date.now(),
      });

      socketToSession.set(socket.id, sessionId);

      console.log(`${timestamp()} ✅ Client session registered: ${sessionId} → ${targetServerId}`);

      // Notify the server a new client wants to connect
      const serverSocket = io.sockets.sockets.get(server.socketId);
      if (serverSocket) {
        serverSocket.emit('client_session', {
          sessionId,
          clientSocketId: socket.id, // Send client socket ID for better tracking
        });
        console.log(`${timestamp()} 📡 Notified server ${targetServerId} about client session ${sessionId}`);
      } else {
        console.log(`${timestamp()} ⚠️ Server socket not found for ${targetServerId}`);
        sessions.delete(sessionId);
        socketToSession.delete(socket.id);
        socket.emit('error', { code: 'SERVER_OFFLINE', message: 'Server is offline.' });
        return;
      }

      socket.emit('registered', { role: 'client', sessionId, targetServerId });
      return;
    }

    socket.emit('error', { code: 'BAD_PAYLOAD', message: 'Unknown role.' });
  });

  // ── Signal: Client ↔ Server ───────────────────────────────────────────────
  socket.on('signal', ({ sessionId, signalData }: SignalPayload) => {
    if (!sessionId || !signalData) {
      socket.emit('error', { code: 'BAD_PAYLOAD', message: 'Missing sessionId or signalData.' });
      return;
    }

    // Determine direction: is this socket a client or a server?
    const ownSessionId = socketToSession.get(socket.id);
    const ownServerId  = socketToServer.get(socket.id);

    // Log signal for debugging
    const signalType = (signalData as any)?.type || (signalData as any)?.candidate ? 'candidate' : 'unknown';
    console.log(`${timestamp()} 📡 Signal: session=${sessionId.slice(0, 8)}... type=${signalType} direction=${ownSessionId ? 'client→server' : ownServerId ? 'server→client' : 'unknown'}`);

    if (ownSessionId) {
      // ── Client → Server ──────────────────────────────────────────────────
      if (ownSessionId !== sessionId) {
        socket.emit('error', { code: 'FORBIDDEN', message: 'sessionId mismatch.' });
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        console.log(`${timestamp()} ❌ Session not found: ${sessionId}`);
        socket.emit('error', { code: 'NOT_FOUND', message: 'Session not found.' });
        return;
      }

      const server = servers.get(session.serverId);
      if (!server) {
        console.log(`${timestamp()} ❌ Target server not found: ${session.serverId}`);
        socket.emit('error', { code: 'NOT_FOUND', message: 'Target server not found.' });
        return;
      }

      const serverSocket = io.sockets.sockets.get(server.socketId);
      if (!serverSocket) {
        console.log(`${timestamp()} ❌ Server socket not connected: ${session.serverId}`);
        socket.emit('error', { code: 'SERVER_OFFLINE', message: 'Server is offline.' });
        return;
      }

      console.log(`${timestamp()} 📡 Forwarding ${signalType} from client to server ${session.serverId}`);
      serverSocket.emit('signal', { sessionId, signalData });

    } else if (ownServerId) {
      // ── Server → Client ──────────────────────────────────────────────────
      const session = sessions.get(sessionId);
      if (!session) {
        console.log(`${timestamp()} ❌ Session not found: ${sessionId}`);
        socket.emit('error', { code: 'NOT_FOUND', message: 'Session not found.' });
        return;
      }

      // Confirm this server actually owns the session
      if (session.serverId !== ownServerId) {
        console.log(`${timestamp()} ❌ Server ${ownServerId} not owner of session ${sessionId} (owner: ${session.serverId})`);
        socket.emit('error', { code: 'FORBIDDEN', message: 'This session belongs to a different server.' });
        return;
      }

      const clientSocket = io.sockets.sockets.get(session.clientSocketId);
      if (!clientSocket) {
        console.log(`${timestamp()} ❌ Client socket not connected for session ${sessionId}`);
        // Clean up stale session
        if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
        sessions.delete(sessionId);
        socketToSession.delete(session.clientSocketId);
        socket.emit('error', { code: 'CLIENT_OFFLINE', message: 'Client is offline.' });
        return;
      }

      console.log(`${timestamp()} 📡 Forwarding ${signalType} from server to client`);
      clientSocket.emit('signal', { sessionId, signalData });

    } else {
      socket.emit('error', { code: 'UNREGISTERED', message: 'You must register before signaling.' });
      return;
    }

    // ── ICE completion detection ──────────────────────────────────────────
    const candidate = (signalData as any)?.candidate;
    if (candidate === null) {
      const session = sessions.get(sessionId);
      if (session && !session.iceComplete) {
        session.iceComplete = true;
        console.log(`${timestamp()} 🧊 ICE complete for session ${sessionId.slice(0, 8)}...`);
        scheduleSessionCleanup(sessionId);
      }
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`${timestamp()} 🔌 Disconnected: ${socket.id} (${ip}) reason: ${reason}`);
    
    // Was this a server?
    const serverId = socketToServer.get(socket.id);
    if (serverId) {
      servers.delete(serverId);
      socketToServer.delete(socket.id);
      console.log(`${timestamp()} ❌ Server disconnected: ${serverId}`);
      logState();
      return;
    }

    // Was this a client session?
    const sessionId = socketToSession.get(socket.id);
    if (sessionId) {
      const session = sessions.get(sessionId);
      
      if (session) {
        // Notify the server its client left
        const server = servers.get(session.serverId);
        if (server) {
          const serverSocket = io.sockets.sockets.get(server.socketId);
          if (serverSocket) {
            serverSocket.emit('client_disconnected', { sessionId });
            console.log(`${timestamp()} 📡 Notified server ${session.serverId} about client disconnect`);
          }
        }
        
        // Clear any pending cleanup timer
        if (session.cleanupTimer) {
          clearTimeout(session.cleanupTimer);
        }
      }
      
      // Always delete the session on disconnect
      sessions.delete(sessionId);
      socketToSession.delete(socket.id);
      console.log(`${timestamp()} ❌ Client session disconnected & cleaned: ${sessionId}`);
      logState();
      return;
    }

    console.log(`${timestamp()} ❌ Unknown socket disconnected: ${socket.id}`);
  });
});

// ─── Health check endpoint ─────────────────────────────────────────────────────
httpServer.on('request', (req: any, res: any) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      servers: servers.size,
      sessions: sessions.size,
      rateLimiterEntries: rateLimiter.size,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
    }));
    return;
  }
  
  res.writeHead(404);
  res.end();
});

// ─── Periodic cleanup intervals ───────────────────────────────────────────────
setInterval(cleanupRateLimiter, RATE_LIMITER_CLEANUP_MS);
setInterval(periodicSessionCleanup, 60_000); // Run every minute

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3003;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`
${timestamp()} Clawdaddy Switchboard online on port ${PORT}

        \\
         \\\\
      __/\\__
   ___( o.o )___
   /   \\ ^/   \\
   \\___/  \\___/
   __/|  | |\\__
  /___|  |_|___\\

🦞 Standing by...
  `);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log(`${timestamp()} Received SIGTERM, shutting down gracefully...`);
  io.close(() => {
    httpServer.close(() => {
      console.log(`${timestamp()} Server closed`);
      process.exit(0);
    });
  });
});