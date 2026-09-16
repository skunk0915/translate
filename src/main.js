import '../styles/main.scss';
import { registerSW } from 'virtual:pwa-register';
import { LANGUAGES, requiredModels, pairSupported, directionSupported, routeFor, allKnownModels } from './languages.js';
import * as online from './online.js';
import { kv, history } from './db.js';
import { log } from './logger.js';
import { startRemoteLog, deviceId } from './remote-log.js';
import { hasModelFiles, deleteModelCache, requestPersistentStorage, storageEstimate } from './models.js';
import { createVad } from './vad.js';
import * as tts from './tts.js';

// ------------------------------------------------------------
// 設定
// ------------------------------------------------------------
const DEFAULTS = {
  mode: 'auto', // auto | online | offline
  langA: 'ja',
  langB: 'en',
  whisperSize: 'base',
  device: 'wasm',
  autoListen: true,
  autoSpeak: true,
  rate: 1,
  voices: {}, // lang -> voiceURI
  typedLang: 'A',
};
const settings = { ...DEFAULTS };

async function loadSettings() {
  const saved = await kv.get('settings');
  if (saved) Object.assign(settings, saved);
  if (!LANGUAGES[settings.langA]) settings.langA = DEFAULTS.langA;
  if (!LANGUAGES[settings.langB]) settings.langB = DEFAULTS.langB;
  if (!['tiny', 'base', 'small'].includes(settings.whisperSize)) settings.whisperSize = DEFAULTS.whisperSize;
  if (!['auto', 'online', 'offline'].includes(settings.mode)) settings.mode = DEFAULTS.mode;
}

// オンラインモードを使うか(自動のときは通信可否で決める)
const useOnline = () => settings.mode === 'online' || (settings.mode === 'auto' && navigator.onLine);
const saveSettings = () => kv.set('settings', { ...settings });

// ホーム画面から起動しているか
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// iOS は Safari とホーム画面のアプリで保存領域が別々なので、Safari で保存したデータはアプリから見えない
const iosSeparateStorage = () => isIOS && !isStandalone();
const IOS_STORAGE_HINT = '（iPhone / iPad では Safari とホーム画面のアプリで保存場所が別です。ホーム画面に追加したアプリからダウンロードしてください）';
const IOS_SMALL_WARNING = 'iPhone では音声認識「大」を使うと、翻訳モデルと合わせてメモリの上限を超え、アプリが強制終了する可能性が高いです。';
const renderWhisperNote = () => (el.whisperNote.textContent = isIOS && settings.whisperSize === 'small' ? IOS_SMALL_WARNING : '');
// Service Worker がページを制御していれば、インストール(アプリ本体のプリキャッシュ)は完了している
let appShellReady = !!navigator.serviceWorker?.controller;

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  pairA: $('pairA'),
  pairB: $('pairB'),
  pairButton: $('pairButton'),
  modeChip: $('modeChip'),
  status: $('status'),
  statusText: $('statusText'),
  modelBanner: $('modelBanner'),
  modelBannerTitle: $('modelBannerTitle'),
  modelBannerText: $('modelBannerText'),
  modelBannerAction: $('modelBannerAction'),
  micBanner: $('micBanner'),
  micBannerText: $('micBannerText'),
  micBannerAction: $('micBannerAction'),
  conversation: $('conversation'),
  conversationEmpty: $('conversationEmpty'),
  textInput: $('textInput'),
  textSend: $('textSend'),
  micButton: $('micButton'),
  micLabel: $('micLabel'),
  stopSpeak: $('stopSpeak'),
  autoSpeakToggle: $('autoSpeakToggle'),
  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
  historyClear: $('historyClear'),
  langA: $('langA'),
  langB: $('langB'),
  pairNote: $('pairNote'),
  modelList: $('modelList'),
  downloadAll: $('downloadAll'),
  storageNote: $('storageNote'),
  storageInfo: $('storageInfo'),
  whisperSize: $('whisperSize'),
  whisperNote: $('whisperNote'),
  device: $('device'),
  autoListenToggle: $('autoListenToggle'),
  voiceA: $('voiceA'),
  voiceB: $('voiceB'),
  voiceALabel: $('voiceALabel'),
  voiceBLabel: $('voiceBLabel'),
  rate: $('rate'),
  rateValue: $('rateValue'),
  voiceTest: $('voiceTest'),
  logView: $('logView'),
  logRefresh: $('logRefresh'),
  logCopy: $('logCopy'),
  logClear: $('logClear'),
  deviceIdText: $('deviceIdText'),
  versionText: $('versionText'),
  toast: $('toast'),
};

let toastTimer = null;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}

const STATUS_LABEL = {
  idle: '待機中',
  loading: 'モデル読込中',
  listening: '聞き取り中',
  hearing: '発話を検出',
  transcribing: '文字起こし中',
  translating: '翻訳中',
  speaking: '読み上げ中',
  missing: 'データ未DL',
  error: 'エラー',
};
function setStatus(state, text) {
  el.status.dataset.state = state;
  el.statusText.textContent = text ?? STATUS_LABEL[state] ?? state;
}

