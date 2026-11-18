"""把旧 checkpoint 装进当前架构：同形复制、新增通道留零。

背景：`architecture.py` 在 Block 2b 加入正交 suspicion 写之后，
`stance_head` 的输入从 133 维（h_last + mean_var + incongruence）扩到 149 维
（末尾追加 n_layer * n_head 的 suspicion 电流），并且每个 Block 新增
`suspicion_dir` / `suspicion_val` 两个参数。此前训练出的权重因此无法 strict 加载。

suspicion 通道在代码里的语义是「可学习但默认不写入」：`suspicion_val`
初始化为 0，`suspicion_precision = strength * incongruence`。所以把
`stance_head` 末尾新增的列置零、缺失的 `suspicion_val` 保持零，就等价于
**旧模型原样推理、新通道不参与**，而不是随机权重冒充训练结果。

用法：
    python -m epistemic_model.serve_bridge --ckpt runs/ablation3k/.pai_ssm_full_latest.pt --compat
"""

from __future__ import annotations

import torch

from .architecture import EpistemicConfig, EpistemicWorldlineModel


def apply_checkpoint_compat(model: EpistemicWorldlineModel, state: dict) -> dict:
    """把 state 装进 model，返回可打印的兼容报告。"""
    own = model.state_dict()
    report = {"copied": 0, "padded": [], "kept_init": [], "shape_mismatch": []}

    with torch.no_grad():
        for name, target in own.items():
            src = state.get(name)
            if src is None:
                report["kept_init"].append(name)
                continue
            if src.shape == target.shape:
                target.copy_(src.to(dtype=target.dtype, device=target.device))
                report["copied"] += 1
                continue
            padded = _pad_stance_head(name, src, target)
            if padded is not None:
                target.copy_(padded)
                report["copied"] += 1
                report["padded"].append(f"{name}[{src.shape[-1]}:{target.shape[-1]}]")
                continue
            report["shape_mismatch"].append(
                {"name": name, "ckpt": tuple(src.shape), "model": tuple(target.shape)}
            )

    # 新通道的默认行为是「不写入」，显式置零，避免将来改动初始化后静默污染
    for name, param in model.named_parameters():
        if name.endswith("suspicion_val") and name in report["kept_init"]:
            param.data.zero_()

    return report


def _pad_stance_head(name: str, src: torch.Tensor, target: torch.Tensor) -> torch.Tensor | None:
    if name != "stance_head.weight" or src.dim() != 2 or target.dim() != 2:
        return None
    if src.shape[0] != target.shape[0] or src.shape[1] > target.shape[1]:
        return None
    out = torch.zeros_like(target)
    out[:, : src.shape[1]] = src.to(dtype=target.dtype, device=target.device)
    return out


def load_checkpoint_compat(
    ckpt_path: str, device: torch.device
) -> tuple[EpistemicWorldlineModel, dict, dict]:
    payload = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    cfg = EpistemicConfig(**payload["config"])
    model = EpistemicWorldlineModel(cfg)
    report = apply_checkpoint_compat(model, payload["model"])
    model = model.to(device).eval()
    return model, report, {"step": payload.get("step"), "arm": payload.get("arm")}
