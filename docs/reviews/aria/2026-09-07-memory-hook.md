# ARIA memory-hook call contract

## ARIA-HIGH-044

State: OPEN pending merge. Owner: `aria-acceptance-gap-fixer` / `okan`.
Deadline: 2026-09-13.

The production orchestrator invokes `MemoryHook.record()` after convergence without the
required `converged_plan` argument. The hook therefore raises before recording its observation.
Its previous result also claimed `memory_hook_recorded` and a verified chain when no signer
existed and no convention had been written.

The convergence ledger owns the reviewed plan body. The hook now reads it by `plan_id`,
requires `CONVERGED`, and uses the existing hash-verified body reader. Callers no longer
provide a second plan copy. With no cycle signer, the hook returns `needs_signing`,
`convention_recorded=false`, and `chain_verified=null`; its governance disclosure identifies
the canonical revision and content hash and is emitted once for that standing fact.
The orchestrator's later implementation signer is not available at this phase.

The supplied-signer path retains hypothesis confidence below the serving floor and reports
recording or chain failures explicitly. It does not establish a verified outcome. Signed
convention storage remains append-only; only the unsigned disclosure's replay behavior is
claimed here.

Evidence:

- `aria-kernel/aria_kernel/autonomy_orchestrator.py`: production memory-hook call.
- `aria-kernel/aria_kernel/cycle_phases/memory.py`: canonical plan ownership and effect status.
- `aria-kernel/tests/test_autonomy_orchestrator.py`: selected production hook accepts the
  canonical plan and rejects missing, unconverged, or tampered ledger state.
- `aria-kernel/tests/invariants/v3_1/test_phase_v31_c2_memory_hook_wire.py`: unsigned replay,
  supplied-signer hypothesis, invalid fingerprint, and hook ordering coverage.

Validation: the original focused suite passed 49 tests; the added replay regression passed
separately. Replacing deduplicated disclosure with ordinary append made that regression fail
with three observations instead of one. On mainline base `a618cb4ee`, the 18-test memory,
scaffold, and production-call integration run passed, as did five workflow CLI/registry tests.

## P14 remains open

This finding closes the call-contract defect and false effect reporting only. It does not
complete [P14's full learning contract](../../superpowers/plans/2026-09-06-aria-security-runtime-closure.md#p14--her-iddiası-yanlışlanabilir-güncel-ve-işe-etkisi-ölçülen-öğrenme).
Every unchecked P14 requirement and acceptance condition remains open, with owner
`aria-acceptance-gap-fixer` / `okan` and deadline 2026-09-13:

- Current-SHA task understanding, architecture/flow maps, design and requirement coverage,
  worker/context freshness gates, and complete producer/consumer integration.
- All-author main-change ingestion, webhook/API/Git backfill, durable cursors, deduplication,
  intent provenance, outcome classification, and honest coverage reporting.
- Typed durable memory, decision history and supersession, restart/restore/redaction receipts,
  full-history retrieval indexes, and separate storage, index, and context budgets.
- `LearningAssertionV2`, distinct static/test/runtime evidence, typed Nx/NATS/event/business-flow
  graphs, the four executable flows, contradiction accounting, and test-to-CI reachability.
- Transitive invalidation/refutation before serving, immutable target-blob excerpts, complete
  required-test witnesses, bounded context manifests, uncertainty, and independent validation.
- OutcomeProof-based promotion and measured scheduler rewards; merge or convergence alone
  must not count as correctness, usefulness, or autonomous acceptance.
- Terminal usage receipts, idempotent budget reservations across retries/fallbacks, deterministic
  reuse, measured token economics, and protected shadow/holdout evaluation.
- Retrieval redaction/access/retention/egress controls, derived knowledge views without policy
  authority, and real P06/P07/P08/P13 production wiring under existing human approval limits.

P14's complete mandatory regression matrix and acceptance still apply: four evidenced flows,
an external P13 repair traced through post-merge outcome, automatic invalidation, and a measured
learning contribution on a fixed safe task set. This PR supplies no live signing, activation,
autonomous merge, whole-repository understanding, or measured-learning-success evidence.
