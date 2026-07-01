const test = require('node:test');
const assert = require('node:assert/strict');
const { stableObject, workPublishAt, workContentKey } = require('./_helper');

test('stableObject 键序无关地排序', () => {
  const a = stableObject({ b: 1, a: 2, c: 3 });
  const b = stableObject({ c: 3, a: 2, b: 1 });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify({ a: 2, b: 1, c: 3 }));
});

test('stableObject 嵌套对象递归排序', () => {
  const a = stableObject({ z: { y: 1, x: 2 }, a: 0 });
  assert.equal(JSON.stringify(a), JSON.stringify({ a: 0, z: { x: 2, y: 1 } }));
});

test('stableObject 数组保持顺序', () => {
  assert.deepEqual(stableObject([3, 1, 2]), [3, 1, 2]);
  assert.deepEqual(stableObject([{ b: 1, a: 0 }]), [{ a: 0, b: 1 }]);
});

test('stableObject 原始值原样返回', () => {
  assert.equal(stableObject(42), 42);
  assert.equal(stableObject('foo'), 'foo');
  assert.equal(stableObject(null), null);
  assert.equal(stableObject(undefined), undefined);
});

test('workPublishAt 解析秒级时间戳（<1e12 升 ms）', () => {
  const secStamp = 1700000000; // 2023-11-14
  const ms = workPublishAt({ publishTime: secStamp });
  assert.equal(ms, secStamp * 1000);
});

test('workPublishAt 解析毫秒级时间戳保持不变', () => {
  const msStamp = 1700000000000;
  const ms = workPublishAt({ publishTime: msStamp });
  assert.equal(ms, msStamp);
});

test('workPublishAt 解析字符串日期（兼容 - 替换为 /）', () => {
  const ms = workPublishAt({ publishTime: '2026-07-01 10:30:00' });
  assert.ok(ms > 0);
  // 同样时间在 GMT 解析应等价于 Date.parse('2026/07/01 10:30:00')
  assert.equal(ms, Date.parse('2026/07/01 10:30:00'));
});

test('workPublishAt 多字段回退', () => {
  assert.equal(
    workPublishAt({ workPublishTime: 1700000000 }),
    1700000000000,
  );
  assert.equal(
    workPublishAt({ createTime: '2026-01-01' }),
    Date.parse('2026/01/01'),
  );
});

test('workPublishAt 非法值返回 0', () => {
  assert.equal(workPublishAt({}), 0);
  assert.equal(workPublishAt({ publishTime: 'not a date' }), 0);
  assert.equal(workPublishAt({ publishTime: '' }), 0);
});

test('workContentKey 对相同标题/时间稳定', () => {
  const a = workContentKey({ title: 'Hello', publishTime: 1700000000 });
  const b = workContentKey({ title: 'hello ', publishTime: 1700000000 }); // trim + lowercase
  assert.equal(typeof a, 'string');
  assert.equal(a.length, 40); // sha1 hex
  assert.equal(a, b, '应当对 trim+lowercase 稳定');
});

test('workContentKey 字段不同结果不同', () => {
  const a = workContentKey({ title: 'A', publishTime: 1 });
  const b = workContentKey({ title: 'B', publishTime: 1 });
  assert.notEqual(a, b);
});
