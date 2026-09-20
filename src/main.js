import '../styles/main.scss';
import { registerSW } from 'virtual:pwa-register';
import { LANGUAGES, requiredModels, pairSupported, directionSupported, routeFor, allKnownModels, detectTextLang } from './languages.js';
import * as online from './online.js';
import { kv, history } from './db.js';
import { auth } from './auth.js';
import { log } from './logger.js';
import { startRemoteLog, deviceId } from './remote-log.js';
import { hasModelFiles, deleteModelCache, requestPersistentStorage, storageEstimate } from './models.js';
import { createVad } from './vad.js';
import { PttRecorder, isSilentAudio } from './recorder.js';
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
  autoSpeak: false,
  rate: 1,
  voices: {}, // lang -> voiceURI
  typedLang: 'A',
  vadSilenceMs: 1400, // 話し終わりの判定(間) ms
  speechDetectMode: 'manual', // manual (プッシュツートーク) | auto (無音検知)
  thinkingLevel: 'minimal',   // minimal (最速) | low (高速) | medium (標準)
  srcFontSize: 'medium',      // small | medium | large | xlarge
  dstFontSize: 'medium',      // small | medium | large | xlarge
};
const settings = { ...DEFAULTS };

async function loadSettings() {
  const saved = await kv.get('settings');
  if (saved) Object.assign(settings, saved);
  settings.autoSpeak = false; // 自動読み上げは既定でオフ（スピーカーボタン押下時のみ再生）
  if (!LANGUAGES[settings.langA]) settings.langA = DEFAULTS.langA;
  if (!LANGUAGES[settings.langB]) settings.langB = DEFAULTS.langB;
  if (!['tiny', 'base', 'small'].includes(settings.whisperSize)) settings.whisperSize = DEFAULTS.whisperSize;
  if (!['auto', 'online', 'offline'].includes(settings.mode)) settings.mode = DEFAULTS.mode;
  if (!settings.vadSilenceMs || isNaN(settings.vadSilenceMs)) settings.vadSilenceMs = DEFAULTS.vadSilenceMs;
  if (!['manual', 'auto'].includes(settings.speechDetectMode)) settings.speechDetectMode = DEFAULTS.speechDetectMode;
  if (!['minimal', 'low', 'medium'].includes(settings.thinkingLevel)) settings.thinkingLevel = DEFAULTS.thinkingLevel;
  if (!['small', 'medium', 'large', 'xlarge'].includes(settings.srcFontSize)) settings.srcFontSize = DEFAULTS.srcFontSize;
  if (!['small', 'medium', 'large', 'xlarge'].includes(settings.dstFontSize)) settings.dstFontSize = DEFAULTS.dstFontSize;
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
  talkNav: $('talkNav'),
  talkBadge: $('talkBadge'),
  talkCounter: $('talkCounter'),
  talkPastBtn: $('talkPastBtn'),
  talkFutureBtn: $('talkFutureBtn'),
  talkCardContainer: $('talkCardContainer'),
  conversation: $('conversation'),
  conversationEmpty: $('conversationEmpty'),
  textInput: $('textInput'),
  textSend: $('textSend'),
  micButton: $('micButton'),
  micLabel: $('micLabel'),
  langABtn: $('langABtn'),
  langBBtn: $('langBBtn'),
  langAFlag: $('langAFlag'),
  langAName: $('langAName'),
  langBFlag: $('langBFlag'),
  langBName: $('langBName'),
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
  vadSilence: $('vadSilence'),
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
  thinkingLevel: $('thinkingLevel'),
  speechDetectMode: $('speechDetectMode'),
  speechDetectNote: $('speechDetectNote'),
  vadSilenceGroup: $('vadSilenceGroup'),
  autoListenToggleGroup: $('autoListenToggleGroup'),
  conversationHint: $('conversationHint'),
  conversationHintSub: $('conversationHintSub'),
  versionText: $('versionText'),
  toast: $('toast'),
  authModal: $('authModal'),
  authForm: $('authForm'),
  authUsername: $('authUsername'),
  authPassword: $('authPassword'),
  authError: $('authError'),
  authSubmit: $('authSubmit'),
  accountUser: $('accountUser'),
  logoutBtn: $('logoutBtn'),
  srcFontSize: $('srcFontSize'),
  dstFontSize: $('dstFontSize'),
  pairArrow: $('pairArrow'),
  langModal: $('langModal'),
  langModalBackdrop: $('langModalBackdrop'),
  langModalClose: $('langModalClose'),
  langModalTabA: $('langModalTabA'),
  langModalTabB: $('langModalTabB'),
  langModalValA: $('langModalValA'),
  langModalValB: $('langModalValB'),
  langModalSwap: $('langModalSwap'),
  langModalHint: $('langModalHint'),
  langModalGrid: $('langModalGrid'),
};

// 文字サイズ設定マッピング
const FONT_CONFIG = {
  src: {
    small: { bubble: '12px', history: '13px' },
    medium: { bubble: '14px', history: '15px' },
    large: { bubble: '17px', history: '18px' },
    xlarge: { bubble: '20px', history: '22px' },
  },
  dst: {
    small: { bubble: '18px', history: '20px' },
    medium: { bubble: '22px', history: '24px' },
    large: { bubble: '26px', history: '30px' },
    xlarge: { bubble: '32px', history: '38px' },
  },
};

function applyFontSizes() {
  const srcCfg = FONT_CONFIG.src[settings.srcFontSize] || FONT_CONFIG.src.medium;
  const dstCfg = FONT_CONFIG.dst[settings.dstFontSize] || FONT_CONFIG.dst.medium;
  const root = document.documentElement;
  root.style.setProperty('--font-src-bubble', srcCfg.bubble);
  root.style.setProperty('--font-src-history', srcCfg.history);
  root.style.setProperty('--font-dst-bubble', dstCfg.bubble);
  root.style.setProperty('--font-dst-history', dstCfg.history);
}

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
  if (name === 'talk' && settings.speechDetectMode === 'manual') {
    pttRecorder.warmup().catch(() => {});
  }
  if (name === 'history') renderHistory();
  if (name === 'settings') {
    renderAccount();
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
const CACHED_KEYS_STORAGE_KEY = 'transrate.cachedKeys';
function loadCachedKeysFromStorage() {
  const map = new Map();
  try {
    const raw = localStorage.getItem(CACHED_KEYS_STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    }
  } catch {}
  return map;
}
function saveCachedKeysToStorage() {
  try {
    localStorage.setItem(CACHED_KEYS_STORAGE_KEY, JSON.stringify(Object.fromEntries(cachedKeys)));
  } catch {}
}
const cachedKeys = loadCachedKeysFromStorage(); // key -> 必要ファイルがすべて端末(Cache API)に保存済みか
function setCachedKey(key, value) {
  cachedKeys.set(key, value);
  saveCachedKeysToStorage();
}
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
  if (!useOnline() && !listening && !busy) setStatus('loading', `${entry.label} を読込中…`);
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
// iOS端末では常時メモリへ載せるのは音声認識(Whisper)のみとし、翻訳モデルは翻訳時に1つずつ入れ替えてメモリ超過を防ぐ。
const usesSwap = () => isIOS;
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
    renderVoiceControls();
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
  renderVoiceControls();
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
      // 入れ替え方式(iPhone等): 起動時は音声認識(Whisper)だけをメモリに載せる。
      // 翻訳モデルは保存されていれば翻訳時(translateOffline)に1つずつ読み込むため、
      // 起動時に翻訳モデルを読み込むとメモリ上限を超えて強制終了の原因になる。
      for (const key of [...loaded]) {
        if (key.startsWith('mt:')) await unloadModel(key);
      }
      targets = targets.filter((m) => m.kind === 'whisper');
    }
    updateReadiness();
    // 音声認識(Whisper)を最優先で読み込み、その後必要なら翻訳モデルを大きい順に読み込む
    const whisperFirst = (a, b) => {
      if (a.kind === 'whisper' && b.kind !== 'whisper') return -1;
      if (b.kind === 'whisper' && a.kind !== 'whisper') return 1;
      return b.sizeMB - a.sizeMB;
    };
    targets.sort(whisperFirst);
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
  for (const m of models) {
    if (result[m.key]) setCachedKey(m.key, result[m.key].cached);
  }
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

// オフライン翻訳の実行。iPhone等では1ステップずつモデルを入れ替えてメモリ上限超過を防ぐ。
async function translateOffline(srcLang, dstLang, text) {
  const route = routeFor(srcLang, dstLang);
  if (!route) {
    throw new Error(`${LANGUAGES[srcLang].name} → ${LANGUAGES[dstLang].name} はオフラインでは翻訳できません`);
  }
  const postName = LANGUAGES[dstLang].post;
  const t0 = performance.now();
  let curText = text;
  const steps = [];

  if (usesSwap()) {
    // iPhone等メモリ制限環境: 中継翻訳(英語経由)でも同時に複数の翻訳モデルをメモリに載せず、
    // 1ステップずつ順に読み込み・翻訳・解放してメモリ上限超過による強制終了を完全に防ぐ
    for (let i = 0; i < route.length; i++) {
      const step = route[i];
      const isLast = i === route.length - 1;
      // このステップ以外の翻訳モデルはすべて解放してメモリを空ける
      for (const key of [...loaded]) {
        if (key.startsWith('mt:') && key !== step.key) await unloadModel(key);
      }
      setStatus('loading', `${step.dir} 翻訳モデルを読込中`);
      await loadModel(step);
      setStatus('translating');
      const res = await call({
        type: 'translate',
        route: [{ key: step.key }],
        text: curText,
        post: isLast ? postName : null,
      });
      curText = res.text;
      steps.push(curText);
    }
  } else {
    // PC等大容量メモリ環境: ルート上のモデルをすべて載せて高速に一括翻訳
    await ensureRoute(route);
    setStatus('translating');
    const res = await call({
      type: 'translate',
      route: route.map((r) => ({ key: r.key })),
      text,
      post: postName,
    });
    curText = res.text;
    steps.push(...(res.steps || [curText]));
  }
  return { text: curText, steps, ms: Math.round(performance.now() - t0) };
}

async function translateTextGeneral(text, srcLang, dstLang) {
  if (useOnline()) {
    const r = await online.translateText(text, srcLang, dstLang, settings.thinkingLevel);
    return (r.translation ?? '').trim();
  } else {
    const route = routeFor(srcLang, dstLang);
    if (!route) {
      throw new Error(
        `${LANGUAGES[srcLang]?.name ?? srcLang} → ${LANGUAGES[dstLang]?.name ?? dstLang} はオフラインでは翻訳できません。オンラインモードを使ってください。`,
      );
    }
    const t = await translateOffline(srcLang, dstLang, text);
    return t.text;
  }
}

