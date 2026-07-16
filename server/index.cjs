'use strict';

// Web 服务入口：静态托管 client/dist + 把上游 IPC 世界桥接成 HTTP/SSE。
require('./electron-hook.cjs'); // 必须最先装 require('electron') 重定向

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const als = require('./als.cjs');
const { getSession, totalActiveTasks, startIdleSweeper } = require('./session-manager.cjs');
const { maskConfig, unmaskConfig } = require('./config-seed.cjs');
const auth = require('./auth-store.cjs');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.resolve(__dirname, '..', 'client', 'dist');
const GLOBAL_MAX_TASKS = Number(process.env.YIBIAO_GLOBAL_MAX_TASKS || 3);
const PER_SESSION_MAX_TASKS = Number(process.env.YIBIAO_PER_SESSION_MAX_TASKS || 2);
const AUTH_COOKIE = 'yb_auth';
const AUTH_TTL_MS = Number(process.env.YIBIAO_AUTH_TTL_MS || 60 * 24 * 3600 * 1000);
const ALLOW_REGISTER = process.env.YIBIAO_ALLOW_REGISTER !== 'false';
const MAX_FETCH_BYTES = 50 * 1024 * 1024;

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '32mb' }));

// ---- 认证中间件：解析 yb_auth cookie -> 当前登录用户（不强制登录，静态资源/登录页可访问）----
app.use((req, _res, next) => {
  req.authToken = req.cookies[AUTH_COOKIE];
  req.authUser = auth.getUserByToken(req.authToken);
  next();
});

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: AUTH_TTL_MS });
}

// ---- 登录闸门：业务 API 必须登录；顺带按 userId 绑定该用户独立的 workspace（每人一套 sqlite+文件+知识库）----
function requireAuth(req, res, next) {
  if (!req.authUser) return res.status(401).json({ ok: false, error: '请先登录', code: 'AUTH_REQUIRED' });
  try {
    req.ybSession = getSession('u' + req.authUser.id);
  } catch (error) {
    console.error('[session] 初始化失败', error);
    return res.status(500).json({ ok: false, error: `会话初始化失败：${error.message || error}` });
  }
  next();
}

// ---- 账号路由（注册 / 登录 / 登出 / 当前用户）----
const loginThrottle = new Map(); // ip -> { fails, until }
function throttleKey(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff && String(xff).split(',')[0].trim()) || req.ip || 'unknown';
}
function isThrottled(req) {
  const rec = loginThrottle.get(throttleKey(req));
  return Boolean(rec && rec.until > Date.now() && rec.fails >= 10);
}
function noteFail(req) {
  const key = throttleKey(req);
  const rec = loginThrottle.get(key) || { fails: 0, until: 0 };
  rec.fails += 1;
  rec.until = Date.now() + 10 * 60 * 1000;
  loginThrottle.set(key, rec);
}
function clearFail(req) { loginThrottle.delete(throttleKey(req)); }

