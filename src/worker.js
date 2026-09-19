// ML ワーカー: Whisper(音声認識 + 2言語間の言語判定) と Marian(翻訳) を transformers.js で実行する。
import {
  env,
  pipeline,
  AutoProcessor,
  AutoTokenizer,
  WhisperForConditionalGeneration,
  LogitsProcessor,
  LogitsProcessorList,
  ModelRegistry,
} from '@huggingface/transformers';
import * as OpenCC from 'opencc-js';

const BASE = self.location.origin + import.meta.env.BASE_URL;

env.allowLocalModels = false;
env.useBrowserCache = true;
// ONNX Runtime の wasm はアプリ同梱のものを使う(オフライン動作のため CDN を使わない)
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${BASE}ort/ort-wasm-simd-threaded.mjs`,
  wasm: `${BASE}ort/ort-wasm-simd-threaded.wasm`,
};
// モバイル端末での過剰なスレッド生成による発熱・CPU過負荷を防ぐ(最大4スレッド)
env.backends.onnx.wasm.numThreads = Math.min(self.navigator?.hardwareConcurrency || 2, 4);

// onnxruntime-web の拡張グラフ最適化(TransposeDQForMatMulNBits)が q8 モデルで失敗するため basic に抑える
const SESSION_OPTIONS = { graphOptimizationLevel: 'basic' };

const state = {
  whisper: null, // { key, processor, tokenizer, model, device }
  mt: new Map(), // key -> pipeline
};

const post = (msg, transfer) => self.postMessage(msg, transfer);

// 簡体字⇄繁体字(台湾)の変換
const converters = {
  cn2twp: OpenCC.Converter({ from: 'cn', to: 'twp' }),
  t2cn: OpenCC.Converter({ from: 't', to: 'cn' }),
};
const applyPost = (text, name) => (name && converters[name] ? converters[name](text) : text);

function progressFor(key) {
  return (p) => {
    if (p.status === 'progress' || p.status === 'done' || p.status === 'initiate') {
      post({ type: 'progress', key, status: p.status, file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    }
  };
}

// 指定トークン以外を -Infinity にして、2言語のどちらかのトークンだけを選ばせる
class OnlyTokens extends LogitsProcessor {
  constructor(ids) {
    super();
    this.ids = ids;
  }
  _call(_inputIds, logits) {
    for (let b = 0; b < logits.dims[0]; b++) {
      const d = logits[b].data;
      const keep = this.ids.map((i) => d[i]);
      d.fill(-Infinity);
      this.ids.forEach((i, k) => (d[i] = keep[k]));
    }
    return logits;
  }
}

const whisperDtype = (device) =>
  device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'q8', decoder_model_merged: 'q8' };
const MT_DTYPE = 'q8';

// モデルの動作に必要なファイル(config / tokenizer / onnx 等)がすべて Cache API に保存されているかを調べる。
// config.json が無いとファイル一覧を決められず、取得にネットが必要になるので、その時点で未保存と判定する。
// transformers.js が Cache API に保存するときのキー(= HuggingFace 上の URL)
const fileUrl = (id, file) => `${env.remoteHost}${env.remotePathTemplate.replaceAll('{model}', id).replaceAll('{revision}', 'main')}${file}`;

const filesFor = (kind, id, device) =>
  kind === 'whisper'
    ? ModelRegistry.get_files(id, { dtype: whisperDtype(device), device })
    : ModelRegistry.get_pipeline_files('translation', id, { dtype: MT_DTYPE, device });

async function cacheStatus({ kind, id, device }) {
  const cache = await caches.open(env.cacheKey);
  if (!(await cache.match(fileUrl(id, 'config.json')))) return { cached: false, missing: ['config.json'] };
  const r =
    kind === 'whisper'
      ? await ModelRegistry.is_cached_files(id, { dtype: whisperDtype(device), device })
      : await ModelRegistry.is_pipeline_cached_files('translation', id, { dtype: MT_DTYPE, device });
  return { cached: r.allCached, missing: r.files.filter((f) => !f.cached).map((f) => f.file) };
}

// モデルを読み込まず(推論セッションを作らず)、ファイルだけを Cache API へ保存する。
// ダウンロードと同時に読み込むと、スマホではメモリ不足でページごと強制終了されるため分けている。
const STREAM_MIN_BYTES = 20 * 1024 * 1024;
async function download({ key, kind, id, device }) {
  const files = await filesFor(kind, id, device);
  const cache = await caches.open(env.cacheKey);
  for (const file of files) {
    const url = fileUrl(id, file);
    if (await cache.match(url)) {
      post({ type: 'progress', key, status: 'done', file, loaded: 0, total: 0 });
      continue;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${file} の取得に失敗しました (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const headers = new Headers(res.headers);
    let loaded = 0;
    if (total > STREAM_MIN_BYTES) {
      // 大きい onnx はメモリに溜めず、受信しながら保存する
      let reported = 0;
      const counter = new TransformStream({
        transform(chunk, ctl) {
          loaded += chunk.byteLength;
          if (loaded - reported >= 1024 * 1024) {
            reported = loaded;
            post({ type: 'progress', key, status: 'progress', file, loaded, total });
          }
          ctl.enqueue(chunk);
        },
      });
      await cache.put(url, new Response(res.body.pipeThrough(counter), { headers }));
      if (loaded !== total) {
        await cache.delete(url);
        throw new Error(`${file} のダウンロードが途中で途切れました (${loaded} / ${total} バイト)`);
      }
    } else {
      const buf = await res.arrayBuffer();
      loaded = buf.byteLength;
      // Cache API が content-length を落とすことがあるため明示する(transformers.js の読み込み時の進捗計算に使われる)
      headers.set('content-length', String(loaded));
      await cache.put(url, new Response(buf, { headers }));
    }
    post({ type: 'progress', key, status: 'done', file, loaded, total: total || loaded });
  }
  post({ type: 'downloaded', key });
}

async function checkCached({ id, models, device }) {
  const result = {};
  for (const m of models) result[m.key] = await cacheStatus({ ...m, device });
  post({ type: 'cacheStatus', id, result });
}

async function loadWhisper({ key, id, device }) {
  if (state.whisper?.key === key && state.whisper.device === device) {
    post({ type: 'loaded', key });
    return;
  }
  if (state.whisper) {
    await state.whisper.model.dispose?.();
    state.whisper = null;
  }
  const cb = progressFor(key);
  const processor = await AutoProcessor.from_pretrained(id, { progress_callback: cb });
  const tokenizer = await AutoTokenizer.from_pretrained(id, { progress_callback: cb });
  const model = await WhisperForConditionalGeneration.from_pretrained(id, { dtype: whisperDtype(device), device, session_options: SESSION_OPTIONS, progress_callback: cb });
  state.whisper = { key, id, processor, tokenizer, model, device };
  post({ type: 'loaded', key });
}

async function loadMT({ key, id, device }) {
  if (state.mt.has(key)) {
    post({ type: 'loaded', key });
    return;
  }
  const tr = await pipeline('translation', id, { dtype: MT_DTYPE, device, session_options: SESSION_OPTIONS, progress_callback: progressFor(key) });
  state.mt.set(key, tr);
  post({ type: 'loaded', key });
}

async function unload({ key }) {
  if (state.whisper?.key === key) {
    await state.whisper.model.dispose?.();
    state.whisper = null;
  } else if (state.mt.has(key)) {
    await state.mt.get(key).dispose?.();
    state.mt.delete(key);
  }
  post({ type: 'unloaded', key });
}

// Whisper: まず <|startoftranscript|> の直後1トークンを候補2言語に絞って生成し言語判定、
// 続いて判定した言語を固定して文字起こしする。
// langs: [{ code: 'zh-TW', whisper: 'zh', post: 'cn2twp' }, ...]
async function transcribe({ id, audio, langs }) {
  const w = state.whisper;
  if (!w) throw new Error('音声認識モデルが読み込まれていません');
  const t0 = performance.now();
  const gc = w.model.generation_config;
  const inputs = await w.processor(audio);

  let picked;
  let t1;
  if (langs.length === 1) {
    picked = langs[0];
    t1 = performance.now();
  } else {
    const langIds = langs.map((l) => gc.lang_to_id[`<|${l.whisper}|>`]);
    if (langIds.some((x) => x == null)) throw new Error(`音声認識が未対応の言語です: ${langs.map((l) => l.code).join(',')}`);
    const lp = new LogitsProcessorList();
    lp.push(new OnlyTokens(langIds));
    const det = await w.model.generate({
      ...inputs,
      decoder_input_ids: [gc.decoder_start_token_id],
      logits_processor: lp,
      max_new_tokens: 1,
    });
    const detIds = Array.from(det[0].data).map(Number);
    picked = langs[langIds.indexOf(detIds[1])] || langs[0];
    t1 = performance.now();
  }

  const out = await w.model.generate({ ...inputs, language: picked.whisper, task: 'transcribe', max_new_tokens: 160 });
  let text = w.tokenizer.decode(Array.from(out[0].data).map(Number), { skip_special_tokens: true }).trim();
  text = applyPost(text, picked.post);
  const t2 = performance.now();
  post({ type: 'transcribed', id, lang: picked.code, text, detectMs: Math.round(t1 - t0), transcribeMs: Math.round(t2 - t1) });
}

// route: [{ key }] を順に適用(英語経由の中継翻訳は2段)。post は最終出力の文字変換。
async function translate({ id, route, text, post: postName }) {
  const t0 = performance.now();
  let cur = text;
  const steps = [];
  for (const s of route) {
    const tr = state.mt.get(s.key);
    if (!tr) throw new Error(`翻訳モデルが読み込まれていません: ${s.key}`);
    const out = await tr(cur, { max_new_tokens: 256 });
    cur = (out[0]?.translation_text ?? '').trim();
    steps.push(cur);
  }
  cur = applyPost(cur, postName);
  post({ type: 'translated', id, text: cur, steps, ms: Math.round(performance.now() - t0) });
}

const handlers = { loadWhisper, loadMT, unload, transcribe, translate, checkCached, download };

self.onmessage = async (e) => {
  const msg = e.data;
  const fn = handlers[msg.type];
  if (!fn) return;
  try {
    await fn(msg);
  } catch (err) {
    post({ type: 'error', id: msg.id, key: msg.key, op: msg.type, message: err?.message ?? String(err) });
  }
};
