// IndexedDB ラッパー: 履歴 / 設定 / 処理ログ
const DB_NAME = 'transrate';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('history')) {
        const s = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        try {
          result = fn(s);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

// ---- 設定 ----
export const kv = {
  get: (key) => tx('kv', 'readonly', (s) => s.get(key)),
  set: (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key)),
};

// ---- 履歴 ----
export const history = {
  add: (entry) => tx('history', 'readwrite', (s) => s.add(entry)),
  all: () =>
    open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const out = [];
          const req = db.transaction('history', 'readonly').objectStore('history').index('ts').openCursor(null, 'prev');
          req.onsuccess = () => {
            const c = req.result;
            if (c) {
              out.push(c.value);
              c.continue();
            } else resolve(out);
          };
          req.onerror = () => reject(req.error);
        }),
    ),
  remove: (id) => tx('history', 'readwrite', (s) => s.delete(id)),
  update: (entry) => tx('history', 'readwrite', (s) => s.put(entry)),
  clear: () => tx('history', 'readwrite', (s) => s.clear()),
};

// ---- ログ ----
const LOG_MAX = 500;
export const logs = {
  add: (entry) => tx('logs', 'readwrite', (s) => s.add(entry)),
  all: () => tx('logs', 'readonly', (s) => s.getAll()),
  // id より後のログを古い順に最大 limit 件(サーバー送信用)
  after: (id, limit) => tx('logs', 'readonly', (s) => s.getAll(IDBKeyRange.lowerBound(id, true), limit)),
  count: () => tx('logs', 'readonly', (s) => s.count()),
  clear: () => tx('logs', 'readwrite', (s) => s.clear()),
  // 古いものから削って LOG_MAX 件に収める
  trim: () =>
    open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction('logs', 'readwrite');
          const s = t.objectStore('logs');
          const countReq = s.count();
          countReq.onsuccess = () => {
            let excess = countReq.result - LOG_MAX;
            if (excess <= 0) return;
            const cur = s.openCursor();
            cur.onsuccess = () => {
              const c = cur.result;
              if (c && excess > 0) {
                c.delete();
                excess--;
                c.continue();
              }
            };
          };
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        }),
    ),
};