function showView(name) {
  el.app.dataset.view = name;
  document.querySelectorAll('.tabbar__item').forEach((b) => {
    if (b.dataset.viewTarget === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'history') renderHistory();
  if (name === 'settings') {
    renderMode();
    renderModelList();
    renderStorageInfo();
    renderVoices();
    renderLog();
  }
}

// ------------------------------------------------------------
// Worker (音声認識・翻訳)
// ------------------------------------------------------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map(); // id -> {resolve,reject}
const loadWaiters = new Map(); // key -> {resolve,reject}
const downloadWaiters = new Map(); // key -> {resolve,reject,promise} ファイル保存のみ(メモリには読み込まない)
const unloadWaiters = new Map(); // key -> {resolve,reject}
let loadBlockedBy = null; // 前回、読み込み中に強制終了したときの記録。同じ強制終了を繰り返さないよう自動読み込みを止める
const loaded = new Set(); // 読み込み済みモデル key
const cachedKeys = new Map(); // key -> 必要ファイルがすべて端末(Cache API)に保存済みか
let preparing = 0; // ensureModels 実行中の数(逐次読み込みの合間も「読み込み中」と表示するため)
const progress = new Map(); // key -> { files: Map(file -> {loaded,total}) }
let seq = 0;

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'progress': {
      let p = progress.get(m.key);
      if (!p) progress.set(m.key, (p = { files: new Map() }));
      p.files.set(m.file, { loaded: m.loaded, total: m.total, done: m.status === 'done' });
      renderModelProgress(m.key);
      break;
    }
    case 'downloaded': {
      progress.delete(m.key);
      downloadWaiters.get(m.key)?.resolve();
      downloadWaiters.delete(m.key);
      log.info('ダウンロード完了', { key: m.key });
      renderModelList();
      break;
    }
    case 'loaded': {
      clearLoadingMark();
      loaded.add(m.key);
      progress.delete(m.key);
      loadWaiters.get(m.key)?.resolve();
      loadWaiters.delete(m.key);
      log.info('モデル読込完了', { key: m.key });
      renderModelList();
      updateReadiness();
      break;
    }
    case 'unloaded': {
      loaded.delete(m.key);
      unloadWaiters.get(m.key)?.resolve();
      unloadWaiters.delete(m.key);
      renderModelList();
      updateReadiness();
      break;
    }
    case 'transcribed':
    case 'translated':
    case 'cacheStatus': {
      pending.get(m.id)?.resolve(m);
      pending.delete(m.id);
      break;
    }
    case 'error': {
      const err = new Error(m.message);
      log.error(`worker エラー (${m.op})`, { key: m.key, message: m.message });
      if (m.id != null && pending.has(m.id)) {
        pending.get(m.id).reject(err);
        pending.delete(m.id);
      } else if (m.op === 'unload' && unloadWaiters.has(m.key)) {
        unloadWaiters.get(m.key).reject(err);
        unloadWaiters.delete(m.key);
      } else if (m.op === 'download' && downloadWaiters.has(m.key)) {
        downloadWaiters.get(m.key).reject(err);
        downloadWaiters.delete(m.key);
        progress.delete(m.key);
        renderModelList();
      } else if (m.key && loadWaiters.has(m.key)) {
        clearLoadingMark();
        loadWaiters.get(m.key).reject(err);
        loadWaiters.delete(m.key);
        progress.delete(m.key);
        renderModelList();
      } else {
        toast(`エラー: ${m.message}`);
      }
      break;
    }
  }
};
worker.onerror = (e) => log.error('worker 実行エラー', { message: e.message });

