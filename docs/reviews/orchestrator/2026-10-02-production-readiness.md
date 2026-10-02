# Production readiness — orchestrator synthesis (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Author | `orchestrator` (synthesis of 12 independent specialist reports) |
| Question | What blocks this repository from going to production? |
| Verdict | **NOT READY** |

All twelve specialists independently returned NOT READY. The code base is mature in its
architecture and gates, but the path to production is not usable, recovery is not possible, the
operator would not be told when something breaks, and several core flows lose or fabricate data.
This synthesis ranks the cross-cutting blockers; the per-domain evidence is in the twelve linked
reports.

## Blockers by theme

### There is no usable path to production

- The production deploy workflow is disabled (last run 2026-07-08) and the deployed/production tag
  is 421 commits behind main; a dispatch would need no green CI. (DEPLOY-HIGH-028,
  DEPLOY-HIGH-029)
- main is red: the npm audit exceptions gate fails on every push, and the Rust advisory ignore
  lapsed on 2026-10-01. CI - Full has been red for four weeks. (SUPPLY-HIGH-022, SUPPLY-HIGH-023,
  PROC-HIGH-039)
- Production SSH cannot be verified: the WAL freshness lane fails on a host-key fingerprint
  mismatch whose cause is unknown, and the development lane deploys every main push with
  production-class secrets. (INFRA-HIGH-202, INFRA-HIGH-203, plus the open INFRA-CRITICAL cluster)
- No deployed-stack end-to-end run has passed since 2026-04-04. (PROC-HIGH-040)

### Nothing can be recovered

- Both WAL archiving and logical backup are declared not-activated; no restore drill exists;
  MinIO, Redis and JetStream are in no backup. (INFRA-CRITICAL-198)

### Nobody would be told when something breaks, including a life-safety event

- Alertmanager has placeholder receivers, no egress and no dead-man. (INFRA-CRITICAL-199)
- No notification channel delivers in production, and mock ids are logged as SENT.
  (ALERT-CRITICAL-019)
- Nothing alerts when a sensor goes silent. (ALERT-CRITICAL-020)
- Farm-signal incidents cannot even be created and escalations reach nobody (existing
  ALERT-CRITICAL-009 and ALERT-CRITICAL-004, both confirmed).

### Core data paths lose or fabricate data

- A failed write still acks a sensor reading; edge backlog is dropped; the dead-letter queue
  cannot publish. (SENSOR-CRITICAL-136, SENSOR-CRITICAL-137, SENSOR-CRITICAL-138)
- Web harvest never moves stock; harvest can reopen a closed batch; the feed-ledger completion can
  double count. (FARM-CRITICAL-365, FARM-HIGH-364, FARM-HIGH-363)
- Per-tenant cron jobs see zero rows because the RLS tenant variable is never set.
  (MT-CRITICAL-071)
- The sensor pages show random numbers as real readings and AquaMobil deletes unsynced field
  records on logout or a refresh failure. (FE-CRITICAL-159, FE-CRITICAL-160)

### The product cannot collect money or enforce plans

- Stripe and the local ledger are disconnected, no payment method is ever collected, non-payment
  never revokes access, and production defaults to mock billing. (BILLING-CRITICAL-035 to
  BILLING-CRITICAL-038)

### Access control has two production gaps

- auth-service rate limits are single platform-wide buckets, and SUPER_ADMIN MFA is detective
  only. (SEC-CRITICAL-179, SEC-CRITICAL-180) No path leaking one tenant's data to another was
  found.

## Corrections to the orchestrator's first-pass answer

- DEPLOY-CRITICAL-017 is not fixed. The compose-project label filter in `droplet-up.sh` only
  covers the log dump (line 273); the destructive cleanup still removes every container whose name
  contains `aqua-` (lines 1285-1304).
- SENSOR-CRITICAL-108 is half fixed: `nats.conf` now says 10GB, but the deploy gate in
  `droplet-up.sh` still aborts above 1800 MB and the capacity gate and alert rule still assume 2
  GiB, so a deploy will refuse once streams grow.
- There was no "production" to deploy to in CI terms: the first pass described the deploy topology
  as if it were live. The production lane is disabled.
- The notification gap is larger than the SNS and APNS TODOs the first pass listed: no channel
  delivers in production at all.
- The ARIA meta-system holds roughly half of the open registry rows, but none of the twelve
  specialists found it to be a production blocker.

## Suggested order

- **Restore trust in the pipeline first.** Name and fix the advisory behind the red npm gate
  (upgrade or override, not a renewal), renew or remove the lapsed Rust ignore, and resolve the
  SSH fingerprint mismatch, treating it as a possible incident until the host key is confirmed
  from the DigitalOcean console. Get CI - Full green.
