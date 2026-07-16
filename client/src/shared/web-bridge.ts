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

// ---- 文件选择 + multipart 上传（替代本地文件对话框）----
function pickFiles({ multiple = true, accept = '' }: { multiple?: boolean; accept?: string }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files || [])));
    input.addEventListener('cancel', () => done([]));
    // 兜底：窗口重新聚焦后若未选择文件，判定为取消
    const onFocus = () => setTimeout(() => { if (!settled && (!input.files || input.files.length === 0)) done([]); }, 500);
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

async function uploadDialog(channel: string, opts: { multiple?: boolean; accept?: string } = {}, args: any[] = []): Promise<any> {
  const files = await pickFiles({ multiple: opts.multiple !== false, accept: opts.accept || '' });
  if (!files.length) return { success: false, message: '已取消选择' };
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  if (args.length) fd.append('args', JSON.stringify(args));
  const res = await fetch(`${API}/api/upload/${channel}`, { method: 'POST', body: fd, credentials: 'same-origin' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '上传失败');
  return data.result;
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
  appName: '易标投标工具箱',
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
