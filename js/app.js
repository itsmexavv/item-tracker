// Item Tracker UI: hash-routed views (items, map, settings, find), bottom sheets,
// and the left-behind / find-my-phone alarms.
import * as alarm from './alarm.js';
import * as ble from './ble.js';
import * as db from './db.js';
import * as geo from './geo.js';
import * as mapView from './map.js';
import { angleDiff, bearing, cardinal, distance, normalizeDeg } from './geo-math.js';
import { formatDistance, html, raw, stamp, str, timeAgo } from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);
const uuid = () => crypto.randomUUID();

const EMOJI = ['🔑', '👛', '💼', '🎒', '📱', '💻', '🎧', '⌚', '👓', '🧳', '🚲', '🚗', '🐶', '🐱', '☂️', '📷', '🎮', '💳', '🪪', '🧸', '⚽', '🎸', '📦', '🏷️'];
const EVENT_LABEL = { spot: '📍 Spot saved', connect: '🔗 Connected', disconnect: '⚠️ Left behind', reconnect: '✅ Back in range', found: '🎉 Found' };
const SOURCE_LABEL = {
  manual: 'saved by you',
  map: 'placed on the map',
  disconnect: 'where Bluetooth was lost',
  connected: 'with you (Bluetooth)',
  found: 'where you found it',
};
const TITLES = { items: 'Items', map: 'Map', settings: 'Settings', find: 'Find' };

// --- Settings (per device) ---

const SETTINGS_KEY = 'item-tracker.settings';
const MONITORING_KEY = 'item-tracker.monitoring';
const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage blocked: settings last until reload */ }
  },
};
const settings = { alarmDelay: 5, sound: true, tagBeep: true, ...parseJson(store.get(SETTINGS_KEY)) };

function parseJson(text) {
  try { return JSON.parse(text) ?? {}; } catch { return {}; }
}

function applySettings() {
  ble.configure({ graceMs: settings.alarmDelay * 1000, tagBeep: settings.tagBeep });
}

// --- State ---

const state = {
  items: [],
  route: { name: 'items' },
  monitoring: false,
  alarms: new Map(), // itemId → { at }: left-behind alarms on screen
  ringingPhone: null, // itemId whose tag button is ringing this phone
  ringingTags: new Map(), // itemId → stop(): tags currently beeping
  dropFixes: new Map(), // itemId → our position when its connection dropped
  installPrompt: null,
};
const byId = (id) => state.items.find((i) => i.id === id);
let releaseMonitorGps = null;

// --- Startup ---

async function init() {
  applySettings();
  state.items = await db.listItems();
  wireEvents();
  route();
  registerServiceWorker();
  db.persistStorage();
  if ((await geo.permission()) === 'granted') geo.quickFix();
  if (store.get(MONITORING_KEY) === '1' && ble.supported && state.items.some((i) => i.ble)) {
    showBanner('Monitoring stopped when the app closed.', 'Start again', startMonitoring);
  }
  setInterval(() => {
    if (document.visibilityState === 'visible') scheduleRender();
  }, 30000);
}

function wireEvents() {
  // Capture phase, because Leaflet stops clicks inside map popups from bubbling.
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onSettingChange);
  document.addEventListener('visibilitychange', scheduleRender);
  window.addEventListener('hashchange', route);
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('#install-btn').hidden = false;
    if (state.route.name === 'settings') renderSettings();
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    $('#install-btn').hidden = true;
  });
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate') location.hash = e.data.hash;
  });

  ble.on('change', scheduleRender);
  ble.on('dropped', ({ itemId }) => state.dropFixes.set(itemId, geo.current(30000)));
  ble.on('lost', onLost);
  ble.on('back', onBack);
  ble.on('connected', onConnected);
  ble.on('button', onTagButton);
  geo.onPosition(onPosition);

  const sheet = $('#sheet');
  sheet.addEventListener('close', () => {
    if (!sheet.open) runSheetClose();
  });
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeSheet(); // tap on the backdrop
  });
  // `close` fires a moment after closing; ignore it if the dialog has reopened since.
  const alarmDialog = $('#alarm-dialog');
  alarmDialog.addEventListener('close', () => {
    if (!alarmDialog.open && state.alarms.size) silenceAlarms();
  });
  const ringDialog = $('#ring-dialog');
  ringDialog.addEventListener('close', () => {
    if (!ringDialog.open && state.ringingPhone) stopRingingPhone();
  });
}

// --- Routing ---

function parseRoute() {
  const [name, a, b] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (name === 'find' && a) return { name: 'find', id: a };
  if (name === 'map') return a === 'place' ? { name: 'map', placeId: b } : { name: 'map', focusId: a || null };
  if (name === 'settings') return { name: 'settings' };
  return { name: 'items' };
}

let leaveRoute = null;

function route() {
  leaveRoute?.();
  leaveRoute = null;
  const r = (state.route = parseRoute());
  for (const name of ['items', 'map', 'settings']) $(`#view-${name}`).hidden = name !== r.name;
  $('#view-find').hidden = r.name !== 'find';
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#title').textContent = TITLES[r.name];
  if (r.name === 'items') renderItems();
  if (r.name === 'settings') renderSettings();
  if (r.name === 'map') leaveRoute = enterMap(r);
  if (r.name === 'find') leaveRoute = enterFind(r.id);
}

function goBack() {
  if (history.length > 1) history.back();
  else location.replace('#/items');
}

let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (state.route.name === 'items') renderItems();
    if (state.route.name === 'map') mapView.update({ items: state.items, here: geo.current() });
  });
}

// --- Actions (any element with data-action) ---

