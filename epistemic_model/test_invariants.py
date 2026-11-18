"""Mathematical & behavioral invariant test suite for PAI-SSM (3rd-Gen Architecture).

Verifies the non-negotiable properties required for paper-grade claims
(I1..I22):
  I1. Acoustic Prosody Discrimination: stuttering/hesitant/rising-pitch speech is
      cleanly separated from resolute falling-pitch speech on raw waveforms.
  I2. Exact Parallel Scan == Sequential Recurrence (max error < 1e-5).
  I3. Exact 3-Way Merge == Full Sequential Replay to machine precision (~1e-15 in fp64)
      + Commutativity (merge3(a,b,0) == merge3(b,a,0)) + Idempotence.
  I4. Fail-Closed Non-Ancestor Guard: corrupted/wrong base state raises ValueError.
  I5. Monotonic Epistemic Uncertainty Reduction: observing along direction q strictly
      decreases posterior variance σ²(q) and Expected Information Gain EIG(q) > 0.
  I6. Verbal-Vocal Incongruence Gate: identical text tokens paired with nervous/stuttered
      prosody yield higher incongruence & lower literal write precision than resolute speech.
  I7. Non-Crossing Quantile Stakes Guarantee: Q10 <= Q30 <= Q50 <= Q70 <= Q90 everywhere.
  I8. End-to-End Gradient Flow + Active Blind-Spot Probe Selection (prefers unobserved axis).
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as F

from epistemic_model.prosody import ParalinguisticExtractor, synthesize_prosody_waveforms
from epistemic_model.future_field import project_future_field, robust_stance_decision
from epistemic_model.paged_memory import ProductKeyPagedMemory
from epistemic_model.architecture import (
    BatchedInformationFilterState,
    EpistemicConfig,
    EpistemicWorldlineModel,
    InformationFilterState,
    STANCE_LABELS,
    batched_epistemic_eig,
    batched_filter_observe,
    parallel_affine_scan,
    pinball_quantile_loss,
)
from epistemic_model.synthesis import FactKnowledgeBase, StyleMatrixBank, SynthesisOperator


def run_all_tests() -> None:
    torch.manual_seed(42)
    passed = 0

    def ok(name: str, detail: str = "") -> None:
        nonlocal passed
        passed += 1
        print(f"  [PASS {passed:02d}] {name}" + (f" :: {detail}" if detail else ""))

    print("=" * 74)
    print("PAI-SSM (3rd-Gen Active Epistemic Architecture) Invariant Verification")
    print("=" * 74)

    # ------------------------------------------------------------------
    # I1: Raw Waveform Paralinguistic Prosody Extraction
    # ------------------------------------------------------------------
    ext = ParalinguisticExtractor(sample_rate=16000)
    waves = synthesize_prosody_waveforms(sample_rate=16000, duration=2.0)
    f_res = ext(waves["resolute_falling"])
    f_nerv = ext(waves["nervous_hesitant"])
    f_low = ext(waves["low_suppressed"])

    assert torch.isfinite(f_res).all() and torch.isfinite(f_nerv).all() and torch.isfinite(f_low).all()
    # Nervous speech must have higher response latency [0], disfluency [2], jitter [7], and rising slope [6] > falling slope
    assert f_nerv[0] > f_res[0] + 0.10, f"latency {f_nerv[0]:.3f} vs {f_res[0]:.3f}"
    assert f_nerv[2] > f_res[2] + 0.15, f"disfluency {f_nerv[2]:.3f} vs {f_res[2]:.3f}"
    assert f_nerv[6] > 0.05 and f_res[6] < -0.05, f"F0 slope nerv={f_nerv[6]:.3f}, res={f_res[6]:.3f}"
    assert f_nerv[7] > f_res[7], f"jitter nerv={f_nerv[7]:.3f}, res={f_res[7]:.3f}"
    assert f_low[4] < f_res[4], f"mean F0 low={f_low[4]:.3f}, res={f_res[4]:.3f}"
    ok(
        "I1 Paralinguistic Waveform Discrimination",
        f"latency={f_nerv[0]:.2f}>{f_res[0]:.2f}, stutter={f_nerv[2]:.2f}>{f_res[2]:.2f}, "
        f"F0_slope={f_nerv[6]:+.2f}(rising) vs {f_res[6]:+.2f}(falling)",
    )

    # ------------------------------------------------------------------
    # I2: Parallel Associative Scan == Sequential Recurrence
    # ------------------------------------------------------------------
    decay = torch.rand(3, 64, 4, 16, dtype=torch.float64) * 0.9 + 0.05
    drive = torch.randn(3, 64, 4, 16, dtype=torch.float64)
    scan_y = parallel_affine_scan(decay, drive)
    seq = []
    s = torch.zeros(3, 4, 16, dtype=torch.float64)
    for t in range(64):
        s = decay[:, t] * s + drive[:, t]
        seq.append(s)
    seq_y = torch.stack(seq, dim=1)
    scan_err = (scan_y - seq_y).abs().max().item()
    assert scan_err < 1e-12, f"scan mismatch {scan_err}"
    ok("I2 Parallel Scan == Token Recurrence", f"fp64 max_diff={scan_err:.2e}")

    # ------------------------------------------------------------------
    # I3: Exact 3-Way Merge == Full Replay (Machine Precision) + Commutativity
    # ------------------------------------------------------------------
    H, d = 4, 16
    prior = InformationFilterState.prior(H, d, lam=0.1, dtype=torch.float64)
    k0, v0, g0 = F.normalize(torch.randn(10, H, d, dtype=torch.float64), dim=-1), torch.randn(10, H, d, dtype=torch.float64), torch.rand(10, H, dtype=torch.float64) + 0.2
    ka, va, ga = F.normalize(torch.randn(15, H, d, dtype=torch.float64), dim=-1), torch.randn(15, H, d, dtype=torch.float64), torch.rand(15, H, dtype=torch.float64) + 0.2
    kb, vb, gb = F.normalize(torch.randn(12, H, d, dtype=torch.float64), dim=-1), torch.randn(12, H, d, dtype=torch.float64), torch.rand(12, H, dtype=torch.float64) + 0.2

    base = prior.observe(k0, v0, g0)
    br_a = base.observe(ka, va, ga)
    br_b = base.observe(kb, vb, gb)

    merged_ab = br_a.merge3(br_b, base)
    merged_ba = br_b.merge3(br_a, base)
    replay_all = prior.observe(
        torch.cat([k0, ka, kb], dim=0),
        torch.cat([v0, va, vb], dim=0),
        torch.cat([g0, ga, gb], dim=0),
    )

    rel_err = ((merged_ab.A - replay_all.A).norm() + (merged_ab.B - replay_all.B).norm()) / (
        replay_all.A.norm() + replay_all.B.norm()
    )
    comm_err = (merged_ab.A - merged_ba.A).abs().max().item() + (merged_ab.B - merged_ba.B).abs().max().item()
    idem = br_a.merge3(br_a, base)
    idem_err = (idem.A - br_a.A).abs().max().item()

    assert rel_err.item() < 1e-14, f"merge3 replay error {rel_err.item()}"
    assert comm_err < 1e-14, f"commutativity error {comm_err}"
    assert idem_err == 0.0, f"idempotence error {idem_err}"
    ok("I3 Exact Merge3 == Replay & Commutativity", f"rel_err={rel_err.item():.2e}, comm_err={comm_err:.2e}")

    # ------------------------------------------------------------------
    # I4: Fail-Closed Invalid Ancestor Guard
    # ------------------------------------------------------------------
    bogus_base = base.observe(torch.randn(40, H, d, dtype=torch.float64), torch.randn(40, H, d, dtype=torch.float64), torch.ones(40, H, dtype=torch.float64) * 5.0)
    caught = False
    try:
        _ = br_a.merge3(br_b, bogus_base)
    except ValueError:
        caught = True
    assert caught, "expected ValueError on invalid ancestor"
    ok("I4 Fail-Closed Non-Ancestor Guard", "rejected non-ancestor base cleanly")

    # ------------------------------------------------------------------
    # I5: Monotonic Uncertainty Reduction & Closed-Form EIG
    # ------------------------------------------------------------------
    axis_known = F.normalize(torch.randn(1, H, d, dtype=torch.float64), dim=-1)
    axis_blind = F.normalize(torch.randn(1, H, d, dtype=torch.float64), dim=-1)
    var_before = prior.epistemic_variance(axis_known).mean().item()
    after_obs = prior.observe(axis_known.expand(8, H, d), torch.randn(8, H, d, dtype=torch.float64), torch.ones(8, H, dtype=torch.float64))
    var_after_known = after_obs.epistemic_variance(axis_known).mean().item()
    var_after_blind = after_obs.epistemic_variance(axis_blind).mean().item()

    eig_scores = after_obs.expected_information_gain(torch.cat([axis_known, axis_blind], dim=0))
    assert var_after_known < var_before * 0.25
    assert eig_scores[1] > eig_scores[0] * 1.5, f"blind spot EIG {eig_scores[1]:.3f} should exceed known {eig_scores[0]:.3f}"
    ok(
        "I5 Active Epistemic Blind-Spot Detection",
        f"known_EIG={eig_scores[0]:.3f} < blind_spot_EIG={eig_scores[1]:.3f} nats",
    )

    # ------------------------------------------------------------------
    # I6, I7, I8: Full Model Prosody Incongruence + Non-Crossing Quantiles + Backward
    # ------------------------------------------------------------------
    cfg = EpistemicConfig(vocab_size=1024, d_model=128, n_layer=4, n_head=4, d_state=16)
    model = EpistemicWorldlineModel(cfg)
    tokens = torch.randint(0, cfg.vocab_size, (2, 16))
    p_pair = torch.stack([f_res, f_nerv], dim=0)  # batch item 0: resolute, item 1: nervous/stutter

    out = model(tokens, prosody=p_pair, update_state=True)
    inc = out["incongruence"]
    assert inc[1] > inc[0], f"nervous incongruence {inc[1]:.3f} must exceed resolute {inc[0]:.3f}"
    ok("I6 Verbal-Vocal Incongruence Gate", f"resolute={inc[0]:.3f} vs nervous_stutter={inc[1]:.3f}")

    q = out["quantiles"]  # [B, 5]
    diffs = q[:, 1:] - q[:, :-1]
    assert (diffs >= -1e-6).all(), "quantile crossing detected!"
    ok("I7 Non-Crossing Outcome Quantiles", f"Q10..Q90={[round(v, 2) for v in q[1].tolist()]}")

    # Loss & backward check across all heads
    target_tokens = torch.randint(0, cfg.vocab_size, (2, 16))
    target_payoff = torch.tensor([6.5, -7.5])
    target_stance = torch.tensor([1, 3])
    target_ruin = torch.tensor([0.0, 1.0])

    lm_loss = F.cross_entropy(out["logits"].view(-1, cfg.vocab_size), target_tokens.view(-1))
    q_loss = pinball_quantile_loss(out["quantiles"], target_payoff)
    st_loss = F.cross_entropy(out["stance_logits"], target_stance)
    ruin_loss = F.binary_cross_entropy(out["ruin_prob"], target_ruin)
    total_loss = lm_loss + q_loss + st_loss + ruin_loss
    total_loss.backward()

    grad_norms = [p.grad.norm().item() for p in model.parameters() if p.grad is not None]
    assert len(grad_norms) > 20 and all(g == g for g in grad_norms)
    ok("I8 End-to-End Multi-Head Gradient Flow", f"total_loss={total_loss.item():.3f}, params={model.num_parameters():,}")

    # Active probe ranking smoke check
    probes = torch.randint(0, cfg.vocab_size, (4, 8))
    probe_rank = model.rank_active_probes(out["world_state"], probes, stakes_spread=float(out["stakes_spread"][1].item()))
    assert 0 <= int(probe_rank["best_index"].item()) < 4
    ok("I9 Active Probe Ranking", f"best_probe=#{probe_rank['best_index'].item()}, max_utility={probe_rank['utility'].max().item():.3f}")

    # ------------------------------------------------------------------
    # I10: Trinary Vector Projection — continuous style deformation
    # ------------------------------------------------------------------
    kb = FactKnowledgeBase.load()
    bank = StyleMatrixBank(content_dim=kb.dim, d_state=64, seed=7)
    op = SynthesisOperator(bank, kb)
    base_logits = torch.tensor([0.4, -0.2, 0.1, 0.9, -0.5, 0.2])

    def rotate_style(x: torch.Tensor, theta: float) -> torch.Tensor:
        y = x.clone()
        a, b = x[0].item(), x[3].item()
        y[0] = a * math.cos(theta) - b * math.sin(theta)
        y[3] = a * math.sin(theta) + b * math.cos(theta)
        return y

    expressions = []
    weight_paths = []
    for theta in (0.0, 1e-3, 2e-3, 4e-3):
        result = op.synthesize("F01", rotate_style(base_logits, theta))
        expressions.append(result["expression"])
        weight_paths.append(result["style_weights"])

    step_1 = (expressions[1] - expressions[0]).norm().item()
    step_2 = (expressions[2] - expressions[1]).norm().item()
    step_3 = (expressions[3] - expressions[2]).norm().item()
    cos_sim = F.cosine_similarity(expressions[0], expressions[1], dim=0).item()
    weight_step = (weight_paths[1] - weight_paths[0]).abs().sum().item()

    assert step_1 < 1e-2 and step_2 < 1e-2 and step_3 < 2e-2, (step_1, step_2, step_3)
    assert step_1 <= 50.0 * 1e-3 + 1e-6, step_1
    assert cos_sim > 0.99, cos_sim
    assert weight_step < 5e-2, weight_step

    result = op.synthesize("F01", base_logits)
    content = bank.project(kb.content("F01"))
    recovered = bank.invert(result["expression"], result["style_weights"])
    roundtrip = (recovered - content).abs().max().item()
    condition = result["path"]["condition_number"]
    assert roundtrip < 1e-5, roundtrip
    assert condition < 2.0, condition

    ok(
        "I10 Trinary Projection Continuity & Invertibility",
        f"lip_step={step_1:.2e}, cos={cos_sim:.6f}, roundtrip={roundtrip:.2e}, cond={condition:.3f}",
    )

    # ------------------------------------------------------------------
    # I11: One-Shot Multi-Horizon Future Field (Block 3)
    # ------------------------------------------------------------------
    model.eval()
    with torch.no_grad():
        field = project_future_field(model, out["hidden_last"], out["world_state"], horizons=6)
    qf = field["quantiles"]  # [B, H, 5]
    fd = qf[..., 1:] - qf[..., :-1]
    assert (fd >= -1e-6).all(), "future-field quantile crossing detected!"
    cr = field["ruin_cumulative"]
    assert (cr[:, 1:] >= cr[:, :-1] - 1e-6).all(), "cumulative ruin curve must be monotone"
    epi = field["epistemic_var"]
    assert epi is not None and (epi[:, -1] <= epi[:, 0] + 1e-6).all(), "expected writes must shrink posterior variance"
    util = field["probe_utility"]
    assert util is not None and util.shape == epi.shape
    ok(
        "I11 One-Shot Future Field (Block 3)",
        f"H={qf.shape[1]}, ruin_h={cr[1][-1].item():.3f}, epi_decay={epi[1][0].item():.2f}->{epi[1][-1].item():.2f}",
    )

    # ------------------------------------------------------------------
    # I12: Copy-on-Write Paged Memory Semantics (Block 5)
    # ------------------------------------------------------------------
    pkm = ProductKeyPagedMemory(d_model=64, sub_keys=16, top_k=2)
    t_parent = pkm.new_table()
    key_vec = torch.randn(64)  # write() expects a single [D] fact
    val_parent = torch.randn(64)
    addr = pkm.write(t_parent, key_vec, val_parent)
    t_child = t_parent.fork()
    val_child = torch.randn(64)
    assert pkm.write(t_child, key_vec, val_child) == addr, "same key must map to the same address"
    zero = torch.zeros(64)
    assert torch.equal(t_parent.read_address(addr, zero), val_parent), "parent must keep its page after fork"
    assert torch.equal(t_child.read_address(addr, zero), val_child), "child dirty page must shadow parent"
    t_child.forget_address(addr)
    assert torch.equal(t_child.read_address(addr, zero), zero), "tombstone must hide parent value"
    routed = pkm.read(t_child, key_vec.view(1, 1, -1))  # read() expects [B, T, D]
    assert routed.shape == (1, 1, 64) and torch.isfinite(routed).all()
    ok("I12 CoW Paged Memory Fork/Shadow/Tombstone", f"addr={addr}, fork=O(1), read=vectorized")

    # ------------------------------------------------------------------
    # I13: Model-Level L2 Paged Memory (retrieval fusion + O(1) fork worldline)
    # ------------------------------------------------------------------
    cfg_p = EpistemicConfig(vocab_size=512, d_model=64, n_layer=2, n_head=2, d_state=8,
                            paged_memory=True, paged_sub_keys=32, paged_top_k=2)
    model_p = EpistemicWorldlineModel(cfg_p)
    table_a = model_p.init_page_table()
    assert table_a is not None
    tokens_a = torch.randint(0, 512, (2, 8))
    out_a = model_p(tokens_a, update_state=True, page_table=table_a)
    table_b = table_a.fork()  # O(1): zero-copy worldline branch
    out_b = model_p(tokens_a, update_state=False, page_table=table_b)
    assert out_b["logits"].shape == (2, 8, 512) and torch.isfinite(out_b["logits"]).all()
    assert len(table_b.dirty_pages) == 0, "fork must be zero-copy (no dirty pages until written)"
    out_c = model_p(torch.randint(0, 512, (2, 8)), update_state=True, page_table=table_b)
    assert len(table_b.dirty_pages) > 0, "child writes must land in its own dirty pages"
    ok("I13 Model L2 Paged Memory + O(1) CoW Fork",
       f"parent_pages={len(table_a.dirty_pages)}, child_dirty={len(table_b.dirty_pages)}")

    # ------------------------------------------------------------------
    # I14: Future-Field & Probe-Policy Gradient Flow (trainable Blocks 3/4)
    # ------------------------------------------------------------------
    model.train()
    out2 = model(tokens, prosody=p_pair, update_state=True)
    aspect = model.rank_probe_aspects(out2["world_state"], out2["stakes_spread"].float())
    assert aspect["utility"].shape == (cfg.n_probes,)
    fld_loss = pinball_quantile_loss(out2["quantiles_seq"], target_payoff.unsqueeze(-1).expand(2, 16))
    prb_target = F.one_hot(torch.tensor([1, 3]), cfg.n_probes).float().mean(dim=0).clamp_min(1e-9)
    prb_loss = (prb_target * (prb_target.log() - F.log_softmax(aspect["utility"] / 0.5, dim=0))).sum()
    (fld_loss + prb_loss).backward()
    assert model.probe_aspect_emb.grad is not None and torch.isfinite(model.probe_aspect_emb.grad).all()
    ok("I14 Field + Probe Policy Gradient Flow",
       f"field={fld_loss.item():.3f}, probe={prb_loss.item():.3f}, |grad|={model.probe_aspect_emb.grad.norm():.2e}")

    # ------------------------------------------------------------------
    # I15: Batched Per-Sample Filter == Per-Sample Sequential State
    #      (Block 4 closed-loop probe *training* path: batched_filter_observe +
    #      batched_epistemic_eig must reproduce the per-sample state math)
    # ------------------------------------------------------------------
    Bs, Ts, Hs, ds2, Ms = 3, 7, 4, 8, 5
    lam_t = 0.5
    kb = F.normalize(torch.randn(Bs, Ts, Hs, ds2, dtype=torch.float64), dim=-1)
    vb = torch.randn(Bs, Ts, Hs, ds2, dtype=torch.float64)
    gb = torch.rand(Bs, Ts, Hs, dtype=torch.float64) + 0.2
    Ab = batched_filter_observe(kb, vb, gb, lam_t)                     # [B,H,d,d]
    qq = F.normalize(torch.randn(Ms, Hs, ds2, dtype=torch.float64), dim=-1)
    eig_batched = batched_epistemic_eig(
        Ab, qq.unsqueeze(0).expand(Bs, -1, -1, -1), jitter=1e-6  # matches InformationFilterState.epistemic_variance default
    )                                                                  # [B,M]
    states_b = [
        InformationFilterState.prior(Hs, ds2, lam=lam_t, dtype=torch.float64).observe(kb[b], vb[b], gb[b])
        for b in range(Bs)
    ]
    A_ref = torch.stack([st.A for st in states_b])
    eig_ref = torch.stack([st.expected_information_gain(qq) for st in states_b])
    a_err = (Ab - A_ref).abs().max().item()
    e_err = (eig_batched - eig_ref).abs().max().item()
    assert a_err < 1e-12, f"batched A mismatch {a_err:.3e}"
    assert e_err < 1e-8, f"batched EIG mismatch {e_err:.3e}"
    ok("I15 Batched Per-Sample Filter == Sequential State",
       f"A_err={a_err:.2e}, EIG_err={e_err:.2e}")

    # ------------------------------------------------------------------
    # I16: Orthogonal Suspicion Write (Block 2b) — high-incongruence turns
    #      engrave precision along q_s WITHOUT touching the literal claim
    #      subspace, and the suspicion value is trainable end to end.
    # ------------------------------------------------------------------
    # (a) state level: exact write + zero cross-contamination (N=1, fp64)
    H16, d16 = 4, 16
    pr16 = InformationFilterState.prior(H16, d16, lam=0.3, dtype=torch.float64)
    k16 = F.normalize(torch.randn(1, H16, d16, dtype=torch.float64), dim=-1)
    v16 = torch.randn(1, H16, d16, dtype=torch.float64)
    g16 = torch.rand(1, H16, dtype=torch.float64) + 0.1
    qs16 = F.normalize(torch.randn(1, H16, d16, dtype=torch.float64), dim=-1)
    gs16 = torch.rand(1, H16, dtype=torch.float64) + 0.5
    vs16 = torch.randn(1, H16, d16, dtype=torch.float64)
    st_w = pr16.observe(k16, v16, g16, suspicion_dir=qs16, suspicion_value=vs16, suspicion_precision=gs16)
    st_wo = pr16.observe(k16, v16, g16)
    dA16 = st_w.A - st_wo.A                                   # pure suspicion increment
    dA_ref = torch.einsum("nh,nhi,nhj->hij", gs16, qs16, qs16)
    write_err = (dA16 - dA_ref).abs().max().item()
    r16 = torch.randn(1, H16, d16, dtype=torch.float64)
    r16 = F.normalize(r16, dim=-1)
    r16 = r16 - (r16 * qs16).sum(-1, keepdim=True) * qs16
    r16 = F.normalize(r16, dim=-1)                                   # r ⊥ q_s
    cross = torch.einsum("nhi,hij,nhj->nh", r16, dA16, r16).abs().max().item()
    assert write_err < 1e-14, f"suspicion write mismatch {write_err:.3e}"
    assert cross < 1e-14, f"suspicion leaked into orthogonal subspace {cross:.3e}"
    # (b) model level: same text, nervous vs calm prosody -> strictly more
    #     precision mass along q_s on every layer/head
    cfg16 = EpistemicConfig(vocab_size=256, d_model=64, n_layer=2, n_head=4, d_state=16)
    m16 = EpistemicWorldlineModel(cfg16)
    toks16 = torch.randint(0, 256, (2, 8))
    p_nerv = torch.rand(2, 8, 12) * 0.9 + 0.05
    p_calm = torch.rand(2, 8, 12) * 0.08
    m16.eval()
    with torch.no_grad():
        st_n = m16(toks16, prosody=p_nerv, update_state=True)["world_state"]
        st_c = m16(toks16, prosody=p_calm, update_state=True)["world_state"]
    mass_n, mass_c = 0.0, 0.0
    for blk, sn, sc in zip(m16.blocks, st_n, st_c):
        qsd = blk.suspicion_dir.double()
        mass_n += float(torch.einsum("hi,hij,hj->h", qsd, sn.A.double(), qsd).sum())
        mass_c += float(torch.einsum("hi,hij,hj->h", qsd, sc.A.double(), qsd).sum())
    assert mass_n > mass_c + 1e-3, f"suspicion mass nervous={mass_n:.4f} !> calm={mass_c:.4f}"
    # (c) gradient flows into the learnable suspicion value via the stance head
    #     (which reads the suspicion-channel currents of the UPDATED states)
    m16.train()
    out16 = m16(toks16, prosody=p_nerv, update_state=True)
    F.cross_entropy(out16["stance_logits"], torch.zeros(2, dtype=torch.long)).backward()
    assert m16.blocks[0].suspicion_val.grad is not None
    assert torch.isfinite(m16.blocks[0].suspicion_val.grad).all()
    ok("I16 Orthogonal Suspicion Write",
       f"write_err={write_err:.1e}, cross_leak={cross:.1e}, "
       f"mass nerv={mass_n:.2f}>calm={mass_c:.2f}, |grad|={m16.blocks[0].suspicion_val.grad.norm():.2e}")

    # ------------------------------------------------------------------
    # I17: Personality Bias Drift (Block 2c) — same event through different
    #      cognitive lenses yields divergent stance/ruin; gain=0 is identity.
    # ------------------------------------------------------------------
    cfg17 = EpistemicConfig(vocab_size=256, d_model=64, n_layer=2, n_head=4, d_state=16)
    m17 = EpistemicWorldlineModel(cfg17).eval()
    toks17 = torch.randint(0, 256, (1, 8))
    pros17 = torch.rand(1, 8, 12) * 0.8 + 0.1
    with torch.no_grad():
        base17 = m17(toks17, prosody=pros17, update_state=True)["world_state"]
        o_ref = m17(toks17, prosody=pros17, world_state=base17, update_state=False)
        p_ref = F.softmax(o_ref["stance_logits"], -1)[0]
        def biased_out(op, g):
            st_b = m17.apply_personality_bias(base17, op, g)
            o = m17(toks17, prosody=pros17, world_state=st_b, update_state=False)
            return F.softmax(o["stance_logits"], -1)[0], float(o["ruin_prob"][0])
        outs17 = {op: biased_out(op, 1.5) for op in m17.list_personality_biases()}
    ps17 = [p for p, _ in outs17.values()]
    spread17 = max(float((a - b).abs().max()) for i, a in enumerate(ps17) for b in ps17[i + 1:])
    ruin_spread17 = max(r for _, r in outs17.values()) - min(r for _, r in outs17.values())
    with torch.no_grad():
        st_g0 = m17.apply_personality_bias(base17, "aggressive", 0.0)
        o_g0 = m17(toks17, prosody=pros17, world_state=st_g0, update_state=False)
    idem17 = float((F.softmax(o_g0["stance_logits"], -1)[0] - p_ref).abs().max())
    assert spread17 > 1e-3, f"biases produced identical stances: {spread17:.2e}"
    assert ruin_spread17 > 1e-4, f"biases produced identical ruin: {ruin_spread17:.2e}"
    assert idem17 < 1e-6, f"gain=0 must be identity, got {idem17:.2e}"
    try:
        m17.apply_personality_bias(base17, "unknown_op", 1.0)
        raise SystemExit("unknown bias operator accepted")
    except ValueError:
        pass
    ok("I17 Personality Bias Drift",
       f"stance spread={spread17:.3f}, ruin spread={ruin_spread17:.3f}, gain0 identity={idem17:.1e}")

    # ------------------------------------------------------------------
    # I18: Hippocampal Forgetting — geometric fade to prior, SPD preserved,
    #      repeatedly-written directions survive relative to one-off details.
    # ------------------------------------------------------------------
    H18, d18 = 4, 16
    prior18 = InformationFilterState.prior(H18, d18, lam=0.3, dtype=torch.float64)
    k18 = F.normalize(torch.randn(6, H18, d18, dtype=torch.float64), dim=-1)
    v18 = torch.randn(6, H18, d18, dtype=torch.float64)
    g18 = torch.rand(6, H18, dtype=torch.float64) + 0.5
    st18 = prior18.observe(k18, v18, g18)
    q_keep = k18[0:1]                                  # "反复被验证的死穴" 方向
    q_drop = F.normalize(torch.randn(1, H18, d18, dtype=torch.float64), dim=-1)  # 一次性细节
    def var_of(st, q):
        return float(st.epistemic_variance(q)[0].sum())
    keep0, drop0 = var_of(st18, q_keep), var_of(st18, q_drop)
    st_f = st18
    for _ in range(20):
        st_f = st_f.decay(0.90, 0.3)
        st_f = st_f.observe(k18[0:1], v18[0:1], g18[0:1])   # 每轮重申死穴
    st_d = st18
    for _ in range(20):
        st_d = st_d.decay(0.90, 0.3)                        # 一次性细节只被遗忘
    keep_f, drop_f = var_of(st_f, q_keep), var_of(st_d, q_drop)
    min_eig18 = float(torch.linalg.eigvalsh(st_d.A).min())
    prior_equiv = prior18.decay(0.5, 0.3)
    assert abs(prior_equiv.A - prior18.A).max().item() < 1e-15, "decaying the prior must be a no-op"
    assert keep_f < keep0 * 0.98, f"reinforced direction did not tighten: {keep_f:.4f} vs {keep0:.4f}"
    assert drop_f > keep_f, f"one-off detail (var {drop_f:.4f}) should exceed reinforced dead-point (var {keep_f:.4f})"
    assert min_eig18 >= 0.3 - 1e-12, f"SPD floor violated: {min_eig18}"
    assert st18.obs_count > 5.9 and st_d.obs_count < st18.obs_count, "obs_count must fade"
    ok("I18 Hippocampal Forgetting",
       f"reinforced var {keep0:.3f}->{keep_f:.3f}, one-off var->{drop_f:.3f}, min_eig={min_eig18:.3f}")

    # ------------------------------------------------------------------
    # I19: Counterfactual Evaluator — with the trained adversarial operator
    #      zeroed the counterfactual branch collapses to the factual field.
    # ------------------------------------------------------------------
    from epistemic_model.future_field import counterfactual_eval
    cfg19 = EpistemicConfig(vocab_size=256, d_model=64, n_layer=2, n_head=4, d_state=16)
    m19 = EpistemicWorldlineModel(cfg19).eval()
    toks19 = torch.randint(0, 256, (2, 8))
    with torch.no_grad():
        out19 = m19(toks19, prosody=torch.rand(2, 8, 12) * 0.7 + 0.1, update_state=True)
        cf19 = counterfactual_eval(m19, out19["hidden_last"], out19["world_state"], horizons=6)
        saved = [b.adv_mix.clone() for b in m19.blocks]
        for b in m19.blocks:
            b.adv_mix.zero_()
        cf19_zero = counterfactual_eval(m19, out19["hidden_last"], out19["world_state"], horizons=6)
        for b, s in zip(m19.blocks, saved):
            b.adv_mix.copy_(s)
    div_zero = float(cf19_zero["divergence"])
    div_on = float(cf19["divergence"])
    rob = float(cf19["robustness"])
    assert 0.0 < rob <= 1.0 and torch.isfinite(cf19["divergence"]), "robustness out of range"
    assert div_zero < 1e-6, f"zero adversarial mix must collapse branches, div={div_zero:.2e}"
    assert div_on > 0.0, f"counterfactual branch inactive, div={div_on:.2e}"
    ok("I19 Counterfactual Evaluator",
       f"div(on)={div_on:.4f}, div(adv=0)={div_zero:.1e}, robustness={rob:.3f}, volatile={cf19['volatile']}")

    # ------------------------------------------------------------------
    # I20: Counterfactual -> Decision Loop — volatility must actually move
    #      probability mass to information seeking, ruin must trip the
    #      circuit breaker, and stable worlds must remain untouched.
    # ------------------------------------------------------------------
    def fake_field(q50: float, spread: float, ruin: float) -> dict:
        q = torch.tensor(
            [q50 - spread, q50 - 0.5 * spread, q50, q50 + 0.5 * spread, q50 + spread]
        ).view(1, 1, 5)
        return {
            "quantiles": q,
            "stakes_spread": torch.tensor([[spread]]),
            "ruin_cumulative": torch.tensor([[ruin]]),
        }

    probs20 = torch.tensor([0.70, 0.10, 0.05, 0.05, 0.05, 0.05])
    stable20 = robust_stance_decision(
        fake_field(6.0, 2.0, 0.1), fake_field(4.0, 3.0, 0.2), probs20,
        divergence=0.2, ruin_prob=0.1,
    )
    volatile20 = robust_stance_decision(
        fake_field(6.0, 2.0, 0.1), fake_field(4.0, 3.0, 0.2), probs20,
        divergence=2.5, ruin_prob=0.1,
    )
    ruin20 = robust_stance_decision(
        fake_field(6.0, 2.0, 0.9), fake_field(4.0, 3.0, 0.95), probs20,
        divergence=2.5, ruin_prob=0.9,
    )
    assert stable20["stance"] == STANCE_LABELS[0] and not stable20["correction_applied"], stable20
    assert stable20["risk_adjusted_q50"] == 6.0, "stable world must not be marked down"
    assert volatile20["stance"] == "probe_blindspot" and volatile20["correction_applied"], volatile20
    assert volatile20["reason"] == "counterfactual_volatile_information_seeking"
    assert volatile20["risk_adjusted_q50"] == 4.0, "volatile world must take downside protection"
    assert abs(sum(volatile20["stance_probs_adjusted"].values()) - 1.0) < 1e-3
    assert ruin20["stance"] == "rupture" and ruin20["reason"] == "ruin_circuit_breaker", ruin20
    ok("I20 Counterfactual Decision Loop",
       f"stable={stable20['stance']}, volatile={volatile20['stance']} "
       f"({volatile20['reason']}), ruin={ruin20['stance']}")

    # ------------------------------------------------------------------
    # I21: Ablation switches are real — disabling memory reads zeroes the
    #      epistemic variance channel, suspicion-off stays finite/grad-safe,
    #      and paged retrieval uses softmax-free normalized weights.
    # ------------------------------------------------------------------
    pm21 = ProductKeyPagedMemory(d_model=16, sub_keys=16, top_k=4)
    addrs21, w21 = pm21._compute_addresses(torch.randn(8, 16))
    assert addrs21.shape == w21.shape == (8, 4)
    assert float(w21.min().detach()) >= 0.0
    assert torch.allclose(w21.sum(-1), torch.ones(8), atol=1e-5)
    assert not any(isinstance(m, torch.nn.Softmax) for m in pm21.modules())
    cfg21 = EpistemicConfig(vocab_size=256, d_model=64, n_layer=2, n_head=4, d_state=16)
    m21 = EpistemicWorldlineModel(cfg21).eval()
    for blk in m21.blocks:
        blk.use_memory_read = False
    with torch.no_grad():
        o21 = m21(torch.randint(0, 256, (2, 8)), prosody=torch.rand(2, 8, 12) * 0.7 + 0.1)
    assert torch.count_nonzero(o21["epistemic_var"]) == 0, "memory-read ablation must zero epistemic variance"
    assert torch.isfinite(o21["stance_logits"]).all()
    for blk in m21.blocks:
        blk.use_memory_read = True
        blk.use_suspicion = False
    m21.train()
    o21b = m21(
        torch.randint(0, 256, (2, 8)), prosody=torch.rand(2, 8, 12) * 0.7 + 0.1,
        update_state=True,
    )
    F.cross_entropy(o21b["stance_logits"], torch.zeros(2, dtype=torch.long)).backward()
    grads21 = [p.grad for p in m21.parameters() if p.grad is not None]
    assert grads21 and all(torch.isfinite(g).all() for g in grads21)
    ok("I21 Ablation Switches",
       f"mem_off_var=0, suspicion_off finite, paged weights min={float(w21.min().detach()):.3f}")

    # ------------------------------------------------------------------
    # I22: Memory warmup is not a no-op — a prefix-warmed (A,B) state must
    #      change both the epistemic variance and the stance logits of the
    #      scored suffix, otherwise Block 1 is dead during training.
    # ------------------------------------------------------------------
    cfg22 = EpistemicConfig(vocab_size=256, d_model=64, n_layer=2, n_head=4, d_state=16)
    m22 = EpistemicWorldlineModel(cfg22).eval()
    x22 = torch.randint(0, 256, (2, 10))
    p22 = torch.rand(2, 10, 12) * 0.7 + 0.1
    with torch.no_grad():
        warm22 = m22(x22[:, :5], prosody=p22[:, :5], update_state=True, collect_kv=False)
        out_prior22 = m22(x22[:, 5:], prosody=p22[:, 5:], update_state=False)
        out_warm22 = m22(
            x22[:, 5:], prosody=p22[:, 5:], world_state=warm22["world_state"],
            update_state=False,
        )
    delta22 = float((out_prior22["stance_logits"] - out_warm22["stance_logits"]).abs().max())
    var_delta22 = float((out_prior22["epistemic_var"] - out_warm22["epistemic_var"]).abs().max())
    assert delta22 > 1e-6, "warmed memory must change stance logits"
    assert var_delta22 > 1e-6, "warmed memory must change epistemic variance"
    assert torch.isfinite(out_warm22["stance_logits"]).all()
    ok("I22 Memory Warmup Active", f"logit_delta={delta22:.2e}, var_delta={var_delta22:.2e}")

    # ------------------------------------------------------------------
    # I23: Strict per-sample (A,B) state — batched training must be exactly
    #      equivalent to independent per-sample runs (no cross-sample leak),
    #      and sample-wise merge3 must match unbatched merge3.
    # ------------------------------------------------------------------
    cfg23 = EpistemicConfig(vocab_size=256, d_model=64, n_layer=2, n_head=4, d_state=16)
    m23 = EpistemicWorldlineModel(cfg23).eval()
    x23 = torch.randint(0, 256, (2, 10))
    p23 = torch.rand(2, 10, 12) * 0.7 + 0.1
    with torch.no_grad():
        bs23 = m23.init_batched_world_state(2)
        assert all(
            s.A.shape == (2, cfg23.n_head, cfg23.d_state, cfg23.d_state) for s in bs23
        ), "per-sample state must be [B,H,d,d]"
        warm_batch = m23(x23[:, :5], prosody=p23[:, :5], world_state=bs23, update_state=True)
        out_batch = m23(
            x23[:, 5:], prosody=p23[:, 5:], world_state=warm_batch["world_state"],
            update_state=False,
        )
        var_single, logit_single = [], []
        for i in range(2):
            w = m23(x23[i:i + 1, :5], prosody=p23[i:i + 1, :5], update_state=True)
            o = m23(
                x23[i:i + 1, 5:], prosody=p23[i:i + 1, 5:],
                world_state=w["world_state"], update_state=False,
            )
            var_single.append(o["epistemic_var"][0])
            logit_single.append(o["stance_logits"][0])
        err_var23 = max(
            float((out_batch["epistemic_var"][i] - var_single[i]).abs().max()) for i in range(2)
        )
        err_logit23 = max(
            float((out_batch["stance_logits"][i] - logit_single[i]).abs().max()) for i in range(2)
        )
        state_diff23 = max(
            float((s.A[0] - s.A[1]).abs().max()) for s in warm_batch["world_state"]
        )
    assert state_diff23 > 1e-6, "different prefixes must produce different per-sample states"
    assert err_var23 < 2e-4, f"batched read diverges from single-sample read: {err_var23:.3e}"
    assert err_logit23 < 2e-3, f"batched stance diverges from single-sample stance: {err_logit23:.3e}"

    gen23 = torch.Generator().manual_seed(23)
    B23, H23, d23, N23 = 2, cfg23.n_head, cfg23.d_state, 6

    def sample23(n: int):
        ks = F.normalize(torch.randn(B23, n, H23, d23, generator=gen23), dim=-1)
        vs = torch.randn(B23, n, H23, d23, generator=gen23)
        gs = torch.rand(B23, n, H23, generator=gen23) + 0.2
        return ks, vs, gs

    k0, v0, g0 = sample23(N23)
    k1, v1, g1 = sample23(N23 + 1)
    base_b = BatchedInformationFilterState.prior(B23, H23, d23, lam=cfg23.prior_lam)
    merged_b = base_b.observe(k0, v0, g0).merge3(base_b.observe(k1, v1, g1), base_b)
    base_u = InformationFilterState.prior(H23, d23, lam=cfg23.prior_lam)
    err_merge23 = 0.0
    for i in range(B23):
        merged_u = base_u.observe(k0[i], v0[i], g0[i]).merge3(
            base_u.observe(k1[i], v1[i], g1[i]), base_u
        )
        err_merge23 = max(
            err_merge23,
            float((merged_b.A[i] - merged_u.A).abs().max()),
            float((merged_b.B[i] - merged_u.B).abs().max()),
        )
    assert err_merge23 < 1e-5, f"batched merge3 != per-sample merge3: {err_merge23:.3e}"
    ok(
        "I23 Strict Per-Sample State",
        f"state_diff={state_diff23:.2e}, var_err={err_var23:.2e}, "
        f"stance_err={err_logit23:.2e}, merge3_err={err_merge23:.2e}",
    )

    print("-" * 74)
    print(f"ALL {passed}/{passed} INVARIANTS PASSED.")


if __name__ == "__main__":
    run_all_tests()
