<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 030 — Acceptance & Gap-Closure Lane

> **Status:** Implemented (deterministic harness + 4-agent lane + command).
> **Branch:** `claude/aria-gaps-cost-review-rebmuc`

## Summary

ARIA is designed-but-undriven: nothing had validated its outputs or proven its
behaviour on this repo. This lane does both — it **validates ARIA's outputs**
against repo evidence and **closes ARIA's gaps** — built on one principle that
mirrors ARIA's own: the accept/reject verdict is a **deterministic assertion**
against repo evidence, never an LLM opinion. The agent layer adds judgment only;
its verdicts are leads, and fixes are review-gated (no auto-merge). The harness
lives OUTSIDE the kernel because the auditor cannot be part of the audited.

## Pillar 1 — Deterministic harness (truth) ✅

`tools/aria-acceptance/harness.py` (+ `test_harness.py`), three checks:
- **`validate_drift_output`** — runs the LLM-free drift scan (`poc.py`) and
  re-verifies every above-threshold drift's evidence refs at HEAD via
  `evidence_trust.classify_evidence_ref`, classifying true-positive /
  false-positive / unverifiable. **On this repo today: 9 drifts → 5 TP, 4 FP,
  0 unverifiable.** The 5 TP cite archived migrations — the nuance the agent
  layer judges.
- **`run_cycle_acceptance`** — drives a full kernel cycle in an isolated temp
  workspace + bound tools-dir (the clean trial CURRENT_STATE demands) and asserts
  behavioural invariants (terminal row, phase keys, hash-chain-valid ledger,
  isolation held).
- **`assert_reacts_to_scenarios`** — seeds a stale belief / consensus
  disagreement / runtime signal and asserts ARIA reacts (decays, escalates to
  HUMAN_REQUIRED, surfaces UNVERIFIED pressure).

Runs today: `python3 tools/aria-acceptance/harness.py` → exit 0 (ACCEPT).

## Pillar 2 — Agent lane (judgment) ✅

`.claude/agents/aria-acceptance-*` (4 agents, all `dispatch: ad-hoc`, pedagogy-
lint clean, no ownership globs):
- **aria-acceptance-lead** (opus/xhigh) — project lead: runs the harness,
  dispatches specialists, decides accept/reject, sequences gap closure.
- **aria-acceptance-output-validator** (sonnet/medium) — runs the harness, adds
  judgment on borderline drifts (e.g. the archived-migration caveat), escalates
  any `unverifiable` drift.
- **aria-acceptance-gap-hunter** (sonnet/high) — audits ARIA for blind spots /
  missing capabilities, produces tracked findings (owner + deadline).
- **aria-acceptance-gap-fixer** (opus/xhigh, write-tier) — closes a validated gap
  with a root-cause fix + test and opens a **draft PR**; never auto-merges.

Command: `/aria-accept` (`.claude/commands/aria-accept.md`). Invariant hardening:
`aria-acceptance-gap-fixer` added to `ARIA_WRITE_TIER` in
`tests/invariants/agent-frontmatter-schema.spec.ts` so the write-capable auditor
cannot be downgraded.

## The iron rule

Pass/fail is always the deterministic harness; an agent verdict is a lead
recorded alongside it, never overturning it silently; corrections land as
review-gated draft PRs. This keeps the watcher from hallucinating ARIA's
behaviour — the same evidence-trust stance ARIA applies to itself.

## Acceptance

- `python3 tools/aria-acceptance/harness.py` exits 0 on the real repo.
- `python3 -m unittest test_harness` (in `tools/aria-acceptance/`) passes.
- The 4 agents pass pedagogy-lint (`python3 -m aria_kernel.pedagogy_lint --strict`)
  and the frontmatter/name-uniqueness invariants.

## Assumptions & deferred — ARIA-030-D1

- ARIA's LLM outputs (findings/beliefs/plans) are not produced on this repo yet
  (`runs.jsonl` empty), so `validate_drift_output` is the live output validated
  today; validating LLM-emitted findings activates once ARIA runs a mock cycle.
- Real autonomous mode needs Codex managed-auth on a trusted runner (absent
  here); the harness is intentionally scoped to mock/isolated runs — deterministic
  and safe. Driving the full unlock burn-in is tracked as ARIA-030-D1.
