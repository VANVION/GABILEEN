const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET } = process.env;
const endpoint = new URL(process.argv[2] || 'https://pay.gabileen.ru/checkout/telegram-webhook');
if (!TELEGRAM_BOT_TOKEN || !/^[A-Za-z0-9_-]{24,256}$/.test(TELEGRAM_WEBHOOK_SECRET || '') ||
    endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
    endpoint.pathname !== '/checkout/telegram-webhook' || endpoint.search || endpoint.hash) {
  console.error('Configure the bot token, webhook secret and HTTPS webhook endpoint.');
  process.exit(1);
}

async function call(method, body) {
  const response = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Telegram API error, HTTP ' + response.status);
  const result = await response.json();
  if (!result.ok) throw new Error('Telegram API rejected ' + method);
  return result.result;
}

try {
  const current = await call('getWebhookInfo', {});
  if (current.url && current.url !== endpoint.href) {
    throw new Error('The bot already uses another webhook. Keep it until its owner confirms migration.');
  }
  await call('setWebhook', { url: endpoint.href, secret_token: TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message'] });
  await call('setMyCommands', { commands: [
    { command: 'orders', description: 'Последние заказы' },
    { command: 'status', description: 'Статус заказа по номеру' },
    { command: 'help', description: 'Помощь по командам' },
    { command: 'id', description: 'ID личного чата' },
  ] });
  console.log('Telegram webhook and commands configured.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
