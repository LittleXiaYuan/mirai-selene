"""PAI-SSM cluster training & 3-arm ablation (DeepSpeed ZeRO-2 + BF16).

This script builds the complete training framework around the frozen math core
(``architecture.py`` / ``prosody.py``):

  * **Ambiguous multi-turn data** (Block 1/2): config-driven ``EpisodeArchetype``
    episodes share marginal stress across latent classes; only the temporal
    drift under challenge disambiguates them, so evidence accumulation through
    the information-filter state is required. Text-only gaps are learnable,
    not guaranteed.
  * **One-shot future-field objective** (Block 3): the same stakes head used by
    ``project_future_field`` is supervised on every position against per-turn
    evidence-resolution targets (pinball + hazard-structured ruin BCE).
  * **Closed-loop probe policy** (Block 4): learnable aspect directions are
    ranked by EIG x stakes; ask->answer->update is simulated with a
    stakes-weighted ranking loss toward the true latent archetype.
  * **L2 paged memory** (Block 5): optional persistent product-key page table
    (turn-end writes, pointer reads, O(1) CoW worldline fork).

Arms (matched parameters):
  1. ``asr_text_only`` : prosody=None (text/ASR-only baseline)
  2. ``naive_prosody`` : prosody encoder output added to hidden states with a
                         constant gate and zero incongruence (rough fusion baseline)
  3. ``pai_ssm_full``  : full incongruence gate + information-filter state
                         (+ paged memory when --paged-memory is set)

Usage:
  torchrun --nproc_per_node=4 -m epistemic_model.train_l20 \
      --preset large_600m --steps 3000 --ablation --bf16 --deepspeed --paged-memory
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, replace
import json
import math
import os
from pathlib import Path
import time
import types

import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F
from torch.nn.parallel import DistributedDataParallel as DDP

from .architecture import (
    QUANTILE_LEVELS,
    EpistemicConfig,
    EpistemicWorldlineModel,
    InformationFilterState,
    batched_epistemic_eig,
    batched_filter_observe,
    pinball_quantile_loss,
)
from .prosody import PARALINGUISTIC_DIM


PRESETS: dict[str, EpistemicConfig] = {
    "smoke": EpistemicConfig(vocab_size=2048, d_model=128, n_layer=4, n_head=4, d_state=16),
    "ablation_120m": EpistemicConfig(vocab_size=16384, d_model=768, n_layer=12, n_head=12, d_state=32),
    "base_350m": EpistemicConfig(vocab_size=32000, d_model=1024, n_layer=20, n_head=16, d_state=32),
    "large_600m": EpistemicConfig(vocab_size=32000, d_model=1280, n_layer=24, n_head=20, d_state=32),
    "large_1b": EpistemicConfig(vocab_size=32000, d_model=1792, n_layer=30, n_head=28, d_state=32),
    "large_2b": EpistemicConfig(vocab_size=32000, d_model=2560, n_layer=32, n_head=32, d_state=32),
}

# (name, stance, confident_words, stress, payoff_mu, payoff_sd, ruin, marker_token)
@dataclass(frozen=True)
class EpisodeArchetype:
    """Latent episode class driving a multi-turn dialogue.

    Deliberate ambiguity design: the *marginal* stress level is shared across
    archetypes (e.g. ``honest_anxious`` vs ``bluff_overclaim`` both live at
    stress ~0.65), so single-turn observation cannot separate them. The
    disambiguating fingerprint is the *temporal drift* under challenge: bluffs
    escalate, honest-anxious speakers de-escalate, pressured probes decay.
    Multi-turn evidence accumulation through the information-filter state is
    therefore required — text-only and naive-prosody gaps are learnable, not
    guaranteed.
    """

    name: str
    stance: int                    # target stance label
    stress_mu: float               # marginal stress (SHARED across archetypes)
    stress_drift: float            # per-turn stress slope after the challenge turn
    challenge_spike: float         # instantaneous stress jump/dip at the challenge
    confident_bias: float          # P(confident wording) per claim slot (weak text cue)
    marker_token: int              # sparse explicit text marker (0 = none)
    comp_mus: tuple[float, float]  # bimodal payoff mixture component means
    comp_sds: tuple[float, float]
    comp_weights: tuple[float, float]
    comp_ruins: tuple[float, float]
    reveal_rate: float             # evidence-resolution speed per turn (future field)


EPISODE_ARCHETYPES: tuple[EpisodeArchetype, ...] = (
    # honest but calm: low stress, no drift (text-distinguishable from neutral by low confidence)
    EpisodeArchetype("honest_calm", 0, 0.15, 0.000, 0.00, 0.35, 0, (3.5, 2.8), (1.6, 1.4), (0.6, 0.4), (0.10, 0.12), 0.60),
    # honest but nervous: HIGH stress flat, de-escalates when challenged. Ambiguous with bluff on marginal stress!
    EpisodeArchetype("honest_anxious", 0, 0.65, -0.012, -0.10, 0.45, 0, (2.5, 1.8), (1.7, 1.5), (0.6, 0.4), (0.15, 0.18), 0.65),
    # neutral factual: calm + confident words (text-only arm can learn this one)
    EpisodeArchetype("neutral_factual", 1, 0.15, 0.000, 0.00, 0.80, 0, (7.0, 6.2), (2.0, 1.8), (0.6, 0.4), (0.04, 0.06), 0.70),
    # pressured blind spot: high stress decaying as they explain; genuinely bimodal payoff
    EpisodeArchetype("pressured_probe", 2, 0.68, -0.014, -0.10, 0.40, 4, (-2.0, 6.5), (3.0, 2.5), (0.5, 0.5), (0.40, 0.08), 0.45),
    # bluff / overclaim: SAME marginal stress as honest_anxious but escalates under challenge
    EpisodeArchetype("bluff_overclaim", 3, 0.65, 0.014, 0.15, 0.55, 0, (-9.0, -4.0), (2.0, 2.5), (0.65, 0.35), (0.90, 0.55), 0.35),
    # counter overreach: medium stress, mild escalation, big upside component
    EpisodeArchetype("counter_overreach", 4, 0.42, 0.008, 0.05, 0.60, 1, (8.5, 3.0), (3.0, 2.8), (0.6, 0.4), (0.25, 0.10), 0.55),
    # rupture red line: extreme stress + explicit marker + catastrophic component
    EpisodeArchetype("rupture_redline", 5, 0.90, 0.012, 0.10, 0.50, 5, (-12.0, -9.0), (2.2, 2.4), (0.6, 0.4), (0.98, 0.94), 0.85),
    # confident bluff: verbally CERTAIN words + nervous trembling voice (verbal-vocal
    # incongruence). Naive fusion must fight strong literal text; the full gate
    # attenuates the literal claim by construction — this is Block 2's load-bearing case.
    EpisodeArchetype("confident_bluff", 3, 0.70, 0.012, 0.15, 0.85, 0, (-8.5, -3.5), (2.2, 2.6), (0.65, 0.35), (0.88, 0.50), 0.35),
)
N_ARCHETYPES = len(EPISODE_ARCHETYPES)
ARCHETYPE_NAMES = tuple(a.name for a in EPISODE_ARCHETYPES)


def check_merge3_consistency(cfg: EpistemicConfig, step: int, tol: float = 1e-15) -> dict[str, float]:
    """Compare merge3(S_a, S_b, S_base) with full sequential replay in float64."""
    device = torch.device("cpu")
    H, d = cfg.n_head, cfg.d_state
    gen = torch.Generator(device=device).manual_seed(1000 + step)

    def sample(n: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        k = F.normalize(torch.randn(n, H, d, generator=gen, device=device, dtype=torch.float64), dim=-1)
        v = torch.randn(n, H, d, generator=gen, device=device, dtype=torch.float64)
        g = torch.rand(n, H, generator=gen, device=device, dtype=torch.float64) + 0.2
        return k, v, g

    k0, v0, g0 = sample(8)
    ka, va, ga = sample(11)
    kb, vb, gb = sample(9)

    prior = InformationFilterState.prior(H, d, lam=cfg.prior_lam, device=device, dtype=torch.float64)
    base = prior.observe(k0, v0, g0)
    branch_a = base.observe(ka, va, ga)
    branch_b = base.observe(kb, vb, gb)

    merged = branch_a.merge3(branch_b, base)
    merged_rev = branch_b.merge3(branch_a, base)
    replay = prior.observe(
        torch.cat([k0, ka, kb], dim=0),
        torch.cat([v0, va, vb], dim=0),
        torch.cat([g0, ga, gb], dim=0),
    )

    err_a = (merged.A - replay.A).abs().max().item()
    err_b = (merged.B - replay.B).abs().max().item()
    err_inc = (merged.incongruence_mass - replay.incongruence_mass).abs().max().item()
    err_cnt = (merged.obs_count - replay.obs_count).abs().max().item()
    comm = max(
        (merged.A - merged_rev.A).abs().max().item(),
        (merged.B - merged_rev.B).abs().max().item(),
    )
    rel_err = ((merged.A - replay.A).norm().item() + (merged.B - replay.B).norm().item()) / max(
        1e-30, replay.A.norm().item() + replay.B.norm().item()
    )
    cnt_rel = err_cnt / max(1.0, abs(replay.obs_count.item()))
    if rel_err > tol or cnt_rel > tol:
        raise RuntimeError(
            f"merge3 consistency violated at step {step}: rel_err={rel_err:.3e}, "
            f"cnt_rel={cnt_rel:.3e} > {tol:.1e} "
            f"(A={err_a:.3e}, B={err_b:.3e}, inc={err_inc:.3e}, cnt={err_cnt:.3e})"
        )
    return {
        "merge3_max_abs_err": max(err_a, err_b, err_inc, comm, err_cnt),
        "merge3_rel_err": rel_err,
        "merge3_cnt_rel_err": cnt_rel,
        "merge3_A_err": err_a,
        "merge3_B_err": err_b,
        "merge3_comm_err": comm,
    }


def assert_no_softmax(model: nn.Module) -> None:
    forbidden = (nn.Softmax, nn.LogSoftmax, nn.Softmax2d)
    for name, mod in model.named_modules():
        if isinstance(mod, forbidden):
            raise RuntimeError(f"forbidden softmax module detected at {name}")


def install_naive_prosody_gate(model: EpistemicWorldlineModel) -> None:
    """Naive arm: add encoded prosody, constant gate, zero incongruence.

    This is a *training-script* wrapper over the frozen architecture.  It uses the
    existing prosody encoder parameters but removes heteroscedastic precision gating
    and the incongruence signal, isolating their contribution in the ablation.
    """
    gate = model.prosody_gate
    heads = gate.to_precision.out_features

    def naive_forward(self, h: torch.Tensor, prosody: torch.Tensor | None = None):
        b, t, _ = h.shape
        if prosody is None:
            return h, torch.ones(b, t, heads, device=h.device, dtype=h.dtype), torch.zeros(
                b, t, 1, device=h.device, dtype=h.dtype
            )
        p = prosody.to(device=h.device, dtype=h.dtype)
        if p.dim() == 2:
            p = p.unsqueeze(1).expand(b, t, -1)
        p_emb = self.prosody_enc(p)
        return (
            h + p_emb,
            torch.ones(b, t, heads, device=h.device, dtype=h.dtype),
            torch.zeros(b, t, 1, device=h.device, dtype=h.dtype),
        )

    gate.forward = types.MethodType(naive_forward, gate)


def install_constant_prosody_gate(model: EpistemicWorldlineModel) -> None:
    """Block 2 ablation: ignore prosody entirely (constant precision, zero incongruence).

    Unlike the text-only arm this keeps the prosody encoder parameters in the
    graph-free model but never lets them influence the block, isolating the
    value of prosody *modulation* from the value of the prosody *features*.
    """
    gate = model.prosody_gate
    heads = gate.to_precision.out_features

    def const_forward(self, h: torch.Tensor, prosody: torch.Tensor | None = None):
        b, t, _ = h.shape
        return (
            h,
            torch.ones(b, t, heads, device=h.device, dtype=h.dtype),
            torch.zeros(b, t, 1, device=h.device, dtype=h.dtype),
        )

    gate.forward = types.MethodType(const_forward, gate)


def generate_high_pressure_batch(
    batch_size: int,
    seq_len: int,
    vocab_size: int,
    device: torch.device,
    generator: torch.Generator,
) -> dict[str, torch.Tensor]:
    """Multi-turn ambiguous episode batch with evidence-accumulation targets.

    Each sequence position is one dialogue turn. A latent ``EpisodeArchetype``
    per sample fixes: (i) the stress level/drift fingerprint, (ii) weak
    per-turn text confidence, (iii) a bimodal payoff mixture, (iv) per-turn
    evidence-resolution targets used to train the one-shot future field.

    Returns keys: ``input_ids``, ``target_ids``, ``prosody`` [B,T,P],
    ``payoff``, ``ruin``, ``stance``, ``latent`` (archetype id),
    ``payoff_evidence`` [B,T], ``ruin_evidence`` [B,T].
    """
    b, T = batch_size, seq_len
    tc = T // 2  # challenge turn index
    t_pos = torch.arange(T, device=device, dtype=torch.float32)

    arch = torch.randint(0, N_ARCHETYPES, (b,), generator=generator, device=device)
    A = EPISODE_ARCHETYPES
    mu = torch.tensor([a.stress_mu for a in A], device=device)[arch]
    drift = torch.tensor([a.stress_drift for a in A], device=device)[arch]
    spike = torch.tensor([a.challenge_spike for a in A], device=device)[arch]
    conf = torch.tensor([a.confident_bias for a in A], device=device)[arch]
    reveal = torch.tensor([a.reveal_rate for a in A], device=device)[arch]

    # --- per-turn latent stress: shared marginals, disambiguating drift -------
    post = (t_pos - tc).clamp_min(0.0)
    stress_t = (
        mu.unsqueeze(-1)
        + drift.unsqueeze(-1) * post.unsqueeze(0)
        + spike.unsqueeze(-1) * (t_pos == tc).float().unsqueeze(0)
    )
    stress_t = (stress_t + torch.randn(b, T, generator=generator, device=device) * 0.05).clamp(0.0, 1.0)

    # --- 12-D prosody per turn from the shared stress->acoustics map ----------
    prosody = torch.randn(b, T, PARALINGUISTIC_DIM, generator=generator, device=device) * 0.07
    s = stress_t.unsqueeze(-1)
    prosody[..., 0] += 0.04 + 0.80 * s[..., 0]   # response latency
    prosody[..., 1] += 0.03 + 0.62 * s[..., 0]   # pause ratio
    prosody[..., 2] += 0.04 + 0.90 * s[..., 0]   # disfluency
    prosody[..., 3] += 0.02 + 0.70 * s[..., 0]   # filled pauses
    prosody[..., 4] += -0.10 + 0.25 * s[..., 0]  # F0 mean
    prosody[..., 5] += 0.08 + 0.55 * s[..., 0]   # F0 std
    prosody[..., 6] += -0.50 + 1.20 * s[..., 0]  # terminal slope (rising under stress)
    prosody[..., 7] += 0.05 + 0.80 * s[..., 0]   # jitter
    prosody[..., 8] += 0.05 + 0.70 * s[..., 0]   # shimmer
    prosody[..., 9] += 1.10 - 0.55 * s[..., 0]   # speech rate
    prosody[..., 10] += 0.10 - 0.55 * s[..., 0]  # energy slope
    prosody[..., 11] += -0.20 - 0.60 * s[..., 0] # spectral tilt

    # --- text: weak per-turn confidence + sparse markers ----------------------
    base_tokens = torch.randint(16, vocab_size, (b, T), generator=generator, device=device)
    claim_rand = torch.rand(b, 3, generator=generator, device=device) < conf.unsqueeze(-1)
    claim_tok = torch.where(claim_rand, torch.tensor(4, device=device), torch.tensor(8, device=device))
    base_tokens[:, tc : tc + 3] = claim_tok
    for idx, a in enumerate(A):
        if a.marker_token:
            base_tokens[arch == idx, tc - 1] = a.marker_token

    # --- bimodal payoff mixture & ruin ---------------------------------------
    w = torch.tensor([a.comp_weights[0] for a in A], device=device)[arch]
    mu0 = torch.tensor([a.comp_mus[0] for a in A], device=device)[arch]
    mu1 = torch.tensor([a.comp_mus[1] for a in A], device=device)[arch]
    sd0 = torch.tensor([a.comp_sds[0] for a in A], device=device)[arch]
    sd1 = torch.tensor([a.comp_sds[1] for a in A], device=device)[arch]
    r0 = torch.tensor([a.comp_ruins[0] for a in A], device=device)[arch]
    r1 = torch.tensor([a.comp_ruins[1] for a in A], device=device)[arch]

    comp0 = torch.bernoulli(w, generator=generator).bool()  # True -> component 0
    noise0 = torch.randn(b, generator=generator, device=device)
    payoff = torch.where(comp0, mu0 + sd0 * noise0, mu1 + sd1 * noise0)
    ruin_c = torch.where(comp0, r0, r1)
    ruin = (ruin_c + torch.randn(b, generator=generator, device=device) * 0.015).clamp(0.0, 1.0)
    stance = torch.tensor([a.stance for a in A], device=device, dtype=torch.long)[arch]

    # --- per-turn evidence-resolution targets (future-field supervision) ------
    p_resolve = (reveal.unsqueeze(-1) * (t_pos + 1.0) / 8.0).clamp(max=1.0)  # [B,T]
    resolved = torch.rand(b, T, generator=generator, device=device) < p_resolve
    comp_resampled = torch.bernoulli(w.unsqueeze(-1).expand(b, T), generator=generator).bool()
    use0 = torch.where(resolved, comp0.unsqueeze(-1).expand(b, T), comp_resampled)
    noise_ev = torch.randn(b, T, generator=generator, device=device)
    payoff_evidence = torch.where(use0, mu0.unsqueeze(-1) + sd0.unsqueeze(-1) * noise_ev,
                                  mu1.unsqueeze(-1) + sd1.unsqueeze(-1) * noise_ev)
    ruin_mix = w * r0 + (1.0 - w) * r1
    ruin_evidence = torch.where(
        resolved, ruin_c.unsqueeze(-1).expand(b, T), ruin_mix.unsqueeze(-1).expand(b, T)
    )

    return {
        "input_ids": base_tokens[:, :-1],
        "target_ids": base_tokens[:, 1:],
        "prosody": prosody[:, :-1],
        "payoff": payoff,
        "ruin": ruin,
        "stance": stance,
        "latent": arch,
        "payoff_evidence": payoff_evidence[:, :-1],
        "ruin_evidence": ruin_evidence[:, :-1],
    }


@torch.no_grad()
def conformal_offsets(
    calib_quantiles: torch.Tensor, calib_target: torch.Tensor
) -> torch.Tensor:
    """Split-conformal offset per quantile level (exact marginal coverage)."""
    residuals = calib_target.unsqueeze(-1) - calib_quantiles  # [N, 5]
    levels = torch.tensor(QUANTILE_LEVELS, device=residuals.device, dtype=residuals.dtype)
    q = torch.quantile(residuals, levels, dim=0)             # [5, 5]
    return torch.diagonal(q)                                 # offset per level [5]


@torch.no_grad()
def evaluate_arm(
    model: EpistemicWorldlineModel,
    arm: str,
    cfg: EpistemicConfig,
    *,
    batch_size: int,
    seq_len: int,
    device: torch.device,
    eval_batches: int,
    seed: int = 99991,
    page_table=None,
    memory_warmup: bool = False,
    per_sample_state: bool = False,
) -> dict[str, float]:
    model.eval()
    gen = torch.Generator(device=device).manual_seed(seed)
    correct = 0
    total = 0
    pinball = 0.0
    ruin_brier = 0.0
    ruin_mae = 0.0
    ruin_pred_sum = 0.0
    ruin_target_sum = 0.0
    crossings = 0
    min_gap = float("inf")
    field_pinball = 0.0
    probe_rank_sum = 0.0
    inc_sum = 0.0
    epi_var_sum = 0.0
    arch_correct = torch.zeros(N_ARCHETYPES, device=device)
    arch_total = torch.zeros(N_ARCHETYPES, device=device)
    all_q: list[torch.Tensor] = []
    all_y: list[torch.Tensor] = []

    for _ in range(eval_batches):
        batch = generate_high_pressure_batch(batch_size, seq_len, cfg.vocab_size, device, gen)
        prosody = None if arm == "asr_text_only" else batch["prosody"]
        seg_start = 0
        if memory_warmup and seq_len >= 8:
            cut = seq_len // 2
            with torch.no_grad():
                warm_state = (
                    model.init_batched_world_state(batch_size, device)
                    if per_sample_state
                    else None
                )
                warm = model(
                    batch["input_ids"][:, :cut],
                    prosody=None if prosody is None else prosody[:, :cut],
                    world_state=warm_state,
                    update_state=True,
                    page_table=page_table,
                    collect_kv=False,
                )
            out = model(
                batch["input_ids"][:, cut:],
                prosody=None if prosody is None else prosody[:, cut:],
                world_state=warm["world_state"],
                update_state=False,
                page_table=page_table,
                collect_kv=True,
            )
            seg_start = cut
        else:
            out = model(
                batch["input_ids"], prosody=prosody, update_state=False, page_table=page_table,
                collect_kv=True,
            )
        preds = out["stance_logits"].argmax(dim=-1)
        inc_sum += float(out["incongruence"].float().mean().item())
        epi_var_sum += float(out["epistemic_var"].float().mean().item())
        match = (preds == batch["stance"]).float()
        correct += int(match.sum().item())
        total += batch["stance"].numel()
        arch_correct.scatter_add_(0, batch["latent"], match)
        arch_total.scatter_add_(0, batch["latent"], torch.ones_like(match))
        q_pred = out["quantiles"].float()
        pinball += float(pinball_quantile_loss(q_pred, batch["payoff"].float()).item())
        ruin_pred = out["ruin_prob"].float()
        ruin_brier += float((ruin_pred - batch["ruin"].float()).pow(2).mean().item())
        ruin_mae += float((ruin_pred - batch["ruin"].float()).abs().mean().item())
        ruin_pred_sum += float(ruin_pred.sum().item())
        ruin_target_sum += float(batch["ruin"].float().sum().item())
        diffs = q_pred
        diffs = diffs[:, 1:] - diffs[:, :-1]
        crossings += int((diffs < -1e-6).sum().item())
        min_gap = min(min_gap, float(diffs.min().item()))

        # Block 3 field quality: mid-episode field vs evidence targets
        seg_len = out["quantiles_seq"].shape[1]
        tc = seg_len // 2 - 1
        evidence = batch["payoff_evidence"][:, seg_start + tc].float()
        field_pinball += float(
            pinball_quantile_loss(out["quantiles_seq"][:, tc].float(), evidence).item()
        )
        # Block 4 probe policy quality: per-sample normalized rank of the latent
        # aspect's utility (0.5 = chance under constant utility, 1.0 = latent on top).
        if out["kv"]:
            K = cfg.n_probes
            q = F.normalize(
                model.probe_aspect_emb.view(K, cfg.n_head, cfg.d_state), dim=-1
            ).float()                                            # [K, H, d]
            eig_total = None
            for (k_b, v_b, g_b, s_b) in out["kv"]:
                A = batched_filter_observe(k_b.float(), v_b.float(), g_b.float(), cfg.prior_lam, suspicion=s_b)
                eig_b = batched_epistemic_eig(A, q.unsqueeze(0).expand(k_b.shape[0], -1, -1, -1))
                eig_total = eig_b if eig_total is None else eig_total + eig_b
            util = eig_total / float(len(out["kv"]))             # [B, K]
            latent = batch["latent"].long()
            u_lat = util.gather(1, latent.clamp(0, K - 1).unsqueeze(1))  # [B, 1]
            greater = (util > u_lat).float().sum(dim=1)
            equal = (util == u_lat).float().sum(dim=1)
            rank_pct = (greater + 0.5 * (equal - 1.0)) / max(1, K - 1)
            probe_rank_sum += float((1.0 - rank_pct).sum().item())

        all_q.append(q_pred)
        all_y.append(batch["payoff"].float())

    # Calibration: PICP raw + split-conformal adjusted (half batches as calibration)
    q_all = torch.cat(all_q, dim=0)
    y_all = torch.cat(all_y, dim=0)
    half = q_all.shape[0] // 2
    offsets = conformal_offsets(q_all[:half], y_all[:half])
    q_adj = q_all[half:] + offsets
    y_test = y_all[half:]
    levels = torch.tensor(QUANTILE_LEVELS, device=device, dtype=q_all.dtype)
    picp_raw = (y_all.unsqueeze(-1) <= q_all).float().mean(dim=0)
    picp_adj = (y_test.unsqueeze(-1) <= q_adj).float().mean(dim=0)
    cov_err_raw = float((picp_raw - levels).abs().mean().item())
    cov_err_adj = float((picp_adj - levels).abs().mean().item())

    n = max(1, eval_batches)
    return {
        "eval_stance_acc": round(correct / max(1, total), 4),
        "eval_quantile_pinball": round(pinball / n, 4),
        "eval_ruin_brier": round(ruin_brier / n, 4),
        "eval_ruin_mae": round(ruin_mae / n, 4),
        "eval_ruin_mean_pred": round(ruin_pred_sum / max(1, total), 4),
        "eval_ruin_mean_target": round(ruin_target_sum / max(1, total), 4),
        "quantile_crossings": crossings,
        "quantile_min_gap": round(min_gap, 6),
        "eval_field_pinball": round(field_pinball / n, 4),
        "eval_probe_latent_rank": round(probe_rank_sum / max(1, total), 4),
        "eval_mean_incongruence": round(inc_sum / n, 4),
        "eval_mean_epistemic_var": round(epi_var_sum / n, 4),
        "eval_per_archetype": {
            ARCHETYPE_NAMES[i]: round((arch_correct[i] / arch_total[i].clamp_min(1)).item(), 4)
            for i in range(N_ARCHETYPES)
        },
        "picp_raw": [round(v, 4) for v in picp_raw.tolist()],
        "picp_adj": [round(v, 4) for v in picp_adj.tolist()],
        "picp_mean_abs_err_raw": round(cov_err_raw, 4),
        "picp_mean_abs_err_adj": round(cov_err_adj, 4),
        "eval_batches": eval_batches,
    }


def train_one_arm(
    arm: str,
    cfg: EpistemicConfig,
    *,
    steps: int,
    batch_size: int,
    seq_len: int,
    lr: float,
    device: torch.device,
    use_bf16: bool,
    use_compile: bool,
    use_deepspeed: bool,
    use_paged: bool = False,
    field_weight: float = 0.5,
    probe_weight: float = 0.5,
    forget_rate: float = 0.0,
    no_suspicion: bool = False,
    no_memory_read: bool = False,
    no_prosody_gate: bool = False,
    memory_warmup: bool = False,
    per_sample_state: bool = False,
    merge3_interval: int,
    ckpt_interval: int,
    rollback_steps: int,
    target_stance: float,
    out_dir: Path,
    rank: int,
    world_size: int,
    resume_path: str | Path | None = None,
    seed: int = 42,
) -> tuple[EpistemicWorldlineModel, dict]:
    torch.manual_seed(seed + rank)
    if use_paged and not cfg.paged_memory:
        cfg = replace(cfg, paged_memory=True)
    if forget_rate > 0.0 and cfg.forget_rate != forget_rate:
        cfg = replace(cfg, forget_rate=forget_rate)
    base_model = EpistemicWorldlineModel(cfg).to(device)
    if arm == "naive_prosody":
        install_naive_prosody_gate(base_model)
    elif no_prosody_gate:
        install_constant_prosody_gate(base_model)
    assert_no_softmax(base_model)
    resume_payload = None
    resume_dir: str | None = None
    if resume_path:
        rp = Path(resume_path)
        if rp.is_dir():
            resume_dir = str(rp)          # DeepSpeed sharded checkpoint root
        else:
            payload = torch.load(resume_path, map_location="cpu", weights_only=False)
            if payload.get("config") != asdict(cfg):
                raise ValueError(f"resume checkpoint config mismatch: {resume_path}")
            base_model.load_state_dict(payload["model"], strict=True)
            resume_payload = payload
            if rank == 0:
                print(f"  [resume] loaded {resume_path} (step={payload.get('step', '?')})", flush=True)
    if resume_dir is not None and not use_deepspeed:
        raise ValueError("a DeepSpeed checkpoint directory requires --deepspeed")
    # Runtime block switches (ablations). Applied after weight loading because
    # they are behaviour flags, not parameters.
    if no_suspicion:
        for blk in base_model.blocks:
            blk.use_suspicion = False
    if no_memory_read:
        for blk in base_model.blocks:
            blk.use_memory_read = False
    param_count = base_model.num_parameters()

    model: nn.Module = base_model
    if use_compile and not use_deepspeed and hasattr(torch, "compile"):
        model = torch.compile(model)

    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01, betas=(0.9, 0.95))
    if resume_payload is not None and not use_deepspeed and resume_payload.get("optimizer") is not None:
        try:
            opt.load_state_dict(resume_payload["optimizer"])
            if rank == 0:
                print("  [resume] optimizer state restored", flush=True)
        except (ValueError, KeyError) as exc:
            if rank == 0:
                print(f"  [resume] optimizer state ignored ({exc})", flush=True)
    engine = None
    ds_resume_state = None
    if use_deepspeed:
        import deepspeed

        if not use_bf16:
            raise ValueError("DeepSpeed ZeRO-2 requires --bf16")
        model, opt, _, _ = deepspeed.initialize(
            model=base_model,
            optimizer=opt,
            config={
                "train_batch_size": batch_size * world_size,
                "train_micro_batch_size_per_gpu": batch_size,
                "gradient_accumulation_steps": 1,
                "bf16": {"enabled": True},
                "zero_optimization": {
                    "stage": 2,
                    "overlap_comm": True,
                    "contiguous_gradients": True,
                    "reduce_bucket_size": 5e8,
                    "allgather_bucket_size": 5e8,
                },
                "gradient_clipping": 1.0,
                "steps_per_print": 100,
                "wall_clock_breakdown": False,
            },
        )
        engine = model
        if resume_dir is not None:
            _, client_state = engine.load_checkpoint(resume_dir, load_module_strict=True)
            if client_state is None:
                raise ValueError(f"DeepSpeed checkpoint has no client state: {resume_dir}")
            if client_state.get("config") != asdict(cfg):
                raise ValueError(f"resume checkpoint config mismatch: {resume_dir}")
            ds_resume_state = client_state
            if rank == 0:
                print(f"  [resume] loaded DeepSpeed checkpoint {resume_dir}", flush=True)
        elif resume_payload is not None and rank == 0:
            print("  [resume] DeepSpeed: weights restored, optimizer moments re-initialized "
                  "(use a DeepSpeed checkpoint dir for full optimizer resume)", flush=True)
    elif world_size > 1:
        # Text-only and naive arms leave submodules unused by design; all arms
        # use find_unused_parameters so DDP reduction cannot deadlock.
        model = DDP(model, device_ids=[device.index], find_unused_parameters=True)

    gen = torch.Generator(device=device).manual_seed(seed * 100 + rank + 1)
    # Block 5: one persistent L2 page table per rank (CoW-forkable worldlines).
    page_table = base_model.init_page_table() if use_paged else None
    amp_dtype = torch.bfloat16 if (use_bf16 and device.type == "cuda") else torch.float32
    amp_enabled = amp_dtype == torch.bfloat16

    losses: list[float] = []
    loss_trace: list[dict[str, float]] = []
    if resume_payload is not None:
        loss_trace.extend(resume_payload.get("loss_trace", []))
    if ds_resume_state is not None:
        loss_trace.extend(ds_resume_state.get("loss_trace", []))
    merge3_checks = 0
    merge3_max_err = 0.0
    merge3_rel_err = 0.0
    latest_ckpt = out_dir / f".{arm}_latest.pt"
    ds_ckpt_root = out_dir / f".{arm}_ds_ckpt"

    def save_checkpoint(tag: str) -> None:
        client_state = {"config": asdict(cfg), "arm": arm, "loss_trace": loss_trace}
        if engine is not None:
            # All ranks must participate in a ZeRO-2 sharded checkpoint.
            engine.save_checkpoint(
                str(ds_ckpt_root), tag=f"step{tag}", client_state=client_state
            )
        if rank != 0:
            return
        torch.save(
            {
                "config": asdict(cfg),
                "model": base_model.state_dict(),
                "arm": arm,
                "step": tag,
                "loss_trace": loss_trace,
                "optimizer": None if engine is not None else opt.state_dict(),
                "deepspeed_zero_stage": 2 if use_deepspeed else 0,
            },
            latest_ckpt,
        )

    def run_steps(start_step: int, num_steps: int, lr_fn) -> None:
        nonlocal merge3_checks, merge3_max_err, merge3_rel_err
        for local in range(1, num_steps + 1):
            step = start_step + local
            batch = generate_high_pressure_batch(batch_size, seq_len, cfg.vocab_size, device, gen)
            prosody_in = None if arm == "asr_text_only" else batch["prosody"]
            lr_now = lr_fn(local, num_steps, start_step)
            for pg in opt.param_groups:
                pg["lr"] = lr_now

            with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_enabled):
                lm_targets = batch["target_ids"]
                evidence_targets = batch["payoff_evidence"]
                ruin_targets = batch["ruin_evidence"]
                if memory_warmup and seq_len >= 8:
                    # Two-pass episode training: first half warms the persistent
                    # (A,B) worldline state, second half is scored with that state
                    # as prior. Without this, every training step starts from the
                    # prior and Block 1's memory read is never exercised.
                    cut = seq_len // 2
                    with torch.no_grad():
                        warm_state = (
                            base_model.init_batched_world_state(batch_size, device)
                            if per_sample_state
                            else None
                        )
                        warm = model(
                            batch["input_ids"][:, :cut],
                            prosody=None if prosody_in is None else prosody_in[:, :cut],
                            world_state=warm_state,
                            update_state=True,
                            page_table=page_table,
                            collect_kv=False,
                        )
                    warm_states = warm["world_state"]
                    out = model(
                        batch["input_ids"][:, cut:],
                        prosody=None if prosody_in is None else prosody_in[:, cut:],
                        world_state=warm_states,
                        update_state=True,
                        page_table=page_table,
                        collect_kv=probe_weight > 0.0,
                    )
                    lm_targets = lm_targets[:, cut:]
                    evidence_targets = evidence_targets[:, cut:]
                    ruin_targets = ruin_targets[:, cut:]
                else:
                    out = model(
                        batch["input_ids"], prosody=prosody_in, update_state=True, page_table=page_table,
                        collect_kv=probe_weight > 0.0,
                    )
                lm_loss = F.cross_entropy(
                    out["logits"].reshape(-1, cfg.vocab_size), lm_targets.reshape(-1)
                )
                q_loss = pinball_quantile_loss(out["quantiles"].float(), batch["payoff"].float())
                st_loss = F.cross_entropy(out["stance_logits"], batch["stance"])
                ruin_loss = F.binary_cross_entropy_with_logits(
                    torch.logit(out["ruin_prob"].float().clamp(1e-4, 1.0 - 1e-4)),
                    batch["ruin"].float(),
                )
                loss = 0.25 * lm_loss + q_loss + st_loss + ruin_loss
                fld = torch.zeros((), device=device)
                prb = torch.zeros((), device=device)

                # Block 3: one-shot future field. The SAME stakes head used by
                # project_future_field reads every position; supervise with the
                # per-turn evidence-resolution targets (hazard-structured ruin).
                if field_weight > 0.0:
                    fld = pinball_quantile_loss(
                        out["quantiles_seq"].float(), evidence_targets.float()
                    ) + F.binary_cross_entropy_with_logits(
                        torch.logit(out["ruin_seq"].float().clamp(1e-4, 1.0 - 1e-4)),
                        ruin_targets.float(),
                    )
                    loss = loss + field_weight * fld

                # Block 4: closed-loop probe policy, per-sample. Each sample's own
                # evidence A_b (rebuilt from its collected k/v/gamma) scores every
                # learnable aspect direction by closed-form EIG x stakes; a
                # stakes-weighted CE pushes the true latent archetype's aspect to
                # the top. Unlike the old shared-batch-state version, confounding
                # across samples cannot leak into the ranking target.
                if probe_weight > 0.0:
                    K = cfg.n_probes
                    q = F.normalize(
                        base_model.probe_aspect_emb.view(K, cfg.n_head, cfg.d_state), dim=-1
                    )                                              # [K, H, d]
                    eig_total = None
                    for (k_b, v_b, g_b, s_b) in out["kv"]:
                        A = batched_filter_observe(
                            k_b.float(), v_b.float(), g_b.float(), cfg.prior_lam, suspicion=s_b
                        )                                          # [B, H, d, d]
                        eig_b = batched_epistemic_eig(
                            A, q.unsqueeze(0).expand(k_b.shape[0], -1, -1, -1)
                        )                                          # [B, K]
                        eig_total = eig_b if eig_total is None else eig_total + eig_b
                    eig_mean = eig_total / float(len(out["kv"]))     # [B, K]
                    spread = out["stakes_spread"].float().clamp_min(0.0)      # [B]
                    util = eig_mean * (1.0 + 0.25 * spread).unsqueeze(-1)     # [B, K]
                    logp = F.log_softmax(util / 0.5, dim=1)          # [B, K]
                    latent = batch["latent"].long().clamp(0, K - 1)  # [B]
                    ce = F.nll_loss(logp, latent, reduction="none")  # [B]
                    stakes_w = 0.5 + batch["payoff"].float().abs() / 10.0     # [B]
                    prb = (ce * stakes_w).mean() / stakes_w.mean()
                    loss = loss + probe_weight * prb

            if engine is not None:
                engine.backward(loss)
                engine.step()
            else:
                opt.zero_grad(set_to_none=True)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()

            losses.append(float(loss.detach().item()))
            if rank == 0 and local % 25 == 0:
                loss_trace.append({
                    "step": step,
                    "loss": round(sum(losses[-25:]) / min(25, len(losses)), 6),
                    "lr": lr_now,
                    "field": round(float(fld.detach().item()), 6),
                    "probe": round(float(prb.detach().item()), 6),
                })
            if rank == 0 and local % 100 == 0:
                window = losses[-100:]
                print(
                    f"  [{arm}] step {step}/{start_step + num_steps} "
                    f"loss={sum(window) / len(window):.4f} lr={lr_now:.2e}",
                    flush=True,
                )

            if merge3_interval > 0 and step % merge3_interval == 0:
                report = check_merge3_consistency(cfg, step)
                merge3_checks += 1
                merge3_max_err = max(merge3_max_err, report["merge3_max_abs_err"])
                merge3_rel_err = max(merge3_rel_err, report["merge3_rel_err"])
                if rank == 0:
                    print(
                        f"  [merge3@{step}] rel_err={report['merge3_rel_err']:.3e} (<=1e-15) "
                        f"max_abs={report['merge3_max_abs_err']:.3e}",
                        flush=True,
                    )

            if ckpt_interval > 0 and step % ckpt_interval == 0:
                save_checkpoint(step)

    warmup = max(1, steps // 10)

    def initial_lr(local: int, total: int, offset: int) -> float:
        step = offset + local
        if step <= warmup:
            return lr * step / warmup
        return lr * (
            0.1 + 0.9 * 0.5 * (1.0 + math.cos(math.pi * (step - warmup) / max(1, steps - warmup)))
        )

    t0 = time.perf_counter()
    run_steps(0, steps, initial_lr)

    eval_metrics = evaluate_arm(
        base_model, arm, cfg, batch_size=batch_size, seq_len=seq_len, device=device,
        eval_batches=32, page_table=page_table, memory_warmup=memory_warmup,
        per_sample_state=per_sample_state,
    )
    model.train()  # evaluate_arm switches to eval() for measurement; restore training mode
    rollback_used = False
    rollback_from = None
    rollback_lr = None

    if arm == "pai_ssm_full" and eval_metrics["eval_stance_acc"] < target_stance and latest_ckpt.exists():
        payload = torch.load(latest_ckpt, map_location=device, weights_only=False)
        base_model.load_state_dict(payload["model"])
        rollback_from = int(payload.get("step") or steps)
        rollback_lr = lr * 0.5
        if engine is not None:
            engine.optimizer.state.clear()
        else:
            opt.state.clear()
        if rank == 0:
            print(
                f"  [{arm}] stance_acc={eval_metrics['eval_stance_acc']:.4f} < {target_stance}; "
                f"rollback to step {rollback_from}, lr={rollback_lr:.2e}, +{rollback_steps} steps",
                flush=True,
            )
        run_steps(rollback_from, rollback_steps, lambda local, total, offset: rollback_lr)
        rollback_used = True
        eval_metrics = evaluate_arm(
            base_model, arm, cfg, batch_size=batch_size, seq_len=seq_len, device=device,
            eval_batches=32, page_table=page_table, memory_warmup=memory_warmup,
            per_sample_state=per_sample_state,
        )
        model.train()

    elapsed = time.perf_counter() - t0
    metrics = {
        "arm": arm,
        "params": param_count,
        "steps": steps,
        "resumed_from": str(resume_path) if resume_path else None,
        "world_size": world_size,
        "deepspeed_zero_stage": 2 if use_deepspeed else 0,
        "bf16": bool(amp_enabled),
        "train_seconds": round(elapsed, 2),
        "tokens_per_sec": round((steps * batch_size * (seq_len - 1) * world_size) / max(1e-6, elapsed), 1),
        "final_loss": round(sum(losses[-5:]) / min(5, len(losses)), 4),
        "stance_target": target_stance,
        "stance_target_met": bool(eval_metrics["eval_stance_acc"] >= target_stance),
        "rollback_used": rollback_used,
        "rollback_from_step": rollback_from,
        "rollback_lr": rollback_lr,
        "merge3_checks": merge3_checks,
        "merge3_max_abs_err": merge3_max_err,
        "merge3_rel_err": merge3_rel_err,
        "paged_memory": bool(use_paged),
        "no_suspicion": bool(no_suspicion),
        "no_memory_read": bool(no_memory_read),
        "no_prosody_gate": bool(no_prosody_gate),
        "memory_warmup": bool(memory_warmup),
        "per_sample_state": bool(per_sample_state),
        "field_weight": field_weight,
        "probe_weight": probe_weight,
        "config": asdict(cfg),
        "loss_trace": loss_trace,
    }
    metrics.update(eval_metrics)
    return base_model, metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", choices=list(PRESETS.keys()), default="smoke")
    parser.add_argument("--steps", type=int, default=80)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--seq-len", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1.5e-3)
    parser.add_argument("--bf16", action="store_true")
    parser.add_argument("--compile", action="store_true")
    parser.add_argument("--deepspeed", action="store_true")
    parser.add_argument("--merge3-interval", type=int, default=500)
    parser.add_argument("--ckpt-interval", type=int, default=500)
    parser.add_argument("--rollback-steps", type=int, default=500)
    parser.add_argument("--target-stance", type=float, default=0.80,
                        help="ambiguous episodes: Bayes-optimal accuracy is < 1, so the "
                             "rollback threshold sits below the old near-deterministic 0.98")
    parser.add_argument("--paged-memory", action="store_true", help="enable L2 paged memory on the pai_ssm_full arm")
    parser.add_argument("--field-weight", type=float, default=0.5)
    parser.add_argument("--probe-weight", type=float, default=0.5)
    parser.add_argument("--forget-rate", type=float, default=0.0,
                        help="hippocampal forgetting per-turn retention (0=perfect memory; e.g. 0.97 ~ 23-turn half-life)")
    parser.add_argument("--resume", type=str, default=None)
    parser.add_argument("--no-suspicion", action="store_true",
                        help="Block 2b ablation: disable orthogonal suspicion writes on the full arm")
    parser.add_argument("--no-memory-read", action="store_true",
                        help="Block 1 ablation: disable persistent (A,B) memory reads on the full arm")
    parser.add_argument("--no-prosody-gate", action="store_true",
                        help="Block 2 ablation: ignore prosody (constant precision, zero incongruence)")
    parser.add_argument("--memory-warmup", action="store_true",
                        help="Train Block 1: warm the (A,B) state on the first half of each episode, "
                             "score the second half with it as prior")
    parser.add_argument("--per-sample-state", action="store_true",
                        help="Strictly per-sample (A,B) worldline state during memory warmup; "
                             "prevents batch-mate evidence leaking into each sample's suffix read")
    parser.add_argument("--ablation", action="store_true")
    parser.add_argument("--out-dir", type=str, default="epistemic_model/runs")
    args = parser.parse_args()

    if args.seq_len < 8:
        parser.error("--seq-len must be >= 8 (episode needs a pre-challenge half and a scorable suffix)")
    if args.per_sample_state and not args.memory_warmup:
        parser.error("--per-sample-state only affects the memory warmup passes; add --memory-warmup")
    if args.memory_warmup and args.no_memory_read:
        parser.error("--memory-warmup with --no-memory-read is contradictory (warm state would never be read)")

    local_rank = int(os.environ.get("LOCAL_RANK", "-1"))
    if local_rank >= 0 and torch.cuda.is_available():
        dist.init_process_group(backend="nccl")
        device = torch.device(f"cuda:{local_rank}")
        torch.cuda.set_device(device)
        rank = dist.get_rank()
        world_size = dist.get_world_size()
    else:
        device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
        rank = 0
        world_size = 1

    cfg = PRESETS[args.preset]
    arms = ["asr_text_only", "naive_prosody", "pai_ssm_full"] if args.ablation else ["pai_ssm_full"]
    results = []
    out_path = Path(args.out_dir)

    resume_root = Path(args.resume) if args.resume else None
    if resume_root is not None and not resume_root.is_dir() and len(arms) > 1:
        raise SystemExit(
            "--resume with multiple arms requires a directory containing per-arm "
            ".<arm>_latest.pt or .<arm>_ds_ckpt checkpoints"
        )

    def resume_for(arm_name: str) -> str | None:
        """Resolve a per-arm resume checkpoint.

        A directory means 'resume every arm that has a checkpoint'; a file is
        only accepted for single-arm runs.  With ``--deepspeed`` a sharded
        ``.<arm>_ds_ckpt`` directory is preferred because it also restores
        optimizer moments, otherwise the portable ``.<arm>_latest.pt`` is used.
        """
        if resume_root is None:
            return None
        if resume_root.is_dir():
            # Directly pointing at one arm's DeepSpeed checkpoint root.
            if (resume_root / "latest").exists():
                if not args.deepspeed:
                    raise SystemExit("a DeepSpeed checkpoint directory requires --deepspeed")
                return str(resume_root)
            pt_candidate = resume_root / f".{arm_name}_latest.pt"
            ds_candidate = resume_root / f".{arm_name}_ds_ckpt"
            if args.deepspeed and ds_candidate.exists():
                return str(ds_candidate)
            if pt_candidate.exists():
                return str(pt_candidate)
            if ds_candidate.exists():
                return str(ds_candidate)
            return None
        return str(resume_root)

    if rank == 0 and resume_root is not None and resume_root.is_dir():
        for arm_name in arms:
            if resume_for(arm_name) is None:
                print(f"  [{arm_name}] no checkpoint in resume dir, starting fresh", flush=True)

    if rank == 0:
        out_path.mkdir(parents=True, exist_ok=True)
        print(
            f"Device: {device} (world_size={world_size}) | Preset: {args.preset} | "
            f"Params: ~{EpistemicWorldlineModel(cfg).num_parameters():,} | "
            f"deepspeed={args.deepspeed} | bf16={args.bf16} | arms={arms}",
            flush=True,
        )

    for arm in arms:
        model, metrics = train_one_arm(
            arm,
            cfg,
            steps=args.steps,
            batch_size=args.batch_size,
            seq_len=args.seq_len,
            lr=args.lr,
            device=device,
            use_bf16=args.bf16,
            use_compile=args.compile,
            use_deepspeed=args.deepspeed,
            use_paged=(args.paged_memory and arm == "pai_ssm_full"),
            field_weight=args.field_weight,
            probe_weight=args.probe_weight,
            forget_rate=args.forget_rate,
            no_suspicion=args.no_suspicion,
            no_memory_read=args.no_memory_read,
            no_prosody_gate=args.no_prosody_gate,
            memory_warmup=args.memory_warmup,
            per_sample_state=args.per_sample_state,
            merge3_interval=args.merge3_interval,
            ckpt_interval=args.ckpt_interval,
            rollback_steps=args.rollback_steps,
            target_stance=args.target_stance,
            out_dir=out_path,
            rank=rank,
            world_size=world_size,
            resume_path=resume_for(arm),
        )
        results.append(metrics)
        if rank == 0:
            print(
                f"  [{arm}] stance_acc={metrics['eval_stance_acc']:.4f} "
                f"(target>={args.target_stance}: {'PASS' if metrics['stance_target_met'] else 'FAIL'}) | "
                f"pinball={metrics['eval_quantile_pinball']:.4f} | "
                f"ruin_brier={metrics['eval_ruin_brier']:.4f} | "
                f"crossings={metrics['quantile_crossings']} | "
                f"merge3_rel={metrics['merge3_rel_err']:.2e} | "
                f"rollback={metrics['rollback_used']}",
                flush=True,
            )
            if arm == "pai_ssm_full":
                final_path = out_path / f"pai_ssm_{args.preset}_final.pt"
                torch.save(
                    {
                        "config": metrics["config"],
                        "model": model.state_dict(),
                        "metrics": {k: v for k, v in metrics.items() if k != "config"},
                        "deepspeed_zero_stage": 2 if args.deepspeed else 0,
                    },
                    final_path,
                )
                print(f"  saved final checkpoint -> {final_path}", flush=True)

    if rank == 0:
        raw_path = out_path / f"ablation_{args.preset}.json"
        raw_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")

        by_arm = {m["arm"]: m for m in results}
        full = by_arm.get("pai_ssm_full")
        text = by_arm.get("asr_text_only")
        summary = {
            "preset": args.preset,
            "steps": args.steps,
            "world_size": world_size,
            "bf16": bool(args.bf16),
            "deepspeed_zero_stage": 2 if args.deepspeed else 0,
            "scenarios": list(ARCHETYPE_NAMES),
            "arms": [
                {
                    "arm": m["arm"],
                    "stance_accuracy": m["eval_stance_acc"],
                    "ruin_probability": {
                        "brier": m["eval_ruin_brier"],
                        "mae": m["eval_ruin_mae"],
                        "mean_pred": m["eval_ruin_mean_pred"],
                        "mean_target": m["eval_ruin_mean_target"],
                    },
                    "quantile_pinball": m["eval_quantile_pinball"],
                    "quantile_crossings": m["quantile_crossings"],
                    "quantile_min_gap": m["quantile_min_gap"],
                    "field_pinball": m["eval_field_pinball"],
                    "probe_latent_rank": m["eval_probe_latent_rank"],
                    "mean_incongruence": m["eval_mean_incongruence"],
                    "mean_epistemic_var": m["eval_mean_epistemic_var"],
                    "per_archetype_accuracy": m["eval_per_archetype"],
                    "picp_raw": m["picp_raw"],
                    "picp_adj": m["picp_adj"],
                    "picp_mean_abs_err_raw": m["picp_mean_abs_err_raw"],
                    "picp_mean_abs_err_adj": m["picp_mean_abs_err_adj"],
                    "paged_memory": m["paged_memory"],
                    "no_suspicion": m["no_suspicion"],
                    "no_memory_read": m["no_memory_read"],
                    "no_prosody_gate": m["no_prosody_gate"],
                    "memory_warmup": m["memory_warmup"],
                    "per_sample_state": m["per_sample_state"],
                    "merge3_rel_err": m["merge3_rel_err"],
                    "merge3_checks": m["merge3_checks"],
                    "rollback_used": m["rollback_used"],
                    "loss_trace": m["loss_trace"],
                }
                for m in results
            ],
        }
        if full and text:
            summary["delta_full_vs_text"] = {
                "stance_accuracy": round(full["eval_stance_acc"] - text["eval_stance_acc"], 4),
                "ruin_brier": round(full["eval_ruin_brier"] - text["eval_ruin_brier"], 4),
                "quantile_pinball": round(
                    full["eval_quantile_pinball"] - text["eval_quantile_pinball"], 4
                ),
            }
        naive = by_arm.get("naive_prosody")
        if full and naive:
            summary["delta_full_vs_naive"] = {
                "stance_accuracy": round(full["eval_stance_acc"] - naive["eval_stance_acc"], 4),
                "ruin_brier": round(full["eval_ruin_brier"] - naive["eval_ruin_brier"], 4),
                "quantile_pinball": round(
                    full["eval_quantile_pinball"] - naive["eval_quantile_pinball"], 4
                ),
                "field_pinball": round(
                    full["eval_field_pinball"] - naive["eval_field_pinball"], 4
                ),
                "probe_latent_rank": round(
                    full["eval_probe_latent_rank"] - naive["eval_probe_latent_rank"], 4
                ),
            }
        summary_path = out_path / "ablation_summary.json"
        summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  saved ablation summary -> {summary_path}", flush=True)
        print(f"Saved artifacts to {out_path}", flush=True)

    if world_size > 1:
        dist.destroy_process_group()


if __name__ == "__main__":
    main()
