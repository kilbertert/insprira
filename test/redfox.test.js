const test = require('node:test');
const assert = require('node:assert/strict');
const { getCacheKey, isCacheableRedfoxResponse, stableObject } = require('./_helper');

test('getCacheKey 同样参数得到同样 key', () => {
  const a = getCacheKey('hotSpot/getListByPlatform', '?x=1', { platform: 'dy', limit: 10 });
  const b = getCacheKey('hotSpot/getListByPlatform', '?x=1', { limit: 10, platform: 'dy' });
  assert.equal(a, b, '应当对 body 键序不敏感');
});

test('getCacheKey 不同 endpoint 不同 key', () => {
  const a = getCacheKey('foo', '', {});
  const b = getCacheKey('bar', '', {});
  assert.notEqual(a, b);
});

test('getCacheKey 不同 query 不同 key', () => {
  const a = getCacheKey('foo', '?a=1', {});
  const b = getCacheKey('foo', '?a=2', {});
  assert.notEqual(a, b);
});

test('getCacheKey 不同 body 不同 key', () => {
  const a = getCacheKey('foo', '', { x: 1 });
  const b = getCacheKey('foo', '', { x: 2 });
  assert.notEqual(a, b);
});

test('isCacheableRedfoxResponse 接受 HTTP 2xx + 业务码 200/2000', () => {
  assert.equal(isCacheableRedfoxResponse(200, JSON.stringify({ code: 200, data: [] })), true);
  assert.equal(isCacheableRedfoxResponse(200, JSON.stringify({ code: 2000, data: [] })), true);
  assert.equal(isCacheableRedfoxResponse(201, '{}'), true);
});

test('isCacheableRedfoxResponse 拒绝 HTTP 4xx/5xx', () => {
  assert.equal(isCacheableRedfoxResponse(404, '{}'), false);
  assert.equal(isCacheableRedfoxResponse(500, '{}'), false);
  assert.equal(isCacheableRedfoxResponse(301, '{}'), false);
});

test('isCacheableRedfoxResponse 拒绝非 200/2000 业务码', () => {
  assert.equal(isCacheableRedfoxResponse(200, JSON.stringify({ code: 500, msg: 'fail' })), false);
  assert.equal(isCacheableRedfoxResponse(200, JSON.stringify({ code: 401 })), false);
});

test('isCacheableRedfoxResponse 缺 code 字段视为可缓存', () => {
  // 业务约定：只有显式 code != 200/2000 才排除
  assert.equal(isCacheableRedfoxResponse(200, JSON.stringify({ data: [] })), true);
  assert.equal(isCacheableRedfoxResponse(200, 'not json'), true);
});

test('stableObject 通过 getCacheKey 间接验证', () => {
  // getCacheKey 内部调用 stableObject；此处额外确认嵌套结构稳定
  const a = getCacheKey('e', '', { outer: { b: 2, a: 1 }, list: [3, 2, 1] });
  const b = getCacheKey('e', '', { outer: { a: 1, b: 2 }, list: [3, 2, 1] });
  assert.equal(a, b);
});
