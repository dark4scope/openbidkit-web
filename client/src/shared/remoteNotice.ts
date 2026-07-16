const PROJECT_NAME = 'yibiao-client';
const DISMISSED_NOTICE_ID_KEY = 'remote_notice_dismissed_id';
const LOG_PREFIX = '[remote-notice]';

export interface RemoteNotice {
  id: string;
  projectName: string;
  enabled: boolean;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface RemoteNoticeResponse {
  code?: number;
  notice?: RemoteNotice | null;
}

function readDismissedNoticeId() {
  try {
    return localStorage.getItem(DISMISSED_NOTICE_ID_KEY) || '';
  } catch {
    return '';
  }
}

export function hasDismissedRemoteNotice(noticeId: string) {
  return Boolean(noticeId) && readDismissedNoticeId() === noticeId;
}

export function dismissRemoteNotice(noticeId: string) {
  if (!noticeId) return;

  try {
    localStorage.setItem(DISMISSED_NOTICE_ID_KEY, noticeId);
  } catch {
    // 公告关闭记录失败不影响主流程；下次轮询可能再次显示同一公告。
  }
}

function normalizeNotice(notice: RemoteNotice | null | undefined): RemoteNotice | null {
  if (!notice?.id || !notice.content || notice.enabled === false) {
    return null;
  }

  return {
    id: String(notice.id),
    projectName: String(notice.projectName || PROJECT_NAME),
    enabled: true,
    title: String(notice.title || '公告'),
    content: String(notice.content),
    createdAt: String(notice.createdAt || ''),
    updatedAt: String(notice.updatedAt || ''),
  };
}

export async function fetchRemoteNotice(): Promise<RemoteNotice | null> {
  // darkscope-web：已关闭远程公告拉取，不再向任何外部服务请求。
  return null;
}
