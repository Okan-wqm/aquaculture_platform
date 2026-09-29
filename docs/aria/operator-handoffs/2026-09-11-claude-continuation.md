# ARIA handoff — STOPPED for Claude takeover

Updated 2026-09-11 14:37 UTC. User explicitly ordered graceful shutdown. All three owned agents and their jobs are quiescent. The live ARIA planner was cancelled through its existing native operator control, its child exited, and its claim was reconciled. Root is returning READY TO EXIT; the user will exit this Codex CLI and launch Claude in the same terminal. **Do not resume Codex or start duplicate workers automatically.**

This is an operational note on the server's `/var` filesystem, not a deployment or whole-system acceptance. Linked `/tmp` evidence still exists but is not guaranteed to survive cleanup. No credentials are included. Existing staged/user changes were preserved.

## Copy-paste first instruction for Claude

> Read `/var/aqua-saas/.worktrees/codex-aria-learning-20260910/CLAUDE.md`, this handoff, and the latest execution-register entries linked below. Codex and its three agents have stopped by user request. Confirm no owned worker/test process remains, preserve all dirty worktrees and inherited indexes, and continue the shortest genuine ARIA planning→implementation→judge→validation→PR/CI→eligible merge→outcome→later-task learning path. Reuse existing owners and peer-review test correctness. Start from the recorded cancelled trial and blockers, not a new architecture inventory. Do not redispatch the cancelled request or fabricate an accepted result. Implement and actually exercise the separately authorized Z.ai subscription API route after secure key provisioning; never print or copy its key. User authorized normal commits/pushes/PRs/Actions, not bypasses or live activation.

## Terminal and conversation access

- tmux session/pane: `aria-codex-visible-20260910:0.0`, pane `%0`.
- Read-only observation: `tmux attach-session -r -t aria-codex-visible-20260910`.
- At shutdown verification: shell PID2638906, root Codex PID2652624, code-mode PID2655150. The only root descendants were code-mode and the already-finished process observation. No worker/model child/test descendant remained. Root CLI itself remains for the user to exit; no unrelated session/service was stopped.
- Codex thread/session: `01a08b96-242b-7aa1-9eac-ed8030c32634`.
- Saved conversation: `/root/.codex/sessions/2026/09/10/rollout-2026-09-10T13-51-09-01a08b96-242b-7aa1-9eac-ed8030c32634.jsonl` (about163MB). Private historical context; do not copy it into ARIA task inputs or evidence. Read this note/register first.
- If the user later chooses Codex again, and the original CLI is no longer active, installed supported resume syntax is:

```bash
codex resume 01a08b96-242b-7aa1-9eac-ed8030c32634 -C /var/aqua-saas/.worktrees/codex-aria-learning-20260910 -m gpt-6-astra -c 'model_reasoning_effort="xhigh"'
```

Claude does not import a Codex thread natively. It continues from the server files. Do not use Esc/SIGINT or start a second resume against an active Codex session. The user will perform the CLI exit and Claude launch.

## Current objective and policies

Connect ARIA's existing capabilities so a real software task consumes revision-bound repo/self knowledge, produces a justified plan and patch, gets separate judge review and actual tests, reacts to regression through bounded repair, passes PR/CI and real merge authority, records an outcome and changes a later decision. Component, declared-fixture, native model, successful, failed and unknown evidence stay distinct.

**SSOT is not mandated.** Compare improving the current design, SSOT, hybrid or other repo-appropriate approaches against actual invariants/failures; have a peer challenge tradeoffs. Find existing capabilities first. Avoid duplicate planners/executors/stores, conflicting authority, stale caches without invalidation, swallowed failures, fake empty/zero success, test weakening and gate bypasses. Changed source requires its source-linked docs/affected edges updated. Root integrates; different authors review tests, native consumers and error behavior. Parent now directs only, with no parent code/test re-audit gate.

Normal commits, nonforced pushes, PRs and applicable Actions are authorized. Preserve unknown inherited staged work; do not blindly add all files. No hook bypass, force push or automatic remote merge/live activation. Farm is parked. Old no-commit/freeze/parent-audit/keep-running/supervisory-ultra instructions are superseded. Last Codex supervisory preference was Astra xhigh; actual ARIA Codex requests Astra ultra. Future Claude supervision is now explicitly requested.

Codex and Claude providers require actual managed subscription CLI sessions, never their API keys/direct APIs. Z.ai alone may use its distinct subscription API. **New explicit backlog acceptance: exercise ARIA agents with REAL Z.ai API access using the user-provided subscription key.** That key has NOT been provisioned to these remote workers; real Z.ai tests are pending, not passed. Arrange a reviewed scoped runtime secret boundary without chat/argv/Git/log/evidence copies; resolve general-vs-Coding-Plan endpoint entitlement honestly. Never inject Z.ai credentials into Codex/Claude children. No Z.ai launch occurred during shutdown.

