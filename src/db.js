import { auth } from './auth.js';

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

const HISTORY_API = `${import.meta.env.BASE_URL}api/history.php`;

let cachedDeviceId = null;
export async function getDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  cachedDeviceId = await kv.get('deviceId');
  if (!cachedDeviceId) {
    cachedDeviceId = crypto.randomUUID();
    await kv.set('deviceId', cachedDeviceId);
  }
  return cachedDeviceId;
}

// サーバー通信
async function callHistoryApi(action, payload = {}) {
  const device = await getDeviceId();
  const token = auth.getToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(HISTORY_API, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ action, device, token, ...payload }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      if (res.status === 401) {
        auth.clearSession();
      }
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// IndexedDB のローカル低レベル操作
const localHistory = {
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

// サーバーデータをローカルキャッシュに一括同期
async function syncLocalCache(serverEntries) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('history', 'readwrite');
    const s = t.objectStore('history');
    s.clear();
    for (const e of serverEntries) {
      s.put({ ...e, synced: true });
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- 履歴 (サーバー側 SQLite 保存 + IndexedDB キャッシュ/オフラインバッファ) ----
export const history = {
  // 全件取得 (オンラインならサーバーから取得しローカル同期、オフライン時はローカルキャッシュ)
  all: async () => {
    if (navigator.onLine) {
      try {
        const localAll = await localHistory.all();
        const unSynced = localAll.filter((e) => !e.synced);
        if (unSynced.length > 0) {
          const syncRes = await callHistoryApi('sync', { entries: unSynced });
          if (syncRes?.ok && Array.isArray(syncRes.entries)) {
            await syncLocalCache(syncRes.entries);
            return syncRes.entries;
          }
        }
        const res = await callHistoryApi('list', { limit: 200 });
        if (res?.ok && Array.isArray(res.entries)) {
          await syncLocalCache(res.entries);
          return res.entries;
        }
      } catch (e) {
        console.warn('サーバー履歴取得エラー、ローカルキャッシュを使用します', e);
      }
    }
    return localHistory.all();
  },

  // 追加 (オンラインならサーバーへ登録し採番IDでローカル保存)
  add: async (entry) => {
    let serverId = null;
    if (navigator.onLine) {
      try {
        const res = await callHistoryApi('add', { entry });
        if (res?.ok && res.id) serverId = res.id;
      } catch (e) {
        console.warn('サーバーへの履歴保存エラー、ローカルに保留します', e);
      }
    }
    const toSave = { ...entry, synced: serverId !== null };
    if (serverId !== null) toSave.id = serverId;
    const savedId = await localHistory.add(toSave);
    return serverId ?? savedId;
  },

  // 更新 (オンラインならサーバーも更新)
  update: async (entry) => {
    if (navigator.onLine) {
      try {
        await callHistoryApi('update', { entry });
      } catch (e) {
        console.warn('サーバー履歴更新エラー', e);
      }
    }
    await localHistory.update(entry);
  },

  // 削除 (オンラインならサーバーからも削除)
  remove: async (id) => {
    if (navigator.onLine) {
      try {
        await callHistoryApi('remove', { id });
      } catch (e) {
        console.warn('サーバー履歴削除エラー', e);
      }
    }
    await localHistory.remove(id);
  },

  // 全件削除 (オンラインならサーバーも全削除)
  clear: async () => {
    if (navigator.onLine) {
      try {
        await callHistoryApi('clear');
      } catch (e) {
        console.warn('サーバー履歴全削除エラー', e);
      }
    }
    await localHistory.clear();
  },

  // サーバーとの同期
  sync: async () => {
    if (!navigator.onLine) return;
    try {
      const localAll = await localHistory.all();
      const unSynced = localAll.filter((e) => !e.synced);
      const res = await callHistoryApi('sync', { entries: unSynced });
      if (res?.ok && Array.isArray(res.entries)) {
        await syncLocalCache(res.entries);
        return res.entries;
      }
    } catch (e) {
      console.warn('履歴同期エラー', e);
    }
  },
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