// ユーザーが現在指定している言語設定（settings.langA, settings.langB）に基づき、
// 編集されたテキスト（または既存エントリ）のソース言語と翻訳先言語を決定する
function resolveRetranslateLanguages(text, currentEntry) {
  const la = settings.langA;
  const lb = settings.langB;
  const detected = detectTextLang(text, la, lb);
  let srcLang, dstLang;
  if (detected === la) {
    srcLang = la;
    dstLang = lb;
  } else if (detected === lb) {
    srcLang = lb;
    dstLang = la;
  } else if (currentEntry?.srcLang === la) {
    srcLang = la;
    dstLang = lb;
  } else if (currentEntry?.srcLang === lb) {
    srcLang = lb;
    dstLang = la;
  } else {
    srcLang = la;
    dstLang = lb;
  }
  return { srcLang, dstLang };
}

// ------------------------------------------------------------
// 会話処理
// ------------------------------------------------------------
let vad = null;
let listening = false;
let voiceMode = 'auto'; // 'auto' | 'langA' | 'langB'
let busy = false;
let queueRunToken = 0;
let currentJobAbortCtrl = null;
let currentPendingEl = null;
const queue = [];
let wakeLock = null;

function cancelCurrentJob(reason = '中断') {
  log.info(`ジョブをキャンセル: ${reason}`);
  queueRunToken++;
  tts.stop();
  if (currentJobAbortCtrl) {
    try {
      currentJobAbortCtrl.abort();
    } catch (_) {}
    currentJobAbortCtrl = null;
  }
  if (currentPendingEl) {
    try {
      currentPendingEl.remove();
    } catch (_) {}
    currentPendingEl = null;
    renderTalk().catch(() => {});
  }
  queue.length = 0;
  busy = false;
  setStatus('idle');
}

const pttRecorder = new PttRecorder();
let isPttRecording = false;
let pttActiveMode = null;
let pttPointerId = null;
let pttPressStartTime = 0;

function renderVoiceControls() {
  const la = LANGUAGES[settings.langA];
  const lb = LANGUAGES[settings.langB];
  if (el.langAFlag && la) el.langAFlag.textContent = la.flag;
  if (el.langAName && la) el.langAName.textContent = la.name;
  if (el.langBFlag && lb) el.langBFlag.textContent = lb.flag;
  if (el.langBName && lb) el.langBName.textContent = lb.name;

  const disabled = settings.langA === settings.langB || el.micButton.disabled;
  if (el.langABtn) el.langABtn.disabled = disabled;
  if (el.langBBtn) el.langBBtn.disabled = disabled;

  const isManual = settings.speechDetectMode === 'manual';

  if (isManual) {
    if (isPttRecording) {
      el.micButton.dataset.recording = pttActiveMode === 'auto' ? 'true' : 'false';
      if (el.langABtn) el.langABtn.dataset.recording = pttActiveMode === 'langA' ? 'true' : 'false';
      if (el.langBBtn) el.langBBtn.dataset.recording = pttActiveMode === 'langB' ? 'true' : 'false';
      el.micButton.dataset.active = 'false';
      if (el.langABtn) el.langABtn.dataset.active = 'false';
      if (el.langBBtn) el.langBBtn.dataset.active = 'false';
      el.micLabel.textContent = '録音中…（離すと翻訳）';
    } else {
      el.micButton.dataset.recording = 'false';
      if (el.langABtn) el.langABtn.dataset.recording = 'false';
      if (el.langBBtn) el.langBBtn.dataset.recording = 'false';
      el.micButton.dataset.active = 'false';
      if (el.langABtn) el.langABtn.dataset.active = 'false';
      if (el.langBBtn) el.langBBtn.dataset.active = 'false';
      el.micLabel.textContent = '長押しで自動認識';
    }
  } else {
    el.micButton.dataset.recording = 'false';
    if (el.langABtn) el.langABtn.dataset.recording = 'false';
    if (el.langBBtn) el.langBBtn.dataset.recording = 'false';

    const aActive = listening && voiceMode === 'langA';
    if (el.langABtn) {
      el.langABtn.dataset.active = aActive ? 'true' : 'false';
      el.langABtn.setAttribute('aria-pressed', aActive ? 'true' : 'false');
      el.langABtn.setAttribute('aria-label', `${la?.name ?? '言語A'}で音声認識${aActive ? '（動作中）' : ''}`);
    }
    const bActive = listening && voiceMode === 'langB';
    if (el.langBBtn) {
      el.langBBtn.dataset.active = bActive ? 'true' : 'false';
      el.langBBtn.setAttribute('aria-pressed', bActive ? 'true' : 'false');
      el.langBBtn.setAttribute('aria-label', `${lb?.name ?? '言語B'}で音声認識${bActive ? '（動作中）' : ''}`);
    }

    const micActive = listening && voiceMode === 'auto';
    el.micButton.dataset.active = micActive ? 'true' : 'false';
    el.micButton.setAttribute('aria-pressed', micActive ? 'true' : 'false');
    el.micLabel.textContent = micActive ? '自動認識 動作中' : '自動認識 停止中';
  }
}

const otherLang = (l) => (l === settings.langA ? settings.langB : settings.langA);

// Whisper が無音や動画音声学習の雑音に対して出しがちな定型字幕ノイズ。
const HALLUCINATIONS = [
  /^ご視聴ありがとうございました[。.]?$/,
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
  const token = ++queueRunToken;
  try {
    while (queue.length) {
      const job = queue.shift();
      await handleJob(job);
      if (token !== queueRunToken) break;
    }
  } finally {
    if (token === queueRunToken) {
      busy = false;
      updateReadiness();
      if (listening && !isPttRecording) setStatus('listening');
    }
  }
}

async function handleJob(job) {
  if (!isReady()) {
    toast('言語データが揃っていないため処理できません');
    return;
  }
  if (job.kind === 'audio' && isSilentAudio(job.audio)) {
    log.info('無音・音声入力なしのため処理破棄');
    toast('声が検出されませんでした');
    setStatus('idle');
    return;
  }
  const abortCtrl = new AbortController();
  currentJobAbortCtrl = abortCtrl;
  const signal = abortCtrl.signal;

  const onlineMode = useOnline();
  const pendingEl = showPendingBubble(job.kind === 'audio' ? (onlineMode ? '送信中…' : '聞き取り中…') : job.text);
  currentPendingEl = pendingEl;

  try {
    let srcLang, srcText, dstLang, dstText;
    let detectMs = null, transcribeMs = null, translateMs = null;
    if (onlineMode) {
      // ---- オンライン: 音声はサーバーで 言語判定+文字起こし+翻訳 を一度に行う ----
      setStatus('translating', 'オンライン翻訳中');
      if (job.kind === 'audio') {
        const fixedSrc = job.voiceMode === 'langA' ? settings.langA : job.voiceMode === 'langB' ? settings.langB : null;
        const r = await online.recognizeAndTranslate(job.audio, [settings.langA, settings.langB], fixedSrc, settings.thinkingLevel, signal);
        if (signal.aborted) return;
        srcLang = r.lang;
        srcText = (r.transcript ?? '').trim();
        dstText = (r.translation ?? '').trim();
        translateMs = r.ms;
        log.info('オンライン音声翻訳', { lang: srcLang, text: srcText, ms: r.ms, sec: job.seconds, voiceMode: job.voiceMode, fixedSrc, thinking: settings.thinkingLevel });
        if (isNoise(srcText) || !dstText) {
          pendingEl.remove();
          if (currentPendingEl === pendingEl) currentPendingEl = null;
          log.info('無音/ノイズとして破棄', { text: srcText });
          return;
        }
        dstLang = otherLang(srcLang);
      } else {
        srcText = job.text;
        const r = await online.translateText(srcText, [settings.langA, settings.langB], null, settings.thinkingLevel, signal);
        if (signal.aborted) return;
        srcLang = r.lang || detectTextLang(srcText, settings.langA, settings.langB);
        dstLang = otherLang(srcLang);
        dstText = (r.translation ?? '').trim();
        translateMs = r.ms;
        log.info('オンライン翻訳', { from: srcLang, to: dstLang, ms: r.ms, text: dstText, thinking: settings.thinkingLevel });
      }
    } else {
      // ---- オフライン: Whisper → Marian(必要なら英語経由) ----
      if (job.kind === 'audio') {
        setStatus('transcribing');
        let langs;
        if (job.voiceMode === 'langA') {
          langs = [{ code: settings.langA, whisper: LANGUAGES[settings.langA].whisper, post: LANGUAGES[settings.langA].post }];
        } else if (job.voiceMode === 'langB') {
          langs = [{ code: settings.langB, whisper: LANGUAGES[settings.langB].whisper, post: LANGUAGES[settings.langB].post }];
        } else {
          langs = [settings.langA, settings.langB].map((c) => ({ code: c, whisper: LANGUAGES[c].whisper, post: LANGUAGES[c].post }));
        }
        const r = await call({ type: 'transcribe', audio: job.audio, langs }, [job.audio.buffer]);
        if (signal.aborted) return;
        srcLang = r.lang;
        srcText = r.text;
        detectMs = r.detectMs;
        transcribeMs = r.transcribeMs;
        log.info('文字起こし', { lang: srcLang, text: srcText, detectMs, transcribeMs, sec: job.seconds, voiceMode: job.voiceMode });
        if (isNoise(srcText)) {
          pendingEl.remove();
          if (currentPendingEl === pendingEl) currentPendingEl = null;
          log.info('無音/ノイズとして破棄', { text: srcText });
          return;
        }
        pendingEl.querySelector('.bubble__src').textContent = srcText;
        pendingEl.querySelector('.bubble__dst').textContent = '翻訳中…';
      } else {
        srcText = job.text;
        srcLang = job.lang || detectTextLang(srcText, settings.langA, settings.langB);
      }
      if (signal.aborted) return;
      dstLang = otherLang(srcLang);
      const route = routeFor(srcLang, dstLang);
      if (!route) {
        pendingEl.remove();
        if (currentPendingEl === pendingEl) currentPendingEl = null;
        const msg = `${LANGUAGES[srcLang].name} → ${LANGUAGES[dstLang].name} はオフラインでは翻訳できません。オンラインモードを使ってください。`;
        log.warn('オフライン未対応方向', { from: srcLang, to: dstLang, text: srcText });
        toast(msg, 5000);
        return;
      }
      const t = await translateOffline(srcLang, dstLang, srcText);
      if (signal.aborted) return;
      dstText = t.text;
      translateMs = t.ms;
      log.info('翻訳', { from: srcLang, to: dstLang, ms: t.ms, steps: t.steps });
    }
    if (signal.aborted) return;
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
    if (signal.aborted) return;
    pendingEl.remove();
    if (currentPendingEl === pendingEl) currentPendingEl = null;
    appendBubble(entry);
    if (settings.autoSpeak) speakEntry(entry).catch(() => {});
  } catch (e) {
    if (signal.aborted || e.name === 'AbortError') {
      log.info('ジョブは中断されました');
      return;
    }
    pendingEl.remove();
    if (currentPendingEl === pendingEl) currentPendingEl = null;
    log.error('会話処理に失敗', e);
    toast(`処理に失敗しました: ${e.message}`, 5000);
  } finally {
    if (currentJobAbortCtrl === abortCtrl) {
      currentJobAbortCtrl = null;
    }
    if (currentPendingEl === pendingEl) {
      currentPendingEl = null;
    }
  }
}

