---
Topic: CI-gated package verification — per-package verification commands, test-runner and security-reviewer dispatch, failed verification rollback, and BLOCKED flag semantics.
---

## Sources

- Google Engineering Practices, "The Standard of Code Review — Tests"
  https://google.github.io/eng-practices/review/reviewer/looking-for.html
- Martin Fowler, "Continuous Integration" — verification as the CI contract
  https://martinfowler.com/articles/continuousIntegration.html
- DORA, "State of DevOps 2023" — Change Failure Rate, MTTR
  https://dora.dev/research/
- Microsoft Learn, "Azure DevOps — Branch policies and required build validation"
  https://learn.microsoft.com/en-us/azure/devops/repos/git/branch-policies
- OWASP DevSecOps Guideline — integrating security gates into CI pipelines
  https://owasp.org/www-project-devsecops-guideline/
- Jez Humble and David Farley, "Continuous Delivery" — Chapter 5: Anatomy of the Deployment Pipeline
- GitHub Actions documentation — "Required status checks"
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

## Key Findings

### Verification Command Design

- Every work package must specify a **Verification Command** — a single shell command (or a small ordered sequence) that produces a deterministic PASS/FAIL signal.
- The verification command must be:
  1. **Scoped**: tests only the files and modules relevant to the package. Running the entire test suite for a one-file fix is wasteful and makes the signal noisy.
  2. **Deterministic**: the same command run twice on the same code produces the same result. Non-deterministic tests (flaky tests, random seeds without fixed seed) are FORBIDDEN in package verification commands.
  3. **Self-contained**: no manual setup steps, no test data loading, no environment variable injection that is not documented in the package file.
  4. **Build-first**: the verification command always starts with compilation (`tsc --noEmit` or `npm run build`) before tests. A test that passes on broken TypeScript is misleading.

- Canonical verification command pattern for NestJS packages:
  ```bash
  npx tsc --noEmit -p apps/{service}/tsconfig.json && \
  npx jest --testPathPattern="apps/{service}/src/{domain}" --coverage=false
  ```
- For migration packages:
  ```bash
  npm run migration:validate -- --schema=tenant_test_{hash}
  ```
- For GraphQL subgraph packages:
  ```bash
  npx rover subgraph check {graph-id}@current --schema apps/{service}/src/schema.graphql --name {subgraph-name}
  ```

### Test-Runner Dispatch

- The `test-runner` agent is a quality gate that runs all tests and reports results. The implementation-planner does NOT invoke test-runner directly — it specifies the verification command that the EXECUTOR uses.
- However, when a package's Verification Command touches ALL tests (not scoped), the planner should annotate: `Dispatch: test-runner` — indicating that the executor should invoke the test-runner agent with the full test scope for that package.
- Scenarios requiring full test-runner dispatch (not scoped command):
  1. Package touches `libs/backend-common/` (any shared lib used by all services)
  2. Package touches `libs/event-contracts/` (any event type change)
  3. Package touches `apps/gateway-api/` (federation composition)
  4. Package is the FINAL package in the plan (full regression test after all fixes)

### Security-Reviewer Dispatch on CRITICAL Package Diffs

- Packages tagged `security-sensitive` (auth-service, gateway-api, guards, middleware, HMAC, JWT, RBAC) MUST have `Dispatch: security-reviewer` in their package file.
- The security-reviewer dispatch is in ADDITION TO the verification command, not instead of it. Both must pass before the package's checkbox is marked `[x]`.
- The security-reviewer dispatch happens on the DIFF of the package (i.e., after the commit is on the branch but BEFORE merging to main). The executor runs: `git diff main...{branch}` and passes this diff to the security-reviewer agent.
- If security-reviewer returns ANY CRITICAL finding on the diff → the package transitions to BLOCKED and MUST NOT be merged. The finding is appended to the package file's Failure Notes and escalated to the human reviewer.
- If security-reviewer returns HIGH findings → the package is PASS WITH CONDITIONS; the findings are appended to the package file and must be addressed in a follow-up package.

### Rollback on Failure

- When a package verification command fails (non-zero exit), the rollback procedure is:
  1. `git revert {commit_hash} --no-edit` — produces a revert commit. The --no-edit flag prevents interactive prompts.
  2. If the package implementation was spread across multiple commits (which violates the one-package-one-commit rule but may happen during debugging): `git revert {hash1} {hash2}` — revert in reverse order.
  3. Append FAIL entry to verification-log.md.
  4. Update package Status to FAILED.
  5. Do NOT update plan.md checkbox.
  6. Escalate per the FAILED escalation protocol.
