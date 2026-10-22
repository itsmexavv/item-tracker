// Web Bluetooth: link devices to items, watch the connection, raise the alarm when
// it drops, and make tags beep. Chrome/Edge on Android, Windows, macOS and ChromeOS
// support it; iPhone and Firefox don't, so the app hides these features there.

export const supported = typeof navigator !== 'undefined' && 'bluetooth' in navigator;

// Standard GATT services. Cheap "iTag" anti-lost tags have all of these.
const IMMEDIATE_ALERT = 0x1802; // write 2 = beep now, 0 = stop
const LINK_LOSS = 0x1803; // how loudly the tag beeps by itself when the link drops
const BATTERY = 0x180f;
const ITAG_BUTTON_SERVICE = 0xffe0; // iTag button presses arrive as notifications
const ALERT_LEVEL = 0x2a06;
const BATTERY_LEVEL = 0x2a19;
const ITAG_BUTTON = 0xffe1;
const OPTIONAL_SERVICES = [IMMEDIATE_ALERT, LINK_LOSS, BATTERY, ITAG_BUTTON_SERVICE];
const CONNECT_TIMEOUT_MS = 12000;
const MAX_RETRY_MS = 15000;

let options = { graceMs: 5000, tagBeep: true };
const links = new Map(); // itemId → connection state for that item's device
const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

/**
 * Subscribe to Bluetooth events. Handlers get `{ itemId, ... }`:
 * change (anything shown in the UI changed), connected ({ first }), dropped ({ at }),
 * lost ({ at }: still gone after the grace period), back (reconnected after being lost), button.
 */
export function on(type, handler) {
  const listener = (e) => handler(e.detail);
  bus.addEventListener(type, listener);
  return () => bus.removeEventListener(type, listener);
}

export function configure(next) {
  options = { ...options, ...next };
}

function linkFor(itemId) {
  if (!links.has(itemId)) {
    links.set(itemId, {
      itemId,
      device: null,
      listeners: null,
      state: 'idle', // idle | connecting | connected | disconnected
      monitored: false,
      sessionConnected: false,
      lost: false,
      lostAt: 0,
      needsPick: false,
      battery: null,
      alert: null,
      linkLoss: null,
      batteryChar: null,
      button: null,
      lastPress: 0,
      connecting: null,
      retry: null,
      grace: null,
      attempts: 0,
      intentional: false,
      adsAbort: null,
    });
  }
  return links.get(itemId);
}

/** What the UI shows for an item's device. */
export function status(itemId) {
  const link = links.get(itemId);
  return {
    state: link?.state ?? 'idle',
    monitored: link?.monitored ?? false,
    lost: link?.lost ?? false,
    lostAt: link?.lostAt ?? 0,
    battery: link?.battery ?? null,
    needsPick: link?.needsPick ?? false, // must be picked again in the browser's device list
    known: Boolean(link?.device),
  };
}

/** False when the Bluetooth radio is off or missing. */
export async function available() {
  if (!supported) return false;
  try {
    return (await navigator.bluetooth.getAvailability?.()) ?? true;
  } catch {
    return true;
  }
}

/** Opens the browser's device picker; must run from a tap. With a name, only that device is listed. */
export function pick(name) {
  return navigator.bluetooth.requestDevice(name
    ? { filters: [{ name }], optionalServices: OPTIONAL_SERVICES }
    : { acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES });
}

/** Ties a device to an item. */
export function adopt(itemId, device) {
  const link = linkFor(itemId);
  if (link.device !== device) {
    detach(link);
    link.device = device;
    link.listeners = {
      disconnected: () => onDisconnected(link),
      advertisement: () => {
        if (link.monitored && link.state !== 'connected') retryNow(link);
      },
    };
    device.addEventListener('gattserverdisconnected', link.listeners.disconnected);
    device.addEventListener('advertisementreceived', link.listeners.advertisement);
  }
  link.needsPick = false;
  emit('change', { itemId });
  return link;
}

function detach(link) {
  if (!link.device || !link.listeners) return;
  link.device.removeEventListener('gattserverdisconnected', link.listeners.disconnected);
  link.device.removeEventListener('advertisementreceived', link.listeners.advertisement);
  link.listeners = null;
}