const actions = {
  add: () => openEditor(),
  detail: (id) => openDetail(id),
  edit: (id) => openEditor(byId(id)),
  'delete-item': (id) => deleteItem(id),
  spot: (id) => markSpot(id),
  find: (id) => {
    closeSheet();
    location.hash = `#/find/${id}`;
  },
  'show-map': (id) => {
    closeSheet();
    location.hash = `#/map/${id}`;
  },
  'place-on-map': (id) => {
    closeSheet();
    location.hash = `#/map/place/${id}`;
  },
  'place-confirm': (id) => placeHere(id),
  'place-cancel': () => goBack(),
  'move-pin': (id) => {
    if (mapView.enableDrag(id)) toast('Drag the pin to the right spot.');
  },
  ring: (id, button) => ringTag(id, button),
  pick: (id) => reconnectWithPicker(id),
  'monitor-start': () => startMonitoring(),
  'monitor-stop': () => stopMonitoring(),
  found: (id) => foundIt(id),
  back: () => goBack(),
  compass: async () => {
    if (await geo.requestCompass()) route();
    else toast('Compass access was denied.');
  },
  'alarm-find': (id) => {
    state.alarms.delete(id);
    updateAlarm();
    location.hash = `#/find/${id}`;
  },
  'alarm-ok': (id) => {
    ble.dismiss(id);
    state.alarms.delete(id);
    alarm.clearNotification(`lost-${id}`);
    updateAlarm();
  },
  'ring-stop': () => stopRingingPhone(),
  'sheet-close': () => closeSheet(),
  'test-alarm': () => {
    alarm.unlockAudio();
    alarm.startSiren({ sound: true });
    setTimeout(() => {
      if (!state.alarms.size && !state.ringingPhone) alarm.stopSiren();
    }, 3000);
  },
  'notify-on': async () => {
    await alarm.enableNotifications();
    renderSettings();
  },
  install: () => installApp(),
  wipe: () => wipeAll(),
};

function onClick(e) {
  const target = e.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = actions[target.dataset.action];
  if (!action) return;
  e.preventDefault();
  action(target.dataset.id, target);
}

// --- Items view ---

function renderItems() {
  const here = geo.current();
  $('#view-items').innerHTML = str(html`
    ${monitorBar()}
    ${state.items.length
      ? html`<ul class="items">${state.items.map((item) => itemCard(item, here))}</ul>`
      : html`<div class="empty">
          <div class="empty-icon" aria-hidden="true">🧭</div>
          <h2>Never lose track again</h2>
          <p>Add the things you carry around. Link Bluetooth tags for a left-behind alarm, or save where you put anything else.</p>
        </div>`}
    <button class="fab" data-action="add">＋ Add item</button>`);
}

function monitorBar() {
  const linked = state.items.filter((i) => i.ble);
  if (!linked.length) return '';
  if (!ble.supported) {
    return html`<p class="note">This browser can't use Bluetooth. Open the app in Chrome on Android, or Chrome or Edge on a computer, to get left-behind alarms.</p>`;
  }
  if (!state.monitoring) {
    return html`<section class="monitor">
      <div class="monitor-text"><strong>Left-behind alarm is off</strong><span>Start it before you head out, and keep the app open on screen.</span></div>
      <button class="primary" data-action="monitor-start">Start monitoring</button>
    </section>`;
  }
  const connected = linked.filter((i) => ble.status(i.id).state === 'connected').length;
  const when = settings.alarmDelay ? `after ${settings.alarmDelay} s out of range` : 'as soon as an item is out of range';
  return html`<section class="monitor on">
    <div class="monitor-text">
      <strong><span class="pulse" aria-hidden="true"></span>Monitoring · ${connected} of ${linked.length} connected</strong>
      <span>Keep this app open on screen. The alarm sounds ${when}.</span>
    </div>
    <button data-action="monitor-stop">Stop</button>
  </section>`;
}

function itemStatus(item) {
  if (ble.supported && item.ble) {
    const b = ble.status(item.id);
    if (b.lost) return { tone: 'bad', text: `⚠️ Left behind ${timeAgo(b.lostAt)}`, showsTime: true };
    if (b.state === 'connected') return { tone: 'ok', text: `● Connected${b.battery != null ? ` · 🔋 ${b.battery}%` : ''}` };
    if (b.monitored && b.needsPick) return { tone: 'warn', text: 'Tap Reconnect to watch it' };
    if (b.monitored) return { tone: 'warn', text: b.state === 'connecting' ? 'Connecting…' : 'Searching…' };
  }
  if (item.lastSeen) return { tone: '', text: `Last seen ${timeAgo(item.lastSeen.at)}`, showsTime: true };
  return { tone: 'muted', text: 'No spot saved yet' };
}

/** "120 m away", or "right here" when it's within GPS accuracy. */
function awayText(here, spot) {
  if (!here || !spot) return null;
  const meters = distance(here, spot);
  return meters <= Math.max(15, here.acc ?? 0) ? 'right here' : `${formatDistance(meters)} away`;
}