- **Make the system recoverable and observable.** Activate backup and WAL archiving (plan phases
  BR-1 and BR-3) and run a logged restore drill; give Alertmanager real receivers and egress; make
  at least one notification channel deliver and fail loudly when disabled; add a stale-sensor
  dead-man.
- **Fix the data-loss and fabrication paths.** Stop acking failed ingestion writes, build the
  edge_seq path, grant dlq publishing, fix the alert_incidents rule_id contract, bind the RLS
  tenant variable in non-request entrypoints (and make the gate reject the current shape), repair
  web harvest and the ledger backfill, remove random sensor data from navigation, and stop
  AquaMobil from wiping its queue.
- **Make billing real.** Connect Stripe to the ledger, collect a payment method, wire non-payment
  to suspension and dunning, and make production refuse mock billing.
- **Close access-control and deploy-pipeline security,** then re-enable the production lane and
  run a deployed-stack end-to-end proof against the exact SHA.

## Reports

| Report | Scope | Verdict | New findings |
| --- | --- | --- | --- |
| [infra-expert](../infra-expert/2026-10-02-production-readiness.md) | Deployment topology, backup/DR, operability | NOT READY | 2 critical, 1 high, 1 medium |
| [security-reviewer](../security-reviewer/2026-10-02-production-readiness.md) | CI/CD and deploy-pipeline security | NOT READY | 3 high, 1 low |
| [supply-chain-auditor](../supply-chain-auditor/2026-10-02-production-readiness.md) | Dependencies and supply chain | NOT READY | 3 high, 4 medium, 1 low |
| [auth-security-expert](../auth-security-expert/2026-10-02-production-readiness.md) | Authentication, authorization, gateway | NOT READY | 2 critical, 3 high, 1 medium, 1 low |
| [multi-tenant-saas-expert](../multi-tenant-saas-expert/2026-10-02-production-readiness.md) | Tenant isolation and SaaS enforcement | NOT READY | 1 critical, 1 high, 1 medium |
| [data-expert](../data-expert/2026-10-02-production-readiness.md) | Migrations, schema drift, data integrity | NOT READY | 2 high, 2 medium, 1 low |
| [alert-engine-expert](../alert-engine-expert/2026-10-02-production-readiness.md) | Life-safety alerting end to end | NOT READY | 2 critical, 3 high, 2 medium |
| [farm-expert](../farm-expert/2026-10-02-production-readiness.md) | Farm stock and lifecycle integrity | NOT READY | 1 critical, 4 high, 1 low |
| [sensor-expert](../sensor-expert/2026-10-02-production-readiness.md) | Sensor ingestion and edge gateway | NOT READY | 3 critical, 3 high, 1 medium, 1 low |
| [billing-expert](../billing-expert/2026-10-02-production-readiness.md) | Billing, revenue, admin duplicates | NOT READY | 4 critical, 7 high, 4 medium |
| [frontend-expert](../frontend-expert/2026-10-02-production-readiness.md) | Web shell, microfrontends, AquaMobil | NOT READY | 2 critical, 3 high, 2 medium, 1 low |
| [test-runner](../test-runner/2026-10-02-production-readiness.md) | CI gate reality and test health | NOT READY | 6 high, 2 medium, 1 low |

## Registry

The cycle appended 85 findings to `docs/reviews/_registry/findings.jsonl` through the
`finding-registry add` CLI (chain verified, 2384 entries): 17 CRITICAL, 39 HIGH, 21 MEDIUM and 8
LOW. Each is OPEN, owned by okan, with a deadline of 2026-10-16 (CRITICAL), 2026-10-30 (HIGH),
2026-11-27 (MEDIUM) or 2026-12-31 (LOW); these deadlines are the orchestrator's proposal and need
the owner's confirmation. Existing findings the specialists confirmed were not re-filed.

Registry hygiene is tracked separately: PROC-MEDIUM-044 lists the rows that are stale
(ORPHAN-CRITICAL-516 and -517, INFRA-CRITICAL-093 and -029, SENSOR-CRITICAL-108 and others) and
the two reopen candidates (BILLING-CRITICAL-001, SEC-HIGH-166). The registry cannot be edited in
place, so those rows need Closes: commits or `finding-registry reopen --reject-closure`.

## What this synthesis does not cover

- No code was executed. The specialists had read-only access; no test suite, build, npm audit or
  browser was run, and no live host, GitHub variable or Environment protection could be read.
- The orchestrator re-checked a subset of claims in the working tree (backup activation state,
  Alertmanager networking, summed compose memory limits, notification environment and mock return
  values, the billing mock default, absence of a Stripe payment-method flow, floating image tags,
  the name-based container cleanup, the JetStream deploy gate, the rollback refusal, and the cited
  lines of 20 critical findings). Everything else is as reported.
