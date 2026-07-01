// 密码哈希与账号校验：纯 crypto，无 db / 模块状态依赖
const crypto = require('crypto');

const PASSWORD_SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'hex');
  const derived = crypto.scryptSync(String(password), saltBuffer, 64, PASSWORD_SCRYPT_OPTIONS);
  return `scrypt$${PASSWORD_SCRYPT_OPTIONS.N}$${PASSWORD_SCRYPT_OPTIONS.r}$${PASSWORD_SCRYPT_OPTIONS.p}$${saltBuffer.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, encoded) {
  const [scheme, n, r, p, saltHex, hashHex] = String(encoded || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PASSWORD_SCRYPT_OPTIONS.maxmem,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validateUsername(value) {
  const username = String(value || '').trim();
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
    throw new Error('用户名需为 3-32 位字母、数字、中文、点、下划线或短横线');
  }
  return username;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 6 || password.length > 128) {
    throw new Error('密码长度需为 6-128 位');
  }
  return password;
}

module.exports = {
  PASSWORD_SCRYPT_OPTIONS,
  hashPassword,
  verifyPassword,
  validateUsername,
  validatePassword,
};
