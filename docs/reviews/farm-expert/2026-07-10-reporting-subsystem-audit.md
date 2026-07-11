# Regulatory Reporting Subsystem — End-to-End Multi-Agent Audit — 2026-07-10

Scope: the **entire** Norwegian regulatory reporting subsystem (Mattilsynet REST +
Fiskeridirektoratet FD-0001/Altinn + varsling), backend `apps/farm-service/src/regulatory/**`
(assembly, scheduler, submission, drafts, Maskinporten/Mattilsynet clients, 5 official schemas,
24 migrations, 5 fish-health capture entities) and frontend
`web/modules/farm-module/src/pages/reports/**`. Bar: production-ready, enterprise-grade,
steel-secure, performant.

Method: ten specialised agents reviewed in parallel from distinct angles — farm domain, data/
migrations, auth-security, performance, multi-tenant isolation, compliance, job-queue/scheduler,
contract-parity, observability, and circuit-breaker/resilience. Every problem was noted, related
or not. Findings below are the consolidated, de-duplicated set. Items marked **FIXED (this PR)**
landed on `claude/serene-allen-8mo9q1`; the rest are tracked for phased remediation.

> Cross-agent convergence: the **advisory-lock-on-pooled-connection** defect was found
> **independently by three agents** (circuit-breaker, multi-tenant, job-queue), making it the
> highest-confidence defect in the audit.

---

## FIXED (this PR)

### FARM-CRITICAL-161 — regulatory scheduler advisory-lock-on-pooled-connection (triple-confirmed)

`ReportSchedulerService` acquired `pg_try_advisory_lock` and released `pg_advisory_unlock` through
two separate `dataSource.query()` calls (different pooled connections). A session-scoped lock stays
held on the acquiring connection; the unlock landed on a different one and no-op'd, so the lock
leaked and every later run of all four regulatory crons self-skipped — silently halting rollover,
deadline sweep, and retry replay for all tenants (missed statutory deadlines). Fixed: `runJob` holds
**one** dedicated `QueryRunner` for the lock's whole lifetime (acquire + work + release provably the
same session), released in `finally`, connection released after. Tier-3 guard: the spec now asserts
acquire/release share one connection and that the lock releases even when the job body throws.

### FARM-HIGH-162 — FeedingCronService shares the same advisory-lock defect

Found while fixing FARM-CRITICAL-161: `FeedingCronService` uses the identical
`dataSource.query()`-per-call acquire/release across four cron methods. Same root cause, same fix
(dedicated per-job `QueryRunner`); tracked and fixed in the same remediation campaign so the pattern
is corrected everywhere, not patched in one service.

### FARM-CRITICAL-171 — no circuit breaker + no timeout on the government-API calls

The three regulatory external calls (Maskinporten discovery, Maskinporten token, Mattilsynet submit)
were raw `fetch()` with no circuit breaker and no timeout, despite a CI-mandated canonical
`CircuitBreakerService`. A hung/slow government API had zero backpressure and no bounded wait, and
under the serial lock-held sweep one slow downstream stalled the whole cron. Fixed: `AbortSignal.timeout`
on all three fetches (5 s auth, 20 s submit); `CircuitBreakerModule` registered in `RegulatoryModule`;
Maskinporten discovery wrapped (global key) + token wrapped (per-tenant), both fail-closed and
throwing on failure so the breaker counts them; Mattilsynet submit wrapped per-tenant fail-closed
(counts network/timeout + slow-call; on open → `CircuitOpenError` → caught → transient replay, never a
fabricated acceptance). Remaining refinements (jitter, single-flight token, LRU cache, 5xx-in-breaker)
tracked as FARM-MEDIUM-172.

### FARM-CRITICAL-169 — migration `1804400` drop-before-backfill aborted the deploy

`1804400` dropped `harvest_records.qualityGrade` from every tenant schema during the source-first
farm pass, but a tenant not yet migrated to the expand migration `1803100` (which backfills
`qualityClass` FROM `qualityGrade`) then hit `42703` when its tenant pass ran, aborting the whole
deploy on any DB with pre-existing tenant schemas. Fixed: removed the aggressive cross-schema
`DROP COLUMN` loop (each schema's own `1804300` drops the column in the correct order after its
`1803100`), and the shared-type reclamation now **defers** (returns) when any schema still references
the type instead of masking-then-dropping. The orphan-type reclamation is tracked as FARM-MEDIUM-170
(post-fan-out step). `bootstrap-from-scratch` missed it (empty DB → zero tenant schemas).

### FARM-CRITICAL-168 — manual executed-slaughter wizard filed a fabricated government report

