"""One-shot multi-horizon future-field projection (Block 3: Analytic Kernel).

Traditional roll-outs forecast the future autoregressively: step k depends on
k-1, errors compound, and bimodal futures (+10 triumph / -10 ruin) get averaged
into a meaningless 0. PAI-SSM instead *develops the whole future field in one
exposure*:

  1. The segment mixer's state transition is expanded with constant
     coefficients harvested from the turn-final hidden state, so all H
     horizons are produced by a SINGLE parallel associative scan
     (O(log H) depth, zero Python token loops over horizons).
  2. The stakes head reads every horizon simultaneously, yielding a
     non-crossing quantile field plus a per-step Ruin hazard.
  3. The per-step hazards compose into a cumulative Ruin curve
     ``R_h = 1 - prod_{i<=h} (1 - r_i)`` -- the "irreversible dead-point
     approach curve" used by the third alarm (circuit-breaker).
  4. The epistemic field is *closed-form*: under the analytic expected
     precision write ``A_h = A + h * gamma * k k^T``, posterior variance
     ``sigma^2_h(q) = q^T A_h^{-1} q`` is exact without any sampling.

The latent kernel is linear (coefficients frozen at the seed state); the
frozen backbone supplies the nonlinearity that produced the seed. This is the
honest scope of the "analytic multi-horizon kernel" claim.
"""

from __future__ import annotations

from typing import Optional

import torch
import torch.nn.functional as F

from .architecture import (
    EpistemicWorldlineModel,
    InformationFilterState,
    STANCE_LABELS,
    parallel_affine_scan,
)


