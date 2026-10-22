// Pure geometry for distances, bearings and compass headings.
// No browser APIs here, so Node's test runner can import this file directly.

const EARTH_RADIUS_M = 6371008.8;

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;

/** Wraps any angle into [0, 360). */
export function normalizeDeg(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d >= 360 ? 0 : d + 0; // `+ 0` turns -0 into 0
}

/** Signed smallest rotation from angle `from` to angle `to`, in (-180, 180]. */
export function angleDiff(from, to) {
  const d = normalizeDeg(to - from);
  return d > 180 ? d - 360 : d;
}

/** Great-circle distance in metres between two { lat, lng } points (haversine). */
export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from a to b, in degrees clockwise from true north. */
export function bearing(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** The point reached by travelling `meters` from `from` on compass bearing `deg`. */
export function offset(from, meters, deg) {
  const d = meters / EARTH_RADIUS_M;
  const t = toRad(deg);
  const lat1 = toRad(from.lat);
  const lng1 = toRad(from.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(t));
  const lng2 = lng1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/**
 * Compass heading the user is facing, from a deviceorientationabsolute reading
 * (alpha/beta/gamma in degrees). Held flat-ish, that is where the top edge of the
 * phone points; held upright, it is the direction the back of the phone faces.
 */
export function headingFromOrientation(alpha, beta, gamma) {
  if (alpha == null || Number.isNaN(alpha)) return null;
  if (Math.abs(beta ?? 0) < 50) return normalizeDeg(360 - alpha);
  const a = toRad(alpha);
  const b = toRad(beta);
  const g = toRad(gamma ?? 0);
  // The back of the device, rotated into east/north coordinates (W3C DeviceOrientation spec).
  const east = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
  const north = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
  if (Math.hypot(east, north) < 1e-6) return null;
  return normalizeDeg(toDeg(Math.atan2(east, north)));
}

/** Moves `prev` a fraction `k` of the way toward `next` along the shorter arc. */
export function smoothAngle(prev, next, k = 0.3) {
  if (prev == null) return normalizeDeg(next);
  return normalizeDeg(prev + angleDiff(prev, next) * k);
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** 8-point compass label, e.g. 44 → "NE". */
export function cardinal(deg) {
  return POINTS[Math.round(normalizeDeg(deg) / 45) % 8];
}
