"""Trinary Vector Projection System: deterministic algebraic expression synthesis.

This module replaces the legacy ``STANCE_PROMPT_DIRECTIVES`` lookup table
("SemanticRouter") with a parameterised, non-generative projection:

    expression = (content_vector @ content_proj) @ (Σ_s w_s · StyleMatrix_s)
    token_logits = Linear(d_state, d_model)(expression) · token_embeddingᵀ

* ``content_vector``: static fact embedding (BGE-m3 1024-D contract, or the
  deterministic static hash fallback used when the model is not present).
* ``w_s``: positive, normalised style weights derived from PAI-SSM stance
  logits via softplus (no softmax, no sampling).
* Every style matrix is ``Q_s @ diag(scale_s)`` with ``Q_s`` orthogonal and
  ``scale_s ∈ [0.75, 1.25]``, so the composed matrix is invertible and the
  transformation is algebraically continuous.

Runtime dependencies: torch only.  The optional BGE-m3 builder in
``build_fact_embeddings.py`` lazy-imports transformers and is never imported by
the serving path.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import torch
import torch.nn as nn
import torch.nn.functional as F


STYLE_NAMES: tuple[str, ...] = (
    "empathetic",
    "neutral",
    "probe_blindspot",
    "skeptical_push",
    "counter_bluff",
    "rupture",
)

DATA_DIR = Path(__file__).resolve().parent / "data"
DEFAULT_FACTS = DATA_DIR / "facts.json"
DEFAULT_EMBEDDINGS = DATA_DIR / "facts_embeddings.pt"


# ---------------------------------------------------------------------------
# Content space
# ---------------------------------------------------------------------------


class StaticContentEncoder:
    """Deterministic character n-gram hashing encoder (BGE-m3 compatible layout).

    Produces an L2-normalised 1024-D vector without any model download.  It is
    the offline fallback used when BGE-m3 weights are unavailable; the
    interface is identical, so ``facts_embeddings.pt`` can be replaced by real
    BGE-m3 embeddings without touching the synthesis operator.
    """

    def __init__(self, dim: int = 1024) -> None:
        self.dim = dim

    def encode(self, text: str) -> torch.Tensor:
        vec = torch.zeros(self.dim, dtype=torch.float32)
        cleaned = (text or "").strip()
        if not cleaned:
            return vec
        for n in (1, 2, 3):
            for i in range(max(1, len(cleaned) - n + 1)):
                gram = cleaned[i : i + n]
                digest = hashlib.blake2b(gram.encode("utf-8"), digest_size=8).digest()
                value = int.from_bytes(digest, "little")
                idx = value % self.dim
                sign = 1.0 if (value >> 63) & 1 else -1.0
                vec[idx] += sign * (1.0 / n)
        norm = vec.norm().clamp_min(1e-8)
        return vec / norm


@dataclass(frozen=True)
class Fact:
    fact_id: str
    text: str
    domain: str = "negotiation"


class FactKnowledgeBase:
    def __init__(self, facts: Iterable[Fact], embeddings: torch.Tensor, dim: int = 1024) -> None:
        self.facts = list(facts)
        if embeddings.dim() != 2 or embeddings.shape[0] != len(self.facts):
            raise ValueError("fact embeddings must be [n_facts, dim]")
        self.embeddings = F.normalize(embeddings.float(), dim=-1)
        self.dim = embeddings.shape[1]
        self._index = {f.fact_id: i for i, f in enumerate(self.facts)}
        if self.dim != dim:
            raise ValueError(f"expected content dim {dim}, got {self.dim}")

    @classmethod
    def load(
        cls,
        facts_path: str | Path = DEFAULT_FACTS,
        embeddings_path: str | Path | None = DEFAULT_EMBEDDINGS,
        dim: int = 1024,
        encoder: StaticContentEncoder | None = None,
    ) -> "FactKnowledgeBase":
        raw = json.loads(Path(facts_path).read_text(encoding="utf-8"))
        facts = [Fact(fact_id=str(f["fact_id"]), text=str(f["text"]), domain=str(f.get("domain", ""))) for f in raw]
        emb_path = Path(embeddings_path) if embeddings_path else None
        if emb_path is not None and emb_path.is_file():
            payload = torch.load(emb_path, map_location="cpu", weights_only=False)
            embeddings = payload["embeddings"] if isinstance(payload, dict) else payload
            embeddings = torch.as_tensor(embeddings, dtype=torch.float32)
            if embeddings.shape[0] != len(facts):
                raise ValueError("facts_embeddings.pt row count does not match facts.json")
            if embeddings.shape[1] != dim:
                # BGE-m3 is 1024-D; other static encoders may differ.
                dim = embeddings.shape[1]
        else:
            enc = encoder or StaticContentEncoder(dim=dim)
            embeddings = torch.stack([enc.encode(f.text) for f in facts])
        return cls(facts, embeddings, dim=dim)

    def content(self, fact_id: str) -> torch.Tensor:
        if fact_id not in self._index:
            raise KeyError(f"unknown fact_id: {fact_id}")
        return self.embeddings[self._index[fact_id]]

    def fact(self, fact_id: str) -> Fact:
        return self.facts[self._index[fact_id]]

    def ids(self) -> list[str]:
        return [f.fact_id for f in self.facts]


# ---------------------------------------------------------------------------
# Style matrix bank
# ---------------------------------------------------------------------------


class StyleMatrixBank(nn.Module):
    """Six invertible style deformation operators on the d_state subspace.

    Each matrix is ``Q_s @ diag(scale_s)`` with ``Q_s`` orthogonal and
    ``scale_s`` strictly positive, so every style and any positive convex
    combination is invertible.  The fixed ``content_proj`` is an orthonormal
    1024 -> d_state projection (BGE-m3 dimensions).
    """

    def __init__(
        self,
        content_dim: int = 1024,
        d_state: int = 256,
        n_styles: int = len(STYLE_NAMES),
        seed: int = 20261117,
    ) -> None:
        super().__init__()
        self.content_dim = content_dim
        self.d_state = d_state
        self.n_styles = n_styles
        g = torch.Generator(device="cpu").manual_seed(seed)

        proj = torch.randn(content_dim, d_state, generator=g)
        proj, _ = torch.linalg.qr(proj)  # [content_dim, d_state], orthonormal columns
        self.register_buffer("content_proj", proj, persistent=True)

        basis, _ = torch.linalg.qr(torch.randn(d_state, d_state, generator=g))
        scales = 0.75 + 0.5 * torch.rand(n_styles, d_state, generator=g)
        self.register_buffer("basis", basis, persistent=True)
        self.register_buffer("scales", scales, persistent=True)

    def project(self, content: torch.Tensor) -> torch.Tensor:
        content = content.float()
        return F.normalize(content @ self.content_proj, dim=-1)

    def composed_scale(self, weights: torch.Tensor) -> torch.Tensor:
        return weights.to(self.scales.dtype) @ self.scales

    def compose(self, weights: torch.Tensor) -> torch.Tensor:
        # M = Q @ diag(Σ_s w_s scale_s); all scales stay in [0.75, 1.25].
        return self.basis * self.composed_scale(weights).unsqueeze(0)

    def invert(self, expression: torch.Tensor, weights: torch.Tensor) -> torch.Tensor:
        # M^{-1} = diag(1/s) Q^T  =>  expr @ M^{-1} = (expr / s) @ Q^T.
        scale = self.composed_scale(weights)
        return (expression / scale) @ self.basis.transpose(-1, -2)


# ---------------------------------------------------------------------------
# Synthesis operator
# ---------------------------------------------------------------------------


class SynthesisOperator:
    def __init__(self, bank: StyleMatrixBank, kb: FactKnowledgeBase) -> None:
        self.bank = bank
        self.kb = kb

    def style_weights(self, stance_logits: torch.Tensor) -> torch.Tensor:
        logits = torch.as_tensor(stance_logits, dtype=torch.float32).reshape(-1)
        if logits.numel() != self.bank.n_styles:
            raise ValueError(f"stance_logits must have {self.bank.n_styles} entries")
        w = F.softplus(logits) + 1e-8
        return w / w.sum()

    @torch.no_grad()
    def synthesize(self, fact_id: str, stance_logits: torch.Tensor) -> dict[str, object]:
        content_raw = self.kb.content(fact_id)
        content = self.bank.project(content_raw)  # [d_state]
        weights = self.style_weights(stance_logits)
        matrix = self.bank.compose(weights)  # [d_state, d_state]
        scale = self.bank.composed_scale(weights)
        expression = content @ matrix

        recovered = self.bank.invert(expression, weights)
        roundtrip = (recovered - content).abs().max().item()
        # cond(Q @ diag(s)) = max(s) / min(s), no SVD on the hot path.
        condition = (scale.max() / scale.min()).item()
        dominant = int(torch.argmax(weights).item())

        path = {
            "fact_id": fact_id,
            "fact_text": self.kb.fact(fact_id).text,
            "dominant_style": STYLE_NAMES[dominant],
            "style_weights": {name: round(float(w), 6) for name, w in zip(STYLE_NAMES, weights)},
            "condition_number": round(float(condition), 6),
            "matrix_frobenius": round(float(scale.norm().item()), 6),
            "composed_scale_min": round(float(scale.min().item()), 6),
            "composed_scale_max": round(float(scale.max().item()), 6),
            "inverse_roundtrip_error": round(float(roundtrip), 9),
            "content_fingerprint": _fingerprint(content),
            "expression_fingerprint": _fingerprint(expression),
            "deterministic": True,
            "generative_dependency": False,
        }
        return {
            "expression": expression,
            "matrix": matrix,
            "style_weights": weights,
            "dominant_style": STYLE_NAMES[dominant],
            "path": path,
        }


# ---------------------------------------------------------------------------
# Decoder
# ---------------------------------------------------------------------------


class ExpressionDecoder(nn.Module):
    """Direct ``Linear(d_state -> vocab)`` decoder, tied to token embeddings."""

    def __init__(
        self,
        d_state: int = 256,
        vocab_size: int = 32000,
        seed: int = 20261117,
        token_embedding: torch.Tensor | None = None,
    ) -> None:
        super().__init__()
        self.proj = nn.Linear(d_state, vocab_size, bias=False)
        if token_embedding is not None:
            token_embedding = token_embedding.float()
            if token_embedding.shape[0] != vocab_size:
                raise ValueError("token_embedding vocab size mismatch")
            if token_embedding.shape[1] < d_state:
                raise ValueError("token_embedding is narrower than d_state")
            weight = token_embedding[:, :d_state]  # [vocab, d_state]
        else:
            g = torch.Generator(device="cpu").manual_seed(seed)
            weight = torch.randn(vocab_size, d_state, generator=g) * 0.02
        with torch.no_grad():
            self.proj.weight.copy_(weight)

    @torch.no_grad()
    def forward(self, expression: torch.Tensor, top_k: int = 8) -> dict[str, object]:
        logits = self.proj(expression)
        scores, ids = torch.topk(logits, k=min(top_k, logits.numel()))
        return {
            "top_token_ids": ids.tolist(),
            "top_token_scores": [round(float(v), 6) for v in scores.tolist()],
            "logit_norm": round(float(logits.norm().item()), 6),
        }


class SynthesisEngine:
    """End-to-end deterministic expression synthesis for one stance vector."""

    def __init__(
        self,
        kb: FactKnowledgeBase,
        bank: StyleMatrixBank,
        decoder: ExpressionDecoder,
    ) -> None:
        self.kb = kb
        self.bank = bank
        self.decoder = decoder
        self.operator = SynthesisOperator(bank, kb)

    @classmethod
    def from_defaults(
        cls,
        token_embedding: torch.Tensor | None = None,
        d_state: int = 256,
        seed: int = 20261117,
        facts_path: str | Path = DEFAULT_FACTS,
        embeddings_path: str | Path | None = DEFAULT_EMBEDDINGS,
    ) -> "SynthesisEngine":
        kb = FactKnowledgeBase.load(facts_path=facts_path, embeddings_path=embeddings_path)
        bank = StyleMatrixBank(content_dim=kb.dim, d_state=d_state, seed=seed)
        decoder = ExpressionDecoder(
            d_state=d_state,
            vocab_size=token_embedding.shape[0] if token_embedding is not None else 32000,
            seed=seed,
            token_embedding=token_embedding,
        )
        return cls(kb, bank, decoder)

    @torch.no_grad()
    def synthesize(
        self,
        fact_id: str,
        stance_logits: torch.Tensor,
        *,
        top_k: int = 8,
    ) -> dict[str, object]:
        t0 = time.perf_counter()
        result = self.operator.synthesize(fact_id, stance_logits)
        decoded = self.decoder(result["expression"], top_k=top_k)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        path = dict(result["path"])
        path["synthesis_latency_ms"] = round(elapsed_ms, 4)
        return {
            "ok": True,
            "label": {
                "dominant_style": result["dominant_style"],
                "fact_id": fact_id,
                "fact_text": path["fact_text"],
            },
            "style_weights": {k: float(v) for k, v in path["style_weights"].items()},
            "matrix_path": path,
            "expression_norm": round(float(result["expression"].norm().item()), 6),
            "top_tokens": decoded,
            "deterministic": True,
            "generative_dependency": False,
        }


def _fingerprint(tensor: torch.Tensor) -> str:
    payload = tensor.detach().to(torch.float32).cpu().contiguous().numpy().tobytes()
    return hashlib.blake2b(payload, digest_size=8).hexdigest()