The manual executed-slaughter form placed the quality-grade **percentages** straight into the
Mattilsynet `superiorKg`/`ordinaerKg`/`produksjonsfiskKg`/`utkastKg` weight fields and hard-coded
`art:'SAL'`, so "50 000 kg of 80% Superior trout" was filed as "80 kg of salmon" — structurally
schema-valid, fully falsified. Fixed by making the fabrication impossible: the tab no longer imports
`useSubmitExecutedSlaughterReport`, the executed submit fails closed with guidance, and the Executed
Slaughter selector is a disabled affordance pointing to the records-based "Scheduled reports due"
draft (now submittable, FARM-HIGH-167). The now-unreachable `completed` wizard steps are dead code
to remove with the FARM-MEDIUM-009 parallel-systems cleanup.

### FARM-HIGH-167 — slaughter drafts were un-submittable (missing official locality wrapper)

`buildWirePayload` spread the flat assembled slakt body verbatim, but the official slakt schemas
require the per-species `arter`/`ukeplanPerArt` nested inside `utførteLokaliteter`/
`planlagteLokaliteter` (`additionalProperties:false`), so every scheduled slaughter draft failed
official-schema validation and could never be submitted. Fixed: `reshapeForWire` wraps the executed
`arter` and planned `ukeplanPerArt` into the single-locality wrapper (the draft's site, carrying the
header org/lokalitet) and drops the assembler-only `totalKgPerArt`.

### FARM-CRITICAL-165 — enum-casing drift killed varsling submit + draft Approve & Submit

The hand-written farm-module types sent lowercase enum VALUES (`welfare_impact`/`high`/`suspected`)
while the GraphQL SDL exposes the enum KEYS (`WELFARE_IMPACT`/`HIGH`/`SUSPECTED`), so the
legally-immediate welfare + disease varsling failed enum coercion before the resolver; and
`ReportsDueSection` compared draft `status === 'ready'` when the wire serializes to `'READY'`, so the
Approve & Submit affordance never rendered for any scheduled draft. Fixed: the varsling inputs are
retyped to the uppercase wire unions with domain→wire maps at the tab boundary; `ReportDraftStatusValue`
+ the `ReportsDueSection` comparisons are uppercased. A vitest guard asserts the mutation sends
`WELFARE_IMPACT`/`HIGH`/`CONFIRMED`, and the `ReportsDueSection` fixtures now use the real uppercase
wire status (both were false-greens on lowercase). The Tier-1 durable fix (codegen-backed FE types) is
tracked as **FARM-MEDIUM-166**.

### FARM-CRITICAL-163 — draft ↔ submission reconciliation (auto-submit re-filed accepted/rejected reports)

A report draft and its `regulatory_reports` row were two unlinked state machines: a draft became
SUBMITTED only on synchronous first-call success, so a retry-sweep success or a PERMANENT failure
left it `READY`, and `autoSubmitForTenant` re-listed and re-filed it every rollover — duplicating an
already-accepted Mattilsynet filing (receipt nulled) or infinitely re-sending a rejected one. Fixed:
`approveAndSubmit` reconciles against the submission SSoT (the report keyed by
`klientReferanse = draft.id`); an accepted (SUBMITTED/QUEUED) row links the draft to its receipt and
returns without re-POST; an automated (`AUTO_SUBMIT_ACTOR_ID`) re-file over a non-accepted row is
refused (the retry sweep owns transient, the operator owns permanent); an explicit operator
re-approval may still retry.

### FARM-HIGH-164 — SUBMITTED report immutability guard

`RegulatoryReportStoreService.upsert` reset an existing row to PENDING and nulled its receipt with no
terminal-state guard, so a re-entry for an accepted `klientReferanse` silently converted an
authoritative filing into a receiptless PENDING row. Fixed: `upsert` returns a SUBMITTED/QUEUED row
unchanged (defense-in-depth to FARM-CRITICAL-163); a DB-level immutability trigger remains a
follow-up.

### FARM-HIGH-160 — disease varsling assembler regression (non-existent column + missing status filter)

The FARM-HIGH-155 fix scoped the disease site through `tb."batchId" = he."batchId"`, but
`tank_batches` has **no** `batchId` column (real columns: `primaryBatchId` + the `batchDetails`
jsonb), so `DISEASE_OUTBREAK` prefill still threw Postgres `42703`, and the SQL-pinning spec locked
the wrong column in. It also did not exclude `resolved`/`cancelled` outbreaks, so a closed event
could be offered for a legally-immediate varsling. Fixed: the `primaryBatchId` + `batchDetails`
jsonb `EXISTS` pattern (mirroring `BiomassReportAssembler.queryStockings`) plus
`he.status NOT IN ('resolved','cancelled')`; the spec now pins the real columns. Durable guard is
the real-DB assembler harness (FARM-MEDIUM-157).