async function speakText(text, langCode) {
  if (!tts.ttsSupported) {
    toast('この端末は読み上げに対応していません');
    return;
  }
  const wasListening = listening;
  if (wasListening) await vad?.pause(); // 自分の読み上げをマイクが拾わないように止める
  setStatus('speaking');
  try {
    const langInfo = LANGUAGES[langCode] ?? { tts: langCode };
    await tts.speak(text, langInfo.tts, { voiceURI: settings.voices[langCode], rate: settings.rate });
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

async function speakEntry(entry) {
  return speakText(entry.dstText, entry.dstLang);
}

let wasListeningBeforeHidden = false;

// ---- 聞き取り ----
async function startListening() {
  if (settings.speechDetectMode !== 'auto') return false;
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
        redemptionMs: settings.vadSilenceMs,
        onSpeechStart: () => {
          if (listening && !busy) setStatus('hearing');
        },
        onSpeechEnd: (audio) => {
          if (isSilentAudio(audio)) {
            log.info('VAD 発話区間が無音のため破棄');
            if (listening && !busy) setStatus('listening');
            return;
          }
          const seconds = +(audio.length / 16000).toFixed(1);
          log.info('発話区間を検出', { seconds, voiceMode });
          // Whisper の1ウィンドウ(30秒)を超える分は切り捨てる
          const clipped = audio.length > 16000 * 30 ? audio.slice(0, 16000 * 30) : audio;
          enqueue({ kind: 'audio', audio: clipped, seconds, voiceMode });
        },
        onMisfire: () => {
          if (listening && !busy) setStatus('listening');
        },
      });
    } else {
      // 既存インスタンスがある場合、設定された沈黙時間を同期し、AudioContext が suspended なら再開
      vad.setOptions?.({ redemptionMs: settings.vadSilenceMs });
      await vad.ensureActive?.();
    }
    await vad.start();
    listening = true;
    el.micBanner.hidden = true;
    renderVoiceControls();
    setStatus('listening');
    log.info('聞き取り開始', { voiceMode });
    acquireWakeLock();
    return true;
  } catch (e) {
    log.error('マイク開始に失敗', e);
    // 失敗したvadは破棄して次回クリーンに再試行できるようにする
    if (vad) {
      vad.stopAllTracks?.();
      await vad.destroy?.().catch(() => {});
      vad = null;
    }
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

async function stopListening({ keepIntent = false } = {}) {
  if (!listening) return;
  listening = false;
  if (!keepIntent) wasListeningBeforeHidden = false;
  try {
    if (vad) {
      vad.stopAllTracks?.();
      await vad.pause().catch(() => {});
      // 手動で明示的に停止した場合は、ゾンビ化マイクを再利用せず次回確実にクリーン初期化できるよう破棄する
      if (!keepIntent) {
        await vad.destroy?.().catch(() => {});
        vad = null;
      }
    }
  } catch (_) {}
  renderVoiceControls();
  if (!busy) setStatus('idle');
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

// バックグラウンド移行(別アプリ表示、ホーム画面へ戻る、タブ切り替え等)の検知と省電力・発熱防止
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    if (listening) {
      wasListeningBeforeHidden = true;
      log.info('別アプリ表示/バックグラウンド移行: マイク待機');
      await stopListening({ keepIntent: true });
    }
  } else if (document.visibilityState === 'visible') {
    acquireWakeLock();
    if (settings.speechDetectMode === 'manual') {
      pttRecorder.warmup().catch(() => {});
    }
    if (wasListeningBeforeHidden) {
      wasListeningBeforeHidden = false;
      log.info('アプリ復帰(フォアグラウンド): 聞き取り自動再開');
      setTimeout(() => {
        if (!listening && settings.autoListen) startListening();
      }, 300);
    }
  }
});

window.addEventListener('pageshow', (e) => {
  if (settings.speechDetectMode === 'manual') {
    pttRecorder.warmup().catch(() => {});
  }
  if (e.persisted && settings.autoListen && !listening) {
    log.info('ページ復元(pageshow): 自動聞き取りを再開');
    setTimeout(() => startListening(), 300);
  }
});

// ------------------------------------------------------------
// 会話ビュー描画
// ------------------------------------------------------------
const timeFmt = (ts) => new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

function bindLongPress(element, onLongPress, options = {}) {
  const ms = typeof options === 'number' ? options : (options.ms ?? 450);
  const pressingClass = typeof options === 'object' && options.pressingClass !== undefined ? options.pressingClass : 'bubble__dst--pressing';
  const ignoreSelector = typeof options === 'object' ? options.ignoreSelector : null;
  const onStart = typeof options === 'object' ? options.onStart : null;
  const onEnd = typeof options === 'object' ? options.onEnd : null;
  const onTap = typeof options === 'object' ? options.onTap : null;

  let timer = null;
  let startX = 0;
  let startY = 0;
  let didTrigger = false;
  let pointerDownActive = false;
  let lastTapTs = 0;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pressingClass) element.classList.remove(pressingClass);
    if (onEnd) onEnd();
  };

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (ignoreSelector && e.target.closest(ignoreSelector)) return;
    didTrigger = false;
    pointerDownActive = true;
    startX = e.clientX;
    startY = e.clientY;
    if (pressingClass) element.classList.add(pressingClass);
    if (onStart) onStart(e);

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      didTrigger = true;
      pointerDownActive = false;
      if (pressingClass) element.classList.remove(pressingClass);
      if (onEnd) onEnd();
      try {
        window.getSelection()?.removeAllRanges();
      } catch {}
      if (typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate(40);
        } catch {}
      }
      onLongPress(e);
    }, ms);
  };

  const onPointerMove = (e) => {
    if (!pointerDownActive) return;
    const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (dist > 10) {
      pointerDownActive = false;
      cancel();
    }
  };

  const onPointerUp = (e) => {
    const wasActive = pointerDownActive;
    pointerDownActive = false;
    cancel();
    if (wasActive && !didTrigger && onTap) {
      if (ignoreSelector && e.target.closest(ignoreSelector)) return;
      lastTapTs = Date.now();
      onTap(e);
    }
  };

  const onPointerCancel = () => {
    pointerDownActive = false;
    cancel();
  };

  const onContextMenu = (e) => {
    if (didTrigger || e.pointerType === 'touch') {
      if (didTrigger || (ignoreSelector && !e.target.closest(ignoreSelector))) {
        e.preventDefault();
        didTrigger = false;
      }
    }
  };

  const onClick = (e) => {
    if (didTrigger) {
      e.preventDefault();
      e.stopPropagation();
      didTrigger = false;
      return;
    }
    // 直前の pointerup で既に onTap が発火した場合は重複実行を抑止
    if (lastTapTs && Date.now() - lastTapTs < 350) {
      return;
    }
    if (onTap) {
      if (ignoreSelector && e.target.closest(ignoreSelector)) return;
      onTap(e);
    }
  };

  const onKeyDown = (e) => {
    if (ignoreSelector && e.target.closest(ignoreSelector)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (onTap) {
        onTap(e);
      } else {
        onLongPress(e);
      }
    }
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerCancel);
  element.addEventListener('contextmenu', onContextMenu);
  element.addEventListener('click', onClick);
  element.addEventListener('keydown', onKeyDown);
}

const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
const CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

async function copyTextWithFeedback(btn, text, label = 'テキスト') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    navigator.vibrate?.(30);
    btn.innerHTML = CHECK_ICON_SVG;
    btn.classList.add('is-copied');
    btn.setAttribute('title', 'コピーしました');
    toast(`${label}をコピーしました`);
    setTimeout(() => {
      btn.innerHTML = COPY_ICON_SVG;
      btn.classList.remove('is-copied');
      btn.setAttribute('title', `${label}をコピー`);
    }, 1500);
  } catch (e) {
    log.error('クリップボードコピー失敗', e);
    toast('コピーに失敗しました');
  }
}

