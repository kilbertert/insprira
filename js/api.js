import { API_CONF } from './config.js';

let unauthorizedHandler = null;
const controllers = new Map();

export function cancelApi(key) {
  const c = controllers.get(key);
  if (c) { c.abort(); controllers.delete(key); }
}

export function cancelAllApi() {
  controllers.forEach(c => c.abort());
  controllers.clear();
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

function handleUnauthorized() {
  if (unauthorizedHandler) {
    unauthorizedHandler();
  } else {
    location.hash = '#login';
  }
}

async function parseResponse(response) {
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(text || `服务端返回非 JSON（HTTP ${response.status}）`);
  }
  return response.json();
}

export class ApiError extends Error {
  constructor(message, { status, code, endpoint } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
  }
}

export async function api(endpoint, body = {}, options = {}) {
  const conf = API_CONF[endpoint];
  if (!conf) throw new ApiError(`未知 API 端点: ${endpoint}`, { endpoint });
  const { signal, abortKey } = options;
  let abortSignal = signal;
  let ownedController = null;
  if (abortKey) {
    cancelApi(abortKey);
    ownedController = new AbortController();
    controllers.set(abortKey, ownedController);
    abortSignal = signal ? AbortSignal.any([signal, ownedController.signal]) : ownedController.signal;
  }
  const releaseController = () => {
    if (abortKey && controllers.get(abortKey) === ownedController) controllers.delete(abortKey);
  };
  try {
    const r = await fetch('/api/' + conf.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: conf.source, ...body }),
      signal: abortSignal,
    });
    releaseController();
    if (r.status === 401) {
      handleUnauthorized();
      throw new ApiError('登录已过期，请重新登录', { status: 401, endpoint });
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new ApiError(`请求失败（HTTP ${r.status}）${text ? ': ' + text : ''}`, { status: r.status, endpoint });
    }
    const j = await r.json();
    if (![200, 2000].includes(j.code)) {
      throw new ApiError(j.message || `业务错误（code ${j.code}）`, { code: j.code, endpoint });
    }
    return j.data;
  } catch (e) {
    releaseController();
    if (e.name === 'AbortError') throw e;
    if (e instanceof ApiError) throw e;
    throw new ApiError(`网络错误: ${e.message}`, { endpoint });
  }
}

export async function localApi(path, options = {}) {
  const { method = 'GET', body, signal, abortKey } = options;
  let response;
  let abortSignal = signal;
  let ownedController = null;
  if (abortKey) {
    cancelApi(abortKey);
    ownedController = new AbortController();
    controllers.set(abortKey, ownedController);
    abortSignal = signal ? AbortSignal.any([signal, ownedController.signal]) : ownedController.signal;
  }
  const releaseController = () => {
    if (abortKey && controllers.get(abortKey) === ownedController) controllers.delete(abortKey);
  };
  try {
    response = await fetch('/api/_/' + path.replace(/^\/+/, ''), {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: abortSignal,
    });
    releaseController();
  } catch (e) {
    releaseController();
    if (e.name === 'AbortError') throw e;
    throw new Error(`网络错误: ${e.message}`);
  }

  if (response.status === 401) {
    const payload = await parseResponse(response).catch(() => null);
    const isLoginRequest = path.replace(/^\/+/, '') === 'login';
    if (!isLoginRequest) handleUnauthorized();
    throw new Error(payload?.error || (isLoginRequest ? '用户名或密码错误' : '登录已过期，请重新登录'));
  }

  const payload = await parseResponse(response);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `本地服务请求失败（HTTP ${response.status}）`);
  }
  // 无 data 包装的端点（/version /status /redfox/apply 等）保留 fallback；
  // 注意：hot/list 类端点必须用 { data: hotListPayload(...) }，不能用 spread，
  // 否则这里会把数组当 data 拆走，丢失 sourceMode/dataDate/cronExpr 等元数据
  if (payload.data === undefined) return payload;

  const data = payload.data;
  if (payload.stale !== undefined) data.stale = payload.stale;
  if (payload.snapshotDate !== undefined) data.snapshotDate = payload.snapshotDate;
  if (payload.capturedAt !== undefined) data.capturedAt = payload.capturedAt;
  if (payload.syncedAt !== undefined) data.syncedAt = payload.syncedAt;
  ['sourceMode', 'sourceLabel', 'dataDate', 'expectedDate', 'latestAttempt', 'analyzed',
    'cronEnabled', 'cronExpr', 'lastRun'].forEach(key => {
    if (payload[key] !== undefined) data[key] = payload[key];
  });
  return data;
}