function itemCard(item, here) {
  const status = itemStatus(item);
  const seen = item.lastSeen;
  const withYou = status.tone === 'ok'; // connected over Bluetooth, so no need for time or distance
  const meta = [
    !withYou && !status.showsTime && seen ? `Last seen ${timeAgo(seen.at)}` : null,
    withYou ? null : awayText(here, seen),
    seen?.note,
  ].filter(Boolean).join(' · ');
  const b = ble.status(item.id);
  let bleButton = '';
  if (ble.supported && item.ble) {
    bleButton = b.needsPick
      ? html`<button class="accent" data-action="pick" data-id="${item.id}">🔄 Reconnect</button>`
      : html`<button data-action="ring" data-id="${item.id}">${state.ringingTags.has(item.id) ? '🔕 Stop' : '🔔 Ring'}</button>`;
  }
  return html`<li class="item ${status.tone}" data-id="${item.id}">
    <button class="item-main" data-action="detail" data-id="${item.id}">
      <span class="item-emoji" aria-hidden="true">${item.emoji}</span>
      <span class="item-text">
        <span class="item-name">${item.name}</span>
        <span class="item-status">${status.text}</span>
        ${meta ? html`<span class="item-meta">${meta}</span>` : ''}
      </span>
    </button>
    <div class="item-actions">
      <button data-action="spot" data-id="${item.id}">📍 Left it here</button>
      <button data-action="find" data-id="${item.id}" ${seen ? '' : raw('disabled')}>🧭 Find</button>
      ${bleButton}
    </div>
  </li>`;
}

// --- Sheets ---

let sheetClose = null;

function showSheet(content, { onClose } = {}) {
  closeSheet();
  const sheet = $('#sheet');
  sheet.innerHTML = str(content);
  sheetClose = onClose ?? null;
  sheet.showModal();
}

function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.open) sheet.close();
  runSheetClose();
}

function runSheetClose() {
  const fn = sheetClose;
  sheetClose = null;
  fn?.();
}

async function openDetail(id) {
  const item = byId(id);
  if (!item) return;
  const events = await db.listEvents(id, 30);
  const here = geo.current();
  const status = itemStatus(item);
  const seen = item.lastSeen;
  const where = seen
    ? [
      `Last seen ${stamp(seen.at)} (${timeAgo(seen.at)})`,
      SOURCE_LABEL[seen.source],
      awayText(here, seen),
      seen.acc ? `±${Math.round(seen.acc)} m` : null,
    ].filter(Boolean).join(' · ')
    : 'No spot saved yet.';
  showSheet(html`<div class="sheet-body">
    <header class="detail-head">
      <span class="item-emoji big" aria-hidden="true">${item.emoji}</span>
      <div>
        <h2 tabindex="-1" autofocus>${item.name}</h2>
        ${item.note ? html`<p class="muted">${item.note}</p>` : ''}
        ${item.ble ? html`<p class="muted small">🔗 ${item.ble.name ?? 'Bluetooth device'}</p>` : ''}
      </div>
    </header>
    ${status.tone && status.tone !== 'muted' ? html`<p class="detail-status ${status.tone}">${status.text}</p>` : ''}
    <p>${where}${seen?.note ? html`<br><em>${seen.note}</em>` : ''}</p>
    <div class="detail-actions">
      <button data-action="spot" data-id="${id}">📍 Left it here</button>
      <button data-action="find" data-id="${id}" ${seen ? '' : raw('disabled')}>🧭 Find</button>
      <button data-action="show-map" data-id="${id}">🗺️ Map</button>
      ${ble.supported && item.ble ? html`<button data-action="ring" data-id="${id}">🔔 Ring</button>` : ''}
      <button data-action="edit" data-id="${id}">✏️ Edit</button>
    </div>
    <h3>History</h3>
    ${events.length
      ? html`<ol class="timeline">${events.map((ev) => html`<li>
          <span>${EVENT_LABEL[ev.type] ?? ev.type}${ev.source === 'map' ? ' (on map)' : ''}${ev.note ? html` · <em>${ev.note}</em>` : ''}</span>
          <span class="when">${stamp(ev.at)}</span>
        </li>`)}</ol>`
      : html`<p class="muted">Nothing yet.</p>`}
  </div>`);
}

