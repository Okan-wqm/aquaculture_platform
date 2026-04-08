---
Topic: Persistent plan state and resumability — plan.md as state file, per-package completion markers, append-only verification log, idempotent re-run protection, and crash-safe restart patterns.
---

## Sources

- Martin Fowler, "Event Sourcing" pattern (martinfowler.com, 2005, updated 2017)
  https://martinfowler.com/eaaDev/EventSourcing.html
- Martin Fowler, "Idempotency" (microservices.io via Fowler references)
  https://martinfowler.com/articles/patterns-of-enterprise-application-architecture
- git-scm.com, "git log" and "git notes" — commit-as-state-record
  https://git-scm.com/docs/git-log
- Microsoft Learn, "Azure DevOps — Work Item Tracking and Task State Machines"
  https://learn.microsoft.com/en-us/azure/devops/boards/work-items/workflow-and-state-categories
- Sam Newman, "Building Microservices" 2nd ed. — Chapter 12: Resilience, Idempotency in Distributed Systems
- Michael Nygard, "Release It!" 2nd ed. — Chapter 4: Stability Patterns (idempotency, circuit breaker, checkpoint/restart)
- PMI/PMBOK 7th Ed. — Schedule Performance Index, Earned Value for tracking plan progress

## Key Findings

### Plan.md as the State File

- The plan.md file at the root of `docs/plans/{YYYY-MM-DD}-{topic}/` serves as the authoritative state machine for the implementation run. It lists every package as a checkbox: `- [ ] NN-{slug}` (pending) or `- [x] NN-{slug}` (complete).
- This pattern is borrowed from GitHub Issues and GitHub Projects — Markdown task lists with `- [ ]` / `- [x]` are natively rendered as checkboxes in GitHub's web UI, providing zero-overhead visual progress tracking for the platform team.
- **Invariant**: a package's checkbox MUST be updated to `[x]` in the SAME commit that implements the package fix (or in a dedicated follow-up commit immediately after verification passes). A committed fix with an unchecked box = plan-divergence, a PROCESS CRITICAL finding.

### Per-Package Completion Markers

- Each package file (`packages/NN-{slug}.md`) contains a **Status** field at the top: `Status: PENDING | IN_PROGRESS | DONE | FAILED | BLOCKED`.
- Status transitions:
  ```
  PENDING → IN_PROGRESS  (executor picks up the package)
  IN_PROGRESS → DONE     (verification command passes, checkbox ticked)
  IN_PROGRESS → FAILED   (verification command fails after 2 retries)
  IN_PROGRESS → BLOCKED  (prerequisite package FAILED or BLOCKED)
  FAILED → IN_PROGRESS   (after root cause analysis and remediation plan update)
  BLOCKED → PENDING      (after prerequisite package transitions to DONE)
  ```
