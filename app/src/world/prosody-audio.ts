/**
 * 浏览器端 12 维副语言声学特征提取器（与 `epistemic_model/prosody.py` 严格同口径）。
 *
 * 为什么不在服务端跑 ASR 了事：
 *   ASR 会把“呃……我……没问题吧？（尾音心虚上扬 + 声带微颤）”直接抹平成“我没问题”，
 *   销毁了 90% 的人类真实博弈心理信号。
 *
 * 本模块直接通过浏览器原生 WebAudio 采集单声道 PCM，在本地毫秒级算出 12 维声学向量，
 * 只上传 12 个浮点数给 PAI-SSM 状态核（既零延迟，又保护用户原始录音隐私）。
 */

export const PARALINGUISTIC_NAMES = [
  "response_latency", // [0] 开口前犹豫潜伏期占比
  "pause_ratio", // [1] 说话中途停顿占比
  "disfluency_rate", // [2] 半半卡卡/断续跳变率
  "filled_pause_ratio", // [3] “呃/嗯/啊”长稳态填充停顿占比
  "f0_mean_norm", // [4] 归一化对数基频均值（音调高低）
  "f0_std_norm", // [5] 基频标准差（抑扬幅度）
  "f0_terminal_slope", // [6] 句末基频斜率（>0 上扬试探/心虚，<0 下沉笃定/低沉）
  "pitch_jitter", // [7] 相邻帧基频微颤（紧张度）
  "amplitude_shimmer", // [8] 相邻帧振幅微颤
  "speech_rate", // [9] 音节包络语速
  "energy_slope", // [10] 全句底气能量走势（<0 越说越虚）
  "spectral_tilt", // [11] 高低频谱倾斜度（嗓音紧绷度）
] as const;