function call(msg, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

function loadModel(entry) {
  if (loaded.has(entry.key)) return Promise.resolve();
  if (loadWaiters.has(entry.key)) return loadWaiters.get(entry.key).promise;
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  loadWaiters.set(entry.key, { resolve, reject, promise });
  progress.set(entry.key, { files: new Map() });
  renderModelList();
  const type = entry.kind === 'whisper' ? 'loadWhisper' : 'loadMT';
  log.info('モデル読込開始', { key: entry.key, id: entry.id, device: settings.device });
  markLoading(entry.key);
  worker.postMessage({ type, key: entry.key, id: entry.id, device: settings.device });
  return promise;
}

// ファイルだけを端末に保存する(メモリには読み込まない)
function downloadFiles(entry) {
  if (downloadWaiters.has(entry.key)) return downloadWaiters.get(entry.key).promise;
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  downloadWaiters.set(entry.key, { resolve, reject, promise });
  progress.set(entry.key, { files: new Map() });
  renderModelList();
  log.info('ダウンロード開始', { key: entry.key, id: entry.id });
  worker.postMessage({ type: 'download', key: entry.key, kind: entry.kind, id: entry.id, device: settings.device });
  return promise;
}

// 読み込み中にアプリが強制終了(主にメモリ不足)したことを次回起動時に検出するための印。
// IndexedDB は非同期で、書き込む前に落ちることがあるため、同期で書ける localStorage を使う。
const LOADING_MARK = 'transrate.loadingModel';
function markLoading(key) {
  try {
    localStorage.setItem(LOADING_MARK, JSON.stringify({ key, at: Date.now(), alreadyLoaded: [...loaded] }));
  } catch (e) {
    log.warn('読み込み中の印を保存できません', e);
  }
}
function clearLoadingMark() {
  try {
    localStorage.removeItem(LOADING_MARK);
  } catch (e) {
    log.warn('読み込み中の印を消せません', e);
  }
}
function takeLoadingMark() {
  try {
    const v = localStorage.getItem(LOADING_MARK);
    localStorage.removeItem(LOADING_MARK);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    log.warn('読み込み中の印を読めません', e);
    return null;
  }
}

function unloadModel(key) {
  return new Promise((resolve, reject) => {
    unloadWaiters.set(key, { resolve, reject });
    worker.postMessage({ type: 'unload', key });
  });
}

const currentRequired = () => requiredModels(settings.langA, settings.langB, settings.whisperSize);

// iPhone はメモリ上限が低く、超えるとページごと強制終了される。
// 実機ログ(2026-09-16): 音声認識(大)249MB + 翻訳109MB の読み込みは成功し、そこへ翻訳145MB を読み込み始めた直後に強制終了。
// 読み込み中は同じ大きさの一時メモリも使うため、同時にメモリへ載せるモデルの合計(ファイルサイズ)をこの値までに抑える。
const IOS_MODEL_BUDGET_MB = 340;
// 全モデルが上限に収まらないときは、音声認識 + 今の翻訳方向に必要な翻訳モデルだけを載せ、方向が変わったら入れ替える
const usesSwap = () => isIOS && currentRequired().reduce((sum, m) => sum + m.sizeMB, 0) > IOS_MODEL_BUDGET_MB;
// 入れ替え方式では、翻訳モデルは保存済みなら翻訳時に読み込むので、未読み込みでも準備完了とみなす
const needsLoad = (m) => !loaded.has(m.key) && !(usesSwap() && m.kind === 'mt' && cachedKeys.get(m.key) === true);
const offlineReady = () => pairSupported(settings.langA, settings.langB) && !currentRequired().some(needsLoad);
const bySizeDesc = (a, b) => b.sizeMB - a.sizeMB;
const isReady = () => (useOnline() ? true : offlineReady());

function renderModeChip() {
  const on = useOnline();
  el.modeChip.dataset.mode = on ? 'online' : 'offline';
  el.modeChip.textContent = on ? 'オンライン' : 'オフライン';
  el.modeChip.title = settings.mode === 'auto' ? `自動（現在: ${on ? 'オンライン' : 'オフライン'}）` : '';
}

function updateReadiness() {
  renderModeChip();
  const supported = pairSupported(settings.langA, settings.langB);
  const missing = currentRequired().filter(needsLoad);
  const loadingNow = preparing > 0 || missing.some((m) => loadWaiters.has(m.key) || downloadWaiters.has(m.key));
  if (useOnline()) {
    el.modelBanner.hidden = true;
    if (!listening && !busy) setStatus('idle');
    el.micButton.disabled = settings.langA === settings.langB;
    return;
  }
  if (!supported) {
    el.modelBanner.hidden = false;
    el.modelBannerTitle.textContent = 'この言語の組み合わせはオフライン未対応です';
    el.modelBannerText.textContent = 'オンラインモードに切り替えるか、設定で言語を変更してください。';
    setStatus('missing', '未対応ペア');
  } else if (missing.length) {
    el.modelBanner.hidden = false;
    const notSaved = missing.filter((m) => cachedKeys.get(m.key) !== true);
    if (loadingNow) {
      el.modelBannerTitle.textContent = notSaved.length ? '言語データをダウンロードしています' : '保存済みの言語データを読み込んでいます';
      el.modelBannerText.textContent = '読み込みが終わると自動で聞き取りを始めます。';
      setStatus('loading');
    } else if (notSaved.length) {
      el.modelBannerTitle.textContent = '言語データが未ダウンロードです';
      el.modelBannerText.textContent = `設定画面から ${notSaved.map((m) => m.label).join('、')} をダウンロードしてください。${iosSeparateStorage() ? IOS_STORAGE_HINT : ''}`;
      setStatus('missing');
    } else if (loadBlockedBy) {
      el.modelBannerTitle.textContent = '前回、言語データの読み込み中にアプリが強制終了しました';
      el.modelBannerText.textContent = 'メモリ不足の可能性があるため、自動での読み込みを止めています。設定で音声認識モデルを小さくしてから「読み込む」を押してください。';
      setStatus('error', '読込停止中');
    } else {
      el.modelBannerTitle.textContent = '言語データを読み込めませんでした';
      el.modelBannerText.textContent = '端末には保存されています。設定画面の「読み込む」を押してください。繰り返す場合は処理ログを確認してください。';
      setStatus('error', '読込失敗');
    }
  } else {
    el.modelBanner.hidden = true;
    if (!listening && !busy) setStatus('idle');
  }
  el.micButton.disabled = !supported;
}

// 保存済み(キャッシュ済み)のモデルをすべて読み込む。未保存のものは download=true のときだけ取得する。
async function ensureModels({ download = false } = {}) {
  if (!pairSupported(settings.langA, settings.langB)) {
    updateReadiness();
    return false;
  }
  if (useOnline() && !download && currentRequired().some((m) => loadWaiters.has(m.key))) return offlineReady();
  preparing++;
  try {
    const pendingModels = currentRequired().filter((m) => !loaded.has(m.key));
    await refreshCacheStatus(pendingModels);
    if (download) {
      // まずファイルを端末に保存するだけ(メモリには読み込まない)
      const toDownload = pendingModels.filter((m) => cachedKeys.get(m.key) !== true);
      updateReadiness();
      for (const m of toDownload) {
        try {
          await downloadFiles(m);
        } catch (e) {
          toast(`${m.label} のダウンロードに失敗: ${e.message}`, 5000);
        }
      }
      await verifySaved(toDownload);
    }
    if (loadBlockedBy) {
      updateReadiness();
      return offlineReady();
    }
    // 別のペアや別の大きさの音声認識など、今は使わないモデルはメモリから外す
    const requiredKeys = new Set(currentRequired().map((m) => m.key));
    for (const key of [...loaded]) if (!requiredKeys.has(key)) await unloadModel(key);
    let targets = pendingModels.filter((m) => cachedKeys.get(m.key) === true);
    if (usesSwap()) {
      // 入れ替え方式: 既に載っている翻訳モデルと重なりが多い方向(同じなら A→B)を選び、その方向の翻訳モデルだけを揃える
      const routes = [routeFor(settings.langA, settings.langB), routeFor(settings.langB, settings.langA)]
        .filter(Boolean)
        .map((r) => new Set(r.map((s) => s.key)));
      const overlap = (r) => [...loaded].filter((k) => r.has(k)).length;
      const route = routes.reduce((best, r) => (overlap(r) > overlap(best) ? r : best));
      for (const key of [...loaded]) if (key.startsWith('mt:') && !route.has(key)) await unloadModel(key);
      targets = targets.filter((m) => m.kind === 'whisper' || route.has(m.key));
    }
    updateReadiness();
    // 1つずつ、大きいモデルから読み込む(同時や小さい順だと、読み込み中の一時メモリを含むピークが大きくなりスマホでは落ちる)
    targets.sort(bySizeDesc);
    for (const m of targets) {
      try {
        await loadModel(m);
      } catch (e) {
        toast(`${m.label} の読み込みに失敗: ${e.message}`, 5000);
      }
    }
  } finally {
    preparing--;
  }
  updateReadiness();
  return offlineReady();
}

// オフラインで使えない理由(利用者向けの文言)。「未保存」と「保存済みだが読み込めない」を区別する。
function offlineProblem() {
  if (!pairSupported(settings.langA, settings.langB)) return 'この言語の組み合わせはオフライン未対応です';
  const missing = currentRequired().filter(needsLoad);
  const notSaved = missing.filter((m) => cachedKeys.get(m.key) !== true);
  if (notSaved.length) return `端末に保存されていない言語データがあります: ${notSaved.map((m) => m.label).join('、')}`;
  return `保存済みの言語データを読み込めませんでした: ${missing.map((m) => m.label).join('、')}（設定の処理ログを確認してください）`;
}

// 必要ファイルがすべて端末に保存されているかをワーカーで確認し cachedKeys に反映する
async function refreshCacheStatus(models) {
  if (!models.length) return {};
  const { result } = await call({ type: 'checkCached', device: settings.device, models: models.map(({ key, kind, id }) => ({ key, kind, id })) });
  for (const m of models) cachedKeys.set(m.key, result[m.key].cached);
  return result;
}

// ダウンロードしたモデルが実際に端末へ保存されたかを確認する。
// transformers.js は容量不足などで保存に失敗しても警告だけで処理を続けるため、ここで検出して知らせる。
async function verifySaved(models) {
  const result = await refreshCacheStatus(models);
  const failed = models.filter((m) => !result[m.key].cached);
  if (failed.length) {
    log.error('言語データを端末に保存できませんでした', failed.map((m) => ({ key: m.key, missing: result[m.key].missing })));
    toast(`${failed.map((m) => m.label).join('、')} を端末に保存できませんでした。空き容量を確認してください（このままでは再起動後に再ダウンロードが必要です）`, 8000);
  }
  return failed.length === 0;
}

// 翻訳の直前に、その方向に必要な翻訳モデルをメモリに載せる。入れ替え方式では他の方向の翻訳モデルを先に外す。
async function ensureRoute(route) {
  const need = new Set(route.map((s) => s.key));
  const toLoad = currentRequired().filter((m) => need.has(m.key) && !loaded.has(m.key)).sort(bySizeDesc);
  if (!toLoad.length) return;
  const toUnload = usesSwap() ? [...loaded].filter((k) => k.startsWith('mt:') && !need.has(k)) : [];
  setStatus('loading', '翻訳モデルを入れ替え中');
  log.info('翻訳モデルを入れ替え', { unload: toUnload, load: toLoad.map((m) => m.key) });
  const t0 = performance.now();
  for (const key of toUnload) await unloadModel(key);
  for (const m of toLoad) await loadModel(m);
  log.info('翻訳モデルの入れ替え完了', { ms: Math.round(performance.now() - t0) });
}

// ------------------------------------------------------------
// 会話処理
// ------------------------------------------------------------
let vad = null;
let listening = false;
let busy = false;
const queue = [];
let wakeLock = null;

const otherLang = (l) => (l === settings.langA ? settings.langB : settings.langA);

// Whisper が無音や雑音に対して出しがちな定型文。翻訳対象から除外する。
const HALLUCINATIONS = [
  /^ご視聴ありがとうございました[。.]?$/,
  /^おやすみなさい[。.]?$/,
  /^Thank you for watching[.!]?$/i,
  /^Thanks for watching[.!]?$/i,
  /^You$/i,
];
const isNoise = (t) => !t || !/[\p{L}\p{N}]/u.test(t) || HALLUCINATIONS.some((r) => r.test(t.trim()));

function enqueue(job) {
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      await handleJob(job);
    }
  } finally {
    busy = false;
    updateReadiness();
    if (listening) setStatus('listening');
  }
}

