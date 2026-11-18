"""PAI-SSM: Paralinguistic-Modulated Information-Filter State Architecture.

Core theoretical properties (all unit-tested in ``test_invariants.py``):
1. **Exact 3-Way Algebraic Mergeability**:
   Each layer maintains natural parameters / sufficient statistics ``(A, B)`` of
   a heteroscedastic Bayesian linear system:
       A = λI + Σ_t γ_t k_t k_t^T,   B = Σ_t γ_t v_t k_t^T
   Any two worldline branches sharing ancestor ``base`` merge without replay via
   ``A_out = A_a + A_b - A_base``, agreeing with full sequential replay to machine
   precision (~1e-15 in float64).

2. **Paralinguistic Heteroscedastic Gating & Verbal-Vocal Incongruence**:
   Instead of collapsing speech into ASR text alone, a 12-D acoustic prosody
   vector ``p_t`` (hesitation, stutter rate, F0 terminal slope, vocal jitter)
   computes cross-modal incongruence against semantic hidden state ``h_t``.
   High incongruence does two things: (i) attenuates the literal write precision
   γ_t by up to 75%, and (ii) fires the **orthogonal suspicion write** — a
   high-precision write along a fixed per-head direction q_s (Gram-Schmidt
   orthogonalized against the claim key) carrying a learnable suspicion value,
   engraving distrust into W_fast without touching the literal claim subspace.

3. **Closed-Form Active Epistemic Probing (Bayesian Experimental Design)**:
   Posterior epistemic uncertainty along any candidate probe query ``q`` is
   ``σ²(q) = q^T A^{-1} q``. By the Matrix Determinant Lemma, the exact Shannon
   Expected Information Gain of probing along ``q`` with expected precision ``γ`` is:
       EIG(q | A) = 0.5 * Σ_h log(1 + γ_h * q_h^T A_h^{-1} q_h) >= 0
   Combined with non-crossing outcome quantiles ``[Q10, Q30, Q50, Q70, Q90]``,
   the model intrinsically asks questions when *both* epistemic uncertainty and
   stakes spread ``(Q90 - Q10)`` are high.

4. **Parallel Associative Prefix Scan**:
   Intra-segment sequence mixing uses an O(log T) parallel affine prefix scan
   (zero Python token loops on GPU), matching recurrent step-by-step decoding.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import math
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F

from .paged_memory import CoWPageTable, ProductKeyPagedMemory
from .prosody import PARALINGUISTIC_DIM


STANCE_LABELS: tuple[str, ...] = (
    "empathetic",     # 0: 接纳共情（信任充足且言行一致）
    "neutral",        # 1: 平视审视
    "probe_blindspot",# 2: 主动追问盲区（检测到高不确定度暗雷）
    "skeptical_push", # 3: 质疑抬杠（捕捉到场面话或言行分裂）
    "counter_bluff",  # 4: 反将一军（拿捏对方软肋施压）
    "rupture",        # 5: 翻脸决裂（击穿不可逆死穴阈值）
)

QUANTILE_LEVELS: tuple[float, ...] = (0.10, 0.30, 0.50, 0.70, 0.90)


@dataclass
class EpistemicConfig:
    vocab_size: int = 16384
    d_model: int = 512
    n_layer: int = 8
    n_head: int = 8
    d_state: int = 32          # per-head Information Filter dimension dk = dv
    prosody_dim: int = PARALINGUISTIC_DIM
    prior_lam: float = 0.10
    n_stances: int = len(STANCE_LABELS)
    dropout: float = 0.0
    # Block 5: OS-style L2 product-key paged memory (L1 = information-filter state)
    paged_memory: bool = False
    paged_sub_keys: int = 256     # K -> K^2 virtual slots (256^2 = 65,536)
    paged_top_k: int = 4          # top-k pointer dereference per query
    # Block 4: closed-loop probe aspects (learnable suspicion directions)
    n_probes: int = 8
    # Block 2b: orthogonal suspicion write — when verbal-vocal incongruence fires,
    # a high-precision write lands on a fixed suspicion direction q_s (orthogonalized
    # against the literal claim key), carrying a learnable suspicion value vector.
    suspicion_write: bool = True
    suspicion_strength: float = 2.0   # max write precision along q_s (u_t = 1)
    # Block 2c: cognitive personality-bias operators (fixed pseudo-observations
    # injected into (A,B) at inference to drift personality: "一千个哈姆雷特")
    n_personality_biases: int = 3
    # Block 5: hippocampal forgetting — per-turn exponential fade of the (A,B)
    # state back toward the prior (0.0 = perfect memory, 0.97 ~ half-life ~23 turns)
    forget_rate: float = 0.0


PERSONALITY_BIAS_NAMES: tuple[str, ...] = ("aggressive", "conservative", "victim")


# ============================================================================
# 1. Heteroscedastic Bayesian Information-Filter State (Exact Merge3 + EIG)
# ============================================================================


@dataclass(frozen=True)
class InformationFilterState:
    """Natural-parameter Bayesian state ``(A, B)`` per attention/worldline head.

    Shapes:
        A: ``[H, d, d]`` symmetric positive-definite precision matrix ``λI + Σ γ k k^T``
        B: ``[H, d, d]`` precision-weighted value accumulator ``Σ γ v k^T``
        incongruence_mass: ``[H]`` accumulated cross-modal verbal-vocal tension
        obs_count: scalar total weighted observations
    """

    A: torch.Tensor
    B: torch.Tensor
    lam: float
    incongruence_mass: torch.Tensor
    obs_count: torch.Tensor

    @classmethod
    def prior(
        cls,
        heads: int,
        dim: int,
        *,
        lam: float = 0.10,
        device: torch.device | str | None = None,
        dtype: torch.dtype = torch.float32,
    ) -> "InformationFilterState":
        if heads <= 0 or dim <= 0 or not (lam > 0.0):
            raise ValueError("heads, dim, and lam must be strictly positive")
        eye = torch.eye(dim, device=device, dtype=dtype).unsqueeze(0).expand(heads, dim, dim).clone()
        return cls(
            A=eye * float(lam),
            B=torch.zeros(heads, dim, dim, device=device, dtype=dtype),
            lam=float(lam),
            incongruence_mass=torch.zeros(heads, device=device, dtype=dtype),
            obs_count=torch.zeros((), device=device, dtype=dtype),
        )

    def detach(self) -> "InformationFilterState":
        return replace(
            self,
            A=self.A.detach().clone(),
            B=self.B.detach().clone(),
            incongruence_mass=self.incongruence_mass.detach().clone(),
            obs_count=self.obs_count.detach().clone(),
        )

    def observe(
        self,
        keys: torch.Tensor,
        values: torch.Tensor,
        precision_gate: torch.Tensor,
        incongruence: torch.Tensor | None = None,
        suspicion_dir: torch.Tensor | None = None,
        suspicion_value: torch.Tensor | None = None,
        suspicion_precision: torch.Tensor | None = None,
    ) -> "InformationFilterState":
        """Bayesian precision update from ``keys [N,H,d]``, ``values [N,H,d]``, ``precision_gate [N,H]``.

        Optional orthogonal suspicion write (Block 2b): ``suspicion_dir [N,H,d]`` receives
        an extra precision ``suspicion_precision [N,H]`` (typically carrying the learnable
        ``suspicion_value [N,H,d]``). Callers must orthogonalize ``suspicion_dir`` against
        ``keys`` if the suspicion channel must not touch the literal claim subspace.
        """
        if keys.dim() != 3 or values.shape != keys.shape:
            raise ValueError(f"expected keys/values [N,H,d], got {tuple(keys.shape)} vs {tuple(values.shape)}")
        k = keys.to(device=self.A.device, dtype=self.A.dtype)
        v = values.to(device=self.A.device, dtype=self.A.dtype)
        g = precision_gate.to(device=self.A.device, dtype=self.A.dtype).clamp_min(0.0)

        dA = torch.einsum("nh,nhi,nhj->hij", g, k, k)
        # Symmetrize explicitly to eliminate floating-point asymmetry drift
        dA = 0.5 * (dA + dA.transpose(-1, -2))
        dB = torch.einsum("nh,nhv,nhk->hvk", g, v, k)

        if suspicion_dir is not None and suspicion_precision is not None:
            qs = suspicion_dir.to(device=self.A.device, dtype=self.A.dtype)
            gs = suspicion_precision.to(device=self.A.device, dtype=self.A.dtype).clamp_min(0.0)
            dAs = torch.einsum("nh,nhi,nhj->hij", gs, qs, qs)
            dA = dA + 0.5 * (dAs + dAs.transpose(-1, -2))
            if suspicion_value is not None:
                vs = suspicion_value.to(device=self.A.device, dtype=self.A.dtype)
                dB = dB + torch.einsum("nh,nhv,nhk->hvk", gs, vs, qs)

        inc = self.incongruence_mass
        if incongruence is not None:
            inc = inc + incongruence.to(device=self.A.device, dtype=self.A.dtype).clamp_min(0.0).sum(dim=0)

        return replace(
            self,
            A=self.A + dA,
            B=self.B + dB,
            incongruence_mass=inc,
            obs_count=self.obs_count + g.mean(dim=-1).sum(),
        )

    def posterior_mean(self, queries: torch.Tensor, jitter: float = 1e-6) -> torch.Tensor:
        """Posterior mean readout ``μ(q) = B A^{-1} q`` for ``queries [..., H, d]``."""
        orig_shape = queries.shape
        H, d = self.A.shape[0], self.A.shape[1]
        q = queries.reshape(-1, H, d).to(device=self.A.device, dtype=self.A.dtype)
        eye = torch.eye(d, device=self.A.device, dtype=self.A.dtype).unsqueeze(0)
        L, info = torch.linalg.cholesky_ex(self.A + jitter * eye)
        if (info != 0).any():
            # Fallback to damped linear solve under extreme ill-conditioning
            A_inv_q = torch.linalg.solve(self.A + 1e-4 * eye, q.permute(1, 2, 0))  # [H, d, M]
        else:
            A_inv_q = torch.cholesky_solve(q.permute(1, 2, 0), L)  # [H, d, M]
        out = torch.einsum("hvd,hdm->mhv", self.B, A_inv_q)
        return out.reshape(orig_shape).to(queries.dtype)

    def epistemic_variance(self, queries: torch.Tensor, jitter: float = 1e-6) -> torch.Tensor:
        """Exact posterior variance ``σ²(q) = q^T A^{-1} q`` per head, shape ``[..., H]``."""
        orig_lead = queries.shape[:-2]
        H, d = self.A.shape[0], self.A.shape[1]
        q = queries.reshape(-1, H, d).to(device=self.A.device, dtype=self.A.dtype)
        eye = torch.eye(d, device=self.A.device, dtype=self.A.dtype).unsqueeze(0)
        q_perm = q.permute(1, 2, 0)  # [H, d, M]
        L, info = torch.linalg.cholesky_ex(self.A + jitter * eye)
        if (info != 0).any():
            A_inv_q = torch.linalg.solve(self.A + 1e-4 * eye, q_perm)
        else:
            A_inv_q = torch.cholesky_solve(q_perm, L)
        var = (q_perm * A_inv_q).sum(dim=1).transpose(0, 1).clamp_min(0.0)  # [M, H]
        return var.reshape(*orig_lead, H).to(queries.dtype)

    def expected_information_gain(
        self,
        candidate_queries: torch.Tensor,
        expected_precision: float | torch.Tensor = 1.0,
    ) -> torch.Tensor:
        """Closed-form Shannon Expected Information Gain ``0.5 * Σ_h log(1 + γ * q^T A^{-1} q)``.

        Args:
            candidate_queries: ``[M, H, d]`` or ``[B, M, H, d]`` normalized probe vectors.
            expected_precision: scalar or ``[..., H]`` expected observation precision.
        Returns:
            EIG score ``[M]`` or ``[B, M]`` in nats (strictly >= 0).
        """
        var = self.epistemic_variance(candidate_queries)  # [..., H]
        gamma = (
            torch.as_tensor(expected_precision, device=var.device, dtype=var.dtype).clamp_min(0.0)
        )
        return 0.5 * torch.log1p(gamma * var).sum(dim=-1)

    def decay(self, rho: float, lam: float) -> "InformationFilterState":
        """Hippocampal forgetting: exponential fade of the whole state toward the prior.

        ``A <- lam·I + rho·(A - lam·I)``, ``B <- rho·B`` (same for incongruence mass
        and observation count). Directions re-written every turn survive in relative
        terms; stale one-off details fade to prior after ~1/(1-rho) turns. Keeps A
        exactly SPD (the ``A - lam·I`` part stays PSD under scaling).

        Args:
            rho: per-turn retention in [0, 1] (1.0 = perfect memory, no-op).
            lam: prior precision floor the state decays toward.
        """
        r = float(rho)
        if not 0.0 <= r <= 1.0:
            raise ValueError(f"rho must be in [0,1], got {rho}")
        eye = torch.eye(self.A.shape[-1], device=self.A.device, dtype=self.A.dtype).unsqueeze(0)
        A = lam * eye + r * (self.A - lam * eye)
        return replace(
            self,
            A=A,
            B=r * self.B,
            incongruence_mass=r * self.incongruence_mass,
            obs_count=r * self.obs_count,
        )

    def merge3(
        self,
        other: "InformationFilterState",
        base: "InformationFilterState",
    ) -> "InformationFilterState":
        """Exact three-way merge ``S_out = S_a + S_b - S_base`` with SPD ancestry guard."""
        if abs(self.lam - other.lam) > 1e-12 or abs(self.lam - base.lam) > 1e-12:
            raise ValueError("cannot merge states with mismatched prior lambda")
        # Idempotent fast-path for identical branches
        if torch.equal(self.A, other.A) and torch.equal(self.B, other.B):
            return self.detach()

        A_out = 0.5 * ((self.A + other.A - base.A) + (self.A + other.A - base.A).transpose(-1, -2))
        B_out = self.B + other.B - base.B
        inc_out = (self.incongruence_mass + other.incongruence_mass - base.incongruence_mass).clamp_min(0.0)
        cnt_out = self.obs_count + other.obs_count - base.obs_count

        if float(cnt_out.item()) < -1e-5:
            raise ValueError("negative merged observation count: base is not a valid common ancestor")
        # Verify A_out remains positive definite (eigenvalues >= 0.5 * lam)
        min_eig = torch.linalg.eigvalsh(A_out.double()).amin().item()
        if min_eig <= 0.0:
            raise ValueError(
                f"merged precision matrix lost positive-definiteness (min_eig={min_eig:.3e}); "
                "base is not a valid ancestor of both branches"
            )
        return InformationFilterState(
            A=A_out,
            B=B_out,
            lam=self.lam,
            incongruence_mass=inc_out,
            obs_count=cnt_out.clamp_min(0.0),
        )


def batched_filter_observe(
    keys: torch.Tensor,
    values: torch.Tensor,
    precision_gate: torch.Tensor,
    lam: float,
    suspicion: tuple[torch.Tensor, torch.Tensor] | None = None,
) -> torch.Tensor:
    """Per-sample precision matrix from per-turn observations.

    Args:
        keys/values: ``[B, T, H, d]`` per-turn filter keys/values.
        precision_gate: ``[B, T, H]`` heteroscedastic write precisions γ_t.
        suspicion: optional ``(dirs [B, T, H, d], precisions [B, T, H])`` orthogonal
            suspicion writes (Block 2b) folded into the same per-sample precision.
    Returns:
        A: ``[B, H, d, d]`` per-sample precision ``λI + Σ_t γ_t k_t k_t^T (+ Σ_t g_s q_s q_s^T)``.
    """
    if keys.dim() != 4 or values.shape != keys.shape:
        raise ValueError(f"expected keys/values [B,T,H,d], got {tuple(keys.shape)}")
    g = precision_gate.clamp_min(0.0).to(keys.dtype)
    dA = torch.einsum("bth,bthi,bthj->bhij", g, keys, keys)
    if suspicion is not None:
        s_dirs, s_prec = suspicion
        gsp = s_prec.clamp_min(0.0).to(keys.dtype)
        dAs = torch.einsum("bth,bthi,bthj->bhij", gsp, s_dirs, s_dirs)
        dA = dA + dAs
    dA = 0.5 * (dA + dA.transpose(-1, -2))
    d = keys.shape[-1]
    eye = torch.eye(d, device=keys.device, dtype=keys.dtype)
    return lam * eye + dA


def batched_epistemic_eig(
    A: torch.Tensor,
    queries: torch.Tensor,
    expected_precision: float = 1.0,
    jitter: float = 1e-6,
) -> torch.Tensor:
    """Closed-form per-sample EIG ``0.5 * Σ_h log(1 + γ q^T A^{-1} q)``.

    Args:
        A: ``[B, H, d, d]`` per-sample precision matrices.
        queries: ``[B, K, H, d]`` candidate probe directions.
    Returns:
        EIG scores ``[B, K]`` in nats.
    """
    B, H, d, _ = A.shape
    eye = torch.eye(d, device=A.device, dtype=A.dtype).expand(H, d, d)
    qph = queries.permute(0, 2, 3, 1).contiguous()          # [B, H, d, K]
    L, info = torch.linalg.cholesky_ex(A + jitter * eye)
    if bool((info != 0).any()):
        A_inv_q = torch.linalg.solve(A + 1e-4 * eye, qph)
    else:
        A_inv_q = torch.cholesky_solve(qph, L)              # [B, H, d, K]
    var = (qph * A_inv_q).sum(dim=2).clamp_min(0.0)         # [B, H, K]
    gamma = float(expected_precision)
    return 0.5 * torch.log1p(gamma * var).sum(dim=1)        # [B, K]


@dataclass(frozen=True)
class BatchedInformationFilterState:
    """Strictly per-sample ``(A, B)`` state: one filter per sequence in the batch.

    ``InformationFilterState`` accumulates *all* tokens of a batch into a single
    ``[H, d, d]`` filter.  That is correct at inference (B = 1) but during batched
    training it lets sample ``i`` read evidence written by sample ``j`` — the
    warm-prefix pass contaminates every suffix.  This class keeps ``A/B`` as
    ``[B, H, d, d]`` so each sample owns its sufficient statistics and the
    per-sample read is mathematically identical to an unbatched run of the same
    episode.

    All ops mirror ``InformationFilterState``; ``merge3`` merges sample-wise.
    """

    A: torch.Tensor              # [B, H, d, d]
    B: torch.Tensor              # [B, H, d, d]
    lam: float
    incongruence_mass: torch.Tensor  # [B, H]
    obs_count: torch.Tensor          # [B]

    @property
    def batch_size(self) -> int:
        return int(self.A.shape[0])

    @classmethod
    def prior(
        cls,
        batch_size: int,
        heads: int,
        dim: int,
        *,
        lam: float = 0.10,
        device: torch.device | str | None = None,
        dtype: torch.dtype = torch.float32,
    ) -> "BatchedInformationFilterState":
        if batch_size <= 0 or heads <= 0 or dim <= 0 or not (lam > 0.0):
            raise ValueError("batch_size, heads, dim, and lam must be strictly positive")
        eye = torch.eye(dim, device=device, dtype=dtype).view(1, 1, dim, dim)
        return cls(
            A=(eye * float(lam)).expand(batch_size, heads, dim, dim).clone(),
            B=torch.zeros(batch_size, heads, dim, dim, device=device, dtype=dtype),
            lam=float(lam),
            incongruence_mass=torch.zeros(batch_size, heads, device=device, dtype=dtype),
            obs_count=torch.zeros(batch_size, device=device, dtype=dtype),
        )

    def detach(self) -> "BatchedInformationFilterState":
        return replace(
            self,
            A=self.A.detach().clone(),
            B=self.B.detach().clone(),
            incongruence_mass=self.incongruence_mass.detach().clone(),
            obs_count=self.obs_count.detach().clone(),
        )

    def _match_batch(self, tensor: torch.Tensor, name: str) -> torch.Tensor:
        if tensor.shape[0] == 1 and self.batch_size > 1:
            tensor = tensor.expand(self.batch_size, *tensor.shape[1:])
        if tensor.shape[0] != self.batch_size:
            raise ValueError(
                f"{name} batch {tensor.shape[0]} does not match state batch {self.batch_size}"
            )
        return tensor

    def _as_batched_tokens(self, tensor: torch.Tensor, name: str) -> torch.Tensor:
        """Normalize ``[H,d]`` / ``[B,H,d]`` / ``[B,T,H,d]`` to ``[B,T,H,d]``."""
        if tensor.dim() == 2:
            tensor = tensor.unsqueeze(0).unsqueeze(0)
        elif tensor.dim() == 3:
            tensor = tensor.unsqueeze(1)
        if tensor.dim() != 4:
            raise ValueError(f"{name} must have shape [B,T,H,d] or [B,H,d], got {tuple(tensor.shape)}")
        return self._match_batch(tensor, name)

    def _as_batched_gate(self, tensor: torch.Tensor, name: str) -> torch.Tensor:
        """Normalize ``[H]`` / ``[B,H]`` / ``[B,T,H]`` to ``[B,T,H]``."""
        if tensor.dim() == 1:
            tensor = tensor.unsqueeze(0).unsqueeze(0)
        elif tensor.dim() == 2:
            tensor = tensor.unsqueeze(1)
        if tensor.dim() != 3:
            raise ValueError(f"{name} must have shape [B,T,H] or [B,H], got {tuple(tensor.shape)}")
        return self._match_batch(tensor, name)

    def observe(
        self,
        keys: torch.Tensor,
        values: torch.Tensor,
        precision_gate: torch.Tensor,
        incongruence: torch.Tensor | None = None,
        suspicion_dir: torch.Tensor | None = None,
        suspicion_value: torch.Tensor | None = None,
        suspicion_precision: torch.Tensor | None = None,
    ) -> "BatchedInformationFilterState":
        """Per-sample Bayesian precision update from ``[B,T,H,d]`` observations."""
        k = self._as_batched_tokens(keys, "keys").to(device=self.A.device, dtype=self.A.dtype)
        v = self._as_batched_tokens(values, "values").to(device=self.A.device, dtype=self.A.dtype)
        if v.shape != k.shape:
            raise ValueError(f"values shape {tuple(v.shape)} != keys shape {tuple(k.shape)}")
        g = self._as_batched_gate(precision_gate, "precision_gate")
        g = g.to(device=self.A.device, dtype=self.A.dtype).clamp_min(0.0)  # [B,T,H]

        dA = torch.einsum("bth,bthi,bthj->bhij", g, k, k)
        dA = 0.5 * (dA + dA.transpose(-1, -2))
        dB = torch.einsum("bth,bthv,bthk->bhvk", g, v, k)

        if suspicion_dir is not None and suspicion_precision is not None:
            qs = self._as_batched_tokens(suspicion_dir, "suspicion_dir").to(self.A.dtype)
            gs = self._as_batched_gate(suspicion_precision, "suspicion_precision")
            gs = gs.to(self.A.dtype).clamp_min(0.0)
            dAs = torch.einsum("bth,bthi,bthj->bhij", gs, qs, qs)
            dA = dA + 0.5 * (dAs + dAs.transpose(-1, -2))
            if suspicion_value is not None:
                vs = self._as_batched_tokens(suspicion_value, "suspicion_value").to(self.A.dtype)
                dB = dB + torch.einsum("bth,bthv,bthk->bhvk", gs, vs, qs)

        inc = self.incongruence_mass
        if incongruence is not None:
            inc_t = self._as_batched_gate(incongruence, "incongruence").to(self.A.dtype)
            if inc_t.shape[-1] == 1:
                inc_t = inc_t.expand(*inc_t.shape[:-1], self.A.shape[1])
            inc = inc + inc_t.clamp_min(0.0).sum(dim=1)

        return replace(
            self,
            A=self.A + dA,
            B=self.B + dB,
            incongruence_mass=inc,
            obs_count=self.obs_count + g.mean(dim=-1).sum(dim=-1),
        )

    def posterior_mean(self, queries: torch.Tensor, jitter: float = 1e-6) -> torch.Tensor:
        """Per-sample posterior mean ``μ(q) = B A^{-1} q`` for ``queries [B,T,H,d]``."""
        Bsz, K, H, d = queries.shape
        if Bsz != self.batch_size:
            raise ValueError(f"query batch {Bsz} does not match state batch {self.batch_size}")
        q = queries.to(device=self.A.device, dtype=self.A.dtype)
        eye = torch.eye(d, device=self.A.device, dtype=self.A.dtype).view(1, 1, d, d)
        q_ph = q.permute(0, 2, 3, 1).contiguous()  # [B,H,d,K]
        L, info = torch.linalg.cholesky_ex(self.A + jitter * eye)
        if bool((info != 0).any()):
            A_inv_q = torch.linalg.solve(self.A + 1e-4 * eye, q_ph)
        else:
            A_inv_q = torch.cholesky_solve(q_ph, L)
        out = torch.einsum("bhvd,bhdm->bmhv", self.B, A_inv_q)  # [B,K,H,d]
        return out.reshape(queries.shape).to(queries.dtype)

    def epistemic_variance(self, queries: torch.Tensor, jitter: float = 1e-6) -> torch.Tensor:
        """Per-sample exact posterior variance ``σ²(q) = q^T A^{-1} q`` → ``[B,T,H]``."""
        Bsz, K, H, d = queries.shape
        if Bsz != self.batch_size:
            raise ValueError(f"query batch {Bsz} does not match state batch {self.batch_size}")
        q = queries.to(device=self.A.device, dtype=self.A.dtype)
        eye = torch.eye(d, device=self.A.device, dtype=self.A.dtype).view(1, 1, d, d)
        q_ph = q.permute(0, 2, 3, 1).contiguous()  # [B,H,d,K]
        L, info = torch.linalg.cholesky_ex(self.A + jitter * eye)
        if bool((info != 0).any()):
            A_inv_q = torch.linalg.solve(self.A + 1e-4 * eye, q_ph)
        else:
            A_inv_q = torch.cholesky_solve(q_ph, L)
        var = (q_ph * A_inv_q).sum(dim=2).clamp_min(0.0)  # [B,H,K]
        return var.permute(0, 2, 1).to(queries.dtype)

    def expected_information_gain(
        self, candidate_queries: torch.Tensor, expected_precision: float = 1.0
    ) -> torch.Tensor:
        """Per-sample EIG ``0.5·Σ_h log(1 + γ q^T A^{-1} q)`` for ``[B,K,H,d]`` queries."""
        return batched_epistemic_eig(self.A, candidate_queries, expected_precision)

    def decay(self, rho: float, lam: float) -> "BatchedInformationFilterState":
        """Per-sample hippocampal forgetting toward the prior."""
        r = float(rho)
        if not 0.0 <= r <= 1.0:
            raise ValueError(f"rho must be in [0,1], got {rho}")
        eye = torch.eye(self.A.shape[-1], device=self.A.device, dtype=self.A.dtype).view(1, 1, *self.A.shape[-2:])
        return replace(
            self,
            A=lam * eye + r * (self.A - lam * eye),
            B=r * self.B,
            incongruence_mass=r * self.incongruence_mass,
            obs_count=r * self.obs_count,
        )

    def merge3(
        self,
        other: "BatchedInformationFilterState",
        base: "BatchedInformationFilterState",
    ) -> "BatchedInformationFilterState":
        """Exact sample-wise ``S_a + S_b - S_base`` with per-sample SPD ancestry guard."""
        if not (self.batch_size == other.batch_size == base.batch_size):
            raise ValueError("cannot merge batched states with different batch sizes")
        if abs(self.lam - other.lam) > 1e-12 or abs(self.lam - base.lam) > 1e-12:
            raise ValueError("cannot merge states with mismatched prior lambda")
        if torch.equal(self.A, other.A) and torch.equal(self.B, other.B):
            return self.detach()

        A_out = 0.5 * ((self.A + other.A - base.A) + (self.A + other.A - base.A).transpose(-1, -2))
        B_out = self.B + other.B - base.B
        inc_out = (self.incongruence_mass + other.incongruence_mass - base.incongruence_mass).clamp_min(0.0)
        cnt_out = self.obs_count + other.obs_count - base.obs_count
        if float(cnt_out.min().item()) < -1e-5:
            raise ValueError("negative merged observation count: base is not a valid common ancestor")
        min_eig = torch.linalg.eigvalsh(A_out.double()).amin().item()
        if min_eig <= 0.0:
            raise ValueError(
                f"merged precision matrix lost positive-definiteness (min_eig={min_eig:.3e}); "
                "base is not a valid ancestor of both branches"
            )
        return BatchedInformationFilterState(
            A=A_out,
            B=B_out,
            lam=self.lam,
            incongruence_mass=inc_out,
            obs_count=cnt_out.clamp_min(0.0),
        )


# ============================================================================
# 2. Cross-Modal Paralinguistic Incongruence & Heteroscedastic Precision Gate
# ============================================================================


class ProsodyIncongruenceGate(nn.Module):
    """Couples text representations with 12-D vocal prosody cues.

    Produces:
      - ``precision_gate`` γ_t in (0, 2): downweights literal text assertions when
        prosody betrays hesitation, stutter, or vocal tremor;
      - ``incongruence`` u_t in (0, 1): cross-modal conflict score;
      - ``fused`` [B, T, D]: prosody-modulated hidden representation.
    """

    def __init__(self, d_model: int, n_head: int, prosody_dim: int = PARALINGUISTIC_DIM) -> None:
        super().__init__()
        self.prosody_enc = nn.Sequential(
            nn.Linear(prosody_dim, d_model // 2),
            nn.SiLU(),
            nn.Linear(d_model // 2, d_model),
        )
        # Project both text and vocal prosody into a shared 32-D certainty/affect subspace
        self.text_cert_proj = nn.Linear(d_model, 32, bias=False)
        self.vocal_cert_proj = nn.Linear(prosody_dim, 32, bias=True)

        # Structural acoustic prior on hesitation/tension indices [0,1,2,3,6,7,8]
        self.tension_weights = nn.Linear(prosody_dim, 1, bias=True)
        with torch.no_grad():
            w = torch.zeros(1, prosody_dim)
            # Latency(0), Pause(1), Disfluency(2), FilledPause(3), RisingSlope(6), Jitter(7), Shimmer(8)
            for idx, val in ((0, 1.2), (1, 0.8), (2, 1.6), (3, 1.5), (6, 0.9), (7, 1.4), (8, 1.1), (10, -0.6)):
                if idx < prosody_dim:
                    w[0, idx] = val
            self.tension_weights.weight.copy_(w)
            self.tension_weights.bias.fill_(-1.1)

        self.to_precision = nn.Linear(d_model + 2, n_head)
        self.to_film = nn.Linear(d_model, 2 * d_model)
        nn.init.zeros_(self.to_film.weight)
        nn.init.zeros_(self.to_film.bias)

    def forward(
        self,
        h: torch.Tensor,
        prosody: Optional[torch.Tensor] = None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Args:
            h: ``[B, T, D]`` token/turn representations
            prosody: ``[B, P]`` or ``[B, T, P]`` 12-D acoustic features, or ``None`` (text-only mode)
        Returns:
            ``(fused_h [B,T,D], precision_gate [B,T,H], incongruence [B,T,1])``
        """
        B, T, D = h.shape
        if prosody is None:
            gate = F.softplus(self.to_precision(F.pad(h, (0, 2), value=0.0)))
            gate = 2.0 * gate / (1.0 + gate)
            inc = torch.zeros(B, T, 1, device=h.device, dtype=h.dtype)
            return h, gate, inc

        p = prosody.to(device=h.device, dtype=h.dtype)
        if p.dim() == 2:
            p = p.unsqueeze(1).expand(B, T, -1)

        t_vec = F.normalize(self.text_cert_proj(h), dim=-1)
        v_vec = F.normalize(self.vocal_cert_proj(p), dim=-1)
        semantic_mismatch = 0.5 * (1.0 - (t_vec * v_vec).sum(dim=-1, keepdim=True))  # [0, 1]
        vocal_tension = torch.sigmoid(self.tension_weights(p))  # [B, T, 1]

        # Incongruence spikes when vocal tension is high or cross-modal alignment breaks
        incongruence = (0.55 * vocal_tension + 0.45 * semantic_mismatch).clamp(0.0, 1.0)

        p_emb = self.prosody_enc(p)
        gamma_beta = self.to_film(p_emb)
        f_gamma, f_beta = gamma_beta.chunk(2, dim=-1)
        fused = (1.0 + 0.5 * torch.tanh(f_gamma)) * h + 0.5 * f_beta

        raw_prec = F.softplus(self.to_precision(torch.cat([fused, incongruence, vocal_tension], dim=-1)))
        # Attenuate literal write precision when speaker exhibits high vocal incongruence/hesitation
        attenuation = 1.0 - 0.75 * incongruence
        precision_gate = (2.0 * raw_prec / (1.0 + raw_prec)) * attenuation
        return fused, precision_gate, incongruence