app.post('/api/auth/register', (req, res) => {
  if (!ALLOW_REGISTER) return res.status(403).json({ ok: false, error: '当前未开放注册' });
  const { username, password, display_name: displayName } = req.body || {};
  try {
    const user = auth.createUser(username, password, displayName);
    const token = auth.createAuthSession(user.id);
    setAuthCookie(res, token);
    res.json({ ok: true, user: { username: user.username, display_name: user.display_name } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/api/auth/login', (req, res) => {
  if (isThrottled(req)) return res.status(429).json({ ok: false, error: '登录尝试过多，请 10 分钟后再试' });
  const { username, password } = req.body || {};
  const user = auth.verifyUser(username, password);
  if (!user) { noteFail(req); return res.status(401).json({ ok: false, error: '用户名或密码错误' }); }
  clearFail(req);
  const token = auth.createAuthSession(user.id);
  setAuthCookie(res, token);
  res.json({ ok: true, user: { username: user.username, display_name: user.display_name } });
});

app.post('/api/auth/logout', (req, res) => {
  auth.deleteSession(req.authToken);
  res.clearCookie(AUTH_COOKIE);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.authUser) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', allowRegister: ALLOW_REGISTER });
  res.json({ ok: true, user: { username: req.authUser.username, display_name: req.authUser.display_name }, allowRegister: ALLOW_REGISTER });
});

// ---- app 级 stub handler（无会话状态 / Web 降级）----
const appHandlers = {
  'app:get-version': () => process.env.YIBIAO_VERSION || '0.1.0-web',
  'required-online-services:get-status': () => ({ ready: true, services: [] }),
  'workspace-database:get-status': () => ({ phase: 'ready', ready: true, message: '本地数据库已就绪' }),
  'app:get-gpu-hardware-acceleration-status': () => ({ configured: true, enabled: false, currentEnabled: false, trial: false, forcedDisabled: true }),
  'app:save-gpu-hardware-acceleration-preference': () => ({ success: true, enabled: false, configured: true, restartRequired: false }),
  'app:start-gpu-hardware-acceleration-trial': () => ({ success: false, message: 'Web 版无需硬件加速设置' }),
  'app:relaunch-with-gpu-hardware-acceleration-disabled': () => ({ success: false }),
  'app:open-external': () => ({ success: true }),
  'app:get-latest-version': () => ({ version: process.env.YIBIAO_VERSION || '0.1.0-web', hasUpdate: false }),
  'app:get-update-download-url': () => ({ url: '' }),
  'app:check-update': () => ({ success: false, message: 'Web 版无需更新' }),
  'app:start-update': () => ({ success: false, message: 'Web 版无需更新' }),
  'app:quit-and-install': () => ({ success: false }),
  'license:get-status': () => ({ status: 'community', activated: true, valid: true, plan: 'community', message: 'Web 公开版' }),
  'license:refresh': () => ({ status: 'community', activated: true, valid: true, plan: 'community', message: 'Web 公开版' }),
  'license:import-offline-file': () => ({ success: false, message: 'Web 版无需授权' }),
  'license:activate-offline-code': () => ({ success: false, message: 'Web 版无需授权' }),
  'agent:get-status': () => ({ status: 'unavailable', running: false, message: 'Web 版未启用本地智能体' }),
  'agent:run': () => { throw new Error('Web 版不支持本地智能体'); },
  'agent:self-check': () => ({ ok: false, message: 'Web 版未启用本地智能体' }),
  'agent:export-self-check-report': () => ({ success: false }),
  'agent:restart': () => ({ success: false }),
  'developer-token-stats:open-window': () => ({ success: false }),
  'developer-token-stats:get': () => ({ totals: {}, records: [] }),
  'developer-token-stats:reset': () => ({ success: true }),
  'developer-expansion-replace-test:run': () => { throw new Error('Web 版不支持该开发者测试'); },
  'export:open-file': () => ({ success: true }),
};

function resolveHandler(session, channel) {
  return session.handlers.get(channel) || appHandlers[channel] || null;
}

// ---- SSE：一条连接收本会话所有 webContents.send 事件 ----
app.get('/api/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: {}\n\n`);
  const { broadcaster } = req.ybSession;
  broadcaster.addClient(res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25000);
  ping.unref?.();
  req.on('close', () => {
    clearInterval(ping);
    broadcaster.removeClient(res);
  });
});

// ---- 通用 IPC 适配器 ----
app.post('/api/ipc/:channel', requireAuth, async (req, res) => {
  const session = req.ybSession;
  const channel = req.params.channel;
  const handler = resolveHandler(session, channel);
  if (!handler) {
    return res.json({ ok: false, error: `未实现的接口：${channel}` });
  }

  let args = Array.isArray(req.body?.args) ? req.body.args : [];

  // 入口：config:save 还原被掩码的 key
  if (channel === 'config:save' && args[0]) {
    args = [unmaskConfig(args[0], session.services.configStore.load())];
  }

  // 限流：AI 生成类任务
  if (channel.startsWith('tasks:start-')) {
    const limitError = checkTaskLimit(session);
    if (limitError) return res.json({ ok: false, error: limitError });
  }

  try {
    const fakeEvent = { sender: session.webContents };
    let result = await als.runWithContext({ session }, () => handler(fakeEvent, ...args));
    // 出口：config:load 掩码 key
    if (channel === 'config:load') result = maskConfig(result);
    res.json({ ok: true, result });
  } catch (error) {
    res.json({ ok: false, error: error?.message || String(error) });
  }
});

function checkTaskLimit(session) {
  if (totalActiveTasks() >= GLOBAL_MAX_TASKS) {
    return '服务器当前生成任务较多，请稍后再试（公开演示站并发有限）';
  }
  try {
    const mine = session.services.taskService?.getActiveTasks?.() || [];
    if (mine.length >= PER_SESSION_MAX_TASKS) {
      return '你已有正在进行的生成任务，请等待其完成后再开始新任务';
    }
  } catch { /* ignore */ }
  return null;
}

// ---- multipart 上传：把"弹本地文件框"的 channel 变成文件上传 ----
const uploadStorage = multer.diskStorage({
  destination(req, _file, cb) {
    if (!req._uploadBatch) req._uploadBatch = crypto.randomUUID();
    const dir = path.join(req.ybSession.app.getPath('userData'), 'uploads', req._uploadBatch);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    // 修复 multer 对非 ASCII 文件名的 latin1 误读，并保留原始扩展名（上游按扩展名选解析器）
    let original = file.originalname;
    try { original = Buffer.from(file.originalname, 'latin1').toString('utf8'); } catch { /* keep */ }
    const safe = original.replace(/[/\\\0]/g, '_').slice(-120) || 'upload';
    cb(null, safe);
  },
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: 50 * 1024 * 1024, files: 20 } });

