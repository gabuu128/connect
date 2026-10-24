const $ = (selector) => document.querySelector(selector);
const customerDialog = $('#customer-dialog');
const customerForm = $('#customer-form');
let state = null;
let paused = false;
let refreshTimer = null;
let refreshBusy = false;
let toastTimer = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function setPage(page) {
  document.querySelectorAll('.page-section').forEach((section) => {
    section.hidden = section.id !== `${page}-page`;
  });
  document.querySelectorAll('.nav-item[data-page]').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $('#page-title').textContent = page[0].toUpperCase() + page.slice(1);
  if (page === 'customers') renderCustomers();
}

function formatRemaining(seconds) {
  if (seconds === null) return 'No timer';
  if (seconds <= 0) return 'Expired';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  return `${remainder}s`;
}

function makeCustomerCell(customer) {
  const wrapper = document.createElement('div');
  wrapper.className = 'customer-person';
  const initial = document.createElement('span');
  initial.className = 'customer-initial';
  initial.textContent = customer.name.trim().slice(0, 1).toUpperCase();
  const details = document.createElement('span');
  const name = document.createElement('b');
  name.textContent = customer.name;
  const email = document.createElement('small');
  email.textContent = customer.email || 'No email added';
  details.append(name, email);
  wrapper.append(initial, details);
  return wrapper;
}

function makeRow(customer, withActions = false) {
  const row = document.createElement('tr');
  const person = document.createElement('td');
  person.append(makeCustomerCell(customer));
  row.append(person);

  const device = document.createElement('td');
  device.className = 'device-cell';
  device.textContent = customer.device || 'Not assigned';
  row.append(device);

  const plan = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = 'plan-chip';
  chip.textContent = customer.packageName;
  plan.append(chip);
  row.append(plan);

  const status = document.createElement('td');
  const statusLabel = document.createElement('span');
  statusLabel.className = `connection-status ${customer.status}`;
  const statusDot = document.createElement('i');
  const statusText = document.createElement('span');
  statusText.textContent = customer.status[0].toUpperCase() + customer.status.slice(1);
  statusLabel.append(statusDot, statusText);
  status.append(statusLabel);
  row.append(status);

  const time = document.createElement('td');
  time.className = customer.remainingSeconds === null ? 'no-timer' : 'time-left';
  time.textContent = customer.remainingSeconds === null ? '—' : formatRemaining(customer.remainingSeconds);
  row.append(time);

  if (withActions) {
    const actions = document.createElement('td');
    actions.className = 'row-actions';
    const connection = document.createElement('button');
    connection.className = 'mini-action';
    connection.textContent = customer.status === 'connected' ? 'Disconnect' : 'Connect';
    connection.disabled = customer.status === 'expired' || state.mode !== 'demo';
    connection.addEventListener('click', () => changeConnection(customer));
    const edit = document.createElement('button');
    edit.className = 'mini-action';
    edit.textContent = 'Edit';
    edit.disabled = customer.status === 'connected';
    edit.addEventListener('click', () => openCustomerDialog(customer));
    const remove = document.createElement('button');
    remove.className = 'mini-action danger';
    remove.textContent = 'Remove';
    remove.disabled = customer.status === 'connected';
    remove.addEventListener('click', () => removeCustomer(customer));
    actions.append(connection, edit, remove);
    row.append(actions);
  }
  return row;
}

function renderCustomers() {
  if (!state) return;
  const search = $('#customer-search').value.trim().toLowerCase();
  const filter = $('#status-filter').value;
  const customers = state.customers.filter((customer) => {
    const text = `${customer.name} ${customer.email} ${customer.device}`.toLowerCase();
    return text.includes(search) && (filter === 'all' || customer.status === filter);
  });
  const allRows = $('#all-customers');
  allRows.replaceChildren(...customers.map((customer) => makeRow(customer, true)));
  $('#empty-state').hidden = customers.length > 0;
  $('#result-count').textContent = `${customers.length} ${customers.length === 1 ? 'customer' : 'customers'}`;

  const recentRows = $('#recent-customers');
  recentRows.replaceChildren(...state.customers.slice(0, 5).map((customer) => makeRow(customer)));
  $('#nav-count').textContent = state.customers.length;
}

function renderPackages() {
  const counts = new Map();
  state.customers.forEach((customer) => counts.set(customer.packageId, (counts.get(customer.packageId) || 0) + 1));
  const grid = $('#package-grid');
  grid.replaceChildren(...state.packages.map((item) => {
    const card = document.createElement('article');
    card.className = `package-card ${item.kind === 'short-term' ? 'short-plan' : `${item.kind}-plan`}`;
    const count = document.createElement('span');
    count.className = 'package-count';
    count.textContent = `${counts.get(item.id) || 0} assigned`;
    const type = document.createElement('span');
    type.className = 'package-type';
    type.textContent = item.kind === 'short-term' ? 'PREPAID SESSION' : 'SUBSCRIPTION';
    const title = document.createElement('h3');
    title.textContent = item.name;
    const description = document.createElement('p');
    description.textContent = item.kind === 'short-term' ? 'Server-timed while connected' : 'No short-term countdown';
    card.append(count, type, title, description);
    return card;
  }));
}

