# ARIA Full-Autonomy Program — Progress Log

> **HISTORICAL — superseded as executable authority (2026-08-22):** This log
> preserves the earlier program's measurements and checklist outcomes. Current
> execution is governed by
> `docs/superpowers/plans/2026-08-22-aria-end-to-end-autonomy-closure.md` and the
> verified boundary in `docs/aria/CURRENT_STATE.md`; this banner changes no
> historical completion state.

Program plan: [`PLAN.md`](./PLAN.md). Newest entries first.

## 2026-08-07 — the alarm nobody heard, and the bind that was spelled as a migration

Two findings closed, and in both the finding's own recorded fix shape was wrong.
Correcting them is most of what the day produced.

**`ORPHAN-MEDIUM-562` — the watchdog reports a stalled memory and freezes
nothing.** PLAN Wave 2 asks for `MERGE_FROZEN` on a watchdog anomaly; the
watchdog shipped the notification half only, and its own body says so. The
freeze now lives in `merge_authority.merge_pr_if_ready` and reads the incident
from the watchdog's own manifest, failing closed on an unreadable answer.

The finding proposed refusing in the `aria-merge-authority` workflow "because it
is already a required check". Measured, that is exactly why it cannot be: it is
required on main and runs on every `pull_request`, so refusing there blocks
every human pull request including the one repairing the stall. A second
deadlock was avoided the same way — a circuit-breaker kind would stop the cycle
at preflight, but the watchdog fires when the `aria/state` tip stalls and the
cycle is what advances it. The breaker is for failures the cycle recovers from
by _not_ acting; this is one it recovers from by acting.

**`ORPHAN-HIGH-556` — the restore bind is spelled as a migration.** Measured on
the real restore path, every night: a full tools-tree backup, a rewrite of every
covered ledger, and nine migration-ceremony rows — to re-establish a binding.

The finding said the rewrite permit expiring 2026-12-31 would kill every restore
on 2027-01-01. Driven directly, it does not: the allowance is consulted **zero**
times, because the declared-surface check that would consult it needs
`repo_identity.json` — the one file a restored tree lacks. A bound-tree control
row proves the probe can see. So the permit is decoration, and the real hazard
is larger than the recorded one: ARIA rewrote every covered ledger of its
hash-chained memory inside the one window where its own guard was blind.

Root cause: `repo_identity.json` mixes three scopes, and the single host-scoped
field — an absolute path — made the whole file unpublishable. The tree could not
state its own contract version, so it read 0. `tools_contract.json` is now a
declared surface carrying the publishable half, written by one function rather
than five copies, and `tools_binding.bind_tools_root` binds first and migrates
only a bound tree that is behind. On the nightly path: one file, one governance
row.

Two things fell out. A store published for another repository is now refused
instead of silently rebound — before the split there was nothing to compare
against. And `_guard_tools_lock` carried a hardcoded roster of operations
allowed to write while holding their own lock; the new bind was the next
operation anyone added, took the lock correctly, and could not write its own row.
That is `ORPHAN-HIGH-569`'s shape in a lock guard, and re-entrancy is now a
property of holding the lock.

**Method.** Fifteen mutations across the two findings, each applied, run, and
reverted, with the baseline confirmed green on both sides. Twice the mutation
was of an _absence_ assertion — that no breaker kind exists, that the required
check does not read the incident — and both were driven with the forbidden thing
actually in place, because an absence-assertion passes for free otherwise. One
regression was found by a test rather than by review: binding after migrating
left `migrate_tools_v2_to_v3` without the identity it refuses to run without.

## 2026-08-06 — the defect class the programme kept meeting, named twice

Two shapes were closed this day, and they are worth recording together because
each was first met as a single bug and only became tractable once it was asked
mechanically.

