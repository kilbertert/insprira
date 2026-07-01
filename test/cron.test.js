const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCronExpr, validateCronField, nextCronTime, matchesCronField } = require('./_helper');

test('parseCronExpr 接受标准 5 字段表达式', () => {
  for (const expr of ['0 0 * * *', '*/5 * * * *', '0,30 * * * *', '0 9 * * 1-5', '15 14 1 * *', '0 0 1 1 *']) {
    assert.ok(parseCronExpr(expr), `应当解析: ${expr}`);
  }
});

test('parseCronExpr 拒绝非法表达式', () => {
  for (const expr of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 32 * *', '* * * 13 *', 'abc * * * *', '1-5-10 * * * *']) {
    assert.equal(parseCronExpr(expr), null, `应当拒绝: "${expr}"`);
  }
});

test('validateCronField 处理 */2 步长语法', () => {
  assert.equal(validateCronField('*/2', 0, 59), true);
  assert.equal(validateCronField('*/0', 0, 59), false, '步长 0 应非法');
  assert.equal(validateCronField('* / 2', 0, 59), false);
  assert.equal(validateCronField('1-10/3', 0, 59), true);
});

test('validateCronField 处理逗号列表', () => {
  assert.equal(validateCronField('0,15,30,45', 0, 59), true);
  assert.equal(validateCronField('0,99', 0, 59), false);
  assert.equal(validateCronField('0,*/5', 0, 59), true);
});

test('nextCronTime 找到下一个整点', () => {
  const next = nextCronTime('0 0 * * *', new Date('2026-07-01T10:30:00+08:00'));
  assert.ok(next);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getHours(), 0);
  assert.ok(next.getDate() >= 1);
});

test('nextCronTime */5 每五分钟触发', () => {
  const from = new Date('2026-07-01T10:03:00+08:00');
  const next = nextCronTime('*/5 * * * *', from);
  assert.ok(next);
  assert.equal(next.getMinutes(), 5);
});

test('nextCronText 工作日周一到周五 9 点', () => {
  // 2026-07-01 是周三
  const wed = new Date('2026-07-01T20:00:00+08:00');
  const next = nextCronTime('0 9 * * 1-5', wed);
  assert.ok(next);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  const dow = next.getDay();
  assert.ok(dow >= 1 && dow <= 5, `应当在工作日触发，实际: ${dow}`);
});

test('nextCronTime dom 与 dow 同时 restrictive 时取 OR 语义', () => {
  // 经典 Vixie cron：当 dom 和 dow 都不是 *，匹配任一即可
  // "* * 13 * 5" 表示每月 13 号 或 每个周五
  const from = new Date('2026-07-01T00:00:00+08:00');
  const next = nextCronTime('0 0 13 * 5', from);
  assert.ok(next);
  const is13th = next.getDate() === 13;
  const isFriday = next.getDay() === 5;
  assert.ok(is13th || isFriday, '应当匹配 13 号或周五');
});

test('nextCronTime 对非法 cron 返回 null', () => {
  assert.equal(nextCronTime('foo bar baz', new Date()), null);
});

test('matchesCronField 周日 = 0 或 7（sundaySeven）', () => {
  // 周日 getDay()=0
  assert.equal(matchesCronField(0, '0', true), true);
  assert.equal(matchesCronField(0, '7', true), true);
  // monday=1
  assert.equal(matchesCronField(1, '0', true), false);
});

test('matchesCronField 步长在范围内匹配', () => {
  assert.equal(matchesCronField(10, '0-59/10'), true);
  assert.equal(matchesCronField(15, '0-59/10'), false);
  assert.equal(matchesCronField(0, '*'), true);
  assert.equal(matchesCronField(5, '*/5'), true);
});
