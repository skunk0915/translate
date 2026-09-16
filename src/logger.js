// 処理ログ。console と IndexedDB の両方へ出し、直近500件だけ保持する。
import { logs } from './db.js';

let writes = 0;
const listeners = new Set();

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function write(level, msg, data) {
  const entry = { ts: Date.now(), level, msg, data: data === undefined ? undefined : safe(data) };
  const line = `[${fmt(entry.ts)}] ${level.toUpperCase()} ${msg}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line, data ?? '');
  try {
    await logs.add(entry);
    if (++writes % 50 === 0) await logs.trim();
  } catch (e) {
    console.warn('log write failed', e);
  }
  listeners.forEach((fn) => fn(entry));
}

function safe(data) {
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack?.split('\n').slice(0, 4).join('\n') };
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return String(data);
  }
}

export const log = {
  info: (m, d) => write('info', m, d),
  warn: (m, d) => write('warn', m, d),
  error: (m, d) => write('error', m, d),
  onEntry: (fn) => listeners.add(fn),
  format: (e) => `${fmt(e.ts)} ${e.level.toUpperCase().padEnd(5)} ${e.msg}${e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''}`,
  async dump() {
    const all = await logs.all();
    return all.map(log.format).join('\n');
  },
  clear: () => logs.clear(),
};
