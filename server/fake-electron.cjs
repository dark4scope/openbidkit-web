'use strict';

// ============================================================================
// Fake Electron —— 让上游 client/electron 的主进程业务代码在裸 Node 里原样运行。
//
// 上游模块顶层都写 `const { ipcMain, dialog, ... } = require('electron')`。
// server/electron-hook.cjs 用 Module._resolveFilename 把 'electron' 重定向到本文件，
// 于是零改上游即可复用其 33k 行业务逻辑。
//
// 关键机制：
//  - ipcMain.handle/on 不做全局注册，而是写入"当前正在初始化的 session"(REGISTRATION_TARGET)，
//    从而实现多会话隔离（每个浏览器会话一套独立的 handler + service 实例）。
//  - dialog.showOpenDialog/showSaveDialog 读 AsyncLocalStorage 里上传端点注入的文件路径，
//    使 6 个"弹本地文件框"的 channel 无需改上游即可走 multipart 上传。
//  - nativeImage 用纯 JS PNG shim；BrowserWindow 在阶段A降级（图表转图不可用但不阻断主线）。
// ============================================================================

const als = require('./als.cjs');
const nativeImage = require('./native-image-shim.cjs');

// ---- 当前注册目标（session-manager 在同步初始化 session 时设置）----
let REGISTRATION_TARGET = null;
function setRegistrationTarget(target) {
  REGISTRATION_TARGET = target;
}

// ---- ipcMain：把注册路由到当前 session ----
const ipcMain = {
  handle(channel, listener) {
    if (!REGISTRATION_TARGET) {
      // app 级 handler（在无 session 上下文时注册）落到全局表
      globalHandlers.set(channel, listener);
      return;
    }
    REGISTRATION_TARGET.handlers.set(channel, listener);
  },
  removeHandler(channel) {
    if (REGISTRATION_TARGET) REGISTRATION_TARGET.handlers.delete(channel);
    else globalHandlers.delete(channel);
  },
  on(channel, listener) {
    const target = REGISTRATION_TARGET;
    if (!target) {
      if (!globalListeners.has(channel)) globalListeners.set(channel, []);
      globalListeners.get(channel).push(listener);
      return;
    }
    if (!target.listeners.has(channel)) target.listeners.set(channel, []);
    target.listeners.get(channel).push(listener);
  },
  removeAllListeners(channel) {
    if (REGISTRATION_TARGET) REGISTRATION_TARGET.listeners.delete(channel);
    else globalListeners.delete(channel);
  },
};

// app 级（无 session）handler / listener 表
const globalHandlers = new Map();
const globalListeners = new Map();

// ---- dialog：从 ALS 读上传端点注入的文件；无注入则视为"用户取消" ----
const dialog = {
  async showOpenDialog(/* options */) {
    const ctx = als.getContext();
    const files = ctx && Array.isArray(ctx.dialogFiles) ? ctx.dialogFiles : null;
    if (!files || files.length === 0) {
      return { canceled: true, filePaths: [] };
    }
    return { canceled: false, filePaths: files.slice() };
  },
  async showSaveDialog(/* options */) {
    const ctx = als.getContext();
    const target = ctx && ctx.saveTarget ? ctx.saveTarget : null;
    if (!target) return { canceled: true, filePath: undefined };
    return { canceled: false, filePath: target };
  },
  showMessageBox: async () => ({ response: 0 }),
  showErrorBox: () => {},
};

// ---- shell：web 版无本地外壳，安全降级 ----
const shell = {
  openExternal: async () => {},
  openPath: async () => '', // 返回空字符串表示成功（上游据此判断）
  showItemInFolder: () => {},
  trashItem: async () => {},
  beep: () => {},
};

// ---- BrowserWindow：阶段A降级。localImageRenderService 用它做离屏图表渲染，
//      new 时抛错 -> 上游 renderMermaid/Html 抛 -> 配图/导出侧已有容错（保留正文/跳过图）。
//      阶段B将用 puppeteer 提供可用实现。
class BrowserWindow {
  constructor() {
    throw new Error('WEB_NO_BROWSER_WINDOW: 图表离屏渲染在 Web 版暂不可用');
  }
  static getAllWindows() {
    return [];
  }
  static getFocusedWindow() {
    return null;
  }
}

// ---- app：全局单例（供直接 require('electron').app 的少数模块用，如 localImageRenderService 兜底、
//      aiHttpError）。各 service 实际用的是 session-manager 注入的 per-session app。----
const path = require('node:path');
const CLIENT_ROOT = path.resolve(__dirname, '..', 'client');

const app = {
  getPath(name) {
    // 全局兜底路径（正常不会走到 —— per-session app 会覆盖）
    const base = process.env.YIBIAO_DATA_DIR || path.join(__dirname, '..', 'data', '_global');
    const map = {
      userData: base,
      downloads: path.join(base, 'downloads'),
      documents: path.join(base, 'documents'),
      temp: require('node:os').tmpdir(),
      logs: path.join(base, 'logs'),
    };
    return map[name] || base;
  },
  getAppPath() {
    return CLIENT_ROOT;
  },
  getVersion() {
    return process.env.YIBIAO_VERSION || '0.1.0-web';
  },
  getName() {
    return 'yibiao';
  },
  get isPackaged() {
    return false;
  },
  once() {},
  on() {},
  off() {},
  whenReady() {
    return Promise.resolve();
  },
  quit() {},
  exit() {},
  relaunch() {},
  disableHardwareAcceleration() {},
  setPath() {},
  requestSingleInstanceLock() {
    return true;
  },
  commandLine: { appendSwitch() {}, appendArgument() {} },
};

// ---- nativeTheme / Menu / protocol / session：极少数被顶层解构，给 noop 兜底 ----
const nativeTheme = { shouldUseDarkColors: false, on() {}, removeAllListeners() {}, themeSource: 'system' };
const Menu = { setApplicationMenu() {}, buildFromTemplate: () => ({}), getApplicationMenu: () => null };
const protocol = { registerSchemesAsPrivileged() {}, handle() {}, registerFileProtocol() {} };
const nativeImageExport = {
  createFromBuffer: nativeImage.createFromBuffer,
  createFromBitmap: nativeImage.createFromBitmap,
  createEmpty: nativeImage.createEmpty,
  createFromPath: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty(),
};

// preload 才用（server 不 require preload），给桩以防被间接引用
const contextBridge = { exposeInMainWorld() {} };
const ipcRenderer = { invoke: async () => undefined, on() {}, send() {}, removeListener() {} };

module.exports = {
  app,
  ipcMain,
  ipcRenderer,
  contextBridge,
  dialog,
  shell,
  BrowserWindow,
  nativeImage: nativeImageExport,
  nativeTheme,
  Menu,
  protocol,
  session: {},
  // server 内部用：
  __setRegistrationTarget: setRegistrationTarget,
  __globalHandlers: globalHandlers,
  __globalListeners: globalListeners,
};