function openEditor(item) {
  const draft = item
    ? { ...item }
    : { id: uuid(), name: '', emoji: '🔑', note: '', ble: null, lastSeen: null, createdAt: Date.now() };
  let device = null;
  showSheet(html`<form class="sheet-body" id="editor" autocomplete="off">
    <h2 tabindex="-1" ${item ? raw('autofocus') : ''}>${item ? 'Edit item' : 'New item'}</h2>
    <label class="field"><span>Name</span>
      <input name="item-name" required maxlength="40" placeholder="Keys, wallet, earbuds…" value="${draft.name}" ${item ? '' : raw('autofocus')}>
    </label>
    <fieldset class="field">
      <legend>Icon</legend>
      <div class="emoji-grid">${EMOJI.map((e) => html`<button type="button" class="emoji-opt" data-emoji="${e}" aria-pressed="${e === draft.emoji}">${e}</button>`)}</div>
    </fieldset>
    <label class="field"><span>Note <span class="muted">(optional)</span></span>
      <input name="item-note" maxlength="80" placeholder="e.g. blue keyring" value="${draft.note ?? ''}">
    </label>
    <div id="ble-field"></div>
    <div class="sheet-actions">
      ${item ? html`<button type="button" class="ghost danger" data-action="delete-item" data-id="${item.id}">Delete</button>` : ''}
      <button type="button" class="ghost" data-action="sheet-close">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div>
  </form>`);

  const form = $('#editor');
  const paintBle = () => {
    $('#ble-field', form).innerHTML = str(bleField(draft));
  };
  paintBle();

  form.addEventListener('click', async (e) => {
    const emoji = e.target.closest('[data-emoji]');
    if (emoji) {
      draft.emoji = emoji.dataset.emoji;
      form.querySelectorAll('[data-emoji]').forEach((b) => b.setAttribute('aria-pressed', String(b === emoji)));
      return;
    }
    if (e.target.closest('[data-ble="unlink"]')) {
      draft.ble = null;
      device = null;
      paintBle();
      return;
    }
    if (!e.target.closest('[data-ble="link"]')) return;
    try {
      const picked = await ble.pick();
      const clash = state.items.find((i) => i.id !== draft.id && i.ble?.id === picked.id);
      if (clash) {
        toast(`That device is already linked to ${clash.name}.`);
        return;
      }
      device = picked;
      draft.ble = { id: picked.id, name: picked.name || null };
      const name = form.elements['item-name'];
      if (!name.value.trim() && picked.name) name.value = picked.name;
      paintBle();
    } catch (err) {
      bleError(err);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    draft.name = form.elements['item-name'].value.trim();
    draft.note = form.elements['item-note'].value.trim();
    if (!draft.name) return;
    if (item?.ble && item.ble.id !== draft.ble?.id) ble.forget(draft.id);
    await db.putItem(draft);
    state.items = await db.listItems();
    if (device) {
      ble.adopt(draft.id, device);
      if (state.monitoring) ble.monitor(draft);
    }
    closeSheet();
    scheduleRender();
    toast(item ? 'Saved' : `${draft.emoji} ${draft.name} added`);
  });
}

function bleField(draft) {
  if (!ble.supported) {
    return html`<p class="note small">Bluetooth alarms need Chrome on Android, or Chrome or Edge on a computer. This item can still use saved spots, the compass and the map.</p>`;
  }
  if (draft.ble) {
    return html`<div class="ble-linked">
      <span>🔗 Linked to <strong>${draft.ble.name ?? 'Bluetooth device'}</strong></span>
      <button type="button" class="ghost small" data-ble="unlink">Unlink</button>
    </div>`;
  }
  return html`<div class="field">
    <button type="button" data-ble="link">🔗 Link Bluetooth device</button>
    <span class="hint">For Bluetooth tags (iTag-style key finders), and some watches and earbuds.</span>
  </div>`;
}

async function deleteItem(id) {
  const item = byId(id);
  if (!item || !confirm(`Delete ${item.name} and its history?`)) return;
  ble.forget(id);
  state.alarms.delete(id);
  updateAlarm();
  await db.deleteItem(id);
  state.items = await db.listItems();
  closeSheet();
  scheduleRender();
  toast('Deleted');
}

// --- Saving spots ---

async function saveSpot(item, fix, { source, type, note = '', at = Date.now() }) {
  const current = byId(item.id) ?? item;
  current.lastSeen = { lat: fix.lat, lng: fix.lng, acc: fix.acc ?? null, at, source, ...(note ? { note } : {}) };
  await db.putItem(current);
  await db.addEvent({
    id: uuid(), itemId: current.id, at, type, source, lat: fix.lat, lng: fix.lng, acc: fix.acc ?? null, ...(note ? { note } : {}),
  });
  scheduleRender();
}

const logEvent = (itemId, type, extra = {}) => db.addEvent({ id: uuid(), itemId, at: Date.now(), type, ...extra });

function markSpot(id) {
  const item = byId(id);
  if (!item) return;
  if (!geo.supported) {
    toast('No location on this device. Place it on the map instead.');
    location.hash = `#/map/place/${id}`;
    return;
  }
  let best = geo.current(10000);
  const opened = Date.now();
  const paint = () => {
    const status = document.getElementById('spot-status');
    if (!status) return;
    if (!best) {
      status.className = 'spot-status';
      status.textContent = Date.now() - opened > 29000
        ? "Can't get GPS here. Try near a window or outside, or place it on the map."
        : geo.describeError(geo.error());
      return;
    }
    const good = best.acc <= 25;
    status.className = `spot-status ${good ? 'ok' : 'warn'}`;
    status.textContent = good
      ? `GPS ready · accurate to ±${Math.round(best.acc)} m`
      : `GPS ±${Math.round(best.acc)} m · waiting for a better fix (you can save now)`;
    document.getElementById('spot-save').disabled = false;
  };
  const release = geo.hold('spot');
  const stopListening = geo.onPosition((fix) => {
    if (fix && (!best || fix.acc <= best.acc || Date.now() - best.at > 15000)) best = fix;
    paint();
  });
  const slow = setTimeout(paint, 30000);
  showSheet(html`<form class="sheet-body" id="spot-form">
    <h2 tabindex="-1" autofocus>📍 Where is ${item.name}?</h2>
    <p class="spot-status" id="spot-status" aria-live="polite">Getting your location…</p>
    <label class="field"><span>Note <span class="muted">(optional)</span></span>
      <input name="spot-note" maxlength="80" placeholder="e.g. car glovebox, desk drawer">
    </label>
    <div class="sheet-actions">
      <button type="button" class="ghost" data-action="place-on-map" data-id="${id}">Place on map</button>
      <button type="submit" class="primary" id="spot-save" disabled>Save spot</button>
    </div>
  </form>`, {
    onClose: () => {
      release();
      stopListening();
      clearTimeout(slow);
    },
  });
  paint();
  const form = $('#spot-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!best) return;
    const fix = best;
    const note = form.elements['spot-note'].value.trim();
    closeSheet();
    await saveSpot(item, fix, { source: 'manual', type: 'spot', note });
    toast(`Saved where ${item.name} is (±${Math.round(fix.acc)} m)`);
  });
}

async function foundIt(id) {
  const item = byId(id);
  if (!item) return;
  const fix = geo.current(30000);
  if (fix) await saveSpot(item, fix, { source: 'found', type: 'found' });
  else await logEvent(id, 'found');
  ble.dismiss(id);
  state.alarms.delete(id);
  updateAlarm();
  location.replace('#/items');
  toast(`🎉 Found ${item.name}!`);
}

