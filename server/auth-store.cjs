'use strict';

// 账号系统：全局共享的 auth.db（better-sqlite3），users + auth_sessions 两表。
// - 密码用 scrypt（Node 内置，无外部依赖），存 salt + hash。
// - 会话 token 是 32 字节随机 hex，服务端存储 + 过期；cookie 只带 token，不带任何身份明文。
// - better-sqlite3 从上游 client/node_modules 解析（容器里已按 node ABI 重编）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const Database = require(require.resolve('better-sqlite3', {
  paths: [
    path.join(__dirname, '..', 'client', 'node_modules'),
    path.join(__dirname, '..', 'client', 'electron'),
    __dirname,
  ],
}));

const { DATA_DIR } = require('./session-manager.cjs');

const AUTH_DB = path.join(DATA_DIR, 'auth.db');
const SESSION_TTL_MS = Number(process.env.YIBIAO_AUTH_TTL_MS || 60 * 24 * 3600 * 1000); // 60 天

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(AUTH_DB);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    username_lower TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_uid ON auth_sessions(user_id);
`);

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

const USERNAME_RE = /^[a-zA-Z0-9_.一-龥-]{2,32}$/;

function createUser(username, password, displayName) {
  const uname = String(username || '').trim();
  if (!USERNAME_RE.test(uname)) throw new Error('用户名需为 2-32 位（字母/数字/中文/下划线/点/横线）');
  if (String(password || '').length < 6) throw new Error('密码至少 6 位');
  const lower = uname.toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE username_lower = ?').get(lower)) {
    throw new Error('用户名已被占用');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO users (username, username_lower, pass_hash, pass_salt, display_name, created_at) VALUES (?,?,?,?,?,?)'
  ).run(uname, lower, hash, salt, (displayName || uname).slice(0, 32), now);
  return { id: Number(info.lastInsertRowid), username: uname, display_name: (displayName || uname).slice(0, 32) };
}

function verifyUser(username, password) {
  const lower = String(username || '').trim().toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE username_lower = ?').get(lower);
  if (!row) return null;
  const hash = hashPassword(password, row.pass_salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(row.pass_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: row.id, username: row.username, display_name: row.display_name };
}

function createAuthSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

function getUserByToken(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db.prepare(`
    SELECT u.id AS id, u.username AS username, u.display_name AS display_name, s.expires_at AS expires_at
    FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name };
}

function deleteSession(token) {
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  }
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function purgeExpired() {
  try { db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now()); } catch { /* ignore */ }
}

module.exports = { createUser, verifyUser, createAuthSession, getUserByToken, deleteSession, userCount, purgeExpired };
