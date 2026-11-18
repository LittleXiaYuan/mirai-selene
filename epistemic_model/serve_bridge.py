"""Local HTTP inference & worldline state bridge for PAI-SSM (4050 Laptop / CPU ready).

Exposes deterministic, millisecond-latency endpoints consumed by ``app/server/serve.mjs``
and ``app/server/mcp.mjs``. Keeps an in-memory registry of ``InformationFilterState``
snapshots keyed by ``node_id`` so every visual-novel save slot (No.01..No.10) is backed
by real PyTorch sufficient-statistic tensors ``(A, B)``.

Endpoints (default ``127.0.0.1:5290``):
  GET  /health         -> model status, device, parameter count, loaded checkpoint
  POST /step           -> forward pass with text + 12-D prosody (or raw PCM waveform),
                          updates InformationFilterState, returns stance lock, quantiles,
                          ruin probability, incongruence, and ranked active probes
  POST /merge3         -> exact three-way tensor merge ``S_a + S_b - S_base`` across all
                          layers, returning new ``node_id`` and replay consistency check
  POST /probe_rank     -> rank candidate follow-up questions by Expected Information Gain

Usage:
  python -m epistemic_model.serve_bridge --port 5290 --ckpt epistemic_model/runs/pai_ssm_smoke.pt
"""

from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
from typing import Any

import torch

from .architecture import (
    EpistemicConfig,
    EpistemicWorldlineModel,
    InformationFilterState,
    STANCE_LABELS,
)
from .prosody import PARALINGUISTIC_DIM, PARALINGUISTIC_FEATURE_NAMES, ParalinguisticExtractor
from .future_field import counterfactual_eval, robust_stance_decision
from .synthesis import SynthesisEngine


def deterministic_hash_tokens(text: str, vocab_size: int, max_len: int = 48) -> list[int]:
    """Fallback byte/character hash tokenizer when external BPE file is not attached.

    Ensures zero-dependency startup on any laptop while preserving deterministic token IDs.
    Replaceable by HuggingFace / SentencePiece tokenizer once trained ``vocab.json`` is present.
    """
    cleaned = (text or "…").strip()[:240]
    ids: list[int] = []
    for ch in cleaned[:max_len]:
        h = int(hashlib.blake2b(ch.encode("utf-8"), digest_size=4).hexdigest(), 16)
        ids.append(16 + (h % (vocab_size - 16)))
    return ids or [16]


