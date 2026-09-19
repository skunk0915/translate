// 手動録音（プッシュ・トゥ・トーク用）: Web Audio API でマイク入力をキャプチャし、
// 16kHz Float32Array として切り出して返す。

function resampleTo16k(input, fromRate) {
  if (fromRate === 16000) return input;
  const ratio = fromRate / 16000;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    result[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return result;
}

export class PttRecorder {
  constructor() {
    this.audioCtx = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.chunks = [];
    this.isRecording = false;
    this.startTime = 0;
  }

  async ensureStream() {
    if (!this.stream || this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      });
    }
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume().catch(() => {});
    }
    return this.stream;
  }

  async start() {
    if (this.isRecording) return;
    await this.ensureStream();

    // トラックを有効化
    this.stream.getAudioTracks().forEach((t) => (t.enabled = true));

    this.chunks = [];
    this.isRecording = true;
    this.startTime = Date.now();

    // ソースとプロセッサの接続
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    // 4096 サンプルごとにバッファを収集（約 85ms @ 48kHz）
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (!this.isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
  }

  async stop() {
    if (!this.isRecording) return null;
    this.isRecording = false;
    const duration = (Date.now() - this.startTime) / 1000;

    // トラックをミュート（省電力 & 不要な音声取得防止）
    if (this.stream) {
      this.stream.getAudioTracks().forEach((t) => (t.enabled = false));
    }

    // ノード切断
    try {
      this.source?.disconnect();
      this.processor?.disconnect();
    } catch (_) {}
    this.source = null;
    this.processor = null;

    if (this.chunks.length === 0) return null;

    // 全チャンクを結合
    let totalLen = 0;
    for (const c of this.chunks) totalLen += c.length;
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.chunks = [];

    // 16kHz にリサンプリング
    const sampleRate = this.audioCtx ? this.audioCtx.sampleRate : 48000;
    const audio16k = resampleTo16k(merged, sampleRate);

    // 最大30秒でクリップ
    const maxSamples = 16000 * 30;
    const finalAudio = audio16k.length > maxSamples ? audio16k.slice(0, maxSamples) : audio16k;

    return {
      audio: finalAudio,
      seconds: +duration.toFixed(1),
    };
  }

  cancel() {
    if (!this.isRecording) return;
    this.isRecording = false;
    if (this.stream) {
      this.stream.getAudioTracks().forEach((t) => (t.enabled = false));
    }
    try {
      this.source?.disconnect();
      this.processor?.disconnect();
    } catch (_) {}
    this.source = null;
    this.processor = null;
    this.chunks = [];
  }

  destroy() {
    this.cancel();
    try {
      this.stream?.getAudioTracks().forEach((t) => t.stop());
      this.audioCtx?.close().catch(() => {});
    } catch (_) {}
    this.stream = null;
    this.audioCtx = null;
  }
}