Usable subscription auth/quota, not nominal dollars, admits work. Keep genuine auth/quota observations, bounded retries/timeouts/context, task/effect ownership and resumable failover. Zero available providers preserves work; one provider permits separate judge sessions without a false diversity claim. Existing S5 backlog: **value of accepted work produced per token**, later, no metric implementation now.

## Source/worktree map

Dirty detached worktrees contain the reproduced accepted staged AND unstaged baseline; HEAD alone is not their source identity. Preserve all of them.

| Owner/scope | Worktree | Branch / HEAD |
| --- | --- | --- |
| Preserved central | `/var/aqua-saas/.worktrees/codex-aria-learning-20260910` | `codex/aria-learning-20260910`, `fea5890`;143 preexisting changed entries plus this new untracked note |
| Root connected candidate | `/tmp/codex-aria-flow-planning-20260911-worktree` | detached `fea5890`; frozen source `7b8ffdf7b70218601f2c00fa6baa2af343556bc2256c953a64581d9c84a5d072` |
| Runtime | `/tmp/codex-aria-runtime-20260911-worktree` | detached `fea5890`; export source `5ae42005` |
| Memory/merge | `/tmp/codex-aria-retention-r2-20260911-worktree` | detached `fea5890`; latest source `616ebc75`, test `bb082faf` |
| Core services/regression | `/tmp/codex-aria-services-20260911-worktree` | detached `fea5890`; latest `f1ed70`, test `94b578` |
| Core publication | `/tmp/codex-aria-publish-spine-20260911` | `fix/aria-event-regression-progression-20260911`, `8ec2536b`;3 fixture files modified after failed push |
| Published runtime | `/tmp/codex-aria-publish-runtime-20260911` | `feat/aria-codex-runtime-prerequisites-20260911`, `cd38d11a`;clean |
| Parked farm | `/tmp/codex-aria-publish-farm-20260911` | `test/farm-feeding-summary-contract-20260911`, `53d3e82d`;2 uncommitted paths |

Repo: `Okan-wqm/aquaculture_platform`. Publication base was `53d3e82d4b500cabc034fe5874df066f2e1af24d`; fetch actual current main for later delivery. Unrelated worktrees exist and must not be altered. Root's runtime integration changed13 paths/3 already exact, retaining shared source-binding and four merge predicates, with independent review. Connected docs are updated; final connected doc/pin/API/publication closure remains.

## Final live trial state — do not duplicate

- Prepared by `prepare_planner_choice.py`; normal `planner_dispatch_hook.dispatch_one_pending_planner_request` invoked by receipt-only `dispatch_planner_choice.py`. No substitute provider, gate bypass or fabricated result.
- Request `AIR-aria-challenger-planner-fa63e92e0c40`; task Git SHA `600cfcffae866c20d7f3482d0cca8fac3ca6ab29`; claim `claim_40bb9edf337e714e`.
- Real managed admission passed and `runtime_attempt_started` selected OpenAI/Codex `gpt-6-astra`, requested ultra. Bound600s execution/900s lease. **No accepted response or planning-consumer result.**
- User shutdown recorded native command `ctl-88c8571f407ca0b8` at14:34:56Z. Existing cancellation poll sent SIGTERM; child exit−15. Native `operator_cancel_applied` says `sigterm`; claim released/requeued with `operator_cancelled`, but authoritative request fold is terminal **`CANCELLED_BY_OPERATOR`**. Cancellation is sticky; do not treat the requeue row as permission to reuse it.
- Wrapper session17802 exited2 after324.162s; CI exit1, no result rows,0accepted results. Finish receipt says `provider_nonzero`; the actual operator-cancel row identifies the cause—do not classify as auth/quota loss. Usage unavailable, not zero.
- Connected source stayed7b8ffdf7; task HEAD unchanged and working status empty. Read-only trial made no model code/PR change. Process was reaped; no residual child remained.
- Exact receipts: `/tmp/codex-aria-flow-planning-20260911/planner-trial-three/{operator-shutdown-command.json,graceful-shutdown-reconciliation.json,native-dispatch-one/result.json}`.
- Subsequent continuation needs a legitimate fresh native request/trial, preserving the cancelled history and current-body rules. Old trial-two lacked explicit subscription policy; do not reuse it. The prepared source task is a controlled real-model planning evaluation, NOT heldout learning. Keep its independent oracle and all answer-bearing engineering/session material outside actual container mounts/tools.

## Completed evidence and remaining connections

