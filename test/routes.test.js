// 路由级集成测试：启动真实 http server，覆盖公开端点、登录流程、受保护端点、401 边界
// 这些测试是后续拆分 handleLocalApi 的回归网
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, close, req } = require('./_server');

let started = false;
test.before(async () => {
  await boot();
  started = true;
});
test.after(async () => {
  if (started) await close();
});

// ============= 公开端点 =============

test('GET /api/_/version 返回版本号', async () => {
  const r = await req('/api/_/version');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.version, 'string');
  assert.ok(r.json.version.length > 0);
});

test('GET /api/_/status 未登录返回 authenticated:false 与 kbEncryptionInsecure', async () => {
  const r = await req('/api/_/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.authenticated, false);
  assert.equal(r.json.user, null);
  assert.equal(r.json.authRequired, true);
  assert.equal(r.json.kbEncryptionInsecure, true);
});

test('POST /api/_/login 错误密码返回 401', async () => {
  const r = await req('/api/_/login', {
    method: 'POST',
    body: { username: 'admin', password: 'definitely-wrong' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
});

test('POST /api/_/login 不存在的用户返回 401', async () => {
  const r = await req('/api/_/login', {
    method: 'POST',
    body: { username: 'nobody', password: 'whatever' },
  });
  assert.equal(r.status, 401);
});

test('POST /api/_/login 缺字段返回 401', async () => {
  const r = await req('/api/_/login', { method: 'POST', body: {} });
  assert.equal(r.status, 401);
});

// ============= 登录流程 =============

let authCookie = null;

test('POST /api/_/login 默认 admin/123456 成功并下发 cookie', async () => {
  const r = await req('/api/_/login', {
    method: 'POST',
    body: { username: 'admin', password: '123456' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.authenticated, true);
  assert.equal(r.json.data.user.username, 'admin');
  const setCookie = r.headers.get('set-cookie');
  assert.ok(setCookie, '应返回 Set-Cookie');
  assert.match(setCookie, /furnace_session=[^;]+/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  authCookie = setCookie.split(';')[0];
});

test('GET /api/_/status 带 cookie 返回 authenticated:true 与 user', async () => {
  assert.ok(authCookie, '前置登录测试应已设置 cookie');
  const r = await req('/api/_/status', { headers: { Cookie: authCookie } });
  assert.equal(r.status, 200);
  assert.equal(r.json.authenticated, true);
  assert.equal(r.json.user.username, 'admin');
  assert.equal(r.json.user.mustChangePassword, true, '种子账号应标记 mustChangePassword');
});

test('POST /api/_/logout 清除会话', async () => {
  assert.ok(authCookie);
  const r = await req('/api/_/logout', { method: 'POST', headers: { Cookie: authCookie } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  // 同一 cookie 之后应无法访问受保护端点
  const after = await req('/api/_/env', { headers: { Cookie: authCookie } });
  assert.equal(after.status, 401);
});

// ============= 401 边界（未登录访问受保护端点）=============

const protectedEndpoints = [
  { path: '/api/_/env', method: 'GET' },
  { path: '/api/_/account', method: 'GET' },
  { path: '/api/_/skills', method: 'GET' },
  { path: '/api/_/inspiration-configs', method: 'GET' },
  { path: '/api/_/trackers', method: 'GET' },
  { path: '/api/_/crons', method: 'GET' },
  { path: '/api/_/my-accounts', method: 'GET' },
  { path: '/api/_/action-logs', method: 'GET' },
  { path: '/api/_/notifications', method: 'GET' },
];

for (const ep of protectedEndpoints) {
  test(`${ep.method} ${ep.path} 未登录返回 401`, async () => {
    const r = await req(ep.path, { method: ep.method });
    assert.equal(r.status, 401);
  });
}

// ============= 已认证受保护端点 =============

async function withLogin(cb) {
  const login = await req('/api/_/login', {
    method: 'POST',
    body: { username: 'admin', password: '123456' },
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  try { return await cb(cookie); } finally {
    await req('/api/_/logout', { method: 'POST', headers: { Cookie: cookie } });
  }
}

test('GET /api/_/env 返回 masked env config', async () => {
  await withLogin(async (cookie) => {
    const r = await req('/api/_/env', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    const env = r.json.data;
    // 所有 EDITABLE_ENV_KEYS 都应在响应里
    for (const key of ['REDFOX_API_KEY', 'LLM_API_KEY', 'KB_ENCRYPTION_KEY']) {
      assert.ok(env[key], `应有 ${key}`);
      assert.equal(env[key].secret, true, `${key} 应标记 secret`);
      assert.equal(env[key].value, '', `${key} value 应被 mask`);
    }
  });
});

test('GET /api/_/skills 返回数组', async () => {
  await withLogin(async (cookie) => {
    const r = await req('/api/_/skills', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(Array.isArray(r.json.data));
  });
});

test('GET /api/_/inspiration-configs 返回数组', async () => {
  await withLogin(async (cookie) => {
    const r = await req('/api/_/inspiration-configs', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.data));
  });
});

test('GET /api/_/trackers 返回数组', async () => {
  await withLogin(async (cookie) => {
    const r = await req('/api/_/trackers', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.data));
  });
});

test('GET /api/_/crons 返回内置 cron 列表', async () => {
  await withLogin(async (cookie) => {
    const r = await req('/api/_/crons', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const ids = r.json.data.map(c => c.id);
    // 内置任务都应在
    for (const id of ['hot-realtime', 'hot-daily-dy', 'cache-clean', 'usage-clean', 'wersss-sync']) {
      assert.ok(ids.includes(id), `应包含内置 cron: ${id}`);
    }
    // lock/protected 是前端概念（js/config.js），后端 listCronJobs 不返回该字段
  });
});

test('GET /api/_/my-accounts 返回数组', async () => {
  await withLogin(async (cookie) => {
    const r = await req('/api/_/my-accounts', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.data));
  });
});

test('GET /api/_/action-logs 返回数组', async () => {
  await withLogin(async (cookie) => {
    const r = await req('/api/_/action-logs', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.data));
  });
});

test('GET /api/_/notifications 返回 ok', async () => {
  await withLogin(async (cookie) => {
    const r = await req('/api/_/notifications', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
  });
});

// ============= RedFox 代理边界 =============

test('POST /api/{未在白名单} 登录后返回 403', async () => {
  // 注意：auth 检查先于白名单检查，必须先登录
  await withLogin(async (cookie) => {
    const r = await req('/api/totally/fake/endpoint', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: { foo: 'bar' },
    });
    assert.equal(r.status, 403);
  });
});

test('POST /api/{未在白名单} 未登录返回 401（auth 优先于白名单）', async () => {
  const r = await req('/api/totally/fake/endpoint', {
    method: 'POST',
    body: { foo: 'bar' },
  });
  assert.equal(r.status, 401);
});

test('POST /api/{白名单端点} 未配置 REDFOX_API_KEY 时返回错误', async () => {
  await withLogin(async (cookie) => {
    // hotKeyword/list 在白名单内，但 REDFOX_API_KEY 在测试环境为空
    const r = await req('/api/hotKeyword/list', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: {},
    });
    assert.ok(r.status >= 400);
  });
});

test('GET /api/{白名单} 用 GET 方法返回 405（auth 后才检查 method）', async () => {
  await withLogin(async (cookie) => {
    const r = await req('/api/hotKeyword/list', { headers: { Cookie: cookie } });
    assert.equal(r.status, 405);
  });
});

// ============= 静态资源 =============

test('GET / 返回 index.html', async () => {
  const r = await req('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.body, /<html/i);
});

test('GET /css/tailwind.css 返回 css', async () => {
  const r = await req('/css/tailwind.css');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/css/);
});

test('GET /js/app.js 返回 javascript', async () => {
  const r = await req('/js/app.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
});

test('GET /vendor/chart.umd.min.js 返回 javascript', async () => {
  const r = await req('/vendor/chart.umd.min.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
});

test('GET /../.env 路径穿越返回 403 或 404', async () => {
  // 注：fetch 通常会规范化 URL，这里测一个相对路径
  const r = await req('/css/..%2F.env');
  // 任何 4xx 都接受——关键是不能泄漏
  assert.ok(r.status >= 400 && r.status < 500);
  assert.equal(r.body.includes('REDFOX_API_KEY'), false, '绝不能泄漏 .env');
});

test('GET /api/_/not-a-real-endpoint 返回 404', async () => {
  const r = await req('/api/_/not-a-real-endpoint');
  // 未认证的 401 优先于 404，所以先登录
  const login = await req('/api/_/login', {
    method: 'POST',
    body: { username: 'admin', password: '123456' },
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const authed = await req('/api/_/not-a-real-endpoint', { headers: { Cookie: cookie } });
  assert.equal(authed.status, 404);
  await req('/api/_/logout', { method: 'POST', headers: { Cookie: cookie } });
});
