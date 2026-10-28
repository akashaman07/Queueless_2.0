const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

const API = process.env.API_URL || 'http://127.0.0.1:5000/api';
const accounts = [
  { role: 'customer', email: 'demo@example.com', password: 'password123' },
  { role: 'seller', email: 'seller@example.com', password: 'seller123' },
  { role: 'admin', email: 'admin@example.com', password: 'admin123' },
];
const tokens = {};

async function request(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test('registration retains the 10-character new-password policy', async () => {
  const response = await request('/auth/register', { method: 'POST', body: { name: 'Test User', email: `short-password-${Date.now()}@example.com`, password: 'short123' } });
  assert.equal(response.status, 400);
});

test('development demo accounts authenticate and return their configured roles', async () => {
  for (const account of accounts) {
    const response = await request('/auth/login', { method: 'POST', body: { email: account.email, password: account.password } });
    assert.equal(response.status, 200, `${account.role} login`);
    assert.equal(response.body.user.role, account.role);
    assert.ok(response.body.token);
    tokens[account.role] = response.body.token;
  }
});

test('login does not apply new-password length rules', async () => {
  const response = await request('/auth/login', { method: 'POST', body: { email: 'seller@example.com', password: 'seller123' } });
  assert.equal(response.status, 200);
});

test('customer and seller cannot access admin user management', async () => {
  assert.equal((await request('/users', { token: tokens.customer })).status, 403);
  assert.equal((await request('/users', { token: tokens.seller })).status, 403);
  assert.equal((await request('/users', { token: tokens.admin })).status, 200);
  assert.equal((await request('/admin/reports/sales', { token: tokens.customer })).status, 403);
  assert.equal((await request('/admin/reports/sales', { token: tokens.seller })).status, 403);
  assert.equal((await request('/admin/reports/sales', { token: tokens.admin })).status, 200);
  assert.equal((await request('/products', { token: tokens.customer, method: 'POST', body: { name: 'No', barcode: 'no-customer-write', price: 1, stock: 1 } })).status, 403);
});

test('admin-only audit route is protected; staff receipt route requires staff role', async () => {
  assert.equal((await request('/admin/audit-logs', { token: tokens.customer })).status, 403);
  assert.equal((await request('/admin/audit-logs', { token: tokens.seller })).status, 403);
  assert.equal((await request('/admin/audit-logs', { token: tokens.admin })).status, 200);
  assert.equal((await request('/receipts/not-an-id/redeem', { token: tokens.customer, method: 'POST', body: { token: 'invalid' } })).status, 403);
});

test('paid receipts redeem once, reject concurrent duplicates, and leave no smoke data', async () => {
  const headers = token => ({ token });
  let productId;
  let orderId;
  try {
    const barcode = `SMOKE-${crypto.randomUUID()}`;
    const created = await request('/products', { ...headers(tokens.seller), method: 'POST', body: { name: 'Temporary smoke item', barcode, category: 'Test', price: 12.34, stock: 2 } });
    assert.equal(created.status, 201);
    productId = created.body._id;
    assert.equal((await request(`/products/${productId}`, { ...headers(tokens.customer), method: 'PATCH', body: { price: 13.34 } })).status, 403);
    const priceUpdate = await request(`/products/${productId}`, { ...headers(tokens.seller), method: 'PATCH', body: { price: 13.34 } });
    assert.equal(priceUpdate.status, 200);
    assert.equal(priceUpdate.body.price, 13.34);

    const idempotencyKey = crypto.randomUUID();
    const place = async () => {
      const response = await fetch(`${API}/orders`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.customer}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ items: [{ productId, quantity: 1 }] }) });
      return { status: response.status, body: await response.json() };
    };
    const first = await place();
    const replay = await place();
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(replay.body._id, first.body._id);
    assert.equal(first.body.total, 13.34);
    orderId = first.body._id;

    const paid = await request('/payments/demo', { ...headers(tokens.customer), method: 'POST', body: { orderId } });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.order.receiptStatus, 'valid');
    assert.ok(paid.body.order.receiptToken);

    const inspect = await request(`/receipts/${orderId}/inspect`, { ...headers(tokens.seller), method: 'POST', body: { token: paid.body.order.receiptToken } });
    assert.equal(inspect.status, 200);
    assert.equal(inspect.body.order.total, 13.34);
    assert.equal(inspect.body.receiptStatus, 'valid');
    assert.equal((await request(`/receipts/${orderId}/inspect`, { ...headers(tokens.customer), method: 'POST', body: { token: paid.body.order.receiptToken } })).status, 403);
    const adjusted = await request(`/products/${productId}/stock`, { ...headers(tokens.seller), method: 'PATCH', body: { quantity: -1, reason: 'Damaged item' } });
    assert.equal(adjusted.status, 200);
    assert.equal(adjusted.body.stock, 0);
    assert.equal((await request(`/products/${productId}/stock`, { ...headers(tokens.seller), method: 'PATCH', body: { quantity: -1, reason: 'Over correction' } })).status, 409);
    assert.equal((await request(`/products/${productId}/stock-movements`, headers(tokens.seller))).body[0].reason, 'Damaged item');

    const redeem = token => request(`/receipts/${orderId}/redeem`, { ...headers(token), method: 'POST', body: { token: paid.body.order.receiptToken } });
    const attempts = await Promise.all([redeem(tokens.seller), redeem(tokens.admin)]);
    assert.equal(attempts.filter(result => result.status === 200).length, 1);
    assert.equal(attempts.filter(result => result.status === 409).length, 1);
    assert.equal((await redeem(tokens.seller)).status, 409);
  } finally {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/queueless', { dbName: process.env.MONGO_DB_NAME || 'queueless' });
    const SmokeProduct = mongoose.model('SmokeProduct', new mongoose.Schema({}, { strict: false }), 'products');
    const SmokeOrder = mongoose.model('SmokeOrder', new mongoose.Schema({}, { strict: false }), 'orders');
    const SmokeAudit = mongoose.model('SmokeAudit', new mongoose.Schema({}, { strict: false }), 'auditlogs');
    if (orderId) {
      await SmokeAudit.deleteMany({ targetType: 'order', targetId: String(orderId), action: 'receipt.redeem' });
      await SmokeOrder.deleteOne({ _id: orderId });
    }
    if (productId) await SmokeProduct.deleteOne({ _id: productId });
    await mongoose.disconnect();
  }
});