class PAISSMEngine:
    def __init__(
        self,
        ckpt_path: str | None = None,
        device_str: str = "auto",
        strict_model: bool = False,
        compat: bool = False,
    ) -> None:
        self.strict_model = strict_model
        self.compat_report: dict | None = None
        if device_str == "auto":
            self.device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
        else:
            self.device = torch.device(device_str)

        self.ckpt_loaded = None
        if ckpt_path and Path(ckpt_path).is_file() and compat:
            from .compat import load_checkpoint_compat

            self.model, self.compat_report, meta = load_checkpoint_compat(ckpt_path, self.device)
            self.ckpt_loaded = str(ckpt_path)
            print(
                "[PAI-SSM] compat load:"
                f" copied={self.compat_report['copied']}"
                f" padded={self.compat_report['padded']}"
                f" kept_init={len(self.compat_report['kept_init'])}"
                f" step={meta.get('step')}"
            )
        elif ckpt_path and Path(ckpt_path).is_file():
            payload = torch.load(ckpt_path, map_location=self.device, weights_only=False)
            cfg = EpistemicConfig(**payload["config"])
            self.model = EpistemicWorldlineModel(cfg).to(self.device)
            try:
                self.model.load_state_dict(payload["model"], strict=True)
            except RuntimeError as exc:
                raise RuntimeError(
                    "checkpoint is incompatible with the current architecture "
                    f"(stale checkpoint?): {ckpt_path}\n"
                    "retry with --compat to load it with zeroed new channels\n"
                    f"{exc}"
                ) from exc
            self.ckpt_loaded = str(ckpt_path)
        else:
            cfg = EpistemicConfig(vocab_size=4096, d_model=256, n_layer=6, n_head=8, d_state=16)
            self.model = EpistemicWorldlineModel(cfg).to(self.device)

        self.model.eval()
        self.extractor = ParalinguisticExtractor(sample_rate=16000).to(self.device)
        self.synthesis = SynthesisEngine.from_defaults(
            token_embedding=self.model.tok_emb.weight.detach().cpu(),
            d_state=min(256, self.model.cfg.d_model),
        )
        self.states: dict[str, list[InformationFilterState]] = {
            "root": self.model.init_world_state(self.device)
        }
        # ThreadingHTTPServer serves /step and /merge3 concurrently; serialize
        # access to the node registry so a fork never observes a half-written state.
        self._lock = threading.RLock()
        self.max_cached_nodes = 4096

    def _get_state(self, node_id: str) -> list[InformationFilterState]:
        with self._lock:
            state = self.states.get(node_id)
        if state is None:
            if node_id == "root":
                return self.model.init_world_state(self.device)
            raise ValueError(f"unknown node_id: {node_id!r} (restart from 'root' or a live node)")
        return state

    def _store_state(self, node_id: str, states: list[InformationFilterState]) -> None:
        with self._lock:
            self.states[node_id] = states
            # Bound the registry: fork/step traffic grows it without limit otherwise.
            while len(self.states) > self.max_cached_nodes:
                evict = next((k for k in self.states if k not in ("root", node_id)), None)
                if evict is None:
                    break
                del self.states[evict]

    def state_fingerprint(self, states: list[InformationFilterState]) -> str:
        h = hashlib.blake2b(digest_size=6)
        for st in states:
            # Hash the FULL sufficient statistics: truncating to a few hundred
            # bytes made distinct branches (d=32 -> 4 KB per matrix) collide into
            # the same node_id, silently overwriting one branch.
            h.update(st.A.detach().cpu().contiguous().numpy().tobytes())
            h.update(st.B.detach().cpu().contiguous().numpy().tobytes())
        return h.hexdigest()

    @torch.no_grad()
    def step(self, body: dict[str, Any]) -> dict[str, Any]:
        t0 = time.perf_counter()
        parent_id = str(body.get("parent_id", "root"))
        base_state = self._get_state(parent_id)
        bias = str(body.get("bias") or "").strip()
        if bias:
            name, _, gv = bias.partition(":")
            try:
                base_state = self.model.apply_personality_bias(
                    base_state, name.strip(), float(gv) if gv else 1.0
                )
            except ValueError as exc:
                raise ValueError(f"invalid personality bias: {exc}") from exc
        text = str(body.get("text", ""))

        prosody_tensor = None
        if isinstance(body.get("waveform"), list) and len(body["waveform"]) >= 320:
            wav = torch.tensor(body["waveform"], dtype=torch.float32, device=self.device)
            prosody_tensor = self.extractor(wav).unsqueeze(0)
        elif isinstance(body.get("prosody"), list) and len(body["prosody"]) == PARALINGUISTIC_DIM:
            prosody_tensor = torch.tensor([body["prosody"]], dtype=torch.float32, device=self.device)

        toks = torch.tensor(
            [deterministic_hash_tokens(text, self.model.cfg.vocab_size)],
            dtype=torch.long,
            device=self.device,
        )
        with torch.no_grad():
            out = self.model(
                toks, prosody=prosody_tensor, world_state=base_state, update_state=True
            )
        next_state: list[InformationFilterState] = out["world_state"]  # type: ignore[assignment]
        fp = self.state_fingerprint(next_state)
        node_id = str(body.get("node_id") or f"s_{fp[:8]}")
        self._store_state(node_id, [s.detach() for s in next_state])

        probs = torch.softmax(out["stance_logits"][0].float(), dim=-1)
        stance_idx = int(probs.argmax().item())
        model_stance = STANCE_LABELS[stance_idx]
        inc_val = float(out["incongruence"][0].item())
        ruin_val = float(out["ruin_prob"][0].item())
        ep_var = float(out["epistemic_var"][0].mean().item())
        q_list = [round(float(v), 2) for v in out["quantiles"][0].tolist()]
        susp = self.model.suspicion_current(next_state)  # [L, H] orthogonal suspicion-channel current

        # Counterfactual deliberation: roll the future field through the model's own
        # trained adversarial counter-move operator and report how volatile the
        # payoff landscape is under the opponent's best response.
        with torch.no_grad():
            cf = counterfactual_eval(
                self.model, out["hidden_last"], next_state, horizons=8
            )

        # Closed-loop deliberation: the counterfactual field now actually
        # corrects the decision instead of only flagging volatility.
        decision = robust_stance_decision(
            cf["factual"],
            cf["counterfactual"],
            probs,
            divergence=float(cf["divergence"]),
            ruin_prob=ruin_val,
        )

        # Alarm-engine layer: acoustic inconsistency / entropy spike / ruin limit.
        # These are *labeled overrides* on top of the model head's own output --
        # disable with --strict-model to expose the raw trained head.
        alarm = None
        if ruin_val >= 0.82:
            alarm = "rupture"
        elif prosody_tensor is not None and inc_val >= 0.50:
            alarm = "skeptical_push"
        elif ep_var >= 6.5 and (q_list[4] - q_list[0]) >= 6.0:
            alarm = "probe_blindspot"
        if self.strict_model:
            stance_code = model_stance
        elif alarm is not None:
            stance_code = alarm
        elif decision["correction_applied"]:
            stance_code = decision["stance"]
        else:
            stance_code = model_stance

        probe_result = None
        candidates = body.get("candidate_probes")
        if isinstance(candidates, list) and candidates:
            max_l = 24
            padded = []
            for c in candidates[:8]:
                ids = deterministic_hash_tokens(str(c), self.model.cfg.vocab_size, max_l)
                ids = (ids + [0] * max_l)[:max_l]
                padded.append(ids)
            c_toks = torch.tensor(padded, dtype=torch.long, device=self.device)
            ranked = self.model.rank_active_probes(
                next_state, c_toks, stakes_spread=float(q_list[4] - q_list[0])
            )
            best_i = int(ranked["best_index"].item())
            probe_result = {
                "best_index": best_i,
                "best_probe": str(candidates[best_i]),
                "eig_nats": [round(float(x), 4) for x in ranked["eig"].tolist()],
            }

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return {
            "ok": True,
            "node_id": node_id,
            "parent_id": parent_id,
            "state_fingerprint": fp,
            "latency_ms": round(elapsed_ms, 3),
            "stance": stance_code,
            "model_stance": model_stance,
            "stance_probs": {name: round(float(p), 4) for name, p in zip(STANCE_LABELS, probs.tolist())},
            "alarm_override": alarm,
            "strict_model": self.strict_model,
            "incongruence": round(inc_val, 4),
            "epistemic_variance": round(ep_var, 4),
            "counterfactual": {
                "divergence": round(float(cf["divergence"].item()), 4),
                "robustness": round(float(cf["robustness"].item()), 4),
                "volatile": cf["volatile"],
                "cf_quantiles": [
                    round(float(v), 2) for v in cf["counterfactual"]["quantiles"][0, -1].tolist()
                ],
            },
            "decision": decision,
            "suspicion_current": [
                [round(float(v), 4) for v in row] for row in susp.tolist()
            ],
            "quantiles": {
                "q10": q_list[0],
                "q30": q_list[1],
                "q50": q_list[2],
                "q70": q_list[3],
                "q90": q_list[4],
                "spread": round(q_list[4] - q_list[0], 2),
            },
            "ruin_prob": round(ruin_val, 4),
            "prosody_echo": (
                dict(zip(PARALINGUISTIC_FEATURE_NAMES, [round(float(v), 3) for v in prosody_tensor[0].tolist()]))
                if prosody_tensor is not None
                else None
            ),
            "active_probe": probe_result,
            "synthesis": self.synthesis.synthesize(
                str(body.get("fact_id") or "F01"), out["stance_logits"][0].float().cpu()
            ),
        }

    @torch.no_grad()
    def synthesize(self, body: dict[str, Any]) -> dict[str, Any]:
        """Deterministic algebraic expression synthesis (no generation)."""
        t0 = time.perf_counter()
        fact_id = str(body.get("fact_id", "F01"))
        logits = body.get("stance_logits")
        if isinstance(logits, list) and len(logits) == 6:
            stance_logits = torch.tensor(logits, dtype=torch.float32)
            forward_ms = 0.0
        else:
            text = str(body.get("text", ""))
            prosody_tensor = None
            if isinstance(body.get("waveform"), list) and len(body["waveform"]) >= 320:
                wav = torch.tensor(body["waveform"], dtype=torch.float32, device=self.device)
                prosody_tensor = self.extractor(wav).unsqueeze(0)
            elif isinstance(body.get("prosody"), list) and len(body["prosody"]) == PARALINGUISTIC_DIM:
                prosody_tensor = torch.tensor(
                    [body["prosody"]], dtype=torch.float32, device=self.device
                )
            toks = torch.tensor(
                [deterministic_hash_tokens(text, self.model.cfg.vocab_size)],
                dtype=torch.long,
                device=self.device,
            )
            out = self.model(toks, prosody=prosody_tensor, update_state=False)
            stance_logits = out["stance_logits"][0].float().cpu()
            forward_ms = (time.perf_counter() - t0) * 1000.0

        result = self.synthesis.synthesize(fact_id, stance_logits)
        result["model_forward_ms"] = round(forward_ms, 3)
        result["total_latency_ms"] = round((time.perf_counter() - t0) * 1000.0, 3)
        return result

    @torch.no_grad()
    def merge3(self, body: dict[str, Any]) -> dict[str, Any]:
        t0 = time.perf_counter()
        left_id = str(body.get("left_id", ""))
        right_id = str(body.get("right_id", ""))
        base_id = str(body.get("base_id", "root"))
        left_state = self._get_state(left_id)
        right_state = self._get_state(right_id)
        base_state = self._get_state(base_id)

        merged = self.model.merge3_world_states(left_state, right_state, base_state)
        # Verify commutativity on the fly as live proof
        merged_rev = self.model.merge3_world_states(right_state, left_state, base_state)
        comm_diff = max(
            float((a.A - b.A).abs().max().item()) for a, b in zip(merged, merged_rev)
        )

        fp = self.state_fingerprint(merged)
        out_id = str(body.get("out_id") or f"m_{fp[:8]}")
        self._store_state(out_id, merged)
        return {
            "ok": True,
            "node_id": out_id,
            "state_fingerprint": fp,
            "commutativity_max_diff": comm_diff,
            "latency_ms": round((time.perf_counter() - t0) * 1000.0, 3),
        }


