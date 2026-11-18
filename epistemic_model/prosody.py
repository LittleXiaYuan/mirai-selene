"""Paralinguistic acoustic feature extractor (Interspeech eGeMAPS-aligned).

Standard ASR pipelines discard disfluencies, pauses, pitch contours, and vocal
micro-tremors by collapsing speech into plain text tokens. In high-stakes human
deliberation, *how* someone speaks carries orthogonal epistemic evidence to
*what* they claim.

This module extracts a 12-dimensional, physically interpretable paralinguistic
vector directly from raw mono waveforms ``[B, N]`` using pure PyTorch ops
(CPU/CUDA compatible, zero external audio binaries required, and 1-to-1
mirrorable in browser WebAudio):

Index  Name                   Acoustic / Behavioral Meaning
-----  ---------------------  -------------------------------------------------
  0    response_latency       Fraction of leading silence before first voiced frame
  1    pause_ratio            Overall unvoiced / silent frame ratio
  2    disfluency_rate        Voiced-unvoiced stuttering transition rate ("我…我…")
  3    filled_pause_ratio     Sustained low-ZCR flat-pitch vocalization ("呃…嗯…啊…")
  4    f0_mean_norm           Normalized log fundamental frequency mean
  5    f0_std_norm            Log-F0 standard deviation (intonation range)
  6    f0_terminal_slope      Linear F0 slope over final 25% voiced frames
                              (>0 rising/uncertain/probing, <0 falling/resolute/low)
  7    pitch_jitter           Cycle-to-cycle relative F0 perturbation (vocal tension)
  8    amplitude_shimmer      Frame-to-frame relative amplitude perturbation
  9    speech_rate            Normalized syllable-envelope modulation rate
 10    energy_slope           Utterance-wide log-energy trajectory slope (fading vs firm)
 11    spectral_tilt          High-to-low frequency energy log-ratio (tense vs lax voice)
"""

from __future__ import annotations

import math
import torch
import torch.nn as nn
import torch.nn.functional as F

PARALINGUISTIC_DIM = 12

PARALINGUISTIC_FEATURE_NAMES: tuple[str, ...] = (
    "response_latency",
    "pause_ratio",
    "disfluency_rate",
    "filled_pause_ratio",
    "f0_mean_norm",
    "f0_std_norm",
    "f0_terminal_slope",
    "pitch_jitter",
    "amplitude_shimmer",
    "speech_rate",
    "energy_slope",
    "spectral_tilt",
)