# ============================================================================
# 3. Parallel Associative Scan + Adversarial Counter-Move Block
# ============================================================================


def parallel_affine_scan(decay: torch.Tensor, drive: torch.Tensor) -> torch.Tensor:
    """Exact O(log T) Hillis-Steele parallel prefix scan for ``s_t = decay_t * s_{t-1} + drive_t``.

    Args:
        decay: ``[B, T, ...]`` elementwise retention gates in ``(0, 1]``
        drive: ``[B, T, ...]`` additive inputs of identical shape
    """
    a = decay
    b = drive
    T = a.shape[1]
    offset = 1
    extra_dims = a.dim() - 2
    while offset < T:
        pad_spec = (0, 0) * extra_dims + (offset, 0)
        a_shift = F.pad(a[:, :-offset], pad_spec, value=1.0)
        b_shift = F.pad(b[:, :-offset], pad_spec, value=0.0)
        b = a * b_shift + b
        a = a * a_shift
        offset <<= 1
    return b


class RMSNorm(nn.Module):
    def __init__(self, d: int, eps: float = 1e-6) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(d))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.weight * x * torch.rsqrt(x.float().pow(2).mean(-1, keepdim=True) + self.eps).to(x.dtype)


class NonCrossingQuantileHead(nn.Module):
    """Predicts 5 strictly monotonic outcome quantiles ``[Q10,Q30,Q50,Q70,Q90]`` + ``P_ruin``.

    Guarantees ``Q10 <= Q30 <= Q50 <= Q70 <= Q90`` for every input by construction
    (median anchor + positive softplus increments), avoiding quantile-crossing bugs.
    """

    def __init__(self, d_model: int) -> None:
        super().__init__()
        self.net = nn.Sequential(
            RMSNorm(d_model),
            nn.Linear(d_model, d_model // 2),
            nn.SiLU(),
        )
        self.to_median = nn.Linear(d_model // 2, 1)
        self.to_spreads = nn.Linear(d_model // 2, 4)  # 2 below median, 2 above median
        self.to_ruin = nn.Linear(d_model // 2, 1)

    def forward(self, h: torch.Tensor) -> dict[str, torch.Tensor]:
        z = self.net(h)
        q50 = torch.tanh(self.to_median(z)) * 10.0  # [-10, +10] stakes scale
        deltas = F.softplus(self.to_spreads(z)) * 2.5
        q30 = q50 - deltas[..., 0:1]
        q10 = q30 - deltas[..., 1:2]
        q70 = q50 + deltas[..., 2:3]
        q90 = q70 + deltas[..., 3:4]
        quantiles = torch.cat([q10, q30, q50, q70, q90], dim=-1)
        ruin_prob = torch.sigmoid(self.to_ruin(z)).squeeze(-1)
        spread = (q90 - q10).squeeze(-1)
        return {
            "quantiles": quantiles,
            "ruin_prob": ruin_prob,
            "spread": spread,
        }


QuantileStakesHead = NonCrossingQuantileHead


def pinball_quantile_loss(pred_quantiles: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """Exact Pinball (check) loss across ``QUANTILE_LEVELS = (0.1, 0.3, 0.5, 0.7, 0.9)``."""
    taus = torch.tensor(QUANTILE_LEVELS, device=pred_quantiles.device, dtype=pred_quantiles.dtype)
    y = target.unsqueeze(-1) if target.dim() == pred_quantiles.dim() - 1 else target
    diff = y - pred_quantiles
    return torch.maximum(taus * diff, (taus - 1.0) * diff).mean()


class EpistemicWorldlineBlock(nn.Module):
    """Single PAI-SSM layer: Parallel Scan + Adversarial Counter-Stream + Info-Filter Read/Write."""

    def __init__(self, cfg: EpistemicConfig, layer_idx: int = 0) -> None:
        super().__init__()
        D, H, ds = cfg.d_model, cfg.n_head, cfg.d_state
        self.H = H
        self.ds = ds
        self.prior_lam = cfg.prior_lam

        self.norm1 = RMSNorm(D)
        # Parallel associative sequence mixer (fast stream + durable commutative band)
        self.to_q = nn.Linear(D, H * ds, bias=False)
        self.to_k = nn.Linear(D, H * ds, bias=False)
        self.to_v = nn.Linear(D, H * ds, bias=False)
        self.to_decay = nn.Linear(D, H)
        self.to_gate = nn.Linear(D, H * ds)
        nn.init.constant_(self.to_decay.bias, 2.5)

        # Adversarial counter-move projection: models pushback/resistance rather than sycophancy
        self.adv_counter = nn.Sequential(
            nn.Linear(D, D // 2, bias=False),
            nn.SiLU(),
            nn.Linear(D // 2, H * ds, bias=False),
        )
        self.adv_mix = nn.Parameter(torch.tensor(0.25))
        self.uncertainty_proj = nn.Linear(H, D, bias=True)
        self.to_out = nn.Linear(H * ds, D, bias=False)

        # Block 2b: orthogonal suspicion channel. A FIXED per-head direction q_s in
        # filter space (orthogonalized against each turn's literal claim key k at
        # write time) receives a HIGH-precision write of the learnable suspicion
        # value whenever verbal-vocal incongruence fires — suspicion is physically
        # engraved into W_fast without contaminating the literal claim subspace.
        self.use_suspicion = cfg.suspicion_write
        # Block 1 ablation switch (runtime only, not persisted in config):
        # when False the block still writes (A,B) but never reads persistent
        # cross-turn memory, isolating the memory-read contribution.
        self.use_memory_read = True
        self.suspicion_strength = float(cfg.suspicion_strength)
        gen = torch.Generator().manual_seed(20261118)
        self.suspicion_dir = nn.Parameter(
            F.normalize(torch.randn(H, ds, generator=gen), dim=-1), requires_grad=False
        )
        self.suspicion_val = nn.Parameter(torch.zeros(H, ds))

        # Block 2c: cognitive personality-bias operators — fixed (direction, value)
        # pseudo-observations per bias, injected into (A,B) at inference time so the
        # SAME event is reasoned through different cognitive lenses. Non-persistent
        # buffers: deterministically regenerated per layer, no ckpt bloat.
        gen_d = torch.Generator().manual_seed(20261119 + layer_idx)
        gen_v = torch.Generator().manual_seed(777000 + layer_idx)
        nb = cfg.n_personality_biases
        self.register_buffer(
            "bias_dir", F.normalize(torch.randn(nb, H, ds, generator=gen_d), dim=-1), persistent=False
        )
        self.register_buffer("bias_val", torch.randn(nb, H, ds, generator=gen_v) * 0.5, persistent=False)

        # SwiGLU channel mix
        self.norm2 = RMSNorm(D)
        ffn = int(D * 8 // 3)
        self.w1 = nn.Linear(D, ffn, bias=False)
        self.w2 = nn.Linear(D, ffn, bias=False)
        self.w3 = nn.Linear(ffn, D, bias=False)

    def forward(
        self,
        x: torch.Tensor,
        precision_gate: torch.Tensor,
        incongruence: torch.Tensor,
        info_state: Optional[InformationFilterState | BatchedInformationFilterState] = None,
        update_state: bool = True,
        collect_kv: bool = False,
    ) -> tuple[
        torch.Tensor,
        InformationFilterState | BatchedInformationFilterState,
        torch.Tensor,
        Optional[tuple],
    ]:
        B, T, D = x.shape
        H, ds = self.H, self.ds
        u = self.norm1(x)

        q = F.normalize(self.to_q(u).view(B, T, H, ds), dim=-1)
        k = F.normalize(self.to_k(u).view(B, T, H, ds), dim=-1)
        v_self = self.to_v(u).view(B, T, H, ds)
        v_adv = self.adv_counter(u).view(B, T, H, ds)
        v = v_self - torch.tanh(self.adv_mix) * v_adv

        decay = (0.05 + 0.945 * torch.sigmoid(self.to_decay(u))).unsqueeze(-1)  # [B,T,H,1]
        drive = precision_gate.unsqueeze(-1) * k * v  # [B,T,H,ds]
        scan_out = parallel_affine_scan(decay.expand_as(drive), drive)

        if info_state is None:
            info_state = InformationFilterState.prior(
                H, ds, lam=self.prior_lam, device=x.device, dtype=torch.float32
            )

        # Read persistent cross-branch belief mean & exact epistemic variance BEFORE writing current segment
        if self.use_memory_read:
            mem_mean = info_state.posterior_mean(q)          # [B, T, H, ds]
            epistemic_var = info_state.epistemic_variance(q) # [B, T, H]
        else:
            mem_mean = torch.zeros_like(q)
            epistemic_var = torch.zeros(B, T, H, device=x.device, dtype=q.dtype)

        combined = (scan_out + mem_mean) * torch.sigmoid(self.to_gate(u).view(B, T, H, ds))
        y = self.to_out(combined.reshape(B, T, H * ds)) + 0.15 * self.uncertainty_proj(epistemic_var)
        x = x + y
        x = x + self.w3(F.silu(self.w1(self.norm2(x))) * self.w2(self.norm2(x)))

        if update_state:
            if isinstance(info_state, BatchedInformationFilterState):
                # Strict per-sample state: each sequence owns its own (A, B), so no
                # sample can read evidence written by another in the same batch.
                inc_bt = incongruence.expand(B, T, H).float()
                if self.use_suspicion:
                    u = inc_bt.clamp_min(0.0)                                # [B,T,H]
                    qs = self.suspicion_dir.detach().float().view(1, 1, H, ds).expand(B, T, H, ds)
                    qs = qs - (qs * k.float()).sum(dim=-1, keepdim=True) * k.float()
                    qn = qs.norm(dim=-1, keepdim=True)
                    qs = torch.where(qn > 1e-6, qs / qn.clamp_min(1e-6), torch.zeros_like(qs))
                    gs = self.suspicion_strength * u
                    vs = self.suspicion_val.float().view(1, 1, H, ds).expand(B, T, H, ds)
                    info_state = info_state.observe(
                        k.float(), v.float(), precision_gate.float(), inc_bt,
                        suspicion_dir=qs, suspicion_value=vs, suspicion_precision=gs,
                    )
                    suspicion = (qs, gs)
                else:
                    info_state = info_state.observe(k.float(), v.float(), precision_gate.float(), inc_bt)
                    suspicion = None
            else:
                flat_k = k.reshape(B * T, H, ds).float()
                flat_v = v.reshape(B * T, H, ds).float()
                flat_g = precision_gate.reshape(B * T, H).float()
                flat_inc = incongruence.expand(B, T, H).reshape(B * T, H).float()
                suspicion = None
                if self.use_suspicion:
                    u = flat_inc.clamp_min(0.0)                                  # [N,H]
                    qs = self.suspicion_dir.detach().float().unsqueeze(0).expand_as(flat_k)
                    # One-step Gram-Schmidt: q_s ⊥ k (literal claim direction), so the
                    # suspicion channel cannot leak into the claim subspace.
                    qs = qs - (qs * flat_k).sum(dim=-1, keepdim=True) * flat_k
                    qn = qs.norm(dim=-1, keepdim=True)
                    qs = torch.where(qn > 1e-6, qs / qn.clamp_min(1e-6), torch.zeros_like(qs))
                    gs = self.suspicion_strength * u                             # [N,H]
                    vs = self.suspicion_val.float().unsqueeze(0).expand_as(flat_k)
                    info_state = info_state.observe(
                        flat_k, flat_v, flat_g, flat_inc,
                        suspicion_dir=qs, suspicion_value=vs, suspicion_precision=gs,
                    )
                    suspicion = (
                        qs.view(B, T, H, ds), gs.view(B, T, H),
                    )
                else:
                    info_state = info_state.observe(flat_k, flat_v, flat_g, flat_inc)
        else:
            suspicion = None

        kv = (k, v, precision_gate, suspicion) if collect_kv else None
        return x, info_state, epistemic_var, kv


# ============================================================================
# 4. Full End-to-End Epistemic Worldline Model (LM + Stance + Quantiles + EIG)
# ============================================================================


class EpistemicWorldlineModel(nn.Module):
    """End-to-end 3rd-Gen Worldline Architecture (supports 30M -> 0.6B+ scaling)."""

    def __init__(self, cfg: EpistemicConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self.tok_emb = nn.Embedding(cfg.vocab_size, cfg.d_model)
        nn.init.normal_(self.tok_emb.weight, mean=0.0, std=0.02)

        self.prosody_gate = ProsodyIncongruenceGate(cfg.d_model, cfg.n_head, cfg.prosody_dim)
        self.blocks = nn.ModuleList([EpistemicWorldlineBlock(cfg, layer_idx=i) for i in range(cfg.n_layer)])
        self.norm_f = RMSNorm(cfg.d_model)

        # Output heads:
        # 1) Language / token prediction head (weight-tied with tok_emb)
        # 2) Anti-sycophancy stance head (6 discrete stances). Input carries the
        #    suspicion-channel currents [L*H] read from the UPDATED states, so the
        #    learnable suspicion value is trained end to end within a single pass.
        # 3) Non-crossing Quantile Stakes + Ruin probability head
        # 4) Active Epistemic Probe query projector
        self.stance_head = nn.Linear(
            cfg.d_model + cfg.n_head + 1 + cfg.n_layer * cfg.n_head, cfg.n_stances
        )
        self.stakes_head = NonCrossingQuantileHead(cfg.d_model)
        self.probe_query_proj = nn.Linear(cfg.d_model, cfg.n_head * cfg.d_state, bias=False)

        # Block 5: L2 product-key paged memory (optional; L1 stays the info-filter state)
        self.paged: Optional[ProductKeyPagedMemory] = None
        if cfg.paged_memory:
            self.paged = ProductKeyPagedMemory(cfg.d_model, sub_keys=cfg.paged_sub_keys, top_k=cfg.paged_top_k)

        # Block 4: learnable probe-aspect suspicion directions q_a in filter space,
        # ranked each step by closed-form EIG x stakes (closed-loop probe policy).
        self.probe_aspect_emb = nn.Parameter(
            torch.randn(cfg.n_probes, cfg.n_head * cfg.d_state) / math.sqrt(cfg.n_head * cfg.d_state)
        )

    def num_parameters(self, non_embedding: bool = False) -> int:
        total = sum(p.numel() for p in self.parameters())
        if non_embedding:
            total -= self.tok_emb.weight.numel()
        return total

    def init_world_state(
        self, device: torch.device | str | None = None, dtype: torch.dtype = torch.float32
    ) -> list[InformationFilterState]:
        dev = device if device is not None else self.tok_emb.weight.device
        return [
            InformationFilterState.prior(
                self.cfg.n_head, self.cfg.d_state, lam=self.cfg.prior_lam, device=dev, dtype=dtype
            )
            for _ in range(self.cfg.n_layer)
        ]

    def init_batched_world_state(
        self,
        batch_size: int,
        device: torch.device | str | None = None,
        dtype: torch.dtype = torch.float32,
    ) -> list[BatchedInformationFilterState]:
        """Per-sample ``(A, B)`` state for strictly independent batched training."""
        dev = device if device is not None else self.tok_emb.weight.device
        return [
            BatchedInformationFilterState.prior(
                batch_size,
                self.cfg.n_head,
                self.cfg.d_state,
                lam=self.cfg.prior_lam,
                device=dev,
                dtype=dtype,
            )
            for _ in range(self.cfg.n_layer)
        ]

    @staticmethod
    def merge3_world_states(
        branch_a: list[InformationFilterState | BatchedInformationFilterState],
        branch_b: list[InformationFilterState | BatchedInformationFilterState],
        base: list[InformationFilterState | BatchedInformationFilterState],
    ) -> list[InformationFilterState | BatchedInformationFilterState]:
        if not (len(branch_a) == len(branch_b) == len(base)):
            raise ValueError("world state layer count mismatch")
        return [sa.merge3(sb, s0) for sa, sb, s0 in zip(branch_a, branch_b, base)]

    def init_page_table(self) -> Optional[CoWPageTable]:
        """Fresh L2 page table. ``fork()`` on the table gives O(1) worldline branching."""
        if self.paged is None:
            return None
        return self.paged.new_table()

    def forward(
        self,
        input_ids: torch.Tensor,
        prosody: Optional[torch.Tensor] = None,
        world_state: Optional[list[InformationFilterState | BatchedInformationFilterState]] = None,
        update_state: bool = True,
        page_table: Optional[CoWPageTable] = None,
        collect_kv: bool = False,
    ) -> dict[str, torch.Tensor | list[InformationFilterState]]:
        x = self.tok_emb(input_ids)
        x, prec_gate, incongruence = self.prosody_gate(x, prosody)

        states_in = world_state if world_state is not None else self.init_world_state(x.device)
        if self.cfg.forget_rate > 0.0:
            states_in = [s.decay(self.cfg.forget_rate, self.cfg.prior_lam) for s in states_in]
        states_out: list[InformationFilterState] = []
        var_acc = []
        kv_acc: list[tuple] = []

        for blk, st in zip(self.blocks, states_in):
            x, st_next, ep_var, kv = blk(
                x, prec_gate, incongruence, st, update_state=update_state, collect_kv=collect_kv
            )
            states_out.append(st_next)
            var_acc.append(ep_var)
            if kv is not None:
                kv_acc.append(kv)

        # Block 5 (L2 paged memory): pointer-addressed retrieval fused before the
        # final norm. Writes are turn-end only (see below) so the L2 stays sparse.
        if self.paged is not None and page_table is not None:
            x = self.paged.read(page_table, x)

        h = self.norm_f(x)
        logits = F.linear(h, self.tok_emb.weight)

        # Per-position stakes field (Block 3 training): the SAME head used by
        # project_future_field reads every position/horizon, so supervising these
        # outputs trains the one-shot future field end to end.
        stakes_seq = self.stakes_head(h)

        # Pool turn-final summary for deliberation & stance heads
        h_last = h[:, -1, :]                                   # [B, D]
        mean_var = torch.stack(var_acc, dim=0).mean(dim=0)[:, -1, :]  # [B, H]
        inc_last = incongruence[:, -1, :]                      # [B, 1]

        stance_logits = self.stance_head(
            torch.cat(
                [
                    h_last,
                    mean_var,
                    inc_last,
                    self._stance_suspicion_rows(states_out, input_ids.shape[0]).to(x.dtype),
                ],
                dim=-1,
            )
        )
        stakes = self.stakes_head(h_last)

        # L2 write policy: turn-end fact = final-position hidden (claim + accumulated
        # evidence), stored under its own content address. CPU-resident, CoW-friendly.
        if self.paged is not None and page_table is not None and update_state:
            with torch.no_grad():
                tail = x[:, -1, :].detach()
                for b in range(tail.shape[0]):
                    self.paged.write(page_table, tail[b], tail[b])

        return {
            "logits": logits,
            "hidden_last": h_last,
            "stance_logits": stance_logits,
            "quantiles": stakes["quantiles"],
            "ruin_prob": stakes["ruin_prob"],
            "stakes_spread": stakes["spread"],
            "quantiles_seq": stakes_seq["quantiles"],
            "ruin_seq": stakes_seq["ruin_prob"],
            "epistemic_var": mean_var,
            "incongruence": inc_last.squeeze(-1),
            "world_state": states_out,
            "kv": kv_acc if collect_kv else None,
        }

    @torch.no_grad()
    def rank_active_probes(
        self,
        world_state: list[InformationFilterState],
        candidate_probe_ids: torch.Tensor,
        stakes_spread: float = 5.0,
    ) -> dict[str, torch.Tensor]:
        """Rank ``M`` candidate probing questions by Expected Information Gain × Stakes Spread.

        Args:
            world_state: current layer-wise ``InformationFilterState`` list
            candidate_probe_ids: ``[M, L]`` tokenized candidate questions/probes
            stakes_spread: ``Q90 - Q10`` spread amplifying urgency of blind-spot resolution
        Returns:
            dict with ``eig [M]``, ``utility [M]``, and ``best_index`` (int tensor).
        """
        emb = self.norm_f(self.tok_emb(candidate_probe_ids)).mean(dim=1)  # [M, D]
        q = F.normalize(
            self.probe_query_proj(emb).view(-1, self.cfg.n_head, self.cfg.d_state),
            dim=-1,
        )
        eig_total = torch.zeros(q.shape[0], device=emb.device, dtype=torch.float32)
        for st in world_state:
            eig_total = eig_total + st.expected_information_gain(q)
        eig_mean = eig_total / float(len(world_state))
        utility = eig_mean * (1.0 + 0.25 * max(0.0, float(stakes_spread)))
        best_idx = torch.argmax(utility)
        return {
            "eig": eig_mean,
            "utility": utility,
            "best_index": best_idx,
        }

    def rank_probe_aspects(
        self,
        world_state: list[InformationFilterState],
        stakes_spread: torch.Tensor,
    ) -> dict[str, torch.Tensor]:
        """Rank the learnable probe-aspect directions by EIG x Stakes (trainable).

        Unlike ``rank_active_probes`` (token candidates, no_grad), this path is
        differentiable end to end: aspect embeddings live directly in filter
        space, so the closed-loop probe policy is learned by backprop.

        Args:
            world_state: current layer-wise ``InformationFilterState`` list.
            stakes_spread: ``[B]`` per-sample Q90-Q10 spread gating urgency.
        Returns:
            ``eig [K]``, ``utility [K]`` (spread-weighted), per aspect.
        """
        K = self.probe_aspect_emb.shape[0]
        q = F.normalize(
            self.probe_aspect_emb.view(K, self.cfg.n_head, self.cfg.d_state), dim=-1
        )
        eig_total = torch.zeros(K, device=self.probe_aspect_emb.device, dtype=torch.float32)
        for st in world_state:
            eig_total = eig_total + st.expected_information_gain(q)
        eig_mean = eig_total / float(len(world_state))
        spread = stakes_spread.to(eig_mean.device, dtype=eig_mean.dtype).mean().clamp_min(0.0)
        utility = eig_mean * (1.0 + 0.25 * spread)
        return {"eig": eig_mean, "utility": utility}

    def list_personality_biases(self) -> tuple[str, ...]:
        """Available cognitive bias operators (Block 2c)."""
        return PERSONALITY_BIAS_NAMES[: self.cfg.n_personality_biases]

    def apply_personality_bias(
        self,
        world_state: list[InformationFilterState],
        operator: str,
        gain: float = 1.0,
    ) -> list[InformationFilterState]:
        """Inject a cognitive-bias pseudo-observation into the (A,B) states.

        Each operator is a fixed per-layer/per-head (direction, value) pair written
        with precision ``|gain|`` — the SAME event is subsequently reasoned through
        a different cognitive lens ("激进 / 保守 / 受害者"), because posterior reads
        ``B·A⁻¹`` are shifted along the operator's subspace. Pure inference-time
        drift: no parameter update, states remain exactly mergeable afterwards.

        Args:
            world_state: current layer-wise information-filter states.
            operator: one of ``PERSONALITY_BIAS_NAMES``.
            gain: injection strength (0 = identity; sign flips the value direction).
        Returns:
            New state list (inputs untouched — immutable style like ``observe``).
        """
        names = self.list_personality_biases()
        if operator not in names:
            raise ValueError(f"unknown bias operator {operator!r}, available: {names}")
        idx = names.index(operator)
        g = float(gain)
        if g == 0.0:
            return world_state
        outs = []
        for st, blk in zip(world_state, self.blocks):
            q = blk.bias_dir[idx].unsqueeze(0).to(device=st.A.device, dtype=st.A.dtype)   # [1,H,d]
            v = blk.bias_val[idx].unsqueeze(0).to(device=st.A.device, dtype=st.A.dtype)
            if g < 0.0:
                v = -v
            prec = torch.full((1, blk.H), abs(g), device=st.A.device, dtype=st.A.dtype)
            outs.append(st.observe(q, v, prec))
        return outs

    def _suspicion_rows(
        self, world_state: list[InformationFilterState | BatchedInformationFilterState]
    ) -> torch.Tensor:
        """Differentiable per-layer suspicion current ``μ(q_s) · q_s``.

        Unbatched state → ``[L, H]``; per-sample state → ``[B, L, H]``.
        """
        batched = isinstance(world_state[0], BatchedInformationFilterState)
        rows = []
        for blk, st in zip(self.blocks, world_state):
            qs = blk.suspicion_dir.detach().float()          # [H, d]
            if batched:
                b = st.batch_size
                mu = st.posterior_mean(qs.view(1, 1, blk.H, blk.ds).expand(b, -1, -1, -1))
                rows.append((mu * qs).sum(dim=-1).squeeze(1))  # [B,H]
            else:
                mu = st.posterior_mean(qs)                   # [H, d]
                rows.append((mu * qs).sum(dim=-1))           # [H]
        return torch.stack(rows, dim=1 if batched else 0)

    def _stance_suspicion_rows(
        self,
        world_state: list[InformationFilterState | BatchedInformationFilterState],
        batch_size: int,
    ) -> torch.Tensor:
        """Flatten suspicion current to ``[B, L*H]`` for the stance head."""
        rows = self._suspicion_rows(world_state)
        if rows.dim() == 2:                                   # [L,H] unbatched
            return rows.reshape(1, -1).expand(batch_size, -1)
        return rows.reshape(batch_size, -1)                   # [B,L,H]

    @torch.no_grad()
    def suspicion_current(self, world_state: list[InformationFilterState]) -> torch.Tensor:
        """Per-layer suspicion-channel current ``μ(q_s) · q_s``  — how strongly the
        trained suspicion value fires along each block's fixed suspicion direction.

        Args:
            world_state: current layer-wise ``InformationFilterState`` list.
        Returns:
            ``[L, H]`` current per block/head (0 = no suspicion engraved yet).
        """
        return self._suspicion_rows(world_state)
