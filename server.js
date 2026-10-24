import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNetworkAdapter } from './network/adapter.js';

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const cookieName = 'connect_session';
const sessionLifetime = 8 * 60 * 60 * 1000;
const packages = [
  { id: '1h', name: '1 hour', kind: 'short-term', hours: 1 },
  { id: '2h', name: '2 hours', kind: 'short-term', hours: 2 },
  { id: '3h', name: '3 hours', kind: 'short-term', hours: 3 },
  { id: '6h', name: '6 hours', kind: 'short-term', hours: 6 },
  { id: '12h', name: '12 hours', kind: 'short-term', hours: 12 },
  { id: 'monthly', name: 'Monthly', kind: 'monthly', hours: null },
  { id: 'unlimited', name: 'Unlimited', kind: 'unlimited', hours: null },
];

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return scrypt(password, salt, 64).then((derived) => `${salt}:${derived.toString('hex')}`);
}

async function verifyPassword(password, stored) {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

function remainingFor(row, now) {
  if (row.kind !== 'short-term') return null;
  if (row.status !== 'connected' || !row.connected_at) return Math.max(0, row.remaining_seconds);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(row.connected_at)) / 1000));
  return Math.max(0, row.remaining_seconds - elapsed);
}

function publicCustomer(row, now) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    device: row.device,
    packageId: row.package_id,
    packageName: packages.find((item) => item.id === row.package_id)?.name ?? 'Unknown',
    kind: row.kind,
    status: row.status,
    remainingSeconds: remainingFor(row, now),
    createdAt: row.created_at,
  };
}

function validString(value, max = 120) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}