async function handleJob(job) {
  if (!isReady()) {
    toast('言語データが揃っていないため処理できません');
    return;
  }
  const onlineMode = useOnline();
  const pendingEl = showPendingBubble(job.kind === 'audio' ? (onlineMode ? '送信中…' : '聞き取り中…') : job.text);
  try {
    let srcLang, srcText, dstLang, dstText;
    let detectMs = null, transcribeMs = null, translateMs = null;
    if (onlineMode) {
      // ---- オンライン: 音声はサーバーで 言語判定+文字起こし+翻訳 を一度に行う ----
      setStatus('translating', 'オンライン翻訳中');
      if (job.kind === 'audio') {
        const r = await online.recognizeAndTranslate(job.audio, [settings.langA, settings.langB]);
        srcLang = r.lang;
        srcText = (r.transcript ?? '').trim();
        dstText = (r.translation ?? '').trim();
        translateMs = r.ms;
        log.info('オンライン音声翻訳', { lang: srcLang, text: srcText, ms: r.ms, sec: job.seconds });
        if (isNoise(srcText) || !dstText) {
          pendingEl.remove();
          log.info('無音/ノイズとして破棄', { text: srcText });
          return;
        }
        dstLang = otherLang(srcLang);
      } else {
        srcLang = job.lang;
        srcText = job.text;
        dstLang = otherLang(srcLang);
        const r = await online.translateText(srcText, srcLang, dstLang);
        dstText = (r.translation ?? '').trim();
        translateMs = r.ms;
        log.info('オンライン翻訳', { from: srcLang, to: dstLang, ms: r.ms, text: dstText });
      }
    } else {
      // ---- オフライン: Whisper → Marian(必要なら英語経由) ----
      if (job.kind === 'audio') {
        setStatus('transcribing');
        const langs = [settings.langA, settings.langB].map((c) => ({ code: c, whisper: LANGUAGES[c].whisper, post: LANGUAGES[c].post }));
        const r = await call({ type: 'transcribe', audio: job.audio, langs }, [job.audio.buffer]);
        srcLang = r.lang;
        srcText = r.text;
        detectMs = r.detectMs;
        transcribeMs = r.transcribeMs;
        log.info('文字起こし', { lang: srcLang, text: srcText, detectMs, transcribeMs, sec: job.seconds });
        if (isNoise(srcText)) {
          pendingEl.remove();
          log.info('無音/ノイズとして破棄', { text: srcText });
          return;
        }
        pendingEl.querySelector('.bubble__src').textContent = srcText;
        pendingEl.querySelector('.bubble__dst').textContent = '翻訳中…';
      } else {
        srcLang = job.lang;
        srcText = job.text;
      }
      dstLang = otherLang(srcLang);
      const route = routeFor(srcLang, dstLang);
      if (!route) {
        pendingEl.remove();
        const msg = `${LANGUAGES[srcLang].name} → ${LANGUAGES[dstLang].name} はオフラインでは翻訳できません。オンラインモードを使ってください。`;
        log.warn('オフライン未対応方向', { from: srcLang, to: dstLang, text: srcText });
        toast(msg, 5000);
        return;
      }
      await ensureRoute(route);
      setStatus('translating');
      const t = await call({ type: 'translate', route: route.map((r) => ({ key: r.key })), text: srcText, post: LANGUAGES[dstLang].post });
      dstText = t.text;
      translateMs = t.ms;
      log.info('翻訳', { from: srcLang, to: dstLang, ms: t.ms, steps: t.steps });
    }
    const entry = {
      ts: Date.now(),
      srcLang,
      dstLang,
      srcText,
      dstText,
      detectMs,
      transcribeMs,
      translateMs,
      source: job.kind,
      mode: onlineMode ? 'online' : 'offline',
    };
    entry.id = await history.add(entry);
    pendingEl.remove();
    appendBubble(entry);
    if (settings.autoSpeak) await speakEntry(entry);
  } catch (e) {
    pendingEl.remove();
    log.error('会話処理に失敗', e);
    toast(`処理に失敗しました: ${e.message}`, 5000);
  }
}

async function speakEntry(entry) {
  if (!tts.ttsSupported) {
    toast('この端末は読み上げに対応していません');
    return;
  }
  const wasListening = listening;
  if (wasListening) await vad?.pause(); // 自分の読み上げをマイクが拾わないように止める
  setStatus('speaking');
  try {
    await tts.speak(entry.dstText, LANGUAGES[entry.dstLang].tts, { voiceURI: settings.voices[entry.dstLang], rate: settings.rate });
  } catch (e) {
    log.warn('読み上げ失敗', e);
    toast(e.message);
  } finally {
    if (wasListening && listening) {
      await new Promise((r) => setTimeout(r, 300));
      await vad?.start();
      setStatus('listening');
    }
  }
}

