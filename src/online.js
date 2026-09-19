// オンラインモード: サーバー側プロキシ(/api/translate.php)経由で Gemini を使う。
// API キーはブラウザに存在しない。

const API = `${import.meta.env.BASE_URL}api/translate.php`;

// 16kHz Float32 → 16bit PCM WAV → base64
export function encodeWavBase64(samples, sampleRate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function post(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 70000);
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'オンライン翻訳がタイムアウトしました' : `オンライン翻訳に接続できません: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 本文が JSON でない
  }
  if (!res.ok) throw new Error(json?.error ? `オンライン翻訳エラー: ${json.error}` : `オンライン翻訳エラー (HTTP ${res.status})`);
  return json;
}

// 音声 → { lang, transcript, translation, ms }
export function recognizeAndTranslate(samples, langs, src = null) {
  const body = { audio: encodeWavBase64(samples), langs };
  if (src) body.src = src;
  return post(body);
}

// テキスト → { translation, ms }
export function translateText(text, src, dst) {
  return post({ text, src, dst });
}
