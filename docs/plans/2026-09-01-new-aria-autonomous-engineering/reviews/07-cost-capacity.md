# D0 adversarial review — cost, capacity, and abuse resistance

## Verdict

`CHANGES_REQUIRED`

D0 correctly carries `ARIA-AUDIT-021` into pre-call reservation, fail-closed unknown cost,
provider limits, settlement/reconciliation, concurrency-race tests, and later live capacity gates.
It also separates the executor from the production droplet, names workspace/provider/risk quotas,
keeps high-risk disabled, uses operator-owned capacity and burn-in prerequisites, and remains
`VERIFYING`. The 88-row matrix is complete and the cost-relevant rows have substantive owners.

Six gaps remain, five of them P1. A conforming implementation can make a charged-but-unattributed
provider call twice, amplify 429/timeouts into a retry storm, exhaust durable storage with queues or
evidence, activate `PR_ONLY` before its comprehensive quotas exist, or run heavy provider brokers
in the production failure domain. The later burn-in/capacity evidence also lacks deterministic
expiry and invalidation semantics. Those are denial-of-wallet and availability boundaries, so D0
should not become implementation authority yet.

## Findings

### COST-P1-001 — `ProviderReservation` has no durable charged-unknown settlement state machine

- **Severity:** P1 — denial-of-wallet / accounting correctness.
- **Evidence:** The design names `ProviderReservation` but supplies state machines only for mission,
  job, effect, permit, and freeze
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:127-155`). The broker
  request carries only a generic budget reservation and the response returns generic `usage`;
  cost uncertainty is denied only _before_ the call
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:166-173`). S14 promises
  atomic reservation/settlement and a reconciliation note, but defines no reservation identity,
  unit, lifecycle, expiry, or post-dispatch unknown rule
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P02.md:65-75`). S17 permits retry
  and crash recovery without binding reservation settlement to the attempt/effect
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:5-15`). The 021 row asks for
  crash-before/after settlement and provider-overage tests, but its broad “terminal settlement/
  reconciliation” control does not define the oracle
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:47`).
- **Consequence:** A timeout after provider acceptance can have real subscription consumption while
  the local effect is `UNKNOWN`. The reservation may be released as unused, settled twice after a
  crash, or followed by a retry with a new reservation. Workspace/global caps can remain locally
  green after the provider has consumed two calls, so the highlighted P0 failure mode is still
  implementable despite every named card passing.
- **Smallest corrective action:** Define an authoritative reservation ledger/state machine such as
  `RESERVED -> DISPATCHED -> SETTLED | HELD_UNKNOWN | EXPIRED_UNUSED | MANUAL_RECONCILIATION`.
  Bind one immutable reservation to provider account/subscription, workspace, risk class, mission,
  job, attempt, effect UUID, request id/idempotency key, quota window, unit and conservative upper
  bound. Atomically consume it before dispatch; keep the full upper bound held after any ambiguous
  started call; settle exactly once from provider-authoritative or explicitly conservative usage;
  never release/retry an unknown charge merely because a lease or timeout expired.
- **Required checks:** Kill at reserve, dispatch, provider acceptance, response, usage write, settle,
  and release boundaries. Race cancel/lease expiry/retry/reconciliation across workers. Assert one
  provider call, one durable reservation, one settlement, no negative available balance, and a held
  upper bound until a charged-unknown call is reconciled. Test missing, malformed, delayed, lower,
  and greater-than-reserved usage.

### COST-P1-002 — Provider rate-limit and retry semantics cannot prevent a fleet-wide retry storm

- **Severity:** P1 — provider exhaustion / denial-of-wallet.
- **Evidence:** The broker contract does not normalize quota scope, remaining/reset time,
  `Retry-After`, charge/execution certainty, retryability, or usage-source confidence
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:166-173`). S17 names
  `retry` but no attempt cap, backoff, jitter, retry budget, or dead-letter/manual state
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:5-15`). S20/S21 test missing
  capability and outage, but not 429/Retry-After, dynamic subscription cooldown, partial output, or
  timeout-after-acceptance
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:41-63`). Circuit breakers arrive generically in S44 and
  loaded tests mention a provider quota shift only in S62
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:41-51`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:65-75`). By contrast, the
  GitHub protocol explicitly forbids blind retry of timeout/unknown results
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:203-207`); the
  provider protocol has no equivalent rule.
- **Consequence:** A shared subscription returning 429, transient 5xx, CLI timeout, or ambiguous
  partial result can wake many durable jobs simultaneously. Restart/replay can reset local delay,
  multiply billed/limited calls, starve other workspaces, and keep the breaker oscillating
  half-open. Per-job idempotency does not make a provider invocation idempotent.
- **Smallest corrective action:** Extend the normalized provider result/capability schema with
  provider-account and quota-bucket identity, observed limit/remaining/reset/TTL, `Retry-After`,
  terminal vs retryable class, request acceptance/charge certainty, usage source/confidence, and
  freshness. Add one durable retry scheduler with capped attempts, exponential backoff plus jitter,
  provider-account retry budgets, a single half-open probe, fairness-aware wakeup, and
  `HELD_UNKNOWN`/manual reconciliation for ambiguous calls. Reboots must preserve next-attempt time
  and retry count; retry cannot mint a new logical effect or evade the original reservation.
- **Required checks:** Fleet-level 429/5xx/timeout/cooldown tests across multiple workspaces and
  restarts; malformed/missing `Retry-After`; quota reset moving backward/forward; both providers
  degraded; half-open races; a charged timeout. Prove bounded provider-call rate, preserved
  fairness, no thundering herd after restart, and no retry while charge certainty is unknown.

### COST-P1-003 — Durable queues, artifacts, conversations, incidents, and telemetry have no aggregate bounds

- **Severity:** P1 — persistent resource exhaustion / storage denial-of-wallet.
- **Evidence:** The design persists jobs, attempts, effects, artifacts, evidence, incidents, audit,
  outbox, and immutable CAS content, but records only per-object size metadata
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:127-137`). Object
  admission checks one upload's size and leaves orphans to unspecified garbage collection
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:157-164`;
  `docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:175-182`). Cancel/retry preserves prior attempts and artifacts,
  and sanitized data may live 180 days while decisions/outcomes live three years
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:226-239`). S44 says “workspace/provider/risk limits” without naming queue rows/age,
  DB bytes, CAS/quarantine bytes, object versions, log/trace cardinality, conversation/draft size,
  evidence count, or per-principal/global dimensions
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:41-51`). The 071 control says
  critical incidents never drop under an all-critical burst, but does not reserve finite emergency
  capacity or define fail-closed producer backpressure
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:97`).
- **Consequence:** An authorized or compromised subject can submit bounded individual objects but
  unbounded aggregate work. At-least-once outbox duplication, retries, high-cardinality telemetry,
  incident floods, legal holds, and preserved historical attempts can fill Postgres/object storage,
  inodes, WAL/backups, or the telemetry backend. “Critical never drop” becomes physically
  impossible at full disk, and unrelated production services can fail before a phase gate notices.