// ---- 聞き取り ----
async function startListening() {
  if (listening) return true;
  if (!isReady()) {
    updateReadiness();
    showView('settings');
    toast('先に言語データをダウンロードするか、オンラインモードに切り替えてください');
    return false;
  }
  try {
    if (!vad) {
      setStatus('loading', 'マイク準備中');
      vad = await createVad({
        onSpeechStart: () => {
          if (listening && !busy) setStatus('hearing');
        },
        onSpeechEnd: (audio) => {
          const seconds = +(audio.length / 16000).toFixed(1);
          log.info('発話区間を検出', { seconds });
          // Whisper の1ウィンドウ(30秒)を超える分は切り捨てる
          const clipped = audio.length > 16000 * 30 ? audio.slice(0, 16000 * 30) : audio;
          enqueue({ kind: 'audio', audio: clipped, seconds });
        },
        onMisfire: () => {
          if (listening && !busy) setStatus('listening');
        },
      });
    }
    await vad.start();
    listening = true;
    el.micBanner.hidden = true;
    el.micButton.dataset.active = 'true';
    el.micButton.setAttribute('aria-pressed', 'true');
    el.micLabel.textContent = '自動聞き取り 動作中';
    setStatus('listening');
    log.info('聞き取り開始');
    acquireWakeLock();
    return true;
  } catch (e) {
    log.error('マイク開始に失敗', e);
    const msg =
      e.name === 'NotAllowedError'
        ? 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可するか、下のボタンを押して許可してください。'
        : e.name === 'NotFoundError'
          ? 'マイクが見つかりません。'
          : e.message;
    el.micBannerText.textContent = msg;
    el.micBanner.hidden = false;
    setStatus('error', 'マイク未使用');
    return false;
  }
}

async function stopListening() {
  if (!listening) return;
  listening = false;
  await vad?.pause();
  el.micButton.dataset.active = 'false';
  el.micButton.setAttribute('aria-pressed', 'false');
  el.micLabel.textContent = '自動聞き取り 停止中';
  setStatus('idle');
  log.info('聞き取り停止');
  releaseWakeLock();
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch (e) {
    log.warn('画面スリープ防止を取得できず', e);
  }
}
function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && listening) acquireWakeLock();
});

// ------------------------------------------------------------
// 会話ビュー描画
// ------------------------------------------------------------
const timeFmt = (ts) => new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

function bubbleEl(entry) {
  const side = entry.srcLang === settings.langA ? 'a' : 'b';
  const src = LANGUAGES[entry.srcLang];
  const dst = LANGUAGES[entry.dstLang];
  const art = document.createElement('article');
  art.className = `bubble bubble--${side}`;
  art.dataset.id = entry.id;
  art.innerHTML = `
    <div class="bubble__meta"><span>${src.flag} ${src.name}</span><span class="bubble__arrow">→</span><span>${dst.flag} ${dst.name}</span><span class="bubble__mode">${entry.mode === 'online' ? 'オンライン' : 'オフライン'}</span><time>${timeFmt(entry.ts)}</time></div>
    <p class="bubble__src"></p>
    <p class="bubble__dst"></p>
    <div class="bubble__actions">
      <button class="btn btn--ghost btn--small" type="button" data-action="speak">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>
        読み上げ
      </button>
    </div>`;
  art.querySelector('.bubble__src').textContent = entry.srcText;
  art.querySelector('.bubble__dst').textContent = entry.dstText;
  art.querySelector('[data-action="speak"]').addEventListener('click', () => speakEntry(entry));
  return art;
}

function appendBubble(entry) {
  el.conversationEmpty.hidden = true;
  el.conversation.appendChild(bubbleEl(entry));
  el.conversation.scrollTop = el.conversation.scrollHeight;
}

function showPendingBubble(text) {
  el.conversationEmpty.hidden = true;
  const art = document.createElement('article');
  art.className = 'bubble bubble--pending';
  art.innerHTML = `<p class="bubble__src"></p><p class="bubble__dst">…</p>`;
  art.querySelector('.bubble__src').textContent = text;
  el.conversation.appendChild(art);
  el.conversation.scrollTop = el.conversation.scrollHeight;
  return art;
}

async function renderRecent() {
  const all = await history.all();
  const recent = all.slice(0, 30).reverse();
  el.conversation.querySelectorAll('.bubble').forEach((b) => b.remove());
  el.conversationEmpty.hidden = recent.length > 0;
  for (const e of recent) el.conversation.appendChild(bubbleEl(e));
  el.conversation.scrollTop = el.conversation.scrollHeight;
}

// ------------------------------------------------------------
// 履歴ビュー
// ------------------------------------------------------------
const dateFmt = (ts) =>
  new Date(ts).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

async function renderHistory() {
  const all = await history.all();
  el.historyList.innerHTML = '';
  el.historyEmpty.hidden = all.length > 0;
  el.historyClear.hidden = all.length === 0;
  for (const entry of all) {
    const src = LANGUAGES[entry.srcLang] ?? { flag: '', name: entry.srcLang };
    const dst = LANGUAGES[entry.dstLang] ?? { flag: '', name: entry.dstLang };
    const li = document.createElement('li');
    li.className = 'history__item';
    li.innerHTML = `
      <div class="history__meta"><time>${dateFmt(entry.ts)}</time><span>${src.flag} ${src.name} → ${dst.flag} ${dst.name}</span></div>
      <p class="history__src"></p>
      <p class="history__dst"></p>
      <div class="history__actions">
        <button class="btn btn--ghost btn--small" type="button" data-action="speak">読み上げ</button>
        <button class="btn btn--ghost btn--small btn--danger" type="button" data-action="delete">削除</button>
      </div>`;
    li.querySelector('.history__src').textContent = entry.srcText;
    li.querySelector('.history__dst').textContent = entry.dstText;
    li.querySelector('[data-action="speak"]').addEventListener('click', () => speakEntry(entry));
    li.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      await history.remove(entry.id);
      li.remove();
      el.conversation.querySelector(`.bubble[data-id="${entry.id}"]`)?.remove();
      const rest = el.historyList.children.length;
      el.historyEmpty.hidden = rest > 0;
      el.historyClear.hidden = rest === 0;
      log.info('履歴を削除', { id: entry.id });
    });
    el.historyList.appendChild(li);
  }
}

el.historyClear.addEventListener('click', async () => {
  if (!confirm('履歴をすべて削除します。よろしいですか？')) return;
  await history.clear();
  log.info('履歴を全削除');
  renderHistory();
  renderRecent();
});

// ------------------------------------------------------------
// 設定ビュー
// ------------------------------------------------------------
function fillLangSelect(select, value) {
  select.innerHTML = '';
  for (const [code, l] of Object.entries(LANGUAGES)) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = l.native === l.name ? `${l.flag} ${l.name}` : `${l.flag} ${l.name} / ${l.native}`;
    select.appendChild(o);
  }
  select.value = value;
}

