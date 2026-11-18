"""Weight-space averaging vs natural-parameter merge3 across diverging branches.

Produces the hard-number evidence slide for Block 1 (W_fast plasticity):

  * Weight-space branch: W_fast is maintained with the DeltaNet-style delta
    rule (online gradient descent on the associative map k -> v). Once two
    branches plasticate independently for D steps, naive averaging
    (Wa + Wb) / 2 is compared against the replayed W trained on the union.
  * Natural-parameter branch: the same observation streams are accumulated as
    (A, B) sufficient statistics and merged with the exact 3-way merge.

Weight-space averaging decays catastrophically with divergence (the two
trajectories leave the shared basin), while the (A, B) merge stays at machine
precision by algebra, not by approximation.

Usage:
  python -m epistemic_model.merge_ablation --out epistemic_model/runs/merge_ablation.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch


def _sample(gen: torch.Generator, n: int, heads: int, d: int):
    k = torch.nn.functional.normalize(torch.randn(n, heads, d, generator=gen, dtype=torch.float64), dim=-1)
    v = torch.randn(n, heads, d, generator=gen, dtype=torch.float64)
    g = torch.rand(n, heads, generator=gen, dtype=torch.float64) + 0.2
    return k, v, g


def delta_rule_train(W: torch.Tensor, k: torch.Tensor, v: torch.Tensor, eta: float) -> torch.Tensor:
    """One DeltaNet-style LMS update per observation; W [H, d, d], k/v [N, H, d]."""
    pred = torch.einsum("hij,nhj->nhi", W, k)
    err = v - pred
    W = W + eta * torch.einsum("nhi,nhj->hij", err, k)
    return W


def run(divergences: list[int], n_shared: int = 8, heads: int = 8, d: int = 32,
        eta: float = 0.5, lam: float = 0.10, seed: int = 7) -> list[dict[str, float]]:
    from .architecture import InformationFilterState

    gen = torch.Generator(device="cpu").manual_seed(seed)
    rows: list[dict[str, float]] = []
    for D in divergences:
        k0, v0, g0 = _sample(gen, n_shared, heads, d)
        ka, va, ga = _sample(gen, D, heads, d)
        kb, vb, gb = _sample(gen, D, heads, d)

        # --- Natural-parameter branches: base -> a / b, then merge3 ----------
        prior = InformationFilterState.prior(heads, d, lam=lam, dtype=torch.float64)
        base = prior.observe(k0, v0, g0)
        br_a = base.observe(ka, va, ga)
        br_b = base.observe(kb, vb, gb)
        merged = br_a.merge3(br_b, base)
        replay = prior.observe(
            torch.cat([k0, ka, kb], dim=0),
            torch.cat([v0, va, vb], dim=0),
            torch.cat([g0, ga, gb], dim=0),
        )
        num = (merged.A - replay.A).norm() + (merged.B - replay.B).norm()
        den = max(1e-30, replay.A.norm() + replay.B.norm())
        merge3_rel = (num / den).item()

        # --- Weight-space branches: shared W0, then divergent delta-rule ----
        W0 = torch.zeros(heads, d, d, dtype=torch.float64)
        for i in range(n_shared):
            W0 = delta_rule_train(W0, k0[i : i + 1], v0[i : i + 1], eta)
        Wa, Wb = W0.clone(), W0.clone()
        for i in range(D):
            Wa = delta_rule_train(Wa, ka[i : i + 1], va[i : i + 1], eta)
            Wb = delta_rule_train(Wb, kb[i : i + 1], vb[i : i + 1], eta)
        W_avg = 0.5 * (Wa + Wb)
        W_replay = W0
        for i in range(D):
            W_replay = delta_rule_train(W_replay, ka[i : i + 1], va[i : i + 1], eta)
            W_replay = delta_rule_train(W_replay, kb[i : i + 1], vb[i : i + 1], eta)
        w_rel = ((W_avg - W_replay).norm() / max(1e-30, W_replay.norm())).item()

        rows.append({
            "divergence_steps": D,
            "weight_avg_rel_err": round(w_rel, 6),
            "merge3_rel_err": merge3_rel,
        })
    return rows


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="epistemic_model/runs/merge_ablation.json")
    p.add_argument("--seed", type=int, default=7)
    args = p.parse_args()

    rows = run([0, 1, 2, 4, 8, 16, 32, 64], seed=args.seed)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {"experiment": "weight_avg_vs_merge3", "seed": args.seed, "rows": rows}
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"{'divergence':>10} | {'weight-avg rel err':>18} | {'merge3 rel err':>16}")
    print("-" * 52)
    for r in rows:
        print(f"{r['divergence_steps']:>10} | {r['weight_avg_rel_err']:>18.6f} | {r['merge3_rel_err']:>16.2e}")
    print(f"saved -> {out}")


if __name__ == "__main__":
    main()
