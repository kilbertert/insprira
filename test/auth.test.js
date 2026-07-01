const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, validateUsername, validatePassword } = require('./_helper');

test('hashPassword 输出 scrypt 格式', () => {
  const hash = hashPassword('hello123');
  const parts = hash.split('$');
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts.length, 6);
  assert.equal(parts[1], '16384'); // N
  assert.equal(parts[2], '8');     // r
  assert.equal(parts[3], '1');     // p
});

test('hashPassword 每次生成不同盐', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a, b, '盐应随机');
});

test('hashPassword 接受自定义盐（可复现）', () => {
  const salt = 'aabbccdd'.repeat(4); // 16 bytes hex
  const a = hashPassword('test', salt);
  const b = hashPassword('test', salt);
  assert.equal(a, b, '相同盐 + 密码应得到相同 hash');
});

test('verifyPassword 正确密码通过', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
});

test('verifyPassword 错误密码拒绝', () => {
  const hash = hashPassword('right');
  assert.equal(verifyPassword('wrong', hash), false);
});

test('verifyPassword 拒绝损坏的 hash', () => {
  assert.equal(verifyPassword('any', ''), false);
  assert.equal(verifyPassword('any', 'notscrypt$foo'), false);
  assert.equal(verifyPassword('any', 'scrypt$1$2$3$4$5'), false);
});

test('verifyPassword 防止长度不匹配时的越界', () => {
  const hash = hashPassword('pw');
  // 截断 hash 模拟损坏
  const truncated = hash.split('$').slice(0, 5).join('$') + '$deadbeef';
  assert.equal(verifyPassword('pw', truncated), false);
});

test('validateUsername 接受合法用户名', () => {
  for (const u of ['admin', 'alice_01', '张三丰', 'a.b-c', 'user.name_2026']) {
    assert.equal(validateUsername(u), u);
  }
});

test('validateUsername 拒绝非法用户名', () => {
  assert.throws(() => validateUsername('ab'), /3-32/);          // 太短
  assert.throws(() => validateUsername('a'.repeat(33)), /3-32/); // 太长
  assert.throws(() => validateUsername('bad name!'), /3-32/);    // 非法字符
  assert.throws(() => validateUsername(''), /3-32/);
});

test('validatePassword 长度边界', () => {
  assert.equal(validatePassword('123456'), '123456'); // 6 位刚好
  assert.throws(() => validatePassword('12345'), /6-128/);     // 5 位太短
  assert.equal(validatePassword('a'.repeat(128)), 'a'.repeat(128)); // 128 位刚好
  assert.throws(() => validatePassword('a'.repeat(129)), /6-128/);  // 129 位太长
});