// --- Bluetooth: monitoring and alarms ---

async function startMonitoring() {
  alarm.unlockAudio(); // must happen during the tap, so the alarm can sound later
  if (alarm.notifyPermission() === 'default') alarm.enableNotifications();
  if (!(await ble.available())) {
    toast('Turn on Bluetooth first.');
    return;
  }
  state.monitoring = true;
  store.set(MONITORING_KEY, '1');
  hideBanner();
  releaseMonitorGps?.();
  releaseMonitorGps = geo.hold('monitor'); // a fresh fix is ready the moment something drops
  alarm.keepAwake(true);
  renderItems();
  toast('Monitoring. Keep this app open on screen.');
  await Promise.all(state.items.filter((i) => i.ble).map((item) => ble.monitor(item)));
}

function stopMonitoring() {
  state.monitoring = false;
  store.set(MONITORING_KEY, '0');
  ble.stopMonitoring();
  releaseMonitorGps?.();
  releaseMonitorGps = null;
  alarm.keepAwake(false);
  state.alarms.clear();
  updateAlarm();
  renderItems();
}

async function onLost({ itemId, at }) {
  const item = byId(itemId);
  if (!item) return;
  state.alarms.set(itemId, { at });
  updateAlarm();
  alarm.notify(`${item.emoji} ${item.name} left behind!`, {
    body: `Lost the Bluetooth connection at ${stamp(at)}. Tap to find it.`,
    tag: `lost-${itemId}`,
    hash: `#/find/${itemId}`,
  });
  const fix = state.dropFixes.get(itemId) ?? geo.current(30000);
  state.dropFixes.delete(itemId);
  if (fix) await saveSpot(item, fix, { source: 'disconnect', type: 'disconnect', at });
  else await logEvent(itemId, 'disconnect', { at });
}

async function onBack({ itemId }) {
  const item = byId(itemId);
  if (!item) return;
  state.alarms.delete(itemId);
  updateAlarm();
  alarm.clearNotification(`lost-${itemId}`);
  alarm.chime();
  toast(`${item.emoji} ${item.name} is back in range`);
  const fix = geo.current(30000);
  if (fix) await saveSpot(item, fix, { source: 'connected', type: 'reconnect' });
  else await logEvent(itemId, 'reconnect');
}

async function onConnected({ itemId, first }) {
  const item = byId(itemId);
  if (!item || !first) return;
  const fix = geo.current(30000);
  if (fix) await saveSpot(item, fix, { source: 'connected', type: 'connect' });
  else await logEvent(itemId, 'connect');
}

let lastPositionRender = 0;

function onPosition(fix) {
  if (!fix) return;
  if (state.monitoring) followConnected(fix);
  if (state.route.name === 'map') {
    mapView.update({ items: state.items, here: fix });
  } else if (Date.now() - lastPositionRender > 5000) {
    lastPositionRender = Date.now();
    scheduleRender();
  }
}

/** While a tag is connected it is with you, so its last-seen spot follows you around. */
function followConnected(fix) {
  for (const item of state.items) {
    if (!item.ble || ble.status(item.id).state !== 'connected') continue;
    const prev = item.lastSeen;
    if (prev?.source === 'connected' && distance(prev, fix) < 25 && Date.now() - prev.at < 10 * 60000) continue;
    item.lastSeen = { lat: fix.lat, lng: fix.lng, acc: fix.acc, at: Date.now(), source: 'connected' };
    db.putItem(item).catch(() => {}); // best effort; the next fix tries again
  }
}

function updateAlarm() {
  const dialog = $('#alarm-dialog');
  const active = [...state.alarms.keys()].map(byId).filter(Boolean);
  if (!active.length) {
    if (dialog.open) dialog.close();
    if (!state.ringingPhone) alarm.stopSiren();
    return;
  }
  const title = active.length === 1 ? `${active[0].name} left behind!` : `${active.length} items left behind!`;
  dialog.innerHTML = str(html`<div class="alarm-body">
    <div class="alarm-icon" aria-hidden="true">${active[0].emoji}</div>
    <h2>${title}</h2>
    <ul class="alarm-list">${active.map((item) => html`<li>
      <span>${item.emoji} ${item.name} · out of range since ${stamp(state.alarms.get(item.id).at)}</span>
      <span class="alarm-actions">
        <button class="light" data-action="alarm-find" data-id="${item.id}">🧭 Find it</button>
        <button class="outline" data-action="alarm-ok" data-id="${item.id}">I have it</button>
      </span>
    </li>`)}</ul>
    <p class="alarm-hint">Its last spot is saved. Head back the way you came.</p>
  </div>`);
  if (!dialog.open) dialog.showModal();
  alarm.startSiren({ sound: settings.sound });
}

/** Back button / Esc on the alarm: stop the noise but keep the items marked as left behind. */
function silenceAlarms() {
  state.alarms.clear();
  updateAlarm();
}

function onTagButton({ itemId }) {
  const item = byId(itemId);
  if (!item) return;
  if (state.ringingPhone) {
    stopRingingPhone(); // a second press stops it
    return;
  }
  state.ringingPhone = itemId;
  const dialog = $('#ring-dialog');
  dialog.innerHTML = str(html`<div class="alarm-body">
    <div class="alarm-icon" aria-hidden="true">📱</div>
    <h2>Here's your phone!</h2>
    <p>You pressed the button on ${item.emoji} ${item.name}.</p>
    <button class="light" data-action="ring-stop">Stop ringing</button>
  </div>`);
  if (!dialog.open) dialog.showModal();
  alarm.startSiren({ sound: true });
  alarm.notify("📱 Here's your phone!", { body: `${item.name}'s button was pressed.`, tag: 'find-phone', hash: '#/items' });
}

