# ARIA Current State

Date: 2026-10-02
Target ref: `origin/main`
Status: post-snowball mainline hardening in progress

## Authority Chain

ARIA authority is ordered and fail-closed:

1. Executable code and machine-checked contracts are normative.
2. This file is the live human-readable state index.
3. Accepted ADRs are normative only when they do not contradict executable contracts or this file.
4. `SPEC.md`, `CONTRACTS.md`, `IDENTITY.md`, `ROADMAP.md`, and `docs/aria/plans/**` are live only in
   sections that are not marked historical, superseded, or compatibility reference.
5. Historical snowball/Claude-era docs are evidence of design history, not runtime authority.

When two sources disagree, the lower-priority source must be updated, generated from code, or
explicitly marked historical. Runtime behavior must not be inferred from stale prose.

This file records no digest of the tree it describes. Its falsifiable claims are the anchors below:
`tests/invariants/aria-doc-runtime-ssot.spec.ts` fails when an anchored path or Python symbol no
longer resolves. The authority-surface digest of any commit is derived on demand with
`npm run aria:authority-hash -- <rev>` (PROC-HIGH-046).

## Current Normative Anchors

- Runtime CLI and public surface: `aria-kernel/aria_kernel/cli.py`
- Runtime profile and write authorization: `aria-kernel/aria_kernel/runtime_profile.py`
- State surface inventory: `aria-kernel/aria_kernel/state_manifest.py`
- Tools root identity and binding: `aria-kernel/aria_kernel/tool_registry.py`
- Runtime artifact graph and v2 approval: `aria-kernel/aria_kernel/runtime_artifacts.py`
- Run envelope/status owner: `aria-kernel/aria_kernel/tool_health.py`
- Strict run-ledger reader/upcaster: `aria-kernel/aria_kernel/runs_reader.py`
- Agent role/lifecycle SSoT: `aria-kernel/aria_kernel/agent_surface.py`
- Agent request/response contract: `aria-kernel/aria_kernel/agent_contract.py`
- Transactional append/index primitive: `aria-kernel/aria_kernel/ledger.py`
- Ledger row-size cap, one constant for write and read side:
  `aria-kernel/aria_kernel/ledger.py::LEDGER_ROW_MAX_BYTES`
- Inline-row byte discipline shared by ledger writers: `aria-kernel/aria_kernel/ledger_inline.py`
- Runner habitat memory budget (systemd drop-ins; `scripts/aria/provision_runner.sh` installs and
  drift-checks them): `scripts/aria/runner-habitat/systemd/`
- Merge authority: `aria-kernel/aria_kernel/merge_authority.py::merge_pr_if_ready`
- Merge lane runner: `.github/workflows/aria-merge-runner.yml`,
  `aria-kernel/aria_kernel/auto_merge_runners.py::select_auto_merge_runner`
- Merge-lane grant owner: `aria-kernel/aria_kernel/runtime_profile.py::get_merge_lane_grant`
- Merge freezes: `aria-kernel/aria_kernel/watchdog_freeze.py::assert_merge_not_watchdog_frozen`,
  `aria-kernel/aria_kernel/self_merge_freeze.py::assert_self_merge_not_frozen`
- Self-revert producer: `aria-kernel/aria_kernel/self_revert.py::run_self_revert_producer`
- Enterprise risk policy owner: `aria-kernel/aria_kernel/risk_policy.py`
- Enterprise autonomy unlock owner: `aria-kernel/aria_kernel/autonomy_unlock.py`
- L3 policy approval owner: `aria-kernel/aria_kernel/policy_approval.py`
- Rollback bundle owner: `aria-kernel/aria_kernel/rollback_bundle.py`
- Incident ledger owner: `aria-kernel/aria_kernel/incident_ledger.py`
- Runner attestation owner: `aria-kernel/aria_kernel/runner_attestation.py`
- Capability resolution owner: `aria-kernel/aria_kernel/capability_resolver.py`
- Required PR merge check: `.github/workflows/aria-merge-authority.yml`
- Executor implementation: `tools/aria-poc/ci_executor.py`, `tools/aria-poc/worker_executor.py`, `tools/aria-poc/claude_runtime.py`
- Runtime artifact safety boundary: `aria-kernel/aria_kernel/artifact_safety.py`
- Enterprise autonomy burn-in: `aria-kernel/aria_kernel/burn_in.py`
- Observe burn-in report schema: `docs/aria/schemas/autonomy-burn-in-report.schema.json`

## Runtime

ARIA live autonomous execution is Claude Code CLI based and must use a managed Claude Code login
session on a trusted/private runner. Direct API-key / proxy-billing runtime mode is not the default
authority for this repository.

Legacy Codex executor language in older docs is historical or compatibility reference unless an
executable contract explicitly calls it. Any live doc section that treats `codex exec`,
ChatGPT-managed Codex auth, or `codex_runtime.py` as the current ARIA runtime authority is a
documentation defect.

## State And Lifecycle

`state_manifest.py` is the inventory for write-driving ledgers, runtime state, indexes, locks, and
artifacts. Runtime writes that can drive future behavior must be declared there before they are
trusted by autonomy.