function renderPair() {
  // ヘッダーは幅が狭いので国旗だけを表示し、言語名は読み上げ用ラベルに入れる
  el.pairA.textContent = LANGUAGES[settings.langA].flag;
  el.pairB.textContent = LANGUAGES[settings.langB].flag;
  el.pairButton.setAttribute('aria-label', `言語ペア: ${LANGUAGES[settings.langA].name} ⇄ ${LANGUAGES[settings.langB].name}（タップで変更）`);
  el.pairButton.title = `${LANGUAGES[settings.langA].name} ⇄ ${LANGUAGES[settings.langB].name}`;
  el.voiceALabel.textContent = `${LANGUAGES[settings.langA].name} の声`;
  el.voiceBLabel.textContent = `${LANGUAGES[settings.langB].name} の声`;
  const a = settings.langA, b = settings.langB;
  const A = LANGUAGES[a], B = LANGUAGES[b];
  if (a === b) el.pairNote.textContent = '同じ言語同士は選べません。';
  else if (!pairSupported(a, b)) el.pairNote.textContent = 'この組み合わせはオフライン未対応です（オンラインモードでは使えます）。';
  else {
    const missing = [];
    if (!directionSupported(a, b)) missing.push(`${A.name} → ${B.name}`);
    if (!directionSupported(b, a)) missing.push(`${B.name} → ${A.name}`);
    const pivot = (routeFor(a, b)?.length === 2 || routeFor(b, a)?.length === 2) ? 'オフラインでは英語を経由して翻訳します。' : '';
    el.pairNote.textContent = missing.length ? `オフラインでは ${missing.join('、')} は翻訳できません（オンラインモードでは可能）。${pivot}` : pivot;
    el.pairNote.className = missing.length ? 'note' : 'note note--info';
    return;
  }
  el.pairNote.className = 'note';
  renderTypedLangControl();
}

async function onPairChanged() {
  await stopListening();
  renderPair();
  await saveSettings();
  log.info('言語ペア変更', { a: settings.langA, b: settings.langB });
  renderModelList();
  renderVoices();
  renderRecent();
  await ensureModels();
  if (isReady() && settings.autoListen) startListening();
}

el.langA.addEventListener('change', () => {
  settings.langA = el.langA.value;
  onPairChanged();
});
el.langB.addEventListener('change', () => {
  settings.langB = el.langB.value;
  onPairChanged();
});
el.pairButton.addEventListener('click', () => showView('settings'));

el.whisperSize.addEventListener('change', async () => {
  settings.whisperSize = el.whisperSize.value;
  loadBlockedBy = null; // モデルを変えたら改めて読み込みを試す
  renderWhisperNote();
  if (isIOS && settings.whisperSize === 'small') toast(IOS_SMALL_WARNING, 8000);
  await saveSettings();
  await stopListening();
  renderModelList();
  await ensureModels();
  if (isReady() && settings.autoListen) startListening();
});

el.device.addEventListener('change', async () => {
  settings.device = el.device.value;
  await saveSettings();
  toast('処理エンジンの変更はアプリ再読み込み後に反映されます');
});

el.autoListenToggle.addEventListener('change', () => {
  settings.autoListen = el.autoListenToggle.checked;
  saveSettings();
});
el.autoSpeakToggle.addEventListener('change', () => {
  settings.autoSpeak = el.autoSpeakToggle.checked;
  saveSettings();
});
el.rate.addEventListener('input', () => {
  settings.rate = Number(el.rate.value);
  el.rateValue.textContent = settings.rate.toFixed(1);
  saveSettings();
});
el.voiceA.addEventListener('change', () => {
  settings.voices[settings.langA] = el.voiceA.value;
  saveSettings();
});
el.voiceB.addEventListener('change', () => {
  settings.voices[settings.langB] = el.voiceB.value;
  saveSettings();
});
el.voiceTest.addEventListener('click', async () => {
  const samples = { ja: 'こんにちは。読み上げのテストです。', en: 'Hello. This is a test of the voice.' };
  for (const lang of [settings.langA, settings.langB]) {
    const text = samples[lang] ?? `${LANGUAGES[lang].native}. 1, 2, 3.`;
    try {
      await tts.speak(text, LANGUAGES[lang].tts, { voiceURI: settings.voices[lang], rate: settings.rate });
    } catch (e) {
      toast(e.message);
    }
  }
});

function renderVoices() {
  for (const [select, lang] of [
    [el.voiceA, settings.langA],
    [el.voiceB, settings.langB],
  ]) {
    const voices = tts.voicesFor(LANGUAGES[lang].tts);
    select.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = voices.length ? '自動' : '（この言語の音声が端末にありません）';
    select.appendChild(auto);
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = `${v.name}${v.localService ? '' : '（オンライン）'}`;
      select.appendChild(o);
    }
    select.value = settings.voices[lang] ?? '';
    if (select.value !== (settings.voices[lang] ?? '')) select.value = '';
  }
}
globalThis.speechSynthesis?.addEventListener?.('voiceschanged', () => renderVoices());

// ---- モデル一覧 ----
const fmtMB = (b) => `${(b / 1024 / 1024).toFixed(0)}MB`;

function modelStatus(key) {
  if (loaded.has(key)) {
    return { state: 'loaded', text: cachedKeys.get(key) === false ? '使用可（端末に未保存・再起動後は再ダウンロードが必要）' : '保存済み・使用可' };
  }
  if (loadWaiters.has(key) || downloadWaiters.has(key)) {
    const p = progress.get(key);
    let l = 0, t = 0;
    p?.files.forEach((f) => ((l += f.loaded), (t += f.total)));
    const pct = t ? Math.min(100, Math.round((l / t) * 100)) : 0;
    const verb = downloadWaiters.has(key) ? 'ダウンロード中' : 'メモリに読み込み中';
    return { state: 'loading', text: t ? `${verb} ${pct}%（${fmtMB(l)} / ${fmtMB(t)}）` : `${verb}…`, pct };
  }
  return null;
}