### FARM-HIGH-159 — planned-slaughter assembler two fatal SQL errors

`SlaktReportAssembler.queryPlanned` selected `SUM(hp."estimatedBiomass")` (that column lives inside
the `estimates` jsonb) and grouped by `s.code` while selecting `COALESCE(s."officialCode", s.code)`
(illegal aggregate, `42803`). Either error alone made every `SLAUGHTER_PLANNED` assemble throw, so
the scheduler silently created no planned-slaughter draft and `reportPrefill(SLAUGHTER_PLANNED)`
500'd. Fixed: `SUM((hp.estimates->>'estimatedBiomass')::numeric)` and
`GROUP BY/ORDER BY COALESCE(s."officialCode", s.code), weekday`.

---

## OPEN — CRITICAL (tracked for remediation)

- **Executed-slaughter wizard fabricates the government report** (farm-expert FARM-CRITICAL-001).
  `SlaughterReportTab.tsx` places the quality-grade **percentages** into the Mattilsynet `*Kg`
  weight fields and hard-codes `art:'SAL'`, so "50,000 kg trout, 80% Superior" is filed as "80 kg
  salmon". Structurally schema-valid, fully fabricated. Root fix: drive executed slaughter from the
  records-based assembled draft (per-species absolute gutted-kg), retire the percentage form.

- **Advisory lock acquired/released on different pooled connections** (circuit-breaker
  CIRCUIT-HIGH-001, multi-tenant REG-HIGH-001, job-queue PRODUCT-JOB-CRITICAL-001 — **triple
  confirmed**). `report-scheduler.service.ts` runs `pg_try_advisory_lock` and `pg_advisory_unlock`
  via separate `dataSource.query()` calls (different pooled connections). The session lock leaks
  onto the acquiring connection and is never released; every later cron tick then self-skips, so
  weekly/monthly rollover, deadline sweep, and retry sweep silently stop for **all** tenants →
  missed statutory deadlines. Fix: hold one dedicated `QueryRunner` for lock+work+unlock, or use
  `pg_advisory_xact_lock` in a job-spanning transaction. Same pattern exists in `FeedingCronService`.

- **Drafts never reconciled with their terminal submission → re-file every rollover** (job-queue
  PRODUCT-JOB-CRITICAL-002). A draft is marked SUBMITTED only on synchronous first-call success; a
  retry-sweep success or a PERMANENT failure leaves it `READY`, so `autoSubmitForTenant` re-lists
  and re-submits an already-accepted (duplicate filing, receipt nulled by `recordPending`) or
  already-rejected (infinite re-send + alert spam) report every cycle. Only Mattilsynet's own
  `klientReferanse` dedup prevents a true duplicate. Fix: reconcile the draft from its
  `regulatory_reports` row; exclude drafts with a terminal/in-flight submission from auto-submit;
  guard `recordPending` against resurrecting a SUBMITTED row.

- **Migration `1804400` drops `qualityGrade` from tenant schemas before their own backfill runs**
  (data-expert DATA-CRITICAL-001). The source-first fan-out drops the shared column across all
  tenant schemas during the `farm` pass; a tenant still behind on the expand migration `1803100`
  then hits `42703` in its backfill → deploy aborts (outage). Triggered by the first prod deploy or
  any replay onto a snapshot with pre-existing tenant schemas. Fix: gate the cross-schema drop to
  tenants whose ledger already contains `1803100`/`1804300`, or reclaim the shared enum in a
  post-fan-out step.

- **Enum-casing drift kills Welfare/Disease varsling submit** (contract-parity CONTRACT-CRITICAL-001).
  Hand-written farm-module types send lowercase enum values (`welfare_impact`, `high`, `suspected`)
  but the GraphQL SDL exposes uppercase names → enum-coercion error before the resolver → the
  legally-immediate welfare/disease varsling never files. Fix: send the GraphQL enum NAMES; migrate
  farm-module to codegen (aquamobil already is).

- **Enum-casing drift kills the scheduled-draft Approve & Submit surface** (contract-parity
  CONTRACT-CRITICAL-002). `ReportsDueSection` compares `status === 'ready'` but the wire value is
  `'READY'`, so the Approve & Submit button never renders for any READY draft — the whole
  review→approve→submit surface is inoperable. Fix: compare uppercase names; codegen.