function renderBubbleExtras(container, entry, onUpdate) {
  if (!container) return;
  container.innerHTML = '';
  const extras = entry.extraTranslations ?? [];
  if (extras.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (let i = 0; i < extras.length; i++) {
    const extra = extras[i];
    const langInfo = LANGUAGES[extra.lang] ?? { flag: '🌐', name: extra.lang };
    const item = document.createElement('div');
    item.className = 'bubble__extra';
    item.innerHTML = `
      <div class="bubble__extra-head">
        <span class="bubble__extra-lang">${langInfo.flag} ${langInfo.name}</span>
        <div class="bubble__extra-actions">
          <button class="btn btn--ghost btn--small bubble__extra-btn" type="button" data-action="copy-extra" aria-label="${langInfo.name}の翻訳をコピー" title="コピー">
            ${COPY_ICON_SVG}
            <span>コピー</span>
          </button>
          <button class="btn btn--ghost btn--small bubble__extra-btn bubble__extra-speak" type="button" data-action="speak-extra" aria-label="${langInfo.name}を読み上げ" title="読み上げ">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>
            <span>読み上げ</span>
          </button>
          <button class="btn btn--ghost btn--small btn--danger bubble__extra-btn" type="button" data-action="delete-extra" aria-label="${langInfo.name}の翻訳を削除" title="削除">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
      </div>
      <p class="bubble__extra-text"></p>
    `;
    const extraTextEl = item.querySelector('.bubble__extra-text');
    extraTextEl.textContent = extra.text;
    extraTextEl.setAttribute('tabindex', '0');
    extraTextEl.setAttribute('role', 'button');
    extraTextEl.setAttribute('title', 'タップでコピー');
    extraTextEl.setAttribute('aria-label', `${langInfo.name}の翻訳をタップでコピー`);
    const copyExtraBtn = item.querySelector('[data-action="copy-extra"]');
    copyExtraBtn.addEventListener('click', () => copyTextWithFeedback(copyExtraBtn, extra.text, `${langInfo.name}の翻訳`));
    extraTextEl.addEventListener('click', () => copyTextWithFeedback(copyExtraBtn, extra.text, `${langInfo.name}の翻訳`));
    item.querySelector('[data-action="speak-extra"]').addEventListener('click', () => speakText(extra.text, extra.lang));
    item.querySelector('[data-action="delete-extra"]').addEventListener('click', async () => {
      if (!confirm(`${langInfo.name}の翻訳を削除します。よろしいですか？`)) return;
      extras.splice(i, 1);
      entry.extraTranslations = extras;
      await history.update(entry);
      renderBubbleExtras(container, entry, onUpdate);
      onUpdate?.();
      toast(`${langInfo.name}の翻訳を削除しました`);
    });
    container.appendChild(item);
  }
}

function renderHistoryExtras(container, entry, onUpdate) {
  if (!container) return;
  container.innerHTML = '';
  const extras = entry.extraTranslations ?? [];
  if (extras.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (let i = 0; i < extras.length; i++) {
    const extra = extras[i];
    const langInfo = LANGUAGES[extra.lang] ?? { flag: '🌐', name: extra.lang };
    const item = document.createElement('div');
    item.className = 'history__extra';
    item.innerHTML = `
      <div class="history__extra-head">
        <span class="history__extra-lang">${langInfo.flag} ${langInfo.name}</span>
        <div class="history__extra-actions">
          <button class="btn btn--ghost btn--small history__extra-btn" type="button" data-action="copy-extra" aria-label="${langInfo.name}の翻訳をコピー" title="コピー">
            ${COPY_ICON_SVG}
            <span>コピー</span>
          </button>
          <button class="btn btn--ghost btn--small history__extra-btn" type="button" data-action="speak-extra" aria-label="${langInfo.name}を読み上げ" title="読み上げ">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>
            <span>読み上げ</span>
          </button>
          <button class="btn btn--ghost btn--small btn--danger history__extra-btn" type="button" data-action="delete-extra" aria-label="${langInfo.name}の翻訳を削除" title="削除">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
      </div>
      <p class="history__extra-text"></p>
    `;
    const extraTextEl = item.querySelector('.history__extra-text');
    extraTextEl.textContent = extra.text;
    extraTextEl.setAttribute('tabindex', '0');
    extraTextEl.setAttribute('role', 'button');
    extraTextEl.setAttribute('title', 'タップでコピー');
    extraTextEl.setAttribute('aria-label', `${langInfo.name}の翻訳をタップでコピー`);
    const copyExtraBtn = item.querySelector('[data-action="copy-extra"]');
    copyExtraBtn.addEventListener('click', () => copyTextWithFeedback(copyExtraBtn, extra.text, `${langInfo.name}の翻訳`));
    extraTextEl.addEventListener('click', () => copyTextWithFeedback(copyExtraBtn, extra.text, `${langInfo.name}の翻訳`));
    item.querySelector('[data-action="speak-extra"]').addEventListener('click', () => speakText(extra.text, extra.lang));
    item.querySelector('[data-action="delete-extra"]').addEventListener('click', async () => {
      if (!confirm(`${langInfo.name}の翻訳を削除します。よろしいですか？`)) return;
      extras.splice(i, 1);
      entry.extraTranslations = extras;
      await history.update(entry);
      renderHistoryExtras(container, entry, onUpdate);
      onUpdate?.();
      toast(`${langInfo.name}の翻訳を削除しました`);
    });
    container.appendChild(item);
  }
}

function bubbleEl(entry, index = 0, total = 1) {
  const side = entry.srcLang === settings.langA ? 'a' : 'b';
  const src = LANGUAGES[entry.srcLang];
  const dst = LANGUAGES[entry.dstLang];
  const isLatest = index === 0;
  const isOldest = index === total - 1 && total > 1;
  const posBadgeText = isLatest ? '最新' : (isOldest ? '最古' : `${index}件前`);
  const posBadgeClass = isLatest ? 'bubble__badge bubble__badge--latest' : (isOldest ? 'bubble__badge bubble__badge--oldest' : 'bubble__badge');

  const art = document.createElement('article');
  art.className = `bubble bubble--${side}`;
  art.dataset.id = entry.id;
  art.innerHTML = `
    <div class="bubble__meta"><span class="${posBadgeClass}">${posBadgeText}</span><span class="bubble__langs"><span>${src.flag} ${src.name}</span><span class="bubble__arrow">→</span><span>${dst.flag} ${dst.name}</span></span><span class="bubble__mode">${entry.mode === 'online' ? 'オンライン' : 'オフライン'}</span><time>${timeFmt(entry.ts)}</time></div>
    <div class="bubble__src-row">
      <p class="bubble__src" tabindex="0" role="button" aria-label="タップでコピー、長押しで編集" title="タップでコピー、長押しで編集"></p>
      <button class="btn btn--icon btn--ghost bubble__copy-btn" type="button" data-action="copy-src" aria-label="原文をコピー" title="原文をコピー">
        ${COPY_ICON_SVG}
      </button>
    </div>
    <div class="bubble__editor" hidden>
      <textarea class="bubble__edit-input" rows="2" aria-label="原文を編集"></textarea>
      <div class="bubble__edit-actions">
        <button class="btn btn--small" type="button" data-action="retranslate">再翻訳</button>
        <button class="btn btn--ghost btn--small" type="button" data-action="cancel">キャンセル</button>
      </div>
    </div>
    <div class="bubble__dst-row">
      <p class="bubble__dst" tabindex="0" role="button" aria-label="タップでコピー、長押しで編集" title="タップでコピー、長押しで編集"></p>
      <button class="btn btn--icon btn--ghost bubble__copy-btn" type="button" data-action="copy-dst" aria-label="翻訳文をコピー" title="翻訳文をコピー">
        ${COPY_ICON_SVG}
      </button>
    </div>
    <div class="bubble__extras"></div>
    <div class="bubble__translate-form" hidden>
      <div class="bubble__translate-form-row">
        <label class="field bubble__translate-field">
          <span class="field__label sr-only">翻訳先言語</span>
          <select class="select select--small bubble__translate-select" aria-label="翻訳先言語"></select>
        </label>
        <button class="btn btn--small" type="button" data-action="confirm-translate-other">翻訳</button>
        <button class="btn btn--ghost btn--small" type="button" data-action="cancel-translate-other">閉じる</button>
      </div>
      <div class="bubble__translate-status" hidden></div>
    </div>
    <div class="bubble__actions">
      <button class="btn btn--ghost btn--small" type="button" data-action="translate-other">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="m12.87 15.07-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7 1.62-4.33L19.12 17h-3.24z"/></svg>
        別の言語での翻訳
      </button>
      <button class="btn btn--ghost btn--small" type="button" data-action="edit">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        編集
      </button>
      <button class="btn btn--ghost btn--small" type="button" data-action="speak">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>
        読み上げ
      </button>
    </div>`;

  const srcRow = art.querySelector('.bubble__src-row');
  const srcEl = art.querySelector('.bubble__src');
  const dstEl = art.querySelector('.bubble__dst');
  const copySrcBtn = art.querySelector('[data-action="copy-src"]');
  const copyDstBtn = art.querySelector('[data-action="copy-dst"]');
  const extrasContainer = art.querySelector('.bubble__extras');
  const translateForm = art.querySelector('.bubble__translate-form');
  const translateSelect = art.querySelector('.bubble__translate-select');
  const confirmTranslateBtn = art.querySelector('[data-action="confirm-translate-other"]');
  const cancelTranslateBtn = art.querySelector('[data-action="cancel-translate-other"]');
  const translateStatus = art.querySelector('.bubble__translate-status');
  const translateOtherBtn = art.querySelector('[data-action="translate-other"]');
  const editor = art.querySelector('.bubble__editor');
  const editInput = art.querySelector('.bubble__edit-input');
  const retranslateBtn = art.querySelector('[data-action="retranslate"]');
  const cancelBtn = art.querySelector('[data-action="cancel"]');
  const editBtn = art.querySelector('[data-action="edit"]');
  const speakBtn = art.querySelector('[data-action="speak"]');

  srcEl.textContent = entry.srcText;
  dstEl.textContent = entry.dstText;

  copySrcBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyTextWithFeedback(copySrcBtn, entry.srcText, '原文');
  });
  copyDstBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyTextWithFeedback(copyDstBtn, entry.dstText, '翻訳文');
  });

  const syncHistoryExtras = () => {
    const historyCard = el.historyList?.querySelector(`.history__item[data-id="${entry.id}"]`);
    if (historyCard) {
      renderHistoryExtras(historyCard.querySelector('.history__extras'), entry, syncBubbleExtras);
    }
  };

  const syncBubbleExtras = () => {
    renderBubbleExtras(extrasContainer, entry, syncHistoryExtras);
  };

  renderBubbleExtras(extrasContainer, entry, syncHistoryExtras);

  const updateSelectOptions = () => {
    translateSelect.innerHTML = '';
    const usedLangs = new Set([entry.srcLang, entry.dstLang, ...(entry.extraTranslations ?? []).map((e) => e.lang)]);
    const available = Object.entries(LANGUAGES).filter(([code]) => !usedLangs.has(code));
    if (available.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'すべての言語に翻訳済みです';
      translateSelect.appendChild(opt);
      confirmTranslateBtn.disabled = true;
      return;
    }
    confirmTranslateBtn.disabled = false;
    for (const [code, info] of available) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `${info.flag} ${info.name}`;
      translateSelect.appendChild(opt);
    }
  };

  translateOtherBtn.addEventListener('click', () => {
    if (!translateForm.hidden) {
      translateForm.hidden = true;
      return;
    }
    updateSelectOptions();
    translateForm.hidden = false;
    translateStatus.hidden = true;
    translateStatus.textContent = '';
    translateSelect.focus();
  });

  cancelTranslateBtn.addEventListener('click', () => {
    translateForm.hidden = true;
  });

  confirmTranslateBtn.addEventListener('click', async () => {
    const targetLang = translateSelect.value;
    if (!targetLang) return;
    const targetInfo = LANGUAGES[targetLang] ?? { name: targetLang, flag: '' };
    confirmTranslateBtn.disabled = true;
    cancelTranslateBtn.disabled = true;
    translateSelect.disabled = true;
    translateStatus.hidden = false;
    translateStatus.textContent = `${targetInfo.flag} ${targetInfo.name} に翻訳中…`;

    try {
      const translatedText = await translateTextGeneral(entry.srcText, entry.srcLang, targetLang);
      if (!entry.extraTranslations) entry.extraTranslations = [];
      entry.extraTranslations.push({
        lang: targetLang,
        text: translatedText,
        ts: Date.now(),
      });
      await history.update(entry);
      renderBubbleExtras(extrasContainer, entry, syncHistoryExtras);
      syncHistoryExtras();
      translateForm.hidden = true;
      toast(`${targetInfo.name}の翻訳を追加しました`);
      log.info('会話カードから別言語への翻訳を追加・記憶', { id: entry.id, targetLang, len: translatedText.length });

      if (settings.autoSpeak) {
        speakText(translatedText, targetLang).catch(() => {});
      }
    } catch (e) {
      log.error('別言語への翻訳に失敗', e);
      translateStatus.textContent = `翻訳エラー: ${e.message}`;
      toast(`翻訳に失敗しました: ${e.message}`);
    } finally {
      confirmTranslateBtn.disabled = false;
      cancelTranslateBtn.disabled = false;
      translateSelect.disabled = false;
    }
  });

  const openEditor = (from = 'tap') => {
    srcRow.hidden = true;
    editor.hidden = false;
    editInput.value = entry.srcText;
    editInput.focus();
    const len = editInput.value.length;
    editInput.setSelectionRange(len, len);
    setTimeout(() => {
      editInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
    if (from && from.startsWith('longpress')) {
      log.info('翻訳の長押しで原文編集を開く', { id: entry.id, from });
    }
  };

  const closeEditor = () => {
    editor.hidden = true;
    srcRow.hidden = false;
  };

  editBtn.addEventListener('click', () => openEditor('button'));
  cancelBtn.addEventListener('click', closeEditor);

  bindLongPress(art, () => openEditor('longpress'), {
    ignoreSelector: 'button, textarea, input, select, a',
    onTap: (e) => {
      if (e?.target?.closest('.bubble__src')) {
        copyTextWithFeedback(copySrcBtn, entry.srcText, '原文');
      } else {
        copyTextWithFeedback(copyDstBtn, entry.dstText, '翻訳文');
      }
    },
    onStart: (e) => {
      if (e.target.closest('.bubble__dst')) {
        dstEl.classList.add('bubble__dst--pressing');
      } else if (e.target.closest('.bubble__src')) {
        srcEl.classList.add('bubble__src--pressing');
      } else {
        art.classList.add('bubble--pressing');
      }
    },
    onEnd: () => {
      dstEl.classList.remove('bubble__dst--pressing');
      srcEl.classList.remove('bubble__src--pressing');
      art.classList.remove('bubble--pressing');
    },
  });

  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      retranslateBtn.click();
    } else if (e.key === 'Escape') {
      closeEditor();
    }
  });

  retranslateBtn.addEventListener('click', async () => {
    const newText = editInput.value.trim();
    if (!newText) {
      toast('テキストを入力してください');
      return;
    }
    retranslateBtn.disabled = true;
    cancelBtn.disabled = true;
    const prevDst = entry.dstText;
    dstEl.textContent = '再翻訳中…';
    try {
      const { srcLang: newSrcLang, dstLang: newDstLang } = resolveRetranslateLanguages(newText, entry);
      const dstText = await translateTextGeneral(newText, newSrcLang, newDstLang);
      entry.srcLang = newSrcLang;
      entry.dstLang = newDstLang;
      entry.srcText = newText;
      entry.dstText = dstText;
      if (entry.extraTranslations && entry.extraTranslations.length > 0) {
        for (const extra of entry.extraTranslations) {
          try {
            extra.text = await translateTextGeneral(newText, entry.srcLang, extra.lang);
          } catch (err) {
            log.warn('追加言語の再翻訳失敗', err);
          }
        }
      }
      entry.ts = Date.now();
      await history.update(entry);
      srcEl.textContent = entry.srcText;
      dstEl.textContent = entry.dstText;
      renderBubbleExtras(extrasContainer, entry, syncHistoryExtras);

      // 言語メタ情報の表示更新
      const s = LANGUAGES[entry.srcLang] ?? { flag: '', name: entry.srcLang };
      const d = LANGUAGES[entry.dstLang] ?? { flag: '', name: entry.dstLang };
      const langsEl = art.querySelector('.bubble__langs');
      if (langsEl) {
        langsEl.innerHTML = `<span>${s.flag} ${s.name}</span><span class="bubble__arrow">→</span><span>${d.flag} ${d.name}</span>`;
      }
      const side = entry.srcLang === settings.langA ? 'a' : 'b';
      art.classList.remove('bubble--a', 'bubble--b');
      art.classList.add(`bubble--${side}`);

      const bTime = art.querySelector('.bubble__meta time');
      if (bTime) bTime.textContent = timeFmt(entry.ts);

      // 履歴一覧側にも同じIDのアイテムがあれば同期
      const historyCard = el.historyList?.querySelector(`.history__item[data-id="${entry.id}"]`);
      if (historyCard) {
        historyCard.querySelector('.history__src').textContent = entry.srcText;
        historyCard.querySelector('.history__dst').textContent = entry.dstText;
        const hLangs = historyCard.querySelector('.history__langs');
        if (hLangs) hLangs.textContent = `${s.flag} ${s.name} → ${d.flag} ${d.name}`;
        const hExtras = historyCard.querySelector('.history__extras');
        if (hExtras) renderHistoryExtras(hExtras, entry, syncBubbleExtras);
        const hTime = historyCard.querySelector('.history__meta time');
        if (hTime) hTime.textContent = dateFmt(entry.ts);
      }

      closeEditor();
      toast('再翻訳しました');
      log.info('会話文を編集・再翻訳', { id: entry.id, len: newText.length, srcLang: entry.srcLang, dstLang: entry.dstLang });
      if (settings.autoSpeak) speakEntry(entry).catch(() => {});
    } catch (e) {
      log.error('再翻訳に失敗', e);
      dstEl.textContent = prevDst;
      toast(`再翻訳に失敗しました: ${e.message}`);
    } finally {
      retranslateBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });

  speakBtn.addEventListener('click', () => speakEntry(entry));
  return art;
}

