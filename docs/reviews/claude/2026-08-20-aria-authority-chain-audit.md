# ARIA Authority-Chain Audit — 2026-08-20

End-to-end read of the ARIA meta-system (docs, kernel, CI lanes, agents, state stores) run in
coordination with a parallel acceptance session. Every claim below was measured against the
repository or the live `aria/state` branch; nothing is inferred from prose. Findings are
registered as ORPHAN-HIGH-763..766, ORPHAN-MEDIUM-767..771, ORPHAN-LOW-772 in
`docs/reviews/_registry/findings.jsonl`. The fix waves live in the approved correction plan
(rev. 4); each fix commit carries a `Closes:` line for the finding it resolves.

## Method notes

- Live-state evidence via `git show origin/aria/state:tools/*.jsonl`; the local `aria-tools/`
  tree is a stale dev mirror and is never used as the sole basis for a "live" claim.
- The local-mirror digest trap (sha256 over findings/raw-findings/cycles/governance ledgers)
  was armed after 10:49 and is unchanged — it covers only post-10:49 transitions.
- ID allocation reserved the ORPHAN high-water at 762 before adding, because the open PR #1299
  carries unpushed ORPHAN-754..762 work; this avoids manufacturing the exact PROC-HIGH-015
  collision class the audit itself reports an instance of.

## Findings

### ORPHAN-HIGH-763 — readiness claim closed as delivered, never produced