class ParalinguisticExtractor(nn.Module):
    """Pure-PyTorch vectorized acoustic prosody & disfluency extractor."""

    def __init__(
        self,
        sample_rate: int = 16000,
        frame_ms: float = 25.0,
        hop_ms: float = 10.0,
        f0_min: float = 70.0,
        f0_max: float = 400.0,
    ) -> None:
        super().__init__()
        self.sample_rate = int(sample_rate)
        self.frame_len = max(64, int(round(sample_rate * frame_ms / 1000.0)))
        self.hop_len = max(16, int(round(sample_rate * hop_ms / 1000.0)))
        self.min_lag = max(2, int(sample_rate / f0_max))
        self.max_lag = min(self.frame_len - 2, int(sample_rate / f0_min))
        self.register_buffer("window", torch.hann_window(self.frame_len), persistent=False)

    @torch.no_grad()
    def forward(self, waveform: torch.Tensor) -> torch.Tensor:
        """Extract 12-D normalized prosody features from ``waveform [B, N]`` or ``[N]``."""
        squeeze = False
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0)
            squeeze = True
        if waveform.dim() != 2:
            raise ValueError(f"expected waveform [B, N] or [N], got {tuple(waveform.shape)}")

        x = waveform.float()
        B, N = x.shape
        if N < self.frame_len * 2:
            x = F.pad(x, (0, self.frame_len * 2 - N))
            N = x.shape[1]

        # Remove DC offset and normalize peak per utterance to isolate prosody from mic gain
        x = x - x.mean(dim=-1, keepdim=True)
        peak = x.abs().amax(dim=-1, keepdim=True).clamp_min(1e-5)
        x = x / peak

        # Frame into [B, T, L]
        frames = x.unfold(dimension=-1, size=self.frame_len, step=self.hop_len)
        B, T, L = frames.shape
        eps = 1e-6

        # 1. Frame RMS energy & adaptive voicing mask
        rms = frames.pow(2).mean(dim=-1).add(eps).sqrt()  # [B, T]
        log_energy = torch.log(rms + eps)
        # Adaptive threshold relative to 90th-percentile frame energy
        hi_energy = torch.quantile(rms, 0.90, dim=-1, keepdim=True).clamp_min(1e-3)
        voiced = rms > (0.14 * hi_energy)  # [B, T] bool

        # Zero-crossing rate per frame
        signs = torch.sign(frames)
        zcr = (signs[:, :, 1:] * signs[:, :, :-1] < 0).float().mean(dim=-1)  # [B, T]

        # [0] Response latency: index of first voiced frame / T
        t_idx = torch.arange(T, device=x.device).unsqueeze(0).expand(B, T)
        first_voiced = torch.where(voiced, t_idx, torch.full_like(t_idx, T)).amin(dim=-1).float()
        response_latency = (first_voiced / float(max(1, T))).clamp(0.0, 1.0)

        # [1] Overall pause ratio (after speech onset to avoid double-counting leading silence)
        active_span = (t_idx >= first_voiced.unsqueeze(-1).long())
        span_len = active_span.float().sum(dim=-1).clamp_min(1.0)
        pause_ratio = ((~voiced & active_span).float().sum(dim=-1) / span_len).clamp(0.0, 1.0)

        # [2] Disfluency / stutter transition rate: voiced <-> unvoiced switches per second
        transitions = (voiced[:, 1:] ^ voiced[:, :-1]).float().sum(dim=-1)
        duration_sec = max(0.1, float(N) / float(self.sample_rate))
        # Normalize: ~8 transitions/sec maps near 1.0
        disfluency_rate = torch.tanh(transitions / (duration_sec * 8.0))

        # 2. Autocorrelation pitch (F0) estimation via Wiener-Khinchin FFT
        win_frames = frames * self.window.to(frames.device)
        n_fft = 1 << (2 * L - 1).bit_length()
        spec = torch.fft.rfft(win_frames, n=n_fft, dim=-1)
        power = spec.real.pow(2) + spec.imag.pow(2)
        acf = torch.fft.irfft(power, n=n_fft, dim=-1)[:, :, :L]
        acf0 = acf[:, :, :1].clamp_min(eps)
        acf_norm = acf / acf0

        lag_slice = acf_norm[:, :, self.min_lag : self.max_lag + 1]
        peak_val, peak_rel = lag_slice.max(dim=-1)
        lags = (peak_rel + self.min_lag).float()
        f0_hz = float(self.sample_rate) / lags.clamp_min(1.0)
        periodic = voiced & (peak_val > 0.32)

        # Log-F0 in semitones relative to 165 Hz neutral reference
        f0_semi = 12.0 * torch.log2((f0_hz / 165.0).clamp_min(0.25))  # roughly [-18, +18]

        # [3] Filled-pause ("呃/嗯/啊"): voiced + periodic + low ZCR + locally flat F0
        f0_diff_abs = F.pad((f0_semi[:, 1:] - f0_semi[:, :-1]).abs(), (1, 0), value=0.0)
        filled_mask = periodic & (zcr < 0.12) & (f0_diff_abs < 0.45)
        # Require run-length >= 8 frames (~80ms) via 1D avg pooling
        filled_runs = F.avg_pool1d(
            filled_mask.float().unsqueeze(1), kernel_size=7, stride=1, padding=3
        ).squeeze(1) > 0.75
        filled_pause_ratio = (filled_runs.float().sum(dim=-1) / float(T)).clamp(0.0, 1.0)

        # Masked F0 statistics per batch item
        f0_mean_norm = torch.zeros(B, device=x.device)
        f0_std_norm = torch.zeros(B, device=x.device)
        f0_terminal_slope = torch.zeros(B, device=x.device)
        pitch_jitter = torch.zeros(B, device=x.device)
        amplitude_shimmer = torch.zeros(B, device=x.device)
        energy_slope = torch.zeros(B, device=x.device)

        for b in range(B):
            p_idx = torch.nonzero(periodic[b], as_tuple=False).squeeze(-1)
            if p_idx.numel() >= 3:
                vals = f0_semi[b, p_idx]
                f0_mean_norm[b] = (vals.mean() / 12.0).clamp(-1.5, 1.5)
                f0_std_norm[b] = (vals.std(unbiased=False) / 6.0).clamp(0.0, 1.5)

                # [6] Terminal F0 slope over final 25% periodic frames (rising vs falling)
                tail_k = max(3, int(math.ceil(p_idx.numel() * 0.25)))
                tail_vals = vals[-tail_k:]
                t_axis = torch.linspace(-1.0, 1.0, tail_k, device=x.device)
                slope = (t_axis * (tail_vals - tail_vals.mean())).sum() / (t_axis.pow(2).sum() + eps)
                f0_terminal_slope[b] = torch.tanh(slope / 3.0)

                # [7] Jitter: adjacent periodic frames relative F0 perturbation
                hz_vals = f0_hz[b, p_idx]
                rel_df0 = (hz_vals[1:] - hz_vals[:-1]).abs() / hz_vals[:-1].clamp_min(40.0)
                pitch_jitter[b] = torch.tanh(rel_df0.mean() * 18.0)

            v_idx = torch.nonzero(voiced[b], as_tuple=False).squeeze(-1)
            if v_idx.numel() >= 3:
                amp = rms[b, v_idx]
                # [8] Shimmer: adjacent voiced frames amplitude perturbation
                rel_damp = (amp[1:] - amp[:-1]).abs() / amp[:-1].clamp_min(eps)
                amplitude_shimmer[b] = torch.tanh(rel_damp.mean() * 4.0)

                # [10] Utterance-wide energy slope (trailing off vs holding ground)
                le = log_energy[b, v_idx]
                t_ax = torch.linspace(-1.0, 1.0, v_idx.numel(), device=x.device)
                e_slp = (t_ax * (le - le.mean())).sum() / (t_ax.pow(2).sum() + eps)
                energy_slope[b] = torch.tanh(e_slp)

        # [9] Speech rate: syllable-rate envelope peaks (smoothed RMS local maxima in voiced regions)
        smooth_rms = F.avg_pool1d(rms.unsqueeze(1), kernel_size=9, stride=1, padding=4).squeeze(1)
        if T >= 3:
            peaks = (
                (smooth_rms[:, 1:-1] > smooth_rms[:, :-2])
                & (smooth_rms[:, 1:-1] >= smooth_rms[:, 2:])
                & voiced[:, 1:-1]
            )
            syllables_per_sec = peaks.float().sum(dim=-1) / duration_sec
        else:
            syllables_per_sec = torch.zeros(B, device=x.device)
        speech_rate = torch.tanh(syllables_per_sec / 6.0)

        # [11] Spectral tilt: log ratio of high-band (>1.5kHz) to low-band (<1.5kHz) power
        freqs = torch.fft.rfftfreq(n_fft, d=1.0 / float(self.sample_rate), device=x.device)
        low_mask = (freqs >= 80.0) & (freqs < 1500.0)
        high_mask = (freqs >= 1500.0) & (freqs <= 6000.0)
        v_weight = voiced.float().unsqueeze(-1) + 1e-3
        low_e = (power[:, :, low_mask] * v_weight).sum(dim=(1, 2)).clamp_min(eps)
        high_e = (power[:, :, high_mask] * v_weight).sum(dim=(1, 2)).clamp_min(eps)
        spectral_tilt = torch.tanh(torch.log(high_e / low_e) / 4.0)

        out = torch.stack(
            (
                response_latency,
                pause_ratio,
                disfluency_rate,
                filled_pause_ratio,
                f0_mean_norm,
                f0_std_norm,
                f0_terminal_slope,
                pitch_jitter,
                amplitude_shimmer,
                speech_rate,
                energy_slope,
                spectral_tilt,
            ),
            dim=-1,
        )
        return out.squeeze(0) if squeeze else out