@torch.no_grad()
def project_future_field(
    model: EpistemicWorldlineModel,
    seed_hidden: torch.Tensor,
    world_state: Optional[list[InformationFilterState]] = None,
    horizons: int = 8,
    expected_precision: float = 1.0,
    n_block: int = 0,
) -> dict[str, torch.Tensor]:
    """Project the future payoff/epistemic field in ONE non-autoregressive pass.

    Args:
        model: trained ``EpistemicWorldlineModel`` (eval mode recommended).
        seed_hidden: ``[B, D]`` turn-final hidden state (``hidden_last``).
        world_state: current layer-wise information-filter states, or ``None``.
        horizons: number of future steps H to project in parallel.
        expected_precision: assumed write precision gamma for the epistemic field.
        n_block: which block's mixer weights parameterize the latent kernel.

    Returns:
        dict with
          ``quantiles``      ``[B, H, 5]`` non-crossing [Q10..Q90] per horizon,
          ``ruin_hazard``    ``[B, H]`` per-step ruin probability,
          ``ruin_cumulative`` ``[B, H]`` cumulative dead-point curve,
          ``stakes_spread``  ``[B, H]`` Q90-Q10 tension per horizon,
          ``hidden``         ``[B, H, D]`` projected latent trajectory,
          ``epistemic_var``  ``[B, H]`` closed-form posterior variance (None if
                             world_state is None), averaged over layers,
          ``probe_utility``  ``[B, H]`` stakes-weighted EIG analog
                             ``epi * (1 + 0.25 * spread)`` per horizon.
    """
    if seed_hidden.dim() != 2:
        raise ValueError(f"expected seed_hidden [B, D], got {tuple(seed_hidden.shape)}")
    B, D = seed_hidden.shape
    if horizons < 1:
        raise ValueError("horizons must be >= 1")
    blk = model.blocks[n_block]
    H, ds = blk.H, blk.ds
    dev = seed_hidden.device

    # Constant-coefficient expansion: mixer coefficients frozen at the seed.
    u = blk.norm1(seed_hidden)                                            # [B, D]
    k = F.normalize(blk.to_k(u).view(B, H, ds), dim=-1)                   # [B, H, ds]
    v = blk.to_v(u).view(B, H, ds)                                        # [B, H, ds]
    decay = (0.05 + 0.945 * torch.sigmoid(blk.to_decay(u))).view(B, H, 1)  # [B, H, 1]
    gate = torch.sigmoid(blk.to_gate(u).view(B, H, ds))                   # [B, H, ds]
    drive = float(expected_precision) * k * v                             # [B, H, ds]

    # One parallel associative scan develops ALL horizons at once.
    a = decay.unsqueeze(1).expand(B, horizons, H, ds).contiguous()        # [B, Hrz, H, ds]
    b = drive.unsqueeze(1).expand(B, horizons, H, ds).contiguous()
    scan = parallel_affine_scan(a, b)                                     # [B, Hrz, H, ds]

    if world_state is not None:
        st = world_state[n_block]
        mem_mean = st.posterior_mean(k)                                   # [B, H, ds]
    else:
        mem_mean = torch.zeros_like(k)
    combined = (scan + mem_mean.unsqueeze(1)) * gate.unsqueeze(1)         # [B, Hrz, H, ds]
    y = blk.to_out(combined.reshape(B, horizons, H * ds))
    x_h = seed_hidden.unsqueeze(1) + y                                    # [B, Hrz, D]
    h_seq = model.norm_f(x_h)                                             # [B, Hrz, D]

    # Outcome field: stakes head reads every horizon simultaneously.
    stakes = model.stakes_head(h_seq)
    quantiles = stakes["quantiles"]                                       # [B, Hrz, 5]
    hazard = stakes["ruin_prob"].clamp(0.0, 1.0)                          # [B, Hrz]
    cum_ruin = 1.0 - torch.cumprod(1.0 - hazard, dim=-1)                  # [B, Hrz]
    spread = stakes["spread"]                                             # [B, Hrz]

    # Epistemic field: closed-form variance under analytic expected writes.
    epi: Optional[torch.Tensor] = None
    probe_utility: Optional[torch.Tensor] = None
    if world_state is not None:
        gamma = float(expected_precision)
        kf = k.float()
        kk = torch.einsum("bhi,bhj->bhij", kf, kf)                        # [B, H, ds, ds]
        epi = torch.zeros(B, horizons, H, device=dev, dtype=torch.float32)
        for st in world_state:
            base = st.A.float().unsqueeze(0)                              # [1, H, ds, ds]
            var_h = []
            for h in range(horizons):
                A_h = base + (h * gamma) * kk                             # [B, H, ds, ds]
                sol = torch.linalg.solve(A_h, kf.unsqueeze(-1))           # [B, H, ds, 1]
                var_h.append((kf.unsqueeze(-1) * sol).sum(dim=(-1, -2)))  # [B, H]
            epi += torch.stack(var_h, dim=1)                              # [B, Hrz, H]
        epi = epi / float(len(world_state))                               # [B, Hrz]
        epi = epi.mean(dim=-1)                                            # [B, Hrz]
        probe_utility = epi * (1.0 + 0.25 * spread.float())

    return {
        "quantiles": quantiles,
        "ruin_hazard": hazard,
        "ruin_cumulative": cum_ruin,
        "stakes_spread": spread,
        "hidden": h_seq,
        "epistemic_var": epi,
        "probe_utility": probe_utility,
    }