function stopRingingPhone() {
  state.ringingPhone = null;
  const dialog = $('#ring-dialog');
  if (dialog.open) dialog.close();
  if (!state.alarms.size) alarm.stopSiren();
  alarm.clearNotification('find-phone');
}

async function ringTag(id, button) {
  const item = byId(id);
  if (!item?.ble) return;
  const stop = state.ringingTags.get(id);
  if (stop) {
    stop();
    return;
  }
  if (button) button.disabled = true;
  try {
    // Ask for the device list right away if needed: it only opens while the tap is fresh.
    const known = ble.status(id).known || (await ble.findDevice(item));
    if (!known) await adoptPicked(item, await ble.pick(item.ble.name ?? undefined));
    await ble.ring(id, true);
    let timer = 0;
    const stopRing = () => {
      clearTimeout(timer);
      state.ringingTags.delete(id);
      ble.ring(id, false).catch(() => {});
      scheduleRender();
    };
    timer = setTimeout(stopRing, 15000);
    state.ringingTags.set(id, stopRing);
    toast(`🔔 Ringing ${item.name}. Tap Stop when you find it.`);
  } catch (err) {
    bleError(err);
  } finally {
    if (button) button.disabled = false;
    scheduleRender();
  }
}

async function reconnectWithPicker(id) {
  const item = byId(id);
  if (!item?.ble) return;
  try {
    await adoptPicked(item, await ble.pick(item.ble.name ?? undefined));
    if (state.monitoring) await ble.monitor(item);
    else await ble.tryConnect(item);
  } catch (err) {
    bleError(err);
  }
}

/** Remembers a device chosen in the picker, updating the item if its id or name changed. */
async function adoptPicked(item, device) {
  ble.adopt(item.id, device);
  if (device.id !== item.ble.id || (device.name && device.name !== item.ble.name)) {
    item.ble = { id: device.id, name: device.name || item.ble.name };
    await db.putItem(item);
  }
}

function bleError(err) {
  if (err?.name === 'NotFoundError' && /cancel/i.test(err.message)) return; // closed the device list
  const messages = {
    NotFoundError: err?.message || 'No device found.',
    SecurityError: 'Bluetooth is blocked for this site. Allow it in your browser settings.',
    NotAllowedError: 'Bluetooth permission was denied.',
    NetworkError: "Couldn't reach the device. Move closer and try again.",
    TimeoutError: "Couldn't reach the device. Move closer and try again.",
  };
  toast(messages[err?.name] ?? `Bluetooth error: ${err?.message ?? err}`);
}

// --- Find view (walk-back compass) ---

function findMarkup(item) {
  const hasBle = ble.supported && item.ble;
  return html`
    <header class="find-top">
      <a class="back" href="#/items" data-action="back" aria-label="Back">‹</a>
      <h2>${item.emoji} Find ${item.name}</h2>
    </header>
    <div class="find-main">
      <div class="dial" aria-hidden="true">
        <div class="dial-north" id="find-north"><span>N</span></div>
        <svg class="arrow" id="find-arrow" viewBox="0 0 100 100"><path d="M50 6 L82 88 L50 70 L18 88 Z"/></svg>
      </div>
      <div class="find-dist" id="find-dist">…</div>
      <div class="find-dir" id="find-dir"></div>
      <p class="find-hint" id="find-hint"></p>
      ${hasBle ? html`<p class="find-ble" id="find-ble"></p>` : ''}
      <p class="find-seen" id="find-seen"></p>
    </div>
    <div class="find-actions">
      <button data-action="compass" hidden>🧭 Turn on compass</button>
      ${hasBle ? html`<button data-action="ring" data-id="${item.id}">🔔 Ring</button>` : ''}
      <button data-action="show-map" data-id="${item.id}">🗺️ Map</button>
      <button class="primary" data-action="found" data-id="${item.id}">✅ Found it</button>
    </div>`;
}

