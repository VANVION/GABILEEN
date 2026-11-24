import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createPhoneLogin } from './phone-login.mjs';

const { TELEGRAM_BOT_TOKEN, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY, CATALOG_ORIGIN,
  TELEGRAM_RETURN_URL, ORDERS_DB, PICKUP_ADDRESS, RECEIPT_VAT_CODE, RECEIPT_TAX_SYSTEM_CODE, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_SELLER_CHAT_ID, GUEST_CHECKOUT_TEST_CODE, TELEGRAM_GATEWAY_TOKEN, PUBLIC_PHONE_LOGIN } = process.env;
if (![TELEGRAM_BOT_TOKEN, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY, CATALOG_ORIGIN,
  TELEGRAM_RETURN_URL, ORDERS_DB, PICKUP_ADDRESS].every(Boolean)) {
  throw new Error('Checkout configuration is incomplete. See checkout/README.md.');
}
if (new URL(CATALOG_ORIGIN).origin !== CATALOG_ORIGIN || !CATALOG_ORIGIN.startsWith('https://') ||
    new URL(TELEGRAM_RETURN_URL).origin !== 'https://t.me') {
  throw new Error('Use the HTTPS catalogue origin and a t.me return URL.');
}

const vatCode = Number(RECEIPT_VAT_CODE);
const taxSystemCode = RECEIPT_TAX_SYSTEM_CODE ? Number(RECEIPT_TAX_SYSTEM_CODE) : null;
if (RECEIPT_VAT_CODE && (!Number.isInteger(vatCode) || vatCode < 1 || vatCode > 99) ||
    taxSystemCode !== null && (!Number.isInteger(taxSystemCode) || taxSystemCode < 1 || taxSystemCode > 6)) {
  throw new Error('Invalid YooKassa receipt settings.');
}

if ((TELEGRAM_WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{24,256}$/.test(TELEGRAM_WEBHOOK_SECRET)) ||
    (TELEGRAM_SELLER_CHAT_ID && !/^[1-9]\d{0,15}$/.test(TELEGRAM_SELLER_CHAT_ID))) {
  throw new Error('Invalid Telegram bot configuration.');
}

const products = new Map(JSON.parse(readFileSync(new URL('../data/products.json', import.meta.url)))
  .filter(product => product.cat === 'bryuki').map(product => [product.id, product]));
const db = new DatabaseSync(ORDERS_DB);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, customer TEXT NOT NULL, checkout_key TEXT NOT NULL,
    items TEXT NOT NULL, amount INTEGER NOT NULL, payment_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'creating', payment_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(customer, checkout_key)
  );
  CREATE TABLE IF NOT EXISTS receipt_requests (
    order_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seller_notifications (
    order_id TEXT NOT NULL, status TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (order_id, status)
  );
  CREATE TRIGGER IF NOT EXISTS queue_seller_notification
  AFTER UPDATE OF status ON orders
  WHEN NEW.status <> OLD.status AND NEW.status IN ('succeeded', 'canceled')
  BEGIN
    INSERT OR IGNORE INTO seller_notifications (order_id, status) VALUES (NEW.id, NEW.status);
  END;
  CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer, created_at);