- **Smallest corrective action:** Add explicit count/byte/rate/age quotas and high-/low-watermarks
  for every durable ingress and derived surface, scoped by subject, workspace, repository, provider,
  risk class, and global installation. Specify bounded pagination/batch sizes, quarantine/orphan TTL,
  version/multipart accounting, telemetry label allowlists/cardinality, retention-compaction
  budgets, legal-hold capacity policy, and reserved emergency incident/outbox capacity. Admission
  must reserve DB/WAL/CAS/backup/telemetry headroom transactionally and backpressure or freeze before
  exhaustion; it may aggregate noncritical telemetry but must durably account for drops.
- **Required checks:** Flood many sub-limit missions/messages/artifacts, retry histories, all-critical
  incidents, unique labels, object versions/multipart uploads, and legal-held data. Inject GC outage,
  backup lag, DB/WAL growth, disk/inode exhaustion, and concurrent workspaces. Verify deterministic
  refusal before reserve exhaustion, critical stop/page durability, bounded recovery queues,
  fairness, and continued health of unrelated production workloads.

### COST-P1-004 — `PR_ONLY` becomes live before its comprehensive quota and breaker boundary exists

- **Severity:** P1 — unsafe activation sequencing.
- **Evidence:** S43 activates `PR_ONLY`, Publisher App mission routing, and live PR creation/update
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:29-39`). Workspace/provider/
  risk concurrency, host headroom, circuit breakers, and backpressure are not implemented until
  S44, whose dependency is S43
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:41-51`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:193-202`). `OP-07` supplies measured
  capacity and SLO minima only for S47/S55/S62/S63, not S43 or S44
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:67-81`). Earlier S14 reserves
  provider budget and S18 limits a worker, but neither supplies the later global/workspace fairness,
  breaker, persistent-storage, or production-host admission boundary.