app.post('/api/upload/:channel', requireAuth, upload.array('files'), async (req, res) => {
  const session = req.ybSession;
  const channel = req.params.channel;
  const handler = resolveHandler(session, channel);
  if (!handler) return res.json({ ok: false, error: `未实现的接口：${channel}` });

  const files = (req.files || []).map((f) => f.path);
  if (!files.length) return res.json({ ok: false, error: '未收到上传文件' });

  let args = [];
  if (req.body?.args) {
    try { args = JSON.parse(req.body.args); } catch { args = []; }
  }

  try {
    const fakeEvent = { sender: session.webContents };
    const result = await als.runWithContext({ session, dialogFiles: files }, () => handler(fakeEvent, ...args));
    res.json({ ok: true, result });
  } catch (error) {
    res.json({ ok: false, error: error?.message || String(error) });
  }
});

// ---- 下载链接导入：服务端拉取 URL -> 临时文件 -> 走和本地上传完全相同的解析链路 ----
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT / Tailscale
    return false;
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.');
}

async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('无效的链接'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https 链接');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('不允许访问内网地址');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('不允许访问内网/回环地址');
  if (!net.isIP(host)) {
    const records = await dns.lookup(host, { all: true });
    for (const { address } of records) {
      if (isPrivateIp(address)) throw new Error('不允许访问内网/回环地址');
    }
  }
  return u;
}

async function safeFetch(rawUrl, maxRedirects = 5) {
  let current = rawUrl;
  for (let i = 0; i <= maxRedirects; i += 1) {
    await assertPublicUrl(current); // 每一跳都校验，防重定向 SSRF
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let resp;
    try {
      resp = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YibiaoWeb/1.0)' },
      });
    } finally { clearTimeout(timer); }
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      current = new URL(resp.headers.get('location'), current).toString();
      continue;
    }
    return resp;
  }
  throw new Error('重定向次数过多');
}

function extFromContentType(ct) {
  const s = (ct || '').toLowerCase();
  if (s.includes('pdf')) return '.pdf';
  if (s.includes('wordprocessingml')) return '.docx';
  if (s.includes('msword')) return '.doc';
  if (s.includes('spreadsheetml') || s.includes('ms-excel')) return '.xlsx';
  if (s.includes('presentationml') || s.includes('ms-powerpoint')) return '.pptx';
  if (s.includes('html')) return '.html';
  if (s.includes('markdown')) return '.md';
  if (s.includes('text/plain')) return '.txt';
  return '.pdf';
}