let renderListSeq = 0;
async function renderModelList() {
  const mySeq = ++renderListSeq;
  const req = currentRequired();
  await refreshCacheStatus(req.filter((m) => !loadWaiters.has(m.key) && !downloadWaiters.has(m.key)));
  // 現在のペアで使わないが端末に残っているモデル(削除用)
  const known = allKnownModels().filter((m) => !req.some((r) => r.key === m.key));
  const knownFlags = await Promise.all(known.map((m) => hasModelFiles(m.id)));
  if (mySeq !== renderListSeq) return; // 後から呼ばれた描画を優先(一覧の重複を防ぐ)
  const cachedFlags = req.map((m) => cachedKeys.get(m.key) === true);
  el.modelList.innerHTML = '';
  req.forEach((m, i) => {
    const swapLater = usesSwap() && m.kind === 'mt';
    const st =
      modelStatus(m.key) ??
      (cachedFlags[i] ? { state: 'cached', text: swapLater ? '保存済み（翻訳するときに読み込み）' : '保存済み' } : { state: 'none', text: '未ダウンロード' });
    const li = document.createElement('li');
    li.className = 'model';
    li.dataset.key = m.key;
    li.dataset.state = st.state;
    li.innerHTML = `
      <div class="model__body">
        <div class="model__name"></div>
        <div class="model__meta"><span class="model__size">約${m.sizeMB}MB</span><span class="model__status"></span></div>
        <div class="model__bar"><span class="model__fill"></span></div>
      </div>
      <div class="model__actions"></div>`;
    li.querySelector('.model__name').textContent = m.label;
    li.querySelector('.model__status').textContent = st.text;
    li.querySelector('.model__fill').style.width = `${st.pct ?? (st.state === 'loaded' || st.state === 'cached' ? 100 : 0)}%`;
    const actions = li.querySelector('.model__actions');
    if (st.state === 'none') {
      const b = document.createElement('button');
      b.className = 'btn btn--small';
      b.type = 'button';
      b.textContent = 'ダウンロード';
      b.addEventListener('click', () => downloadModel(m));
      actions.appendChild(b);
    } else if (st.state === 'cached' && !swapLater) {
      const b = document.createElement('button');
      b.className = 'btn btn--small';
      b.type = 'button';
      b.textContent = '読み込む';
      b.addEventListener('click', () => downloadModel(m));
      actions.appendChild(b);
    }
    if (st.state === 'loaded' || st.state === 'cached') {
      const d = document.createElement('button');
      d.className = 'btn btn--ghost btn--small btn--danger';
      d.type = 'button';
      d.textContent = '削除';
      d.addEventListener('click', () => removeModel(m));
      actions.appendChild(d);
    }
    el.modelList.appendChild(li);
  });

  const others = known.filter((_, i) => knownFlags[i]);
  if (others.length) {
    const head = document.createElement('li');
    head.className = 'models__head';
    head.textContent = '現在のペアでは使わない保存済みデータ';
    el.modelList.appendChild(head);
    for (const m of others) {
      const li = document.createElement('li');
      li.className = 'model';
      li.dataset.state = 'cached';
      li.innerHTML = `<div class="model__body"><div class="model__name"></div><div class="model__meta"><span class="model__size">約${m.sizeMB}MB</span></div></div><div class="model__actions"></div>`;
      li.querySelector('.model__name').textContent = m.label;
      const d = document.createElement('button');
      d.className = 'btn btn--ghost btn--small btn--danger';
      d.type = 'button';
      d.textContent = '削除';
      d.addEventListener('click', () => removeModel(m));
      li.querySelector('.model__actions').appendChild(d);
      el.modelList.appendChild(li);
    }
  }
  el.downloadAll.hidden = req.every((m, i) => loaded.has(m.key) || cachedFlags[i]);
}

function renderModelProgress(key) {
  const li = el.modelList.querySelector(`.model[data-key="${key}"]`);
  if (!li) return;
  const st = modelStatus(key);
  if (!st) return;
  li.dataset.state = st.state;
  li.querySelector('.model__status').textContent = st.text;
  li.querySelector('.model__fill').style.width = `${st.pct ?? 0}%`;
}

async function renderStorageInfo() {
  el.storageNote.textContent = iosSeparateStorage()
    ? 'iPhone / iPad では、Safari で保存した言語データはホーム画面に追加したアプリでは使えません（保存場所が別々です）。先に共有メニューの「ホーム画面に追加」を行い、追加したアプリを開いてからダウンロードしてください。'
    : '';
  const lines = [
    appShellReady
      ? { text: 'アプリ本体: オフラインで起動できます' }
      : { text: 'アプリ本体: オフライン用の保存が終わっていません。ネットに接続したまま、少し待ってから開き直してください', warn: true },
  ];
  const est = await storageEstimate();
  if (est) lines.push({ text: `保存容量: ${fmtMB(est.usage)} 使用 / 上限 約${fmtMB(est.quota)}` });
  const persisted = await navigator.storage?.persisted?.();
  if (persisted === true) lines.push({ text: '自動削除からの保護: 有効' });
  if (persisted === false) lines.push({ text: '自動削除からの保護: 無効（空き容量が少なくなると、ブラウザが保存データを消すことがあります）' });
  el.storageInfo.replaceChildren(
    ...lines.map((l) => Object.assign(document.createElement('p'), { className: l.warn ? 'note' : 'note note--info', textContent: l.text })),
  );
}

async function downloadModel(m) {
  await refreshCacheStatus([m]);
  const wasSaved = cachedKeys.get(m.key) === true;
  if (!navigator.onLine && !wasSaved) {
    toast('オフラインのためダウンロードできません');
    return;
  }
  await requestPersistentStorage();
  try {
    if (wasSaved) {
      // 利用者が明示的に読み込むので、前回の強制終了による自動読み込み停止を解除する
      loadBlockedBy = null;
      await loadModel(m);
      toast(`${m.label} を読み込みました`);
    } else {
      await downloadFiles(m);
      if (await verifySaved([m])) toast(`${m.label} を保存しました`);
      await ensureModels();
    }
    renderModelList();
    updateReadiness();
    if (isReady() && settings.autoListen) startListening();
  } catch (e) {
    toast(`${m.label} の取得に失敗: ${e.message}`);
  }
}

async function removeModel(m) {
  if (!confirm(`${m.label} を端末から削除します。よろしいですか？`)) return;
  if (loaded.has(m.key)) unloadModel(m.key);
  const n = await deleteModelCache(m.id);
  cachedKeys.set(m.key, false);
  log.info('モデル削除', { key: m.key, files: n });
  toast(`${m.label} を削除しました`);
  if (currentRequired().some((r) => r.key === m.key)) await stopListening();
  renderModelList();
  updateReadiness();
}

el.downloadAll.addEventListener('click', async () => {
  if (!navigator.onLine) {
    toast('オフラインのためダウンロードできません');
    return;
  }
  await requestPersistentStorage();
  const ready = await ensureModels({ download: true });
  if (ready) {
    if (currentRequired().every((m) => cachedKeys.get(m.key) === true)) toast('すべての言語データを保存しました');
    if (settings.autoListen) startListening();
  }
  renderStorageInfo();
});
el.modelBannerAction.addEventListener('click', () => showView('settings'));

// ---- ログ ----
async function renderLog() {
  el.deviceIdText.textContent = `端末ID: ${(await deviceId()).slice(0, 8)}`;
  el.logView.textContent = (await log.dump()) || '（ログはありません）';
  el.logView.scrollTop = el.logView.scrollHeight;
}
el.logRefresh.addEventListener('click', renderLog);
el.logClear.addEventListener('click', async () => {
  await log.clear();
  renderLog();
});
el.logCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(await log.dump());
    toast('ログをコピーしました');
  } catch (e) {
    toast(`コピーできませんでした: ${e.message}`);
  }
});

