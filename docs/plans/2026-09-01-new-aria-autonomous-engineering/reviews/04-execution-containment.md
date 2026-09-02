<!-- markdownlint-disable MD013 MD033 -->
<!-- Historical review text preserves long evidence tokens and placeholders. -->

# D0 adversarial review — execution containment and concurrency

## Verdict

`CHANGES_REQUIRED`

The D0 bundle has strong high-level controls: the executor is assigned to a separate worker VM; legacy ARIA
has zero diff and is not a runtime dependency; Postgres current state, transactional outbox/inbox, quarantined
CAS admission, fencing, reconciliation, role-specific credentials, and the P03/P04 no-push/no-merge gates are
all named. The reviewed state also remains `VERIFYING`.

However, five execution-boundary issues remain. Each can permit a stale or compromised worker to cross a phase
boundary, make the intended credential split impossible to implement safely, or perform the first live effect
before its recovery boundary is proved. These are load-bearing P1 issues, so D0 should not be approved as the
implementation authority yet.

## Findings

### EXEC-P1-001 — The provider broker/executor split has no executable process and filesystem contract

- **Severity:** P1
- **Evidence:**
  [`design.md:62`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L62)
  places the brokers outside the worker zone while
  [`design.md:64`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L64)
  assigns the worktree to the executor. The authority matrix forbids broker Git access and forbids executor
  access to the provider secret at
  [`design.md:83`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L83)
  and
  [`design.md:85`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L85).
  Yet the normalized broker request includes a permitted tool set and the broker returns an artifact at
  [`design.md:168`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L168),
  while S20/S21 only require a credential-isolated broker image and secret-propagation tests
  ([`P03.md:41`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md#L41),
  [`P03.md:53`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md#L53)). The
  plan never says which process runs Codex/Claude tool calls, which role mounts the worktree, or how tool
  requests cross the boundary without exposing the subscription credential.
- **Consequence:** An implementer must choose between running the provider CLI beside the secret with
  repository/tool access (making the broker a second, unconstrained executor) or running it in the executor
  and exposing the credential. A malicious repository/prompt can then read broker auth material, bypass
  executor command/network policy, or make the heavy CLI share the production control-plane failure domain.
- **Smallest corrective action:** Add one normative process/data-flow contract. It must identify where each
  CLI process and child tool runs, mount and namespace ownership, broker placement, authenticated job-scoped
  RPC, which side enforces tool/egress policy, and why raw credential bytes/config/socket/process environment
  are unreachable to the executor and repository code. If the broker executes tools, give it the same
  worker-VM sandbox and explicitly narrow its worktree access; if the executor executes tools, define a
  credential-blind mediated protocol and prove that the subscription CLIs support it. Bind this deliverable to
  S18, S20, S21, and S24.
- **Required checks:** Malicious prompt/repository fixtures must attempt `/proc` environment reads, broker
  credential-home/config/socket access, direct broker child-process execution, unauthorized filesystem writes,
  Git/provider egress, and secret reflection in responses/artifacts. Also prove broker/CLI CPU, memory, PID,
  disk, and timeout containment on the worker failure domain.

### EXEC-P1-002 — Lease fencing stops database writes but is absent from the broker side-effect envelope

- **Severity:** P1
- **Evidence:** Every external effect is said to carry a fencing token and attempt at
  [`design.md:135`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L135),
  and stale-worker writes are rejected at
  [`design.md:153`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L153).
  The actual broker request contract at
  [`design.md:168`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L168)
  contains `requestId`, workspace, snapshot, capability, budget, timeout, retention, and tools, but no
  mission/job/attempt identity, lease epoch/fencing token, cancel generation, effect UUID, or idempotency key.
  S17 tests a stale fencing token
  ([`P03.md:9`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md#L9)), but
  S20/S21 do not require a stale/cancelled lease refusal at the broker boundary
  ([`P03.md:45`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md#L45),
  [`P03.md:57`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md#L57)).
- **Consequence:** After lease expiry, cancellation, or reassignment, the old executor can continue provider
  calls and consume reserved capacity concurrently with the new attempt. Rejecting its final DB write does not
  undo provider cost, disclosure, compute usage, or duplicate artifacts. Retry/replay can therefore create
  multiple real side effects while the ledger records only one.
- **Smallest corrective action:** Make every broker/CAS/publisher admission carry a canonical
  `missionId + jobId + attemptId + effectId + idempotencyKey + leaseEpoch/fencingToken + cancelGeneration + snapshotSha + budgetReservationId`
  envelope. Require a current, atomic capability check before dispatch and again before result/artifact
  admission. Define how a broker with no authority-DB credential verifies the short-lived capability, and
  preserve one effect ID across retry/reconciliation.
- **Required checks:** Race lease expiry/cancel/retry against broker dispatch at every boundary: before send,
  after send/before response, after response/before CAS, and after CAS/before DB admission. Prove the stale
  attempt cannot start a new call or admit output, that an already-sent call remains `UNKNOWN` until
  reconciled, and that budget settles exactly once.

### EXEC-P1-003 — Cleanup containment is check-then-delete and lacks a non-attacker-owned teardown boundary

- **Severity:** P1
- **Evidence:** S19 specifies allowlisted roots, `realpath`/symlink containment, registered-worktree matching,
  and fail-closed `git worktree remove`
  ([`P03.md:31`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md#L31)). Its
  negative controls are static outside-path/symlink/unregistered/nonzero fixtures at
  [`P03.md:33`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md#L33). The
  design repeats a generic cleanup gate at
  [`design.md:177`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L177),
  but neither artifact defines who owns the allowlisted parent, whether executor code can rename or replace
  path components after validation, or an fd/volume/VM-scoped teardown primitive.
- **Consequence:** Repository-controlled code sharing the cleanup UID can win a validation-to-use race by
  renaming/replacing a path or mount after `realpath`/registry validation. A cleanup worker can then target a
  different tree, race an active worktree, or destroy another job's directory. Static symlink tests do not
  establish destructive-operation safety under concurrency.
- **Smallest corrective action:** Make cleanup targets supervisor-created opaque workspace IDs, not
  persisted/caller paths. The executor must not write the allowlisted parent. Prefer destroying a job-scoped
  ephemeral volume/VM; otherwise specify dirfd/handle-relative no-symlink traversal, immutable parent
  ownership, same-device/mount checks, immediate pre-delete identity revalidation, active-lease fencing, and
  no recursive path fallback. Cleanup must run only after the attempt is fenced and all child
  processes/effects are terminal or reconciled.
- **Required checks:** Multi-process rename/symlink/bind-mount swap during validation and deletion; concurrent
  cleanup of active and adjacent worktrees; reused path/job ID; crashed/nonzero Git removal; orphan child
  holding the CWD; and a proof that only the disposable job volume disappears.

### EXEC-P1-004 — `EXECUTE_NO_PUSH` evidence conflicts with the mandatory per-sprint push protocol

- **Severity:** P1
- **Evidence:** The global sprint contract requires every green commit to be pushed
  ([`PLAN.md:37`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md#L37)) and the
  branch protocol repeats push-after-each-commit at
  [`PLAN.md:278`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md#L278). The same
  plan calls every sprint/mission an isolated branch/worktree
  ([`design.md:177`](../../../../docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md#L177)),
  while P03 requires `EXECUTE_NO_PUSH` and an observed zero remote-ref/PR/merge delta
  ([`P03.md:3`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md#L3),
  [`P03.md:89`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md#L89)). No
  authority text distinguishes the human/program-development branch that must be pushed from the runtime
  mission worktree whose remote effects must remain zero.
- **Consequence:** S17-S24 cannot literally satisfy both statements. Evidence can accidentally count the
  required implementation push as a P03 violation, or, more dangerously, exclude an executor push after the
  fact by informally changing scope. The no-push gate is therefore not a reproducible deterministic claim.
- **Smallest corrective action:** Define two explicit, separately identified planes: (1) the
  operator/development sprint branch, delivered under repository commit/push rules, and (2) the new-ARIA
  runtime mission sandbox, which has no credential/helper/socket/Git-provider route and whose remote state is
  measured. Bind all S24 evidence to a runtime job/attempt, executor image, network policy, repository ID,
  baseline remote refs, and observation window; state that program delivery occurs outside that window and
  identity.
- **Required checks:** Capture all remote refs/PR/check/merge state before and after the runtime attempt;
  inject credential URL, credential helper, `.netrc`, SSH agent, Git config/include, hook, alternate remote,
  and direct HTTPS/SSH push attempts; require both network denial and zero provider state delta. Separately
  prove the implementation sprint's ordinary push without using executor credentials.

### EXEC-P1-005 — The first live merge precedes rollback/revert readiness

- **Severity:** P1
- **Evidence:** S52 explicitly runs merge execution live and permits a “sandbox/canary” result
  ([`P07.md:43`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md#L43),
  [`P07.md:50`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md#L50)). S53
  then observes merged/deployed outcomes
  ([`P07.md:55`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md#L55)).
  Revert, rollback, stop/page, the release-owner prerequisite, and rollback evidence are not built or drilled
  until S54
  ([`P07.md:67`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md#L67));
  `OP-06` is likewise gated only at S54/S69
  ([`PLAN.md:76`](../../../../docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md#L76)). The actual
  supervised cohort begins later at S55.
- **Consequence:** If “canary” in S52 is a real protected-repository merge, the program performs its first
  autonomous irreversible repository effect before it has proved who can stop/page/revert it or that a failed
  revert cannot be reported as success. The P07 gate's later rollback evidence cannot protect that first
  merge.
- **Smallest corrective action:** Make S52 live proof disposable-sandbox-only and state that
  production/protected-repository merge dispatch remains capability-disabled through S54. Require the S54
  rollback/stop/page drill and `OP-06` before S55 is the first low-risk production canary. Add the same
  activation boundary to the PLAN index/gate text so “live” cannot be interpreted as production authority.
- **Required checks:** Before S54, prove a production repository/effect cannot be selected even with a forged
  permit or direct adapter call. In a disposable repository, exercise 202/409/unknown and a failed revert.
  Before the first S55 merge, require current rollback owner/on-call, successful revert/readback, freeze, page
  delivery, exact-SHA restore, and release-role absence from ARIA.

## Focused verification performed

- `git apply --check --reverse .superpowers/sdd/BOOTSTRAP/review-eeb401131..c6065d6da.diff` — PASS.
- Parsed the D0 evidence JSON and every JSONL event record — PASS.
- `git diff --check eeb401131260fe45f3f60be55fa25d023a082d18..c6065d6dac97306f147de67ef58a96e3a67524ac` —
  PASS.
- Protected legacy diff check for `aria-kernel`, `tools/aria-poc`, `docs/aria`, `.claude/agents/aria-*`, and
  `.github/workflows` — empty/PASS.
- Read the root rules, D0 brief, task contract, implementer report, complete changed artifacts, packaged diff,
  and the frozen execution-related audit evidence at `85787e610`.

No tracked file, commit, remote branch, PR, legacy ARIA artifact, or runtime state was changed by this review.
Only this controller-requested scratch report was created.
