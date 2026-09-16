// 読み上げ(端末内蔵の speechSynthesis)。
const synth = globalThis.speechSynthesis;
let voicesCache = [];

function refreshVoices() {
  if (!synth) return [];
  voicesCache = synth.getVoices();
  return voicesCache;
}
if (synth) {
  refreshVoices();
  synth.addEventListener?.('voiceschanged', refreshVoices);
}

export const ttsSupported = !!synth;

export function voicesFor(langCode) {
  const all = voicesCache.length ? voicesCache : refreshVoices();
  const short = langCode.split('-')[0].toLowerCase();
  return all.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(short));
}

// 自動選択: ローカル(オフライン)音声を優先し、次に既定音声
export function pickVoice(langCode, preferredURI) {
  const list = voicesFor(langCode);
  if (preferredURI) {
    const hit = list.find((v) => v.voiceURI === preferredURI);
    if (hit) return hit;
  }
  return list.find((v) => v.localService && v.default) || list.find((v) => v.localService) || list.find((v) => v.default) || list[0] || null;
}

let current = null;

export function stop() {
  if (!synth) return;
  synth.cancel();
  current = null;
}

export function speak(text, langCode, { voiceURI, rate = 1 } = {}) {
  return new Promise((resolve, reject) => {
    if (!synth) return reject(new Error('この端末は読み上げに対応していません'));
    if (!text) return resolve();
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(langCode, voiceURI);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || langCode;
    u.rate = rate;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      current = null;
      err ? reject(err) : resolve();
    };
    u.onend = () => finish();
    u.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') finish();
      else finish(new Error(`読み上げに失敗: ${e.error}`));
    };
    current = u;
    synth.speak(u);
    // 一部端末で onend が来ない対策: 長さに応じた上限時間で解決する
    setTimeout(() => finish(), Math.min(60000, 3000 + text.length * 250));
  });
}

export function isSpeaking() {
  return !!synth && (synth.speaking || synth.pending);
}
