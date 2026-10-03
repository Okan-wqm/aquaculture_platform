# ARIA program review — findings from five adversarial reviews (2026-10-02)

Context: the operator asked for a plan that makes ARIA's memory permanent, immutable and
repo-shaped, and makes ARIA know the repository at field level across layers, so that ARIA itself
solves, records and learns. Six expert designs were merged into one program plan and then attacked
by five independent adversarial reviewers (security, accounting completeness, architecture and
sequencing, operations and cost, goal fit and learning validity). The plan was revised on the result
(`/root/.claude/plans/crystalline-purring-hare.md`, rev2, approved by the operator the same day).

This file records the real defects the reviewers measured outside the plan itself. Each one was
re-checked against `origin/main` 8083cb15e before it was registered. Gate-parity candidates (admin
panel platform capabilities, frontend module gates without a backend twin, an ungrantable
`edge:manage-io-config` capability) go to ARIA's label queue instead, because they are not yet
established as defects.

Owner: claude (records), okan (decisions and operator settings).

## ARIA-HIGH-270

The MCP front door admits any write once an operator_approval_ref of six or more characters is
supplied: \_write_gate checks only the length, so a runtime signal or feedback write needs no
operator act at all.

Evidence:

- `aria-kernel/aria_kernel/mcp_server.py:163` (\_write_gate: allow_writes flag, then len(ref) < 6 is
  the only check)
- `aria-kernel/aria_kernel/mcp_server.py:169` (the unverified ref is recorded as the governance
  approval)

Rule: A write through ARIA's front door is admitted only on a verified operator act (an ssh
signature checked against the allowed-signers anchor on main), never on an unverified string.

Program plan rev2 step K5 (S1) makes the gate signature-verified before the executor is enabled.
Owner okan, deadline 2026-10-23.

## ARIA-HIGH-272

The public aria/state branch publishes ARIA's raw LLM prompts and responses (tools/agent-invocations
prompts 16 MiB, outputs 33 MiB), and a public Actions artifact carries the whole tools tree.

Evidence:

- `aria-kernel/aria_kernel/state_manifest.py:284` (agent_invocation_prompts is a published state
  surface)
- `.github/workflows/aria-auto-cycle.yml:1057` (aria-state-cache artifact upload)
- `origin/aria/state` 05c5d3160:tools/agent-invocations/prompts.jsonl (16.2 MiB)
- `origin/aria/state` 05c5d3160:tools/agent-invocations/outputs/ (33.3 MiB)
- `Actions` artifact aria-state-cache-36930983093 (121 MB, not expired) on a public repository

Rule: What ARIA records stays readable only by those the operator chooses; free-text model input and
output is not published to a public branch or artifact.

Operator decision 2026-10-02: everything stays on the branch and the repository becomes private; the
operator sets the date. Until then no runtime, tenant or PII body and no open security-finding
detail is added to public surfaces (program plan rev2 K-1). Owner okan, deadline 2026-12-31.

## ARIA-MEDIUM-273

Operator signatures cannot distinguish the operator from a root agent session on the host: the
ed25519 operator key is root 0600 without an interactive passphrase and is also the commit-signing
key.

Evidence:

- `.github/CODEOWNERS:52` (the operator signers manifest directory)
- `/root/.ssh/aria-operator-signing` (root:root 0600; fingerprint equals
  .github/manifests/aria-operator-signers)
- `local` git config of /var/aqua-saas and /root/aria-8b sets commit.gpgsign=true with
  user.signingkey pointing at the same key
- `ARIA's` runner runs as gharunner (uid 1000, no sudo, not in the docker group, /root mode 700, App
  identity, no PAT in the runner .env), so ARIA itself cannot sign or approve

Rule: An act that calibration treats as human ground truth is provably the operator's, or it is
recorded as delegated.

Accepted risk by operator decision 2026-10-02 (the key stays on the server). Label seals stay
operator-run and interactive by procedure; revisit when the repository goes private. Owner okan,
deadline 2026-12-31.

## INFRA-MEDIUM-197