export type ProsodyVector = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface ProsodySummary {
  vector: ProsodyVector;
  /** 给人看的一句话直观声学诊断（用于舞台轻提示，不画丑图表） */
  cueLabel: string;
  /** 0..1 综合语音紧张/犹豫度，用于驱动呼吸光晕环 */
  tension: number;
  /** 原始底噪 RMS（20 分位能量，未归一化） */
  noiseFloorRms: number;
  /** 估算底噪分贝（dBFS，安静房间约 -55~-38 dB，吵闹会场常 > -30 dB） */
  noiseDb: number;
  /** 是否检测到环境较吵闹，可能干扰副语言特征提取 */
  noisy: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 从单声道 PCM 采样数组提取与 Python `ParalinguisticExtractor` 对齐的 12 维向量。
 */
export function extractProsodyFromPCM(samples: Float32Array, sampleRate = 16000): ProsodySummary {
  const frameLen = Math.max(64, Math.round(sampleRate * 0.025));
  const hopLen = Math.max(16, Math.round(sampleRate * 0.01));
  const minLag = Math.max(2, Math.floor(sampleRate / 400));
  const maxLag = Math.min(frameLen - 2, Math.floor(sampleRate / 70));

  if (samples.length < frameLen * 2) {
    return {
      vector: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      cueLabel: "未捕捉到有效语音",
      tension: 0,
      noiseFloorRms: 0,
      noiseDb: -60,
      noisy: false,
    };
  }

  // 去直流 + 计算原始（未归一化）底噪水平 + 峰值归一化
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;

  let peak = 1e-5;
  const x = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] - mean;
    x[i] = v;
    const av = Math.abs(v);
    if (av > peak) peak = av;
  }

  // 在归一化前计算每帧原始 RMS，用于真实环境吵闹度（底噪）检测
  const T = Math.floor((x.length - frameLen) / hopLen) + 1;
  const rawRms = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const off = t * hopLen;
    let e = 0;
    for (let i = 0; i < frameLen; i++) {
      const s = x[off + i];
      e += s * s;
    }
    rawRms[t] = Math.sqrt(e / frameLen + 1e-12);
  }
  const sortedRawRms = Array.from(rawRms).sort((a, b) => a - b);
  const noiseFloorRms = sortedRawRms[Math.floor(sortedRawRms.length * 0.2)] ?? 0;
  const peakRawRms = sortedRawRms[Math.floor(sortedRawRms.length * 0.9)] ?? 0;
  const noiseDb = Math.max(-65, Math.min(0, Math.round(20 * Math.log10(Math.max(1e-5, noiseFloorRms)))));
  const noisy =
    noiseFloorRms > 0.032 ||
    (noiseFloorRms > 0.02 && peakRawRms > 0 && noiseFloorRms / peakRawRms > 0.36);

  for (let i = 0; i < x.length; i++) x[i] /= peak;

  const rms = new Float32Array(T);
  const zcr = new Float32Array(T);
  const f0Hz = new Float32Array(T);
  const f0Semi = new Float32Array(T);
  const periodic = new Uint8Array(T);
  let highFreqAcc = 0;
  let lowFreqAcc = 1e-6;

  for (let t = 0; t < T; t++) {
    const off = t * hopLen;
    let e = 0;
    let z = 0;
    let diffEnergy = 0;
    for (let i = 0; i < frameLen; i++) {
      const s = x[off + i];
      e += s * s;
      if (i > 0) {
        if (s >= 0 !== x[off + i - 1] >= 0) z++;
        const d = s - x[off + i - 1];
        diffEnergy += d * d;
      }
    }
    rms[t] = Math.sqrt(e / frameLen + 1e-12);
    zcr[t] = z / (frameLen - 1);
    lowFreqAcc += e;
    highFreqAcc += diffEnergy;
  }

  // 90 分位能量自适应有声门限
  const sortedRms = Array.from(rms).sort((a, b) => a - b);
  const hiEnergy = Math.max(1e-3, sortedRms[Math.floor(sortedRms.length * 0.9)] ?? 0.1);
  const voiced = new Uint8Array(T);
  let firstVoiced = T;
  for (let t = 0; t < T; t++) {
    if (rms[t] > 0.14 * hiEnergy) {
      voiced[t] = 1;
      if (firstVoiced === T) firstVoiced = t;
    }
  }

  // 自相关基频 F0 估计
  for (let t = 0; t < T; t++) {
    if (!voiced[t]) continue;
    const off = t * hopLen;
    let acf0 = 1e-8;
    for (let i = 0; i < frameLen; i++) acf0 += x[off + i] * x[off + i];
    let bestLag = minLag;
    let bestVal = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      const limit = frameLen - lag;
      for (let i = 0; i < limit; i++) sum += x[off + i] * x[off + i + lag];
      const norm = sum / acf0;
      if (norm > bestVal) {
        bestVal = norm;
        bestLag = lag;
      }
    }
    if (bestVal > 0.32) {
      periodic[t] = 1;
      const hz = sampleRate / bestLag;
      f0Hz[t] = hz;
      f0Semi[t] = 12 * Math.log2(Math.max(0.25, hz / 165.0));
    }
  }

  const responseLatency = clamp(firstVoiced / Math.max(1, T), 0, 1);
  let unvoicedAfterOnset = 0;
  let transitions = 0;
  for (let t = firstVoiced; t < T; t++) {
    if (!voiced[t]) unvoicedAfterOnset++;
    if (t > 0 && voiced[t] !== voiced[t - 1]) transitions++;
  }
  const activeSpan = Math.max(1, T - firstVoiced);
  const pauseRatio = clamp(unvoicedAfterOnset / activeSpan, 0, 1);
  const durationSec = Math.max(0.1, samples.length / sampleRate);
  const disfluencyRate = Math.tanh(transitions / (durationSec * 8.0));

  // “呃/嗯”填充停顿检测：连续 >=7 帧低过零率且基频平坦
  let filledFrames = 0;
  let run = 0;
  for (let t = 1; t < T; t++) {
    const flat = periodic[t] && zcr[t] < 0.12 && Math.abs(f0Semi[t] - f0Semi[t - 1]) < 0.45;
    run = flat ? run + 1 : 0;
    if (run >= 7) filledFrames++;
  }
  const filledPauseRatio = clamp(filledFrames / Math.max(1, T), 0, 1);

  // F0 均值、标准差、句末斜率与 Jitter
  const pIdx: number[] = [];
  for (let t = 0; t < T; t++) if (periodic[t]) pIdx.push(t);

  let f0MeanNorm = 0;
  let f0StdNorm = 0;
  let f0TerminalSlope = 0;
  let pitchJitter = 0;

  if (pIdx.length >= 3) {
    let m = 0;
    for (const idx of pIdx) m += f0Semi[idx];
    m /= pIdx.length;
    let v = 0;
    for (const idx of pIdx) v += (f0Semi[idx] - m) ** 2;
    f0MeanNorm = clamp(m / 12.0, -1.5, 1.5);
    f0StdNorm = clamp(Math.sqrt(v / pIdx.length) / 6.0, 0, 1.5);

    const tailK = Math.max(3, Math.ceil(pIdx.length * 0.25));
    const tail = pIdx.slice(-tailK).map((idx) => f0Semi[idx]);
    const tMean = tail.reduce((a, b) => a + b, 0) / tailK;
    let num = 0;
    let den = 1e-6;
    for (let i = 0; i < tailK; i++) {
      const tx = -1 + (2 * i) / Math.max(1, tailK - 1);
      num += tx * (tail[i] - tMean);
      den += tx * tx;
    }
    f0TerminalSlope = Math.tanh(num / den / 3.0);

    let jitSum = 0;
    for (let i = 1; i < pIdx.length; i++) {
      const prev = Math.max(40, f0Hz[pIdx[i - 1]]);
      jitSum += Math.abs(f0Hz[pIdx[i]] - f0Hz[pIdx[i - 1]]) / prev;
    }
    pitchJitter = Math.tanh((jitSum / (pIdx.length - 1)) * 18.0);
  }

  // Shimmer 与整句底气斜率
  const vIdx: number[] = [];
  for (let t = 0; t < T; t++) if (voiced[t]) vIdx.push(t);
  let amplitudeShimmer = 0;
  let energySlope = 0;
  if (vIdx.length >= 3) {
    let shim = 0;
    const le: number[] = [];
    for (let i = 0; i < vIdx.length; i++) {
      const a = rms[vIdx[i]];
      le.push(Math.log(a + 1e-6));
      if (i > 0) shim += Math.abs(a - rms[vIdx[i - 1]]) / Math.max(1e-6, rms[vIdx[i - 1]]);
    }
    amplitudeShimmer = Math.tanh((shim / (vIdx.length - 1)) * 4.0);
    const leMean = le.reduce((a, b) => a + b, 0) / le.length;
    let num = 0;
    let den = 1e-6;
    for (let i = 0; i < le.length; i++) {
      const tx = -1 + (2 * i) / Math.max(1, le.length - 1);
      num += tx * (le[i] - leMean);
      den += tx * tx;
    }
    energySlope = Math.tanh(num / den);
  }

  // 音节包络峰值语速
  let peaks = 0;
  for (let t = 2; t < T - 2; t++) {
    const c = (rms[t - 1] + rms[t] + rms[t + 1]) / 3;
    const l = (rms[t - 2] + rms[t - 1] + rms[t]) / 3;
    const r = (rms[t] + rms[t + 1] + rms[t + 2]) / 3;
    if (voiced[t] && c > l && c >= r) peaks++;
  }
  const speechRate = Math.tanh(peaks / durationSec / 6.0);
  const spectralTilt = Math.tanh(Math.log(Math.max(1e-6, highFreqAcc) / lowFreqAcc) / 4.0);

  const vector: ProsodyVector = [
    Number(responseLatency.toFixed(4)),
    Number(pauseRatio.toFixed(4)),
    Number(disfluencyRate.toFixed(4)),
    Number(filledPauseRatio.toFixed(4)),
    Number(f0MeanNorm.toFixed(4)),
    Number(f0StdNorm.toFixed(4)),
    Number(f0TerminalSlope.toFixed(4)),
    Number(pitchJitter.toFixed(4)),
    Number(amplitudeShimmer.toFixed(4)),
    Number(speechRate.toFixed(4)),
    Number(energySlope.toFixed(4)),
    Number(spectralTilt.toFixed(4)),
  ];

  const tension = clamp(
    0.25 * responseLatency + 0.3 * disfluencyRate + 0.25 * pitchJitter + 0.2 * Math.max(0, f0TerminalSlope),
    0,
    1,
  );

  let cueLabel = "语调平稳笃定";
  if (disfluencyRate > 0.42 || filledPauseRatio > 0.16) {
    cueLabel = "说话断续卡壳 · 夹带犹豫停顿";
  } else if (f0TerminalSlope > 0.22 && pitchJitter > 0.25) {
    cueLabel = "尾音上扬发飘 · 声带微颤心虚";
  } else if (f0TerminalSlope < -0.2 && energySlope >= -0.15) {
    cueLabel = "尾音下沉坚定 · 底气充足";
  } else if (energySlope < -0.3) {
    cueLabel = "句末声音渐弱 · 底气回落";
  }

  return { vector, cueLabel, tension, noiseFloorRms, noiseDb, noisy };
}
