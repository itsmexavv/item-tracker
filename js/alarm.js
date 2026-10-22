// Alarm outputs: a siren synthesized with Web Audio (no sound file needed offline),
// vibration, system notifications, and keeping the screen awake while monitoring.

let ctx = null;
let siren = null;
let buzzTimer = null;
let wakeLock = null;
let wantAwake = false;

/** Call from a tap: browsers only let audio start after the user has interacted. */
export function unlockAudio() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    // No Web Audio: vibration and notifications still work.
  }
}

/**
 * Two-tone siren. A slow square-wave oscillator swings the pitch, so the pattern
 * keeps going even when the browser throttles timers.
 */
export function startSiren({ sound = true } = {}) {
  if (!buzzTimer && 'vibrate' in navigator) {
    const buzz = () => navigator.vibrate([700, 300, 700, 300, 700]);
    buzz();
    buzzTimer = setInterval(buzz, 3000);
  }
  if (!sound || siren) return;
  unlockAudio();
  if (!ctx) return;
  const tone = ctx.createOscillator();
  tone.type = 'square';
  tone.frequency.value = 1100;
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 1.6;
  const swing = ctx.createGain();
  swing.gain.value = 250;
  const volume = ctx.createGain();
  volume.gain.value = 0.25;
  lfo.connect(swing).connect(tone.frequency);
  tone.connect(volume).connect(ctx.destination);
  tone.start();
  lfo.start();
  siren = { tone, lfo, volume };
}

export function stopSiren() {
  if (siren) {
    siren.tone.stop();
    siren.lfo.stop();
    siren.volume.disconnect();
    siren = null;
  }
  if (buzzTimer) {
    clearInterval(buzzTimer);
    buzzTimer = null;
    navigator.vibrate?.(0);
  }
}

/** Short rising chime for good news, like an item coming back in range. */
export function chime() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  [660, 880].forEach((freq, i) => {
    const start = t + i * 0.15;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.45);
  });
}

export const notifyPermission = () =>
  'Notification' in window && 'serviceWorker' in navigator ? Notification.permission : 'unsupported';

/** Call from a tap. */
export async function enableNotifications() {
  if (notifyPermission() === 'unsupported') return 'unsupported';
  return Notification.requestPermission();
}

/** System notification, sent through the service worker (Android requires that). */
export async function notify(title, { body, tag, hash } = {}) {
  if (notifyPermission() !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.showNotification(title, {
      body,
      tag,
      renotify: Boolean(tag),
      requireInteraction: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      vibrate: [400, 200, 400],
      data: { hash },
    });
  } catch {
    // Notifications are a bonus; the in-app alarm has already gone off.
  }
}

export async function clearNotification(tag) {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    (await reg?.getNotifications({ tag }))?.forEach((n) => n.close());
  } catch {
    // Nothing to clear.
  }
}

/** Keeps the screen on while monitoring, since Bluetooth alarms need the app on screen. */
export async function keepAwake(on) {
  wantAwake = on;
  if (on) return acquireWakeLock();
  const lock = wakeLock;
  wakeLock = null;
  await lock?.release().catch(() => {});
}

async function acquireWakeLock() {
  if (!wantAwake || wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!wantAwake) {
      lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    // Refused, e.g. by battery saver. Monitoring still works while the screen is on.
  }
}

// The browser drops the wake lock whenever the app is hidden; take it again on return.
document.addEventListener('visibilitychange', acquireWakeLock);