let currentTalkIndex = 0;

async function renderTalk() {
  const all = await history.all();
  const total = all.length;

  if (total === 0) {
    currentTalkIndex = 0;
    el.talkNav.hidden = true;
    el.conversationEmpty.hidden = false;
    el.talkCardContainer.innerHTML = '';
    return;
  }

  el.conversationEmpty.hidden = true;
  el.talkNav.hidden = false;

  currentTalkIndex = Math.max(0, Math.min(currentTalkIndex, total - 1));
  el.talkCounter.textContent = `${currentTalkIndex + 1} / ${total}`;
  el.talkPastBtn.disabled = currentTalkIndex === total - 1;
  el.talkFutureBtn.disabled = currentTalkIndex === 0;

  if (el.talkBadge) {
    if (currentTalkIndex === 0) {
      el.talkBadge.textContent = '最新';
      el.talkBadge.className = 'talk-nav__badge talk-nav__badge--latest';
    } else if (currentTalkIndex === total - 1 && total > 1) {
      el.talkBadge.textContent = '最古';
      el.talkBadge.className = 'talk-nav__badge talk-nav__badge--oldest';
    } else {
      el.talkBadge.textContent = `${currentTalkIndex}件前`;
      el.talkBadge.className = 'talk-nav__badge';
    }
  }

  const entry = all[currentTalkIndex];
  el.talkCardContainer.innerHTML = '';
  el.talkCardContainer.appendChild(bubbleEl(entry, currentTalkIndex, total));
}

// 互換性のため renderRecent() も renderTalk() を呼び出す
async function renderRecent() {
  await renderTalk();
}

async function appendBubble(entry) {
  // 新しい発話が追加されたら、最新の1件（インデックス 0）を表示
  currentTalkIndex = 0;
  await renderTalk();
}

function showPendingBubble(text) {
  el.conversationEmpty.hidden = true;
  el.talkNav.hidden = true;
  const art = document.createElement('article');
  art.className = 'bubble bubble--pending';
  art.innerHTML = `<p class="bubble__src"></p><p class="bubble__dst">…</p>`;
  art.querySelector('.bubble__src').textContent = text;
  el.talkCardContainer.innerHTML = '';
  el.talkCardContainer.appendChild(art);
  return art;
}

// 会話ナビゲーションボタン（上：過去、下：未来）
el.talkPastBtn.addEventListener('click', async () => {
  const all = await history.all();
  if (currentTalkIndex < all.length - 1) {
    currentTalkIndex++;
    renderTalk();
  }
});

el.talkFutureBtn.addEventListener('click', () => {
  if (currentTalkIndex > 0) {
    currentTalkIndex--;
    renderTalk();
  }
});

// スワイプによる前後の会話めくり
let talkTouchStartY = 0;
el.conversation.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    talkTouchStartY = e.touches[0].clientY;
  }
}, { passive: true });

el.conversation.addEventListener('touchend', async (e) => {
  if (e.changedTouches.length === 1) {
    const deltaY = e.changedTouches[0].clientY - talkTouchStartY;
    if (Math.abs(deltaY) > 50) {
      if (deltaY < 0) {
        // 上にスワイプ -> 古い会話へ
        const all = await history.all();
        if (currentTalkIndex < all.length - 1) {
          currentTalkIndex++;
          renderTalk();
        }
      } else {
        // 下にスワイプ -> 新しい会話へ
        if (currentTalkIndex > 0) {
          currentTalkIndex--;
          renderTalk();
        }
      }
    }
  }
}, { passive: true });

