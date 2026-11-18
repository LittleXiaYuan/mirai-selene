"""Virtual Paged Episodic Memory with Sub-Linear Product-Key Addressing & Copy-on-Write.

Addresses the fundamental information-theoretic dilemma of sequence models:
  - Transformer KV-cache remembers exact tokens but scales as O(N) memory & time per step.
  - Pure O(1) recurrent states (RWKV / Mamba / fixed matrices) have constant VRAM, but
    inevitably overwrite old details once history exceeds fixed bit capacity.

Inspired by OS Virtual Memory & Product-Key Memory (Lample et al., NeurIPS 2019):
  - **L1 Register (GPU O(1))**: ``InformationFilterState (A, B)`` holds global belief,
    stance dynamics, and epistemic uncertainty.
  - **L2 Virtual Paged Memory (RAM/CPU-offloadable, N = K² slots)**:
    Splits query/key into two half-spaces of size ``K`` (e.g., ``K=512 -> 262,144`` slots;
    ``K=1024 -> 1,048,576`` slots). Addressing evaluates two tiny ``K``-way inner products
    to jump directly to the exact ``(row, col)`` memory address in **O(K) = O(√M)** ops
    without scanning history!
  - **Copy-on-Write (CoW) Worldline Branching**:
    Forking a worldline copies **zero** memory pages — child branches share immutable
    parent pages and allocate tiny delta entries only for newly written addresses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import math
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class CoWPageTable:
    """Copy-on-Write sparse page store backing ``K * K`` virtual memory addresses.

    Branching is O(1) in both time and memory regardless of how many millions of
    tokens were written prior to the branch point.
    """

    num_keys_per_half: int
    d_value: int
    parent: Optional["CoWPageTable"] = None
    dirty_pages: dict[int, torch.Tensor] = field(default_factory=dict)
    tombstones: set[int] = field(default_factory=set)

    @property
    def total_virtual_slots(self) -> int:
        return self.num_keys_per_half * self.num_keys_per_half

    def fork(self) -> "CoWPageTable":
        """O(1) zero-copy worldline branch."""
        return CoWPageTable(
            num_keys_per_half=self.num_keys_per_half,
            d_value=self.d_value,
            parent=self,
        )

    def read_address(self, addr: int, default: torch.Tensor) -> torch.Tensor:
        cur: Optional[CoWPageTable] = self
        while cur is not None:
            if addr in cur.tombstones:
                return default
            if addr in cur.dirty_pages:
                return cur.dirty_pages[addr]
            cur = cur.parent
        return default

    def write_address(self, addr: int, value: torch.Tensor) -> None:
        self.tombstones.discard(addr)
        self.dirty_pages[addr] = value.detach().clone()

    def forget_address(self, addr: int) -> None:
        self.dirty_pages.pop(addr, None)
        self.tombstones.add(addr)


class ProductKeyPagedMemory(nn.Module):
    """Constant-VRAM pointer-addressed memory supporting >1M virtual slots & O(1) fork."""

    def __init__(self, d_model: int, sub_keys: int = 256, top_k: int = 4) -> None:
        super().__init__()
        assert d_model % 2 == 0, "d_model must be even for product-key split"
        self.d_model = d_model
        self.half_d = d_model // 2
        self.sub_keys = sub_keys  # Total addressable pages = sub_keys^2 (e.g. 256^2 = 65,536; 1024^2 = 1,048,576)
        self.top_k = top_k

        self.q_proj = nn.Linear(d_model, d_model, bias=False)
        # Two tiny codebooks of shape [sub_keys, d_model/2] -> O(sub_keys) lookup instead of O(N)!
        self.codebook_row = nn.Parameter(torch.randn(sub_keys, self.half_d) / math.sqrt(self.half_d))
        self.codebook_col = nn.Parameter(torch.randn(sub_keys, self.half_d) / math.sqrt(self.half_d))
        self.out_gate = nn.Linear(d_model, 1)
        nn.init.constant_(self.out_gate.bias, -1.5)

    def new_table(self) -> CoWPageTable:
        return CoWPageTable(num_keys_per_half=self.sub_keys, d_value=self.d_model)

    def _compute_addresses(self, vec: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Map ``vec [M, D]`` to top-k exact ``(addr, score)`` in O(√Slots) time."""
        q = self.q_proj(vec)
        q1 = F.normalize(q[:, : self.half_d], dim=-1)
        q2 = F.normalize(q[:, self.half_d :], dim=-1)
        c1 = F.normalize(self.codebook_row, dim=-1)
        c2 = F.normalize(self.codebook_col, dim=-1)

        k_sub = min(self.top_k, self.sub_keys)
        s1, i1 = torch.topk(q1 @ c1.t(), k=k_sub, dim=-1)  # [M, k]
        s2, i2 = torch.topk(q2 @ c2.t(), k=k_sub, dim=-1)  # [M, k]

        # Cartesian product of top-k sub-keys -> [M, k*k] candidate addresses
        comb_scores = (s1.unsqueeze(2) + s2.unsqueeze(1)).reshape(vec.shape[0], k_sub * k_sub)
        comb_addrs = (i1.unsqueeze(2) * self.sub_keys + i2.unsqueeze(1)).reshape(vec.shape[0], k_sub * k_sub)

        best_scores, idx = torch.topk(comb_scores, k=min(self.top_k, comb_scores.shape[1]), dim=-1)
        best_addrs = torch.gather(comb_addrs, 1, idx)
        # Softmax-free positive weighting: strictly positive normalized scores keep
        # the architecture compliant with the "no softmax attention" constraint.
        weights = F.softplus(best_scores)
        weights = weights / weights.sum(dim=-1, keepdim=True).clamp_min(1e-12)
        return best_addrs, weights

    def write(self, table: CoWPageTable, key_vec: torch.Tensor, val_vec: torch.Tensor) -> int:
        """Write a single ``[D]`` fact directly to its primary pointer address."""
        addrs, _ = self._compute_addresses(key_vec.unsqueeze(0))
        primary_addr = int(addrs[0, 0].item())
        table.write_address(primary_addr, val_vec.detach().cpu())
        return primary_addr

    def read(self, table: CoWPageTable, query_seq: torch.Tensor) -> torch.Tensor:
        """Direct pointer dereference for ``query_seq [B, T, D]`` with constant GPU memory.

        The CoW chain is walked ONCE per unique address (memoized), then gathered
        as a single stacked tensor instead of per-element ``read_address`` calls.
        """
        B, T, D = query_seq.shape
        flat = query_seq.reshape(B * T, D)
        addrs, weights = self._compute_addresses(flat)  # [BT, k_used]
        k_used = addrs.shape[1]
        flat_addrs = addrs.reshape(-1).tolist()

        resolved: dict[int, torch.Tensor] = {}
        unique = set(flat_addrs)
        for addr in unique:
            cur: Optional[CoWPageTable] = table
            while cur is not None:
                if addr in cur.tombstones:
                    break
                if addr in cur.dirty_pages:
                    resolved[addr] = cur.dirty_pages[addr]
                    break
                cur = cur.parent

        zero_cpu = torch.zeros(D, dtype=torch.float32)
        vals = torch.stack([resolved.get(int(a), zero_cpu) for a in flat_addrs])
        gathered = vals.view(B * T, k_used, D)

        retrieved = (gathered.to(query_seq.device, dtype=query_seq.dtype) * weights.unsqueeze(-1)).sum(dim=1)
        gate = torch.sigmoid(self.out_gate(flat)).reshape(B, T, 1)
        return query_seq + gate * retrieved.reshape(B, T, D)