- A FAILED package MUST include a **Failure Notes** section appended to the package file with: the verification command output (first 50 lines), the suspected root cause, and whether a re-attempt is warranted or escalation is required.
- A BLOCKED package MUST list the blocking package(s) by ID so the executor can detect the unblock event automatically (when the prerequisite's status transitions to DONE).

### Append-Only Verification Log

- `verification-log.md` at the plan root is an **append-only** event log. Every verification attempt is appended as an entry; entries are NEVER edited or deleted.
- Log entry format:
  ```markdown
  ## {YYYY-MM-DDThh:mm}Z — Package {NN-slug}
  - Status: PASS | FAIL
  - Command: `{verification command}`
  - Exit code: {0 | N}
  - Output: (first 20 lines)
  - Commit: {git hash} (if PASS)
  ```
- The append-only property is equivalent to Event Sourcing's immutable event log. The current state of the plan is derived by replaying the log from the beginning — every PASS entry corresponds to a completed package.
- This property guarantees crash-safe restart: if an executor session crashes mid-package, the verification log shows which packages were fully verified (PASS entry present) vs. partially attempted (no final entry or a FAIL entry). On restart, the executor resumes from the first package without a PASS entry.

### Idempotent Re-Run Protection

- A package with Status: DONE and a PASS entry in the verification log MUST be skipped on re-run. Attempting to re-implement a DONE package is idempotency-violating and risks overwriting a correct fix with a regressed one.
- Idempotency check protocol on restart:
  1. Read plan.md — identify all `[x]` packages.
  2. Cross-reference against verification-log.md — verify each `[x]` package has a PASS entry. A `[x]` without a PASS entry = PROCESS CRITICAL (plan diverged from reality — likely a manual checkbox update without verification).
  3. Begin execution from the first `[ ]` package in topological order.
- The git commit hash in the verification log entry is the ground truth: even if a checkbox is marked incorrectly, the git hash can be verified against the repository to confirm the fix was actually committed.

### Crash-Safe Restart Pattern

- Michael Nygard's checkpoint/restart pattern: at each stable checkpoint (a PASS verification), the full system state is recorded (git hash + checkbox + log entry). Restart means re-reading the checkpoints and resuming from the last stable one.
- For this platform: the "checkpoint" is the TRIPLE of (git commit hash, `[x]` in plan.md, PASS in verification-log.md). All three must agree. If any one is missing or contradictory, the package is considered not-complete and must be re-verified.
- This triple-record design means the plan state is resilient to: (a) executor crash after git commit but before checkbox update, (b) checkbox update without git commit, (c) verification log corruption (the git hash is independently verifiable via `git show {hash}`).

### Plan Version and State Divergence Detection

- The plan is generated at a point in time from review reports that existed at that moment. If the underlying codebase changes significantly (e.g., another branch merges new commits) between plan generation and execution, the plan may become stale.
- Stale plan indicator: a package's Affected Files list includes a file path that no longer exists (renamed or deleted by a subsequent commit).
- The plan must include a **Generated From** metadata block at the top of plan.md:
  ```
  Generated: {YYYY-MM-DD}
  Base Commit: {git hash at generation time}
  Source Reports: {list of source report paths}
  ```
- On execution start, verify `git rev-parse HEAD` against Base Commit. If the current HEAD diverges by more than 20 commits, flag as PLAN_STALE and require human review before proceeding.

### FAILED Package Marking and Escalation

- A package that FAILS verification after 2 retries enters FAILED status. The implementation-planner's plan must include a **Rollback Plan** section in every package file. The rollback plan specifies the exact `git revert` command to undo any partial commits from the failed attempt.
- FAILED packages whose root cause cannot be identified by the executor → escalate to context-manager (may be a systemic issue) and architectural-arbiter (may require a different approach).
- A cascade of FAILUREs (3+ packages failing in the same topological tier) is a signal that the source review reports contained incorrect findings or the affected codebase changed significantly since the review. This is a PLAN_CRITICAL event requiring human review.

## Security Concerns

- The verification log is an audit trail. Do NOT include secrets, credentials, environment variables, or JWT tokens in verification command output. Verification commands must be designed so their output is safe to log in the plan directory (which is checked into the repository).
- Plan files under `docs/plans/` must NOT contain resolved credentials, API keys, or production database connection strings — only generic commands that the executor resolves from the environment.

## Performance Concerns

- The verification log grows linearly with the number of packages × retry count. For a 50-package plan with some retries, the log may reach 500-2000 lines. This is negligible in size but should be structured so the executor can scan for the last PASS entry quickly (newest entries at the bottom; executor reads from the bottom up).

## Architectural Implications

- The plan state model is inspired by Event Sourcing (append-only log, current state derived from events) and by the platform's own use of event sourcing for aggregate state changes. The planning system is architecturally coherent with the platform's data model.
- The `.full-review/state.json` file used by the orchestrator and context-manager is a complementary state file for the review phase. The `docs/plans/{topic}/` tree is the analogous state file for the implementation phase. They do NOT overlap and MUST NOT be conflated.
- The TRIPLE record (git hash, checkbox, log entry) creates a three-way handshake that is resilient to the two most common failure modes in agentic execution: (a) tool call succeeds but response is lost (git hash is ground truth), and (b) response succeeds but tool call was not retried correctly (verification log entry is the record).

## Domain Rule Additions

1. plan.md package checkboxes are updated in the same commit as the fix (or the immediately following commit). Checkbox without a PASS log entry = PROCESS CRITICAL.
2. verification-log.md is append-only. No entries are edited or deleted. Each entry records: timestamp, package ID, status, command, exit code, first 20 lines of output, and git hash on PASS.
3. On restart, verify the TRIPLE (git hash + checkbox + PASS log entry) for all supposedly completed packages before resuming. Any discrepancy = re-verify from that package.
4. A package FAILED after 2 retries triggers the Rollback Plan section and escalates to context-manager + architectural-arbiter.
5. Plan metadata includes Base Commit hash. Divergence > 20 commits = PLAN_STALE, requires human sign-off before execution.