main requires no pull-request review at all, so on GitHub the trust anchors ARIA verifies against
(`.github/manifests/aria-operator-signers`, `docs/aria/policy/operators.json`) are guarded only by
the four required status checks. A review rule cannot separate the operator from agents that act
under the operator's identity, and readiness forbids the bypass actor such a rule would need.

Evidence:

- `.github/CODEOWNERS:52`: the manifests directory is code-owned by the operator, but no review rule
  enforces it.
- `aria-kernel/aria_kernel/enterprise_readiness.py:625`: any ruleset bypass actor on main fails
  readiness (ARIA-HIGH-207).
- `aria-kernel/aria_kernel/implementation_safety.py:73`: READONLY_PATHS covers `.github/` but not
  `docs/aria/policy/` (ARIA-LOW-267).
- Measured 2026-10-02: `branches/main/protection` returns `required_pull_request_reviews: null`,
  `enforce_admins: true`, strict status checks on sens-enterprise-summary, merge-gate,
  aria-merge-authority and build-status.

The adversarial reviewer proposed code-owner review, last-push approval and stale dismissal. That
would either lock every operator-authored pull request (`enforce_admins` on, one human code owner
who cannot approve their own pull request) or need an admin bypass actor that readiness forbids. The
actor to keep out is ARIA's runner (`gharunner`, App identity), so the guard belongs in the kernel
(program plan rev2 K5/S1) and in `aria-merge-authority`. The `aria/state-cold` branch was added to
the `aria-state-protection` ruleset on 2026-10-02 (no deletion, no non-fast-forward, no bypass).

Rule: An operator trust anchor changes only through a path ARIA's own identity cannot complete: the
kernel refuses to write it, and the merge-authority check refuses an ARIA-authored pull request that
touches it.

Owner okan, deadline 2026-10-23.

## ARIA-HIGH-274

Aria/state will exceed the 1,280 MiB snapshot input budget around 2026-10-15: per-cycle
run-artifacts/hot (196 MiB) and discovery (176 MiB) are never evicted, and retention apply only
copies into .archive.

Evidence:

- `origin/aria/state` 05c5d3160: 554.8 MiB total, +55-69 MiB/day (358.7 MiB on 09-29)
- `aria-kernel/aria_kernel/runtime_artifacts.py:1098` (retention_apply copies candidates under
  .archive and records an event; eviction is left to an unimplemented R3)
- `aria-kernel/aria_kernel/state_snapshot.py:84` (snapshot budgets)

Rule: ARIA's state stays inside its own budgets by construction: old cycle evidence moves to an
append-only, verifiable cold store automatically, never by deletion and never by raising a cap.

Program plan rev2 Faz 0a-2; design in progress (cold content-addressed store, pointer rows in the
hot tree). Owner okan, deadline 2026-10-12.

## ARIA-HIGH-275

Tools/agent-invocations/requests.jsonl grows about 2.2 MiB a day, is not compactable, and reaches
the 64 MiB per-surface cap in three to seven weeks, before the planned memory segments exist.

Evidence:

- `origin/aria/state:` requests.jsonl 4.3 MiB (09-15), 10.9 MiB (09-25), 17.64 MiB (10-02)
- `aria-kernel/aria_kernel/state_compact.py:1` (only runs, raw-findings, beliefs and learning-events
  are compactable)
- `aria-kernel/aria_kernel/state_snapshot.py:84` (64 MiB per-surface cap)

Rule: A ledger ARIA must keep whole rolls over into sealed segments before any cap can refuse a
publish.

Program plan rev2 K3 (IR) lands monthly rollover before the executor is enabled. Owner okan,
deadline 2026-10-23.

## OBS-HIGH-009

Error capture never reaches admin.error_groups in production: every ServiceErrorCaptured publish
fails with 'subject tenant mismatch: subject=system, payload='.

Evidence:

- `libs/backend-common/src/observability/error-capture.interceptor.ts:253` (tenantOf returns '' for
  a tenant-less failure)