`);
const store = {
  create: db.prepare('INSERT OR IGNORE INTO orders (id, customer, checkout_key, items, amount) VALUES (?, ?, ?, ?, ?)'),
  saveReceipt: db.prepare('INSERT OR IGNORE INTO receipt_requests (order_id, fingerprint) VALUES (?, ?)'),
  receipt: db.prepare('SELECT fingerprint FROM receipt_requests WHERE order_id = ?'),
  byKey: db.prepare('SELECT * FROM orders WHERE customer = ? AND checkout_key = ?'),
  byCustomer: db.prepare('SELECT * FROM orders WHERE customer = ? ORDER BY created_at DESC LIMIT 50'),
  recentForSeller: db.prepare("SELECT * FROM orders WHERE payment_id IS NOT NULL ORDER BY created_at DESC LIMIT 8"),
  recentForBuyer: db.prepare("SELECT * FROM orders WHERE customer = ? AND payment_id IS NOT NULL ORDER BY created_at DESC LIMIT 8"),
  statusForSeller: db.prepare("SELECT * FROM orders WHERE id LIKE ? AND payment_id IS NOT NULL LIMIT 2"),
  statusForBuyer: db.prepare("SELECT * FROM orders WHERE id LIKE ? AND customer = ? AND payment_id IS NOT NULL LIMIT 2"),
  pendingNotifications: db.prepare(`SELECT n.order_id, n.status AS event_status, o.*
    FROM seller_notifications n JOIN orders o ON o.id = n.order_id
    WHERE n.sent = 0 AND n.retry_at <= unixepoch() ORDER BY o.created_at LIMIT 5`),
  markNotified: db.prepare('UPDATE seller_notifications SET sent = 1 WHERE order_id = ? AND status = ?'),
  retryNotification: db.prepare('UPDATE seller_notifications SET retry_at = unixepoch() + 60 WHERE order_id = ? AND status = ?'),
  byPayment: db.prepare('SELECT * FROM orders WHERE payment_id = ?'),
  attach: db.prepare(`UPDATE orders SET payment_id = ?, status = ?, payment_url = ? WHERE id = ? AND payment_id IS NULL`),
  status: db.prepare(`UPDATE orders SET status = ? WHERE id = ? AND status IN ('pending', 'waiting_for_capture')`),
};
const authKey = createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
const guestTestCodeHash = /^[0-9a-f]{32,64}$/.test(GUEST_CHECKOUT_TEST_CODE || '') ?
  createHmac('sha256', authKey).update(GUEST_CHECKOUT_TEST_CODE).digest() : null;
const yookassaAuthorization = 'Basic ' + Buffer.from(YOOKASSA_SHOP_ID + ':' + YOOKASSA_SECRET_KEY).toString('base64');

class RequestError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const phoneLogin = createPhoneLogin(db, authKey, TELEGRAM_GATEWAY_TOKEN, RequestError);

function authenticate(header) {
  const raw = typeof header === 'string' && header.startsWith('tma ') ? header.slice(4) : '';
  const data = new URLSearchParams(raw);
  const hash = data.get('hash');
  data.delete('hash');
  data.sort();
  const signed = [...data].map(([key, value]) => key + '=' + value).join('\n');
  const expected = createHmac('sha256', authKey).update(signed).digest();
  const timestamp = Number(data.get('auth_date'));
  const age = Date.now() / 1000 - timestamp;
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !timingSafeEqual(Buffer.from(hash, 'hex'), expected) ||
      !Number.isSafeInteger(timestamp) || age < -30 || age > 3600) {
    throw new RequestError(401, 'telegram_session');
  }
  let user;
  try { user = JSON.parse(data.get('user')); } catch { throw new RequestError(401, 'telegram_session'); }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw new RequestError(401, 'telegram_session');
  return String(user.id);
}

function normalizeCart(cart) {
  if (!Array.isArray(cart) || !cart.length || cart.length > 16) throw new RequestError(422, 'cart');
  const seen = new Set();
  return cart.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RequestError(422, 'cart');
    const { id, size, qty } = item;
    const product = products.get(id);
    const label = String(product?.sizes ?? '');
    const sizes = label.match(/\d+/g)?.map(Number) ?? [];
    const selected = typeof size === 'string' && /^\d+$/.test(size) ? Number(size) : NaN;
    const isRange = sizes.length === 2 && /[–—-]/.test(label);
    const inRange = isRange ? selected >= sizes[0] && selected <= sizes[1] && (selected - sizes[0]) % 2 === 0 : sizes.includes(selected);
    const unavailable = (String(product?.soldout ?? '').match(/\d+/g) ?? []).map(Number);
    const price = product?.price;
    const key = JSON.stringify([id, selected]);
    if (!Number.isSafeInteger(price) || price < 1 || price > 1_000_000 || !inRange || unavailable.includes(selected) ||
        !Number.isInteger(qty) || qty < 1 || qty > 5 || seen.has(key)) {
      throw new RequestError(422, 'cart');
    }
    seen.add(key);
    return { id, size: selected, qty, name: product.name_ru, unitPrice: price };
  }).sort((a, b) => a.id.localeCompare(b.id) || a.size - b.size);
}

async function yookassa(path, options = {}) {
  const response = await fetch('https://api.yookassa.ru/v3/payments' + path, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: { Authorization: yookassaAuthorization, 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) throw new RequestError(502, 'payment_provider');
  return response.json();
}

function validatePayment(order, payment) {
  if (!/^[a-z0-9-]{1,80}$/i.test(payment.id) || payment.metadata?.order_id !== order.id ||
      payment.amount?.currency !== 'RUB' || Number(payment.amount.value) !== order.amount ||
      !['pending', 'waiting_for_capture', 'succeeded', 'canceled'].includes(payment.status) ||
      (payment.status === 'succeeded' && payment.paid !== true)) {
    throw new RequestError(502, 'payment_provider');
  }
  return payment;
}

async function refresh(order) {
  if (!order.payment_id || !['pending', 'waiting_for_capture'].includes(order.status)) return order;
  const payment = validatePayment(order, await yookassa('/' + order.payment_id));
  if (payment.id !== order.payment_id) throw new RequestError(502, 'payment_provider');
  store.status.run(payment.status, order.id);
  return store.byPayment.get(order.payment_id);
}

function orderView(order) {
  return {
    id: order.id, items: JSON.parse(order.items), amount: order.amount, status: order.status,
    createdAt: order.created_at.replace(' ', 'T') + 'Z',
    pickupAddress: PICKUP_ADDRESS,
    paymentUrl: order.status === 'pending' ? order.payment_url : null,
  };
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16_384) throw new RequestError(413, 'request_size');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  throw new RequestError(400, 'body');
}

function receiptFor(items, emailValue) {
  if (!vatCode) throw new RequestError(503, 'receipt_configuration');
  const email = typeof emailValue === 'string' ? emailValue.trim() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RequestError(422, 'receipt_email');
  }
  return {
    customer: { email },
    ...(taxSystemCode !== null ? { tax_system_code: taxSystemCode } : {}),
    items: items.map(item => ({
      description: (item.name + ' / ' + item.id + ' / ' + item.size).slice(0, 128),
      quantity: item.qty.toFixed(3),
      amount: { value: item.unitPrice.toFixed(2), currency: 'RUB' },
      vat_code: vatCode,
      payment_subject: 'commodity',
      payment_mode: 'full_prepayment',
    })),
  };
}

function checkoutCustomer(request) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('phone ')) {
    if (request.headers.origin !== CATALOG_ORIGIN) throw new RequestError(403, 'phone_origin');
    const account = phoneLogin.customer(authorization.slice(6));
    if (account.startsWith('phone-public:') && PUBLIC_PHONE_LOGIN !== '1') throw new RequestError(503, 'phone_disabled');
    return account;
  }
  if (!authorization?.startsWith('guest ')) return authenticate(authorization);
  if (!guestTestCodeHash) throw new RequestError(503, 'guest_disabled');
  const match = /^guest ([0-9a-f]{64})\.([0-9a-f]{32,64})$/.exec(authorization);
  if (!match || request.headers.origin !== CATALOG_ORIGIN ||
      !timingSafeEqual(createHmac('sha256', authKey).update(match[2]).digest(), guestTestCodeHash)) {
    throw new RequestError(401, 'guest_test_code');
  }
  return 'guest:' + createHmac('sha256', authKey).update(match[1]).digest('hex');
}

async function createOrder(customer, body) {
  const { checkoutKey } = body;
  if (typeof checkoutKey !== 'string' || !/^[a-f0-9-]{36}$/i.test(checkoutKey)) throw new RequestError(400, 'checkout_key');
  const existing = store.byKey.get(customer, checkoutKey);
  if (existing?.payment_id) return orderView(await refresh(existing));
  const items = existing ? JSON.parse(existing.items) : normalizeCart(body.cart);
  const receipt = receiptFor(items, body.receiptEmail);
  const amount = items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
  store.create.run(randomUUID(), customer, checkoutKey, JSON.stringify(items), amount);
  const order = store.byKey.get(customer, checkoutKey);
  // YooKassa retains idempotency keys for 24 hours. Never retry an ambiguous older creation.
  if (Date.now() - Date.parse(order.created_at.replace(' ', 'T') + 'Z') >= 23 * 3600_000) {
    throw new RequestError(409, 'payment_review');
  }
  // A retry uses the same payment parameters while the email stays out of SQLite.
  const fingerprint = createHmac('sha256', authKey).update(JSON.stringify(receipt)).digest('hex');
  store.saveReceipt.run(order.id, fingerprint);
  if (store.receipt.get(order.id).fingerprint !== fingerprint) throw new RequestError(409, 'receipt_retry');
  const phone = customer.startsWith('phone:');
  const web = phone || customer.startsWith('guest:');
  const returnUrl = new URL(web ? '/GABILEEN/' : TELEGRAM_RETURN_URL, CATALOG_ORIGIN);
  if (web) {
    returnUrl.searchParams.set('checkout', 'test');
    if (phone) returnUrl.searchParams.set('login', 'phone');
    returnUrl.searchParams.set('order', order.id);
  } else {
    returnUrl.searchParams.set('startapp', 'checkout-order-' + order.id);
  }
  const payment = validatePayment(order, await yookassa('', {
    method: 'POST',
    headers: { 'Idempotence-Key': order.id },
    body: JSON.stringify({
      amount: { value: order.amount.toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: returnUrl.href },
      description: 'GABILEEN · ' + order.id,
      metadata: { order_id: order.id },
      receipt,
    }),
  }));
  if (payment.test !== true) throw new RequestError(502, 'test_payment_required');
  let confirmation = null;
  if (payment.confirmation?.confirmation_url) {
    const url = new URL(payment.confirmation.confirmation_url);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !['yoomoney.ru', 'yookassa.ru'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
      throw new RequestError(502, 'payment_provider');
    }
    confirmation = url.href;
  }
  if (payment.status === 'pending' && !confirmation) throw new RequestError(502, 'payment_provider');
  store.attach.run(payment.id, payment.status, confirmation, order.id);
  return orderView(store.byPayment.get(payment.id));
}

const telegramSecretHash = TELEGRAM_WEBHOOK_SECRET ?
  createHmac('sha256', authKey).update(TELEGRAM_WEBHOOK_SECRET).digest() : null;

function telegramAuthorized(header) {
  return telegramSecretHash && typeof header === 'string' &&
    timingSafeEqual(createHmac('sha256', authKey).update(header).digest(), telegramSecretHash);
}

async function sendTelegram(chatId, text) {
  const response = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !(await response.json()).ok) throw new RequestError(502, 'telegram_delivery');
}

const statusLabels = {
  pending: 'Ожидает оплаты', waiting_for_capture: 'Оплата проверяется',
  succeeded: 'Оплачено', canceled: 'Платёж отменён',
};
function orderSummary(order, details = false) {
  const value = 'Заказ № ' + order.id.slice(0, 8).toUpperCase() + ' · ' +
    (statusLabels[order.status] || 'Не оформлен') + ' · ' + order.amount.toLocaleString('ru-RU') + ' ₽';
  if (!details) return value;
  const lines = JSON.parse(order.items).map(item => {
    const product = products.get(item.id);
    return '• ' + item.name + ' · арт. ' + (product?.article || item.id) + ' · размер ' + item.size + ' × ' + item.qty;
  });
  // Telegram limits a text message to 4096 characters.
  return [value, ...lines].join('\n').slice(0, 3800) + '\nСамовывоз: ' + PICKUP_ADDRESS.slice(0, 200);
}

async function botReply(update) {
  const message = update.message;
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(message.from?.id) ||
      message.chat.id !== message.from.id || typeof message.text !== 'string') return;
  const customer = String(message.from.id);
  const seller = customer === TELEGRAM_SELLER_CHAT_ID;
  const [command, orderNumber] = message.text.trim().split(/\s+/, 2);
  switch (command.toLowerCase().split('@')[0]) {
    case '/id':
      return sendTelegram(customer, 'Ваш ID чата: ' + customer);
    case '/start':
    case '/help':
      return sendTelegram(customer, 'GABILEEN\n/orders — последние заказы\n/status НОМЕР — статус заказа, например /status 54F74A71\n/id — ID этого чата');
    case '/orders': {
      const orders = seller ? store.recentForSeller.all() : store.recentForBuyer.all(customer);
      return sendTelegram(customer, orders.length ? orders.map(order => orderSummary(order)).join('\n') +
        '\n\nДля подробностей: /status НОМЕР' : 'Оформленных заказов пока нет.');
    }
    case '/status': {
      if (!orderNumber || !/^(?:[a-f0-9]{8}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(orderNumber)) {
        return sendTelegram(customer, 'Укажите номер заказа, например /status 54F74A71. Список заказов: /orders');
      }
      const prefix = orderNumber.toLowerCase() + '%';
      const rows = seller ? store.statusForSeller.all(prefix) : store.statusForBuyer.all(prefix, customer);
      if (rows.length !== 1) return sendTelegram(customer, rows.length ? 'Укажите полный номер заказа.' : 'Заказ не найден.');
      let order = rows[0];
      try { order = await refresh(order); } catch {
        return sendTelegram(customer, orderSummary(order, true) + '\nНе удалось проверить оплату. Показан последний подтверждённый статус.');
      }
      return sendTelegram(customer, orderSummary(order, true));
    }
  }
}

let notifying = false;
async function deliverSellerNotifications() {
  if (!TELEGRAM_SELLER_CHAT_ID || notifying) return;
  notifying = true;
  try {
    for (const order of store.pendingNotifications.all()) {
      try {
        await sendTelegram(TELEGRAM_SELLER_CHAT_ID, 'GABILEEN · тестовый заказ\n' + orderSummary({ ...order, status: order.event_status }, true));
        store.markNotified.run(order.order_id, order.event_status);
      } catch {
        store.retryNotification.run(order.order_id, order.event_status);
      }
    }
  } finally {
    notifying = false;
  }
}

if (TELEGRAM_SELLER_CHAT_ID) {
  setInterval(() => {
    deliverSellerNotifications().catch(() => console.error('Seller notification queue temporarily unavailable'));
  }, 5000).unref();
}

async function handle(request) {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname;
  if (request.method === 'GET' && path === '/health') return { ok: true };
  if (request.method === 'OPTIONS' && request.headers.origin === CATALOG_ORIGIN) return {};
  if (request.method === 'POST' && path === '/checkout/telegram-webhook') {
    if (!telegramAuthorized(request.headers['x-telegram-bot-api-secret-token'])) throw new RequestError(403, 'telegram_webhook');
    await botReply(await readJson(request));
    return {};
  }
  if (request.method === 'POST' && path === '/checkout/webhook') {
    const { event, object } = await readJson(request);
    if (['payment.succeeded', 'payment.canceled'].includes(event) && typeof object?.id === 'string') {
      const order = store.byPayment.get(object.id);
      if (order) await refresh(order); // Trust the authenticated YooKassa API, never the incoming event payload.
    }
    return {};
  }
  if (request.method === 'POST' && path.startsWith('/checkout/phone/')) {
    const authorization = request.headers.authorization || '';
    if (path === '/checkout/phone/logout' && authorization.startsWith('phone ')) {
      checkoutCustomer(request);
      phoneLogin.logout(authorization.slice(6));
      return {};
    }
    let requester;
    if (authorization.startsWith('phone-web ')) {
      if (PUBLIC_PHONE_LOGIN !== '1') throw new RequestError(503, 'phone_disabled');
      if (request.headers.origin !== CATALOG_ORIGIN) throw new RequestError(403, 'phone_origin');
      const browserKey = authorization.slice(10);
      if (!/^[a-f0-9]{64}$/.test(browserKey)) throw new RequestError(401, 'phone_session');
      requester = 'phone-web:' + createHmac('sha256', authKey).update(browserKey).digest('hex');
    } else {
      if (!authorization.startsWith('guest ')) throw new RequestError(401, 'guest_test_code');
      requester = checkoutCustomer(request);
    }
    if (path === '/checkout/phone/start') return phoneLogin.start(requester, await readJson(request));
    if (path === '/checkout/phone/verify') return phoneLogin.verify(requester, await readJson(request));
    throw new RequestError(404, 'route');
  }
  const customer = checkoutCustomer(request);
  if (request.method === 'POST' && path === '/checkout/orders') {
    if (customer.startsWith('phone-public:')) throw new RequestError(403, 'public_payment_disabled');
    return createOrder(customer, await readJson(request));
  }
  if (request.method === 'GET' && path === '/checkout/orders') {
    const orders = store.byCustomer.all(customer);
    const pending = orders.map((order, index) => ({ order, index }))
      .filter(({ order }) => ['pending', 'waiting_for_capture'].includes(order.status));
    const requested = pending.find(({ order }) => order.id === url.searchParams.get('order'));
    const toRefresh = [requested, ...pending.filter(entry => entry !== requested)].filter(Boolean).slice(0, 3);
    await Promise.allSettled(toRefresh.map(async ({ order, index }) => {
      orders[index] = await refresh(order);
    }));
    return orders.map(orderView);
  }
  throw new RequestError(404, 'route');
}

createServer({ requestTimeout: 15_000 }, async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Vary', 'Origin');
  if (request.headers.origin === CATALOG_ORIGIN) {
    response.setHeader('Access-Control-Allow-Origin', CATALOG_ORIGIN);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  try {
    response.end(JSON.stringify(await handle(request)));
  } catch (error) {
    response.statusCode = error instanceof RequestError ? error.status : 503;
    const retryAfter = error instanceof RequestError ? error.retryAfter : undefined;
    if (retryAfter) response.setHeader('Retry-After', String(retryAfter));
    response.end(JSON.stringify({
      error: error instanceof RequestError ? error.message : 'checkout_unavailable',
      retry_after: retryAfter,
    }));
  }
}).listen(Number(process.env.PORT || 8787), process.env.BIND_ADDRESS || '127.0.0.1');
