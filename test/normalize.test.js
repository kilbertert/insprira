const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshotItems } = require('./_helper');

test('normalizeSnapshotItems platform=all 聚合关键词', () => {
  const result = normalizeSnapshotItems('all', [
    { keyword: 'iPhone 17', plats: ['dy', 'xhs', 'gzh'] },
    { keyword: 'AI', plats: ['dy'] },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    key: 'iPhone 17',
    title: 'iPhone 17',
    score: 3,
    raw: { keyword: 'iPhone 17', plats: ['dy', 'xhs', 'gzh'] },
  });
});

test('normalizeSnapshotItems platform=ai-gzh 以阅读数为 score', () => {
  const result = normalizeSnapshotItems('ai-gzh', [
    { photoId: 'p1', title: 'A', readCount: 1000 },
    { id: 'p2', title: 'B', readCount: 500 },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].score, 1000);
  assert.equal(result[1].score, 500);
});

test('normalizeSnapshotItems platform=ai-dy 累计 like+share+comment', () => {
  const result = normalizeSnapshotItems('ai-dy', [
    { id: 'x', title: 'T', likeCount: 10, shareCount: 5, commentCount: 3 },
  ]);
  assert.equal(result[0].score, 18);
});

test('normalizeSnapshotItems platform=dy 用 workId 作 key', () => {
  const result = normalizeSnapshotItems('dy', [
    { workId: 'w1', title: 'A', likeCount: 100 },
    { title: 'B', likeCount: 50 }, // 缺 workId 回退
  ]);
  assert.equal(result[0].key, 'w1');
  assert.equal(result[0].score, 100);
  assert.equal(result[1].key, 'B');
});

test('normalizeSnapshotItems platform=xhs 字段回退', () => {
  const result = normalizeSnapshotItems('xhs', [
    { workId: 'w1', workTitle: 'X', workLikedCount: 80 },
    { id: 'i2', title: 'Y', likedCount: 30 },
  ]);
  assert.equal(result[0].key, 'w1');
  assert.equal(result[0].title, 'X');
  assert.equal(result[0].score, 80);
  assert.equal(result[1].score, 30);
});

test('normalizeSnapshotItems platform=gzh 用 readCount', () => {
  const result = normalizeSnapshotItems('gzh', [
    { workUuid: 'u1', title: 'A', readCount: 1000 },
    { id: 'u2', title: 'B', clicksCount: 200 },
  ]);
  assert.equal(result[0].key, 'u1');
  assert.equal(result[0].score, 1000);
  assert.equal(result[1].score, 200, '应当回退到 clicksCount');
});

test('normalizeSnapshotItems 缺标题用占位符', () => {
  const result = normalizeSnapshotItems('dy', [{ workId: 'w' }]);
  assert.equal(result[0].title, '(无标题)');
});

test('normalizeSnapshotItems 兼容 list/articles 包装', () => {
  const r1 = normalizeSnapshotItems('dy', { list: [{ workId: 'a', title: 'X' }] });
  const r2 = normalizeSnapshotItems('gzh', { articles: [{ id: 'b', title: 'Y' }] });
  assert.equal(r1.length, 1);
  assert.equal(r2.length, 1);
});

test('normalizeSnapshotItems 空数据返回空数组', () => {
  assert.deepEqual(normalizeSnapshotItems('dy', []), []);
  assert.deepEqual(normalizeSnapshotItems('dy', null), []);
  assert.deepEqual(normalizeSnapshotItems('dy', {}), []);
});