// ------------------------------------------------------------
// 履歴ビュー
// ------------------------------------------------------------
const dateFmt = (ts) =>
  new Date(ts).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function createHistoryCard(entry) {
  const src = LANGUAGES[entry.srcLang] ?? { flag: '', name: entry.srcLang };
  const dst = LANGUAGES[entry.dstLang] ?? { flag: '', name: entry.dstLang };

  const li = document.createElement('li');
  li.className = 'history__item';
  li.dataset.id = entry.id;
  li.innerHTML = `
    <div class="history__meta">
      <time>${dateFmt(entry.ts)}</time>
      <span class="history__langs">${src.flag} ${src.name} → ${dst.flag} ${dst.name}</span>
    </div>
    <div class="history__src-row">
      <p class="history__src" tabindex="0" role="button" aria-label="タップでコピー、長押しで編集" title="タップでコピー、長押しまたは編集ボタンで編集"></p>
      <button class="btn btn--icon btn--ghost history__copy-btn" type="button" data-action="copy-src" aria-label="原文をコピー" title="原文をコピー">
        ${COPY_ICON_SVG}
      </button>
    </div>
    <div class="history__editor" hidden>
      <textarea class="history__edit-input" rows="2" aria-label="原文を編集"></textarea>
      <div class="history__edit-actions">
        <button class="btn btn--small" type="button" data-action="retranslate">再翻訳</button>
        <button class="btn btn--ghost btn--small" type="button" data-action="cancel">キャンセル</button>
      </div>
    </div>
    <div class="history__dst-row">
      <p class="history__dst" tabindex="0" role="button" aria-label="タップでコピー、長押しで編集" title="タップでコピー、長押しまたは編集ボタンで編集"></p>
      <button class="btn btn--icon btn--ghost history__copy-btn" type="button" data-action="copy-dst" aria-label="翻訳文をコピー" title="翻訳文をコピー">
        ${COPY_ICON_SVG}
      </button>
    </div>
    <div class="history__extras"></div>
    <div class="history__translate-form" hidden>
      <div class="history__translate-form-row">
        <label class="field history__translate-field">
          <span class="field__label sr-only">翻訳先言語</span>
          <select class="select select--small history__translate-select" aria-label="翻訳先言語"></select>
        </label>
        <button class="btn btn--small" type="button" data-action="confirm-translate-other">翻訳</button>
        <button class="btn btn--ghost btn--small" type="button" data-action="cancel-translate-other">閉じる</button>
      </div>
      <div class="history__translate-status" hidden></div>
    </div>
    <div class="history__actions">
      <button class="btn btn--ghost btn--small" type="button" data-action="translate-other">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="m12.87 15.07-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7 1.62-4.33L19.12 17h-3.24z"/></svg>
        別の言語での翻訳
      </button>
      <button class="btn btn--ghost btn--small" type="button" data-action="edit">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        編集
      </button>
      <button class="btn btn--ghost btn--small" type="button" data-action="speak">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>
        読み上げ
      </button>
      <button class="btn btn--ghost btn--small btn--danger" type="button" data-action="delete">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        削除
      </button>
    </div>`;

  const srcRow = li.querySelector('.history__src-row');
  const srcEl = li.querySelector('.history__src');
  const dstEl = li.querySelector('.history__dst');
  const copySrcBtn = li.querySelector('[data-action="copy-src"]');
  const copyDstBtn = li.querySelector('[data-action="copy-dst"]');
  const timeEl = li.querySelector('.history__meta time');
  const langsEl = li.querySelector('.history__langs');
  const extrasContainer = li.querySelector('.history__extras');
  const translateForm = li.querySelector('.history__translate-form');
  const translateSelect = li.querySelector('.history__translate-select');
  const confirmTranslateBtn = li.querySelector('[data-action="confirm-translate-other"]');
  const cancelTranslateBtn = li.querySelector('[data-action="cancel-translate-other"]');
  const translateStatus = li.querySelector('.history__translate-status');
  const translateOtherBtn = li.querySelector('[data-action="translate-other"]');
  const editor = li.querySelector('.history__editor');
  const editInput = li.querySelector('.history__edit-input');
  const retranslateBtn = li.querySelector('[data-action="retranslate"]');
  const cancelBtn = li.querySelector('[data-action="cancel"]');
  const editBtn = li.querySelector('[data-action="edit"]');
  const speakBtn = li.querySelector('[data-action="speak"]');
  const deleteBtn = li.querySelector('[data-action="delete"]');

  srcEl.textContent = entry.srcText;
  dstEl.textContent = entry.dstText;

  copySrcBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyTextWithFeedback(copySrcBtn, entry.srcText, '原文');
  });
  copyDstBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyTextWithFeedback(copyDstBtn, entry.dstText, '翻訳文');
  });

  const syncBubbleExtras = () => {
    const bubble = el.conversation.querySelector(`.bubble[data-id="${entry.id}"]`);
    if (bubble) {
      renderBubbleExtras(bubble.querySelector('.bubble__extras'), entry, () => {
        renderHistoryExtras(extrasContainer, entry, syncBubbleExtras);
      });
    }
  };

  renderHistoryExtras(extrasContainer, entry, syncBubbleExtras);

  const updateSelectOptions = () => {
    translateSelect.innerHTML = '';
    const usedLangs = new Set([entry.srcLang, entry.dstLang, ...(entry.extraTranslations ?? []).map((e) => e.lang)]);
    const available = Object.entries(LANGUAGES).filter(([code]) => !usedLangs.has(code));
    if (available.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'すべての言語に翻訳済みです';
      translateSelect.appendChild(opt);
      confirmTranslateBtn.disabled = true;
      return;
    }
    confirmTranslateBtn.disabled = false;
    for (const [code, info] of available) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `${info.flag} ${info.name}`;
      translateSelect.appendChild(opt);
    }
  };

  translateOtherBtn.addEventListener('click', () => {
    if (!translateForm.hidden) {
      translateForm.hidden = true;
      return;
    }
    updateSelectOptions();
    translateForm.hidden = false;
    translateStatus.hidden = true;
    translateStatus.textContent = '';
    translateSelect.focus();
  });

  cancelTranslateBtn.addEventListener('click', () => {
    translateForm.hidden = true;
  });

  confirmTranslateBtn.addEventListener('click', async () => {
    const targetLang = translateSelect.value;
    if (!targetLang) return;
    const targetInfo = LANGUAGES[targetLang] ?? { name: targetLang, flag: '' };
    confirmTranslateBtn.disabled = true;
    cancelTranslateBtn.disabled = true;
    translateSelect.disabled = true;
    translateStatus.hidden = false;
    translateStatus.textContent = `${targetInfo.flag} ${targetInfo.name} に翻訳中…`;

    try {
      const translatedText = await translateTextGeneral(entry.srcText, entry.srcLang, targetLang);
      if (!entry.extraTranslations) entry.extraTranslations = [];
      entry.extraTranslations.push({
        lang: targetLang,
        text: translatedText,
        ts: Date.now(),
      });
      await history.update(entry);
      renderHistoryExtras(extrasContainer, entry, syncBubbleExtras);
      syncBubbleExtras();
      translateForm.hidden = true;
      toast(`${targetInfo.name}の翻訳を追加しました`);
      log.info('別言語への翻訳を追加', { id: entry.id, targetLang, len: translatedText.length });

      if (settings.autoSpeak) {
        speakText(translatedText, targetLang).catch(() => {});
      }
    } catch (e) {
      log.error('別言語への翻訳に失敗', e);
      translateStatus.textContent = `翻訳エラー: ${e.message}`;
      toast(`翻訳に失敗しました: ${e.message}`);
    } finally {
      confirmTranslateBtn.disabled = false;
      cancelTranslateBtn.disabled = false;
      translateSelect.disabled = false;
    }
  });

  const openEditor = (from = 'tap') => {
    srcRow.hidden = true;
    editor.hidden = false;
    editInput.value = entry.srcText;
    editInput.focus();
    const len = editInput.value.length;
    editInput.setSelectionRange(len, len);
    setTimeout(() => {
      editInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
    if (from && from.startsWith('longpress')) {
      log.info('履歴の長押しで原文編集を開く', { id: entry.id, from });
    }
  };

  const closeEditor = () => {
    editor.hidden = true;
    srcRow.hidden = false;
  };

  editBtn.addEventListener('click', () => openEditor('button'));
  cancelBtn.addEventListener('click', closeEditor);

  // 原文タップでコピー、長押しで編集
  bindLongPress(srcEl, () => openEditor('longpress-src'), {
    ignoreSelector: 'button, textarea, input, select, a',
    onTap: () => copyTextWithFeedback(copySrcBtn, entry.srcText, '原文'),
    onStart: () => srcEl.classList.add('history__src--pressing'),
    onEnd: () => srcEl.classList.remove('history__src--pressing'),
  });

  // 翻訳文タップでコピー、長押しで編集
  bindLongPress(dstEl, () => openEditor('longpress-dst'), {
    ignoreSelector: 'button, textarea, input, select, a',
    onTap: () => copyTextWithFeedback(copyDstBtn, entry.dstText, '翻訳文'),
    onStart: () => dstEl.classList.add('history__dst--pressing'),
    onEnd: () => dstEl.classList.remove('history__dst--pressing'),
  });

  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      retranslateBtn.click();
    } else if (e.key === 'Escape') {
      closeEditor();
    }
  });

  retranslateBtn.addEventListener('click', async () => {
    const newText = editInput.value.trim();
    if (!newText) {
      toast('テキストを入力してください');
      return;
    }
    retranslateBtn.disabled = true;
    cancelBtn.disabled = true;
    const prevDst = entry.dstText;
    dstEl.textContent = '再翻訳中…';
    try {
      const { srcLang: newSrcLang, dstLang: newDstLang } = resolveRetranslateLanguages(newText, entry);
      const dstText = await translateTextGeneral(newText, newSrcLang, newDstLang);
      entry.srcLang = newSrcLang;
      entry.dstLang = newDstLang;
      entry.srcText = newText;
      entry.dstText = dstText;
      if (entry.extraTranslations && entry.extraTranslations.length > 0) {
        for (const extra of entry.extraTranslations) {
          try {
            extra.text = await translateTextGeneral(newText, entry.srcLang, extra.lang);
          } catch (err) {
            log.warn('追加言語の再翻訳失敗', err);
          }
        }
      }
      entry.ts = Date.now();
      await history.update(entry);
      srcEl.textContent = entry.srcText;
      dstEl.textContent = entry.dstText;
      renderHistoryExtras(extrasContainer, entry, syncBubbleExtras);
      timeEl.textContent = dateFmt(entry.ts);

      const s = LANGUAGES[entry.srcLang] ?? { flag: '', name: entry.srcLang };
      const d = LANGUAGES[entry.dstLang] ?? { flag: '', name: entry.dstLang };
      if (langsEl) {
        langsEl.textContent = `${s.flag} ${s.name} → ${d.flag} ${d.name}`;
      }

      closeEditor();
      toast('再翻訳しました');
      log.info('履歴を編集・再翻訳', { id: entry.id, len: newText.length, srcLang: entry.srcLang, dstLang: entry.dstLang });

      // 会話画面（chat view）にも同じIDのバブルがあれば表示を同期
      const bubble = el.conversation.querySelector(`.bubble[data-id="${entry.id}"]`);
      if (bubble) {
        bubble.querySelector('.bubble__src').textContent = entry.srcText;
        bubble.querySelector('.bubble__dst').textContent = entry.dstText;
        const bExtras = bubble.querySelector('.bubble__extras');
        if (bExtras) renderBubbleExtras(bExtras, entry);
        const bTime = bubble.querySelector('.bubble__meta time');
        if (bTime) bTime.textContent = timeFmt(entry.ts);
        const bLangs = bubble.querySelector('.bubble__langs');
        if (bLangs) {
          bLangs.innerHTML = `<span>${s.flag} ${s.name}</span><span class="bubble__arrow">→</span><span>${d.flag} ${d.name}</span>`;
        }
        const side = entry.srcLang === settings.langA ? 'a' : 'b';
        bubble.classList.remove('bubble--a', 'bubble--b');
        bubble.classList.add(`bubble--${side}`);
      }

      if (settings.autoSpeak) speakEntry(entry).catch(() => {});
    } catch (e) {
      log.error('履歴の再翻訳に失敗', e);
      dstEl.textContent = prevDst;
      toast(`再翻訳に失敗しました: ${e.message}`);
    } finally {
      retranslateBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });

  speakBtn.addEventListener('click', () => speakEntry(entry));
  deleteBtn.addEventListener('click', async () => {
    if (!confirm('この履歴を削除します。よろしいですか？')) return;
    await history.remove(entry.id);
    li.remove();
    el.conversation.querySelector(`.bubble[data-id="${entry.id}"]`)?.remove();
    const rest = el.historyList.children.length;
    el.historyEmpty.hidden = rest > 0;
    el.historyClear.hidden = rest === 0;
    await renderTalk();
    toast('履歴を削除しました');
    log.info('履歴を削除', { id: entry.id });
  });

  return li;
}

async function renderHistory() {
  const all = await history.all();
  el.historyList.innerHTML = '';
  el.historyEmpty.hidden = all.length > 0;
  el.historyClear.hidden = all.length === 0;

  for (const entry of all) {
    el.historyList.appendChild(createHistoryCard(entry));
  }
}