**"Correct, tested, exported — and called by nobody."** `ORPHAN-CRITICAL-498`,
`ORPHAN-HIGH-569`, `ORPHAN-MEDIUM-571` and `ORPHAN-MEDIUM-572` are one defect
wearing four names, and every instance was found by a human noticing. Measured:
of 85 public control-verb callables in `aria_kernel`, **18 were referenced by no
production module at all**. The worst was `verify_no_secret_in_envelope`, whose
own docstring calls it a hard-fail check on the agent-response envelope —
exported, tested, absent from `HARD_FAIL_CHECKS`, called by nothing, while its
sibling scanning diffs _was_ wired. `ORPHAN-HIGH-573` makes it a test failure
(#1110).

**"Committing inside an unguarded loop."** `ORPHAN-HIGH-575` was found by reading
a traceback: one `TypeError` on the repository's most ordinary commit shape —
code plus its own review document — escaped the loop over every pending dispatch
and disabled impact-graph computation for a whole cycle. Fixing the `TypeError`
removed the instance. Asking mechanically removed the assumption: **12 of the 16
cycle learning hooks, across 7 modules**, commit as they iterate, so item _k_
raising leaves items 1.._k_-1 on disk, skips _k_+1.._n_, and collapses the report
to one wholesale failure. `ORPHAN-HIGH-578` closes it (#1121).

**What the two have in common is the lesson.** A green suite is no evidence
against either, because the tests call the thing directly — that is precisely how
it stays green while governing nothing. Both cures are the same mechanism reused
rather than reinvented: enumerate what should hold, derive the roster instead of
listing it, require a declared waiver with an expiry compared **to the clock**,
and give the gate a positive control so "found nothing" can be told apart from
"cannot see". Both gates were caught being wrong in exactly that way before they
shipped — one counted an `import` as a use; the other stayed green when its scan
was blinded.

**Honest limits, recorded so a green gate is not read as more than it is.**
`control_reachability` asks whether a control is _called_, not whether its
refusal branch is _reachable_ — `ORPHAN-HIGH-577` is the live counter-example and
stays OPEN pending an operator policy decision, because a check that cannot
refuse is false assurance and both honest fixes need intent this session does not
have. `batch_containment` makes containment the zero-effort default, not a
structural impossibility, and its gate covers the 16 cycle learning hooks only;
the same shape elsewhere in the kernel is unmeasured.

**Also measured, correcting two of my own earlier claims.** ARIA does not
autonomously merge today: the nightly runs `--profile standard`, which selects
`NoOpAutoMergeRunner`; real merging needs `strict` or `autonomous`, which the
scheduled lane never uses. And `evaluate_v9_implementation_merge`'s hardcoded
`eligible=False` is not a defect but a deliberately demoted fail-closed surface,
with `auto_merge.merge_if_green` as the only real executor.

**Neither of those measurements says anything about `ORPHAN-MEDIUM-562`, and an
earlier version of this entry claimed they did.** 562 is not about whether ARIA
merges autonomously; it is that the external watchdog **notifies but cannot
freeze** — it files an incident issue and fails its own run, while PLAN Wave 2
specifies a `MERGE_FROZEN` breaker. The finding already records the correct
shape, so this is tracked work with a known fix rather than a decision waiting on
the operator: the freeze must be an alarm the MERGE side READS, not a write the
watchdog performs, because freezing writes the breaker ledger, that requires
importing the kernel, and every failure the watchdog exists to catch is a failure
of that kernel — a watchman that dies of the illness it watches for is not a
watchman. `aria-merge-authority` is already a required check and can refuse while
a watchdog incident issue is open, which keeps the dependency pointing the safe
way. Until it lands, a stalled ARIA memory is visible but not enforcing.

## 2026-08-04 — Wave 1 PR 2.6b: the lane cutover (written, not yet exercised)

Merged as `249a5e940` (#1073). Both scheduled lanes now restore from and publish
to the `aria/state` branch. The 30-day `aria-tools-state` artifact is retired;
what remains under that name is nothing — the forensic copy is run-scoped
(`aria-state-cache-<run_id>`) and no code path restores from it, which is the
point. Retires the transport ORPHAN-CRITICAL-484/488/513 describe.

**The blocker I had been carrying was not the one I thought.** "The cutover is
blocked on the self-hosted runner" went unchecked for a session. The runner
blocks EXECUTION; it never blocked WRITING the cutover, and the cutover was
neither written nor tracked — it lived in the parenthetical above this entry's
predecessor.

**Two defects the YAML-only cutover would have shipped**, both found by reading
the round trip rather than the diff:

- A restored store is not yet a usable tools root. `repo_identity.json` is what
  makes one resolvable and the branch deliberately does not carry it, so a
  checkout arrives as covered state with no identity — `ambiguous_tools_root`.
  `aria-auto-cycle` had the binding migration; `aria-agent-executor` never did,
  so its first restored run would have died at the lease check. The migration
  moved INTO the restore action: one definition, both lanes.

  My first fix here was wrong and PLAN §2.6 had already recorded why. I declared
  `repo_identity.json` as a state surface so it would ride the publish; it
  records `bound_repo_root`, an absolute path on the host that wrote it, and the
  branch is shared by every runner. The test I wrote passed. It would have
  passed for the wrong design — which is why the replacement asserts the
  identity is NOT published, alongside the refusal and the migration that
  resolves it.

- `seed_drift_findings.py` wrote to `<checkout>/aria-findings` while the kernel
  reads through `repo_state_root`, which the restore binds at the store. Every
  night would have seeded a full pool where nothing looks. It imports the
  kernel's resolver now.

**Honest limit:** this lands reviewed, contract-verified and locally tested, and
UNEXERCISED. The lanes run on `[self-hosted, linux, claude]`; until a real
nightly runs, no line of it has executed. **Wave 1 is not complete until that run
exists.** The operator has one-time setup first: the `aria/state` branch ruleset
(block force-push + deletions) BEFORE any bootstrap, then
`vars.ARIA_STATE_BOOTSTRAP_ACK` — see
[`docs/runbooks/aria-state-branch-bootstrap.md`](../../runbooks/aria-state-branch-bootstrap.md).

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
the store instead of the 30-day artifact. ORPHAN-CRITICAL-484/488/513 therefore
stay OPEN against the artifact transport, which is the honest state — the store
exists and is proven, and nothing is using it yet.

> **Corrected 2026-08-04.** This entry originally said the cutover "requires the
> self-hosted runner, which is offline". That conflated two things and cost a
> session: the runner blocks the cutover's first REAL RUN, not its writing. The
> cutover landed on 2026-08-04 (see the entry above) with the runner still
> offline, and found two defects that a live run would have hit on night two.

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
before any write-capable step. **Corrected 2026-08-04:** this line said
`aria-auto-cycle.yml` runs on `ubuntu-latest`. It does not, and never did —
both lanes target `[self-hosted, linux, claude]` (`aria-auto-cycle.yml:95`).
The error mattered: it implied one lane could run without the operator's
runner. What CI config
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
