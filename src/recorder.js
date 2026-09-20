// 手動録音（プッシュ・トゥ・トーク用）: Web Audio API & MediaRecorder のデュアルキャプチャ
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
    this.mediaRecorder = null;
    this.mediaChunks = [];
    this.chunks = [];
    this.isRecording = false;
    this.startTime = 0;
    this.userStartTime = 0;
    this.startPromise = null;
  }

  // ユーザーの直接操作イベント（pointerdown等）の同期コンテキストで呼び出す
  ensureAudioContext() {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
    }
    if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  async ensureStream() {
    this.ensureAudioContext();

    const isStreamAlive = (s) => {
      if (!s || !s.active) return false;
      const tracks = s.getAudioTracks();
      if (tracks.length === 0) return false;
      return tracks.some((t) => t.readyState === 'live');
    };

    if (!isStreamAlive(this.stream)) {
      try {
        this.stream?.getAudioTracks().forEach((t) => t.stop());
      } catch (_) {}
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      });
    }

    if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
      await this.audioCtx.resume().catch(() => {});
    }

    return this.stream;
  }

  async warmup() {
    try {
      this.ensureAudioContext();
      await this.ensureStream();
    } catch (_) {}
  }

  start(userStartTime = Date.now()) {
    this.userStartTime = userStartTime;
    if (this.startPromise) return this.startPromise;
    this.isRecording = true;
    this.ensureAudioContext();

    this.startPromise = (async () => {
      try {
        await this.ensureStream();
        if (!this.isRecording) return;

        this.chunks = [];
        this.mediaChunks = [];
        this.startTime = Date.now();

        // 1. ScriptProcessorNode による低遅延リアルタイム PCM キャプチャ
        try {
          this.source?.disconnect();
          this.processor?.disconnect();
        } catch (_) {}

        this.source = this.audioCtx.createMediaStreamSource(this.stream);
        // 2048 サンプル（約42ms @ 48kHz）
        this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
        this.processor.onaudioprocess = (e) => {
          if (!this.isRecording) return;
          const input = e.inputBuffer.getChannelData(0);
          this.chunks.push(new Float32Array(input));
          // Safari の省電力パイプライン停止防止のため出力バッファをクリアして満たす
          const output = e.outputBuffer.getChannelData(0);
          output.fill(0);
        };

        this.source.connect(this.processor);
        this.processor.connect(this.audioCtx.destination);

        // 2. バックアップ系統: MediaRecorder による確実な音声キャプチャ (Safari/WebKit 対策)
        if (typeof MediaRecorder !== 'undefined') {
          try {
            const mime = MediaRecorder.isTypeSupported('audio/webm')
              ? 'audio/webm'
              : MediaRecorder.isTypeSupported('audio/mp4')
              ? 'audio/mp4'
              : '';
            const options = mime ? { mimeType: mime } : undefined;
            this.mediaRecorder = new MediaRecorder(this.stream, options);
            this.mediaRecorder.ondataavailable = (e) => {
              if (e.data && e.data.size > 0) {
                this.mediaChunks.push(e.data);
              }
            };
            this.mediaRecorder.start(80);
          } catch (mrErr) {
            console.warn('MediaRecorder 起動スキップ:', mrErr);
            this.mediaRecorder = null;
          }
        }
      } catch (err) {
        this.isRecording = false;
        throw err;
      }
    })();

    return this.startPromise;
  }

  async stop(userEndTime = Date.now()) {
    if (!this.isRecording && !this.startPromise) return null;

    let startError = null;
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch (e) {
        startError = e;
      }
      this.startPromise = null;
    }

    if (startError) {
      this.cancel();
      return { error: 'MIC_START_FAILED', message: startError.message };
    }

    if (!this.isRecording) return null;
    this.isRecording = false;

    const pressDuration = this.userStartTime ? (userEndTime - this.userStartTime) / 1000 : 0;

    // MediaRecorder 停止待機
    let mrStoppedPromise = null;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      mrStoppedPromise = new Promise((resolve) => {
        this.mediaRecorder.onstop = () => resolve();
        try {
          this.mediaRecorder.stop();
        } catch (_) {
          resolve();
        }
      });
    }

    // Web Audio ノード切断
    try {
      this.source?.disconnect();
      this.processor?.disconnect();
    } catch (_) {}
    this.source = null;
    this.processor = null;

    if (mrStoppedPromise) {
      await Promise.race([mrStoppedPromise, new Promise((r) => setTimeout(r, 200))]);
    }

    // 1. ScriptProcessor から PCM チャンクが取れている場合（最速パス）
    if (this.chunks.length > 0) {
      let totalLen = 0;
      for (const c of this.chunks) totalLen += c.length;
      const merged = new Float32Array(totalLen);
      let offset = 0;
      for (const c of this.chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      this.chunks = [];
      this.mediaChunks = [];

      const sampleRate = this.audioCtx ? this.audioCtx.sampleRate : 48000;
      const audio16k = resampleTo16k(merged, sampleRate);
      const maxSamples = 16000 * 30;
      const finalAudio = audio16k.length > maxSamples ? audio16k.slice(0, maxSamples) : audio16k;

      const micDuration = this.startTime ? (Date.now() - this.startTime) / 1000 : 0;
      const effectiveSeconds = Math.max(pressDuration, micDuration, +(finalAudio.length / 16000));

      return {
        audio: finalAudio,
        seconds: +effectiveSeconds.toFixed(2),
        chunksCount: merged.length,
        sourceType: 'pcm',
      };
    }

    // 2. ScriptProcessor が空で、MediaRecorder からデータが取れている場合（WebKit救済パス）
    if (this.mediaChunks.length > 0) {
      try {
        const mime = this.mediaRecorder?.mimeType || 'audio/mp4';
        const blob = new Blob(this.mediaChunks, { type: mime });
        this.mediaChunks = [];

        this.ensureAudioContext();
        const arrayBuf = await blob.arrayBuffer();
        const audioBuf = await this.audioCtx.decodeAudioData(arrayBuf);
        const pcmChannel = audioBuf.getChannelData(0);
        const audio16k = resampleTo16k(pcmChannel, audioBuf.sampleRate);
        const maxSamples = 16000 * 30;
        const finalAudio = audio16k.length > maxSamples ? audio16k.slice(0, maxSamples) : audio16k;

        const effectiveSeconds = Math.max(pressDuration, +(finalAudio.length / 16000));
        return {
          audio: finalAudio,
          seconds: +effectiveSeconds.toFixed(2),
          chunksCount: finalAudio.length,
          sourceType: 'media_recorder',
        };
      } catch (decodeErr) {
        console.warn('MediaRecorder デコード失敗:', decodeErr);
      }
    }

    // 3. どちらからも取れなかった場合
    if (pressDuration >= 0.25) {
      // 0.25秒以上押されていたのに音声が来ない場合はマイクスタックとみなし、次回のためリセット
      this.destroy();
      return {
        error: 'MIC_NO_AUDIO',
        pressDuration,
      };
    }

    return null;
  }

  cancel() {
    this.isRecording = false;
    this.startPromise = null;
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    } catch (_) {}
    this.mediaRecorder = null;
    this.mediaChunks = [];
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