function renderEvents() {
  const names = {
    admin_login: 'Administrator signed in',
    admin_password_changed: 'Administrator password changed',
    customer_created: 'Customer added',
    customer_updated: 'Customer details updated',
    customer_removed: 'Customer removed',
    device_connected: 'Device connected',
    device_disconnected: 'Device disconnected',
    session_expired: 'Session expired',
    enforcement_failed: 'Access enforcement failed',
    demo_stress_started: 'Simulated stress test started',
  };
  $('#event-list').replaceChildren(...state.events.map((event) => {
    const row = document.createElement('div');
    row.className = 'event-row';
    const bullet = document.createElement('i');
    bullet.className = 'event-bullet';
    const text = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = names[event.type] || event.type.replaceAll('_', ' ');
    const detail = document.createElement('small');
    detail.textContent = event.detail || 'Account activity';
    text.append(title, detail);
    const time = document.createElement('time');
    time.textContent = new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.append(bullet, text, time);
    return row;
  }));
}

function renderMode() {
  const demo = state.mode === 'demo';
  $('#sidebar-network-label').textContent = demo ? 'Demo network' : 'Production mode';
  $('#sidebar-network-mode').textContent = demo ? 'Simulated data' : 'Adapter not configured';
  $('#mode-banner').classList.toggle('production', !demo);
  $('#mode-banner p').replaceChildren();
  const strong = document.createElement('b');
  strong.textContent = demo ? 'Demo mode' : 'Production mode';
  $('#mode-banner p').append(strong, document.createTextNode(demo
    ? ' · Connections and network measurements are simulated. Subscriber data and server-side timers are persistent.'
    : ' · No network adapter configured. Real connections, bandwidth, and access enforcement are unavailable.'));
  $('#telemetry-tag').textContent = demo ? 'SIMULATED' : 'UNAVAILABLE';
  $('#telemetry-note').textContent = demo ? 'Illustrative demo readings' : 'Provider adapter required';
  $('#settings-mode-title').textContent = demo ? 'Demo mode' : 'Production mode';
  $('#settings-mode-copy').textContent = demo
    ? 'This environment uses simulated connection events and bandwidth readings. No real router is contacted.'
    : 'Production controls are disabled until an authorized provider network adapter has been implemented and configured.';
  $('#settings-adapter').textContent = state.network.adapter;
  $('#settings-adapter-detail').textContent = demo ? 'No credentials stored in the browser' : 'Connection and telemetry are unavailable';
  $('#stress-button').disabled = !demo;
  $('#stream-button').disabled = !demo;
}

function renderDashboard() {
  if (!state) return;
  const { stats } = state;
  $('#stat-online').textContent = stats.online;
  $('#stat-devices').textContent = stats.devices;
  $('#stat-subscribers').textContent = stats.subscribers;
  $('#stat-short-term').textContent = stats.shortTerm;
  $('#stat-bandwidth').textContent = stats.bandwidthMb.toFixed(1);
  $('#bandwidth-label').textContent = state.mode === 'demo' ? 'Simulated network throughput' : 'Real telemetry unavailable';
  renderMode();
  renderCustomers();
  renderPackages();
  renderEvents();
}

function drawBars(selector, peak, pausedStream) {
  const container = $(selector);
  if (!container.childElementCount) {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 42; index += 1) {
      const bar = document.createElement('i');
      bar.className = 'bar';
      fragment.append(bar);
    }
    container.append(fragment);
  }
  container.classList.toggle('paused', pausedStream);
  container.querySelectorAll('.bar').forEach((bar, index) => {
    const wave = Math.abs(Math.sin(index * 0.39 + Date.now() / 600));
    const height = pausedStream ? 8 : Math.max(10, Math.min(100, 15 + wave * peak * 0.76 + Math.random() * 12));
    bar.style.height = `${height}%`;
    bar.style.opacity = pausedStream ? '.2' : String(.46 + height / 190);
  });
}

function renderNetwork(network) {
  const unavailable = !network.available;
  if (paused && !unavailable) return;
  $('#download-speed').textContent = unavailable ? '—' : network.download.toFixed(1);
  $('#upload-speed').textContent = unavailable ? '—' : network.upload.toFixed(1);
  $('#ping-value').textContent = unavailable ? '—' : network.ping;
  $('#ping-quality').textContent = unavailable ? 'No provider signal' : network.ping < 50 ? 'Excellent response' : network.ping < 100 ? 'Fair response' : 'High latency';
  $('#ping-fill').style.width = unavailable ? '0' : `${Math.min(100, network.ping / 2)}%`;
  $('#ping-fill').style.background = network.ping < 50 ? '#82d69a' : network.ping < 100 ? '#e6c26c' : '#f17d68';
  $('#network-warning').hidden = !network.stressed;
  if (network.stressed) $('#stress-button').textContent = 'ϟ  Stress test running';
  else if (state.mode === 'demo') $('#stress-button').innerHTML = '<span>ϟ</span> Simulate network stress test';
  if (!paused && !unavailable) {
    drawBars('#download-bars', Math.min(100, network.download * 1.25), false);
    drawBars('#upload-bars', Math.min(100, network.upload * 3.1), false);
  } else {
    drawBars('#download-bars', 0, true);
    drawBars('#upload-bars', 0, true);
  }
}

