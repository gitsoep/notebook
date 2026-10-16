const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const auth = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'notes.json');
const COOKIE_NAME = 'cn_session';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const CORS_ORIGINS = new Set([
  'https://notebook.soep.org',
  'https://notes.soep.org',
]);
const MAX_NOTES = 500;
const MAX_TEXT = 2000;
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const MAX_BODY = 8 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- Notes storage ----------

let notes = loadNotes();
let saveTimer = null;

function loadNotes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.slice(-MAX_NOTES) : [];
  } catch {
    return [];
  }
}

function saveNotesNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(notes));
  fs.renameSync(tmp, DATA_FILE);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNotesNow, 250);
}

function addNote(note, canReceive) {
  notes.push(note);
  if (notes.length > MAX_NOTES) notes = notes.slice(-MAX_NOTES);
  scheduleSave();
  broadcast({ type: 'note', note }, undefined, canReceive);
}

// ---------- HTTP helpers ----------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

function sessionFromReq(req) {
  return auth.resolveSession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.host === req.headers.host || CORS_ORIGINS.has(parsedOrigin.origin);
  } catch {
    return false;
  }
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const allowedOrigin = new URL(origin).origin;
    if (!CORS_ORIGINS.has(allowedOrigin)) return false;
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    return true;
  } catch {
    return false;
  }
}