/** The item's device without the picker: from memory, or getDevices() where the browser has it. */
export async function findDevice(item) {
  const link = linkFor(item.id);
  if (link.device) return link.device;
  if (!navigator.bluetooth.getDevices) return null;
  try {
    const device = (await navigator.bluetooth.getDevices()).find((d) => d.id === item.ble.id);
    if (device) adopt(item.id, device);
    return device ?? null;
  } catch {
    return null;
  }
}

/** Starts watching an item's device; the alarm fires if it disconnects. */
export async function monitor(item) {
  const link = linkFor(item.id);
  link.monitored = true;
  link.sessionConnected = false;
  link.attempts = 0;
  if (!(await findDevice(item))) {
    link.needsPick = true; // the UI shows "Reconnect" until it's picked again
    emit('change', { itemId: item.id });
    return;
  }
  try {
    await connect(link);
  } catch {
    if (link.monitored) scheduleRetry(link);
  }
}

export function stopMonitoring() {
  for (const link of links.values()) {
    link.monitored = false;
    link.lost = false;
    link.needsPick = false;
    cancelTimers(link);
    hangUp(link);
    emit('change', { itemId: link.itemId });
  }
}

/** Stops watching an item and forgets its device (after unlinking or deleting it). */
export function forget(itemId) {
  const link = links.get(itemId);
  if (!link) return;
  link.monitored = false;
  cancelTimers(link);
  hangUp(link).finally(() => detach(link));
  links.delete(itemId);
  emit('change', { itemId });
}

/** Clears the "left behind" state once the user has the item, without waiting for a reconnect. */
export function dismiss(itemId) {
  const link = links.get(itemId);
  if (!link?.lost) return;
  link.lost = false;
  emit('change', { itemId });
}

/** One connection attempt outside monitoring, e.g. while walking back to an item. */
export async function tryConnect(item) {
  const link = linkFor(item.id);
  if (link.state === 'connected') return true;
  if (!(await findDevice(item))) {
    link.needsPick = true;
    emit('change', { itemId: item.id });
    return false;
  }
  try {
    await connect(link);
    return true;
  } catch {
    return false;
  }
}

/** Makes the tag beep (true) or stop (false), connecting first if needed. */
export async function ring(itemId, on = true) {
  const link = links.get(itemId);
  if (!link?.device) throw new DOMException('Pick the device again to ring it.', 'NotFoundError');
  await connect(link);
  if (!link.alert) throw new Error("This device can't beep (it has no alert feature).");
  await write(link.alert, on ? 2 : 0);
}

/** Re-applies the "tag beeps when left behind" setting to connected tags. */
export function applyTagBeep() {
  for (const link of links.values()) {
    if (link.linkLoss) write(link.linkLoss, options.tagBeep ? 2 : 0).catch(() => {});
  }
}

// --- Connection handling ---

function connect(link) {
  const gatt = link.device.gatt;
  if (link.state === 'connected' && gatt.connected) return Promise.resolve();
  link.connecting ??= (async () => {
    link.state = 'connecting';
    emit('change', { itemId: link.itemId });
    try {
      const server = await withTimeout(gatt.connect(), CONNECT_TIMEOUT_MS, () => gatt.disconnect());
      link.state = 'connected';
      link.intentional = false;
      link.needsPick = false;
      await setUp(link, server);
      onConnected(link);
    } catch (err) {
      link.state = 'disconnected';
      throw err;
    } finally {
      link.connecting = null;
      emit('change', { itemId: link.itemId });
    }
  })();
  return link.connecting;
}

function onConnected(link) {
  if (!link.device.gatt.connected) return; // dropped again during setup; the disconnect handler took over
  cancelTimers(link);
  link.attempts = 0;
  const wasLost = link.lost;
  link.lost = false;
  const first = link.monitored && !link.sessionConnected;
  if (link.monitored) link.sessionConnected = true;
  if (wasLost) emit('back', { itemId: link.itemId });
  else emit('connected', { itemId: link.itemId, first });
}

