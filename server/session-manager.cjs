'use strict';

// 每个浏览器会话（cookie UUID）= 一套独立的 workspace（sqlite + 文件）+ 一套 service 实例
// + 一张 handler 表。初始化时把 fake-electron 的"注册目标"指向本会话，再调用上游各
// registerXxxIpc，于是所有 ipcMain.handle 落到本会话的 handler 表 —— 实现完全隔离。
//
// 之所以必须隔离：technical_plan_meta 有 CHECK(id=1)，一个 workspace 只能存一个技术方案，
// 公开站不隔离会互相覆盖。

require('./electron-hook.cjs'); // 必须先装 require('electron') 重定向
const fakeElectron = require('./electron-hook.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionBroadcaster } = require('./broadcaster.cjs');
const { seedConfig } = require('./config-seed.cjs');

const CLIENT = path.resolve(__dirname, '..', 'client', 'electron');
// 上游 factory
const { createConfigStore } = require(path.join(CLIENT, 'services/configStore.cjs'));
const { createAiService } = require(path.join(CLIENT, 'services/aiService.cjs'));
const { createFileService } = require(path.join(CLIENT, 'services/fileService.cjs'));
const { createExportService } = require(path.join(CLIENT, 'services/exportService.cjs'));
const { createSystemFontService } = require(path.join(CLIENT, 'services/systemFontService.cjs'));
const { createSqliteDatabase } = require(path.join(CLIENT, 'services/sqliteDatabase.cjs'));
const { createKnowledgeBaseStore } = require(path.join(CLIENT, 'services/knowledgeBaseStore.cjs'));
const { createKnowledgeBaseService } = require(path.join(CLIENT, 'services/knowledgeBaseService.cjs'));
const { createTechnicalPlanStore } = require(path.join(CLIENT, 'services/technicalPlanStore.cjs'));
const { createDuplicateCheckStore } = require(path.join(CLIENT, 'services/duplicateCheckStore.cjs'));
const { createRejectionCheckStore } = require(path.join(CLIENT, 'services/rejectionCheckStore.cjs'));
const { createTemplateStore } = require(path.join(CLIENT, 'services/templateStore.cjs'));
const { createDuplicateCheckService } = require(path.join(CLIENT, 'services/duplicateCheckService.cjs'));
const { createTaskService } = require(path.join(CLIENT, 'services/taskService.cjs'));
// 上游 ipc 注册器
const { registerConfigIpc } = require(path.join(CLIENT, 'ipc/configIpc.cjs'));
const { registerAiIpc } = require(path.join(CLIENT, 'ipc/aiIpc.cjs'));
const { registerFileIpc } = require(path.join(CLIENT, 'ipc/fileIpc.cjs'));
const { registerExportIpc } = require(path.join(CLIENT, 'ipc/exportIpc.cjs'));
const { registerSystemFontIpc } = require(path.join(CLIENT, 'ipc/systemFontIpc.cjs'));
const { registerKnowledgeBaseIpc } = require(path.join(CLIENT, 'ipc/knowledgeBaseIpc.cjs'));
const { registerTechnicalPlanIpc } = require(path.join(CLIENT, 'ipc/technicalPlanIpc.cjs'));
const { registerDuplicateCheckIpc } = require(path.join(CLIENT, 'ipc/duplicateCheckIpc.cjs'));
const { registerRejectionCheckIpc } = require(path.join(CLIENT, 'ipc/rejectionCheckIpc.cjs'));
const { registerTemplateIpc } = require(path.join(CLIENT, 'ipc/templateIpc.cjs'));
const { registerTaskIpc } = require(path.join(CLIENT, 'ipc/taskIpc.cjs'));

const DATA_DIR = process.env.YIBIAO_DATA_DIR || path.join(__dirname, '..', 'data');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
const MAX_SESSIONS = Number(process.env.YIBIAO_MAX_SESSIONS || 60);
const IDLE_EVICT_MS = Number(process.env.YIBIAO_SESSION_IDLE_MS || 2 * 60 * 60 * 1000); // 2h

const sessions = new Map(); // id -> session

function makeSessionApp(workspaceRoot) {
  return {
    getPath(name) {
      const map = {
        userData: workspaceRoot,
        downloads: path.join(workspaceRoot, 'downloads'),
        documents: path.join(workspaceRoot, 'documents'),
        temp: os.tmpdir(),
        logs: path.join(workspaceRoot, 'logs'),
      };
      return map[name] || workspaceRoot;
    },
    getAppPath: () => path.resolve(__dirname, '..', 'client'),
    getVersion: () => process.env.YIBIAO_VERSION || '0.1.0-web',
    getName: () => 'yibiao',
    isPackaged: false,
    once() {},
    on() {},
    off() {},
    whenReady: () => Promise.resolve(),
    quit() {},
    exit() {},
    relaunch() {},
  };
}

function makeStubAgentService() {
  return {
    warmup: async () => {},
    runTask: async () => {
      throw new Error('AGENT_UNAVAILABLE: Web 版不支持本地智能体自主任务');
    },
    selfCheck: async () => ({ ok: false, message: 'Web 版不支持本地智能体' }),
    getStatus: () => ({ status: 'unavailable', running: false, message: 'Web 版未启用本地智能体' }),
    restart: () => {},
    markRestartPending: () => {},
    handleConfigChanged: () => {},
    onStatus: () => () => {},
    exportSelfCheckReport: async () => {
      throw new Error('Web 版不支持导出自检报告');
    },
    close: async () => {},
  };
}

function buildSession(sessionId) {
  const workspaceRoot = path.join(WORKSPACES_DIR, sessionId);
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const app = makeSessionApp(workspaceRoot);
  const broadcaster = createSessionBroadcaster();
  const session = {
    id: sessionId,
    app,
    broadcaster,
    webContents: broadcaster.webContents,
    handlers: new Map(),
    listeners: new Map(),
    services: {},
    lastActive: nowMs(),
  };

  fakeElectron.__setRegistrationTarget(session);
  try {
    const configStore = createConfigStore(app);
    seedConfig(configStore);

    const aiService = createAiService({ app, configStore });
    const fileService = createFileService({ app, configStore });
    const exportService = createExportService({ configStore });
    const systemFontService = createSystemFontService();

    registerConfigIpc({
      configStore,
      aiService,
      onDeveloperModeChange() {},
      onConfigChanged() {},
    });
    registerAiIpc({ aiService });
    registerFileIpc({ fileService });
    registerExportIpc({ exportService });
    registerSystemFontIpc({ systemFontService });

    // workspace 数据库层
    const sqliteDatabase = createSqliteDatabase(app, { onStatus() {} });
    const knowledgeBaseStore = createKnowledgeBaseStore({ app, db: sqliteDatabase.db });
    const knowledgeBaseService = createKnowledgeBaseService({ app, aiService, configStore, knowledgeBaseStore });
    const technicalPlanStore = createTechnicalPlanStore({ app, db: sqliteDatabase.db, fileService });
    const duplicateCheckStore = createDuplicateCheckStore({ app, db: sqliteDatabase.db });
    const rejectionCheckStore = createRejectionCheckStore({ app, db: sqliteDatabase.db, fileService, technicalPlanStore });
    const templateStore = createTemplateStore({ db: sqliteDatabase.db });
    const duplicateCheckService = createDuplicateCheckService({ app, configStore, workspaceStore: duplicateCheckStore });
    const agentService = makeStubAgentService();
    const taskService = createTaskService({
      aiService,
      agentService,
      technicalPlanStore,
      rejectionCheckStore,
      duplicateCheckStore,
      knowledgeBaseService,
      duplicateCheckService,
    });

    registerKnowledgeBaseIpc({ knowledgeBaseService });
    registerTechnicalPlanIpc({ technicalPlanStore });
    registerDuplicateCheckIpc({ duplicateCheckStore });
    registerRejectionCheckIpc({ rejectionCheckStore });
    registerTemplateIpc({ templateStore });
    registerTaskIpc({ taskService });

    session.services = {
      configStore,
      aiService,
      fileService,
      exportService,
      systemFontService,
      sqliteDatabase,
      technicalPlanStore,
      taskService,
    };
  } finally {
    fakeElectron.__setRegistrationTarget(null);
  }

  return session;
}

// 避免 Date.now 在某些受限环境不可用的顾虑；server 运行时正常可用
function nowMs() {
  return Date.now();
}

function evictIfNeeded() {
  if (sessions.size <= MAX_SESSIONS) return;
  const sorted = [...sessions.values()].sort((a, b) => a.lastActive - b.lastActive);
  while (sessions.size > MAX_SESSIONS && sorted.length) {
    const victim = sorted.shift();
    closeSession(victim.id);
  }
}

function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    const db = session.services.sqliteDatabase;
    if (db && typeof db.close === 'function') db.close();
    else if (db && db.db && typeof db.db.close === 'function') db.db.close();
  } catch {
    // ignore
  }
  sessions.delete(sessionId);
}

function getSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = buildSession(sessionId);
    sessions.set(sessionId, session);
    evictIfNeeded();
  }
  session.lastActive = nowMs();
  return session;
}

// 全局活跃任务总数（限流用）
function totalActiveTasks() {
  let total = 0;
  for (const session of sessions.values()) {
    try {
      const tasks = session.services.taskService?.getActiveTasks?.() || [];
      total += tasks.length;
    } catch {
      // ignore
    }
  }
  return total;
}

function startIdleSweeper() {
  setInterval(() => {
    const cutoff = nowMs() - IDLE_EVICT_MS;
    for (const [id, session] of sessions) {
      if (session.lastActive < cutoff && !session.broadcaster.hasClients()) {
        closeSession(id);
      }
    }
  }, 5 * 60 * 1000).unref();
}

module.exports = { getSession, closeSession, totalActiveTasks, startIdleSweeper, sessions, WORKSPACES_DIR, DATA_DIR };