function deriveFilename(rawUrl, contentDisposition, contentType) {
  let name = '';
  if (contentDisposition) {
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(contentDisposition);
    if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
  }
  if (!name) {
    try { name = decodeURIComponent(path.basename(new URL(rawUrl).pathname) || ''); } catch { name = ''; }
  }
  name = String(name).replace(/[/\\\0?%*:|"<>]/g, '_').slice(-120).trim();
  const knownExt = /\.(pdf|docx?|wps|txt|md|html?|xlsx?|pptx?)$/i;
  if (!knownExt.test(name)) name = (name || 'download') + extFromContentType(contentType);
  return name || 'download.pdf';
}

app.post('/api/fetch-url/:channel', requireAuth, async (req, res) => {
  const session = req.ybSession;
  const channel = req.params.channel;
  const handler = resolveHandler(session, channel);
  if (!handler) return res.json({ ok: false, error: `未实现的接口：${channel}` });

  const url = String(req.body?.url || '').trim();
  const args = Array.isArray(req.body?.args) ? req.body.args : [];
  if (!url) return res.json({ ok: false, error: '请提供下载链接' });

  try {
    const resp = await safeFetch(url);
    if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new Error('下载到的文件为空');
    if (buf.length > MAX_FETCH_BYTES) throw new Error('文件超过 50MB 限制');

    const filename = deriveFilename(url, resp.headers.get('content-disposition'), resp.headers.get('content-type'));
    const dir = path.join(session.app.getPath('userData'), 'uploads', crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    const fpath = path.join(dir, filename);
    fs.writeFileSync(fpath, buf);

    const fakeEvent = { sender: session.webContents };
    const result = await als.runWithContext({ session, dialogFiles: [fpath] }, () => handler(fakeEvent, ...args));
    res.json({ ok: true, result });
  } catch (error) {
    res.json({ ok: false, error: error?.message || String(error) });
  }
});

// ---- Word 导出：注入保存路径，完成后把 docx 作为附件下载 ----
app.post('/api/export/word', requireAuth, async (req, res) => {
  const session = req.ybSession;
  const handler = resolveHandler(session, 'export:word');
  if (!handler) return res.status(500).json({ ok: false, error: '导出接口不可用' });

  const payload = req.body?.payload || req.body || {};
  const exportDir = path.join(session.app.getPath('userData'), 'exports');
  fs.mkdirSync(exportDir, { recursive: true });
  const target = path.join(exportDir, `${crypto.randomUUID()}.docx`);
  const downloadName = `${sanitize(payload.project_name || '投标技术文件')}.docx`;

  try {
    const fakeEvent = { sender: session.webContents };
    const result = await als.runWithContext({ session, saveTarget: target }, () => handler(fakeEvent, payload));
    if (result && result.success && fs.existsSync(target)) {
      res.download(target, downloadName, (err) => {
        fs.rm(target, { force: true }, () => {});
        if (err && !res.headersSent) res.status(500).end();
      });
    } else {
      res.status(400).json({ ok: false, error: result?.message || '导出失败' });
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

function sanitize(name) {
  return String(name || '文档').replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 100) || '文档';
}

// ---- 健康检查 ----
app.get('/healthz', (req, res) => res.json({ ok: true, activeTasks: totalActiveTasks() }));

// ---- AGPL 合规：修改版源代码可获取 (§13) + NOTICE 保留 (§7b) ----
const SOURCE_URL = process.env.YIBIAO_SOURCE_URL || 'https://github.com/dark4scope/openbidkit-web';
app.get('/source', (_req, res) => res.redirect(302, SOURCE_URL));
app.get('/NOTICE', (_req, res) => {
  try {
    const notice = fs.readFileSync(path.resolve(__dirname, '..', 'NOTICE'), 'utf-8');
    res.type('text/plain; charset=utf-8').send(notice);
  } catch {
    res.type('text/plain; charset=utf-8').send('OpenBidKit_Yibiao (mark/yibiaoai) · AGPL-3.0\nSource: ' + SOURCE_URL);
  }
});

// ---- 静态前端 + SPA fallback ----
app.use(express.static(DIST_DIR));
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  const indexHtml = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
  next();
});

startIdleSweeper();
auth.purgeExpired();
setInterval(() => auth.purgeExpired(), 6 * 3600 * 1000).unref?.();
app.listen(PORT, HOST, () => {
  console.log(`[yibiao-web] listening on http://${HOST}:${PORT}  (dist: ${DIST_DIR})`);
});