- Real managed Codex COMPONENT returned `ARIA_COMPONENT_OK`40.0283s with thread/turn events and9359input/7output tokens, private writable state, readonly original auth file and PID namespace. Requested model/effort known; returned model/effort unavailable. No native accepted task implied.
- Runtime inherited2 passed29.52s; binding3+2sub passed27.03s isolated and27.06s connected. Disposable positive fixture still PENDING: `runtime_admission_unavailable`/`no_eligible_provider`, fake status exit1/`status_not_confirmed`, auth/quota unknown, controls available. Separate fake reconstruction passed; context-specific discrepancy unresolved. Do not alter production just to accommodate an incomplete fixture.
- Connected retention/hot6 passed136.97s+8sub. Scope/caller7 passed; remaining exact native merge-context method retried unchanged after sandbox Git EPERM and passed202.49s+8sub. These are separate runs, not combined invented coverage.
- Four of7 real predicates are implemented/exercised: branch-tip recheck, content hash, per-file exclusion, plan coverage. Open: operator feedback authority/binding, shared subscription-aware cycle/turn budget, final expert consensus. They do NOT gate readonly planning.
- Final implementation→two native expert requests passed79.72s+8sub. Subsequent consumer control failed101.66s+6sub **before consensus**: native response admission rejects `specialist_domain_review` as an unknown response role. First consumer/role contract connection remains missing; do not weaken the schema blindly. Applicability-order legacy control RED3.08s→GREEN2.68s preserved. No fifth predicate or model opinions proved.
- Regression→failed cycle/outer→preserved same-plan baseline→corrective-plan consumer passed7+2sub212.27s and separate legacy5 72.99s. Integrated source exists; actual model validated repair/resume remains open.
- Services upcaster control reached real native validation with Nx exit0 but failed its unsupported human-log `Tests:` assertion; earlier missing plugin/Nx internal-path fixture errors are preserved. Supported Jest JSON-report correction is external-only, not applied/reviewed/executed. No native correlation product RED yet.

## Quiesced agents and immediate next work

All three agents ended model work; do not send resume tasks automatically. Runtime: no jobs at stop, frozen export, checkpoint `/tmp/codex-aria-runtime-evidence-20260911-o8c5835e/shutdown-current-handoff.json`. Memory: test session43169/PID1483392 completed naturally and reaped, checkpoint `/tmp/codex-aria-merge-seven-20260911-bk1hawao/SHUTDOWN-HANDOFF.md`. Services: sessions30686/1191/9397/3346/68358 all completed/reaped, no job, checkpoint `/tmp/codex-aria-services-evidence-20260911-dvsnatv4/graceful-shutdown-checkpoint.json`. Root sessions25141/17802/25467/84727/27745 also exited; no new tests, edits to implementation, commits or provider calls launched after shutdown request.

After user starts Claude: verify state once, then assign disjoint implementation and peer-review owners. Prioritize actual fresh native planner accepted-result/consumer proof, implementation/judge role dispatch, validated repair and memory reuse. Keep cancellation history; inspect pending native role/schema and command-correlation gaps. Complete operator authority and subscription-aware attempt/evidence budget predicates without self-signed endorsement or legacy dollar reblocking. Actual Z.ai subscription tests are now explicit pending acceptance after secure provisioning.

Publication: original normal push failed **2849tests/8failures/38errors/16skips/7948.421s**.37errors share F-901 fixture history; equivalent base/candidate ordered pairs reproduced finding/promotion leakage and CLI deadline leakage. Three fixture-only lifetime repairs are uncommitted: `test_change_outcome.py`, `test_finding_promotion.py`, `test_cli_autonomy_subcommand.py` (12inserted lines; all methods unchanged). Targeted8 passed29.495s; actual corrected CLI-fixture→same adjudication passed48.376s/51.28outer, peer-cleared. Original history intact. Finish remaining targeted failures/docs/finding traceability/pin, normal commit/push, then required broad hook/Actions. Do not repeat broad tests before targeted causes are resolved; never erase findings or weaken deadline/regression gates.

Earlier draft [PR1547](https://github.com/Okan-wqm/aquaculture_platform/pull/1547), headcd38d11a, last verified8workflows/4required contexts green. Core8ec2536b has NOT pushed and has no PR. Future pushes need actual head-specific CI; no farm delivery claim.

## Detailed existing context

- Execution register: `/tmp/codex-aria-retention-r1-r2-20260911-_qef_m9w/ARIA-execution-register-current.md` (latest-first; older freezes/policy are historical).
- Connected evidence/task/readout: `/tmp/codex-aria-flow-planning-20260911/`; private oracle is `planner-choice-private-oracle.md`, never include in model scope. Existing `read_planner_choice.py` joins accepted sealed result to actual plan event when a future run qualifies.
- Runtime: `/tmp/codex-aria-runtime-evidence-20260911-o8c5835e/`; frozen16-file export `native-cumulative-runtime-export/`, genuine component and source/launcher peer reviews.
- Merge: `/tmp/codex-aria-merge-seven-20260911-bk1hawao/`; expert producer/consumer and4predicate evidence.
- Services: `/tmp/codex-aria-services-evidence-20260911-dvsnatv4/`; native repair, upcaster and `publication-deadline-source-review/`.
- Publication: `/tmp/codex-aria-spine-publication-20260911/`; original push, exact failure index, paired base/candidate receipts and fixture GREENs.
- Worktree roster snapshot: `/tmp/codex-aria-delivery-20260911-v71xqq39/current-handoff-worktrees.json`.

No takeover/model job is launched by this file. The user starts Claude themselves.