el.historyClear.addEventListener('click', async () => {
  if (!confirm('履歴をすべて削除します。よろしいですか？')) return;
  await history.clear();
  log.info('履歴を全削除');
  currentTalkIndex = 0;
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
  el.pairButton.setAttribute('aria-label', `言語ペア: ${LANGUAGES[settings.langA].name} ⇄ ${LANGUAGES[settings.langB].name}（タップで変更・入れ替え）`);
  el.pairButton.title = `${LANGUAGES[settings.langA].name} ⇄ ${LANGUAGES[settings.langB].name}`;
  if (el.langA) el.langA.value = settings.langA;
  if (el.langB) el.langB.value = settings.langB;
  el.voiceALabel.textContent = `${LANGUAGES[settings.langA].name} の声`;
  el.voiceBLabel.textContent = `${LANGUAGES[settings.langB].name} の声`;
  const a = settings.langA, b = settings.langB;
  const A = LANGUAGES[a], B = LANGUAGES[b];
  if (a === b) {
    el.pairNote.textContent = '同じ言語同士は選べません。';
    el.pairNote.className = 'note';
  } else if (!pairSupported(a, b)) {
    el.pairNote.textContent = 'この組み合わせはオフライン未対応です（オンラインモードでは使えます）。';
    el.pairNote.className = 'note';
  } else {
    const missing = [];
    if (!directionSupported(a, b)) missing.push(`${A.name} → ${B.name}`);
    if (!directionSupported(b, a)) missing.push(`${B.name} → ${A.name}`);
    const pivot = (routeFor(a, b)?.length === 2 || routeFor(b, a)?.length === 2) ? 'オフラインでは英語を経由して翻訳します。' : '';
    el.pairNote.textContent = missing.length ? `オフラインでは ${missing.join('、')} は翻訳できません（オンラインモードでは可能）。${pivot}` : pivot;
    el.pairNote.className = missing.length ? 'note' : 'note note--info';
  }
  renderTypedLangControl();
  renderVoiceControls();
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

// ------------------------------------------------------------
// クイック言語切り替え & スワップ
// ------------------------------------------------------------
async function swapLanguages() {
  const oldA = settings.langA;
  const oldB = settings.langB;
  settings.langA = oldB;
  settings.langB = oldA;
  await onPairChanged();
  const infoA = LANGUAGES[settings.langA];
  const infoB = LANGUAGES[settings.langB];
  toast(`${infoA.flag} ${infoA.name} ⇄ ${infoB.flag} ${infoB.name} に入れ替えました`);
  log.info('言語ペアをスワップ', { a: settings.langA, b: settings.langB });
  try {
    navigator.vibrate?.(15);
  } catch (_) {}
}

let currentPickerSlot = 'A'; // 'A' | 'B'

function openLangModal(slot = 'A') {
  currentPickerSlot = slot;
  updateLangModalUI();
  el.langModal.hidden = false;
  try {
    navigator.vibrate?.(15);
  } catch (_) {}
  log.info('クイック言語切り替えを開く', { slot });
}

function closeLangModal() {
  el.langModal.hidden = true;
}

function updateLangModalUI() {
  const isA = currentPickerSlot === 'A';
  el.langModalTabA.classList.toggle('is-active', isA);
  el.langModalTabB.classList.toggle('is-active', !isA);

  const infoA = LANGUAGES[settings.langA] ?? { flag: '', name: settings.langA };
  const infoB = LANGUAGES[settings.langB] ?? { flag: '', name: settings.langB };
  el.langModalValA.textContent = `${infoA.flag} ${infoA.name}`;
  el.langModalValB.textContent = `${infoB.flag} ${infoB.name}`;

  el.langModalHint.textContent = isA
    ? `言語 A（現在: ${infoA.name}）の変更先を選択`
    : `言語 B（現在: ${infoB.name}）の変更先を選択`;

  const currentSelected = isA ? settings.langA : settings.langB;
  const otherSelected = isA ? settings.langB : settings.langA;

  el.langModalGrid.innerHTML = '';
  for (const [code, info] of Object.entries(LANGUAGES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lang-modal__item';
    if (code === currentSelected) btn.classList.add('is-selected');
    if (code === otherSelected) btn.classList.add('is-other');

    btn.innerHTML = `
      <span class="lang-modal__item-flag">${info.flag}</span>
      <span class="lang-modal__item-name">${info.name}</span>
      ${code === currentSelected ? '<span class="lang-modal__item-check" aria-hidden="true">✓</span>' : ''}
    `;

    btn.addEventListener('click', async () => {
      if (code === currentSelected) {
        closeLangModal();
        return;
      }
      if (code === otherSelected) {
        // 反対側の言語と同じものを選んだ場合は入れ替え（スワップ）とする
        await swapLanguages();
        closeLangModal();
        return;
      }
      if (isA) {
        settings.langA = code;
      } else {
        settings.langB = code;
      }
      await onPairChanged();
      toast(`${isA ? '言語 A' : '言語 B'} を ${info.flag} ${info.name} に変更しました`);
      closeLangModal();
    });

    el.langModalGrid.appendChild(btn);
  }
}

el.langModalTabA?.addEventListener('click', () => {
  currentPickerSlot = 'A';
  updateLangModalUI();
});

el.langModalTabB?.addEventListener('click', () => {
  currentPickerSlot = 'B';
  updateLangModalUI();
});

el.langModalSwap?.addEventListener('click', async () => {
  await swapLanguages();
  updateLangModalUI();
});

el.langModalClose?.addEventListener('click', closeLangModal);
el.langModalBackdrop?.addEventListener('click', closeLangModal);

el.langA.addEventListener('change', () => {
  settings.langA = el.langA.value;
  onPairChanged();
});
el.langB.addEventListener('change', () => {
  settings.langB = el.langB.value;
  onPairChanged();
});

el.pairButton.addEventListener('click', (e) => {
  // 矢印（⇄）が押された場合はその場で直接入れ替え！
  if (e.target.closest('#pairArrow') || e.target.closest('.pair__arrow')) {
    e.stopPropagation();
    swapLanguages();
    return;
  }
  // 言語B（右側）が押された場合は言語Bの変更ピッカーを開く
  if (e.target.closest('#pairB') || e.target.closest('.pair__lang:last-child')) {
    openLangModal('B');
    return;
  }
  // それ以外（言語A、またはペア全体）は言語Aの変更ピッカーを開く
  openLangModal('A');
});

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

el.thinkingLevel.addEventListener('change', async () => {
  settings.thinkingLevel = el.thinkingLevel.value;
  await saveSettings();
  log.info('思考レベル変更', { thinkingLevel: settings.thinkingLevel });
});

el.srcFontSize?.addEventListener('change', async () => {
  settings.srcFontSize = el.srcFontSize.value;
  applyFontSizes();
  await saveSettings();
  log.info('原文の文字サイズ変更', { srcFontSize: settings.srcFontSize });
});

el.dstFontSize?.addEventListener('change', async () => {
  settings.dstFontSize = el.dstFontSize.value;
  applyFontSizes();
  await saveSettings();
  log.info('翻訳結果の文字サイズ変更', { dstFontSize: settings.dstFontSize });
});

el.speechDetectMode.addEventListener('change', async () => {
  settings.speechDetectMode = el.speechDetectMode.value;
  await saveSettings();
  updateSpeechDetectModeUI();
  if (settings.speechDetectMode === 'manual') {
    pttRecorder.warmup().catch(() => {});
  }
  log.info('音声入力方式変更', { speechDetectMode: settings.speechDetectMode });
});

function updateSpeechDetectModeUI() {
  const isManual = settings.speechDetectMode === 'manual';
  if (el.speechDetectMode) el.speechDetectMode.value = settings.speechDetectMode;
  if (el.vadSilenceGroup) el.vadSilenceGroup.classList.toggle('is-mode-hidden', isManual);
  if (el.autoListenToggleGroup) el.autoListenToggleGroup.classList.toggle('is-mode-hidden', isManual);
  if (el.speechDetectNote) {
    el.speechDetectNote.textContent = isManual
      ? 'ボタンを押している間だけ録音し、離した瞬間に即座に翻訳します（息継ぎでの誤作動なし）。'
      : 'ボタンを押すと常時聞き取りを開始し、話し終わりの沈黙を検知して自動で翻訳します。';
  }
  if (el.conversationHint) {
    el.conversationHint.textContent = isManual
      ? 'ボタンを長押ししながら話してください。指を離すと即座に翻訳します。'
      : '話しかけると、どちらの言語かを判定して相手の言語に翻訳し、読み上げます。';
  }
  if (el.conversationHintSub) {
    el.conversationHintSub.textContent = isManual
      ? 'マイク（自動認識）または左右の言語ボタンを長押しできます。'
      : 'ボタンを押す必要はありません。置いたままで会話できます。';
  }
  if (isManual) {
    if (listening) {
      stopListening().catch(() => {});
    }
    if (vad) {
      vad.stopAllTracks?.();
      vad.destroy?.().catch(() => {});
      vad = null;
    }
  }
  renderVoiceControls();
}

el.vadSilence.addEventListener('change', async () => {
  settings.vadSilenceMs = Number(el.vadSilence.value);
  await saveSettings();
  vad?.setOptions?.({ redemptionMs: settings.vadSilenceMs });
  log.info('話し終わり判定時間変更', { vadSilenceMs: settings.vadSilenceMs });
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
  setCachedKey(m.key, false);
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
  if (typedControl) {
    typedControl.remove();
    typedControl = null;
  }
  const la = LANGUAGES[settings.langA];
  const lb = LANGUAGES[settings.langB];
  if (el.textInput && la && lb) {
    el.textInput.placeholder = `テキスト入力でも翻訳できます（${la.name} / ${lb.name} 自動判別）`;
  }
}

function submitTyped() {
  const text = el.textInput.value.replace(/^[\s\u3000\u200B-\u200D\uFEFF]+|[\s\u3000\u200B-\u200D\uFEFF]+$/g, '');
  if (!text) {
    el.textInput.value = '';
    return;
  }
  el.textInput.value = '';
  enqueue({ kind: 'text', text });
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
  history.sync().then(() => {
    renderRecent();
    renderHistory();
  }).catch(() => {});
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
// ユーザー認証 (ID / パスワード式)
// ------------------------------------------------------------
function renderAccount() {
  const isLoggedIn = auth.isLoggedIn();
  const user = auth.getUser();
  if (isLoggedIn) {
    el.accountUser.textContent = `${user} (ログイン中)`;
    el.logoutBtn.hidden = false;
  } else {
    el.accountUser.textContent = '未ログイン';
    el.logoutBtn.hidden = true;
  }
}

function updateAuthUI() {
  renderAccount();
  if (auth.isLoggedIn()) {
    el.authModal.hidden = true;
  } else {
    el.authModal.hidden = false;
    el.authPassword.value = '';
    el.authError.hidden = true;
  }
}

el.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = el.authUsername.value.trim();
  const password = el.authPassword.value;
  if (!username || !password) return;

  el.authSubmit.disabled = true;
  el.authError.hidden = true;
  try {
    await auth.login(username, password);
    toast('ログインしました');
    updateAuthUI();
    await renderRecent();
    if (el.app.dataset.view === 'history') await renderHistory();
  } catch (err) {
    el.authError.textContent = err.message || 'ログインに失敗しました';
    el.authError.hidden = false;
  } finally {
    el.authSubmit.disabled = false;
  }
});

el.logoutBtn.addEventListener('click', async () => {
  if (!confirm('ログアウトしますか？')) return;
  await auth.logout();
  toast('ログアウトしました');
  updateAuthUI();
  await renderRecent();
  if (el.app.dataset.view === 'history') await renderHistory();
});

auth.onChange((isLoggedIn) => {
  updateAuthUI();
  if (isLoggedIn) {
    renderRecent();
  }
});

window.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    if (!el.langModal.hidden) {
      closeLangModal();
    }
    return;
  }

  // 会話画面を開いている時、かつ入力要素にフォーカスがない場合に ArrowUp / ArrowDown で前後の項目へ切り替え
  const currentView = document.querySelector('.app')?.dataset.view;
  const activeEl = document.activeElement;
  const isInputActive = activeEl && (
    activeEl.tagName === 'INPUT' ||
    activeEl.tagName === 'TEXTAREA' ||
    activeEl.tagName === 'SELECT'
  );
  if (isInputActive) return;

  if (currentView === 'talk') {
    if (e.key === 'ArrowUp') {
      // 上キー -> 過去（古い会話）へ
      const all = await history.all();
      if (currentTalkIndex < all.length - 1) {
        e.preventDefault();
        currentTalkIndex++;
        renderTalk();
      }
    } else if (e.key === 'ArrowDown') {
      // 下キー -> 未来（新しい会話）へ
      if (currentTalkIndex > 0) {
        e.preventDefault();
        currentTalkIndex--;
        renderTalk();
      }
    }
  }
});