- **Consequence:** The first live PR/provider workload can run with no documented global concurrency
  cap, host-reserve threshold, shared-subscription breaker, or SRE-attested envelope. A burst or
  compromised super-admin can consume subscription/host/storage capacity during S43 and still let
  S43 meet its exact exit predicate; later S44 evidence cannot protect effects already dispatched.
- **Smallest corrective action:** Keep the fixed phase roster but make S43 install and live-test a
  dormant/single-disposable-canary `PR_ONLY` capability under explicit bootstrap ceilings. General
  PR/provider dispatch must remain unreachable until S44 has accepted current operator-owned
  quota/headroom/breaker policy. Add the appropriate capacity prerequisite to S44 and make the
  S44 seal the activation transaction; missing/stale limits must be `BLOCKED`, not defaults.
- **Required checks:** At the S43 head, attempt concurrent workspaces, repeated mission creation,
  direct publisher routing, and provider dispatch; only the explicitly bounded disposable canary
  may run. Remove/stale the capacity manifest at S44 and prove dispatch count remains zero. Race
  policy activation with queued work and prove no job observes a partially installed limit set.

### COST-P1-005 — Heavy broker/CLI placement can still share the production droplet failure domain

- **Severity:** P1 — global host availability.
- **Evidence:** The trust diagram places `broker-codex`/`broker-claude` outside the separate worker
  zone, and only the executor is explicitly on the separate VM
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:57-70`). The authority
  matrix gives the brokers subscription credentials and provider egress, while the text guarantees
  production-droplet CPU/memory/disk separation only for `executor`
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:77-93`). The deployment section permits the control plane on the production droplet
  and merely says global headroom is used; broker placement and provider child processes are not
  stated
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:249-253`). S18's production-droplet scheduling negative applies to the executor;
  S20/S21 do not require broker/CLI CPU, memory, PID, disk, or inode isolation
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:17-27`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:41-63`). This is material because the frozen audit records the shared host reaching
  7.8 GiB RAM plus OOM kills and 154/154 GiB disk exhaustion
  (`/var/aqua-saas/.worktrees/aria-full-system-audit-2026-09-01/docs/reviews/codex/2026-09-01-aria-full-system-audit.md:96-105`).
- **Consequence:** A compliant deployment can keep the nominal executor isolated while running the
  actual heavy Codex/Claude CLI process, child tool orchestration, provider buffers, or artifact
  staging beside production Postgres/Redis/services. One prompt, concurrent broker sessions, or
  runaway CLI can reproduce the documented OOM/ENOSPC outage; “global headroom” without placement
  and reservation semantics is not a failure-domain boundary.
- **Smallest corrective action:** Normatively place each provider CLI process and all of its child
  tools/artifact staging on the dedicated worker VM or on a separate broker worker failure domain,
  never the production droplet. If a small credential broker remains on the droplet, make it a
  bounded RPC/token mediator that cannot execute the CLI or buffer artifacts. Define cgroup/VM CPU,
  memory, PID, disk, inode, I/O and network limits for every role; reserve production headroom
  against existing services and all ARIA roles, not just current ARIA usage.
- **Required checks:** Assert scheduler placement and process ancestry for brokers/CLIs/children;
  saturate provider calls, tool output, artifact staging, and concurrent sessions while production
  services run their peak profile. Inject memory/disk/PID/I/O exhaustion and prove ARIA is
  throttled/frozen first, no production process is OOM-killed, and reserved headroom never crosses
  its floor.

### COST-P2-006 — Burn-in and capacity evidence has no deterministic freshness or invalidation contract

- **Severity:** P2 — promotion-evidence freshness.
- **Evidence:** Generic evidence carries “freshness,” but no required `validUntil`, invalidation key,
  or maximum age is defined
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:184-189`). Provider
  limits, worker capacity, and burn-in sample minima are explicitly unknown until measured/operator
  approved
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:271-278`). S47, S55, and S63 require operator-approved/current minimum
  samples/windows, and S62 records an exact version/workload, but none binds the evidence to the
  provider subscription/account and quota epoch, host topology and competing-load profile, policy/
  breaker/reservation configuration digest, or automatic expiry after a material change
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:77-87`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:77-87`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:65-87`).
- **Consequence:** A statistically small or biased “minimum,” or capacity evidence collected before
  a provider quota reduction, host co-tenant change, image/config change, outage, or incident can
  remain “current” and authorize low/medium-risk promotion. Exact implementation SHA alone does not
  establish current external capacity.
