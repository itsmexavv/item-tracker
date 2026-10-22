// End-to-end check in headless Edge or Chrome over the DevTools protocol, with no
// npm dependencies. It drives the real app with a fake Bluetooth tag, emulated GPS
// and compass, then stops the web server and reloads to prove the app works offline.
// Usage: npm run smoke   (set BROWSER=/path/to/chrome to pick a browser)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { distance, offset } from '../js/geo-math.js';
import { startServer } from './serve.mjs';

const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const PORT = 8137;
const DEBUG_PORT = 9337;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOME = { lat: 48.8584, lng: 2.2945 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

// A fake iTag, installed as navigator.bluetooth before the app's scripts run.
const FAKE_BLUETOOTH = `(() => {
  const uuid = (u) => typeof u === 'number' ? '0000' + u.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb' : String(u).toLowerCase();
  const tag = { writes: [], outOfRange: false, button: null };
  class Characteristic extends EventTarget {
    constructor(service, id, initial = 0) {
      super();
      this.service = service;
      this.uuid = uuid(id);
      this.initial = initial;
      this.value = null;
      this.properties = { read: true, write: true, writeWithoutResponse: true, notify: true };
    }
    async readValue() { this.value = new DataView(Uint8Array.of(this.initial).buffer); return this.value; }
    async writeValue(v) { tag.writes.push({ service: this.service, bytes: [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)] }); }
    writeValueWithoutResponse(v) { return this.writeValue(v); }
    async startNotifications() { if (this.uuid === uuid(0xffe1)) tag.button = this; return this; }
    async stopNotifications() { return this; }
  }
  const service = (id, chars) => [uuid(id), {
    async getCharacteristic(c) {
      const found = chars.find((ch) => ch.uuid === uuid(c));
      if (!found) throw new DOMException('No Characteristics matching UUID found.', 'NotFoundError');
      return found;
    },
  }];
  const freshServices = () => Object.fromEntries([
    service(0x1802, [new Characteristic(0x1802, 0x2a06)]),
    service(0x1803, [new Characteristic(0x1803, 0x2a06)]),
    service(0x180f, [new Characteristic(0x180f, 0x2a19, 87)]),
    service(0xffe0, [new Characteristic(0xffe0, 0xffe1)]),
  ]);
  class Gatt {
    constructor(device) { this.device = device; this.connected = false; this.services = {}; }
    async connect() {
      await new Promise((r) => setTimeout(r, 30));
      if (tag.outOfRange) throw new DOMException('Bluetooth Device is no longer in range.', 'NetworkError');
      this.connected = true;
      this.services = freshServices();
      return this;
    }
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      setTimeout(() => this.device.dispatchEvent(new Event('gattserverdisconnected')));
    }
    async getPrimaryService(id) {
      if (!this.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
      const s = this.services[uuid(id)];
      if (!s) throw new DOMException('No Services matching UUID found in Device.', 'NotFoundError');
      return s;
    }
  }
  class Device extends EventTarget {
    constructor() { super(); this.id = 'fake-itag-1'; this.name = 'iTAG'; this.gatt = new Gatt(this); }
  }
  tag.device = new Device();
  tag.drop = () => {
    tag.outOfRange = true;
    tag.device.gatt.connected = false;
    tag.device.dispatchEvent(new Event('gattserverdisconnected'));
  };
  tag.back = () => { tag.outOfRange = false; };
  tag.press = () => {
    tag.button.value = new DataView(Uint8Array.of(1).buffer);
    tag.button.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  const bluetooth = {
    requestDevice: async () => tag.device,
    getDevices: async () => [tag.device],
    getAvailability: async () => true,
  };
  Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: () => bluetooth });
  window.__fakeTag = tag;
})();`;

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Set();

  static async connect(url) {
    for (let attempt = 1; ; attempt++) {
      const ws = new WebSocket(url);
      const opened = await new Promise((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
      });
      if (opened) return new Cdp(ws);
      if (attempt === 10) throw new Error(`Could not connect to the browser at ${url}`);
      await sleep(300);
    }
  }

  constructor(ws) {
    this.#ws = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (!msg.id) {
        this.#listeners.forEach((fn) => fn(msg));
        return;
      }
      const call = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`));
      else call.resolve(msg.result);
    };
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }

  on(fn) {
    this.#listeners.add(fn);
  }

  close() {
    this.#ws.close();
  }
}

/**
 * Closes the browser, then kills anything still running with our temporary profile:
 * on Windows the process we spawned can hand off to another, and stray headless
 * browsers left behind can break networking for other programs.
 */
async function stopBrowser(cdp, browser, profile) {
  await Promise.race([cdp?.send('Browser.close').catch(() => {}), sleep(3000)]);
  cdp?.close();
  if (browser.exitCode === null) await Promise.race([new Promise((r) => browser.once('exit', r)), sleep(3000)]);
  const tag = basename(profile);
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' });
  } else {
    spawnSync('pkill', ['-f', tag], { stdio: 'ignore' });
  }
}

async function browserSocketUrl() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error('The browser did not start');
}

const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) {
  console.error('No Edge or Chrome found. Set BROWSER=/path/to/browser.');
  process.exit(1);
}

let server = await startServer(PORT);
const profile = await mkdtemp(join(tmpdir(), 'item-tracker-smoke-'));
const browser = spawn(browserPath, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
], { stdio: 'ignore' });

let cdp;
const errors = [];
let watchErrors = true;
// Some locked-down machines refuse a few local connections at random. That's the
// environment, not the app, so those are counted separately instead of failing the run.
const REFUSED = /ERR_NETWORK_ACCESS_DENIED/;
let refused = 0;

try {
  cdp = await Cdp.connect(await browserSocketUrl());
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, label, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        // page may be mid-navigation
      }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  };
  const setLocation = (p, accuracy = 8) => send('Emulation.setGeolocationOverride', { latitude: p.lat, longitude: p.lng, accuracy });
  const db = (call) => evaluate(`import('./js/db.js').then((db) => db.${call})`);

  cdp.on((msg) => {
    if (msg.sessionId !== sessionId || !watchErrors) return;
    const p = msg.params;
    let error = null;
    if (msg.method === 'Runtime.exceptionThrown') error = p.exceptionDetails.exception?.description ?? p.exceptionDetails.text;
    if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') error = p.args.map((a) => a.value ?? a.description).join(' ');
    if (msg.method === 'Log.entryAdded' && p.entry.level === 'error' && !/tile\.openstreetmap\.org/.test(p.entry.url ?? '')) {
      error = `${p.entry.text} ${p.entry.url ?? ''}`;
    }
    if (error && REFUSED.test(error)) refused++;
    else if (error) errors.push(error);
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await cdp.send('Browser.grantPermissions', { origin: ORIGIN, permissions: ['geolocation', 'notifications'] });
  await setLocation(HOME);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BLUETOOTH });

  // 1. Loads and installs the service worker. Only this first load needs the server;
  // a refused connection can break it, so reload a few times before giving up.
  let loads = 0;
  for (let ready = false; !ready;) {
    loads++;
    await send(loads === 1 ? 'Page.navigate' : 'Page.reload', loads === 1 ? { url: `${ORIGIN}/` } : {});
    try {
      await waitFor(`!!document.querySelector('#view-items .empty') && !!navigator.serviceWorker.controller`, 'app ready', 15000);
      ready = true;
    } catch (err) {
      if (loads >= 8) throw new Error(`App never loaded with the service worker in control (${loads} tries)`);
    }
  }
  check(true, 'App loads, shows the empty state, and the service worker takes control', loads > 1 ? `${loads} loads` : '');

  // 2. An everyday item with a GPS spot
  await evaluate(`document.querySelector('[data-action="add"]').click()`);
  await waitFor(`!!document.querySelector('#editor')`, 'editor');
  await evaluate(`(() => {
    const f = document.querySelector('#editor');
    f.elements['item-name'].value = 'Wallet';
    f.querySelector('[data-emoji="👛"]').click();
    f.requestSubmit();
  })()`);
  await waitFor(`document.querySelectorAll('.item').length === 1`, 'wallet card');
  const walletId = await evaluate(`document.querySelector('.item').dataset.id`);
  await evaluate(`document.querySelector('[data-action="spot"][data-id="${walletId}"]').click()`);
  await waitFor(`document.querySelector('#spot-save')?.disabled === false`, 'GPS fix in the spot sheet');
  await evaluate(`(() => {
    const f = document.querySelector('#spot-form');
    f.elements['spot-note'].value = 'Kitchen drawer';
    f.requestSubmit();
  })()`);
  await waitFor(`import('./js/db.js').then((db) => db.getItem('${walletId}')).then((i) => !!i?.lastSeen)`, 'wallet spot saved');
  const wallet = await db(`getItem('${walletId}')`);
  check(distance(wallet.lastSeen, HOME) < 1 && wallet.lastSeen.note === 'Kitchen drawer', '"Left it here" saves the GPS position and note',
    `${distance(wallet.lastSeen, HOME).toFixed(2)} m off`);

  // 3. A Bluetooth item: link, monitor, left-behind alarm, reconnect, ring, tag button
  await evaluate(`document.querySelector('[data-action="add"]').click()`);
  await waitFor(`!!document.querySelector('#editor [data-ble="link"]')`, 'link button');
  await evaluate(`document.querySelector('#editor [data-ble="link"]').click()`);
  await waitFor(`!!document.querySelector('#editor .ble-linked')`, 'device linked in the editor');
  await evaluate(`(() => {
    const f = document.querySelector('#editor');
    f.elements['item-name'].value = 'Keys';
    f.querySelector('[data-emoji="🔑"]').click();
    f.requestSubmit();
  })()`);
  await waitFor(`document.querySelectorAll('.item').length === 2`, 'keys card');
  const keysId = await evaluate(`[...document.querySelectorAll('.item')].find((li) => li.textContent.includes('Keys')).dataset.id`);

  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`!!document.querySelector('[data-setting="alarmDelay"]')`, 'settings view');
  await evaluate(`(() => {
    const s = document.querySelector('[data-setting="alarmDelay"]');
    s.value = '0';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await evaluate(`location.hash = '#/items'`);
  await waitFor(`!!document.querySelector('[data-action="monitor-start"]')`, 'monitor bar');
  await evaluate(`document.querySelector('[data-action="monitor-start"]').click()`);
  await waitFor(`window.__fakeTag.device.gatt.connected && document.querySelector('.item[data-id="${keysId}"]').classList.contains('ok')`, 'tag connected');
  check(true, 'Start monitoring connects the Bluetooth tag');
  check(await evaluate(`document.querySelector('.item[data-id="${keysId}"] .item-status').textContent.includes('87%')`), 'Battery level is shown');

  const away = offset(HOME, 60, 90);
  await setLocation(away);
  await waitFor(`import('./js/geo.js').then((g) => Math.abs((g.current()?.lng ?? 0) - ${away.lng}) < 1e-7)`, 'GPS follows the walk');
  await evaluate('window.__fakeTag.drop()');
  await waitFor(`document.querySelector('#alarm-dialog').open`, 'left-behind alarm', 5000);
  check(true, 'Alarm goes off when the tag drops out of range');
  await waitFor(`import('./js/db.js').then((db) => db.listEvents('${keysId}', 1)).then(([e]) => e?.type === 'disconnect')`, 'disconnect event');
  const [dropped] = await db(`listEvents('${keysId}', 1)`);
  check(distance(dropped, away) < 1, 'The spot where the connection dropped is saved', `${distance(dropped, away).toFixed(2)} m off`);

  await evaluate('window.__fakeTag.back()');
  await waitFor(`!document.querySelector('#alarm-dialog').open`, 'alarm cleared', 20000);
  check(true, 'Alarm stops when the tag is back in range');
  await waitFor(`import('./js/db.js').then((db) => db.listEvents('${keysId}', 1)).then(([e]) => e?.type === 'reconnect')`, 'reconnect event');
  check(true, 'A "back in range" event is saved');

  await evaluate(`window.__fakeTag.writes.length = 0; document.querySelector('[data-action="ring"][data-id="${keysId}"]').click()`);
  await waitFor('window.__fakeTag.writes.some((w) => w.service === 0x1802 && w.bytes[0] === 2)', 'ring write');
  check(true, 'Ring makes the tag beep (alert level 2)');
  await waitFor(`document.querySelector('[data-action="ring"][data-id="${keysId}"]')?.textContent.includes('Stop')`, 'stop button');
  await evaluate(`document.querySelector('[data-action="ring"][data-id="${keysId}"]').click()`);
  await waitFor('window.__fakeTag.writes.some((w) => w.service === 0x1802 && w.bytes[0] === 0)', 'stop write');
  check(true, 'Stop silences the tag (alert level 0)');

  await evaluate('window.__fakeTag.press()');
  await waitFor(`document.querySelector('#ring-dialog').open`, 'find-my-phone screen');
  await evaluate(`document.querySelector('[data-action="ring-stop"]').click()`);
  await waitFor(`!document.querySelector('#ring-dialog').open`, 'find-my-phone closed');
  check(true, "Pressing the tag's button rings the phone");

  await evaluate(`document.querySelector('[data-action="monitor-stop"]').click()`);
  await waitFor(`!!document.querySelector('[data-action="monitor-start"]')`, 'monitoring stopped');
  await waitFor('!window.__fakeTag.device.gatt.connected', 'tag disconnected on purpose');
  check(!(await evaluate(`document.querySelector('#alarm-dialog').open`)), 'Stopping monitoring disconnects without an alarm');

  // 4. Walk-back compass: stand 100 m south of the wallet
  await setLocation(offset(HOME, 100, 180), 5);
  await evaluate(`location.hash = '#/find/${walletId}'`);
  await waitFor(`Math.abs(Number(document.querySelector('#find-dist')?.dataset.m) - 100) < 2`, 'find distance');
  check(true, 'Find shows the distance back to the item (≈100 m)');
  const arrowWhenFacing = async (alpha) => {
    await evaluate(`(() => {
      for (let i = 0; i < 40; i++) {
        window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: ${alpha}, beta: 0, gamma: 0, absolute: true }));
      }
    })()`);
    await sleep(200);
    return Number(await evaluate(`document.querySelector('#find-arrow').dataset.deg`));
  };
  const facingNorth = await arrowWhenFacing(0);
  check(Math.min(facingNorth, 360 - facingNorth) < 3, 'Facing north, the arrow points straight ahead', `${facingNorth}°`);
  const facingSouth = await arrowWhenFacing(180);
  check(Math.abs(facingSouth - 180) < 3, 'Facing south, the arrow points behind you', `${facingSouth}°`);

  // 5. Map shows both items
  await evaluate(`location.hash = '#/map'`);
  await waitFor(`document.querySelectorAll('#map .pin').length === 2`, 'two pins', 10000);
  check(true, 'Map shows a pin for each item');

  // 6. Offline: stop the server and reload
  await evaluate(`location.hash = '#/items'`);
  watchErrors = false;
  check(errors.length === 0, 'No console errors or uncaught exceptions', errors.join(' | '));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server = null;
  await send('Page.reload', { ignoreCache: false });
  await waitFor(`document.querySelectorAll('.item').length === 2`, 'items after offline reload', 15000);
  check(true, 'With the server stopped, the app reloads from the service worker with both items');
} catch (err) {
  check(false, err?.message || String(err));
  errors.forEach((e) => console.log(`      console: ${e}`));
} finally {
  await stopBrowser(cdp, browser, profile);
  server?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}

if (refused) console.log(`\nNote: this machine refused ${refused} local connection(s) (net::ERR_NETWORK_ACCESS_DENIED); not counted as app errors.`);
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