`merge_authority.merge_pr_if_ready` requires a `readiness_claim_id`
(`aria-kernel/aria_kernel/merge_authority.py:39,58`); `auto_merge_runners.py:217` sources it
from `resolve_readiness_claim_id_from_claims` (:347), which reads
`enterprise/readiness-claims.jsonl` and demands exactly one match per (repo, target_ref,
head_ref, head_sha). The producer that would write that ledger —
`produce_readiness_claim` (`readiness_proofs.py:1021`, block header "F5-g (ORPHAN-694)") — has
no production caller (only `test_branch_protection_proof.py` reaches it). The closing commit
`52d150c77` (PR #1247, 2026-08-17) is titled "the claim chain closes — every proof family
gains a producer and the merge lock becomes satisfiable". The ledger is empty; the lock is not
satisfiable. The defect is live and the closure did not hold.

The function itself enforces the correct shape: it refuses to assemble a claim when the calling
run's `workflow_run_id` has no proven `ci_workflow_run` row
(`readiness_claim_current_run_unproven`, :1060-1072) — so the merge runner producing its own
claim is impossible by design. The fix therefore places production in the PR-head CI lane
(`aria-merge-authority.yml`, a required status check on every PR): after its checks pass, it
records its workflow-run proof and assembles the claim with its own run identity, then
publishes the ledger to `aria/state`. Consumer side is unchanged. `test_narrow_lane_inactive_until_unlock.py`
stays green — the lane remains inactive; this completes the activation-time path only.

`ORPHAN-HIGH-694` itself is triple-booked: two full ledger headings (`orphan-findings.md:34`
Alertmanager routing, `:9686` branch-protection F5-b — both RESOLVED, different topics) plus
the code comment at `readiness_proofs.py:1004` using the same number for F5-g. Recorded as a
new instance under **PROC-HIGH-015**; renumbering waits for PR #1299's ledger-identity
uniqueness mechanism to merge. Until then no new commit writes `Closes: ...#ORPHAN-HIGH-694`.

### ORPHAN-HIGH-764 — the pre-merge perimeter exists, runs nowhere

`GATE_PRE_MERGE` is defined (`implementation_safety.py:993`), hard-fail checks default to it
(:1119), and `HARD_FAIL_GATES = {GATE_PRE_PR_OPEN, GATE_PRE_MERGE}` (:994). The only production
perimeter callsites are `pr_manager.py:347,359` — both `GATE_PRE_PR_OPEN`. `merge_authority`
contains no `observe_perimeter`/`run_hard_fail_checks` call, while ADR-041 decision 3 lists "a
fresh pre-merge re-check" in the ordered gate chain. The fix inserts the perimeter into
`merge_pr_if_ready` before any merge side effect, with a static pin in
`test_readiness_merge_eval_static_invariants.py` plus a behavioral test that a perimeter
refusal stops the merge.

### ORPHAN-HIGH-765 — promotion has never fired against live state

Live `aria/state`: `tools/raw-findings.jsonl` = 24,788 rows, `tools/findings.jsonl` = 0 rows.
`promote_consensus_findings` is wired (`cycle.py:1697`) and its contract says a confirmed true
positive is promoted exactly once per fingerprint — none ever was. Diagnosis runs against live
state to determine which filter empties the pipeline (no `ai_consensus` feedback rows / no
`true_positive` verdicts / `evidence_refs` never resolving to repo files,
`finding_promotion.py:95-109`); the fix lands on the producer side (judge-fanout consensus
writer or evidence-ref format). Regression test: a seeded consensus row with repo-file refs
promotes exactly once; non-repo refs skip with `no_repo_verified_evidence`.

### ORPHAN-HIGH-766 — the closure ceremony never asks if the closing thing is reached

Today's ceremony verifies a `Closes:` line names an existing finding. It never verifies that
the mechanism the closing commit added is reachable — ORPHAN-694/PR #1247 is the first
measured RESOLVED-but-live instance. This is the findings-analog of the closed-vocabulary
direction (declared-member reachability): `literal_provenance.ProductionIndex` already computes
writer/producer call-reachability; the caller dimension is the missing half. Fix is a Tier-3
gate on the ORPHAN-750 cricket template: first run pins the existing unreachable-closure set
as a named, owner+dated baseline; red only on NEW unreachable closures; the baseline never
ratchets up and shrinks only when a baseline entry becomes genuinely reachable (each shrink
visible in its own commit). ORPHAN-694/PR #1247 sits in the baseline by name — counted, not
silenced.

### ORPHAN-MEDIUM-767 — the ledger mirror's writer is unattributable

All ten `aria-tools/*.jsonl` ledgers carry nanosecond-identical mtimes in two batch events
(2026-08-20 10:12:26 and 10:49:54.957779186); sha256 digests unchanged across observations;
the files are gitignored (`.gitignore:208-214`) so no VCS signal exists; `refs/aria-snap2`
pins the morning's published tip at 07:02 with an unknown owner. Mechanism unidentified and
recorded as unknown — size-equality is not content-equality, and the digest trap covers only
post-10:49 transitions. Fix (Tier 3): a last-writer row (command, pid, ts) in the state
manifest from every state-materializing path, and a kernel conftest guard that refuses to run
tests when `ARIA_TOOLS_DIR` points at the repo's real `aria-tools/`.

### ORPHAN-MEDIUM-768 — the authority chain's live node is structurally stale

`CURRENT_STATE.md` is the top human-readable authority; all three core docs delegate to it via
ARIA-LIVE-AUTHORITY banners. Its `Date:` is 2026-06-21 because `aria-authority-hash.ts --write`
"rewrites only the 64 hex characters" and `aria-doc-runtime-ssot.spec.ts:126` pins
`toContain('Date: 2026-06-21')` — the freshness signal is frozen by the gate that should carry
it. Fix: CURRENT_STATE indexes the last two months of architecture (aria/state model,
CyclePhase pipeline, missions hierarchy, V9 implementer lane, judge/arbiter panel,
ADR-033/041 amendments); `--write` stamps Date alongside the hash; the spec literal becomes a
same-write consistency check.

### ORPHAN-MEDIUM-769 — three suites per main push, one of them a subset

`aria-kernel.yml` push has no paths filter (deliberate, ARIA-V-007 — kept). `aria-kernel-fast`
and `aria-kernel-full` fire on the same push with the same paths-ignore; full runs a strict
subset of kernel's steps (verified line by line); fast re-runs the same
unittests+lint+dry-run on PRs. Neither is a required status context. Fix: delete full, make
fast PR-only, update `test_ci_workflow_invariants.py:164`'s pin and rationale,
`workflow_contract_registry.py` exclusions, and scheduled-workflows.json references.

### ORPHAN-MEDIUM-770 — a branch-writing lane with no concurrency rule

`aria-agent-eval.yml` (hosted, weekly) publishes to `aria/state` and declares no concurrency
group. The z1 rule is disk-scoped by design (its docstring says why hosted jobs are out of the
DISK rule) — no rule covers the BRANCH hazard. Fix: eval gets its own group (not the shared
self-hosted group — ORPHAN-713/736 eviction hazard), and a sibling invariant: every workflow
that pushes to `aria/state`, hosted or self-hosted, must declare a concurrency group.

### ORPHAN-MEDIUM-771 — live prose contradicting executable reality

CONTRACTS.md:300 says `llm_bridge.py` does not exist; it exists (modified 2026-08-14) and is
the single entry of `_APPROVED_WRAPPERS` (`agent_harness_security_adapter.py:105`) — the
sanctioned exception to the direct-Anthropic-API security rule. It is not deleted; CONTRACTS
is corrected. Also in this set: IDENTITY §0 / CONTRACTS §0,§14 "ARIA does not exist" honesty
floors; SPEC §8.1 ceiling vs the staged unlock ladder; dangling
`docs/plans/2026-06-13-aria-to-main-controlled-merge/` (added in 29f2f2055, now absent) and
`docs/reviews/aria-implementer/`; stale cron comments (say 01:00/05:16, actual 01:13/02:29);
Node 20/22 pin split; codex-era runbooks without historical banners; stale counts (58 ADRs,
107 agent files, 23 aria-\* agents today).

### ORPHAN-LOW-772 — hygiene debt blunting signals

`.aria-acceptance-poc-tmp/` untracked and unignored; `api_backoff.py` (alive to grep only via
the watchdog's `api_backoff_engaged` event string), `restart_verify.sh`,
`tool_health_placeholder_test.py`, codex-monitor pid locks, the legacy
`aria-kernel/aria-tools/` tree. Host-level debris listed for the operator: three zombie
`tail -F` processes (May), `.aria-poc/` 7.1MB (2026-05-13), ~130 `.aria-ci/` tmp dirs,
`agent-workspace/` tar.gz archives. The snowball genesis retirement is deliberately NOT here —
see Governance below.

## PROC-HIGH-015 — new instance

The ORPHAN-694 triple-booking (two ledger headings + one code comment) is a new measured
instance of the concurrent-worktree ID-collision class. Resolution (renumbering one ledger
entry) is deferred until PR #1299's ledger-identity uniqueness mechanism merges; the instance
is recorded here and under the PROC-HIGH-015 section of `orphan-findings.md`.

## Governance item (not a hygiene item)

`_maintenance/aria-drafter` + the L3-snowball lane + I-V3-00a live in production code
(`agent_genesis.py:782,848`, `draft_validator.py:163` K6 contract, `lane_classifier.py`).
Retiring them removes the mechanism that could object. An operator-signed decision record with
rationale and a migration plan is prepared by this audit's fix waves; removal itself waits for
that signature.

## Operator gates this audit does not execute

ADR-040 live invocation (`PENDING-OPERATOR-LIVE-INVOCATION`), ADR-041 activation ceremony
steps 1-2, v3.1 smoke / V10.3-B endurance (dates long past, no run recorded). These are listed
for the operator: run them or re-date them with an explicit owner.

## Operator decision register (prepared 2026-08-20, awaiting signature)

Decisions this audit could PREPARE but not make — each needs the platform operator's signature
because each removes a mechanism that could object, or spends operator-held credentials:

1. **Snowball genesis retirement (governance, not hygiene).** `_maintenance/aria-drafter`, the
   L3-snowball lane and the I-V3-00a invariant live in production code (`agent_genesis.py:782,848`
   runtime-model resolution, `draft_validator.py:163` K6 refusal contract, `lane_classifier.py`).
   Removing them removes the mechanism that validates the genesis path; the retirement needs a
   signed decision with a migration plan (which module absorbs the drafter's validation role).
2. **Python stub-adapter portfolio.** Four Python adapters ride `shadow_runner.py` while the real
   logic lives in the TS adapters; `agent_harness_security_adapter.py` additionally owns the
   `_APPROVED_WRAPPERS` allowlist whose single entry is `llm_bridge.py`. Decide: fold into the TS
   registry or delete, together with the allowlist's future.
3. **Legacy `aria-kernel/aria-tools/` shadow state tree.** Kept as a documented hazard and
   referenced by `tool_registry` comments and V3.3 tests; removal migrates those references.

## Operator gates and host checklist (recorded, not executed)

- **ADR-040:** `verified_at_commit: PENDING-OPERATOR-LIVE-INVOCATION` — one supervised live
  invocation upgrades the lane's evidence from smoke to live.
- **ADR-041 activation ceremony:** (1) `aria-auto-cycle` dispatch with `mode=burn-in-observe`
  → REAL 30-cycle observe burn-in; (2) ≥1 week of nightly cycles inside caps; (3) master-switch
  enabling commit; (4) first autonomous-profile run watched end-to-end. The readiness-claim
  producer this audit landed (ORPHAN-HIGH-763) is the missing prerequisite the ceremony had.
- **GitHub App setup** (`docs/runbooks/aria-github-app-setup.md`): the `aria-readiness-claim`
  lane needs `ARIA_GH_APP_INSTALLATION_ID` / `ARIA_GH_APP_ID` / private key as repo secrets;
  until then the lane fails closed on every PR by design (`ARIA_REQUIRE_MODE_A=true`).
- **v3.1 smoke / V10.3-B endurance gates:** dates long past with no run recorded — run or re-date
  with an owner.
- **Host (the droplet doubles as the self-hosted runner):** three zombie `tail -F` processes
  (May, watching a deleted snowball worktree); `agent-workspace/` tar.gz archives and
  `.aria-poc/` (7.1MB, 2026-05-13) as local debris; **disk at 97%** — `/tmp` test debris was
  cleaned once (59GB→57GB) but the fill is structural; `aria-tools/daemons/codex-monitor-*`
  locks removed locally this session.
- **In-flight foreign work in the shared checkout:** `billing-plan-change-events.schema.ts` +
  the billing saga migration are half-wired (the event-contracts adapter correctly reds on the
  un-wired catalog) and belong to the parallel session's open train; every push from this
  checkout had to set them aside.

## ORPHAN-MEDIUM-773 — the production-roster gate failed on machine activity, not on the repo

Found while pushing Wave 1: two full-suite pre-push runs failed only on
`test_the_production_roster_still_covers_the_repository` — `.claude` carried 3445 Python files,
the full kernel copies inside parallel-session git worktrees. `unrostered_production_dirs`
walked every `*.py` under the checkout, so the roster gate went red whenever any session had an
active worktree and green only when the machine was idle. Fixed by skipping `.claude/worktrees`
explicitly (a checkout of this tree at another commit is not an answer to the roster's question).
Registration note: the finding was first registered state=RESOLVED at birth — a registration
error, since the close ceremony cannot run pre-merge (`close` refuses branch-local SHAs,
PROC-HIGH-001) — and was returned to OPEN through the new governed `reopen` verb; the close will
run post-merge with the main-reachable SHA of fix commit 3d1574576.

## ORPHAN-LOW-774 — the specialist-review --strict flip lived as a workflow-comment TODO

The dry-run ran warn-mode in the kernel lanes behind "flip to --strict once the Lane-A inventory
is fully populated" — a decision with no owner, no criterion, no deadline, carried only in YAML
comments. The comments now cite the finding; the flip criterion (inventory fully populated AND
four consecutive green weekly warn-mode runs), owner (platform operator with the kernel owner)
and deadline (2026-09-30) are in the registry row.
