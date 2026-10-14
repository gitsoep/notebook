const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,23}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const ROLES = ['admin', 'user'];
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let users = readJson(USERS_FILE, []);
if (!Array.isArray(users)) users = [];

const storedSessions = readJson(SESSIONS_FILE, {});
const sessions = new Map(Object.entries(storedSessions && typeof storedSessions === 'object' ? storedSessions : {}));
let sessionSaveTimer = null;

function saveUsers() {
  writeJson(USERS_FILE, users);
}

function saveSessionsNow() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = null;
  writeJson(SESSIONS_FILE, Object.fromEntries(sessions));
}

function saveSessions() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSessionsNow, 500);
}

function flush() {
  if (sessionSaveTimer) saveSessionsNow();
}

// ---------- Passwords ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(actual, expected);
}

// Used so that logins for unknown usernames take as long as real ones.
const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function validateUsername(name) {
  if (typeof name !== 'string' || !USERNAME_RE.test(name)) {
    throw new AuthError(400, 'Usernames are 2–24 characters: letters, numbers, dots, dashes or underscores.');
  }
  return name;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new AuthError(400, `Passwords need at least ${PASSWORD_MIN} characters.`);
  }
  if (password.length > PASSWORD_MAX) {
    throw new AuthError(400, `Passwords can be at most ${PASSWORD_MAX} characters.`);
  }
  return password;
}

function validateRole(role) {
  if (!ROLES.includes(role)) throw new AuthError(400, 'Unknown role.');
  return role;
}

// ---------- Users ----------

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: !!u.disabled,
    mustChangePassword: !!u.mustChangePassword,
    createdAt: u.createdAt,
    createdBy: u.createdBy || null,
    lastLoginAt: u.lastLoginAt || null,
  };
}

function findById(id) {
  return users.find((u) => u.id === id) || null;
}

function findByName(name) {
  const key = String(name || '').toLowerCase();
  return users.find((u) => u.username.toLowerCase() === key) || null;
}

function listUsers() {
  return users.map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
}

function userCount() {
  return users.length;
}

async function createUser({ username, password, role = 'user', mustChangePassword = true, createdBy = null }) {
  validateUsername(username);
  validatePassword(password);
  validateRole(role);
  if (findByName(username)) throw new AuthError(409, 'That username is already taken.');
  const passwordHash = await hashPassword(password);
  if (findByName(username)) throw new AuthError(409, 'That username is already taken.');
  const user = {
    id: crypto.randomUUID(),
    username,
    role,
    passwordHash,
    mustChangePassword,
    disabled: false,
    createdAt: Date.now(),
    createdBy,
    lastLoginAt: null,
  };
  users.push(user);
  saveUsers();
  return user;
}

async function setPassword(user, password, { mustChangePassword }) {
  validatePassword(password);
  user.passwordHash = await hashPassword(password);
  user.mustChangePassword = mustChangePassword;
  saveUsers();
}

function updateUser(user, changes) {
  if ('role' in changes) user.role = validateRole(changes.role);
  if ('disabled' in changes) user.disabled = !!changes.disabled;
  saveUsers();
}

function deleteUser(user) {
  users = users.filter((u) => u !== user);
  saveUsers();
  revokeUserSessions(user.id);
}

async function authenticate(username, password) {
  const user = typeof username === 'string' ? findByName(username.trim()) : null;
  const pw = typeof password === 'string' ? password.slice(0, PASSWORD_MAX) : '';
  const ok = await verifyPassword(pw, user ? user.passwordHash : await dummyHash);
  if (!user || !ok || user.disabled) return null;
  user.lastLoginAt = Date.now();
  saveUsers();
  return user;
}

// ---------- Sessions ----------

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = hashToken(token);
  sessions.set(id, { userId, expires: Date.now() + SESSION_TTL_MS });
  saveSessions();
  return { token, id };
}

function resolveSession(token) {
  if (typeof token !== 'string' || !token) return null;
  const id = hashToken(token);
  const session = sessions.get(id);
  if (!session) return null;
  const user = findById(session.userId);
  if (session.expires < Date.now() || !user || user.disabled) {
    sessions.delete(id);
    saveSessions();
    return null;
  }
  return { id, user };
}

function deleteSession(id) {
  if (sessions.delete(id)) saveSessions();
}

function revokeUserSessions(userId, exceptId = null) {
  for (const [id, s] of sessions) {
    if (s.userId === userId && id !== exceptId) sessions.delete(id);
  }
  saveSessions();
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (s.expires < now || !findById(s.userId)) {
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) saveSessions();
}

pruneSessions();

module.exports = {
  AuthError,
  SESSION_TTL_MS,
  PASSWORD_MAX,
  publicUser,
  findById,
  findByName,
  listUsers,
  userCount,
  createUser,
  setPassword,
  updateUser,
  deleteUser,
  authenticate,
  verifyPassword,
  generatePassword,
  createSession,
  resolveSession,
  deleteSession,
  revokeUserSessions,
  pruneSessions,
  flush,
};
