# 2026-10-14 — ARIA wave 2: findings spawned by the Z.ai takeover adjudication

**Owner agent:** claude · **Cycle:** 2026-10-14-aria-wave2-spawned-findings · **Branch:**
`fix/aria-zai-quality-port`

## Why this document exists

On 2026-10-13 the operator handed Z.ai's ARIA quality audit to Claude. Wave 1 re-validated its 219
findings on origin/main 99689e46b, fixed the valid ones on this branch and registered them as
ARIA-LOW-449 to ARIA-HIGH-501
([2026-10-13-aria-quality-audit-port.md](../zcode/2026-10-13-aria-quality-audit-port.md)). Wave 2
adjudicated what wave 1 left open: the recorded stubs, the registry rows they touch, and the
defects its own critics and blind-spot audits found. Its plan groups the fixes into buckets that
land through a sequence of landing PRs (L1, L2, and so on).

A fix commit can close only a registered finding, and its `Closes:` trailer must cite the review
file of that finding's own registry row. Every row the wave-3 registry steps mint therefore uses
this file as its `review_file`. Each minted ID has a section below with the problem and the planned
fix; the landing commit appends what landed. Amendments to existing rows that no governed registry
verb can record are listed at the end.

## Findings

### ARIA-HIGH-502 — `require_lifecycle_state` waiver lapses before its control is wired

- **Wave-2 key:** ORPHAN-HIGH-573-waivers (a deadline item; ORPHAN-HIGH-573 itself is RESOLVED).
- **Problem:** origin/main carries four control-reachability dormancy waivers that expire on
  2026-10-20, so every kernel lane on main goes red from 2026-10-21 UTC. The repair stack removes
  three. `require_lifecycle_state` (`genesis_lifecycle.py:417`) still has no production caller,
  and `shadow_eval_bridge.py` appends the eval and governance rows (`:244`) before the lifecycle
  precondition it promises to check first (`:137-138`; checked only at `:298`).
- **Planned fix:** bucket `G013-573-waivers` (landing L1) calls `require_lifecycle_state` in the
  bridge after the target agent is resolved and before `run_agent_eval`, with the entry states
  derived from `ALLOWED_TRANSITIONS`, and deletes the waiver. Deadline: 2026-10-20.

### PROC-LOW-049 — committed conflict markers in a gated document, and no gate refuses them

- **Wave-2 key:** SYN-conflict-markers (wave-2 critic).
- **Problem:** the debt-closure plan's `finding-truth-table.md:251-253` on origin/main holds
  `<<<<<<< HEAD`, `=======` and `>>>>>>> 291d2adb8` with both sides empty, in a document that
  `debt-plan-truth` parses. Nothing in the repository refuses a committed conflict marker.
- **Planned fix:** bucket `SYN-conflict-marker-gate` (landing L1) deletes the three lines and adds
  `tests/invariants/no-committed-conflict-markers.spec.ts`, which fails on any tracked text line
  that starts with seven `<` or seven `>` characters and a space.

### ORPHAN-MEDIUM-840 — observability-service never runs its security-events consumer

- **Wave-2 key:** R7-011 (design G020 N3; minted at the registry step before wave 1).
- **Problem:** `SecurityEventsModule` subscribes `events.security.events.>`
  (`security-events-consumer.service.ts:30`), but no module imports it (`app.module.ts:38`), so the
  observability security counters and structured logs are never produced. admin-api-service still
  stores the events.
- **Planned fix:** a product-lane PR (wave-2 operator question Q26 decides the branch) imports the
  module in `AppModule` and adds a tier-3 invariant that every `apps/<svc>/src/**/*.module.ts` is
  reachable from its service's `AppModule`.

## Registry amendments recorded at the L1 registry step

- **ARIA-HIGH-281** (wave-2 key R7-008): reopened by `finding-registry reopen`, which rejects
  closer 9665c5862 (false close: the T2 probe reads a root-owned anchor through the hardened git
  as gharunner, git refuses it, and nothing refreshes that checkout). The plan dates it
  2026-10-28; no governed verb sets a deadline, so the row keeps 2026-10-09 until the operator
  re-dates it (wave-2 operator question Q12). Fix: bucket `R7-t2-anchor-read`.
- **ORPHAN-MEDIUM-532:** to be treated as HIGH. The crossing happened: `runs.jsonl` passed the
  64 MiB per-surface cap and state publishes are refused. The ID carries the severity and no
  governed verb changes it; the plan ranks its bucket `R-532-size-consumer` HIGH.
- **ORPHAN-HIGH-430:** to be treated as MEDIUM. No deployment unit runs the daemon, and production
  uses the correct 24-hour window. Same constraint; the plan ranks its bucket
  `R-430-watchdog-window` MEDIUM.
- **ARIA-HIGH-415:** its closing evidence must also cite
  `aria-kernel/tests/test_auto_cycle_observation_steps.py`, the only test that pins the workflow
  half. It closes from its repair-stack trailer; the L1 PR body carries this citation.