- **Smallest corrective action:** Make `OP-07` an operator-owned, versioned acceptance manifest with
  denominator/population, risk/provider strata, minimum successes and failure/incident bounds,
  observation duration, excluded-window rules, confidence method where applicable, SLO objectives,
  workload/peak-shape digest, safety factor/headroom floor, maximum evidence age, and invalidation
  triggers. Bind live evidence to provider account/quota epoch, runtime images/config/policy,
  topology, host competing-load profile, and exact deployment SHA. Any material change or stop-rule
  event returns the gate to `VERIFYING`/`BLOCKED` until fresh evidence is admitted.
- **Required checks:** Attempt promotion with zero/small/cherry-picked samples, missing strata,
  outage-window exclusion, stale timestamps, changed provider limit/account, changed host topology,
  scaled queue, changed breaker/quota config, and a post-burn-in incident. Every mutation must
  invalidate the dossier; only a fresh representative rerun may restore eligibility.

## Verified controls and review checks

- `FINDING-COVERAGE.md` contains exactly 88 unique rows from 001 through 088; all 88 severity/title
  pairs match the frozen report. The highlighted 021 mapping correctly covers S14/S23/S44/S62/S68,
  and cost/capacity-relevant rows 043, 062, 064, 070, 071, 083, and 086 have substantive tests and
  closure rules. Owner/card expansion found no cost/capacity mismatch (the two global mismatches,
  015/S68 and 023/S67, are outside this specialist report).
- Strong controls retained: atomic pre-call reservation intent, fail-closed pre-call unknown cost,
  provider capability/status freshness tests, workspace/provider/risk quota intent, fairness,
  circuit breaker/backpressure, disk/memory fault tests, SLO/cost measurements, anti-cherry-pick
  burn-in negatives, and explicit operator prerequisites. Findings above narrow what must become
  executable; they do not discard these controls.
- The packaged 2,203-line diff is byte-identical to `git diff -U10` for
  `eeb401131260fe45f3f60be55fa25d023a082d18..c6065d6dac97306f147de67ef58a96e3a67524ac`.
  `git diff --check` passed. The evidence JSON and all four JSONL events parse. Protected legacy
  ARIA/workflow path diff is empty. D0 remains `VERIFYING`, independent admission is pending, and no
  live/merge/replacement authority is claimed.
- Read root `CLAUDE.md`, the adversarial brief, complete task contract and implementer report, all
  changed authority artifacts, all nine phase cards, all 88 mappings, the full packaged diff, and
  the frozen cost/capacity audit evidence. No tracked file, commit, branch, remote, PR, legacy ARIA
  artifact, or runtime state was changed; only this requested scratch report was created.