// ------------------------------------------------------------
// テキスト入力
// ------------------------------------------------------------
let typedControl = null;
function renderTypedLangControl() {
  if (!typedControl) {
    typedControl = document.createElement('div');
    typedControl.className = 'seg';
    typedControl.setAttribute('role', 'radiogroup');
    typedControl.setAttribute('aria-label', '入力テキストの言語');
    el.textInput.parentElement.insertBefore(typedControl, el.textInput);
  }
  typedControl.innerHTML = '';
  for (const side of ['A', 'B']) {
    const lang = side === 'A' ? settings.langA : settings.langB;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg__item';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.typedLang === side));
    b.textContent = LANGUAGES[lang].native;
    b.addEventListener('click', () => {
      settings.typedLang = side;
      saveSettings();
      renderTypedLangControl();
    });
    typedControl.appendChild(b);
  }
}

function submitTyped() {
  const text = el.textInput.value.trim();
  if (!text) return;
  el.textInput.value = '';
  const lang = settings.typedLang === 'A' ? settings.langA : settings.langB;
  enqueue({ kind: 'text', text, lang });
}
el.textSend.addEventListener('click', submitTyped);
el.textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    submitTyped();
  }
});

// ------------------------------------------------------------
// 翻訳モード
// ------------------------------------------------------------
function renderMode() {
  document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === settings.mode));
  renderModeChip();
}
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', async () => {
    if (!r.checked) return;
    settings.mode = r.value;
    await saveSettings();
    log.info('翻訳モード変更', { mode: settings.mode, online: navigator.onLine });
    renderModeChip();
    updateReadiness();
    if (!useOnline()) {
      const ready = await ensureModels();
      if (!ready) await stopListening();
    }
    if (isReady() && settings.autoListen && !listening) startListening();
  }),
);
el.modeChip.addEventListener('click', () => showView('settings'));
window.addEventListener('online', () => {
  log.info('通信: オンライン');
  updateReadiness();
  toast(settings.mode === 'auto' ? 'ネット接続を検出。オンライン翻訳に切り替えました' : 'ネットに接続しました');
});
window.addEventListener('offline', async () => {
  log.info('通信: オフライン');
  updateReadiness();
  if (settings.mode === 'auto') {
    // 保存済みでまだ読み込んでいないモデルは端末から読み込んでから判定する
    const ready = await ensureModels();
    if (navigator.onLine) return; // 読み込み中に回線が戻った
    if (ready) {
      toast('ネットが切れました。オフライン翻訳に切り替えました', 5000);
    } else {
      const reason = offlineProblem();
      log.warn('オフライン翻訳に切り替えられません', {
        reason,
        required: currentRequired().map((m) => m.key),
        loaded: [...loaded],
        cached: Object.fromEntries(cachedKeys),
      });
      toast(`ネットが切れました。${reason}`, 8000);
      await stopListening();
    }
  } else if (settings.mode === 'online') toast('ネットが切れました。オンラインモードでは翻訳できません', 5000);
});

// ------------------------------------------------------------
// その他 UI
// ------------------------------------------------------------
el.micButton.addEventListener('click', () => (listening ? stopListening() : startListening()));
el.micBannerAction.addEventListener('click', () => startListening());
el.stopSpeak.addEventListener('click', () => tts.stop());
document.querySelectorAll('.tabbar__item').forEach((b) => b.addEventListener('click', () => showView(b.dataset.viewTarget)));

// 捕捉されなかったエラーも処理ログに残す(サーバーへ送られ、開発者が追跡できる)
window.addEventListener('error', (e) => log.error('未処理のエラー', { message: e.message, source: e.filename, line: e.lineno, col: e.colno }));
window.addEventListener('unhandledrejection', (e) =>
  log.error('未処理の Promise 拒否', e.reason instanceof Error ? e.reason : { reason: String(e.reason) }),
);

// デバッグ用: 16kHz Float32Array を直接流し込める
globalThis.transrateDebug = {
  processAudio: (audio) => enqueue({ kind: 'audio', audio, seconds: +(audio.length / 16000).toFixed(1) }),
  settings,
  state: () => ({
    loaded: [...loaded],
    downloading: [...downloadWaiters.keys()],
    cached: Object.fromEntries(cachedKeys),
    status: el.statusText.textContent,
    banner: el.modelBanner.hidden ? null : el.modelBannerTitle.textContent,
    appShellReady,
  }),
};

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------
async function boot() {
  registerSW({
    immediate: true,
    onOfflineReady: () => {
      appShellReady = true;
      log.info('アプリ本体のオフライン保存が完了');
      renderStorageInfo();
    },
    onRegisterError: (e) => log.error('Service Worker の登録に失敗', e),
  });
  await loadSettings();
  startRemoteLog({ isStandalone: isStandalone(), onEntry: log.onEntry });
  // 前回の読み込み中に強制終了していたら、同じ強制終了を繰り返さないよう自動読み込みを止める
  loadBlockedBy = takeLoadingMark();
  if (loadBlockedBy) log.error('前回、言語データの読み込み中にアプリが強制終了しました（メモリ不足の可能性）', loadBlockedBy);
  fillLangSelect(el.langA, settings.langA);
  fillLangSelect(el.langB, settings.langB);
  el.whisperSize.value = settings.whisperSize;
  renderWhisperNote();
  el.device.value = settings.device;
  el.autoListenToggle.checked = settings.autoListen;
  el.autoSpeakToggle.checked = settings.autoSpeak;
  el.rate.value = settings.rate;
  el.rateValue.textContent = Number(settings.rate).toFixed(1);
  el.versionText.textContent = `Transrate v${__APP_VERSION__}`;
  renderPair();
  renderMode();
  renderVoices();
  await renderRecent();
  log.info('起動', { ua: navigator.userAgent, online: navigator.onLine, mode: settings.mode, pair: [settings.langA, settings.langB], whisper: settings.whisperSize, standalone: isStandalone(), appShellReady });
  setStatus('loading');
  // オフライン用モデルは保存済みなら常に読み込んでおく(自動モードで通信が切れても即座に使えるように)
  const offlineOk = await ensureModels();
  // 上限が極端に小さい場合はプライベートブラウズやアプリ内ブラウザ(閉じると保存データが消える環境)の可能性がある
  log.info('保存容量', { ...(await storageEstimate()), persisted: await navigator.storage?.persisted?.() });
  if (currentRequired().some((m) => cachedKeys.get(m.key))) {
    log.info('保存領域の永続化', { persisted: await requestPersistentStorage() });
  }
  updateReadiness();
  if (isReady() && settings.autoListen) await startListening();
  else if (!useOnline() && !offlineOk) showView('settings');
}

boot().catch((e) => {
  log.error('起動に失敗', e);
  setStatus('error');
  toast(`起動に失敗しました: ${e.message}`);
});