function enterFind(id) {
  const item = byId(id);
  if (!item) {
    location.replace('#/items');
    return null;
  }
  const view = $('#view-find');
  view.innerHTML = str(findMarkup(item));
  const el = (sel) => $(sel, view);
  const release = geo.hold('find');
  geo.startCompass();
  // Continuous (unwrapped) angles, so the CSS transition never spins the long way round.
  let arrowDeg = 0;
  let northDeg = 0;
  let frame = 0;
  const requestPaint = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };

  function paint() {
    const current = byId(id);
    if (!current) return;
    const face = geo.facing();
    // iPhone only sends compass readings after a tap grants access.
    el('[data-action="compass"]').hidden = face.source === 'compass' || !geo.compassNeedsPermission();
    const ringButton = el('[data-action="ring"]');
    if (ringButton) ringButton.textContent = state.ringingTags.has(id) ? '🔕 Stop' : '🔔 Ring';
    const bleLine = el('#find-ble');
    if (bleLine) {
      const s = ble.status(id);
      bleLine.textContent = s.state === 'connected'
        ? '📶 In Bluetooth range. Tap Ring to make it beep.'
        : s.needsPick ? 'Tap Ring to reconnect to the tag.' : 'Not in Bluetooth range yet. Keep going.';
    }
    const arrow = el('#find-arrow');
    const target = current.lastSeen;
    if (!target) {
      el('#find-dist').textContent = 'No spot saved';
      el('#find-dir').textContent = 'Tap "Left it here" next time you put it down.';
      arrow.classList.add('idle');
      return;
    }
    el('#find-seen').textContent = [
      `Last seen ${stamp(target.at)} (${timeAgo(target.at)})`,
      SOURCE_LABEL[target.source],
      target.note,
    ].filter(Boolean).join(' · ');
    const here = geo.current(30000);
    if (!here) {
      el('#find-dist').textContent = '…';
      el('#find-dir').textContent = geo.describeError(geo.error());
      arrow.classList.add('idle');
      return;
    }
    const meters = distance(here, target);
    const toward = bearing(here, target);
    const rel = face.deg == null ? toward : toward - face.deg;
    arrowDeg += angleDiff(arrowDeg, rel);
    northDeg += angleDiff(northDeg, face.deg == null ? 0 : -face.deg);
    arrow.style.transform = `rotate(${arrowDeg}deg)`;
    arrow.dataset.deg = normalizeDeg(rel).toFixed(1);
    el('#find-north').style.transform = `rotate(${northDeg}deg)`;
    const nearby = meters <= Math.max(10, here.acc ?? 0, target.acc ?? 0);
    arrow.classList.toggle('idle', nearby);
    const dist = el('#find-dist');
    dist.textContent = nearby ? 'Right around here' : formatDistance(meters);
    dist.dataset.m = meters.toFixed(1);
    el('#find-dir').textContent = `Direction ${cardinal(toward)} · your GPS ±${Math.round(here.acc)} m`;
    el('#find-hint').textContent = nearby
      ? "You're within GPS range. Look around here."
      : face.source === 'compass' ? 'Hold your phone flat and walk where the arrow points.'
        : face.source === 'walking' ? 'No compass: the arrow follows the direction you walk.'
          : 'No compass on this device: the arrow is north-up (N at the top).';
  }

  const unsubscribe = [
    geo.onPosition(requestPaint),
    geo.onHeading(requestPaint),
    ble.on('change', (d) => {
      if (d.itemId === id) requestPaint();
    }),
  ];
  paint();

  // Keep trying to reach a Bluetooth tag, so Ring works as soon as you're close.
  let poll = 0;
  if (ble.supported && item.ble) {
    const reach = () => {
      const s = ble.status(id);
      if (!s.monitored && s.state !== 'connected' && s.state !== 'connecting') ble.tryConnect(byId(id) ?? item);
    };
    reach();
    poll = setInterval(reach, 8000);
  }
  const tick = setInterval(requestPaint, 1000); // keeps "x min ago" and the compass fallback fresh

  return () => {
    release();
    geo.stopCompass();
    unsubscribe.forEach((off) => off());
    clearInterval(poll);
    clearInterval(tick);
    cancelAnimationFrame(frame);
  };
}

// --- Map view ---

function enterMap({ focusId, placeId }) {
  const release = geo.hold('map');
  const placing = placeId ? byId(placeId) : null;
  $('#place-bar').hidden = !placing;
  $('#crosshair').hidden = !placing;
  $('#map-error').hidden = true;
  if (placing) {
    $('#place-text').textContent = `Move the map so the cross is on ${placing.name}'s spot.`;
    $('#place-ok').dataset.id = placing.id;
  }
  updateOnline();
  let left = false;
  mapView.load().then(() => {
    if (left) return;
    mapView.show($('#map'), {
      items: state.items,
      here: geo.current(),
      focusId,
      describe: popupFor,
      history: (id) => db.listEvents(id, 12),
      eventLabel: (ev) => `${EVENT_LABEL[ev.type] ?? ev.type} · ${stamp(ev.at)}`,
      isLost: (id) => ble.status(id).lost,
      onPinMoved: async (id, latlng) => {
        const item = byId(id);
        if (!item) return;
        await saveSpot(item, { lat: latlng.lat, lng: latlng.lng, acc: null }, { source: 'map', type: 'spot' });
        toast(`Moved ${item.name}'s pin`);
      },
    });
    if (placing) mapView.centerOn(placing.lastSeen ?? geo.current());
  }).catch(() => {
    if (!left) $('#map-error').hidden = false;
  });
  return () => {
    left = true;
    release();
    mapView.hide();
  };
}

function popupFor(id) {
  const item = byId(id);
  if (!item?.lastSeen) return html``;
  const seen = item.lastSeen;
  const where = [stamp(seen.at), SOURCE_LABEL[seen.source], awayText(geo.current(), seen)].filter(Boolean).join(' · ');
  return html`<div class="popup">
    <strong>${item.emoji} ${item.name}</strong>
    <span>${itemStatus(item).text}</span>
    <span class="muted">${where}</span>
    <div class="popup-actions">
      <button class="small" data-action="find" data-id="${id}">🧭 Find</button>
      ${ble.supported && item.ble ? html`<button class="small" data-action="ring" data-id="${id}">🔔 Ring</button>` : ''}
      <button class="small" data-action="move-pin" data-id="${id}">✋ Move pin</button>
    </div>
  </div>`;
}

async function placeHere(id) {
  const item = byId(id);
  const center = mapView.center();
  if (!item || !center) return;
  await saveSpot(item, { lat: center.lat, lng: center.lng, acc: null }, { source: 'map', type: 'spot' });
  toast(`Saved ${item.name}'s spot`);
  location.replace(`#/map/${id}`);
}

function updateOnline() {
  $('#map-chip').hidden = navigator.onLine;
}

// --- Settings view ---