async function refresh() {
  if (refreshBusy || !state) return;
  refreshBusy = true;
  try {
    const [data, network] = await Promise.all([api('/api/bootstrap'), api('/api/network')]);
    state = data;
    renderDashboard();
    renderNetwork(network);
  } catch (error) {
    showToast(error.message);
  } finally {
    refreshBusy = false;
  }
}

async function enterApplication() {
  const status = await api('/api/status');
  if (!status.authenticated) {
    $('#login-screen').hidden = false;
    $('#app-shell').hidden = true;
    return;
  }
  $('#login-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#admin-email').textContent = status.admin.email;
  $('#current-date').textContent = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  state = await api('/api/bootstrap');
  renderDashboard();
  renderNetwork(await api('/api/network'));
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 1000);
}

async function changeConnection(customer) {
  const action = customer.status === 'connected' ? 'disconnect' : 'connect';
  try {
    await api(`/api/customers/${customer.id}/${action}`, { method: 'POST', body: '{}' });
    await refresh();
    showToast(action === 'connect' ? 'Simulated device connected' : 'Session saved and paused');
  } catch (error) { showToast(error.message); }
}

function openCustomerDialog(customer = null) {
  customerForm.reset();
  $('#dialog-error').textContent = '';
  customerForm.elements.id.value = customer?.id || '';
  customerForm.elements.name.value = customer?.name || '';
  customerForm.elements.email.value = customer?.email || '';
  customerForm.elements.device.value = customer?.device || '';
  $('#dialog-title').textContent = customer ? 'Edit customer' : 'Add customer';
  $('#dialog-eyebrow').textContent = customer ? 'CUSTOMER DETAILS' : 'NEW SUBSCRIBER';
  const select = customerForm.elements.packageId;
  select.replaceChildren(...state.packages.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    return option;
  }));
  select.value = customer?.packageId || '1h';
  customerDialog.showModal();
}

async function saveCustomer() {
  if (!customerForm.reportValidity()) return;
  const form = new FormData(customerForm);
  const id = form.get('id');
  const customer = Object.fromEntries(['name', 'email', 'device', 'packageId'].map((key) => [key, form.get(key)]));
  try {
    await api(id ? `/api/customers/${id}` : '/api/customers', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(customer) });
    customerDialog.close();
    await refresh();
    showToast(id ? 'Customer updated' : 'Customer added');
  } catch (error) { $('#dialog-error').textContent = error.message; }
}

async function removeCustomer(customer) {
  if (!confirm(`Remove ${customer.name}? This cannot be undone.`)) return;
  try {
    await api(`/api/customers/${customer.id}`, { method: 'DELETE' });
    await refresh();
    showToast('Customer removed');
  } catch (error) { showToast(error.message); }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
    $('#login-error').textContent = '';
    await enterApplication();
  } catch (error) { $('#login-error').textContent = error.message; }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch { /* Expired sessions return to login as well. */ }
  clearInterval(refreshTimer);
  await enterApplication();
});

document.querySelectorAll('.nav-item[data-page]').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.page)));
document.querySelectorAll('[data-go]').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.go)));
$('#add-customer-button').addEventListener('click', () => openCustomerDialog());
$('#save-customer').addEventListener('click', saveCustomer);
$('#customer-search').addEventListener('input', renderCustomers);
$('#status-filter').addEventListener('change', renderCustomers);
$('#refresh-button').addEventListener('click', refresh);
$('#stream-button').addEventListener('click', () => {
  paused = !paused;
  $('#stream-button').innerHTML = paused ? '▶ &nbsp;Resume stream' : 'Ⅱ &nbsp;Pause stream';
  $('#stream-label').textContent = paused ? 'PAUSED' : 'STREAMING';
  $('#stream-dot').style.background = paused ? '#e6c26c' : '#6ad58c';
  if (!paused) refresh();
});
$('#stress-button').addEventListener('click', async () => {
  try { await api('/api/network/stress', { method: 'POST', body: '{}' }); await refresh(); }
  catch (error) { showToast(error.message); }
});
$('.banner-close').addEventListener('click', () => { $('#mode-banner').hidden = true; });

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const passwordForm = event.currentTarget;
  const form = new FormData(passwordForm);
  const message = $('#password-message');
  message.textContent = '';
  if (form.get('password') !== form.get('confirm')) { message.textContent = 'Passwords do not match.'; message.style.color = '#bd4941'; return; }
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ password: form.get('password') }) });
    clearInterval(refreshTimer);
    passwordForm.reset();
    await enterApplication();
    $('#login-error').textContent = 'Password updated. Sign in with your new password.';
  } catch (error) { message.textContent = error.message; message.style.color = '#bd4941'; }
});

enterApplication().catch((error) => showToast(error.message));