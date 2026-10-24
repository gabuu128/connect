import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.js';

async function withServer(run, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'connect-test-'));
  const dbPath = join(folder, 'connect.sqlite');
  let app;
  try {
    app = await createApplication({ dbPath, seedDemo: false, timerInterval: 0, adminPassword: 'A-Strong-Private-Test-Password', ...options });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    await run({ app, dbPath, origin, replaceApplication: (next) => { app = next; } });
  } finally {
    if (app) await app.close();
    await rm(folder, { recursive: true, force: true });
  }
}

async function request(origin, path, { cookie, ...options } = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...options.headers };
  const response = await fetch(`${origin}${path}`, { ...options, headers });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function signIn(origin, password = 'A-Strong-Private-Test-Password') {
  const { response, body, cookie } = await request(origin, '/api/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@connect.local', password }),
  });
  assert.equal(response.status, 200, body.error);
  return cookie;
}

test('admin API protects changes and session timers persist, pause, resume, and expire server-side', async () => {
  let instant = Date.parse('2026-10-24T10:00:00Z');
  await withServer(async ({ app, dbPath, origin, replaceApplication }) => {
    let result = await request(origin, '/');
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('content-type'), /text\/html/);
    result = await request(origin, '/app.js');
    assert.equal(result.response.status, 200, 'dashboard interactions are served by the application');
    result = await request(origin, '/styles.css');
    assert.equal(result.response.status, 200, 'dashboard styles are served by the application');
    result = await request(origin, '/telemetry.css');
    assert.equal(result.response.status, 200, 'segmented bandwidth styles are served by the application');

    result = await request(origin, '/api/bootstrap');
    assert.equal(result.response.status, 401, 'unauthorized API requests are rejected');

    const badLogin = await request(origin, '/api/login', {
      method: 'POST', body: JSON.stringify({ email: 'admin@connect.local', password: 'wrong-password' }),
    });
    assert.equal(badLogin.response.status, 401, 'incorrect password is rejected');

    const cookie = await signIn(origin);
    const invalidCustomer = await request(origin, '/api/customers', {
      method: 'POST', cookie, body: JSON.stringify({ name: '', packageId: '1h' }),
    });
    assert.equal(invalidCustomer.response.status, 400, 'invalid customer data is rejected');
    const invalidEmail = await request(origin, '/api/customers', {
      method: 'POST', cookie, body: JSON.stringify({ name: 'Invalid Email', email: 'not-an-email', packageId: '1h' }),
    });
    assert.equal(invalidEmail.response.status, 400, 'invalid email addresses are rejected');

    const created = await request(origin, '/api/customers', {
      method: 'POST', cookie, body: JSON.stringify({ name: 'Amina Wanjiku', email: 'amina@example.ke', device: 'Phone · 01:AB', packageId: '1h' }),
    });
    assert.equal(created.response.status, 201);
    const customerId = created.body.customer.id;

    result = await request(origin, `/api/customers/${customerId}`, {
      method: 'PATCH', cookie, body: JSON.stringify({ name: 'Amina Wanjiku Updated', packageId: '2h' }),
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.customer.remainingSeconds, 7200, 'changing packages assigns the new package duration');
    result = await request(origin, `/api/customers/${customerId}`, {
      method: 'PATCH', cookie, body: JSON.stringify({ name: 'Amina Wanjiku', packageId: '1h' }),
    });
    assert.equal(result.body.customer.remainingSeconds, 3600);

    result = await request(origin, '/api/bootstrap', { cookie });
    assert.equal(result.body.stats.subscribers, 1);
    assert.equal(result.body.stats.online, 0);

    result = await request(origin, `/api/customers/${customerId}/connect`, { method: 'POST', cookie, body: '{}' });
    assert.equal(result.response.status, 200);
    const editConnected = await request(origin, `/api/customers/${customerId}`, {
      method: 'PATCH', cookie, body: JSON.stringify({ name: 'Blocked Edit' }),
    });
    assert.equal(editConnected.response.status, 409, 'connected subscription time cannot be edited');
    instant += 10 * 60 * 1000;
    result = await request(origin, '/api/bootstrap', { cookie });
    assert.equal(result.body.customers[0].remainingSeconds, 3000, 'timer subtracts server-measured connected time');
    assert.equal(result.body.stats.online, 1);

    result = await request(origin, `/api/customers/${customerId}/disconnect`, { method: 'POST', cookie, body: '{}' });
    assert.equal(result.response.status, 200);
    instant += 4 * 60 * 60 * 1000;
    result = await request(origin, '/api/bootstrap', { cookie });
    assert.equal(result.body.customers[0].remainingSeconds, 3000, 'remaining time is frozen while disconnected');
    assert.equal(result.body.stats.online, 0);

    app.now = () => instant;
    await app.close();
    const reopened = await createApplication({ dbPath, seedDemo: false, timerInterval: 0, adminPassword: 'ignored-after-first-run', now: () => instant });
    app = reopened;
    replaceApplication(reopened);
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const newOrigin = `http://127.0.0.1:${app.server.address().port}`;
    const continuedCookie = await signIn(newOrigin);
    result = await request(newOrigin, '/api/bootstrap', { cookie: continuedCookie });
    assert.equal(result.body.customers[0].remainingSeconds, 3000, 'database restart preserves saved time and account');

    await request(newOrigin, `/api/customers/${customerId}/connect`, { method: 'POST', cookie: continuedCookie, body: '{}' });
    instant += 60 * 60 * 1000;
    result = await request(newOrigin, '/api/bootstrap', { cookie: continuedCookie });
    assert.equal(result.body.customers[0].status, 'expired', 'server expires a fully consumed session');
    assert.equal(result.body.stats.shortTerm, 0);
    assert.equal(result.body.events.some((event) => event.type === 'session_expired' && event.detail.includes('Simulated')), true);
    const expiredReconnect = await request(newOrigin, `/api/customers/${customerId}/connect`, { method: 'POST', cookie: continuedCookie, body: '{}' });
    assert.equal(expiredReconnect.response.status, 409, 'expired short-term access cannot be restored by reconnecting');

    const monthly = await request(newOrigin, '/api/customers', {
      method: 'POST', cookie: continuedCookie, body: JSON.stringify({ name: 'Monthly Member', packageId: 'monthly' }),
    });
    const monthlyId = monthly.body.customer.id;
    assert.equal(monthly.body.customer.remainingSeconds, null);
    await request(newOrigin, `/api/customers/${monthlyId}/connect`, { method: 'POST', cookie: continuedCookie, body: '{}' });
    instant += 48 * 60 * 60 * 1000;
    const refreshedCookie = await signIn(newOrigin);
    result = await request(newOrigin, '/api/bootstrap', { cookie: refreshedCookie });
    const monthlyResult = result.body.customers.find((customer) => customer.id === monthlyId);
    assert.equal(monthlyResult.status, 'connected', 'monthly subscribers are excluded from short-term expiry');
    assert.equal(monthlyResult.remainingSeconds, null);
    assert.equal(result.body.stats.online, 1);

    const baselineNetwork = await request(newOrigin, '/api/network', { cookie: refreshedCookie });
    const stress = await request(newOrigin, '/api/network/stress', { method: 'POST', cookie: refreshedCookie, body: '{}' });
    assert.equal(stress.response.status, 200);
    result = await request(newOrigin, '/api/network', { cookie: refreshedCookie });
    assert.equal(result.body.simulated, true);
    assert.equal(result.body.stressed, true);
    assert.ok(result.body.ping >= 160);
    assert.ok(result.body.download < baselineNetwork.body.download, 'stress test reduces the simulated download speed');
    instant += 12_001;
    result = await request(newOrigin, '/api/network', { cookie: refreshedCookie });
    assert.equal(result.body.stressed, false, 'stress test recovers after its simulation window');

    const removed = await request(newOrigin, `/api/customers/${customerId}`, { method: 'DELETE', cookie: refreshedCookie });
    assert.equal(removed.response.status, 200);
    result = await request(newOrigin, '/api/bootstrap', { cookie: refreshedCookie });
    assert.equal(result.body.stats.subscribers, 1, 'dashboard counts update after removal');

    const logout = await request(newOrigin, '/api/logout', { method: 'POST', cookie: refreshedCookie, body: '{}' });
    assert.equal(logout.response.status, 200);
    result = await request(newOrigin, '/api/bootstrap', { cookie: refreshedCookie });
    assert.equal(result.response.status, 401, 'logout revokes the server-side session');
  }, { mode: 'demo', now: () => instant });
});