`runtime_profile.py` is the single write-authorization boundary for profile-aware surfaces. The live
profile taxonomy is `observe`, `standard`, `strict`, `frozen`, and `autonomous`.

`runtime_artifacts.py` owns artifact graph verification. Promotion evidence must be
artifact-bearing, hash-bound, path-contained, indexed, and connected to the relevant cycle/run
ledgers. Lifecycle-only cycles do not authorize promotion.

`ARIA Operational Proof` is the GitHub Actions proof lane for isolated temp-tools runtime
verification and strict/mock autonomy smoke. It must not write repo-local ARIA runtime state.

`agent_surface.py` owns request roles, invocation roles, dispatchable roles, bridge-required roles,
target-agent whitelist, role-target pairing, and derived request lifecycle labels. Callers must
consume that SSoT rather than maintaining local role sets.

`autonomy burn-in observe` is the first enterprise autonomy acceptance slice. It runs discovery,
memory, pressure, and triage for exactly 30 observe attempts with at least 20 valid cycles, and
fails if agent claims, tool runs, PR lifecycle, runtime promotions, or agent/skill materializations
are observed. It is not a full autonomous merge proof.

## Merge Lane

Read from the code on 2026-10-17 (ARIA-MEDIUM-232):

- `aria-merge-runner.yml` runs `aria-kernel merge-lane run` when `aria-readiness-claim` or
  `CI - Affected` completes, and hourly. It builds the one runner that may execute a merge
  (`executes_merges=True`), and every merge goes through `merge_pr_if_ready`, which merges with
  `gh pr merge --squash --match-head-commit <head>` (`aria-kernel/aria_kernel/auto_merge.py`).
- `aria-readiness-claim.yml` assembles a head's readiness claim when that head's
  `aria-merge-authority` pull-request run completes green, under the aria/state writer lease. A run
  that meets a held lease yields and claims nothing; the lane's hourly schedule then claims, one
  head per run, an open head no claim names whose green `aria-merge-authority` run still has its
  proof artifact (`aria-kernel readiness sweep-claimless`, ARIA-HIGH-222).
- A merge needs an operator's merge-lane grant: lane `L1` only, at most 90 days, with an
  `operator_approval_ref` and a recorded approval; an expired, malformed or unreadable grant reads
  as no grant (`get_merge_lane_grant`). ARIA cannot grant itself the lane (M-6.1 in
  `docs/aria/MISSION_SPEC.md`).
- Two freezes refuse merges inside `merge_pr_if_ready`: an open external-watchdog incident refuses
  every merge (`assert_merge_not_watchdog_frozen`); ARIA's own self-merge freeze refuses every PR
  except the revert it registered (`assert_self_merge_not_frozen`). The self-revert producer writes
  that freeze before it opens the revert, and only an operator's GitHub act lifts it.
- The self-revert producer opens a revert only for a merge the merge authority recorded as its own,
  on an attributable post-merge red or a `regression` change outcome (`run_self_revert_producer`).
- `merge_pr_if_ready` refuses a PR whose readiness claim does not verify
  (`enterprise_readiness_required_for_merge`), and the claim's branch-protection proof fails with
  `branch_protection_merge_queue_required` unless main's rules carry a squash merge queue
  (`aria-kernel/aria_kernel/enterprise_readiness.py::branch_protection_policy_reasons`,
  ARIA-HIGH-221). Main requires up-to-date branches and has no merge queue (branch protection read
  on 2026-10-07, recorded in `aria-kernel/aria_kernel/pr_branch_update.py`), and a user-owned
  repository cannot carry a merge-queue ruleset (PROC-LOW-038), so the lane merges nothing until
  ARIA-HIGH-221 is settled.

## Clean Trial Rule

A clean ARIA trial must run from an isolated worktree at the declared target commit. Existing
detached or dirty operator worktrees are not validation surfaces. Every runtime command in a trial
must receive an explicit bound `--tools-dir` and `--workspace-root`; repo-local shadow roots such as
`aria-kernel/aria-tools/` are invalid.

## Documentation State

The ARIA docs set contains historical material. Sections still saying only the PoC exists, the
kernel does not exist, live runtime is Claude/Anthropic, or auto-merge is categorically impossible
are superseded unless explicitly restated by this file and the executable contracts above.

For the bilingual architecture explainer with diagrams, see `docs/aria/ARCHITECTURE.md`. That
document is explanatory only: it must defer to this file, executable contracts, and machine-checked
invariants whenever there is a conflict.

For the enterprise autonomy SSoT and burn-in acceptance matrix, see `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md`.

On 2026-06-20, `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md` records the accepted
production-autonomy target decisions: full production autonomy, whole-repo
risk-gating, L3 two-stage human policy approval before ARIA merge execution,
rollback bundle plus incident ledger, L2 unlock after 30 supervised successes,
hybrid GitHub Actions plus private-runner runtime, hybrid GitHub App plus
`GITHUB_TOKEN` token model, kernel plus required-check plus CODEOWNERS merge
authority, and hybrid ledger/state authority. This record is not live merge
permission; live authority still requires the machine-readable policy files,
schemas, executable owners, required GitHub check, CODEOWNERS ownership,
state-manifest declarations, and invariants listed in that SSoT.
