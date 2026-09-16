// マイク入力の発話区間検出(Silero VAD)。発話が終わるごとに 16kHz Float32Array を返す。
import { MicVAD } from '@ricky0123/vad-web';

const BASE = import.meta.env.BASE_URL;
const ORT_DIR = `${BASE}ort-vad/`;

// onnxruntime-web は wasm のローダー(.mjs)を動的 import するが、Vite 開発サーバは /public の
// .mjs を import できないため、ローダーを取得して Blob URL にし、wasm 本体は事前に読み込んで渡す。
let ortAssets = null;
async function prepareOrtAssets() {
  if (ortAssets) return ortAssets;
  const [mjs, wasm] = await Promise.all([
    fetch(`${ORT_DIR}ort-wasm-simd-threaded.mjs`).then((r) => {
      if (!r.ok) throw new Error(`VAD ランタイムの取得に失敗 (${r.status})`);
      return r.text();
    }),
    fetch(`${ORT_DIR}ort-wasm-simd-threaded.wasm`).then((r) => {
      if (!r.ok) throw new Error(`VAD ランタイム(wasm)の取得に失敗 (${r.status})`);
      return r.arrayBuffer();
    }),
  ]);
  ortAssets = {
    mjsUrl: URL.createObjectURL(new Blob([mjs], { type: 'text/javascript' })),
    wasmUrl: `${ORT_DIR}ort-wasm-simd-threaded.wasm`,
    wasmBinary: wasm,
  };
  return ortAssets;
}

const requestMic = () =>
  navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true },
  });

export async function createVad({ onSpeechStart, onSpeechEnd, onMisfire }) {
  const assets = await prepareOrtAssets();
  const vad = await MicVAD.new({
    model: 'v5',
    baseAssetPath: `${BASE}vad/`,
    onnxWASMBasePath: ORT_DIR,
    ortConfig: (ort) => {
      ort.env.wasm.wasmPaths = { mjs: assets.mjsUrl, wasm: assets.wasmUrl };
      ort.env.wasm.wasmBinary = assets.wasmBinary;
    },
    positiveSpeechThreshold: 0.55,
    negativeSpeechThreshold: 0.35,
    preSpeechPadMs: 400,
    redemptionMs: 900, // これだけ無音が続いたら発話終了
    minSpeechMs: 300, // これより短い音は無視
    submitUserSpeechOnPause: false,
    getStream: requestMic,
    // vad-web の既定は一時停止でマイクを止め(track.stop)、再開時に getUserMedia し直す。
    // iPhone ではそのたびに許可ダイアログが出るため、止めずにミュートして同じマイクを使い続ける。
    pauseStream: async (stream) => {
      stream.getAudioTracks().forEach((t) => (t.enabled = false));
    },
    resumeStream: async (stream) => {
      const tracks = stream.getAudioTracks();
      // 通話の割り込み等で OS 側がマイクを終了させた場合だけ取り直す
      if (!tracks.length || tracks.some((t) => t.readyState === 'ended')) return requestMic();
      tracks.forEach((t) => (t.enabled = true));
      return stream;
    },
    onSpeechStart,
    onSpeechEnd,
    onVADMisfire: onMisfire,
  });
  return vad;
}