@torch.no_grad()
def counterfactual_eval(
    model: EpistemicWorldlineModel,
    seed_hidden: torch.Tensor,
    world_state: Optional[list[InformationFilterState]] = None,
    horizons: int = 8,
    expected_precision: float = 1.0,
    n_block: int = 0,
) -> dict:
    """Counterfactual deliberation (Block 1/3 reasoning upgrade): before committing,
    the model rolls the SAME future field through its own trained adversarial
    counter-move operator and measures how violently the payoff landscape shifts.

    The counterfactual seed perturbs the factual seed along the block's trained
    adversarial value stream (``adv_counter`` / ``adv_mix``) — "如果对方反手，世界会怎样".
    If the Q50 path and stakes spread barely move (robustness ~ 1) the decision is
    stable; if they tear apart (divergence large) the caller should treat the
    current stance as volatile and prefer information-seeking over commitment.

    Args:
        model: trained ``EpistemicWorldlineModel`` (eval mode recommended).
        seed_hidden: ``[B, D]`` turn-final hidden state.
        world_state: current layer-wise filter states, or ``None``.
        horizons: number of future steps to project for both branches.
        expected_precision: assumed write precision for the epistemic field.
        n_block: which block's adversarial operator parameterizes the counter-move.

    Returns:
        dict with
          ``factual``        full ``project_future_field`` output for the seed,
          ``counterfactual`` full output for the adversarially perturbed seed,
          ``divergence``     scalar mean |ΔQ50| + |Δspread| across horizons,
          ``robustness``     ``1 / (1 + divergence)`` in (0, 1] — 1 = 反事实无感,
          ``volatile``       ``divergence`` exceeds the 1.0 volatility threshold.
    """
    factual = project_future_field(
        model, seed_hidden, world_state, horizons, expected_precision, n_block
    )
    blk = model.blocks[n_block]
    B, D = seed_hidden.shape
    u = blk.norm1(seed_hidden)
    v_adv = blk.adv_counter(u).view(B, blk.H, blk.ds)
    cf_seed = seed_hidden + blk.to_out(
        (torch.tanh(blk.adv_mix) * v_adv).reshape(B, blk.H * blk.ds).to(seed_hidden.dtype)
    )
    counterfactual = project_future_field(
        model, cf_seed, world_state, horizons, expected_precision, n_block
    )
    q50_f = factual["quantiles"][..., 2].float()
    q50_c = counterfactual["quantiles"][..., 2].float()
    spread_f = factual["stakes_spread"].float()
    spread_c = counterfactual["stakes_spread"].float()
    divergence = (q50_f - q50_c).abs().mean() + (spread_f - spread_c).abs().mean()
    robustness = 1.0 / (1.0 + divergence)
    return {
        "factual": factual,
        "counterfactual": counterfactual,
        "divergence": divergence,
        "robustness": robustness,
        "volatile": bool(divergence.item() > 1.0),
    }


# Stances that commit to the current worldline (no new information gathered).
_COMMITMENT_STANCES: tuple[str, ...] = ("empathetic", "counter_bluff", "rupture")
_INFORMATION_STANCE = "probe_blindspot"


def _last_quantiles(field: dict) -> torch.Tensor:
    q = field["quantiles"]
    if q.dim() < 2 or q.shape[0] != 1:
        raise ValueError(
            f"robust_stance_decision expects a single sample, got quantiles {tuple(q.shape)}"
        )
    return q.reshape(-1, q.shape[-1])[0].float().detach()


def _last_scalar(field: dict, key: str) -> float:
    v = field[key]
    if v.dim() >= 1 and v.shape[0] != 1:
        raise ValueError(
            f"robust_stance_decision expects a single sample, got {key} {tuple(v.shape)}"
        )
    return float(v.reshape(-1)[-1].detach())


