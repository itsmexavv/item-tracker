// IndexedDB storage: `items` (the things you track) and `events` (their history).
// Everything stays on this device.

const DB_NAME = 'item-tracker';
const MAX_EVENTS_PER_ITEM = 200;
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('items', { keyPath: 'id' });
      db.createObjectStore('events', { keyPath: 'id' }).createIndex('byItem', ['itemId', 'at']);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const promisify = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Runs `body(...stores)` in one transaction and resolves with its result once committed. */
async function transact(names, mode, body) {
  const db = await openDb();
  const tx = db.transaction(names, mode);
  const committed = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
  const stores = [].concat(names).map((name) => tx.objectStore(name));
  const [result] = await Promise.all([body(...stores), committed]);
  return result;
}

const itemRange = (itemId) => IDBKeyRange.bound([itemId, -Infinity], [itemId, Infinity]);

export const listItems = () =>
  transact('items', 'readonly', (items) => promisify(items.getAll()))
    .then((all) => all.sort((a, b) => a.createdAt - b.createdAt));

export const getItem = (id) => transact('items', 'readonly', (items) => promisify(items.get(id)));

export const putItem = (item) => transact('items', 'readwrite', (items) => {
  items.put(item);
  return item;
});

export const deleteItem = (id) => transact(['items', 'events'], 'readwrite', (items, events) => {
  items.delete(id);
  events.index('byItem').openCursor(itemRange(id)).onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
});

/** Adds a history event, keeping only the newest MAX_EVENTS_PER_ITEM for that item. */
export const addEvent = (event) => transact('events', 'readwrite', (events) => {
  events.add(event);
  let kept = 0;
  events.index('byItem').openCursor(itemRange(event.itemId), 'prev').onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    if (++kept > MAX_EVENTS_PER_ITEM) cursor.delete();
    cursor.continue();
  };
  return event;
});

/** Newest-first history for one item. */
export const listEvents = (itemId, limit = 50) => transact('events', 'readonly', (events) => new Promise((resolve, reject) => {
  const found = [];
  const req = events.index('byItem').openCursor(itemRange(itemId), 'prev');
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor && found.length < limit) {
      found.push(cursor.value);
      cursor.continue();
    } else {
      resolve(found);
    }
  };
  req.onerror = () => reject(req.error);
}));

export const clearAll = () => transact(['items', 'events'], 'readwrite', (items, events) => {
  items.clear();
  events.clear();
});

/** Asks the browser not to evict our data when storage runs low. Resolves true when granted. */
export async function persistStorage() {
  try {
    return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}