// ------------------------------------------------------------
// その他 UI
// ------------------------------------------------------------
async function toggleVoiceListening(mode) {
  if (busy || currentJobAbortCtrl || currentPendingEl) {
    cancelCurrentJob('音声切り替えによる中断');
  }
  if (listening && voiceMode === mode) {
    await stopListening();
    return;
  }
  voiceMode = mode;
  if (!listening) {
    await startListening();
  } else {
    renderVoiceControls();
  }
}

// ---- 手動録音 (プッシュ・トゥ・トーク) 制御 ----
async function startPtt(mode, targetBtn, pointerId = null) {
  if (isPttRecording) return;
  // 前の翻訳処理中または読み上げ中であれば即座に中断して新規録音を開始
  if (busy || currentJobAbortCtrl || currentPendingEl) {
    cancelCurrentJob('PTT開始による中断');
  } else {
    tts.stop();
  }
  if (!isReady()) {
    updateReadiness();
    showView('settings');
    toast('先に言語データをダウンロードするか、オンラインモードに切り替えてください');
    return;
  }

  pttPressStartTime = Date.now();
  isPttRecording = true;
  pttActiveMode = mode;
  pttPointerId = pointerId;

  if (pointerId !== null && targetBtn.setPointerCapture) {
    try {
      targetBtn.setPointerCapture(pointerId);
    } catch (_) {}
  }

  try {
    navigator.vibrate?.(35);
  } catch (_) {}

  // 0msで即座にUIを録音中状態にし、ユーザーに視覚的・触覚的フィードバックを返す
  renderVoiceControls();
  const langA = LANGUAGES[settings.langA];
  const langB = LANGUAGES[settings.langB];
  const targetName = mode === 'langA' ? (langA?.name || '言語A') : mode === 'langB' ? (langB?.name || '言語B') : '自動認識';
  setStatus('hearing', `${targetName} 録音中…`);
  log.info('PTT 録音開始', { mode });

  try {
    await pttRecorder.start(pttPressStartTime);
  } catch (e) {
    log.error('PTT 録音開始に失敗', e);
    isPttRecording = false;
    pttActiveMode = null;
    pttPointerId = null;
    renderVoiceControls();
    setStatus('idle');
    toast(`マイク開始に失敗しました: ${e.message}`);
  }
}

async function stopPtt(targetBtn) {
  if (!isPttRecording) return;
  const mode = pttActiveMode;
  const pressEndTime = Date.now();
  const pressDuration = (pressEndTime - pttPressStartTime) / 1000;
  isPttRecording = false;
  pttActiveMode = null;

  if (pttPointerId !== null && targetBtn.releasePointerCapture) {
    try {
      targetBtn.releasePointerCapture(pttPointerId);
    } catch (_) {}
  }
  pttPointerId = null;

  try {
    navigator.vibrate?.(25);
  } catch (_) {}

  const res = await pttRecorder.stop(pressEndTime);
  renderVoiceControls();

  const effectiveSeconds = Math.max(res?.seconds || 0, pressDuration);

  // マイクエラー（起動失敗や、0.3秒以上押されたのに音声が全く回収できなかった場合）
  if (res?.error || (!res?.audio && pressDuration >= 0.3)) {
    log.warn('PTT マイク音声取得失敗', { error: res?.error, pressDuration, recordedSeconds: res?.seconds });
    toast('マイクから音声を取得できませんでした。もう一度お試しください');
    setStatus('idle');
    return;
  }

  // 0.15 秒未満しか押されていない場合のみ「短すぎます」とする
  if (!res || !res.audio || effectiveSeconds < 0.15) {
    log.info('PTT 音声が短すぎるためスキップ', { seconds: effectiveSeconds, pressDuration, recordedSeconds: res?.seconds });
    toast('録音時間が短すぎます。ボタンを長押ししながら話してください');
    setStatus('idle');
    return;
  }

  // 声が入っていない（無音・環境ノイズのみ）場合はAPIに送信せずその場で破棄
  if (isSilentAudio(res.audio)) {
    log.info('PTT 音声が無音/声が小さすぎるため破棄', { seconds: res.seconds });
    toast('声が検出されませんでした');
    setStatus('idle');
    return;
  }

  log.info('PTT 録音完了・翻訳キューへ', { seconds: res.seconds, mode, effectiveSeconds, sourceType: res.sourceType });
  enqueue({ kind: 'audio', audio: res.audio, seconds: res.seconds, voiceMode: mode });
}

function cancelPtt(targetBtn) {
  if (!isPttRecording) return;
  isPttRecording = false;
  pttActiveMode = null;
  if (pttPointerId !== null && targetBtn.releasePointerCapture) {
    try {
      targetBtn.releasePointerCapture(pttPointerId);
    } catch (_) {}
  }
  pttPointerId = null;
  pttRecorder.cancel();
  renderVoiceControls();
  setStatus('idle');
}

function bindVoiceButton(btn, mode) {
  if (!btn) return;

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // 主ボタン(左クリック/タッチ)のみ
    if (settings.speechDetectMode === 'manual') {
      e.preventDefault();
      // ボタンを押した瞬間に前の翻訳・読み上げ処理を即時中断
      if (busy || currentJobAbortCtrl || currentPendingEl) {
        cancelCurrentJob('PTT押下による中断');
      }
      // ユーザー操作の同期コールバック内で AudioContext を即時初期化・再開（iOS Safari 必須対策）
      pttRecorder.ensureAudioContext();
      startPtt(mode, btn, e.pointerId);
    }
  });

  btn.addEventListener('pointerup', (e) => {
    if (settings.speechDetectMode === 'manual') {
      e.preventDefault();
      stopPtt(btn);
    }
  });

  btn.addEventListener('pointercancel', (e) => {
    if (settings.speechDetectMode === 'manual') {
      // スマホのジェスチャー誤判定などで cancel が来ても、既に0.15秒以上押されていれば録音完了として救済
      const pressDuration = (Date.now() - pttPressStartTime) / 1000;
      if (isPttRecording && pressDuration >= 0.15) {
        stopPtt(btn);
      } else {
        cancelPtt(btn);
      }
    }
  });

  btn.addEventListener('click', (e) => {
    if (settings.speechDetectMode === 'auto') {
      toggleVoiceListening(mode);
    } else {
      e.preventDefault();
    }
  });
}

bindVoiceButton(el.micButton, 'auto');
bindVoiceButton(el.langABtn, 'langA');
bindVoiceButton(el.langBBtn, 'langB');

el.micBannerAction.addEventListener('click', () => {
  if (settings.speechDetectMode === 'auto') startListening();
  else toast('ボタンを長押しして話してください');
});
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
  if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      log.info('新しいバージョンが検出されました。即時適用します');
      updateSW(true);
    },
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
  if (loadBlockedBy) {
    log.error('前回、言語データの読み込み中にアプリが強制終了しました（メモリ不足の可能性）', loadBlockedBy);
    // 前回、翻訳モデルが載った状態で音声認識を読み込んで落ちていた場合、
    // 今は翻訳モデルを外して音声認識単体で読み込むため自動復帰を試みる
    if (loadBlockedBy.key?.startsWith('whisper:') && loadBlockedBy.alreadyLoaded?.some((k) => k.startsWith('mt:'))) {
      log.info('翻訳モデル解放によるメモリ軽量化構成のため、強制終了ガードを自動解除して音声認識の読み込みを再試行します');
      loadBlockedBy = null;
    }
  }
  fillLangSelect(el.langA, settings.langA);
  fillLangSelect(el.langB, settings.langB);
  el.whisperSize.value = settings.whisperSize;
  renderWhisperNote();
  el.device.value = settings.device;
  el.autoListenToggle.checked = settings.autoListen;
  el.autoSpeakToggle.checked = settings.autoSpeak;
  el.rate.value = settings.rate;
  el.rateValue.textContent = Number(settings.rate).toFixed(1);
  el.vadSilence.value = String(settings.vadSilenceMs);
  el.thinkingLevel.value = settings.thinkingLevel;
  applyFontSizes();
  if (el.srcFontSize) el.srcFontSize.value = settings.srcFontSize;
  if (el.dstFontSize) el.dstFontSize.value = settings.dstFontSize;
  updateSpeechDetectModeUI();
  el.versionText.textContent = `Transrate v${__APP_VERSION__}`;
  renderPair();
  renderMode();
  renderVoices();
  await auth.check();
  updateAuthUI();
  await renderRecent();

  // 初回起動時やLocalStorage未同期時、Cache APIに既に保存されているモデルがあれば同期する
  if (cachedKeys.size === 0 && 'caches' in window) {
    try {
      const known = allKnownModels();
      for (const m of known) {
        const has = await hasModelFiles(m.id);
        if (has) setCachedKey(m.key, true);
      }
    } catch {}
  }

  log.info('起動', { ua: navigator.userAgent, online: navigator.onLine, mode: settings.mode, pair: [settings.langA, settings.langB], whisper: settings.whisperSize, speechDetectMode: settings.speechDetectMode, thinkingLevel: settings.thinkingLevel, standalone: isStandalone(), appShellReady });
  updateReadiness();

  if (useOnline()) {
    // オンラインモード(または自動モードで通信可能)の場合は、重い端末内モデルのロードを行わず即座に準備完了とする
    if (settings.speechDetectMode === 'auto' && settings.autoListen) startListening();
  } else {
    // オフライン翻訳時はモデルが必須のため読み込みを待つ
    setStatus('loading', 'モデル読込中');
    const offlineOk = await ensureModels();
    updateReadiness();
    if (isReady() && settings.speechDetectMode === 'auto' && settings.autoListen) await startListening();
    else if (!offlineOk) showView('settings');
  }

  // 上限が極端に小さい場合はプライベートブラウズやアプリ内ブラウザ(閉じると保存データが消える環境)の可能性がある
  log.info('保存容量', { ...(await storageEstimate()), persisted: await navigator.storage?.persisted?.() });
  if (currentRequired().some((m) => cachedKeys.get(m.key))) {
    log.info('保存領域の永続化', { persisted: await requestPersistentStorage() });
  }

  if (settings.speechDetectMode === 'manual') {
    pttRecorder.warmup().catch(() => {});
  }
}

boot().catch((e) => {
  log.error('起動に失敗', e);
  setStatus('error');
  toast(`起動に失敗しました: ${e.message}`);
});