- `platform/libs/event-bus/src/subjects/tenant-event-subject.ts:111` (subject assertion compares the
  derived 'system' subject with the empty payload tenant)
- `production` 2026-10-02: admin.error_groups has 0 rows; 39 'Failed to publish event
  ServiceErrorCaptured' lines in the admin-api and farm logs

Rule: A platform-level fact has one tenant sentinel that the envelope, the subject builder and the
subject assertion all agree on.

The fix is a BaseEvent envelope decision (data-expert) across every tenant-less event type, not a
change to one interceptor. Owner okan, deadline 2026-10-23.

## OBS-MEDIUM-010

Event-bus delivery metrics are never scraped: event_bus_handler_outcome_total and
event_bus_dead_letter_total live on prom-client's global registry, which /metrics does not serve.

Evidence:

- `platform/libs/event-bus/src/nats/event-bus-delivery-metrics.ts:28` (counters registered on
  prom-client's global registry)
- `libs/backend-common/src/metrics/metrics.service.ts:136` (only registries passed to
  registerContributor are served; the global registry never is)
- `Prometheus` 2026-10-02: 0 series for event*bus*\*, while nats_consumer_num_redelivered sums to
  8,879

Rule: Every metric a library defines is reachable from the scrape endpoint of the service that loads
it.

Owner okan, deadline 2026-11-13.

## DEPLOY-MEDIUM-026

No deploy sets RELEASE_VERSION, so error groups never record the release they appeared in, and the
farm service runs an image tagged farmsetup-fix-13 instead of a commit SHA.

Evidence:

- `libs/backend-common/src/bootstrap/create-service-app.ts:874` (RELEASE_VERSION is read)
- `apps/admin-api-service/src/system-management/services/error-tracking.service.ts:227`
  (affectedReleases depends on it)
- `docker` ps on the droplet 2026-10-02: farm-service image tag farmsetup-fix-13

Rule: Every running container is traceable to the commit it was built from, and every runtime fact
names that release.

Owner okan, deadline 2026-11-13.

## OBS-MEDIUM-011

GraphQL errors and request-validation rejections are invisible per operation: the gateway has no
error plugin, production masks errors, and whitelist rejections are logged without route or DTO.

Evidence:

- `apps/gateway-api/src/app.module.ts:323` (production formatError masks; only operation-limit and
  complexity plugins at :333)
- `libs/backend-common/src/bootstrap/create-service-app.ts:423` (flattenValidationErrors: field
  paths and constraints only)
- `libs/backend-common/src/logging/structured-logger.service.ts:221` (log line carries correlationId
  and tenantId, not method or route)
- `production` logs 2026-10-02: farm 45 'property status should not exist' style rejections, hr 12,
  auth 1

Rule: A rejected client request is countable by operation or route and by DTO field, without
recording any value.

Owner okan, deadline 2026-11-13.

## SEC-MEDIUM-172

Shared.access_logs keeps full request paths with query strings and, outside the hash-gated regions,
raw client IPs (2.48M rows since 2026-07-12); nginx writes the combined format with IPs and query
strings.

Evidence:

- `libs/backend-common/src/middleware/access-log.middleware.ts:120` (IP hashed only when
  shouldHashIp is true for the user's region)
- `libs/backend-common/src/middleware/access-log.middleware.ts:126` (path from req.originalUrl,
  query string included)
- `infrastructure/nginx/droplet.conf:56` (default combined log format)

Rule: Access records store what operations need (route template, status, duration) and mask personal
data and query values by default.

Owner okan, deadline 2026-11-13.

## INFRA-LOW-196

Prometheus runs with 15-day retention and without the 127.0.0.1:9090 binding its compose file
declares.

Evidence:

- `docker-compose.monitoring.yml:55` (--storage.tsdb.retention.time=15d)
- `docker-compose.monitoring.yml:65` (127.0.0.1:9090 declared; the running container has no port
  binding)

Rule: The running monitoring stack matches its declared configuration, and retention covers the
longest comparison window any consumer needs.

Owner okan, deadline 2026-11-13.

## FE-MEDIUM-308

The GraphQL codegen workflow never sees operations outside src/graphql and diffs only aquamobil and
shared-ui output, so drift in module hooks (farm hooks/use\*.ts) is never regenerated or checked.

Evidence:

- `.github/workflows/graphql-codegen-validate.yml:36` (path triggers)
- `.github/workflows/graphql-codegen-validate.yml:124` (diff step covers aquamobil and shared-ui
  only)
- `codegen.ts:54` (operation documents generated for aquamobil only)

Rule: Every GraphQL operation in the web tree is typed from the supergraph, and a change to any of
them re-runs codegen.

Owner okan, deadline 2026-11-13.

## HR-MEDIUM-011

The leave list's status filter sends lowercase literals cast to LeaveRequestStatus, while the
GraphQL enum's wire keys are uppercase, and it omits draft and withdrawn, so filtering by status
fails.

Evidence:

- `web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:390` (options
  'pending','approved','rejected','cancelled')
- `web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398` (e.target.value as LeaveRequestStatus)
- `web/modules/hr-module/src/graphql/leave.operations.ts:58` ($status: LeaveRequestStatus)
- `apps/hr-service/src/leave/entities/leave-request.entity.ts:18` (enum values) and :32
  (registerEnumType wire keys)

Rule: A value sent to an enum-typed GraphQL variable comes from the generated enum, never from a
string literal behind a cast.

Kept as ARIA's development case for the enum-literal detector (program plan rev2 Faz 1): ARIA's
second signed request fixes the class and leaves a pin. Owner okan, deadline 2026-11-13.

## ARIA-MEDIUM-276

The label queue is not blind and records no sampling design: each item shows the AI judges'
verdicts, quotas split evenly across strata, no inclusion probability is kept, and verdicts are
binary.

Evidence:

- `aria-kernel/aria_kernel/label_queue.py:110` (judge_verdicts embedded in each queued item)
- `aria-kernel/aria_kernel/label_queue.py:91` (even split across strata)
- `aria-kernel/aria_kernel/feedback_store.py:20` (binary verdict vocabulary)
- `origin/aria/state:` operator-feedback 175 rows, 0 from a human

Rule: An operator label used as ground truth is collected blind, with its inclusion probability
recorded, so precision estimates are unbiased.

Owner okan, deadline 2026-11-13.

## ARIA-MEDIUM-271

Runtime signals are lost or merged: the bridge overwrites one JSON file per signal on resolve, every
runtime pressure gets the same id pressure:runtime_signal:unknown, and the hourly watchdog ingests
into a throwaway checkout.

Evidence:

- `aria-kernel/aria_kernel/runtime_signal_bridge.py:43` (id from source, service, summary and code
  refs only)
- `aria-kernel/aria_kernel/runtime_signal_bridge.py:150` (resolve rewrites the signal file)
- `aria-kernel/aria_kernel/pressure.py:1002` (pressure id from source plus discriminator, which
  runtime signals never set)
- `.github/workflows/dataflow-integrity-watchdog.yml:121` (runtime signal ingest into the job's own
  aria-tools checkout, never the state store)

Rule: A runtime observation is an append-only event bound to the node it concerns; resolving it adds
a closing event and never rewrites the observation.

Owner okan, deadline 2026-11-13.

## PROC-LOW-038

The registry single-writer runbook's Flip 2 cannot be applied: merge queue rulesets are not
available on a user-owned repository, and the runbook's merge_method 'merge' contradicts the
kernel's squash requirement.

Evidence:

- `docs/runbooks/registry-single-writer.md:54` (Flip 2: merge queue ruleset)
- `docs/runbooks/registry-single-writer.md:80` (merge_method merge)
- `aria-kernel/aria_kernel/preflight.py:156` (SQUASH required)
- `gh` api repos/Okan-wqm/aquaculture_platform: owner.type=User

Rule: A runbook step is executable on the repository as it is, and agrees with the kernel's own
merge contract.

Owner okan, deadline 2026-11-13.

## PROC-HIGH-039

Every merged fix PR turns main's test job red until a separate reconcile PR lands: the closure-drift
spec checks origin/main, and since 2026-08-31 a deploy needs the same run's test to be green, so
only reconcile merges are deployable.

Evidence:

- `tests/invariants/finding-registry-closure-drift.spec.ts:58` (resolveBaseRef reads origin/main)
- `tests/invariants/finding-registry-closure-drift.spec.ts:98` (OPEN finding with a Closes: trailer
  on main fails)
- `.github/workflows/finding-closure-reconcile.yml` (header: the moment a PR merges, main violates
  the assertion)
- `.github/workflows/ci-affected.yml:1222` (deploy requires the run's test job)
- `12` of the 13 test-failing push runs on main since 2026-09-21 fail only this spec

Rule: Every commit on main satisfies the registry closure rule by construction: the fix PR carries
its own closure, so no merge leaves main red.

Program plan rev2 F-P2 (delta registry: the PR carries its transition row, folded at read) is the
structural fix. Owner okan, deadline 2026-10-30.

## SUPPLY-MEDIUM-015

The npm security audit runs on a PR only when package files change and stops at the first failing
scope, so new advisories turn main red with no code change and three of six scopes go unchecked.

Evidence:

- `.github/workflows/ci-affected.yml:1446` (if: dependency_audit_required)
- `scripts/ci/select-deployment-scope.ts:343` (true only when the range touches package or lock
  files)
- `.github/workflows/ci-affected.yml:1552` (bash -e loop exits on the first failing scope)

Rule: Advisory exposure is checked on a schedule and on every PR across all scopes, and the gate
reports every failing scope before it exits.

Owner okan, deadline 2026-11-13.

## INFRA-MEDIUM-198

The self-hosted runner works at its memory ceiling: the runner cgroup peaked at 2.41 GB against
MemoryHigh 2.3G with 11,383 memory.high events.

Evidence:

- `scripts/aria/runner-habitat/systemd/actions-runner.limits.conf:41` (MemoryHigh=2300M)
- `systemd` actions.runner.Okan-wqm-aquaculture_platform.suderra-droplet-claude.service:
  MemoryHigh=2.3G, MemoryMax=3G
- `runner` cgroup memory.peak 2,413,465,600 bytes; memory.events high 11383 (2026-10-02)

Rule: Each lane on the shared runner has a measured memory budget below the cgroup ceiling; heavy
builds run on hosted runners.

Owner okan, deadline 2026-11-13.

## CONTRACT-MEDIUM-006

The dead-contract scan sees only `export const UPPER = ...` operation definitions and keys them by
constant name, so 81 operation names defined in more than one file collapse into one.

Evidence:

- `tests/invariants/lib/dead-contract-scan.ts:32` (DEF_RE matches export const UPPER_SNAKE only)
- `tests/invariants/lib/dead-contract-scan.ts:76` (map keyed by constant name)
- `measured` 2026-10-02: 583 definitions found against 1,051 lexical named operations

Rule: A contract scan counts every operation in its population and keys each one by its module and
document, not by name alone.

Owner okan, deadline 2026-11-13.

## ARIA-MEDIUM-277

Self-hosted lanes starve each other: the hourly watchdog fired only 3-7 times a day, and the shared
concurrency group keeps one pending slot, so a new job cancels a pending cycle.

Evidence:

- `.github/workflows/dataflow-integrity-watchdog.yml:13` (hourly cron 40 \* \* \* \*)
- `gh` run history 2026-09-19..10-02: dataflow-integrity-watchdog runs per day
  7,6,5,6,6,5,5,6,6,3,5,4,4,3; one job waited 11,853 s behind a cycle (09-29)
- `.github/workflows/aria-auto-cycle.yml:136` (the concurrency group's single pending slot cancels
  queued runs; documented)

Rule: A scheduled lane either runs at its declared cadence or reports the gap; no lane can silently
cancel another lane's pending run.

Owner okan, deadline 2026-11-13.
