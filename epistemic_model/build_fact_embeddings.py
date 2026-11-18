"""Offline fact-embedding builder.

Runtime serving never imports transformers.  This script is the only place that
may lazy-import it, when a real BGE-m3 checkpoint is available:

    python -m epistemic_model.build_fact_embeddings \
        --model BAAI/bge-m3 --out epistemic_model/data/facts_embeddings.pt

Without ``--model`` it writes the deterministic static-hash 1024-D fallback used
by the offline demo (same tensor layout as BGE-m3, so the serving path is
unchanged).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
import torch.nn.functional as F

from .synthesis import DEFAULT_FACTS, StaticContentEncoder


def bge_encode(texts: list[str], model_name: str, dim: int) -> torch.Tensor:
    from transformers import AutoModel, AutoTokenizer  # lazy, offline builder only

    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModel.from_pretrained(model_name, torch_dtype=torch.float32)
    model.eval()
    with torch.no_grad():
        batch = tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="pt",
        )
        hidden = model(**batch).last_hidden_state
        mask = batch["attention_mask"].unsqueeze(-1).float()
        pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp_min(1.0)
        pooled = F.normalize(pooled, dim=-1)
    if pooled.shape[1] != dim:
        raise ValueError(f"BGE output dim {pooled.shape[1]} != expected {dim}")
    return pooled


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--facts", default=str(DEFAULT_FACTS))
    parser.add_argument("--out", default=str(DEFAULT_FACTS.with_name("facts_embeddings.pt")))
    parser.add_argument("--model", default=None, help="BGE-m3 checkpoint path/name (optional)")
    parser.add_argument("--dim", type=int, default=1024)
    args = parser.parse_args()

    raw = json.loads(Path(args.facts).read_text(encoding="utf-8"))
    texts = [str(item["text"]) for item in raw]

    if args.model:
        embeddings = bge_encode(texts, args.model, args.dim)
        encoder_name = args.model
    else:
        encoder = StaticContentEncoder(dim=args.dim)
        embeddings = torch.stack([encoder.encode(text) for text in texts])
        encoder_name = "static-hash"

    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "embeddings": embeddings,
            "encoder": encoder_name,
            "dim": int(embeddings.shape[1]),
            "facts": len(texts),
        },
        output,
    )
    print(f"saved {tuple(embeddings.shape)} embeddings -> {output} (encoder={encoder_name})")


if __name__ == "__main__":
    main()
