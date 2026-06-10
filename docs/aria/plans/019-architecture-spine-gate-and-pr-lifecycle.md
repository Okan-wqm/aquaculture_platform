<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 019 — Architecture Spine Gate, PR CLI, Auth Lane (operator-revised, reconstructed retrospectively)

> **Branch:** `snowball`.
> **Status:** **CLOSED** — Plan 019 sign-off review v4 landed at commit `a952df16`.
> **Doc backfill:** This file was reconstructed from the 17 Plan 019 commit messages on `2026-05-08` per Plan 022 §M-3. The original Plan 019 spec was never committed to `docs/aria/plans/`; the CI invariant test `tests/invariants/aria-plan-doc-presence.spec.ts` (introduced alongside this file) prevents the same drift on future plans.
> **Sign-off review:** `docs/aria/reviews/2026-05-07-plan-019-sign-off-review-v4.md` (committed in `a952df16`).

---

## Context

Plan 016 left three load-bearing gaps that Plan 017–018 did not close:

1. **Architecture Spine** had no kernel-side invariant gate — operators had to read individual adapter outputs to detect drift across tenant scoping, event contracts, schema entities, and auth security boundaries.
2. **PR pipeline** had no kernel CLI surface — operators invoked `gh pr create` directly, bypassing the validation gate + suppression scanner contract.
3. **Auth lane** existed as a one-off adapter manifest (Plan 018 §6.A) but was not bound to the registry; the spine gate's `auth_security` invariant had no live data source.

Plan 019 closed all three. The 11-phase arc landed 17 commits between commits `0e28eacd` (Phase 0.1 preflight) and `de328198` (Phase 7.5 verification).

---

## Phase reference map (commit-by-commit)

| Phase | Commit | Subject |
|-------|--------|---------|
| 0.1   | `0e28eacd` | preflight gate fire (gate_pass true) |
| 0.3   | `a352ca04` | gitignore impact-graphs runtime dir |
| 1     | `97fca751` | plan 017 doc DEBT date drift align with ledger |
| 2     | `9a63693c` | F-002 superseded by F-003 (architectural-arbiter ruling) |
| 2.5   | `1f06bb3b` | domain agent contract extension (operator critique #3) |
| 3     | `c6b84e34` | aria-kernel pr CLI sub-command surface |
| 4     | `341d67cd` | 3 real impact sources + DEBT-002 RESOLVED (1/2) |
| 5 (rev) | `aa9dc9d2` | bind existing TS adapters to registry (no new parsers) |
| 5.5   | `5b765a7b` | Architecture Spine Gate (operator critique #4) |
| 5.5   | `705b0ab3` | first live Architecture Spine baseline |
| 6     | `1e7e7a53` | auth lane bind + spine gate auth_security live (operator critique #2) |
| 7     | `a331bc50` | change ledger primitive (operator critique #8 — append-only event-stream) |
| 7.5   | `ba1e6fd9` | impact graph governance event SSoT (operator critique #5+#6) |
| 7.5   | `de328198` | live impact compute on farm-events.ts (verification) |
| 8     | `49a6cf82` | CI Claude Code OAuth executor + spike doc (operator critique #9) |
| 9.5   | `7de14959` | widen Phase 4 globs + alias schema-drift to typeorm TS adapter (operator critique #7) |
| 10    | `a952df16` | operator sign-off review v4 |

## Closures and outcomes

- **`DEBT-2026-05-07-002`** — RESOLVED in Phase 4 (`341d67cd`).
- **`F-002`** — superseded by `F-003` per architectural-arbiter ruling in Phase 2 (`9a63693c`); historical lineage preserved (Plan 022 M-5 later relinks the still-pointing debt).
- **Architecture Spine Gate** — 4 invariants live (`tenant_scoping`, `event_contracts`, `schema_entity`, `auth_security`); first live baseline at commit `705b0ab3`. Plan 020 §4 added the fresh-orchestrator chokepoint; Plan 020 §10 added the 5th invariant (`harness_security`).
- **`aria-kernel pr` CLI** — 7 sub-commands (`prepare`, `commit`, `push`, `create`, `list-actions`, `lifecycle-plan`, `split-plan`); `--base snowball` invariant enforced at the kernel boundary.
- **Change Ledger** — append-only `change_planned` / `change_committed` / `change_validated` events with hash chain; Plan 020 §8 added the validation matrix gate that fires before `change_validated`; Plan 020 §9 added the `aria_change_chain_validation_pct` metric.
- **CI Claude Code OAuth executor** — Phase 8 spike doc (`tools/aria-poc/ci_executor_contract_spike.md`) marked the contract UNVERIFIED; Plan 020 §5 emitted `DEBT-2026-05-08-001` to track the operator-supervised closure.
- **schema-drift adapter** — aliased to `typeorm-entity-schema-adapter` in Phase 9.5 (`7de14959`).

## Boundary

Plan 019 closed the spine gate + PR CLI + auth-lane wiring backbone. It did NOT close:

- Multi-adapter registry portfolio (Plan 020 §14 outbox + cqrs; Plan 021 placeholder for the remaining 3).
- Real OAuth contract verification (Plan 020 §5 escalated to `DEBT-2026-05-08-001`).
- Kernel correctness gaps that audit later surfaced (Plan 022 closes 21 implementation fixes).

## Reconstruction provenance

This file was rebuilt from `git log --grep "plan 019"` on `2026-05-08` per Plan 022 §M-3. The original Plan 019 spec lived only in operator chat history and the per-phase commit messages; the reconstructed doc here is sufficient for traceability + audit chain integrity but is NOT the original 14-pass operator audit cycle artifact (that exists only in chat scrollback).

CI invariant `tests/invariants/aria-plan-doc-presence.spec.ts` enforces that future plan numbers (referenced in commit messages) carry a `docs/aria/plans/0XX-*.md` file before the next plan starts.
