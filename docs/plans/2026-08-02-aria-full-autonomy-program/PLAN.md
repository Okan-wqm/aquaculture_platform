# ARIA Full-Autonomy Program — Plan of Record

- **Plan date:** 2026-08-02
- **Owner:** okan
- **Audit baseline:** `main@7e1563e6` (ARIA kernel surfaces byte-identical to `f723a488`, the external review's reference)
- **Design source:** operator design document "ARIA Tam Otonom Yazılım Ekibi Tasarımı" (47 sections, 2026-08-02) — target state is its §47 _Final Definition of Done_
- **Supersedes:** `docs/plans/2026-07-26-aria-software-team-program/PLAN.md` (stage map below); that plan's registered findings remain authoritative in the registry
- **Status:** Wave R in progress
- **Revision 2 (2026-08-02):** operator asked for a second pass over the design
  document with the repo evidence and this program's own judgment. Deltas:
  wave order swapped (durable state now lands **before** missions — a mission
  ledger on a 30-day artifact violates "no mission silently lost" from birth);
  the Digital Twin is split into an early **Twin-lite** (file-level deps,
  test↔source, contract surfaces, churn/co-change) with the deep symbol graph
  deferred to Wave 10 behind a demonstrated-need gate; the external watchdog
  moves early (Wave 1 era — the transition period needs it most); explicit
  non-goals declared (embedding/search index, Graphify, traffic-percentage
  canary until infra exists, ARIA ownership of §35 domain invariants — those
  belong to the platform's own suites and Lane-A/B agents); §43 acceptance
  scenarios classified (CI-executable / infra-gated / platform-owned) with
  ladder promotion bound to the CI-executable class only; the ladder cadence
  (30/30/30 at nightly pace) named as an explicit operator knob rather than an
  inherited default.

## 1. Goal

Evolve ARIA from a plan-and-review meta-system into a full autonomous software
organization: persistent missions closed DISCOVERED→VERIFIED without per-task
human approval, durable memory, a Repository Digital Twin, an agent/tool
factory, independent verifiers, a signed Machine Merge Authority, a runtime
feedback loop, and safe self-upgrade. A mission's correct outcome is not always
a merge: `POLICY_REJECTED` and `NO_ACTION_REQUIRED` are first-class verified
terminals.

## 2. Verified starting point (session audit, 2026-08-02)

**Strong foundations (evolved, never rebuilt):** `merge_authority.merge_pr_if_ready`
(risk lanes, autonomy unlock, readiness claims, runner attestation, rollback
bundles, head-SHA freshness, triple gate); `validation_matrix_gate` (diff→risk
class→required test layers); `change_ledger` planned→committed→validated chains;
hash-chained `knowledge_graph` with quarantine; `runtime_signal_bridge`'s
signal≠evidence trust split; `state_manifest`'s 160 typed surfaces; the
genesis/eval/quarantine skeleton; watchdog + circuit breaker; profile/ladder.

**Verified critical gaps (the program closes these):**

1. No persistent Mission — task identity is cycle-scoped (`task.py`), the
   generator has no production caller.
2. Dual/dead pipeline — `run_phases=`/`pre_tool_phases=` have no production
   caller (ORPHAN-CRITICAL-498); GATE_PRE_PR_OPEN is not on the scheduled lane;
   real PRs are opened by agent subprocesses, bypassing `open_pr_for_action`
   entirely; `burn_in` is a third hand-rolled loop.
3. `replay_pending_bridges` does not exist — under `strict`/`autonomous` every
   cycle unconditionally breaks with `bridge_replay_required`.
4. State rides a 30-day GitHub Actions artifact with silent fresh-bootstrap on
   loss; workspace-root surfaces (10, incl. all workspace memory) live under
   the runner's `$HOME` and die **every run**; `aria-findings/` is gitignored
   and uncarried, so finding IDs reset to F-001 on every bootstrap.
5. `integrity verify` covers ~35 of 160 declared surfaces (ORPHAN-HIGH-433).
6. Re-observed evidence re-increments belief support/confidence
   (`memory.py:589-602`) — repetition reads as certainty.
7. Converged plans are recorded as 0.9-confidence conventions pre-outcome
   (`cycle_phases/memory.py`).
8. `merge_finalized_no_incident` is written at merge time; no observation
   window; mission-style outcome verification does not exist. The breaker's
   `ci_red` kind has no producer.
9. 7 of 17 `HARD_FAIL_CHECKS` are `_not_implemented` stubs — all at
   `GATE_PRE_MERGE`. The merge-authority token is an unsigned deterministic
   string (no nonce, no expiry, not single-use).
10. No maintainability/refactoring pressure source; no symbol-level repo graph.
11. Every autonomy switch is off (`AUTONOMOUS_AUTO_ACK_LANES = ∅`,
    `AUTO_PROMOTE_DEFAULTS.enabled = False`, agent eval `mock_mode=True`,
    `IMMUTABLE_AGENT_FILE_HASH_REGISTRY = {}`), and the nightly's `standard`
    profile maps to NoOp merge/implementation runners — the entire action
    machinery is inert on the scheduled lane.

## 3. Operator decisions (recorded 2026-08-02)

| Decision                       | Choice                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical state store          | Dedicated orphan git branch **`aria/state`** (hash-chained JSONL segments + signed snapshot manifests, fast-forward-only push as CAS); the Actions artifact is demoted to cache |
| Open ARIA PRs                  | Land **#1041** first (rebased/merged with main); close **#936** as superseded — autonomous mode is rebuilt on the Mission + signed-permit architecture                          |
| Merge-autonomy activation      | **Staged automatic promotion** (§44.1 rungs); each promotion is decided by the executable acceptance suite + outcome thresholds, not per-task human approval                    |
| Runtime signal sources (first) | **GitHub-native + operator CLI** (Actions failures, deploy workflow results, main CI status); Prometheus/Sentry connectors are a later phase                                    |

## 4. Program principles

- **Evolution, not greenfield.** The design document's §40 module tree is a
  target taxonomy, not a file plan. Every capability lands inside the existing
  kernel; a parallel second system is forbidden (that pattern produced
  ORPHAN-CRITICAL-498).
- Every wave lands as independent PRs with `aria:ci:all` green; every fix
  commit carries a `Closes:` trailer; the nightly must stay green **through**
  each migration (flagged/soaked cutovers, never big-bang).
- The design document's 20 immutable rules (§4) are progressively converted to
  invariant tests; each wave's "completion evidence" names the §43 acceptance
  scenarios it makes executable.
- Cost model is wall-clock (subscription CLI runtime; USD is telemetry only) —
  consistent with the #1024 ruling.
- **The core diagnosis (Revision 2):** ARIA's biggest deficit is not missing
  design but written-yet-unreachable machinery (dead perimeter, 7/17 pre-merge
  stubs, empty hash registry, mock-mode evals, NoOp runners on the nightly, a
  bridge-replay function that was never written, artifact-borne state). Most
  wave content is therefore wiring + hardening + activation of what exists,
  with new subsystems only where nothing exists at all (missions, state
  branch, permits, connectors).

## 4b. Non-goals (Revision 2 — declared out of scope)

- **Embedding/search index** (design §24.1/8): fuzzy retrieval inside an
  evidence-first trust chain; excluded until a concrete retrieval failure is
  demonstrated.
- **Graphify** (design §19.1): no integration exists in this repo; the
  principle it encodes (inference ≠ compiler truth) already lives in
  `evidence_trust` grades.
- **Traffic-percentage canary / blue-green** (design §34): no infrastructure
  on the docker-compose droplet; Wave 9 ships deploy-verify + risk-windowed
  observation + config-service feature flags + auto-revert. Real canary is a
  human-owned infra prerequisite, tracked as debt.
- **ARIA ownership of §35 aquaculture domain invariants:** biology/tenant
  business rules belong to the platform's own invariant suites and the
  Lane-A/B domain agents. ARIA verifies their _existence and coverage_ (twin
  TESTED_BY), it does not own the rules — duplicate ownership is exactly what
  the repo's retired-roster rule forbids.
- **The design's §40 module tree as a file plan** — flat evolution instead.

## 4c. §43 acceptance-scenario classification (Revision 2)

- **A — CI-executable** (these gate ladder promotion): 1-5, 9-17, 19-28,
  30-33, 36-39, plus 40 as a capability-absence invariant and 7 as the
  polling-only default.
- **B — infra-gated:** 18 (canary), the rehearsal half of 34, 35
  (deploy-SHA match — once deploy-verify exists).
- **C — platform-owned:** 29 (MQTT idempotency — sensor-service's suite),
  §35.x domain rules.

## 4d. Adopted from the mathematical-kernel proposal (2026-08-03)

A second agent produced a design document ("ARIA Matematiksel Karar, Zekâ ve
Güvenilirlik Çekirdeği") proposing TLA+ model checking, a CP-SAT scheduler, a
POMDP action model, conformal prediction, Dempster–Shafer fusion, doubly-robust
ATE estimation and roughly forty-five new record schemas.

**It is declined as a whole, and four parts of it are adopted.** The reason for
declining is not difficulty — it is that the document assumes ARIA has a
_decision-quality_ problem. The evidence says otherwise: of the seven PRs that
closed Wave 1, six fixed machinery that had been written and never called (a
dead perimeter, a bridge drainer resolving to a function that did not exist, a
NoOp merge runner, a verifier covering 35 of 160 surfaces, state that died with
the runner, a ladder that could not tell thirty successes from a seventeen-day
hole). Adding forty-five schemas and a constraint solver to a system whose
nightly lane is offline reproduces exactly that defect at larger scale. Nothing
here is calibrated, because ARIA has not yet produced the outcomes calibration
would be computed over.

The four items below are adopted because each names a defect that is in the
tree today. They fold into existing waves rather than getting a wave of their
own.

### 4d.1 Typed confidence — Wave 2, with the mission schema (ORPHAN-HIGH-541)

`confidence` is a bare float in at least five places with five different
meanings: a frequency-derived pattern score (`knowledge_graph.MIN_PATTERN_CONFIDENCE`
= 0.7), a decaying belief weight (`memory._record_belief`, stale below 0.5), a
self-reported judge probability (`feedback_store.CONSENSUS_MIN_CONFIDENCE` =
0.80), an adapter-emitted detector score (`tool_runner._valid_memory_candidates`),
and an explicitly-ranged instinct score (`instinct_candidate.confidence_0_to_1`).

The defect is not that there are five — it is that two of them disagree about
what an out-of-range value means, and the disagreement fails OPEN:
`instinct_candidate` refuses (`raise GovernanceError` outside [0,1]);
`tool_runner` clamps (`min(float(confidence), 1.0)` after accepting any
non-negative number). An adapter that emits `confidence: 5` — a count, a
severity, a milliseconds reading — is silently promoted to 1.0, maximum
certainty, and flows into `_record_belief` as a belief weight. A unit error
becomes a certainty. Tracked as ORPHAN-HIGH-541; the tier-1 fix (a validating
`Confidence` construction path per kind; the clamp deleted, not widened) lands
with Wave 2's first schema PR so the schema work stays in one place.

### 4d.2 Evidence independence groups — Wave 4, with the evidence envelope

PR 2.5 (`5295feec`) closed ONE instance: `_record_belief` gates `support_count`
and the confidence term on `evidence_hashes` actually changing, so re-reading an
unchanged file stops reading as corroboration (one file had walked a belief
0.605 → 0.925 in eleven cycles). The general rule is the same shape one layer
down, in `evidence_trust.EvidenceEnvelope`: two refs sharing a source, fixture,
or model lineage are ONE vote. The envelope already carries `content_hash`,
`trust_grade` and `self_output_class`; quorum counting (`expert_review_gate`,
`feedback_store` consensus) counts distinct independence-group keys derived
from those, not envelopes. Closes the class, not the instance.

### 4d.3 INCONCLUSIVE as a first-class verdict — Wave 4, alongside 4d.2

Shipped once already: `memory_gap.GAP_UNKNOWN` exists because continuity is
undecidable without an outside reference, and `agent_question.RESPONSE_VERDICTS`
admits `refused`. The calibration path does not, and its omission is baked into
arithmetic rather than vocabulary: `feedback_store.FEEDBACK_VERDICTS` is the
closed pair `("true_positive","false_positive")` and `judge_calibration`'s
`else` branch ASSUMES the complement — so a judge that cannot decide must
guess, and a third verdict added later would silently count as
`false_positive`. Adding the third member requires the `else` to become
explicit and undecidable rows to leave the denominator, not be scored into it.
This must land before Wave 10's calibration measurement consumes the ledger.

### 4d.4 "No score bypasses a hard gate" — invariant, Wave 8

`implementation_safety.HARD_FAIL_CHECKS` contains no confidence arithmetic
today; the property holds by habit, not construction. Wave 8 rewrites half that
registry (the seven `_not_implemented` stubs) — exactly when a confidence
threshold is most tempting as a shortcut. One invariant test, written BEFORE
the stubs are filled.

### 4d.5 The one genuine gap the document exposed — Wave 10 (+ Wave 9)

`e16b4e22` added `outcome_status` so a converged plan records as a hypothesis
rather than a 0.9-confidence convention — and nothing measures those hypotheses
against what happened. `judge_calibration` measures judges against a
human-labelled goldset; there is no equivalent for ARIA's own predictions. Wave
10 gains Brier score + expected calibration error over recorded
prediction/outcome pairs, possible only after Wave 9 supplies the outcome half.
Sequential change detection (CUSUM/SPRT) defers to the same window for the same
reason: `circuit_breaker.FAILURE_KINDS` names `ci_red` and nothing produces it
yet, so there is no series to detect over. Preregistered observation plans
(pick the metric before seeing the result) land with Wave 9's observation
window, where they are nearly free.

### 4d.6 Declined, with the reason

TLA+ full model checking, CP-SAT scheduling, POMDP action selection, conformal
prediction, information geometry, Dempster–Shafer fusion, doubly-robust ATE
with a propensity model, category theory / TDA, and the ~45-schema recording
surface. Each is declined for the same three reasons, and "hard" is not among
them: no consumer exists, no data volume justifies it, and every one is itself
a maintained surface that would need verifying. Causal ATE in particular needs
the canary infrastructure Wave 9 already declared out of reach on a
docker-compose droplet. The document's own §5 says P0 must land before P2/P3
autonomy opens — that sequencing is right; the disagreement is about what
belongs in P0.

## 5. Waves

### Wave R — PR reconciliation + ground truth (in progress)

1. Merge `main` into `claude/aria-security-audit-findings-8l9it5` (#1041),
   resolve conflicts, land it. Conflict resolutions of record: five branch
   migrations re-timestamped above main's maxima (`1808100000000-RestoreSharedAccessLogs`,
   `1808200000000/1808400000000/1808500000000-RestoreAuditImmutabilityContract`,
   `1808300000000-RestoreAuthUsersTenantFk`) because both sides had claimed
   `1801600000000` (admin-api) and `1806900000000` (farm); jest invariant lists
   kept the branch's named-constant structure + main's three new specs; the
   dormancy manifest took the branch's `{}` (all 24 waivers had expired
   2026-06-30 — activating them is that PR's work); the finding registry took
   main's 1308 rows + the branch's 16 (ORPHAN-502..517) re-chained via
   `rechain-from 1308` (tip `444efa9a`, `findings:verify` green); the
   debt-closure plan trio was repinned; `format-scope.json` regenerated.
2. Close #936 as superseded. Salvage first: the ORPHAN-HIGH-334 substance
   (per-cycle ed25519 **private keys** + token files under `aria-debts/keys/`
   are stageable — no ignore rule on main) is re-registered under a fresh ID
   and fixed (`.gitignore` rule now; the workflow-contract write root lands
   with the Wave 8/9 autonomous-lane rebuild). The ORPHAN-HIGH-333 substance
   (FAILING_CI plan source emits `gh-run-list:<id>` evidence that can never
   grade `repo_verified` → plan starvation) is re-registered for the Wave 9
   connector work. Neither row exists in main's registry today.
3. Commit this plan; mark the 2026-07-26 program superseded with the stage map:
   S0→R/0 (sandbox reality check), S1→W0/W1, S2→W8, S3→W11, S4→W9, S5→W2.
4. Runner sandbox ground truth (RC-9): document what is verifiable from CI
   config; a live bwrap capability probe on the self-hosted executor lane is
   an operator action item.

**Completion evidence:** #1041 merged; #936 closed with salvage landed or
registered; `findings:verify` green on main; this plan committed.

### Wave 0 — Pipeline collapse: one `CyclePhase` SSoT

New `cycle_phases/registry.py` (`CyclePhase`, `PhaseContext`, `PhaseResult`,
ordered `CYCLE_PHASES`, `run_cycle_pipeline`, `phases_for(mode, profile)`) +
`cycle_phases/kernel_phases.py` (runners extracted 1:1 from `cycle.py:389-595`
and `:704-973`). Phase order maps today's behavior verbatim and reserves slots
for `state_continuity` (W2), `mission_reconcile`/`mission_ingest`/
`mission_scheduling` (W1). The `post_tool_failure` chain becomes
`failure_policy="halt_integrate_chain"`.

Key rulings:

- `pr_lifecycle` is gated by `ACTION_PERMISSIONS["pr_open"]` (**not**
  `PROFILES_WITH_ACTION_AUTHORITY` — that would fail every `standard` nightly);
  under `standard` it runs dry-run (making the breaker's only
  `validator_rejection` producer finally reachable — closes
  ORPHAN-CRITICAL-498), live under `strict`/`autonomous`. `pr_open` gains its
  first `enforce_profile_for_action` callsite.
- Burn-in stops being a third loop: `run_observe_burn_in` keeps its signature
  and evidence bundle but drives `run_enterprise_cycle(mode="burn_in")`; the
  phase filter structurally guarantees the no-action property.
- `bridge_status_ledger.replay_pending_bridges` is written (pending +
  retry-budget rows re-invoked through the shared extracted
  `_invoke_bridges_for_result`; return shape pinned to the orchestrator's
  consumer contract). This alone un-breaks `strict`/`autonomous`.
- PR production centralizes: agent subprocesses lose `gh pr create`
  (`ALLOWED_BASH_COMMANDS` trim); executors call
  `python3 -m aria_kernel pr open …` → `open_pr_for_action(dry_run=False)`, so
  GATE_PRE_PR_OPEN + the breaker producer guard the executor lane too.

PR sequence 0.1–0.7 (each independently landable): bridge replay → registry +
golden-parity fixture (legacy body vs pipeline across standard/observe/
discovery_only/shadow_only/injected-failure) → body flip + legacy deletion →
extended phases registered (`record_and_continue` +
`phase_would_have_failed` soak → `fail_cycle` after 7 clean nightlies) →
burn-in mode → kwarg deletion + no-second-entrance invariants → executor PR
centralization (flag-guarded).

**0.7's follow-through gate, corrected 2026-08-03.** The plan said the legacy
`gh pr create` pattern and `ARIA_EXECUTOR_PR_VIA_KERNEL` get deleted together
"after one green scheduled run". That gate cannot be reached by waiting:
`aria-agent-executor` declares `runs-on: [self-hosted, linux, claude]`, that
runner has been offline since 2026-07-17, and every scheduled run since has
queued for 24h and been auto-cancelled (watchdog issue #1005; ORPHAN-HIGH-529,
ORPHAN-HIGH-530). The real precondition is an operator action — the runner
returns — after which one green scheduled run closes the gate. A
`workflow_dispatch` run under the flag on a restored runner counts as the same
evidence. Until then the legacy pattern stays, and it stays because the gate
is genuinely unmet, not because anyone forgot it.

Invariant pins: I-W0-01 no-second-entrance (AST); I-W0-02 registry is the only
ordered phase literal; I-W0-03 gate identity (`pr_open`, never the authority
set); I-W0-04 ≥2 `record_failure` production callsites; I-W0-05 kwargs gone +
bridge drainer resolves a real function; permanent golden-parity fixture.

**Completion evidence:** single live pipeline, explicit preconditions, nightly
green throughout, perimeter-less PR production structurally impossible.

### Wave 1 — Durable event store: `aria/state` branch + memory continuity (Revision 2: promoted ahead of missions; + early external watchdog)

**Early external watchdog (moved here from Wave 11):** a small,
kernel-independent `aria-external-watchdog.yml` — state-branch freshness
(latest snapshot age), nightly heartbeat (last successful cycle), publish
contention accumulation; anomalies trip the breaker into MERGE_FROZEN and
notify the operator. Plain script + `gh api`, no kernel imports — the
transition period's insurance policy.

Orphan branch layout: `GENESIS` (bootstrap-once marker), signed
`snapshot.json`/`snapshot.sig` (`aria/state-snapshot/v1`: per-surface sha256 +
tail ledger hash + row count, `manifest_root`, prev-snapshot chain, per-cycle
ed25519 signer already minted by `gh_token_factory`), `keys/<cycle>.pub`,
`tools/` (144 surfaces verbatim), `workspace/<repo_hash>/` (the 10
workspace surfaces — per-run death ends), `findings/aria-findings/` (F-001
resets end). Bulky artifact-class surfaces stay in the cache artifact,
sha-pinned in the snapshot.

**§2.2b REVISED — `.seg-NNN` segment rollover is superseded and will NOT be
built.** The original text specified splitting a ledger into `.seg-NNN` files
at 8 MB, chained by `prev_segment_tail_hash` rows. A blast-radius map over the
readers found 42 blocking couplings across roughly 100 call sites, one of them
a fail-OPEN governance hazard: `surface_for_path` returns `None` for a path
that is not a declared surface, and `_assert_raw_jsonl_append_allowed` treats
`None` as "not a governed surface" — so a segment file would have bypassed the
append guard entirely rather than being refused by it. Path-keyed lock identity,
`_verify_jsonl_from_text`'s `None` chain seed, and the one-name-one-path index
membership rule each break in their own way, and about 25 workspace readers
resolve a surface to exactly one file.

The measurement that settles it: the largest ledger on disk today is **313 KB**
against the 8 MB trigger — a factor of 26 away, with no growth curve that
reaches it inside this program. Building a 42-blocker change for a threshold
nothing approaches, and taking a fail-open governance hole to do it, is not a
trade worth making.

**Replacement design (same problem, one-live-file invariant preserved):** a
MEASURED trigger plus surface-level ARCHIVAL. `state_store` records each
surface's byte size in the snapshot it already builds; when a surface crosses a
measured threshold, its old rows are sealed into an archive file classified
`artifact` — a class the snapshot ALREADY pins by sha256 and already keeps out
of the branch (`STORAGE_POLICY`). The live surface keeps its declared path, its
lock identity, its index membership and its single-file readers; the archive is
detectable-if-lost without inflating the store. No reader changes, no new
governance surface, and the continuity root covers the archive on day one
because artifact-class pinning is already how it treats run outputs.
Implemented when a measured surface actually approaches the threshold — the
trigger is the measurement, not the calendar.

The measurement half lands with PR 2.3: every snapshot surface entry now
carries `size_bytes`, because the snapshot walk already visits each file and
the number was otherwise unrecorded anywhere in ARIA. Until that existed, "is
any surface approaching a size that matters" had no answer short of someone
going and looking — which is how a threshold gets crossed unnoticed. The
consuming trigger is tracked separately and is NOT part of 2.3.

New `state_store.py` (`checkout_state_store` as a worktree, `build_snapshot`,
`publish_state` — plain `git push` is the FF-only CAS; loser replays append-only
suffixes on the winner's tip; `autonomous_host_lease` reused as advisory publish
lease; push via `mint_installation_token` scoped contents:write with a GitHub
ruleset on `aria/state` blocking force-push/deletion) and `memory_gap.py`
(`assess_memory_continuity` → `state_integrity_gap` breaker kind freezing every
authority profile → `restore_and_replay` → `equivalence_check` → resume).
Branch-absent requires `ARIA_STATE_BOOTSTRAP_ACK`.

**Corrected in PR 2.5, from reading the code this paragraph describes:**

- _"The silent-bootstrap path in both workflows is deleted"_ named the wrong
  line. `integrity migrate-tools-bootstrap` is not a bootstrap-only step — it
  is an idempotent CONTRACT MIGRATION that carries a restored tree from
  v0/v1/v2 to v3. Deleting it, or gating it on `bootstrap == 'true'`, would
  leave an older restored tree unmigrated. It stays.
- The silence was never in that step. The shared restore action (then
  `restore-aria-tools-state`, since PR 2.6b `restore-aria-state`)
  already fails hard on a real error and writes `restored=true` only on the
  success path, so the transport proof is sound; what was missing is that both
  lanes evaluate that proof at the END of the job, having already acted. The
  kernel-side `state_continuity` gate is the missing consumer, and it asks the
  other question — not _did the download work_ but _is this the state we left_.
  No workflow edit ships with it: a second early check duplicating what the
  action enforces is the copy-drift this wave keeps treating.
- A third verdict, `unknown`, is added to the two the paragraph implies.
  Continuity is only decidable against a reference OUTSIDE the tree, and until
  the state-branch lane cuts over (2.6) or the daily anchor lane resumes with
  `state_manifest_root`, no such reference exists on `main`. `unknown` blocks
  nothing and asserts nothing; `freeze_autonomous_writes` raises on any status
  but `critical`, so an unproven gap structurally cannot trip a breaker.
- `restore_and_replay` moves to 2.6 with the lane that gives it a transport.
  `equivalence_check` ships in 2.5 because 2.6 needs it and it is testable
  standalone.

**Corrected in PR 2.6, the same way:**

- _"`autonomous_host_lease` reused as advisory publish lease"_ is not built,
  and that is a decision. The lease's purpose was to stop the two lanes racing
  habitually — but with deterministic replay the race is CORRECT AND CHEAP: one
  extra fetch, reset, replay and push, measured in seconds. An advisory lease
  adds a second answer to _who may publish_, and its own failure mode — a
  crashed lane's stale lease blocking a healthy lane — is strictly worse than
  the problem it removes. The FF-only push is the answer;
  `publish_with_contention_replay` is the retry.
- A store-checked-out tools root cannot be used until it is bound.
  `repo_identity.json` records an absolute `bound_repo_root`, so it is
  machine-local binding state, deliberately not a declared surface, and the
  published branch does not carry it. A fresh checkout is therefore exactly the
  shape `ensure_tools_dir` refuses (`ambiguous_tools_root`), and the governed
  binding step is `integrity migrate-tools-bootstrap` — the second and stronger
  reason the step §2.5's correction already kept must stay.
- Replay is not idempotent by construction, and a failing test found that:
  after a successful replay the winner holds the loser's rows but the loser's
  file is unchanged, so a retry between replay and re-publish would append
  every row twice. The guard is a TAIL match on logical content (chain fields
  excluded) — set membership would silently drop legitimately identical rows
  from two lanes.

Verifier fix (ORPHAN-HIGH-433): `covered_tool_ledgers` becomes a derivation
over `state_manifest` (every tools-root ledger surface), one release soak
`covered` → `manifest_full` (160/160).

Memory hygiene in the same wave: `_record_belief` stops incrementing
`support_count` when `evidence_hashes` is unchanged (repetition ≠ support);
`MemoryHookImpl` conventions gain `outcome_status: hypothesis` at reduced
confidence (VERIFIED-promotion arrives in W10).

**Completion evidence:** artifact-deletion drill → verified restore/replay,
`integrity verify` 160/160; §43 scenarios 3, 19, 20, 38 executable.

### Wave 2 — Persistent Mission + no-half-plan (Revision 2: runs after durable state)

New `mission.py` (event-sourced on the proven `plan_convergence`
`_mutate`/fold/idempotency pattern), `mission_scheduler.py`,
`mission_reconcile.py`. `mission_id = m-sha256(source_kind|source_id|repo_hash)[:16]`
— never cycle-derived (I-W1-05). Event rows `aria/mission/v1` carry
from/to_state, reason_code, retry_rung, idempotency key
`(mission_id|step_id|target_sha|action_type)`, bindings (plan_ids, change_ids,
assignment_ids, pr_numbers, branch, finding_ids, queue/task ids), next_action,
wake_condition. Surfaces `mission_events` + `mission_index` declared in
`state_manifest`.

State machine per design §7.2 with INTERIM (releases the WIP slot) and TERMINAL
sets, a closed `ALLOWED_TRANSITIONS` table, the 7-rung retry ladder, and
skip-forward edges (`reason_code="coarse_observation"`) where today's pipeline
cannot observe finer states. `assert_cycle_closure` runs inside `cycle_seal`:
every open mission must carry next_action + wake_condition — "no plan silently
half-done" as an executable gate (fail_cycle under strict/autonomous).

WIP=1 per capability enforced at the mutation chokepoint
(`promotion_controller.promote_converged_plan_to_dispatch` —
closes ORPHAN-HIGH-487) and at scheduler selection; starvation aging in
`score_mission`. `mission_reconcile` (preflight) reconciles GitHub reality with
the ledger through a closed divergence table (external merge fast-forward,
closed-unmerged → ladder advance, lost branch → PLANNING, `ARIA-Mission:` PR
trailer adoption, adapter error → **no transition** + breaker count).
`mission_ingest` gives `task.generate_task_candidates` its first production
caller and adopts pending `next_cycle_queue` items; PR 1.6 atomically swaps
request-minting authority to the scheduler; PR 1.7 retires the queue producer
(reflection opens missions directly).

**Completion evidence:** crash-injection suite — kill at every transition,
mission resumes; design-§43 scenarios 1, 2, 4, 21, 22 executable.

### Wave 3 — Repository Digital Twin (Revision 2: **Twin-lite** scope; deep symbol graph deferred to Wave 10)

New `aria_kernel/twin/` subpackage (new capability, consumers ported onto it).
**Twin-lite is four deterministic layers — no symbol-level CALLS edges:**
(1) file/project dependencies (nx graph ported from `impact_graph` + a
file-level import map); (2) test↔source mapping (TESTED_BY); (3) contract
surfaces (GraphQL schemas, `libs/event-contracts`, TypeORM entities,
migrations); (4) history (git-log churn + co-change). File-level impact
closure over-approximates by design — over-approximation is safe for
validation (it demands more tests, never fewer). Modules: `bootstrap.py`;
`incremental.py` (diff-driven re-parse, temporal edge
closure, reverse-dependency frontier); `store.py` on the W1 state branch;
`overlay.py` (mission-branch delta); `equivalence.py` (incremental ==
clean-rebuild; divergence freezes the merge lane + opens a repair mission).
Every node/edge: stable identity, valid_from/to SHA, source tool+version,
deterministic|inferred class, evidence ref. Consumers ported: `plan_coverage`
impact closure, `validation_matrix_gate` affected-file resolution, pressure
churn/co-change.

**Completion evidence:** post-bootstrap cycles parse only changed files; a user
commit is in the twin next cycle; incremental==rebuild on fixture commits
(§43 scenarios 5, 9, 33).

### Wave 4 — Acceptance Contract + evidence closure + anti-gaming

New `acceptance_contract.py` (`aria/acceptance-contract/v1`, frozen at
CONTRACTING: goal/scope/out-of-scope, preserved behaviors, negative conditions,
allowed file/symbol scope, clause→evidence-type map, bound_base_sha,
contract_hash; implementer-readonly, amendment is a separate gated state).
`validation_matrix_gate` grows risk templates (`ui_change`,
`dependency_change`, `migration_destructive` join the existing four) bound to
contract clauses; the design's IMPLEMENTATION_SUFFICIENT predicate becomes a
required component of `verify_enterprise_readiness`. `EvidenceEnvelope` gains
mission_id, clause_id, environment_digest (image digest + lockfile hash + tool
versions — the §30 reproducibility core). `aria-completeness-critic` is
extended into the Closure Auditor (reuse-first, no new agent).
Anti-gaming: `suppression_scanner` joins GATE_PRE_PR_OPEN; assertion-deletion /
coverage-threshold-drop diff detectors; any non-human lane touching tests,
gates, invariants, or workflows routes through an `evaluator_integrity` review.

**Completion evidence:** a green-CI mission with an uncovered clause cannot
reach READY (§43 scenarios 11, 12, 25).

### Wave 5 — Refactoring intelligence

`pressure.py` gains `maintainability_hotspot` (twin churn×coupling×co-change),
`duplication_cluster`, `architecture_boundary_violation` (wiring the currently
dead spine gates into the live lane), `doc_drift` — weights per design §12
(raw length weight 3/100; an invariant pins that length alone never produces a
candidate). New `refactor_readiness.py`: Need vs Readiness scores → decision
matrix → `characterization_first` child missions. Detector calibrated by
historical replay over past refactor commits; candidates stay SHADOW until the
goldset precision bar (genesis_policy SLOs) is met.

**Completion evidence:** length-only never triggers; detector precision on the
replay corpus reaches the configured bar before the implementation lane opens.

### Wave 6 — Agent + Tool Factory maturation

Unify the two lifecycles (genesis gains QUARANTINED; shared state vocabulary in
one `lifecycle_common.py` SSoT; separate ledgers remain). Reuse-first
capability search (`agent_priors` scope-glob overlap) becomes a mandatory step
before genesis (§43 scenario 31). Real eval mode unlocked (closes
DEBT-2026-05-08-001) with the existing provenance binding.
`IMMUTABLE_AGENT_FILE_HASH_REGISTRY` populated (18 aria-\* files hash-pinned;
changes route through evaluator_integrity). Eval Lab: whole-cycle historical
replay harness seeded from `run_cycle_acceptance`; prompt-injection +
permission-escalation fixture corpora (§43 scenarios 13, 14, 15). Mission
outcomes feed per-agent performance stats (`agent_satisfaction`/`agent_priors`)
consumed by routing. CAPABILITY_REQUIRED: parent mission → capability gap →
genesis child mission → parent auto-resume.

**Completion evidence:** parent auto-resumes after child capability activates;
no duplicate agent for an existing capability.

### Wave 7 — Guardian teams

The live `specialist_review` phase grows risk-based guardian dispatch:
Test Intelligence (twin TESTED_BY + validation-run history → evidence-based
flaky classification, bounded reruns — §43 scenario 16; the fail→fix→pass
proof pair for bug fixes enters the validation matrix); Contract Guardian
(deterministic GraphQL/OpenAPI/event-contract/generated-type drift adapters —
§27 closures over twin edges); Data Guardian (schema-drift validator +
expand-contract discipline; destructive step never in the first PR — §43
scenario 34); Security Guardian (secret scan + suppression scanner +
lockfile-change evidence); Reproducible Environment (environment_digest
mismatch on same SHA+env → nondeterminism finding). UX Guardian starts with
Playwright smoke + screenshot evidence for `ui_change`; full visual regression
is a tracked R2+ debt with owner and deadline.

**Completion evidence:** synthetic violations per guardian are blocked
(§43 scenarios 27, 28).

### Wave 8 — Machine Merge Authority: signed permits

Implement the seven `_not_implemented` GATE_PRE_MERGE checks
(`branch_tip_lock_and_recheck` absorbs the live re-eval logic;
`per_file_mutual_exclusion` reads W1 WIP data; `operator_feedback_signature`
is redefined as `policy_approval_signature` — constitution policy, not
per-task humans; `cycle_and_turn_budget_cap` on wall clock;
`content_hash_recheck`; `expert_consensus_evidence_verified` wires
`expert_review_gate`; `plan_coverage_witness_verified` wires
`plan_convergence`). New `merge_permit.py` (`aria/merge-permit/v1`): signed by
an operator-provisioned Merge-Authority ed25519 key (private in repo secret,
public committed + invariant-pinned), single-use nonce ledger on the state
branch, expiry, bound to mission/PR/head/base SHA/contract hash/evidence merkle
root/quorum/risk class; `merge_pr_if_ready` refuses without a valid unused
permit; revocation events per design §21.3. R0-R3 map onto risk_policy L1-L3;
R3 is closed to autonomous merge. `aria-merge-authority.yml` verifies permits
on ARIA PRs.

**Completion evidence:** stale evidence / changed head / missing gate / reused
or expired permit all refuse (§43 scenarios 10, 26); 17/17 hard-fail checks
real.

### Wave 9 — Runtime intelligence + post-merge outcome + delivery

`runtime_connectors.py`: main-CI failure poller (the first producer for the
breaker's `ci_red` kind), deploy-workflow result reader, and the operator CLI
`runtime-signal ingest` — all feeding the existing `ingest_runtime_signal`
(trust split preserved). Post-merge chain per design §22: MERGING →
MAIN_VERIFYING → OUTCOME_OBSERVING → VERIFIED; `finalize_merge_incident`
records the merge event but no longer closes anything; risk-class observation
windows (R0: 1 nightly, R1: 2, R2: 7 days); regression inside the window →
causal correlation → automatic revert PR through the same gates on an
expedited lane → FAILED_AND_ROLLED_BACK + root-cause mission. Delivery
adapted to the droplet reality: deploy-verify (deployed SHA == merge SHA),
staged windows, config-service feature-flag hook for R2; traffic-percentage
canary is a tracked debt until the infra exists.

**Completion evidence:** injected post-merge regression auto-stopped and
reverted; VERIFIED unreachable at merge time (§43 scenarios 17, 30, 35).

### Wave 10 — Outcome learning + self-upgrade (Revision 2: + Deep Twin, conditional)

**Deep Twin (conditional):** symbol-level extractors (a ts-morph-based
`tools/twin/extract-ts.mjs` Node script the kernel only consumes; Python
`ast`; Rust `cargo metadata`) are added ONLY if a consumer demonstrates, with
measurement, that file-level coupling signals are insufficient (e.g. the
refactoring detector's precision stalls below its bar). Otherwise the program
closes without Deep Twin — a decision, not a gap.

Two-stage conventions: `hypothesis` at CONVERGED, promoted at VERIFIED, demoted
(+ anti-pattern candidate) on FAILED_AND_ROLLED_BACK. `failed_strategies`
ledger feeds planner context (negative knowledge). Self-upgrade per design §23
on the existing PR-only `self_modification` base: kernel version manifest,
candidate kernels proven by Eval-Lab whole-cycle replay A/B + shadow cycles +
low-risk canary missions, independent promotion gate, previous ref retained
for automatic rollback. Constitution/watchdog/permit-verifier files remain
human-approved forever.

**Completion evidence:** failed methods cannot become high-confidence patterns;
broken candidate auto-rolls back to stable (§43 scenarios 23, 24).

### Wave 11 — Full autonomy: Constitution + Product Governor + activation

`docs/aria/CONSTITUTION.md` (goals, prohibitions, authority limits, evidence
precedence, risk classes, the R3 physical-control prohibition, self-upgrade
rules) hash-pinned, added to READONLY_PATHS, read by `constitution.py`; the
design's 20 immutable rules each map to an invariant test (table in the
appendix of that doc). `product_governor.py` + operator-signed
`docs/aria/objectives.yaml`; every mission carries `objective_refs`; portfolio
capacity (40/20/15/10/10/5) enforced by the scheduler; `NO_ACTION_REQUIRED`
terminal. Activation is staged automatic promotion: each §44.1 rung binds to
the existing ladder; when the executable acceptance suite + unlock thresholds
pass, `AUTO_PROMOTE_DEFAULTS.enabled`, `AUTONOMOUS_AUTO_ACK_LANES` (lane by
lane), and the rebuilt autonomous-cycle workflow mode open in order. Human
signature remains only for: Constitution changes, R3, safety-core files,
ladder policy. The external watchdog's base
workflow landed in Wave 1 (Revision 2); here it grows merge-velocity anomaly
detection, permission-escalation traces, and the deadman rule (if the watchdog
itself has not run for N days, the daily report carries a warning block).
**Cadence knob (Revision 2):** the ladder thresholds in
`docs/aria/policy/autonomy-unlock.json` are operator-signed policy. With the
class-A acceptance suite green, compressing the calendar is legitimate two
ways — raising cycle frequency (N cycles/day via cron) and/or consciously
lowering thresholds. The default remains 30/30/30 at nightly pace; the choice
is the operator's, made explicit here instead of inherited silently.

**Completion evidence:** a selected mission set completes
discovery→outcome-verified with zero human interaction in a controlled
low-risk window; the full §43 suite green in CI; watchdog kill-switch drill
passes.

## 6. Supersession map (2026-07-26 program → this program)

| 2026-07-26 stage          | Status there              | Lands here                           |
| ------------------------- | ------------------------- | ------------------------------------ |
| S0 Containment            | blocked (sandbox reality) | Wave R item 4 + Wave 0 executor lane |
| S1 Draft-PR capable       | not started               | Waves 0 + 1                          |
| S2 Supervised merge       | not started               | Wave 8                               |
| S3 Autonomous merge       | not started               | Wave 11 activation                   |
| S4 Deploy/canary/rollback | not started               | Wave 9                               |
| S5 Institutional memory   | not started               | Wave 2                               |

Registered findings from that program (ORPHAN-417..499 etc.) stay authoritative;
open ones become mission sources in Wave 1's backlog ingest.

## 7. One-time operator prerequisites (the only human setup)

1. GitHub ruleset on `aria/state`: block force-push + deletion (FF-only server-side).
2. `ARIA_MERGE_AUTHORITY_KEY` secret + committed public key (Wave 8).
3. `ARIA_OPERATOR_TOKEN` (state-branch push + PR management until App credentials).
4. Self-hosted runner bubblewrap capability probe (RC-9).
5. First signature on CONSTITUTION.md + objectives.yaml (Wave 11).

## 8. Program-level verification

Per PR: `npm run aria:ci:all`; `npm run type-check` when TS is touched;
`npm run findings:verify` when the registry is touched; `nx affected` when
platform code is touched. Per wave: the named §43 scenarios land as executable
tests under `tools/aria-acceptance/` or `aria-kernel/tests/invariants/v12+/`
and run in CI. Program metrics tracked in `PROGRESS.md` (mission loss 0,
wrong-SHA validation 0, unauthorized merge 0, incremental==rebuild, change
failure rate, cost per verified mission).
