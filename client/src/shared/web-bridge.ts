// Web 版的 window.yibiao 桥：与 Electron preload 暴露的 YibiaoBridge 形状完全一致，
// 但底层从 IPC 换成 HTTP(POST /api/ipc/:channel) + SSE(/api/events) + multipart 上传。
// 前端业务代码零改动即可从桌面版切到 Web 版。
/* eslint-disable @typescript-eslint/no-explicit-any */

const API = '';

async function ipc<T = any>(channel: string, ...args: any[]): Promise<T> {
  const res = await fetch(`${API}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
    credentials: 'same-origin',
  });
  if (res.status === 401) { handleAuthLost(); throw new Error('登录已失效，请重新登录'); }
  if (!res.ok) throw new Error(`请求失败 (${res.status})`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '请求失败');
  return data.result as T;
}

// ---- SSE 事件分发 ----
type Listener = (payload: any) => void;
const listeners = new Map<string, Set<Listener>>();
let eventSource: EventSource | null = null;

const EVENT_CHANNELS = [
  'tasks:event',
  'export:word-progress',
  'ai:http-error',
  'knowledge-base:event',
  'workspace-database:status',
  'agent:status',
  'developer-token-stats:changed',
  'app:update-progress',
  'app:update-downloaded',
  'app:update-error',
];

function ensureEventSource() {
  if (eventSource) return;
  eventSource = new EventSource(`${API}/api/events`, { withCredentials: true });
  for (const channel of EVENT_CHANNELS) {
    eventSource.addEventListener(channel, (evt: MessageEvent) => {
      let payload: any;
      try {
        payload = JSON.parse(evt.data)?.payload;
      } catch {
        payload = undefined;
      }
      const set = listeners.get(channel);
      if (set) set.forEach((cb) => { try { cb(payload); } catch { /* ignore */ } });
    });
  }
  eventSource.onerror = () => { /* 浏览器会自动重连 */ };
}

function subscribe(channel: string, cb: Listener): () => void {
  ensureEventSource();
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel)!.add(cb);
  return () => { listeners.get(channel)?.delete(cb); };
}

// ---- 会话失效：任何业务请求返回 401 时回到登录页 ----
let authLostHandled = false;
function handleAuthLost() {
  if (authLostHandled) return;
  authLostHandled = true;
  try { window.location.reload(); } catch { /* ignore */ }
}

// ---- 导入对话框：本地文件 或 粘贴下载链接（URL 由服务端拉取，走同一解析链路）----
let importStyleInjected = false;
function injectImportStyle() {
  if (importStyleInjected) return;
  importStyleInjected = true;
  const css = `
  .yb-imp-mask{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(15,18,26,.5);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .yb-imp-card{width:min(440px,92vw);background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.28);padding:22px;color:#1f2430;animation:yb-imp-in .16s ease}
  @keyframes yb-imp-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
  .yb-imp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
  .yb-imp-title{font-size:16px;font-weight:600}
  .yb-imp-x{border:none;background:transparent;font-size:20px;line-height:1;color:#9aa0ad;cursor:pointer;padding:2px 6px;border-radius:8px}
  .yb-imp-x:hover{background:#f1f2f5;color:#3a3f4b}
  .yb-imp-drop{border:1.5px dashed #cfd3dd;border-radius:12px;padding:20px;text-align:center;cursor:pointer;transition:.15s;background:#fafbfc}
  .yb-imp-drop:hover{border-color:#5b74e6;background:#f5f7ff}
  .yb-imp-drop b{display:block;font-size:14px;color:#2b3140;margin-bottom:3px}
  .yb-imp-drop small{color:#98a0ae;font-size:12px}
  .yb-imp-or{display:flex;align-items:center;gap:10px;color:#b3b8c4;font-size:12px;margin:14px 0}
  .yb-imp-or::before,.yb-imp-or::after{content:"";flex:1;height:1px;background:#e8eaef}
  .yb-imp-urlrow{display:flex;gap:8px}
  .yb-imp-url{flex:1;height:38px;border:1px solid #d7dae2;border-radius:9px;padding:0 12px;font-size:13px;outline:none;color:#1f2430;background:#fff}
  .yb-imp-url:focus{border-color:#5b74e6;box-shadow:0 0 0 3px rgba(91,116,230,.15)}
  .yb-imp-go{height:38px;padding:0 15px;border:none;border-radius:9px;background:#5b74e6;color:#fff;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
  .yb-imp-go:hover{background:#4a63d8}
  .yb-imp-go:disabled{opacity:.55;cursor:default}
  .yb-imp-err{color:#e5484d;font-size:12px;margin-top:10px}
  .yb-imp-busy{text-align:center;padding:26px 0;color:#6b7280;font-size:13px}
  .yb-imp-spin{width:26px;height:26px;border:3px solid #e5e8ef;border-top-color:#5b74e6;border-radius:50%;margin:0 auto 12px;animation:yb-imp-spin .8s linear infinite}
  @keyframes yb-imp-spin{to{transform:rotate(360deg)}}
  @media (prefers-color-scheme:dark){.yb-imp-card{background:#20242e;color:#e6e8ee}.yb-imp-drop{background:#262b36;border-color:#3a4150}.yb-imp-drop b{color:#e6e8ee}.yb-imp-url{background:#262b36;border-color:#3a4150;color:#e6e8ee}.yb-imp-x:hover{background:#2c313c}}
  `;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}

// 显示导入模态，处理文件上传 / URL 拉取的完整网络流程，resolve 服务端 handler 结果；取消 -> {success:false}
async function uploadDialog(channel: string, opts: { multiple?: boolean; accept?: string } = {}, args: any[] = []): Promise<any> {
  injectImportStyle();
  const multiple = opts.multiple !== false;
  const accept = opts.accept || '';

  return new Promise<any>((resolve, reject) => {
    const mask = document.createElement('div');
    mask.className = 'yb-imp-mask';
    mask.innerHTML = `
      <div class="yb-imp-card" role="dialog" aria-modal="true">
        <div class="yb-imp-head">
          <span class="yb-imp-title">导入文件</span>
          <button type="button" class="yb-imp-x" aria-label="关闭">&times;</button>
        </div>
        <div class="yb-imp-body">
          <div class="yb-imp-drop" tabindex="0">
            <b>📁 选择本地文件</b>
            <small>${multiple ? '支持一次选择多个文件' : '选择单个文件'}</small>
          </div>
          <div class="yb-imp-or">或</div>
          <div class="yb-imp-urlrow">
            <input class="yb-imp-url" type="url" inputmode="url" placeholder="粘贴文件下载链接（http/https）" />
            <button type="button" class="yb-imp-go">从链接导入</button>
          </div>
          <div class="yb-imp-err" style="display:none"></div>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const card = mask.querySelector('.yb-imp-card') as HTMLElement;
    const body = mask.querySelector('.yb-imp-body') as HTMLElement;
    const errBox = mask.querySelector('.yb-imp-err') as HTMLElement;
    const drop = mask.querySelector('.yb-imp-drop') as HTMLElement;
    const urlInput = mask.querySelector('.yb-imp-url') as HTMLInputElement;
    const goBtn = mask.querySelector('.yb-imp-go') as HTMLButtonElement;
    const closeBtn = mask.querySelector('.yb-imp-x') as HTMLButtonElement;

    let done = false;
    const cleanup = () => { mask.remove(); window.removeEventListener('keydown', onKey); };
    const cancel = () => { if (done) return; done = true; cleanup(); resolve({ success: false, message: '已取消' }); };
    const fail = (msg: string) => { if (done) return; done = true; cleanup(); reject(new Error(msg)); };
    const succeed = (result: any) => { if (done) return; done = true; cleanup(); resolve(result); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) cancel(); });
    closeBtn.addEventListener('click', cancel);

    const showError = (msg: string) => { errBox.textContent = msg; errBox.style.display = 'block'; };
    const showBusy = (text: string) => { body.innerHTML = `<div class="yb-imp-busy"><div class="yb-imp-spin"></div>${text}</div>`; };

    // 本地文件
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = multiple;
    if (accept) fileInput.accept = accept;
    fileInput.style.display = 'none';
    card.appendChild(fileInput);
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') fileInput.click(); });
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;
      showBusy('正在上传并解析…');
      try {
        const fd = new FormData();
        for (const f of files) fd.append('files', f, f.name);
        if (args.length) fd.append('args', JSON.stringify(args));
        const res = await fetch(`${API}/api/upload/${channel}`, { method: 'POST', body: fd, credentials: 'same-origin' });
        if (res.status === 401) { handleAuthLost(); return fail('登录已失效，请重新登录'); }
        const data = await res.json();
        if (!data.ok) return fail(data.error || '上传失败');
        succeed(data.result);
      } catch (e: any) { fail(e?.message || '上传失败'); }
    });

    // 下载链接
    const doUrl = async () => {
      const url = urlInput.value.trim();
      if (!/^https?:\/\/.+/i.test(url)) { showError('请输入有效的 http/https 链接'); return; }
      goBtn.disabled = true;
      showBusy('正在从链接下载并解析…');
      try {
        const res = await fetch(`${API}/api/fetch-url/${channel}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, args }),
          credentials: 'same-origin',
        });
        if (res.status === 401) { handleAuthLost(); return fail('登录已失效，请重新登录'); }
        const data = await res.json();
        if (!data.ok) return fail(data.error || '导入失败');
        succeed(data.result);
      } catch (e: any) { fail(e?.message || '导入失败'); }
    };
    goBtn.addEventListener('click', doUrl);
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUrl(); });
    setTimeout(() => urlInput.focus(), 30);
  });
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 招标 / 投标 / 方案文档可选的扩展名（宽松；服务端按扩展名选解析器）
const DOC_ACCEPT = '.pdf,.doc,.docx,.wps,.txt,.md,.html,.htm,.xls,.xlsx,.ppt,.pptx';

const bridge = {
  appName: '投标工具箱',
  platform: 'web',
  getVersion: () => ipc('app:get-version'),
  getGpuHardwareAccelerationStatus: () => ipc('app:get-gpu-hardware-acceleration-status'),
  saveGpuHardwareAccelerationPreference: (enabled: boolean) => ipc('app:save-gpu-hardware-acceleration-preference', enabled),
  startGpuHardwareAccelerationTrial: () => ipc('app:start-gpu-hardware-acceleration-trial'),
  relaunchWithGpuHardwareAccelerationDisabled: () => ipc('app:relaunch-with-gpu-hardware-acceleration-disabled'),
  requiredOnlineServices: {
    getStatus: () => ipc('required-online-services:get-status'),
  },
  getLatestVersion: () => ipc('app:get-latest-version'),
  getUpdateDownloadUrl: () => ipc('app:get-update-download-url'),
  openExternal: async (url: string) => {
    try { window.open(url, '_blank', 'noopener,noreferrer'); return { success: true }; }
    catch { return { success: false, message: '无法打开链接' }; }
  },
  checkUpdate: () => ipc('app:check-update'),
  startUpdate: () => ipc('app:start-update'),
  quitAndInstall: () => ipc('app:quit-and-install'),
  onUpdateProgress: (cb: Listener) => subscribe('app:update-progress', cb),
  onUpdateDownloaded: (cb: Listener) => subscribe('app:update-downloaded', cb),
  onUpdateError: (cb: Listener) => subscribe('app:update-error', cb),
  database: {
    getStatus: () => ipc('workspace-database:get-status'),
    onStatus: (cb: Listener) => subscribe('workspace-database:status', cb),
  },
  config: {
    load: () => ipc('config:load'),
    save: (config: any) => ipc('config:save', config),
    listModels: (config: any) => ipc('config:list-models', config),
    openConfigFolder: () => ipc('config:open-config-folder'),
  },
  license: {
    getStatus: () => ipc('license:get-status'),
    refresh: () => ipc('license:refresh'),
    importOfflineFile: () => ipc('license:import-offline-file'),
    activateOfflineCode: (code: string) => ipc('license:activate-offline-code', code),
  },
  ai: {
    chat: (request: any) => ipc('ai:chat', request),
    requestJson: (request: any) => ipc('ai:request-json', request),
    testImageModel: (config: any) => ipc('ai:test-image-model', config),
    onHttpError: (cb: Listener) => subscribe('ai:http-error', cb),
  },
  agent: {
    run: (payload: any) => ipc('agent:run', payload),
    selfCheck: () => ipc('agent:self-check'),
    exportSelfCheckReport: (payload: any) => ipc('agent:export-self-check-report', payload),
    getStatus: () => ipc('agent:get-status'),
    restart: (reason: any) => ipc('agent:restart', reason),
    onStatus: (cb: Listener) => subscribe('agent:status', cb),
  },
  developerTokenStats: {
    openWindow: () => ipc('developer-token-stats:open-window'),
    get: () => ipc('developer-token-stats:get'),
    reset: () => ipc('developer-token-stats:reset'),
    onChanged: (cb: Listener) => subscribe('developer-token-stats:changed', cb),
  },
  developerExpansionReplaceTest: {
    run: (payload: any) => ipc('developer-expansion-replace-test:run', payload),
  },
  file: {
    selectDuplicateCheckFiles: (options: any) => uploadDialog('file:select-duplicate-check-files', { multiple: options?.multiple !== false, accept: DOC_ACCEPT }),
  },
  knowledgeBase: {
    getMigrationStatus: () => ipc('knowledge-base:get-migration-status'),
    migrateLegacy: () => ipc('knowledge-base:migrate-legacy'),
    list: () => ipc('knowledge-base:list'),
    createFolder: (name: string) => ipc('knowledge-base:create-folder', name),
    renameFolder: (folderId: string, name: string) => ipc('knowledge-base:rename-folder', folderId, name),
    reorderFolder: (a: string, b: string, p: any) => ipc('knowledge-base:reorder-folder', a, b, p),
    deleteFolder: (folderId: string) => ipc('knowledge-base:delete-folder', folderId),
    deleteDocument: (documentId: string) => ipc('knowledge-base:delete-document', documentId),
    moveDocument: (documentId: string, t: string, td: string, p: any) => ipc('knowledge-base:move-document', documentId, t, td, p),
    uploadDocuments: (folderId: string) => uploadDialog('knowledge-base:upload-documents', { multiple: true, accept: DOC_ACCEPT }, [folderId]),
    retryDocument: (documentId: string) => ipc('knowledge-base:retry-document', documentId),
    startMatching: (documentId: string, batchSize: any) => ipc('knowledge-base:start-matching', documentId, batchSize),
    readMarkdown: (documentId: string) => ipc('knowledge-base:read-markdown', documentId),
    readItems: (documentId: string) => ipc('knowledge-base:read-items', documentId),
    readAnalysis: (documentId: string) => ipc('knowledge-base:read-analysis', documentId),
    onEvent: (cb: Listener) => subscribe('knowledge-base:event', cb),
  },
  technicalPlan: {
    loadState: () => ipc('technical-plan:load-state'),
    importTenderDocument: () => uploadDialog('technical-plan:import-tender-document', { multiple: true, accept: DOC_ACCEPT }),
    importOriginalPlanDocument: () => uploadDialog('technical-plan:import-original-plan-document', { multiple: false, accept: DOC_ACCEPT }),
    checkBidSections: () => ipc('technical-plan:check-bid-sections'),
    selectBidSection: (s: any) => ipc('technical-plan:select-bid-section', s),
    readTenderMarkdown: () => ipc('technical-plan:read-tender-markdown'),
    readTenderSourceMarkdown: (sourceId: any) => ipc('technical-plan:read-tender-source-markdown', sourceId),
    readOriginalPlanMarkdown: () => ipc('technical-plan:read-original-plan-markdown'),
    updateStep: (step: any) => ipc('technical-plan:update-step', step),
    setWorkflowKind: (k: any) => ipc('technical-plan:set-workflow-kind', k),
    switchWorkflowKind: (k: any) => ipc('technical-plan:switch-workflow-kind', k),
    saveBidAnalysisConfig: (p: any) => ipc('technical-plan:save-bid-analysis-config', p),
    saveOutlineConfig: (p: any) => ipc('technical-plan:save-outline-config', p),
    saveOutline: (d: any) => ipc('technical-plan:save-outline', d),
    saveGlobalFacts: (g: any) => ipc('technical-plan:save-global-facts', g),
    saveContentGenerationOptions: (o: any) => ipc('technical-plan:save-content-generation-options', o),
    saveChapterContent: (p: any) => ipc('technical-plan:save-chapter-content', p),
    clear: () => ipc('technical-plan:clear'),
  },
  duplicateCheck: {
    loadState: () => ipc('duplicate-check:load-state'),
    saveFiles: (p: any) => ipc('duplicate-check:save-files', p),
    saveUiState: (p: any) => ipc('duplicate-check:save-ui-state', p),
    updateState: (p: any) => ipc('duplicate-check:update-state', p),
    clear: () => ipc('duplicate-check:clear'),
  },
  rejectionCheck: {
    loadState: () => ipc('rejection-check:load-state'),
    importDocument: (role: any) => uploadDialog('rejection-check:import-document', { multiple: true, accept: DOC_ACCEPT }, [role]),
    importTenderFromTechnicalPlan: () => ipc('rejection-check:import-tender-from-technical-plan'),
    removeDocument: (role: any, documentId: any) => ipc('rejection-check:remove-document', role, documentId),
    saveUiState: (p: any) => ipc('rejection-check:save-ui-state', p),
    updateState: (p: any) => ipc('rejection-check:update-state', p),
    clear: () => ipc('rejection-check:clear'),
  },
  templates: {
    list: () => ipc('templates:list'),
    get: (id: any) => ipc('templates:get', id),
    create: (c: any) => ipc('templates:create', c),
    update: (id: any, c: any) => ipc('templates:update', id, c),
    delete: (id: any) => ipc('templates:delete', id),
  },
  tasks: {
    startBidSectionExtraction: (p: any) => ipc('tasks:start-bid-section-extraction', p),
    startBidAnalysis: (p: any) => ipc('tasks:start-bid-analysis', p),
    startOutlineGeneration: (p: any) => ipc('tasks:start-outline-generation', p),
    startGlobalFactsGeneration: (p: any) => ipc('tasks:start-global-facts-generation', p),
    startContentGeneration: (p: any) => ipc('tasks:start-content-generation', p),
    pauseContentGeneration: () => ipc('tasks:pause-content-generation'),
    startRejectionItemsExtraction: (p: any) => ipc('tasks:start-rejection-items-extraction', p),
    startRejectionCheck: (p: any) => ipc('tasks:start-rejection-check', p),
    startDuplicateAnalysis: (p: any) => ipc('tasks:start-duplicate-analysis', p),
    getActiveTasks: () => ipc('tasks:get-active'),
    onTaskEvent: (cb: Listener) => subscribe('tasks:event', cb),
  },
  export: {
    exportWord: async (payload: any) => {
      const res = await fetch(`${API}/api/export/word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        let msg = '导出失败';
        try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const name = `${(payload?.project_name || '投标技术文件')}.docx`;
      triggerDownload(blob, name);
      return { success: true, path: name, message: 'Word 已导出，请在下载中查看。', warnings: [] };
    },
    openFile: (filePath: string) => ipc('export:open-file', filePath),
    onWordExportProgress: (cb: Listener) => subscribe('export:word-progress', cb),
  },
  systemFonts: {
    list: () => ipc('system-fonts:list'),
  },
};

(window as any).yibiao = bridge;
(window as any).yibiaoClient = { appName: bridge.appName, platform: bridge.platform };

export default bridge;
