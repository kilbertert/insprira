// 通知渠道（Discord/Bark/Webhook/钉钉/飞书/Telegram）
// 通过 ctx 注入 getLocalData/setLocalData（避免与 server.js 的 local_data 模块循环）
const http = require('http');
const https = require('https');

const NOTIFICATION_CHANNELS = new Set(['discord', 'bark', 'webhook', 'dingtalk', 'feishu', 'telegram']);

function postJsonUrl(rawUrl, payload) {
  const target = new URL(rawUrl);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = transport.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 500) >= 300) reject(new Error(`通知 HTTP ${response.statusCode}`));
        else resolve(text);
      });
    });
    req.on('timeout', () => req.destroy(new Error('通知请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeHelpers(getLocalData, setLocalData) {
  function notificationConfigs() {
    return getLocalData('settings', 'notifications') || {};
  }

  function publicNotificationConfigs() {
    return Object.fromEntries(Object.entries(notificationConfigs()).map(([channel, config]) => [
      channel,
      {
        enabled: Boolean(config.enabled),
        configured: Boolean(config.url || (config.botToken && config.chatId)),
        url: config.url || '',
        botToken: config.botToken || '',
        chatId: config.chatId || '',
      },
    ]));
  }

  function saveNotificationConfigs(input) {
    const current = notificationConfigs();
    for (const channel of NOTIFICATION_CHANNELS) {
      if (!input[channel]) continue;
      const value = input[channel];
      current[channel] = {
        enabled: Boolean(value.enabled),
        url: String(value.url || '').trim() || current[channel]?.url || '',
        botToken: String(value.botToken || '').trim() || current[channel]?.botToken || '',
        chatId: String(value.chatId || '').trim() || current[channel]?.chatId || '',
      };
    }
    setLocalData('settings', 'notifications', current);
    return publicNotificationConfigs();
  }

  return { notificationConfigs, publicNotificationConfigs, saveNotificationConfigs };
}

async function sendNotification(channel, config, title, message) {
  if (!NOTIFICATION_CHANNELS.has(channel)) throw new Error('不支持的通知渠道');
  if (channel === 'telegram') {
    if (!config.botToken || !config.chatId) throw new Error('请配置 Bot Token 和 Chat ID');
    return postJsonUrl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      chat_id: config.chatId,
      text: `${title}\n${message}`,
    });
  }
  if (!config.url) throw new Error('请配置通知地址');
  if (channel !== 'bark' && !config.url.startsWith('https:')) throw new Error('该通知地址必须使用 HTTPS');
  const payload = channel === 'discord'
    ? { content: `**${title}**\n${message}` }
    : channel === 'dingtalk'
      ? { msgtype: 'text', text: { content: `${title}\n${message}` } }
      : channel === 'feishu'
        ? { msg_type: 'text', content: { text: `${title}\n${message}` } }
        : channel === 'bark'
          ? { title, body: message }
          : { title, message, text: `${title}\n${message}` };
  return postJsonUrl(config.url, payload);
}

async function broadcastNotification(getConfigs, title, message) {
  const configs = getConfigs();
  const targets = [];
  for (const [channel, config] of Object.entries(configs)) {
    if (!config?.enabled) continue;
    if (channel === 'telegram') {
      if (config.botToken && config.chatId) targets.push([channel, config]);
    } else if (config.url) {
      targets.push([channel, config]);
    }
  }
  if (!targets.length) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  await Promise.all(targets.map(async ([channel, config]) => {
    try {
      await sendNotification(channel, config, title, message);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[notify] ${channel} 推送失败:`, error.message);
    }
  }));
  return { sent, failed };
}

module.exports = {
  NOTIFICATION_CHANNELS,
  postJsonUrl,
  makeHelpers,
  sendNotification,
  broadcastNotification,
};
