import { useCallback, useEffect, useRef, useState } from "react";
import {
  extractProsodyFromPCM,
  type ProsodySummary,
  type ProsodyVector,
} from "@/world/prosody-audio";

/** 与 Python 侧保持同一采样率；浏览器通常给 48k，这里按整数倍抽取。 */
const TARGET_RATE = 16000;
/** 实时诊断只看最近这一小段，够判断「是不是在卡壳」。 */
const LIVE_WINDOW_SEC = 1.5;
/** 实时诊断节流：12 维自相关很吃 CPU，不能每帧跑。 */
const LIVE_EVERY_MS = 650;
const MAX_SEC = 12;

export interface ProsodyRecorder {
  recording: boolean;
  /** 已提取出的紧张度（上次诊断或松手后的定稿）。 */
  tension: number;
  /** 实时音量包络，用来让光晕跟着说话起伏。 */
  energy: number;
  cue: string;
  vector: ProsodyVector | null;
  /** 是否检测到环境较吵闹（用于舞台红字提醒建议在安静环境使用）。 */
  noisy: boolean;
  /** 估算环境底噪（dBFS），用于直观展示吵闹程度。 */
  noiseDb: number | null;
  error: string | null;
  start: (onText?: (text: string) => void) => Promise<void>;
  stop: () => void;
}

/**
 * 按住说话的采集器：一边把 PCM 抽到 16k 里，一边节流跑 12 维提取。
 *
 * 松手后 `vector` 留给下一次 `/step`，`tension` 定稿；录音本身不出本机。
 */
export function useProsody(): ProsodyRecorder {
  const [recording, setRecording] = useState(false);
  const [tension, setTension] = useState(0);
  const [energy, setEnergy] = useState(0);
  const [cue, setCue] = useState("按住开口，语气会被听见");
  const [vector, setVector] = useState<ProsodyVector | null>(null);
  const [noisy, setNoisy] = useState(false);
  const [noiseDb, setNoiseDb] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef(0);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  const ring = useRef(new Float32Array(TARGET_RATE * MAX_SEC));
  const written = useRef(0);
  const lastDiag = useRef(0);
  const lastEnergy = useRef(0);
  const smoothEnergy = useRef(0);
  const noisyFrames = useRef(0);

  const push = (chunk: Float32Array) => {
    const buf = ring.current;
    for (let i = 0; i < chunk.length; i++) {
      buf[written.current % buf.length] = chunk[i];
      written.current++;
    }
  };

  const recent = (seconds: number): Float32Array => {
    const buf = ring.current;
    const n = Math.min(written.current, Math.floor(seconds * TARGET_RATE));
    const out = new Float32Array(n);
    const start = written.current - n;
    for (let i = 0; i < n; i++) out[i] = buf[(start + i) % buf.length];
    return out;
  };

  const diagnose = useCallback((final: boolean) => {
    const samples = recent(final ? MAX_SEC : LIVE_WINDOW_SEC);
    if (samples.length < TARGET_RATE * 0.4) return;
    const summary: ProsodySummary = extractProsodyFromPCM(samples, TARGET_RATE);
    setTension(summary.tension);
    setCue(summary.cueLabel);
    setNoisy(summary.noisy);
    setNoiseDb(summary.noiseDb);
    if (final) setVector(summary.vector);
  }, []);

  const teardown = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }, []);

  const stop = useCallback(() => {
    if (!ctxRef.current && !streamRef.current) return;
    diagnose(true);
    setRecording(false);
    setEnergy(0);
    smoothEnergy.current = 0;
    teardown();
  }, [diagnose, teardown]);

  const start = useCallback(
    async (onText?: (text: string) => void) => {
      if (ctxRef.current) return;
      setError(null);
      setNoisy(false);
      setNoiseDb(null);
      noisyFrames.current = 0;
      written.current = 0;
      lastDiag.current = 0;
      try {
        // 保留真实环境底噪特征（仅开回声消除），这样吵闹会场可以被真实识别并红字提示
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
        });
        const ctx = new AudioContext();
        await ctx.resume();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        ctx.createMediaStreamSource(stream).connect(analyser);

        ctxRef.current = ctx;
        streamRef.current = stream;
        analyserRef.current = analyser;
        setRecording(true);
        setCue("正在听 · 松手后把语气带进这一句");

        const step = Math.max(1, Math.round(ctx.sampleRate / TARGET_RATE));
        const frame = new Float32Array(analyser.fftSize);
        const down = new Float32Array(Math.floor(frame.length / step));

        const loop = () => {
          const node = analyserRef.current;
          if (!node) return;
          node.getFloatTimeDomainData(frame);
          let sum = 0;
          for (let i = 0, j = 0; j < down.length; i += step, j++) {
            down[j] = frame[i];
            sum += frame[i] * frame[i];
          }
          push(down);

          const rms = Math.sqrt(sum / frame.length);
          smoothEnergy.current = smoothEnergy.current * 0.82 + Math.min(1, rms * 7) * 0.18;
          // 连续高底噪即时预警（~0.4s 持续超过阈值立即亮红字，无需等松手）
          if (rms > 0.045) {
            noisyFrames.current += 1;
            if (noisyFrames.current >= 22) {
              setNoisy(true);
              setNoiseDb(Math.max(-65, Math.min(0, Math.round(20 * Math.log10(Math.max(1e-5, rms))))));
            }
          } else if (rms < 0.018) {
            noisyFrames.current = Math.max(0, noisyFrames.current - 2);
          }
          const now = performance.now();
          if (now - lastEnergy.current > 66) {
            lastEnergy.current = now;
            setEnergy(smoothEnergy.current);
          }
          if (now - lastDiag.current > LIVE_EVERY_MS) {
            lastDiag.current = now;
            diagnose(false);
          }
          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);

        // 有语音识别就顺手转写，没有也不影响声学链路。
        const Ctor =
          (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ??
          (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
        if (Ctor && onText) {
          const recognition = new (Ctor as new () => {
            lang: string;
            continuous: boolean;
            interimResults: boolean;
            onresult: (event: {
              results: ArrayLike<ArrayLike<{ transcript: string }>>;
            }) => void;
            start: () => void;
            stop: () => void;
          })();
          recognition.lang = "zh-CN";
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.onresult = (event) => {
            let text = "";
            for (let i = 0; i < event.results.length; i++) {
              text += event.results[i][0]?.transcript ?? "";
            }
            if (text.trim()) onText(text.trim());
          };
          try {
            recognition.start();
            recognitionRef.current = recognition;
          } catch {
            recognitionRef.current = null;
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "没有拿到麦克风权限");
        teardown();
      }
    },
    [diagnose, teardown],
  );

  useEffect(() => teardown, [teardown]);

  return { recording, tension, energy, cue, vector, noisy, noiseDb, error, start, stop };
}
