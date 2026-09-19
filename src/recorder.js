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
    this.userStartTime = 0;
    this.startPromise = null;
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

  async warmup() {
    try {
      await this.ensureStream();
      if (this.stream) {
        this.stream.getAudioTracks().forEach((t) => (t.enabled = false));
      }
    } catch (_) {}
  }

  start(userStartTime = Date.now()) {
    this.userStartTime = userStartTime;
    if (this.startPromise) return this.startPromise;
    this.isRecording = true;

    this.startPromise = (async () => {
      await this.ensureStream();
      if (!this.isRecording) return; // 待機中にキャンセルされていた場合

      this.stream.getAudioTracks().forEach((t) => (t.enabled = true));
      this.chunks = [];
      this.startTime = Date.now();

      try {
        this.source?.disconnect();
        this.processor?.disconnect();
      } catch (_) {}

      this.source = this.audioCtx.createMediaStreamSource(this.stream);
      // 2048 サンプル（約42ms @ 48kHz）で高頻度にバッファを回収
      this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
      this.processor.onaudioprocess = (e) => {
        if (!this.isRecording) return;
        const input = e.inputBuffer.getChannelData(0);
        this.chunks.push(new Float32Array(input));
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);
    })();

    return this.startPromise;
  }

  async stop(userEndTime = Date.now()) {
    if (!this.isRecording && !this.startPromise) return null;

    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch (_) {}
      this.startPromise = null;
    }

    if (!this.isRecording) return null;
    this.isRecording = false;

    // トラックをミュート（省電力 & 不要な音声取得防止）
    if (this.stream) {
      this.stream.getAudioTracks().forEach((t) => (t.enabled = false));
    }

    const pressDuration = this.userStartTime ? (userEndTime - this.userStartTime) / 1000 : 0;

    // もし押下時間は十分なのにバッファがまだ届いていない場合、最初の1コマを待つ
    if (this.chunks.length === 0 && pressDuration >= 0.1) {
      await new Promise((r) => setTimeout(r, 60));
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

    const micDuration = this.startTime ? (Date.now() - this.startTime) / 1000 : 0;
    const effectiveSeconds = Math.max(pressDuration, micDuration, +(finalAudio.length / 16000));

    return {
      audio: finalAudio,
      seconds: +effectiveSeconds.toFixed(2),
    };
  }

  cancel() {
    this.isRecording = false;
    this.startPromise = null;
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

// 音声データに実際の声（エネルギー）が含まれているか判定する。
// 環境ノイズや無音の場合は true を返す。
export function isSilentAudio(samples, rmsThreshold = 0.007, peakThreshold = 0.035) {
  if (!samples || samples.length === 0) return true;
  let sumSquares = 0;
  let maxPeak = 0;
  for (let i = 0; i < samples.length; i++) {
    const val = Math.abs(samples[i]);
    if (val > maxPeak) maxPeak = val;
    sumSquares += val * val;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms < rmsThreshold && maxPeak < peakThreshold;
}