def serve(
    host: str = "127.0.0.1",
    port: int = 5290,
    ckpt: str | None = None,
    strict_model: bool = False,
    compat: bool = False,
) -> None:
    engine = PAISSMEngine(ckpt_path=ckpt, strict_model=strict_model, compat=compat)

    # 第一次前向要建 CUDA context / 编译 kernel，现场第一次点击会多出 1–2 秒；
    # 启动即预热，保证台上第一次 /step 就是热路径延迟。
    if engine.ckpt_loaded:
        try:
            with torch.no_grad():
                warm = torch.tensor([[16, 17, 18, 19]], device=engine.device)
                engine.model(
                    warm,
                    world_state=engine.model.init_world_state(engine.device),
                    update_state=False,
                )
            print("[PAI-SSM] warmup done")
        except Exception as exc:
            print(f"[PAI-SSM] warmup skipped: {exc}")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def _send(self, code: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()

        def do_GET(self) -> None:
            if self.path.startswith("/health"):
                self._send(
                    200,
                    {
                        "ok": True,
                        "arch": "PAI-SSM-v3",
                        "device": str(engine.device),
                        "params": engine.model.num_parameters(),
                        "checkpoint": engine.ckpt_loaded,
                        "compat": engine.compat_report is not None,
                        "compat_report": engine.compat_report,
                        "active_nodes": len(engine.states),
                    },
                )
                return
            self._send(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                if self.path == "/step":
                    self._send(200, engine.step(body))
                elif self.path == "/synthesize":
                    self._send(200, engine.synthesize(body))
                elif self.path == "/merge3":
                    self._send(200, engine.merge3(body))
                else:
                    self._send(404, {"ok": False, "error": "unknown endpoint"})
            except Exception as exc:
                self._send(400, {"ok": False, "error": str(exc)})

    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"[PAI-SSM Bridge] listening on http://{host}:{port} | device={engine.device} | params={engine.model.num_parameters():,}")
    httpd.serve_forever()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5290)
    p.add_argument("--ckpt", default=None)
    p.add_argument("--strict-model", action="store_true", help="expose the raw trained stance head without alarm overrides")
    p.add_argument("--compat", action="store_true", help="load a pre-suspicion checkpoint with zeroed new channels")
    a = p.parse_args()
    serve(a.host, a.port, a.ckpt, strict_model=a.strict_model, compat=a.compat)