function validEmail(value) {
  return !value || (validString(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

export async function createApplication({
  dbPath = join(root, 'data', 'connect.sqlite'),
  mode = process.env.CONNECT_MODE === 'production' ? 'production' : 'demo',
  adminPassword = process.env.CONNECT_ADMIN_PASSWORD || 'ConnectDemo!2026',
  adminEmail = process.env.CONNECT_ADMIN_EMAIL || 'admin@connect.local',
  secureCookie = process.env.CONNECT_COOKIE_SECURE === 'true',
  seedDemo = true,
  now = Date.now,
  timerInterval = 1000,
} = {}) {
  if (!['demo', 'production'].includes(mode)) throw new Error('CONNECT_MODE must be demo or production');
  if (mode === 'production' && (adminPassword === 'ConnectDemo!2026' || adminPassword.length < 12)) {
    throw new Error('Set a unique CONNECT_ADMIN_PASSWORD with at least 12 characters before starting in production mode');
  }

  if (dbPath !== ':memory:') await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin'
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '',
      package_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'disconnected',
      remaining_seconds INTEGER NOT NULL DEFAULT 0, connected_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, customer_id TEXT, event_type TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KES', status TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
  `);

  const initialAdmin = db.prepare('SELECT id FROM admins LIMIT 1').get();
  if (!initialAdmin) {
    const passwordHash = await hashPassword(adminPassword);
    db.prepare('INSERT INTO admins(id, email, password_hash) VALUES(?, ?, ?)').run(randomUUID(), adminEmail.toLowerCase(), passwordHash);
  }

  if (seedDemo && mode === 'demo' && db.prepare('SELECT COUNT(*) AS count FROM customers').get().count === 0) {
    const createdAt = new Date(now()).toISOString();
    const insert = db.prepare(`INSERT INTO customers
      (id, name, email, device, package_id, kind, status, remaining_seconds, connected_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const samples = [
      ['Amina Wanjiku', 'amina@example.ke', 'Pixel 8 · ...4A:21', '2h', 'short-term', 'connected', 4860],
      ['Brian Otieno', 'brian@example.ke', 'iPhone 14 · ...B2:09', 'monthly', 'monthly', 'connected', 0],
      ['Njeri Kamau', 'njeri@example.ke', 'MacBook Air · ...18:CC', '6h', 'short-term', 'disconnected', 21600],
      ['David Mwangi', 'david@example.ke', 'Galaxy A54 · ...90:3D', 'unlimited', 'unlimited', 'disconnected', 0],
    ];
    for (const [name, email, device, packageId, kind, status, seconds] of samples) {
      const id = randomUUID();
      const startedAt = status === 'connected' && kind === 'short-term'
        ? new Date(now() - 900_000).toISOString()
        : null;
      insert.run(id, name, email, device, packageId, kind, status, seconds, startedAt, createdAt);
    }
  }

  const adapter = createNetworkAdapter(mode);
  const getCustomer = db.prepare('SELECT * FROM customers WHERE id = ?');
  const updateCustomer = db.prepare('UPDATE customers SET status = ?, remaining_seconds = ?, connected_at = ? WHERE id = ?');
  const addEvent = db.prepare('INSERT INTO events(id, customer_id, event_type, detail, created_at) VALUES(?, ?, ?, ?, ?)');
  const log = (customerId, eventType, detail = '') => addEvent.run(randomUUID(), customerId, eventType, detail, new Date(now()).toISOString());
  const expireDueSessions = () => {
    const instant = now();
    const active = db.prepare("SELECT * FROM customers WHERE kind = 'short-term' AND status = 'connected'").all();
    for (const row of active) {
      const remaining = remainingFor(row, instant);
      if (remaining !== 0) continue;
      try {
        adapter.enforceAccess(row.id);
        updateCustomer.run('expired', 0, null, row.id);
        log(row.id, 'session_expired', adapter.simulated ? 'Simulated access block applied' : 'Provider adapter enforced access');
      } catch (error) {
        log(row.id, 'enforcement_failed', error.message);
      }
    }
  };
  const timer = timerInterval > 0 ? setInterval(expireDueSessions, timerInterval) : null;
  timer?.unref();

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    const method = request.method;

    try {
      if (path.startsWith('/api/')) {
        if (method === 'POST' && path !== '/api/login') {
          const origin = request.headers.origin;
          if (origin && new URL(origin).host !== request.headers.host) {
            return sendJson(response, 403, { error: 'Cross-origin request rejected' });
          }
        }

        if (method === 'GET' && path === '/api/status') {
          const token = parseCookies(request.headers.cookie)[cookieName];
          const session = token && db.prepare(`SELECT a.id, a.email, a.role FROM admin_sessions s
            JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(await hashToken(token), now());
          return sendJson(response, 200, { authenticated: Boolean(session), admin: session ? { email: session.email, role: session.role } : null, mode, adapter: adapter.label });
        }

        if (method === 'POST' && path === '/api/login') {
          const body = await readBody(request);
          if (!validString(body.email, 254) || !validString(body.password, 256)) return sendJson(response, 400, { error: 'Enter a valid email and password' });
          const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(body.email.trim().toLowerCase());
          if (!admin || !(await verifyPassword(body.password, admin.password_hash))) return sendJson(response, 401, { error: 'Email or password is incorrect' });
          const token = randomBytes(32).toString('base64url');
          db.prepare('INSERT INTO admin_sessions(token_hash, admin_id, expires_at) VALUES(?, ?, ?)').run(await hashToken(token), admin.id, now() + sessionLifetime);
          log(null, 'admin_login', `Administrator signed in: ${admin.email}`);
          const cookie = `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}${secureCookie ? '; Secure' : ''}`;
          return sendJson(response, 200, { admin: { email: admin.email, role: admin.role }, mode }, { 'Set-Cookie': cookie });
        }

        const token = parseCookies(request.headers.cookie)[cookieName];
        const session = token && db.prepare(`SELECT a.id, a.email, a.role FROM admin_sessions s
          JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(await hashToken(token), now());
        if (!session) return sendJson(response, 401, { error: 'Administrator sign-in required' });

        if (method === 'POST' && path === '/api/logout') {
          db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(await hashToken(token));
          return sendJson(response, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}` });
        }

        if (method === 'POST' && path === '/api/password') {
          const body = await readBody(request);
          if (!validString(body.password, 256) || body.password.length < 12) return sendJson(response, 400, { error: 'New password must be at least 12 characters' });
          const hash = await hashPassword(body.password);
          db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, session.id);
          db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(session.id);
          log(null, 'admin_password_changed', `Administrator changed password: ${session.email}`);
          return sendJson(response, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}` });
        }

        if (method === 'GET' && path === '/api/bootstrap') {
          expireDueSessions();
          const instant = now();
          const customers = db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all().map((row) => publicCustomer(row, instant));
          const events = db.prepare('SELECT event_type AS type, detail, created_at AS at FROM events ORDER BY created_at DESC LIMIT 12').all();
          return sendJson(response, 200, {
            mode,
            network: { adapter: adapter.label, simulated: adapter.simulated },
            packages,
            customers,
            events,
            stats: {
              online: customers.filter((customer) => customer.status === 'connected').length,
              devices: customers.filter((customer) => customer.status === 'connected' && customer.device).length,
              subscribers: customers.length,
              shortTerm: customers.filter((customer) => customer.status === 'connected' && customer.kind === 'short-term').length,
              bandwidthMb: Number((customers.filter((customer) => customer.status === 'connected').length * 8.4).toFixed(1)),
            },
          });
        }

        if (method === 'GET' && path === '/api/network') {
          const stressed = (networkStressUntil > now());
          if (mode === 'production') return sendJson(response, 200, { simulated: false, available: false, adapter: adapter.label, download: null, upload: null, ping: null, stressed: false });
          const scale = stressed ? 0.28 : 1;
          return sendJson(response, 200, {
            simulated: true,
            available: true,
            adapter: adapter.label,
            download: Number((46 + Math.random() * 24).toFixed(1)) * scale,
            upload: Number((9 + Math.random() * 12).toFixed(1)) * scale,
            ping: Math.round(stressed ? 160 + Math.random() * 80 : 18 + Math.random() * 14),
            stressed,
            stressUntil: stressed ? networkStressUntil : null,
          });
        }

        if (method === 'POST' && path === '/api/network/stress') {
          if (mode !== 'demo') return sendJson(response, 409, { error: 'Stress simulation is available in demo mode only' });
          networkStressUntil = now() + 12_000;
          log(null, 'demo_stress_started', 'Simulated network stress test started');
          return sendJson(response, 200, { ok: true, until: networkStressUntil });
        }

        if (method === 'POST' && path === '/api/customers') {
          const body = await readBody(request);
          const selectedPackage = packages.find((item) => item.id === body.packageId);
          if (!validString(body.name, 120) || !validEmail(body.email) || (body.device && !validString(body.device, 160)) || !selectedPackage) {
            return sendJson(response, 400, { error: 'Name, package, and valid email/device details are required' });
          }
          const id = randomUUID();
          db.prepare(`INSERT INTO customers(id, name, email, device, package_id, kind, status, remaining_seconds, created_at)
            VALUES(?, ?, ?, ?, ?, ?, 'disconnected', ?, ?)`)
            .run(id, body.name.trim(), (body.email || '').trim().toLowerCase(), (body.device || '').trim(), selectedPackage.id, selectedPackage.kind, selectedPackage.hours ? selectedPackage.hours * 3600 : 0, new Date(now()).toISOString());
          log(id, 'customer_created', `Customer created: ${body.name.trim()}`);
          return sendJson(response, 201, { customer: publicCustomer(getCustomer.get(id), now()) });
        }

        const customerMatch = path.match(/^\/api\/customers\/([\w-]+)$/);
        if (customerMatch && method === 'PATCH') {
          const body = await readBody(request);
          const customer = getCustomer.get(customerMatch[1]);
          if (!customer) return sendJson(response, 404, { error: 'Customer not found' });
          if (customer.status === 'connected') return sendJson(response, 409, { error: 'Disconnect the customer before editing their subscription or device' });
          const selectedPackage = packages.find((item) => item.id === (body.packageId ?? customer.package_id));
          const name = body.name ?? customer.name;
          const email = body.email ?? customer.email;
          const device = body.device ?? customer.device;
          if (!validString(name, 120) || !validEmail(email) || (device && !validString(device, 160)) || !selectedPackage) return sendJson(response, 400, { error: 'Invalid customer details or package' });
          const remaining = selectedPackage.kind === customer.kind && selectedPackage.id === customer.package_id
            ? customer.remaining_seconds
            : selectedPackage.hours ? selectedPackage.hours * 3600 : 0;
          db.prepare(`UPDATE customers SET name = ?, email = ?, device = ?, package_id = ?, kind = ?, remaining_seconds = ?, status = 'disconnected'
            WHERE id = ?`).run(name.trim(), email.trim().toLowerCase(), device.trim(), selectedPackage.id, selectedPackage.kind, remaining, customer.id);
          log(customer.id, 'customer_updated', `Customer updated: ${name.trim()}`);
          return sendJson(response, 200, { customer: publicCustomer(getCustomer.get(customer.id), now()) });
        }

        if (customerMatch && method === 'DELETE') {
          const customer = getCustomer.get(customerMatch[1]);
          if (!customer) return sendJson(response, 404, { error: 'Customer not found' });
          if (customer.status === 'connected') return sendJson(response, 409, { error: 'Disconnect the customer before removal' });
          log(customer.id, 'customer_removed', `Customer removed: ${customer.name}`);
          db.prepare('DELETE FROM customers WHERE id = ?').run(customer.id);
          return sendJson(response, 200, { ok: true });
        }

        const connectionMatch = path.match(/^\/api\/customers\/([\w-]+)\/(connect|disconnect)$/);
        if (connectionMatch && method === 'POST') {
          const customer = getCustomer.get(connectionMatch[1]);
          if (!customer) return sendJson(response, 404, { error: 'Customer not found' });
          if (mode !== 'demo') return sendJson(response, 409, { error: 'No real provider adapter is configured; simulated connection controls are disabled' });
          if (connectionMatch[2] === 'connect') {
            if (customer.status === 'connected') return sendJson(response, 409, { error: 'Customer is already connected' });
            if (customer.kind === 'short-term' && remainingFor(customer, now()) <= 0) return sendJson(response, 409, { error: 'This session has expired. Assign a new package before reconnecting.' });
            updateCustomer.run('connected', customer.remaining_seconds, new Date(now()).toISOString(), customer.id);
            log(customer.id, 'device_connected', 'Simulated device connected');
          } else {
            if (customer.status !== 'connected') return sendJson(response, 409, { error: 'Customer is not connected' });
            const remaining = remainingFor(customer, now());
            updateCustomer.run(remaining === 0 && customer.kind === 'short-term' ? 'expired' : 'disconnected', remaining, null, customer.id);
            log(customer.id, 'device_disconnected', 'Simulated device disconnected; short-term time saved');
          }
          return sendJson(response, 200, { customer: publicCustomer(getCustomer.get(customer.id), now()) });
        }

        return sendJson(response, 404, { error: 'API route not found' });
      }

      if (method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (!['index.html', 'app.js', 'styles.css', 'telemetry.css'].includes(file)) return sendJson(response, 404, { error: 'Not found' });
      const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      response.writeHead(200, { 'Content-Type': contentTypes[extname(file)], 'Cache-Control': 'no-cache' });
      response.end(await readFile(join(root, 'public', file)));
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : 'Request failed' });
    }
  });

  let networkStressUntil = 0;
  return {
    server,
    db,
    close: async () => {
      if (timer) clearInterval(timer);
      if (server.listening) await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      db.close();
    },
  };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function readBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) {
      const error = new Error('Request body is too large');
      error.status = 413;
      throw error;
    }
  }
  try {
    const value = JSON.parse(raw || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error('Request body must be a JSON object');
    error.status = 400;
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.env.CONNECT_MODE === 'production' ? 'production' : 'demo';
  if (mode === 'production' && !process.env.CONNECT_ADMIN_PASSWORD) {
    console.error('Production mode requires CONNECT_ADMIN_PASSWORD.');
    process.exit(1);
  }
  const app = await createApplication({ mode });
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`Connect (${mode}) listening on http://localhost:${port}`);
    if (mode === 'demo') console.log('Demo network data is simulated. Change the seeded administrator password before deployment.');
  });
}