- **No circuit breaker + no timeout on any government-API/auth call** (circuit-breaker
  CIRCUIT-CRITICAL-001/002, job-queue PRODUCT-JOB-HIGH-002). The three external `fetch()` calls
  (Maskinporten discovery, token, Mattilsynet submit) are raw and untimed despite a CI-mandated
  canonical `CircuitBreakerService`. A hung/slow regulator has no backpressure and no bounded wait;
  under the serial lock-held sweep one slow downstream stalls the whole cron and every tenant. Fix:
  per-tenant, fail-closed, timed breaker on each boundary; gate the retry/auto-submit sweeps through
  it; add jitter + single-flight token acquisition.

### FARM-HIGH-173 — direct REST submit trusted client-supplied regulatory identity

The five REST submit mutations took `organisasjonsnummer` + `lokalitetsnummer` straight from the
GraphQL client and never verified them against the tenant's configured sites/org (the draft path
derives them server-side), so an operator could attribute a legally-binding filing to any org/lokalitet
the tenant credential could reach. Fixed: `assertTenantOwnsIdentity` verifies every declared
(org, lokalitet) pair against the tenant's effective site-locality mappings + org number and rejects a
foreign lokalitet or mismatched org (BadRequestException) before any persistence or submission, on all
five mutations (top-level + nested slakt localities).

### FARM-HIGH-174 — deadline sweep + reportDeadlines loaded every draft ever created

Both `notifyDeadlinesForTenant` (daily) and `listDeadlines` did `repo.find({ where:{ tenantId } })` and
then discarded terminal/undated rows in JS, so the scans grew unbounded with history. Fixed:
`listDeadlineCandidates` pushes `status NOT IN (SUBMITTED,DISMISSED) AND dueAt IS NOT NULL` into SQL
(covered by the `(tenantId,status)` index); both callers use it. Specs assert the SQL where.

### FARM-HIGH-175 — retry pipeline had no max-attempt / dead-letter

A chronically-failing TRANSIENT report (persistent 403 auth misconfig, or a multi-day outage)
rescheduled every 6h forever, and the operator alert fires only on PERMANENT — so a stuck report
silently missed its deadline. Fixed: a MAX_TRANSIENT_ATTEMPTS=12 ceiling escalates an exhausted
transient failure through the extracted markPermanentFailure (terminal PERMANENT + the operator
outbox alert) so the sweep stops replaying it and the failure surfaces.

### FARM-HIGH-176 — BIOMASS draft in the REST due-list with a broken Approve & Submit

The scheduler assembled a BIOMASS draft into regulatory_report_drafts monthly; it surfaced in
"Scheduled reports due" with a Mattilsynet "Approve & Submit" that always threw (biomass is the
FD-0001/Altinn channel, not a REST report) and duplicated the biomass_reports lifecycle. Fixed:
BIOMASS removed from monthlyJobs so it no longer flows through the REST pipeline; biomass keeps its
own biomass_reports + Altinn confirm flow.

### FARM-HIGH-177 — settefisk assembler CTEs whole-tenant scanned per site

The mortality/culls/external_out CTEs filtered only by tenantId + date (not site), aggregating the
tenant's entire history and discarding non-site rows in the final join — re-run once per site.
Fixed: each CTE joins site_tanks on the source tankId so it seeks the (tankId, date) index for the
site's tanks instead of a whole-tenant scan.

## OPEN — HIGH (tracked)

- **Slaughter drafts can never be submitted** — `buildWirePayload` never wraps `arter`/`ukeplanPerArt`
  into the required `utførteLokaliteter`/`planlagteLokaliteter` locality wrapper, so every slaughter
  draft fails official-schema validation (farm-expert FARM-HIGH-002, contract CONTRACT-HIGH-003).
- **No immutable, actor-attributed audit trail** for any regulator action (submit/approve/override/
  dismiss/resubmit) — the module never writes `farm_audit_logs` (compliance COMPLIANCE-HIGH-001).
- **A SUBMITTED report can be silently overwritten** — `regulatory-report-store.upsert` resets an
  accepted row to PENDING and nulls the receipt with no terminal-state guard and no DB immutability
  trigger (compliance COMPLIANCE-HIGH-002, job-queue PRODUCT-JOB-MEDIUM-002).
- **Tenant erasure deletes government-filed records under statutory retention** and cannot scrub a
  single worker's PII embedded in a filed report (compliance COMPLIANCE-HIGH-003).
- **Direct REST submit trusts client-supplied org/lokalitet** instead of deriving them server-side
  like the draft path does (auth-security SEC-HIGH-001).
- **`regulatory_report_drafts` has no RLS** (its sibling `regulatory_reports` does) and the draft
  service reads via a plain repository outside `runInTenantRead` (multi-tenant REG-HIGH-002).
