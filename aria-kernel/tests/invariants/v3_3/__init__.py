"""Plan ARIA-V3.3 invariant package marker.

Predecessor: ARIA-V3.2 (D1 unified belief-freshness writer + D2
reflection absolute-path assertion + D3 cycle_id schema completeness).

V3.3 closes F-010-D4 (tools_dir Tier-1 rewrite — always-absolute,
walk-up resolver, raise on unresolvable) + F-010-D2-POSTMORTEM
(reflection-runs-mid-cycle reordering — defer_reflection kwarg +
orchestrator post-worker reflection).

Eight invariant cases:
  I-V3.3-01..04, 08  — tools_dir Tier-1 (Phase 3.1)
  I-V3.3-05..07      — reflection ordering (Phase 3.2)
"""