def synthesize_prosody_waveforms(sample_rate: int = 16000, duration: float = 2.0) -> dict[str, torch.Tensor]:
    """Generate deterministic acoustic archetypes for unit tests & calibration.

    Returns three waveforms with identical semantic duration but distinct
    paralinguistic signatures:
      - ``resolute_falling``: prompt onset, steady F0 with falling terminal contour, low jitter
      - ``nervous_hesitant``: long leading latency, repeated stutter gaps, filled pause,
                              vocal jitter/tremor, and rising terminal F0 ("呃…我…没问题吧？")
      - ``low_suppressed``:   low F0, trailing energy decay, long pauses
    """
    n = int(sample_rate * duration)
    t = torch.linspace(0.0, duration, n)

    # 1. Resolute & falling F0 (190 Hz -> 130 Hz, immediate onset, firm amplitude)
    f0_res = torch.linspace(190.0, 130.0, n)
    phase_res = 2.0 * math.pi * torch.cumsum(f0_res / sample_rate, dim=0)
    env_res = torch.ones_like(t)
    env_res[: int(0.04 * sample_rate)] = 0.0  # tiny 40ms onset
    syll_mod = 0.75 + 0.25 * torch.sin(2.0 * math.pi * 4.2 * t)
    w_resolute = env_res * syll_mod * (
        0.7 * torch.sin(phase_res) + 0.25 * torch.sin(2 * phase_res) + 0.1 * torch.sin(3 * phase_res)
    )

    # 2. Nervous hesitant: 0.45s latency + filled "呃" flat tone + stutter chopped bursts + jitter + rising tail
    jitter_noise = 8.5 * torch.sin(2.0 * math.pi * 23.0 * t) + 5.0 * torch.sin(2.0 * math.pi * 37.0 * t)
    f0_nerv = torch.full_like(t, 175.0) + jitter_noise
    tail_start = int(0.70 * n)
    f0_nerv[tail_start:] = torch.linspace(180.0, 285.0, n - tail_start) + jitter_noise[tail_start:]
    phase_nerv = 2.0 * math.pi * torch.cumsum(f0_nerv / sample_rate, dim=0)
    env_nerv = torch.zeros_like(t)
    # 0.45s - 0.75s: flat filled pause "呃..."
    env_nerv[int(0.45 * sample_rate) : int(0.75 * sample_rate)] = 0.65
    # 0.85s - 1.95s: choppy stuttered bursts ("我…我…真没…")
    for seg_s in (0.86, 1.04, 1.22, 1.42, 1.62, 1.78):
        s0 = int(seg_s * sample_rate)
        s1 = min(n, s0 + int(0.09 * sample_rate))
        env_nerv[s0:s1] = 0.85 * (1.0 + 0.32 * torch.sin(2.0 * math.pi * 19.0 * t[s0:s1]))
    w_nervous = env_nerv * (
        0.55 * torch.sin(phase_nerv) + 0.35 * torch.sin(3 * phase_nerv) + 0.25 * torch.sin(5 * phase_nerv)
    )

    # 3. Low suppressed: low pitch (110 Hz), slow, decaying energy
    f0_low = torch.linspace(118.0, 98.0, n)
    phase_low = 2.0 * math.pi * torch.cumsum(f0_low / sample_rate, dim=0)
    env_low = torch.exp(-1.4 * t)
    env_low[: int(0.25 * sample_rate)] = 0.0
    env_low[int(0.95 * sample_rate) : int(1.30 * sample_rate)] = 0.0
    w_low = env_low * (0.85 * torch.sin(phase_low) + 0.12 * torch.sin(2 * phase_low))

    return {
        "resolute_falling": w_resolute,
        "nervous_hesitant": w_nervous,
        "low_suppressed": w_low,
    }
