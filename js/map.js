// Map of last-seen spots, drawn with Leaflet on OpenStreetMap tiles. The service
// worker caches every tile you view, so places you've looked at work offline.
import { escapeHtml, str } from './format.js';

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

let leaflet = null;
let map = null;
let pins = null; // layer group holding one marker per item
const markers = new Map(); // itemId → { marker, key }
let meDot = null;
let meRing = null;
let trail = null;
let hooks = null;
let focus = null;
let framedFor = null;

/**
 * Loads Leaflet the first time the map opens: it is large, and many visits never
 * need it. A failed load is retried the next time the map is opened.
 */
export function load() {
  if (window.L) return Promise.resolve();
  leaflet ??= Promise.all([
    attach('link', { rel: 'stylesheet', href: 'vendor/leaflet/leaflet.css' }),
    attach('script', { src: 'vendor/leaflet/leaflet.js' }),
  ]).catch((err) => {
    leaflet = null;
    throw err;
  });
  return leaflet;
}

function attach(tag, attrs) {
  const url = attrs.href ?? attrs.src;
  if (document.querySelector(`[data-leaflet="${url}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement(tag), attrs);
    el.dataset.leaflet = url;
    el.onload = resolve;
    el.onerror = () => {
      el.remove();
      reject(new Error(`Couldn't load ${url}`));
    };
    // Leaflet's styles go before ours, so the app's overrides win.
    document.head.insertBefore(el, document.querySelector('link[rel="stylesheet"]'));
  });
}

/**
 * Shows the map in `el` (call load() first). Hooks (all from app.js):
 * describe(id) → popup markup, history(id) → events, eventLabel(event) → text,
 * isLost(id) → bool, onPinMoved(id, latlng).
 */
export function show(el, { items, here, focusId = null, ...rest }) {
  hooks = rest;
  focus = focusId;
  if (!map) {
    map = L.map(el, { worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer(TILES, { maxZoom: 19, crossOrigin: true, attribution: ATTRIBUTION }).addTo(map);
    pins = L.layerGroup().addTo(map);
  }
  map.invalidateSize();
  update({ items, here });
  const key = focusId ?? 'all';
  if (framedFor !== key) {
    framedFor = frame(items, here) ? key : null;
  }
  showTrail(focusId);
}

/** Refreshes pins and the you-are-here dot. */
export function update({ items, here }) {
  if (!map || !hooks) return;
  syncPins(items);
  if (here) syncMe(here);
  if (framedFor === null && frame(items, here)) framedFor = focus ?? 'all';
}

export function hide() {
  map?.closePopup();
  focus = null;
}

export const center = () => map?.getCenter();

export function centerOn(point, zoom = 18) {
  if (map && point) map.setView([point.lat, point.lng], zoom);
}

/** Lets the user drag an item's pin; the onPinMoved hook fires when they let go. */
export function enableDrag(itemId) {
  const entry = markers.get(itemId);
  if (!entry) return false;
  entry.marker.closePopup();
  entry.marker.dragging.enable();
  return true;
}

function pinIcon(item, focused, lost) {
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin${focused ? ' focused' : ''}${lost ? ' lost' : ''}"><span>${escapeHtml(item.emoji)}</span></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 48],
    popupAnchor: [0, -44],
  });
}

function syncPins(items) {
  const keep = new Set();
  for (const item of items) {
    if (!item.lastSeen) continue;
    keep.add(item.id);
    const lost = hooks.isLost(item.id);
    const key = `${item.emoji}|${item.id === focus}|${lost}`;
    const latlng = [item.lastSeen.lat, item.lastSeen.lng];
    let entry = markers.get(item.id);
    if (!entry) {
      // Pass the icon up front: Leaflet's default icon would load an image we don't ship.
      const icon = pinIcon(item, item.id === focus, lost);
      const marker = L.marker(latlng, { icon, title: item.name, riseOnHover: true, autoPanOnFocus: false });
      marker.on('dragend', () => {
        marker.dragging.disable();
        hooks.onPinMoved(item.id, marker.getLatLng());
      });
      marker.bindPopup(() => str(hooks.describe(item.id)), { minWidth: 220 });
      marker.addTo(pins);
      entry = { marker, key };
      markers.set(item.id, entry);
    }
    if (!entry.marker.dragging?.enabled()) entry.marker.setLatLng(latlng);
    if (entry.key !== key) {
      entry.marker.setIcon(pinIcon(item, item.id === focus, lost));
      entry.key = key;
    }
  }
  for (const [id, entry] of markers) {
    if (keep.has(id)) continue;
    pins.removeLayer(entry.marker);
    markers.delete(id);
  }
}

function syncMe(here) {
  const latlng = [here.lat, here.lng];
  if (!meDot) {
    meRing = L.circle(latlng, { radius: here.acc || 0, className: 'me-acc', interactive: false }).addTo(map);
    meDot = L.circleMarker(latlng, { radius: 7, className: 'me-dot', interactive: false }).addTo(map);
  } else {
    meRing.setLatLng(latlng).setRadius(here.acc || 0);
    meDot.setLatLng(latlng);
  }
}

/** Fits the view to the focused item or to everything. Returns false if there was nothing to show yet. */
function frame(items, here) {
  const target = items.find((i) => i.id === focus)?.lastSeen;
  if (target) {
    map.setView([target.lat, target.lng], 18);
    markers.get(focus)?.marker.openPopup();
    return true;
  }
  const points = items.filter((i) => i.lastSeen).map((i) => [i.lastSeen.lat, i.lastSeen.lng]);
  if (here) points.push([here.lat, here.lng]);
  if (!points.length) return false;
  if (points.length === 1) map.setView(points[0], 17);
  else map.fitBounds(points, { padding: [48, 48], maxZoom: 17 });
  return true;
}

/** Dashed line through the focused item's recent spots, oldest to newest. */
async function showTrail(itemId) {
  trail?.remove();
  trail = null;
  if (!itemId) return;
  const spots = (await hooks.history(itemId)).filter((e) => e.lat != null).slice(0, 12).reverse();
  if (spots.length < 2 || focus !== itemId) return;
  trail = L.layerGroup([
    L.polyline(spots.map((e) => [e.lat, e.lng]), { className: 'trail', interactive: false }),
    ...spots.slice(0, -1).map((e) => L.circleMarker([e.lat, e.lng], { radius: 5, className: 'trail-dot' }).bindTooltip(hooks.eventLabel(e))),
  ]).addTo(map);
}
