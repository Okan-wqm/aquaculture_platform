"""Plan ARIA-V5 invariant package marker.

Predecessor: ARIA-V3.3 CONVERGED (F-010 RESOLVED; 8 v3_3 invariants).

V5 wires adversarial convergence gates into the autonomy orchestrator:

  * V5.1 Phase 3.1 — Gate A (pre-worker primary↔challenger convergence
    via ``convergence_drainer``). 5 invariants (I-V5.1-01..05) +
    2 required-injection invariants (I-V5-01, I-V5-02).
  * V5.2 Phase 3.2 — Gate B (post-impl adversarial review).
    4 invariants (I-V5.2-01..04).
  * V5.3 Phase 3.4 — Pedagogy universalization to 75 agents.
    3 invariants (I-V5.3-01..03).
  * V5.4 Phase 3.3 — Reflection telemetry v2.
    3 invariants (I-V5.4-01..03).

Total target: 14 V5 invariants + 2 required-injection = 16 new cases.

Mock factories for ALL 4 convergence + 3 review runners are
pre-staged in ``_helpers.py`` at C1 (V5.1 landing) so C2 (V5.2) +
C3 (V5.4) reuse them with zero test-fixture churn.
"""