- The rollback plan in each package file must pre-specify the exact revert command. The executor should not have to derive it during a failure event (cognitive load is highest during failures).

### BLOCKED Flag Semantics

- A package becomes BLOCKED when:
  1. A prerequisite package is in FAILED or BLOCKED status — the current package cannot proceed until the prerequisite is resolved.
  2. The security-reviewer returned a CRITICAL finding on the package diff — the package is blocked pending human security review.
  3. A cycle is detected in the dependency graph that involves this package — it is blocked pending architectural-arbiter resolution.
- BLOCKED packages do NOT count against the FAILED escalation threshold (3+ failures → PLAN_CRITICAL). BLOCKED is a distinct, non-failure state.
- When a package transitions from BLOCKED to PENDING (because its blocker resolved), append a UNBLOCKED entry to the verification-log.md with the reason and the datetime.

### CI Integration (GitHub Actions)

- The platform uses GitHub Actions (`.github/workflows/`). For each short-lived fix branch created for a package, GitHub Actions CI must pass before the branch is eligible to merge.
- The aqua-saas platform's existing CI workflows (`infra-expert` scope) provide the base. The verification command in each package file should map to an existing CI job name where possible, rather than inventing ad hoc commands.
- Branch protection on `main` should require:
  1. CI passes (build + tests)
  2. At least one approval (human or gated agent review)
- For CRITICAL packages: the security-reviewer approval IS the required review. No merge without security-reviewer PASS.

### Change Failure Rate and Verification Discipline

- DORA 2023: elite performers have a Change Failure Rate (CFR) under 5%. The primary driver of low CFR is comprehensive pre-merge verification.
- For this platform's 12 services, a failed deployment that reaches production costs more than a failed verification in CI. Every minute spent on a precise verification command saves 10 minutes of production debugging.
- The package verification command is the single most important field in the package file for platform reliability. Imprecise verification commands (running the wrong tests, not testing the modified code) directly cause escaped defects.

## Security Concerns

- OWASP DevSecOps Guideline: security gates must be in the CI pipeline, not post-merge. The security-reviewer dispatch on CRITICAL package diffs is this platform's implementation of the "shift-left security" principle.
- The verification command must NOT contain secrets. Any environment variable that holds a credential must be referenced as `$ENV_VAR_NAME`, not hardcoded. The platform's CLAUDE.md already enforces this; the planner must enforce it in the verification command syntax it generates.
- Failed verification logs must be sanitized before being appended to verification-log.md. Test output occasionally contains credential strings from test fixtures — the first 20 lines rule (not full output) limits exposure.

## Performance Concerns

- Scoped verification commands (targeting one service, one domain) run in 30-90 seconds on this platform's test suite. Full test-runner runs take 5-15 minutes. The difference is why scoping matters for rapid iteration.
- Parallel package verification (multiple branches in CI simultaneously) is possible for parallelizable packages. GitHub Actions matrix jobs can run verification for independent packages concurrently.

## Architectural Implications

- The platform's NestJS CQRS + GraphQL Federation architecture means some verification commands require an integration test (a command handler publishing an event to NATS, a GraphQL query traversing two subgraphs). Unit tests alone are insufficient for CQRS packages — the package's test plan must include at least one integration test that verifies the end-to-end command → event → projection chain.
- For TypeORM entity packages: verification must include a migration dry-run against the test schema. Schema changes that pass unit tests but fail migration = FAILED verification.
- The existing test-runner agent enforces that ALL test files pass. The implementation-planner's scoped verification commands are the per-package gate; the test-runner is the final integration gate before the plan is marked complete.

## Domain Rule Additions

1. Every package file includes a Verification Command: `tsc --noEmit` + scoped jest run (or service-specific variant). The command is deterministic, scoped to the changed domain, and produces a pass/fail exit code.
2. Packages touching shared libs (`libs/`) or the final package in any plan → annotate `Dispatch: test-runner` for full regression coverage.
3. Packages tagged `security-sensitive` → annotate `Dispatch: security-reviewer` on the branch diff. Both the verification command AND the security-reviewer must PASS before the checkbox is marked.
4. Verification failure → immediate rollback via the pre-specified `git revert` command in the package's Rollback Plan section. Append FAIL to verification-log.md. Mark package FAILED.
5. BLOCKED status is distinct from FAILED: blocked packages are waiting on a prerequisite or a human decision. They do not trigger the 3+ FAILED escalation threshold.
