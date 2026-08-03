# ARIA Full-Autonomy Program — Progress Log

Program plan: [`PLAN.md`](./PLAN.md). Newest entries first.

## 2026-08-03 — Wave 1 COMPLETE (except the lane cutover)

Durable state landed before missions, per Revision 2's reordering. Seven PRs,
each independently landable, each with its finding closed by the next:

- **#1052 (`db4d937f`)** — PR 2.1/2.2: integrity coverage derived from the
  manifest rather than a hand list, and `manifest_root` as the tree-level
  continuity root (ORPHAN-HIGH-433, 528).
- **#1053 (`cdf7b585`)** — every workflow job that runs kernel code now
  provisions the kernel first (ORPHAN-HIGH-529). The daily-report lane had died
  on `ModuleNotFoundError: yaml` for seventeen days.
- **#1054/#1055 (`ecd004af`, `c218d174`)** — PR 2.3/2.4: the `aria/state` store,
  FF-only push as compare-and-swap with a content-addressed ancestry proof, and
  the workspace + repo-state roots bound to it (ORPHAN-HIGH-531, 533, 534).
  A near-miss caught before it shipped: `publish_state` staged the whole tree,
  and `gh_token_factory` writes per-cycle ed25519 private keys beside the
  declared ledgers — staging is now exactly the snapshot's own surfaces.
- **#1056 (`5295feec`)** — repetition stopped reading as corroboration: one
  unchanged file had carried a belief 0.605 → 0.925 in eleven cycles
  (ORPHAN-HIGH-535).
- **#1057 (`705c237e`)** — the autonomy ladder gained a time dimension:
  thirty successes spanning a seventeen-day hole no longer satisfy a threshold
  of thirty (ORPHAN-HIGH-530). The obvious fix — gating cycle recording on lane
  liveness — was _vacuous_, since a dead lane runs no cycles.
- **#1058 (`e16b4e22`)** — converged plans are recorded as hypotheses below the
  serving floor instead of 0.9-confidence conventions, so ARIA stops compounding
  its own predictions into its own priors (ORPHAN-HIGH-536).
- **#1059 (`79f3e54e`) / #1060 (`31447612`) / #1061** — the helm-registry CI
  flake fixed at its root, the `state_continuity` preflight gate, and
  contention replay for a lost publish race (ORPHAN-HIGH-538, 539, 540).

### Plan corrections made while building, not after

- **§2.5's "delete the silent-bootstrap path" named the wrong line.**
  `integrity migrate-tools-bootstrap` is a contract migration (v0/v1/v2 → v3),
  and PR 2.6 found the second, stronger reason it must stay: a store-checked-out
  tools root has no `repo_identity.json` (machine-local binding state, correctly
  not a declared surface) and that command is the only governed way to bind it.
  Deleting the step would have made the state-store lane unable to start.
- **The silence was never in that step.** The restore action already fails hard;
  the gap was that both lanes evaluate the transport proof at the END of the job,
  having already acted. The kernel-side continuity gate is the missing consumer,
  and it asks a different question: not _did the download work_ but _is this the
  state we left_.
- **A third verdict, `unknown`.** Continuity is only decidable against a
  reference outside the tree, and none exists on `main` yet. The gate reports
  `unknown` every night and blocks nothing until the daily anchor lane resumes
  or the store lane cuts over — recorded here rather than left to be discovered.
- **The advisory publish lease is deliberately not built.** With replay the race
  is correct and cheap; an advisory lease adds a second answer to _who may
  publish_, whose stale-lease failure mode is worse than the problem.

### What Wave 1 did NOT deliver

The **lane cutover** — pointing `aria-auto-cycle` and `aria-agent-executor` at
the store instead of the 30-day artifact. It requires the self-hosted runner
(`[self-hosted, linux, claude]`), which is offline: today's scheduled runs queue
and auto-cancel. ORPHAN-CRITICAL-484/488/513 therefore stay OPEN against the
artifact transport, which is the honest state — the store exists and is proven,
and nothing is using it yet.

### Method note

Every fix in this wave was mutation-checked, and the mutations paid for
themselves three times: a "winner is checked too" test that did not test it, a
`::warning::` assertion satisfied by the wrong message, and an idempotency claim
that was false by construction. Each was a passing test that proved less than its
name claimed.

## 2026-08-03 — Wave 0 COMPLETE

- **#1049 merged (`980876e9`)** — the burn-in lane collapsed into the one
  pipeline as a mode (`CYCLE_PHASES.modes` column; `run_observe_burn_in`
  delegates each cycle to `run_enterprise_cycle(mode="burn_in")`;
  lifecycle rows have a single owner). Closes ORPHAN-HIGH-521. Also
  aboard: the ORPHAN-CRITICAL-498 close ceremony and the
  pressure-fixture calendar-bomb fix (ORPHAN-HIGH-522 — fixtures dated
  2026-05-05 crossed the 90-day faded threshold at 2026-08-03T00:00Z and
  broke every branch's CI at once; now wall-clock anchored).
- **#1050 merged (`2e3863e3`)** — executor-lane PR opening centralized on
  the kernel CLI (ORPHAN-HIGH-523): `ALLOWED_BASH_COMMANDS` swaps raw
  `gh pr create` for `python3 -m aria_kernel pr create` (routes through
  `open_pr_for_action`'s guards); the scheduled executor lane sets
  `ARIA_EXECUTOR_PR_VIA_KERNEL=1`, making the kernel path the single
  reachable one there. 521/522 close ceremonies rode this PR.
- **Remaining tracked follow-through (Wave 0's only open end):** after
  one green scheduled `aria-agent-executor` run under the flag, delete
  `LEGACY_GH_PR_CREATE_PATTERN` and the flag together (§0.7 two-step).
- Wave 0's original items 0.2/0.3/0.4/0.6 had landed inside #1045's
  squash (see the 2026-08-02 re-scope entry below); 0.1 was #1047.

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