async function renderSettings() {
  const [persisted, version] = await Promise.all([
    navigator.storage?.persisted?.().catch(() => false) ?? false,
    swVersion(),
  ]);
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const delays = [0, 5, 15, 30];
  $('#view-settings').innerHTML = str(html`
    <section class="panel">
      <h2>Left-behind alarm</h2>
      <label class="row">Alarm after
        <select data-setting="alarmDelay">${delays.map((s) => html`<option value="${s}" ${settings.alarmDelay === s ? raw('selected') : ''}>${s ? `${s} seconds` : 'No wait'}</option>`)}</select>
      </label>
      <p class="hint">How long a tag must stay out of range before the alarm sounds. A short wait avoids false alarms from brief signal drops.</p>
      <label class="row">Alarm sound <input type="checkbox" data-setting="sound" ${settings.sound ? raw('checked') : ''}></label>
      <label class="row">Tag beeps when left behind <input type="checkbox" data-setting="tagBeep" ${settings.tagBeep ? raw('checked') : ''}></label>
      <button data-action="test-alarm">▶ Test alarm (3 s)</button>
    </section>
    <section class="panel">
      <h2>Notifications</h2>
      ${notificationRow()}
    </section>
    <section class="panel">
      <h2>Install and offline</h2>
      ${installed
        ? html`<p>✓ Installed as an app.</p>`
        : state.installPrompt ? html`<button class="primary" data-action="install">Install app</button>` : html`<p>${installHint()}</p>`}
      <p>${navigator.serviceWorker?.controller ? '✓ Ready to work offline.' : 'Getting offline mode ready. Reload once while online.'}</p>
      <p>${persisted ? '✓ Your data is stored permanently on this device.' : 'Your data is stored on this device. The browser may clear it if storage runs very low; installing the app helps prevent that.'}</p>
      <p class="muted small">Version ${version ?? '–'}</p>
    </section>
    <section class="panel">
      <h2>Good to know</h2>
      <ul class="limits">
        <li>Bluetooth alarms only work while this app is open on screen. The screen stays on while monitoring.</li>
        <li>Bluetooth needs Chrome on Android, or Chrome or Edge on a computer. iPhone can use spots, the compass and the map.</li>
        <li>Works best with cheap BLE "iTag" key finders. AirTag, Tile and SmartTag only work with their own apps.</li>
        <li>The alarm plays at media volume, so keep it turned up.</li>
        <li>Phone GPS works offline, but the first fix can take 30 seconds or more.</li>
        <li>Map areas only show offline if you've viewed them once while online.</li>
        <li>Your items stay on this device. No account, no sync.</li>
      </ul>
    </section>
    <section class="panel">
      <h2>Data</h2>
      <button class="ghost danger" data-action="wipe">Delete all items and history</button>
    </section>`);
}

function notificationRow() {
  const permission = alarm.notifyPermission();
  if (permission === 'unsupported') return html`<p>This browser can't show notifications.</p>`;
  if (permission === 'granted') return html`<p>✓ On. Left-behind alarms also show as a notification.</p>`;
  if (permission === 'denied') return html`<p>Blocked. Allow notifications for this site in your browser settings.</p>`;
  return html`<button data-action="notify-on">Turn on notifications</button>`;
}

function installHint() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'In Safari, tap Share, then "Add to Home Screen".';
  if (/Android/.test(ua)) return 'In Chrome, open the ⋮ menu, then "Install app" or "Add to Home screen".';
  return 'In Chrome or Edge, use the install icon in the address bar.';
}

function onSettingChange(e) {
  const input = e.target.closest('[data-setting]');
  if (!input) return;
  const key = input.dataset.setting;
  settings[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
  store.set(SETTINGS_KEY, JSON.stringify(settings));
  applySettings();
  if (key === 'tagBeep') ble.applyTagBeep();
}

async function installApp() {
  const prompt = state.installPrompt;
  if (!prompt) return;
  state.installPrompt = null;
  $('#install-btn').hidden = true;
  prompt.prompt();
  await prompt.userChoice.catch(() => {});
  if (state.route.name === 'settings') renderSettings();
}

async function wipeAll() {
  if (!confirm('Delete all items and their history from this device?')) return;
  stopMonitoring();
  state.items.forEach((item) => ble.forget(item.id));
  await db.clearAll();
  state.items = [];
  toast('All data deleted');
  renderSettings();
}

// --- Service worker, banner, toast ---

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let updating = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updating) location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = () => showBanner('A new version is ready.', 'Reload', () => {
      updating = true;
      reg.waiting?.postMessage('SKIP_WAITING');
    });
    if (reg.waiting && navigator.serviceWorker.controller) offer();
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) offer();
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {});
    });
  }).catch(() => {});
}

function swVersion() {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data);
    worker.postMessage('VERSION', [channel.port2]);
    setTimeout(() => resolve(null), 1000);
  });
}

function showBanner(text, actionLabel, onAction) {
  const banner = $('#banner');
  banner.innerHTML = str(html`<span>${text}</span>
    <button class="small primary" id="banner-action">${actionLabel}</button>
    <button class="small ghost" id="banner-close" aria-label="Dismiss">✕</button>`);
  banner.hidden = false;
  $('#banner-action').addEventListener('click', () => {
    hideBanner();
    onAction();
  });
  $('#banner-close').addEventListener('click', hideBanner);
}

function hideBanner() {
  $('#banner').hidden = true;
}

let toastTimer = 0;

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  // A popover sits in the top layer, so the toast shows above open dialogs too.
  try {
    if (el.matches(':popover-open')) el.hidePopover();
    el.showPopover();
  } catch {
    // No popover support: the class below still shows it.
  }
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      if (el.classList.contains('show')) return;
      try { el.hidePopover(); } catch { /* not a popover */ }
    }, 250);
  }, 3500);
}

init();
