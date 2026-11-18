"""PAI-SSM: Paralinguistic-Modulated Information-Filter State Architecture.

Third-generation stateful worldline model combining:
1. 12-D paralinguistic prosody extraction (disfluency, F0 contour slope, jitter/shimmer, tempo)
2. Heteroscedastic Bayesian Information-Filter state (A, B) with exact 3-way merge (merge3)
3. Closed-form Expected Information Gain (EIG) for intrinsic active epistemic probing
4. Adversarial counter-move transition + non-crossing Quantile Stakes & Ruin head
"""

from .prosody import PARALINGUISTIC_FEATURE_NAMES, ParalinguisticExtractor, synthesize_prosody_waveforms
from .architecture import (
    BatchedInformationFilterState,
    EpistemicConfig,
    InformationFilterState,
    ProsodyIncongruenceGate,
    QuantileStakesHead,
    EpistemicWorldlineBlock,
    EpistemicWorldlineModel,
    STANCE_LABELS,
    pinball_quantile_loss,
)
from .future_field import project_future_field, counterfactual_eval, robust_stance_decision
from .synthesis import (
    ExpressionDecoder,
    FactKnowledgeBase,
    StyleMatrixBank,
    SynthesisEngine,
    SynthesisOperator,
)

__all__ = [
    "PARALINGUISTIC_FEATURE_NAMES",
    "ParalinguisticExtractor",
    "EpistemicConfig",
    "InformationFilterState",
    "BatchedInformationFilterState",
    "STANCE_LABELS",
    "ProsodyIncongruenceGate",
    "QuantileStakesHead",
    "EpistemicWorldlineBlock",
    "EpistemicWorldlineModel",
    "pinball_quantile_loss",
    "project_future_field",
    "counterfactual_eval",
    "robust_stance_decision",
    "SynthesisEngine",
    "SynthesisOperator",
    "StyleMatrixBank",
    "FactKnowledgeBase",
    "ExpressionDecoder",
]
