// モデルのローカル保存状態の確認 / 削除 (transformers.js が使う Cache API を直接みる)
const CACHE_NAME = 'transformers-cache';
const HF = 'https://huggingface.co/';

async function keysFor(id) {
  if (!('caches' in self)) return [];
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const prefix = `${HF}${id}/`;
  return keys.filter((r) => r.url.startsWith(prefix));
}

// 端末にこのモデルのファイルが1つでも残っているか(削除対象の表示用)。
// 「使える状態で保存済みか」の判定はワーカーの checkCached で必要ファイルをすべて確認する。
export async function hasModelFiles(id) {
  return (await keysFor(id)).length > 0;
}

export async function deleteModelCache(id) {
  const cache = await caches.open(CACHE_NAME);
  const keys = await keysFor(id);
  await Promise.all(keys.map((k) => cache.delete(k)));
  return keys.length;
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
