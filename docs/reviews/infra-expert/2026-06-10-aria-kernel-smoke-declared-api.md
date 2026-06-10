# aria-kernel CI smoke vs declared-surface ledger API (2026-06-10)

**Context.** The `aria-kernel` workflow's "ARIA runtime artifact smoke" job has
failed on every `main` push since #375 merged (`aa315130c`, 12:40Z; last green
`e2ebab062`, 11:53Z). #375's train commit `42695736f` hardened
`aria_kernel/ledger.py` with declared-surface enforcement: raw
`append_jsonl` to an enterprise-governed surface now raises
`LedgerIntegrityError: raw_jsonl_declared_surface_rejected`. Every production
writer was migrated (`tool_health.py` → `expected_surface="runs"`,
`cycle.py` → `expected_surface="cycles"`), but the CI smoke script — inlined
in `.github/workflows/aria-kernel.yml` — still used the raw primitive, so the
guard correctly rejected it. Same train-debt class as EDGE-CRITICAL-001: a
path-filtered workflow that is not a required check let the train merge red.

## INFRA-MEDIUM-001 — CI smoke bypassed the ledger's enterprise write API

The smoke is a *writer* of governed surfaces (`runs`, `cycles`) and must go
through the same API production goes through — that is the smoke's entire
value. Fix: `append_jsonl` → `append_declared_jsonl(..., expected_surface=
"runs"/"cycles")`, mirroring `tool_health.py:540` and `cycle.py:294`. The
ledger guard stays untouched (it did its job); no `bypass_profile_gate`, no
legacy-context escape — the default `standard` profile permits these surfaces,
so the smoke now exercises the exact production write path end-to-end.

**Verification:** smoke body extracted verbatim from the edited workflow and
executed locally (`PYTHONPATH=aria-kernel python3`) → exit 0, evidence class
`ARTIFACT_BEARING`, no repo-output mutation detected by the watcher block.
