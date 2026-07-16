'use strict';

// Web 服务入口：静态托管 client/dist + 把上游 IPC 世界桥接成 HTTP/SSE。
require('./electron-hook.cjs'); // 必须最先装 require('electron') 重定向

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const als = require('./als.cjs');
const { getSession, totalActiveTasks, startIdleSweeper } = require('./session-manager.cjs');
const { maskConfig, unmaskConfig } = require('./config-seed.cjs');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.resolve(__dirname, '..', 'client', 'dist');
const GLOBAL_MAX_TASKS = Number(process.env.YIBIAO_GLOBAL_MAX_TASKS || 3);
const PER_SESSION_MAX_TASKS = Number(process.env.YIBIAO_PER_SESSION_MAX_TASKS || 2);
const COOKIE = 'yb_sid';

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '32mb' }));

// ---- 会话中间件：cookie UUID -> session ----
app.use((req, res, next) => {
  let sid = req.cookies[COOKIE];
  if (!sid || !/^[a-zA-Z0-9_-]{8,64}$/.test(sid)) {
    sid = crypto.randomUUID();
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000 });
  }
  try {
    req.ybSession = getSession(sid);
  } catch (error) {
    console.error('[session] 初始化失败', error);
    return res.status(500).json({ ok: false, error: `会话初始化失败：${error.message || error}` });
  }
  next();
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
app.get('/api/events', (req, res) => {
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
app.post('/api/ipc/:channel', async (req, res) => {
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

app.post('/api/upload/:channel', upload.array('files'), async (req, res) => {
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

// ---- Word 导出：注入保存路径，完成后把 docx 作为附件下载 ----
app.post('/api/export/word', async (req, res) => {
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
app.listen(PORT, HOST, () => {
  console.log(`[yibiao-web] listening on http://${HOST}:${PORT}  (dist: ${DIST_DIR})`);
});
