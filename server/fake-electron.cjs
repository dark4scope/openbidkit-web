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

// ---- BrowserWindow：puppeteer 无头 chromium 离屏渲染（阶段B，图表转图可用）。----
//      localImageRenderService 用 new BrowserWindow(同步) + await loadURL/executeJavaScript +
//      webContents.debugger.sendCommand(CDP) 截图。这里把这套 Electron 面映射到 puppeteer。
const { getBrowser } = require('./puppeteer-pool.cjs');

class FakeWebContents {
  constructor(viewport) {
    this._listeners = new Map();
    this._cdp = null;
    this._attached = false;
    const self = this;
    this.debugger = {
      isAttached: () => self._attached,
      attach: () => { self._attached = true; },
      detach: () => { self._attached = false; self._cdp = null; },
      sendCommand: async (method, params) => {
        const cdp = await self._ensureCdp();
        return cdp.send(method, params || {});
      },
    };
    // 同步启动 page 创建（constructor 必须同步返回）；后续方法内部 await 之。
    this._pagePromise = (async () => {
      const browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setViewport({
          width: Math.max(1, Math.round(viewport.width || 800)),
          height: Math.max(1, Math.round(viewport.height || 600)),
        });
      } catch { /* ignore */ }
      return page;
    })();
    this._pagePromise.catch(() => { /* 失败在 loadURL 时重新抛 */ });
  }

  async _ensureCdp() {
    const page = await this._pagePromise;
    if (!this._cdp) this._cdp = await page.target().createCDPSession();
    return this._cdp;
  }

  _add(event, cb, once) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add({ cb, once });
  }

  once(event, cb) { this._add(event, cb, true); return this; }

  on(event, cb) { this._add(event, cb, false); return this; }

  removeListener(event, cb) {
    const set = this._listeners.get(event);
    if (set) for (const l of [...set]) if (l.cb === cb) set.delete(l);
  }

  _emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const l of [...set]) { if (l.once) set.delete(l); try { l.cb(...args); } catch { /* ignore */ } }
  }

  // 上游传字符串代码（IIFE / 对象字面量），puppeteer page.evaluate(string) 按表达式求值并 returnByValue。
  async executeJavaScript(code) {
    const page = await this._pagePromise;
    return page.evaluate(code);
  }

  stop() {
    this._pagePromise.then((p) => p.evaluate('window.stop && window.stop()').catch(() => {})).catch(() => {});
  }
}

class BrowserWindow {
  constructor(opts = {}) {
    this._destroyed = false;
    this.webContents = new FakeWebContents({ width: opts.width, height: opts.height });
  }

  setMenuBarVisibility() { /* no-op */ }

  isDestroyed() { return this._destroyed; }

  async loadURL(url) {
    const wc = this.webContents;
    try {
      const page = await wc._pagePromise;
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      wc._emit('did-finish-load');
    } catch (err) {
      wc._emit('did-fail-load', {}, -1, (err && err.message) || String(err));
      throw err;
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.webContents._pagePromise.then((p) => p.close().catch(() => {})).catch(() => {});
  }

  close() { this.destroy(); }

  static getAllWindows() { return []; }

  static getFocusedWindow() { return null; }
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
