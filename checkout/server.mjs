import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const { TELEGRAM_BOT_TOKEN, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY, CATALOG_ORIGIN,
  TELEGRAM_RETURN_URL, ORDERS_DB, PICKUP_ADDRESS } = process.env;
if (![TELEGRAM_BOT_TOKEN, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY, CATALOG_ORIGIN,
  TELEGRAM_RETURN_URL, ORDERS_DB, PICKUP_ADDRESS].every(Boolean)) {
  throw new Error('Checkout configuration is incomplete. See checkout/README.md.');
}
if (new URL(CATALOG_ORIGIN).origin !== CATALOG_ORIGIN || !CATALOG_ORIGIN.startsWith('https://') ||
    new URL(TELEGRAM_RETURN_URL).origin !== 'https://t.me') {
  throw new Error('Use the HTTPS catalogue origin and a t.me return URL.');
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
  CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer, created_at);
`);
const store = {
  create: db.prepare('INSERT OR IGNORE INTO orders (id, customer, checkout_key, items, amount) VALUES (?, ?, ?, ?, ?)'),
  byKey: db.prepare('SELECT * FROM orders WHERE customer = ? AND checkout_key = ?'),
  byCustomer: db.prepare('SELECT * FROM orders WHERE customer = ? ORDER BY created_at DESC LIMIT 50'),
  byPayment: db.prepare('SELECT * FROM orders WHERE payment_id = ?'),
  attach: db.prepare(`UPDATE orders SET payment_id = ?, status = ?, payment_url = ? WHERE id = ? AND payment_id IS NULL`),
  status: db.prepare(`UPDATE orders SET status = ? WHERE id = ? AND status IN ('pending', 'waiting_for_capture')`),
};
const authKey = createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
const yookassaAuthorization = 'Basic ' + Buffer.from(YOOKASSA_SHOP_ID + ':' + YOOKASSA_SECRET_KEY).toString('base64');

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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

async function createOrder(customer, body) {
  const { checkoutKey } = body;
  if (typeof checkoutKey !== 'string' || !/^[a-f0-9-]{36}$/i.test(checkoutKey)) throw new RequestError(400, 'checkout_key');
  const existing = store.byKey.get(customer, checkoutKey);
  if (existing?.payment_id) return orderView(await refresh(existing));
  const items = existing ? JSON.parse(existing.items) : normalizeCart(body.cart);
  const amount = items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
  store.create.run(randomUUID(), customer, checkoutKey, JSON.stringify(items), amount);
  const order = store.byKey.get(customer, checkoutKey);
  // YooKassa retains idempotency keys for 24 hours. Never retry an ambiguous older creation.
  if (Date.now() - Date.parse(order.created_at.replace(' ', 'T') + 'Z') >= 23 * 3600_000) {
    throw new RequestError(409, 'payment_review');
  }
  const payment = validatePayment(order, await yookassa('', {
    method: 'POST',
    headers: { 'Idempotence-Key': order.id },
    body: JSON.stringify({
      amount: { value: order.amount.toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: TELEGRAM_RETURN_URL },
      description: 'GABILEEN · ' + order.id,
      metadata: { order_id: order.id },
    }),
  }));
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

async function handle(request) {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'GET' && path === '/health') return { ok: true };
  if (request.method === 'OPTIONS' && request.headers.origin === CATALOG_ORIGIN) return {};
  if (request.method === 'POST' && path === '/checkout/webhook') {
    const { event, object } = await readJson(request);
    if (['payment.succeeded', 'payment.canceled'].includes(event) && typeof object?.id === 'string') {
      const order = store.byPayment.get(object.id);
      if (order) await refresh(order); // Trust the authenticated YooKassa API, never the incoming event payload.
    }
    return {};
  }
  const customer = authenticate(request.headers.authorization);
  if (request.method === 'POST' && path === '/checkout/orders') return createOrder(customer, await readJson(request));
  if (request.method === 'GET' && path === '/checkout/orders') {
    const orders = store.byCustomer.all(customer);
    // The latest payment may have completed since Telegram was opened.
    const latestPending = orders.findIndex(order => order.status === 'pending');
    if (latestPending !== -1) {
      try { orders[latestPending] = await refresh(orders[latestPending]); } catch { /* Display the last confirmed status. */ }
    }
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
    response.end(JSON.stringify({ error: error instanceof RequestError ? error.message : 'checkout_unavailable' }));
  }
}).listen(Number(process.env.PORT || 8787), process.env.BIND_ADDRESS || '127.0.0.1');
