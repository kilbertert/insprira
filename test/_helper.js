// 每个测试进程独立 DATA_DIR，避免并发污染生产 data/cache.db
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DATA_DIR = process.env.TEST_DATA_DIR
  || path.join(os.tmpdir(), `insprira-test-${process.pid}`);

fs.mkdirSync(TMP_DATA_DIR, { recursive: true });
process.env.DATA_DIR = TMP_DATA_DIR;
// 关闭调度器，避免测试进程注册 cron timer
process.env.ENABLE_SCHEDULER = 'false';

const server = require('../server.js');

module.exports = server;
module.exports.TMP_DATA_DIR = TMP_DATA_DIR;
