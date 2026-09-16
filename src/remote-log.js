// 処理ログをサーバー(/api/log.php)へ自動送信する。開発者が端末のログをサーバー上で追跡するため。
// - ログは logger.js が IndexedDB に書いたものを、送信済み ID の続きから順に送る(オフライン中は溜まるだけ)
// - 会話の中身(文字起こし・翻訳文)は送らず、文字数だけに置き換える
import { kv, logs } from './db.js';

const API = `${import.meta.env.BASE_URL}api/log.php`;
const BATCH = 50;
const INTERVAL_MS = 30000;
const KEEPALIVE_MAX_BYTES = 60000; // keepalive 付き fetch は本文 64KB まで
const TEXT_KEYS = new Set(['text', 'srcText', 'dstText', 'transcript', 'translation', 'steps']);

const session = crypto.randomUUID();
let device = null;
let standalone = false;
let sending = false;
let errorTimer = null;

export async function deviceId() {
  if (device) return device;
  device = await kv.get('deviceId');
  if (!device) {
    device = crypto.randomUUID();
    await kv.set('deviceId', device);
  }
  return device;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (TEXT_KEYS.has(k)) out[k] = { redacted: true, len: Array.isArray(v) ? v.length : String(v ?? '').length };
    else out[k] = redact(v);
  }
  return out;
}

async function flush() {
  if (sending || !navigator.onLine) return;
  sending = true;
  try {
    let last = (await kv.get('remoteLogLastId')) ?? 0;
    for (;;) {
      const entries = await logs.after(last, BATCH);
      if (!entries.length) break;
      const body = JSON.stringify({
        device: await deviceId(),
        session,
        version: __APP_VERSION__,
        standalone,
        entries: entries.map((e) => ({ id: e.id, ts: e.ts, level: e.level, msg: e.msg, data: redact(e.data) })),
      });
      // 画面を閉じる途中でも送り切れるよう、小さい本文は keepalive で送る
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: body.length <= KEEPALIVE_MAX_BYTES,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      last = entries[entries.length - 1].id;
      await kv.set('remoteLogLastId', last);
      if (entries.length < BATCH) break;
    }
  } catch (e) {
    // 送信失敗は次回送る(未送信分は IndexedDB に残る)。ここで log.* を使うと送信ループになるため console のみ。
    console.warn('ログ送信に失敗', e);
  } finally {
    sending = false;
  }
}

export function startRemoteLog({ isStandalone, onEntry }) {
  standalone = isStandalone;
  flush();
  setInterval(flush, INTERVAL_MS);
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  // エラーはすぐ確認できるよう、少し待って(直後の関連ログもまとめて)送る
  onEntry((entry) => {
    if (entry.level !== 'error' || errorTimer) return;
    errorTimer = setTimeout(() => {
      errorTimer = null;
      flush();
    }, 2000);
  });
}
