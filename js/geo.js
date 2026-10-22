// Live position (GPS) and compass heading, shared by every screen that needs them.
// GPS works without internet on phones; the first fix can take a while outdoors.
import { headingFromOrientation, normalizeDeg, smoothAngle } from './geo-math.js';

export const supported = 'geolocation' in navigator;

let last = null; // latest fix: { lat, lng, acc, at, course, speed }
let lastError = null;
let watchId = null;
const holders = new Set();
const positionListeners = new Set();

function accept(p) {
  const c = p.coords;
  last = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, at: Date.now(), course: c.heading, speed: c.speed };
  lastError = null;
  positionListeners.forEach((fn) => fn(last, null));
}

function fail(err) {
  lastError = err;
  positionListeners.forEach((fn) => fn(null, err));
}

/** Keeps a high-accuracy GPS watch running until every holder has released it. Returns the release function. */
export function hold(reason) {
  holders.add(reason);
  if (supported && watchId == null) {
    watchId = navigator.geolocation.watchPosition(accept, fail, { enableHighAccuracy: true, maximumAge: 3000, timeout: 60000 });
  }
  return () => {
    holders.delete(reason);
    if (!holders.size && watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  };
}

/** Called with (fix, null) for each new position, or (null, error). Returns an unsubscribe function. */
export function onPosition(fn) {
  positionListeners.add(fn);
  return () => positionListeners.delete(fn);
}

/** The latest fix, if it is recent enough to trust. */
export function current(maxAgeMs = 120000) {
  return last && Date.now() - last.at <= maxAgeMs ? last : null;
}

export const error = () => lastError;

/** One quick, low-power fix so the item list can show distances. */
export function quickFix() {
  if (!supported) return;
  navigator.geolocation.getCurrentPosition(accept, () => {}, { enableHighAccuracy: false, maximumAge: 120000, timeout: 20000 });
}

export async function permission() {
  try {
    return (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch {
    return 'prompt';
  }
}

export function describeError(err) {
  if (!supported) return 'This browser has no location support.';
  switch (err?.code) {
    case 1: return 'Location is blocked. Allow location for this site in your browser settings.';
    case 2: return 'No location here. Try near a window or outside, or place it on the map.';
    case 3: return 'Still waiting for GPS…';
    default: return 'Getting your location…';
  }
}

// --- Compass ---

let heading = null;
let headingAt = 0;
let compassUsers = 0;
let sawAbsolute = false;
let compassGranted = false;
const headingListeners = new Set();

const screenAngle = () => screen.orientation?.angle ?? window.orientation ?? 0;

function setHeading(deg) {
  if (deg == null || Number.isNaN(deg)) return;
  heading = smoothAngle(heading, normalizeDeg(deg + screenAngle()), 0.3);
  headingAt = Date.now();
  headingListeners.forEach((fn) => fn(heading));
}

// Android Chrome: true heading from the absolute orientation sensor.
function onAbsolute(e) {
  if (e.alpha == null) return;
  sawAbsolute = true;
  setHeading(headingFromOrientation(e.alpha, e.beta, e.gamma));
}

// iPhone gives webkitCompassHeading; some other browsers mark plain events as absolute.
function onRelative(e) {
  if (typeof e.webkitCompassHeading === 'number') setHeading(e.webkitCompassHeading);
  else if (e.absolute && e.alpha != null && !sawAbsolute) setHeading(headingFromOrientation(e.alpha, e.beta, e.gamma));
}

/** iPhone only asks for compass access from a tap. */
export const compassNeedsPermission = () =>
  typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function' && !compassGranted;

export async function requestCompass() {
  try {
    compassGranted = (await DeviceOrientationEvent.requestPermission()) === 'granted';
  } catch {
    compassGranted = false;
  }
  return compassGranted;
}

export function startCompass() {
  if (compassUsers++ > 0) return;
  heading = null;
  sawAbsolute = false;
  window.addEventListener('deviceorientationabsolute', onAbsolute);
  window.addEventListener('deviceorientation', onRelative);
}

export function stopCompass() {
  if (compassUsers === 0 || --compassUsers > 0) return;
  window.removeEventListener('deviceorientationabsolute', onAbsolute);
  window.removeEventListener('deviceorientation', onRelative);
}

export function onHeading(fn) {
  headingListeners.add(fn);
  return () => headingListeners.delete(fn);
}

/** Which way the user is facing: the compass, else their walking direction from GPS, else unknown. */
export function facing() {
  if (heading != null && Date.now() - headingAt < 3000) return { deg: heading, source: 'compass' };
  const fix = current(10000);
  if (fix && Number.isFinite(fix.course) && (fix.speed ?? 0) > 0.6) return { deg: fix.course, source: 'walking' };
  return { deg: null, source: null };
}