function isSecure(req) {
  return COOKIE_SECURE || !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(auth.SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) {
      reject(new auth.AuthError(413, 'Request too large.'));
      return;
    }
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return reject(new auth.AuthError(413, 'Request too large.'));
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const value = raw ? JSON.parse(raw) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch {
        reject(new auth.AuthError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- Login throttling ----------

const loginFailures = new Map();

function loginBlocked(ip) {
  const f = loginFailures.get(ip);
  if (!f) return false;
  if (Date.now() > f.reset) {
    loginFailures.delete(ip);
    return false;
  }
  return f.count >= LOGIN_MAX_FAILURES;
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const f = loginFailures.get(ip);
  if (!f || now > f.reset) loginFailures.set(ip, { count: 1, reset: now + LOGIN_WINDOW_MS });
  else f.count++;
}

// ---------- API ----------

async function handleApi(req, res, pathname) {
  if (req.method !== 'GET') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request blocked.' });
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return sendJson(res, 415, { error: 'Expected JSON.' });
    }
  }

  const ip = req.socket.remoteAddress || '';
  const session = sessionFromReq(req);
  const route = `${req.method} ${pathname}`;

  if (route === 'POST /api/login') {
    if (loginBlocked(ip)) {
      return sendJson(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
    }
    const body = await readJsonBody(req);
    const user = await auth.authenticate(body.username, body.password);
    if (!user) {
      noteLoginFailure(ip);
      return sendJson(res, 401, { error: 'Wrong username or password.' });
    }
    loginFailures.delete(ip);
    if (session) auth.deleteSession(session.id);
    const { token } = auth.createSession(user.id);
    setSessionCookie(req, res, token);
    return sendJson(res, 200, { user: auth.publicUser(user) });
  }

  if (route === 'POST /api/logout') {
    if (session) {
      auth.deleteSession(session.id);
      closeSockets((ws) => ws.sessionId === session.id, 'signed-out');
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (!session) return sendJson(res, 401, { error: 'Not signed in.' });
  const me = session.user;

  if (route === 'GET /api/me') return sendJson(res, 200, { user: auth.publicUser(me) });

  if (route === 'POST /api/me/password') {
    if (loginBlocked(ip)) {
      return sendJson(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
    }
    const body = await readJsonBody(req);
    const current = typeof body.currentPassword === 'string' ? body.currentPassword.slice(0, auth.PASSWORD_MAX) : '';
    if (!(await auth.verifyPassword(current, me.passwordHash))) {
      noteLoginFailure(ip);
      return sendJson(res, 400, { error: 'Your current password is incorrect.' });
    }
    if (body.newPassword === current) {
      return sendJson(res, 400, { error: 'Choose a password that differs from the current one.' });
    }
    await auth.setPassword(me, body.newPassword, { mustChangePassword: false });
    auth.revokeUserSessions(me.id, session.id);
    closeSockets((ws) => ws.userId === me.id && ws.sessionId !== session.id, 'password-changed');
    return sendJson(res, 200, { user: auth.publicUser(me) });
  }

  if (me.mustChangePassword) return sendJson(res, 403, { error: 'Change your password first.' });
  if (me.role !== 'admin') return sendJson(res, 403, { error: 'Only admins can manage users.' });

  if (route === 'GET /api/users') return sendJson(res, 200, { users: auth.listUsers() });

  if (route === 'POST /api/users') {
    const body = await readJsonBody(req);
    const password = body.password ? body.password : auth.generatePassword();
    const user = await auth.createUser({
      username: typeof body.username === 'string' ? body.username.trim() : body.username,
      password,
      role: body.role || 'user',
      mustChangePassword: true,
      createdBy: me.username,
    });
    return sendJson(res, 201, { user: auth.publicUser(user), password });
  }

  const match = pathname.match(/^\/api\/users\/([0-9a-f-]{36})(\/reset-password)?$/);
  if (match) {
    const target = auth.findById(match[1]);
    if (!target) return sendJson(res, 404, { error: 'User not found.' });
    const isSelf = target.id === me.id;

    if (match[2] && req.method === 'POST') {
      if (isSelf) return sendJson(res, 400, { error: 'Use “Password” in the sidebar to change your own password.' });
      const body = await readJsonBody(req);
      const password = body.password ? body.password : auth.generatePassword();
      await auth.setPassword(target, password, { mustChangePassword: true });
      auth.revokeUserSessions(target.id);
      closeSockets((ws) => ws.userId === target.id, 'password-reset');
      return sendJson(res, 200, { user: auth.publicUser(target), password });
    }

    if (!match[2] && req.method === 'PATCH') {
      if (isSelf) return sendJson(res, 400, { error: 'You can’t change your own role or status.' });
      const body = await readJsonBody(req);
      const changes = {};
      if ('role' in body) changes.role = body.role;
      if ('disabled' in body) changes.disabled = body.disabled === true;
      auth.updateUser(target, changes);
      if (target.disabled) {
        auth.revokeUserSessions(target.id);
        closeSockets((ws) => ws.userId === target.id, 'account-disabled');
      } else {
        notifyUser(target);
      }
      return sendJson(res, 200, { user: auth.publicUser(target) });
    }

    if (!match[2] && req.method === 'DELETE') {
      if (isSelf) return sendJson(res, 400, { error: 'You can’t delete your own account.' });
      auth.deleteUser(target);
      closeSockets((ws) => ws.userId === target.id, 'account-removed');
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

// ---------- Static files ----------

function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const host = req.headers.host || '';
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': [
        "default-src 'self'",
        "style-src 'self' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data:",
        `connect-src 'self' ws://${host} wss://${host}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/api' || urlPath.startsWith('/api/')) {
    const corsAllowed = setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      if (!corsAllowed) return sendJson(res, 403, { error: 'Cross-origin request blocked.' });
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    try {
      await handleApi(req, res, urlPath);
    } catch (err) {
      if (err instanceof auth.AuthError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
      }
    }
    return;
  }
  serveStatic(req, res, urlPath);
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const reject = (status) => {
    socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://x').pathname;
  } catch {
    /* handled below */
  }
  if (pathname !== '/ws') return reject(404);
  if (!sameOrigin(req)) return reject(403);
  const session = sessionFromReq(req);
  if (!session || session.user.mustChangePassword) return reject(401);

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = session.user.id;
    ws.sessionId = session.id;
    ws.user = session.user.username;
    wss.emit('connection', ws);
  });
});

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, except, canReceive) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN && client.userId &&
        (!canReceive || canReceive(client))) client.send(data);
  }
}

// Close codes in the 4000 range tell the browser to stop reconnecting and show the sign-in screen.
function closeSockets(predicate, reason) {
  for (const ws of wss.clients) {
    if (ws.userId && predicate(ws)) ws.close(4001, reason);
  }
}

function notifyUser(user) {
  for (const ws of wss.clients) {
    if (ws.userId === user.id) send(ws, { type: 'me', user: auth.publicUser(user) });
  }
}

function onlineUsers() {
  const names = new Set();
  for (const client of wss.clients) if (client.userId) names.add(client.user);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function socketsFor(userId) {
  let n = 0;
  for (const client of wss.clients) if (client.userId === userId) n++;
  return n;
}

function systemNote(text) {
  addNote(
    { id: crypto.randomUUID(), system: true, adminOnly: true, text, ts: Date.now() },
    (client) => auth.findById(client.userId)?.role === 'admin',
  );
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.sent = [];
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const user = auth.findById(ws.userId);
  const visibleNotes = user.role === 'admin'
    ? notes
    : notes.filter((note) => !note.adminOnly &&
      !(note.system && /(?:opened|closed) the notebook$/.test(note.text)));
  send(ws, { type: 'welcome', user: auth.publicUser(user), notes: visibleNotes, users: onlineUsers() });
  broadcast({ type: 'presence', users: onlineUsers() });
  if (socketsFor(ws.userId) === 1) systemNote(`${ws.user} opened the notebook`);

  ws.on('message', (raw) => {
    const current = auth.findById(ws.userId);
    if (!current || current.disabled) {
      ws.close(4001, 'session-revoked');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'note') {
      const text = typeof msg.text === 'string' ? msg.text.replace(/\r\n/g, '\n').trim() : '';
      if (!text) return;
      if (text.length > MAX_TEXT) {
        send(ws, { type: 'error', message: `Notes are limited to ${MAX_TEXT} characters.` });
        return;
      }
      const now = Date.now();
      ws.sent = ws.sent.filter((t) => now - t < RATE_WINDOW_MS);
      if (ws.sent.length >= RATE_MAX) {
        send(ws, { type: 'error', message: 'Slow down a little — too many notes at once.' });
        return;
      }
      ws.sent.push(now);
      addNote({ id: crypto.randomUUID(), authorId: ws.userId, author: ws.user, text, ts: now });
      return;
    }

    if (msg.type === 'typing') {
      broadcast({ type: 'typing', name: ws.user }, ws);
    }
  });

  ws.on('close', () => {
    const { userId, user: name } = ws;
    ws.userId = null;
    broadcast({ type: 'presence', users: onlineUsers() });
    if (socketsFor(userId) === 0) systemNote(`${name} closed the notebook`);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [ip, f] of loginFailures) if (now > f.reset) loginFailures.delete(ip);
  auth.pruneSessions();
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

// ---------- Startup ----------

async function bootstrapAdmin() {
  if (auth.userCount() > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const fromEnv = !!process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || auth.generatePassword();
  await auth.createUser({ username, password, role: 'admin', mustChangePassword: !fromEnv, createdBy: 'system' });
  console.log('\n  No users found — created the first admin account.');
  console.log(`    username: ${username}`);
  if (!fromEnv) {
    console.log(`    password: ${password}`);
    console.log('  You will be asked to choose a new password on first sign-in.\n');
  }
}

function shutdown() {
  if (saveTimer) saveNotesNow();
  auth.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bootstrapAdmin()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Shared notebook running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
