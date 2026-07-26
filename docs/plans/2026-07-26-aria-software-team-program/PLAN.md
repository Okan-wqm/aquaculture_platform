# ARIA — Industrial-Grade Program Plan: from control plane to software team

| | |
|---|---|
| **Plan date** | 2026-07-26 |
| **Owner** | okan |
| **Audit baseline** | commit `bdaf00bf633151927740304985551a012e5e2e5c` |
| **Findings source** | `docs/reviews/2026-07-26-aria-codex-audit-verification.md` |
| **Registry** | `docs/reviews/_registry/findings.jsonl` (`ORPHAN-*-333..349`) |
| **Branch** | `claude/aria-security-audit-findings-8l9it5` |
| **Status** | S0 in progress |

> This file is the plan of record. It is updated as stages land — see
> [Stage status](#stage-status) and [Progress log](#progress-log) at the end. Every stage-status
> change is committed with the work that caused it, so the plan and the repo never disagree.

---

## Context

The goal is for ARIA to work like a software team: take a task, write the code, open a PR, watch
CI, pass independent review, merge, ship, and remember why. An external audit called it a control
plane rather than a team. That was verified at commit `bdaf00b`: all 15 of its P0 findings confirmed,
and a second adversarial hunt added 8 more. Seventeen are registered (`ORPHAN-*-333..349`).

Measured against the ten things a team does, ARIA does **two** — it plans, and (as of the
2026-07-26 session) it reviews for real. It cannot write code (`NoOpV9ImplementationRunner` is the
production default), its queue cannot reach its executor (`aria-tools/agent-invocations/` is
gitignored out of the consumer's filesystem), and it has no task intake (`task.py` has zero
importers).

**The decisive discovery for this plan:** the repo already contains an industrial maturity model —
`autonomy_unlock.py` gates promotion through `L1 → L2 → L3` counting `observe_success`,
`l1_autonomous_success`, `l2_supervised_success`, `l2_autonomous_success`, `l3_approval_success`,
`rollback_success`, with `critical_violation` as a hard blocker. It is the right spine and this plan
builds on it rather than inventing a parallel one. But:

* only `observe_success` has a producer (`autonomy_ladder.record_clean_cycle`). The other five event
  types appear **only** in the enum and the counters — nothing emits them, so the ladder cannot
  advance past its first rung;
* `record_clean_cycle` takes `pr_number` and `head_sha` as **optional**, so a rung can be earned with
  no delivery — the ladder measures process, not outcome;
* its evidence ledger `enterprise/acceptance-events.jsonl` is **not** covered by the publication
  integrity gate (`ORPHAN-HIGH-348`), so the record that authorises promotion can be corrupted
  without detection.

Intended outcome: each rung becomes emittable **only** by a delivered WorkItem carrying
`pr_number` + `head_sha` + green CI + independent review evidence, the evidence ledger is protected,
and merge and deploy authority are unlocked by the ladder rather than by a flag anyone can flip.

Operator decisions taken: the finish line **includes deploy + canary**; a ladder rung counts only on
a **delivered WorkItem**.

### Corrections from the adversarial review of this plan

The plan was attacked by an independent agent panel before approval (writers and their auditors).
Six challenges; **three confirmed, three refuted.** All three confirmed ones changed the plan, and
one of them found a defect in the plan's own acceptance assertion:

1. **The originally-chosen golden E2E task was impossible for ARIA to perform.** `.gitignore` is in
   `READONLY_PATHS` (`aria-kernel/aria_kernel/implementation_safety.py:69`, "operator-only"), so the
   live `_check_forbidden_scope_normalized` returns `readonly_path_write:.gitignore` at
   `GATE_PRE_PR_OPEN` and the sandbox ro-binds it; and `classify_change(['.gitignore'])` → lane
   **`blocked`**, reason `risk_unknown_path`, so it could never traverse S2 either. The mechanical
   check was also **inverted**: `git check-ignore -v` reports negation matches and exits **0**; only
   the plain form exits 1. Both fixed below.
2. **Item 334 rewrites a pinned contract, and the lane has no push credential.** Confirmed by
   reading both sides. Also confirmed: minted installation tokens land in a **tracked, non-ignored**
   path, which moves that work from S3 into S1.
3. **The first rung is self-blocking.** `merge_authority.py:70` asserts the ladder unconditionally
   before any merge, and a real code change is lane **L2**, whose requirement is
   `l2_supervised_successes: 30` — the exact event that merge would have produced.

Refuted, and therefore not in the plan: that S1 is blocked on the S3 token-scope item; that the
credential fix is an operator ceremony; and two lesser sequencing objections.

---

## Capability model — what "software team" means, measurably

| # | Team function | Now | Earned at |
|---|---|---|---|
| 1 | Task intake | ✗ `task.py` orphaned | S1 |
| 2 | Plan | ✓ real | done |
| 3 | Write code | ✗ NoOp implementer | S1 |
| 4 | Local test | ✗ not on delivery path | S1 |
| 5 | Open PR | ✗ unreachable from scheduled lane | S1 |
| 6 | Watch CI | ✗ queue never reaches executor | S1 |
| 7 | Independent review | ✓ real (336/337/338) | done |
| 8 | Merge with authority | ~ head-bound gate sound; perimeter 5/17 | S2 |
| 9 | Not harm itself | ~ containment done (342); perimeter partial | S0/S2 |
| 10 | Remember why | ✗ repetition counted as confidence | S5 |

---

## Stage gates

Every stage has machine-checkable exit evidence, a kill switch, and a stated residual risk. No stage
exits on opinion. `critical_violation` in the acceptance ledger blocks every stage.

### S0 — Containment

Nothing may write code before the box exists.

* **Done:** `ORPHAN-CRITICAL-342` — `wrap_bash_in_sandbox` raises instead of returning bare argv;
  `claude_runtime._apply_write_containment` wraps every write-capable spawn and refuses when no
  backend exists. Where a backend exists, READONLY_PATHS are ro-bind and kernel self-modification
  EROFSes. Current state stated honestly: neither `bwrap` nor `firejail` is installed in the CI
  container, so today containment manifests as **spawn refused**, not EROFS. That is the correct
  fail-closed behaviour, and it is also why installing a backend is an S1 runner prerequisite — a
  refused spawn cannot write code either.
* **Done:** gate split `GATE_PRE_PR_OPEN` / `GATE_PRE_MERGE`, with `HardFailCheck.gate` defaulting
  to `pre_merge` so an unclassified check lands in the unsatisfiable gate.
* **Remaining:** `ORPHAN-CRITICAL-343` phase A — 5 mechanical pre-PR-open checks
  (`no_force_push` refspec pattern, `no_no_verify` flag denial,
  `kernel_self_modification_blocked_at_envelope_mint` set intersection,
  `test_gate_canonical_suite` list containment, `pr_body_templating` render).
* **Remaining:** make the suite signal trustworthy — see Verification.
* **Exit evidence:** `run_hard_fail_checks(ctx, gate=GATE_PRE_PR_OPEN).passed` is True for a clean
  action and False for each of: kernel-path write, secret in diff, forbidden gh-api path, disallowed
  bash command, path escape. `sandbox_backend()` non-None on the runner.
* **Kill switch:** `ARIA_ALLOW_UNCONFINED_WRITE` unset ⇒ no write-capable spawn.
* **Residual:** egress from the agent's own bash commands is not contained; only the filesystem is.

### S1 — Draft-PR capable (earns `l1_autonomous_success`)

The stage that makes ARIA a team at all: functions 1, 3, 4, 5, 6.

* `ORPHAN-CRITICAL-334` — collapse producer and executor into one job graph in
  `.github/workflows/aria-auto-cycle.yml` so the queue never crosses a filesystem boundary.
  Artifacts become evidence only, never queue authority. Three things travel with it, all confirmed
  by reading both sides:
  * **the workflow contract must change in the same commit.**
    `workflow_contract_registry.py:183-196` pins the `cycle` job to
    `required_permissions=(("contents","read"),("actions","read"))`,
    `token_source="github_actions_artifact_token"`, and write roots `aria-tools/` + `aria-findings/`.
    A job that opens a PR needs `contents: write` + `pull-requests: write` and a different token
    source. Amending the registry is not paperwork — it is the thing that makes the widened authority
    reviewable, and `workflow_contracts._verify_upload_artifact_step` already enforces it.
  * **the lane has no push credential.** The workflow sets `persist-credentials: false` and
    `GH_TOKEN` on exactly one step, under `permissions: contents: read`. So `pr_manager`'s
    `git push` / `gh pr create` have nothing to authenticate with, and `mint_installation_token`
    Mode B raises. Fix the credential path as part of 334, not after it.
  * **minted secrets currently land in a stageable path.** `gh_token_factory._keys_dir` writes
    `<workspace>/aria-debts/keys/<cycle>.token`; `aria-debts/` is tracked and
    `git check-ignore aria-debts/keys/abc.token` exits 1 — not ignored. The moment ARIA can run
    `git add`, a token is one glob away from a public diff. This is why it moves out of S3 and into
    S1. (`aria-debts/` is also in `READONLY_PATHS`, so minting must stay outside the sandboxed
    agent — the write path and the trust boundary already disagree.)
* `P0-03` — replace `NoOpV9ImplementationRunner` (`cycle_phases/implementer.py`) with the real
  runner on the scheduled path; give `task.py` an authenticated entry point.
* Local validation on the delivery path, with command + artifact digests recorded.
* PR opening via `pr_manager.open_pr_for_action`, **draft only**, guarded by
  `gate=GATE_PRE_PR_OPEN`. `ORPHAN-HIGH-348` — bring `enterprise/acceptance-events.jsonl` and the
  other uncovered surfaces under the publication integrity gate before any rung is recorded.
* **Entry prerequisite, operator:** one commit adding the `!aria-tools/reports/daily/` negation to
  `.gitignore`. This was `ORPHAN-HIGH-349`, originally picked as the golden task; ARIA structurally
  cannot do it (see corrections above), so it becomes a one-line operator commit that precedes S1
  rather than the work that proves S1.
* The **golden E2E task** is therefore a new WorkItem chosen to be executable: paths in `docs/**`
  (excluding `docs/adr/`) or root `tests/**` — verified L1 in `risk_policy.classify_change` and
  outside every `READONLY_PATHS` prefix. Beware the trap: `aria-kernel/tests/**` classifies L1 but is
  read-only, so "it's only tests" is not a safe selector. The file set is named explicitly in the
  WorkItem, not inferred at runtime.
* **Ladder bootstrap:** L1's only requirement is `observe_successes: 30`
  (`docs/aria/policy/autonomy-unlock.json`), and that is the one event with a producer — so an
  L1-lane golden task is also the only first rung the ladder can actually grant. This is why the
  golden task must be L1, not merely small.
* **Exit evidence:** one `l1_autonomous_success` row carrying `pr_number` + `head_sha`, whose PR is
  a draft, whose CI is green, and whose `accepted_result_ref` names a real adversarial review.
* **Kill switch:** merge stays closed automatically — `GATE_PRE_MERGE` has 7 unimplemented checks and
  cannot pass. No flag to forget.
* **Residual:** review quality is bounded by `ORPHAN-HIGH-346` (banned-phrase check reads keys the
  production envelope lacks); fix it in this stage or plans degrade quietly.

### S2 — Supervised merge (earns `l2_supervised_success`)

**Entry blocker to resolve first — the rung is currently self-blocking.** `merge_authority.py:70`
calls `assert_autonomy_unlocked(lane=lane)` unconditionally, before any evaluation, with the lane
taken from `record_risk_decision_for_pr`. A real code change classifies **L2**
(`classify_change(['apps/farm-service/src/x.ts'])` → `L2`, `runtime_behavior_supervised`), and L2
requires `l2_supervised_successes: 30` — which only a supervised merge can produce. So the first
supervised merge raises `GovernanceError: autonomy_unlock_required_for_merge` and the rung can never
be earned. The fix must not be "lower the threshold" or "skip the assert": the gate is right, the
bootstrap is missing. The change is to make the **supervised** path assert what supervision actually
requires — a human-approved merge with a fresh head SHA and both hard-fail gates passed — and record
`l2_supervised_success` from it, so the autonomous rungs keep asserting the full ladder. The
threshold policy in `docs/aria/policy/autonomy-unlock.json` stays untouched; the defect is
production, not policy, exactly as with the five missing emitters.

* `ORPHAN-CRITICAL-343` phase B — the 7 pre-merge checks. Three pull in other findings:
  `cycle_and_turn_budget_cap` needs `ORPHAN-CRITICAL-335` (budget/breaker have zero callers),
  `operator_feedback_signature` needs `P0-12` (signature verification is a non-empty-string check),
  `expert_consensus_evidence_verified` needs `expert_review_gate.py` wired (zero production callers).
  `branch_tip_lock_and_recheck` largely exists — `merge_authority.py:178` already blocks on
  `latest_head_sha != head_sha`; bind the existing implementation rather than rewrite it.
* Thread `HardFailReport` into `pr_manager.open_pr_for_action` and `auto_merge.merge_if_green`.
* `P0-13` — rename the contract-test workflow; promote `merge_authority.merge_pr_if_ready` (already
  head-SHA-bound, already consuming `verify_rollback_bundle` and the incident ledger) into the
  required check. **Blocked on the operator's live branch-ruleset change** — the context rename must
  land in the same window or every PR wedges.
* `P0-11` — merge candidates come from the current WorkItem's exact PR, not the global readiness
  ledger.
* `ORPHAN-HIGH-344` — Gate B oscillation guard gets a caller and a paired reset before any
  fix/reopen loop can run unattended.
* **Exit evidence:** `l2_supervised_success` for a merge where the report passed both gates, the head
  SHA was re-verified pre-merge, and a human approved the merge itself.
* **Kill switch:** runtime profile ≠ `autonomous`; ladder L2 not unlocked.
* **Residual:** `is_gh_api_path_forbidden` is a denylist and has never been bypass-tested.

### S3 — Autonomous merge (earns `l2_autonomous_success`, `l3_approval_success`)

Only reachable once S2's evidence exists and `critical_violations == 0`.

* `ORPHAN-HIGH-345` — the watchdog must actually observe: replace the self-advancing cursor with a
  persisted cumulative per-plan event index. Granting write authority while the only stall detector
  is dead removes the ability to notice the rest went wrong.
* `P0-05`/`P0-06` — profile epoch + capability revocation on downgrade; real CAS + fencing so two
  hosts cannot both own a WorkItem.
* `P0-04`/`ORPHAN-HIGH-340` — role-scoped credentials: the `repositories` key the token request
  omits, expiry read from the API response, tokens out of the repo working tree.
* **Exit evidence:** ladder verdict `valid=True` for L3 with the policy thresholds met, plus a
  `rollback_success` row (below).
* **Kill switch:** `ARIA_STOP`, profile downgrade (which must now actually revoke), breaker tripped.
* **Residual:** prompt injection through repo content into agent prompts is unexamined.

### S4 — Deploy, canary, and proven rollback (earns `rollback_success`)

* Deployment provenance: PR `head_sha` → image digest → `deployment_id`, correlated to the WorkItem.
  Existing surfaces to build on: `deploy-digitalocean.yml`, `deploy-staging.yml`,
  `production-post-deploy-verify.yml`, `pitr-restore-production.yml`.
* Canary + soak with metric thresholds. No canary workflow exists today; this is new.
* A real rollback **executor**. `verify_rollback_bundle` is already consumed by
  `merge_authority.py:96`, and `enterprise/rollback-bundles.jsonl` is a declared surface — so the
  bundle contract exists and what is missing is the actor that restores the previous digest.
* Incident loop: detect → diagnose → repair → verify → close, writing to `incident_ledger` (today
  read by `merge_authority` and written almost nowhere).
* **Exit evidence:** a deliberately broken canary halts, the previous digest is restored, health
  recovers, and a `rollback_success` row references the incident — i.e. rollback is demonstrated,
  never asserted.
* **Residual:** `ORPHAN-MEDIUM-347` (spine gate drops unmeasurable files) and memory quality (S5).

### S5 — Institutional memory

`memory.py:589` increments `support_count` unconditionally and feeds confidence at `:598`, so
re-reading the same repo turns repetition into certainty. Evidence-hash dedup, contradiction and
supersession, provenance graph. Function 10 of the capability model.

---

## Ladder wiring (the spine change)

The smallest change that makes the whole program measurable. It belongs in S1.

* `autonomy_ladder.py` gains one emitter per rung. Each requires a `DeliveredWorkItem` —
  `work_item_id`, `pr_number`, `head_sha`, CI conclusion, `accepted_result_ref` — and refuses without
  it, so `pr_number`/`head_sha` stop being optional at the rung boundary.
* `autonomy_unlock.verdict_from_rows` is unchanged: it already counts the right event types with the
  right thresholds. The defect is production, not policy.
* `enterprise/acceptance-events.jsonl` moves under the integrity gate (348) **before** the first rung
  is recorded, so promotion evidence cannot be corrupted undetected.

---

## Outcome SLOs (not process)

Recorded because the dashboard reported process health as mission success — 21 blocked cycles read
`ok`, and `warning_count` was pinned to 0. Separate the families, and never let the first stand in
for the second:

* control-plane: cycle completion, integrity verdict, queue age, breaker state
* mission: WorkItems delivered, PR lead time, CI first-pass rate, review rejection rate,
  human-escalation age, deploy success, rollback MTTR
* a stage may not exit on control-plane green alone.

---

## Risk register

| Finding | Must close by |
|---|---|
| `ORPHAN-CRITICAL-342` sandbox | S0 (done) |
| `ORPHAN-CRITICAL-343` perimeter | S0 phase A, S2 phase B |
| `ORPHAN-CRITICAL-334` queue | S1 |
| `ORPHAN-HIGH-348` gate coverage | S1, before first rung |
| `ORPHAN-HIGH-346` compliance blindness | S1 |
| `ORPHAN-HIGH-349` daily anchor | S1 **entry prerequisite, operator commit** (not the golden task) |
| aria-auto-cycle workflow contract + push credential | S1, same commit as 334 |
| minted token in tracked `aria-debts/keys/` | S1 (moved out of S3) |
| self-blocking L2 ladder assertion (`merge_authority.py:70`) | S2 **entry**, before any rung |
| `ORPHAN-CRITICAL-335` budget/breaker | S2 |
| `ORPHAN-HIGH-344` oscillation | S2 |
| `ORPHAN-HIGH-345` watchdog | S3 |
| `ORPHAN-MEDIUM-347` spine gate | S4 |
| `ORPHAN-HIGH-341` panel | done |
| `ORPHAN-HIGH-336/337/338/339`, `333` | done |

---

## Verification

Per stage, and the same shape every time: an assertion that fails before the change, and evidence a
reviewer can re-derive.

* **Standing:** `npm run aria:ci:all`; every fix commit carries `Closes:`; no stage exits with a red
  suite. Baseline 2026-07-26: 2735 tests, OK (34 skipped).
* **S0 prerequisite — make the suite signal trustworthy.** Found while verifying this plan: with
  concurrent agents running git commands, three tests errored with `git commit` exit 128 inside their
  own temp-repo fixtures (`aria-kernel/tests/test_evidence_trust.py:50`,
  `aria-kernel/tests/test_executor_lane.py:34`), and all 33 passed on an isolated re-run. The likely
  cause is a globally-set `commit.gpgsign=true` inherited by temp repos. This matters more than a
  flake: the whole program gates every stage on "suite green", so a suite that reddens for reasons
  unrelated to the change is a signal that can be wrong — the same defect class as
  `warning_count: 0`. Fixture repos must set their own committer identity and disable signing
  explicitly, and this lands in S0 because every later exit criterion depends on the suite meaning
  what it says.
* **Golden E2E (S1 exit).** The task is an L1, non-`READONLY_PATHS` WorkItem with its file set named
  explicitly — ARIA reads the task, writes the change, runs the suite, opens a **draft** PR, and its
  review names a real accepted result. Pass = the `l1_autonomous_success` row's `pr_number` +
  `head_sha` resolve to that draft PR with green CI, and the `accepted_result_ref` resolves to a real
  adversarial review row.
* **Operator entry prerequisite, verified separately (was `ORPHAN-HIGH-349`).** After the `.gitignore`
  negation commit, `git check-ignore aria-tools/reports/daily/<date>.md` must exit **1** — the plain
  form, no `-v`. The earlier assertion said `-v` must exit non-zero and that is wrong: with
  `--verbose` git also reports paths matched by a negation pattern and returns 0, so the `-v` form
  passes both before and after the fix and proves nothing. As of 2026-07-26 both forms exit 0 against
  pattern `.gitignore:13:aria-tools/`.
* **Fault injection (S1 → S3):** producer killed mid-cycle; executor killed mid-claim; lease expiry
  and takeover; state corruption; GitHub API timeout; stale approval replay; head SHA changed after
  review; CI red; kill between merge and ledger append. Pass = no lost work item, no duplicate side
  effect, no stale writer, no unauthorised mutation, no false green, full timeline rebuildable.
* **S4:** deliberately broken canary → halt, restore previous digest, health recovers,
  `rollback_success` written with an incident reference.

---

## What we will not do

* Not chase the remaining P1/P2 findings yet. Most sit on paths that do not execute, so fixing them
  buys nothing until the chain exists and cannot be verified by use. They land in the stage whose
  path runs them.
* Not merge `feat/aria-autonomous-mode`, and not merge archive tags.
* Not open autonomous merge before S2's evidence exists — and not by agent decision. It comes as a
  separate operator decision, because a standing approval used to widen its own authority is the
  defect class this whole programme is closing.
* Not rename the required merge-authority context until the operator changes the live ruleset in the
  same window.

---

## Stage status

Updated with the commit that causes the change. `~` = in progress.

| Stage | Status | Exit evidence present? | Last updated |
|---|---|---|---|
| S0 Containment | `~` in progress | no — 343 phase A + suite-signal fix outstanding | 2026-07-26 |
| S1 Draft-PR capable | not started | no | 2026-07-26 |
| S2 Supervised merge | not started | no | 2026-07-26 |
| S3 Autonomous merge | not started | no | 2026-07-26 |
| S4 Deploy + canary + rollback | not started | no | 2026-07-26 |
| S5 Institutional memory | not started | no | 2026-07-26 |

### Work item ledger

| Item | Stage | Status | Commit |
|---|---|---|---|
| `ORPHAN-CRITICAL-333` breaker fails closed under ledger damage | pre-S0 | done | `8c30bd69b` |
| `ORPHAN-HIGH-339` derived counters + gated publication | pre-S0 | done | `1a80bf5e9` |
| `ORPHAN-HIGH-336/337` review + specialist fail-open | pre-S0 | done | `b5fbcebbf` |
| `ORPHAN-HIGH-338` three independence layers functional | pre-S0 | done | `50956150b` |
| `ORPHAN-HIGH-341` HUMAN_REQUIRED agent panel | pre-S0 | done | `0c1f9a117` |
| `ORPHAN-CRITICAL-342` sandbox bound to spawn path | S0 | done | `873f038f8` |
| `ORPHAN-CRITICAL-343` registry executable, fails closed on unbuilt checks | S0 | partial | `f46324323` |
| Gate split `pre_pr_open` / `pre_merge` | S0 | done | `a4197533a` |
| `ORPHAN-CRITICAL-343` phase A — 5 mechanical pre-PR-open checks | S0 | open | — |
| Suite-signal fix (fixture git identity + signing) | S0 | open | — |
| `ORPHAN-HIGH-349` `.gitignore` negation | S1 entry, operator | open | — |
| `ORPHAN-CRITICAL-334` single job graph + contract + credential + token path | S1 | open | — |
| `P0-03` real implementer + `task.py` entry point | S1 | open | — |
| `ORPHAN-HIGH-348` integrity-gate coverage | S1 | open | — |
| `ORPHAN-HIGH-346` banned-phrase envelope keys | S1 | open | — |
| Ladder emitters + `DeliveredWorkItem` | S1 | open | — |
| Self-blocking L2 assertion (`merge_authority.py:70`) | S2 entry | open | — |
| `ORPHAN-CRITICAL-343` phase B — 7 pre-merge checks | S2 | open | — |
| `P0-13` required-check rename | S2 | open, operator-blocked | — |

## Progress log

### 2026-07-26 — plan of record established

* Verification of the external audit completed: 15/15 P0 confirmed, 8 more severe than reported,
  3 framings corrected in ARIA's favour, 8 new findings registered
  (`docs/reviews/2026-07-26-aria-codex-audit-verification.md`).
* Wave 0 containment and fail-closed work landed: `333`, `336`, `337`, `338`, `339`, `341`, `342`.
* Gate split landed (`a4197533a`): `GATE_PRE_PR_OPEN` carries 10 checks including all 5 implemented
  ones; `GATE_PRE_MERGE` carries 7, none implemented, so merge is closed by construction rather than
  by a flag. `HardFailCheck.gate` defaults to `pre_merge`.
* Plan reviewed adversarially by an independent agent panel before approval: 3 confirmed gaps folded
  in (impossible golden task, workflow-contract + credential + tracked-token path, self-blocking L2
  rung), 3 refuted and excluded.
* Suite baseline recorded: 2735 tests, OK.