def robust_stance_decision(
    factual: dict,
    counterfactual: dict,
    stance_probs: torch.Tensor,
    *,
    divergence: float,
    ruin_prob: float,
    volatility_threshold: float = 1.0,
    ruin_threshold: float = 0.82,
    caution_mix: float = 0.5,
) -> dict:
    """Turn the counterfactual field into an actual risk-adjusted decision.

    ``counterfactual_eval`` only reports how violently the payoff landscape moves
    under the opponent's best response.  This function closes the loop:

    * **Ruin circuit breaker** — if the counterfactual cumulative ruin reaches
      ``ruin_threshold``, the decision hard-switches to ``rupture``.
    * **Volatile -> information seeking** — if the counterfactual divergence
      exceeds ``volatility_threshold``, a fraction of the probability mass on
      commitment stances (empathetic / counter_bluff / rupture) is transferred
      to ``probe_blindspot``, so the model asks before committing.
    * **Risk-adjusted outcome band** — the reported quantiles become the
      elementwise minimum of the factual and counterfactual bands (min of two
      non-crossing quantile vectors stays non-crossing; downside protection).

    All probability edits are deterministic positive renormalisation, no
    sampling and no softmax attention.

    Args:
        factual: output of ``project_future_field`` for the factual seed.
        counterfactual: output for the adversarially perturbed seed.
        stance_probs: ``[n_stances]`` current stance distribution.
        divergence: scalar counterfactual divergence from ``counterfactual_eval``.
        ruin_prob: factual ruin probability from the stance pass.
        volatility_threshold: divergence above which the decision is corrected.
        ruin_threshold: cumulative counterfactual ruin that trips the breaker.
        caution_mix: maximum fraction of commitment mass moved per volatile turn.

    Returns:
        Dict with corrected ``stance``, adjusted probabilities, risk-adjusted
        quantiles, and an auditable ``reason`` code.
    """
    probs = torch.as_tensor(stance_probs, dtype=torch.float32).detach().reshape(-1).clamp_min(0.0)
    if probs.numel() != len(STANCE_LABELS):
        raise ValueError(f"expected {len(STANCE_LABELS)} stance probabilities, got {probs.numel()}")
    probs = probs / probs.sum().clamp_min(1e-12)
    original_idx = int(probs.argmax().item())

    fq = _last_quantiles(factual)
    cq = _last_quantiles(counterfactual)
    volatile = float(divergence) > float(volatility_threshold)
    risk_q = torch.minimum(fq, cq) if volatile else fq
    factual_spread = _last_scalar(factual, "stakes_spread")
    # Report the width of the band we actually return.  Elementwise min of two
    # non-crossing quantile vectors is still non-crossing, so deriving the spread
    # from risk_q keeps "risk_adjusted_spread == q90 - q10" self-consistent.
    risk_spread = float(risk_q[-1] - risk_q[0]) if volatile else factual_spread
    cf_ruin = _last_scalar(counterfactual, "ruin_cumulative")
    risk_ruin = max(float(ruin_prob), cf_ruin) if volatile else float(ruin_prob)

    adjusted = probs.clone()
    reason = "stable"
    if risk_ruin >= ruin_threshold:
        adjusted.zero_()
        adjusted[STANCE_LABELS.index("rupture")] = 1.0
        reason = "ruin_circuit_breaker"
    elif volatile:
        commit_idx = [i for i, name in enumerate(STANCE_LABELS) if name in _COMMITMENT_STANCES]
        info_idx = STANCE_LABELS.index(_INFORMATION_STANCE)
        mass = adjusted[commit_idx].sum()
        excess = (float(divergence) - float(volatility_threshold)) / max(1e-6, float(volatility_threshold))
        shift = caution_mix * min(1.0, excess) * mass
        if float(shift) > 0.0:
            shares = adjusted[commit_idx] / mass.clamp_min(1e-12)
            adjusted[commit_idx] = adjusted[commit_idx] - shares * shift
            adjusted[info_idx] = adjusted[info_idx] + shift
            reason = "counterfactual_volatile_information_seeking"
        elif original_idx == info_idx:
            reason = "already_information_seeking"

    adjusted = adjusted.clamp_min(0.0)
    adjusted = adjusted / adjusted.sum().clamp_min(1e-12)
    corrected_idx = int(adjusted.argmax().item())
    return {
        "stance": STANCE_LABELS[corrected_idx],
        "original_stance": STANCE_LABELS[original_idx],
        "correction_applied": corrected_idx != original_idx,
        "reason": reason,
        "volatile": volatile,
        "divergence": round(float(divergence), 4),
        "risk_adjusted_quantiles": [round(float(v), 4) for v in risk_q.tolist()],
        "risk_adjusted_q50": round(float(risk_q[2]), 4),
        "risk_adjusted_spread": round(float(risk_spread), 4),
        "risk_ruin": round(float(risk_ruin), 4),
        "stance_probs_adjusted": {
            name: round(float(p), 4) for name, p in zip(STANCE_LABELS, adjusted.tolist())
        },
    }