function onDisconnected(link) {
  link.alert = link.linkLoss = link.batteryChar = link.button = null;
  if (link.intentional || !link.monitored) {
    link.intentional = false;
    link.state = 'idle';
    emit('change', { itemId: link.itemId });
    return;
  }
  link.state = 'disconnected';
  if (!link.lost && !link.grace) {
    const at = Date.now();
    emit('dropped', { itemId: link.itemId, at });
    // Short dropouts are common, so only alarm if it stays gone for the grace period.
    link.grace = setTimeout(() => {
      link.grace = null;
      if (!link.monitored || link.state === 'connected') return;
      link.lost = true;
      link.lostAt = at;
      emit('lost', { itemId: link.itemId, at });
      emit('change', { itemId: link.itemId });
    }, options.graceMs);
  }
  emit('change', { itemId: link.itemId });
  link.attempts = 0;
  scheduleRetry(link);
}

/** Retries at 0.3 s, 2 s, 4 s, 8 s, then every 15 s while monitoring. */
function scheduleRetry(link) {
  clearTimeout(link.retry);
  if (!link.monitored) return;
  const delay = link.attempts === 0 ? 300 : Math.min(1000 * 2 ** link.attempts, MAX_RETRY_MS);
  link.retry = setTimeout(() => attempt(link), delay);
}

async function attempt(link) {
  link.retry = null;
  if (!link.monitored || link.state === 'connected') return;
  link.attempts++;
  try {
    await connect(link);
  } catch {
    listenForAdvertisements(link);
    scheduleRetry(link);
  }
}

function retryNow(link) {
  clearTimeout(link.retry);
  attempt(link);
}

/** Where the browser supports scanning, reconnect the moment the tag is heard again. */
function listenForAdvertisements(link) {
  if (link.adsAbort || !link.device?.watchAdvertisements) return;
  link.adsAbort = new AbortController();
  link.device.watchAdvertisements({ signal: link.adsAbort.signal }).catch(() => {});
}

function cancelTimers(link) {
  clearTimeout(link.retry);
  clearTimeout(link.grace);
  link.retry = null;
  link.grace = null;
  link.adsAbort?.abort();
  link.adsAbort = null;
}

/** Disconnects on purpose, first telling the tag not to beep about it. */
async function hangUp(link) {
  if (!link.device?.gatt.connected) {
    link.state = 'idle';
    return;
  }
  link.intentional = true;
  if (link.linkLoss) await write(link.linkLoss, 0).catch(() => {});
  link.device.gatt.disconnect();
}

async function setUp(link, server) {
  link.alert = await characteristic(server, IMMEDIATE_ALERT, ALERT_LEVEL);
  link.linkLoss = await characteristic(server, LINK_LOSS, ALERT_LEVEL);
  if (link.linkLoss) await write(link.linkLoss, options.tagBeep ? 2 : 0).catch(() => {});

  const battery = await characteristic(server, BATTERY, BATTERY_LEVEL);
  if (battery && battery !== link.batteryChar) {
    link.batteryChar = battery;
    try {
      link.battery = (await battery.readValue()).getUint8(0);
      battery.addEventListener('characteristicvaluechanged', (e) => {
        link.battery = e.target.value.getUint8(0);
        emit('change', { itemId: link.itemId });
      });
      await battery.startNotifications();
    } catch {
      // Battery level is optional.
    }
  }

  const button = await characteristic(server, ITAG_BUTTON_SERVICE, ITAG_BUTTON);
  if (button && button !== link.button) {
    link.button = button;
    button.addEventListener('characteristicvaluechanged', () => {
      if (Date.now() - link.lastPress < 1000) return; // one press can arrive twice
      link.lastPress = Date.now();
      emit('button', { itemId: link.itemId });
    });
    await button.startNotifications().catch(() => {});
  }
}

async function characteristic(server, service, id) {
  try {
    return await (await server.getPrimaryService(service)).getCharacteristic(id);
  } catch {
    return null; // the device doesn't have this feature
  }
}

function write(char, level) {
  const value = Uint8Array.of(level);
  return char.properties?.writeWithoutResponse && char.writeValueWithoutResponse
    ? char.writeValueWithoutResponse(value)
    : char.writeValue(value);
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new DOMException('Timed out connecting.', 'TimeoutError'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A connection can drop while the page is hidden without us hearing about it.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const link of links.values()) {
      if (link.monitored && link.state === 'connected' && !link.device?.gatt.connected) onDisconnected(link);
    }
  });
}
