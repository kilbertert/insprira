// HTTP 响应/请求辅助：json 写出 + readBody 解析
// 不持有状态；MAX_BODY_SIZE 在此模块内固定为 2MB
const { parseJson } = require('./utils');

const MAX_BODY_SIZE = 2 * 1024 * 1024;

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
        reject(new Error('请求体超过 2MB'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const parsed = parseJson(body);
      if (parsed == null) reject(new Error('请求体不是有效 JSON'));
      else resolve({ text: body, data: parsed });
    });
    req.on('error', reject);
  });
}

module.exports = { MAX_BODY_SIZE, json, readBody };
