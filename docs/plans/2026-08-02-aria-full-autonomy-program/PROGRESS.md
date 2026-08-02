# ARIA Full-Autonomy Program — Progress Log

Program plan: [`PLAN.md`](./PLAN.md). Newest entries first.

## 2026-08-02 — Wave 0 re-scoped: the pipeline collapse was already aboard #1045

Preparing PR 0.2 surfaced that `main` already contains the full pipeline
collapse: `cycle.py` carries the ordered `CYCLE_PHASES` SSoT (22 rows, all
extended phases registered — `validation_matrix` live under
`writes_permitted`, `pr_lifecycle` gated on `ACTION_PERMISSIONS["pr_open"]`
exactly as this program's plan ruled), the closed `CYCLE_PRECONDITIONS`
set, four named error policies, `build_phase_context` as the single
constructor, an import-time well-formedness assert, and the
`run_phases`/`pre_tool_phases` kwargs deleted outright
(`test_cycle_phase_pipeline.py` pins it). The work rode the #1041 branch's
later commits — after that PR's description declared the collapse "not
started" — and landed on `main` inside #1045's byte-identical squash
(`fd963861`), validated by this program's own Wave R run (2993 tests,
invariants green) without knowing what it carried.

Consequences, recorded rather than papered over:

- **PLAN.md's Wave 0 PR sequence is largely moot:** 0.2 (registry), 0.3
  (body flip + legacy deletion), 0.4 (extended-phase registration) and 0.6
  (kwarg deletion + single-entrance pinning) are on `main`. Remaining Wave 0
  work: **0.5** (`burn_in.py` still hand-rolls a third cycle loop importing
  `cycle` internals) and **0.7** (executor-lane PR centralization —
  verification first). PR 0.1 (`replay_pending_bridges`, #1047) was real and
  is merged.
- **`ORPHAN-CRITICAL-498` is fixed on `main` but OPEN in the registry:** the
  fix's landing commit (`fd963861`) carries no `Closes:` trailer for it —
  nobody knew at merge time. The commit registering this note carries the
  trailer; the close ceremony (PROC-HIGH-001) records the main-reachable
  SHA in the next registry commit after this lands.
- **Process lesson:** a superseding squash inherits the branch's WHOLE tree,
  including work its PR description disclaims. Wave R's reconciliation
  audited the diff mechanically (tests, invariants, registry) but took the
  description's scope claims on trust. From now on a re-land PR's scope
  summary is derived from `git diff --stat` against the merge base, not
  from the superseded PR's prose.

## 2026-08-02 — Wave R executed

- **#1045 merged to main (`fd963861`)** — the RC closeout (supersedes #1041):
  RC-2 observation/breaker split, RC-4/5 derived breaker window, RC-7/8 test
  honesty, RC-1 tier-3 reachability invariant, plus the full main
  reconciliation (five migration re-timestampings, jest spec-constant merge,
  24 expired dormancy waivers stay drained, registry re-chained to 1324 rows
  tip `444efa9a`, debt-closure repin, format-scope regeneration). Validated:
  `aria:test:unit` 2993 OK, `invariants:fast` green including the newly
  activated specs, `findings:verify` green. Route chosen by the operator:
  fresh single-commit re-land instead of growing the frozen
  `PRE_PHASE6_SHAS` allowlist (the branch's pre-retrace history carried
  trailers the #1024 retrace had invalidated). Closes ORPHAN-CRITICAL-503,
  ORPHAN-MEDIUM-483, ORPHAN-HIGH-499/502/504.
- **#1041 closed** (superseded by #1045; branch preserved for archaeology).
- **#936 closed** (superseded; autonomous mode rebuilds on Mission +
  signed-permit architecture in Waves 8/9). Salvage: `ORPHAN-HIGH-518`
  (aria-debts/keys stageable — `.gitignore` fix in the registering commit;
  no key file was ever actually tracked, the rule is preventive) and
  `ORPHAN-HIGH-519` (FAILING_CI evidence grounding — scheduled into Wave 9).
  Review: `docs/reviews/claude/2026-08-02-aria-wave-r-reconciliation.md`.
- **Program plan of record committed** (this directory; PR #1046), with the
  2026-07-26 program marked SUPERSEDED-BY + stage map.

### Runner sandbox ground truth (RC-9 scope, Wave R item 4)

Verifiable from CI config at `main@fd963861`: both ARIA lanes install
bubblewrap via `apt-get` and hard-verify `implementation_safety.sandbox_backend()`
before any write-capable step (`aria-auto-cycle.yml` — ubuntu-latest;
`aria-agent-executor.yml` — `[self-hosted, linux, claude]`). What CI config
cannot prove: whether `apt-get` succeeds and bwrap actually confines on the
self-hosted executor host (user namespaces, kernel config). **Operator action
item (PLAN.md §7.4):** run the capability probe once on the self-hosted
runner; until then the 2026-07-26 program's S0 caveat (`ORPHAN-CRITICAL-439`)
stays conservatively open for that lane.

### Program metrics (baseline at Wave R close)

| Metric                                   | Value                               |
| ---------------------------------------- | ----------------------------------- |
| Mission loss                             | n/a (mission layer lands in Wave 2) |
| Unauthorized merges                      | 0                                   |
| Registry chain                           | valid, 1326 entries                 |
| Open ORPHAN findings feeding the backlog | 104                                 |
| Waves complete                           | R (0-11 pending)                    |