test('production mode has no simulated connections or measurements and requires an initial secret', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'connect-production-'));
  const dbPath = join(folder, 'connect.sqlite');
  let app;
  try {
    await assert.rejects(createApplication({ dbPath, mode: 'production', adminPassword: 'ConnectDemo!2026', timerInterval: 0 }), /CONNECT_ADMIN_PASSWORD/);
    await assert.rejects(createApplication({ dbPath, mode: 'production', adminPassword: 'too-short', timerInterval: 0 }), /at least 12 characters/);
    app = await createApplication({ dbPath, mode: 'production', adminPassword: 'A-Strong-Production-Secret', timerInterval: 0 });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const cookie = await signIn(origin, 'A-Strong-Production-Secret');
    const customer = await request(origin, '/api/customers', {
      method: 'POST', cookie, body: JSON.stringify({ name: 'Production Subscriber', packageId: '1h' }),
    });
    const connect = await request(origin, `/api/customers/${customer.body.customer.id}/connect`, { method: 'POST', cookie, body: '{}' });
    assert.equal(connect.response.status, 409);
    const network = await request(origin, '/api/network', { cookie });
    assert.equal(network.body.available, false);
    assert.equal(network.body.simulated, false);
    assert.equal(network.body.download, null);
  } finally {
    if (app) await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('password updates enforce length, revoke old sessions, and reject cross-origin writes', async () => {
  await withServer(async ({ origin }) => {
    const cookie = await signIn(origin);
    let result = await request(origin, '/api/password', {
      method: 'POST', cookie, body: JSON.stringify({ password: 'too-short' }),
    });
    assert.equal(result.response.status, 400);

    result = await request(origin, '/api/customers', {
      method: 'POST', cookie, headers: { Origin: 'https://attacker.example' },
      body: JSON.stringify({ name: 'Cross-origin', packageId: '1h' }),
    });
    assert.equal(result.response.status, 403);

    const newPassword = 'A-New-Strong-Password-2026';
    result = await request(origin, '/api/password', {
      method: 'POST', cookie, body: JSON.stringify({ password: newPassword }),
    });
    assert.equal(result.response.status, 200);
    result = await request(origin, '/api/bootstrap', { cookie });
    assert.equal(result.response.status, 401, 'the old cookie is revoked after a password update');
    const newCookie = await signIn(origin, newPassword);
    result = await request(origin, '/api/bootstrap', { cookie: newCookie });
    assert.equal(result.response.status, 200);
  });
});