- **No RED metrics / cron heartbeat / operator alerts** on the government-submission pipeline — a
  Mattilsynet rejection returns GraphQL-200 and counts as success everywhere (observability
  OBS-HIGH-001/002/003).
- **No max-attempt / dead-letter** — chronic TRANSIENT failures (incl. 401/403) retry forever,
  surfaced to no operator (job-queue PRODUCT-JOB-HIGH-001, observability OBS-HIGH-002).
- **Biomass draft in the "due" list has a broken Mattilsynet Approve & Submit** and is a duplicate of
  the `biomass_reports` Altinn state machine (farm-expert FARM-HIGH-004).
- **Monthly standing-stock read "as of now", not period-end** — `refresh` on a historical month
  stamps today's stock as that month's closing beholdning with RECORDS provenance (farm-expert
  FARM-HIGH-005, data-expert DATA-MEDIUM-004).
- **Settefisk CTEs are not site-scoped** → whole-tenant mortality scans re-run once per site
  (performance PERF-HIGH-002).
- **Daily deadline sweep + auto-submit load every draft ever created** then filter in JS
  (performance PERF-HIGH-003, job-queue PRODUCT-JOB-MEDIUM-003).
- **No farm-module code-splitting / bundle budget** — the whole reporting UI ships eagerly
  (performance PERF-HIGH-004).
- **Each assembler sub-query opens its own ~6-round-trip tenant boundary** (performance PERF-HIGH-005).

## OPEN — MEDIUM / LOW (tracked)

Biomass assembler defaults a missing stocking avg-weight to `0` tagged RECORDS (compliance
COMPLIANCE-MEDIUM-005); manual overrides stored/injected as strings fail numeric schema validation
(farm-expert FARM-MEDIUM-006); executed-slaughter uses round weight where the regulator may expect
gutted (FARM-MEDIUM-007); CSV/formula injection in both CSV exporters (auth-security SEC-MEDIUM-002);
KEK dev-fallback gated only on `NODE_ENV==='production'` (SEC-MEDIUM-003); regulator error bodies +
PII logged via string interpolation that bypasses `maskPii` (SEC-MEDIUM-004, observability
OBS-MEDIUM-003); `updateAutoSubmitPolicy` accepts arbitrary report types (COMPLIANCE-MEDIUM-006);
varsling QUEUED shown as "Submitted" with the internal event id as a fake "Mattilsynet receipt"
(COMPLIANCE-MEDIUM-004, farm-expert FARM-LOW-012); settefisk mixed-batch attribution (FARM-MEDIUM-010);
`EscapeIncidentRecordedEvent` has no consumer so the "varsling is immediate" reminder is dropped
(contract CONTRACT-MEDIUM-005); stale codegen/subgraph SDL missing the prefill/draft surface
(CONTRACT-MEDIUM-004); no DB CHECK constraints on welfare 0–3 / lice non-negative (data DATA-LOW-007);
lossy relocation-before-drop migrations with no backup step (DATA-MEDIUM-005/006); duplicate parallel
submission systems (manual wizard vs assembled draft) per report type (farm-expert FARM-MEDIUM-009);
inconsistent artskode regex + COALESCE laundering (FARM-LOW-011, FARM-MEDIUM-158); non-atomic
attemptCount RMW + operator/sweep race (job-queue PRODUCT-JOB-MEDIUM-001); no span coverage / deterministic
backoff without jitter / token single-flight + LRU (OBS-MEDIUM-001/002, CIRCUIT-MEDIUM-001/002/003);
plus assorted LOWs (siteName never populated, sea-lice temperature not hydrated, tenant discovery keyed
off `sites`).

## Verified sound (no action)

Maskinporten token cache tenant-keying + AES-256-GCM credential-at-rest + no GraphQL exposure; the
`ValidatedPayload<T>` brand gate (unvalidated submit is a compile error); persist-first submit +
transient/permanent classification; `klientReferanse` idempotency (happy path); the biomass Altinn
READY→CONFIRMED_SUBMITTED honesty state machine + terminal immutability; ISO-week/month period math
and Oslo/DST-safe deadline computation; rollover `ON CONFLICT` idempotency; the sea-lice
`fishSampled`-weighted pooled mean; the temperature `sensor_temperature_daily` rollup reader;
frontend tenant-scoped query-key cache hygiene; no `console.*`, no secrets logged; the authz matrix
(global fail-closed RolesGuard + PermissionMatrixGuard) and `saveOverrides` RECORDS/SENSOR rejection;
per-tenant exception isolation in the sweeps; MODULE_SCHEMAS registration + RLS on `regulatory_reports`.
