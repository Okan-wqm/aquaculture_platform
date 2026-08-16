# farm-service data layer — entities, migrations, events, outbox — 2026-08-16

**Agent:** `data-expert` · **Mode:** CATCHER (read-only) · **Lane:** farm
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** CONDITIONAL
**Findings surviving verification:** 6 (CRITICAL 0 · HIGH 0 · MEDIUM 4 · LOW 2) · 4 refuted

> Produced by a 27-agent audit workflow. Every CRITICAL/HIGH claim was handed to an
> independent verifier instructed to **refute** it by reopening each cited line;
> claims that could not be defended were dropped into the Refuted section below.
> MEDIUM/LOW claims did not enter the verify stage and carry the raising agent's
> confidence only.
>
> **Finding IDs** are allocated above the `DATA` high-water mark in
> `docs/reviews/_registry/findings.jsonl` (DATA was at 10 at cycle time), so
> they do not collide with existing registry entries. They are **not yet registered** —
> `npm run findings:add` is a separate, human-gated append to the hash-chained ledger.

## Scope

Read /home/user/aquaculture_platform/CLAUDE.md \+ apps/farm-service/CLAUDE.md,
.claude/shared/output-format.md, .claude/knowledge/layer-1-typeorm.md,
.claude/knowledge/layer-2-patterns.md. Farm data layer: all 98 `@Entity` declarations under
`apps/farm-service/src/**/entities/` (grep \+ targeted reads of batch, feeding-protocol, finance,
weather, regulatory, storage, outbox, compliance, database entities);
apps/farm-service/src/database/data-source.ts, migrations/manifest.ts, and 76 active migration files
(full read of 1800700000000-CreateCanonicalOutboxInbox; grep sweeps for SET search_path /
lock_timeout / CONCURRENTLY / DecimalTransformer / numeric / jsonb / timestamptz); app.module.ts
TypeORM+SchemaDrift+MigrationRunner wiring; apps/farm-service/src/outbox/**;
platform/libs/outbox/src/{outbox-entity.base,outbox-worker.service}.ts;
libs/backend-common/src/database/schema-manager.service.ts MODULE_SCHEMAS['farm'] and
rls/apply-tenant-rls.helper.ts; libs/event-contracts/src/{base-event,farm-events}.ts,
schemas/farm-events.schema.ts (full), upcasters/{index,batch-harvested-v1-to-v2}.ts; every farm
producer site found by grepping createBaseEvent \+ OutboxPublisher.enqueue \+ eventBus.publish
(auto-rule-trigger, task, water-quality, harvest, regulatory-varsling, growth, meal-execution,
feeding-cron-v2, listeners); apps/farm-service/src/compliance/services/tenant-erasure.service.ts;
gates: tools/gates/migration-sql-lint.ts, eslint.config.mjs override 9,
tests/invariants/farm-outbox-publish-ssot.spec.ts,
`apps/farm-service/src/**tests**/e2e/tenant-schema-routing.architecture.spec.ts` \+
jest.{config,integration.config,e2e.config}.ts.

## Executive summary

The farm data layer is architecturally sound at runtime: all 98 entities are classified in
MODULE_SCHEMAS, per-tenant tables correctly omit `schema:`, nothing lands in `public`, the migration
manifest matches the 76 files on disk, `migrationsRun:false` \+ `DATABASE_MIGRATIONS_RUN` discipline
holds, no active migration carries a session-scoped `SET search_path`, and the transactional outbox
is adopted across ~119 producer files with lease/backoff/dead-letter/idempotency-key support and a
correct `BatchHarvested` v1→v2 upcaster with a `version: 2` producer.

The gaps are in the enforcement and the edges. The CLAUDE.md-named schema-routing invariant is stale
and red (its allowlist omits two entities its own regex flags). Three regulatory varsling events
ship raw operator name/email/phone into the append-only NATS ledger and into
`farm.outbox_events.payload`, with no crypto-shred key and no erasure sweep of that table. Both NATS
listeners swallow handler errors, so the bus ACKs and the mortality alert plus the food-safety
harvest traceability record are lost permanently on any transient fault. `inbox_messages` and
`event_dlq` exist as tables with zero code. Nine farm event contracts have no producer, including
the three feed-lot traceability events.

## Findings (by severity)

### MEDIUM

### DATA-MEDIUM-015

**Title:** farm.inbox_messages and farm.event_dlq are provisioned tables with zero producers and
zero consumers — durable consumer idempotency and DLQ are MISSING

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `DATA-MEDIUM-005` by `data-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/database/migrations/1800700000000-CreateCanonicalOutboxInbox.ts:82 — CREATE
  TABLE farm.inbox_messages with unique index (consumerName, tenantId, eventId) at :96
- apps/farm-service/src/database/migrations/1800700000000-CreateCanonicalOutboxInbox.ts:106 — CREATE
  TABLE farm.event_dlq with failedAt/tenant indexes at :120-:125
- libs/backend-common/src/database/schema-manager.service.ts:380 — both listed in farm
  infrastructureTables so strictOwnership will not drop them
- apps/farm-service/src/events/listeners/harvest-completed.listener.ts:250 — inbound idempotency
  uses a volatile Redis setNx claim with a 24h TTL instead of the inbox ledger, and degrades to
  'claim won' when Redis is unavailable (:246)

**Rule violated:**

layer-2 Outbox/inbox pattern \+ data-expert consumer fail-closed invariant (idempotency on eventId
under at-least-once delivery)

**Proposed fix direction:**

Either wire the inbox: give `farm.inbox_messages` an OutboxEntityBase-style entity and route the two
listeners' claim/release through it inside the same transaction as their side effects, which makes
idempotency survive a Redis restart and removes the fail-open branch. Or delete both tables in a
migration and remove them from MODULE_SCHEMAS so the registry stops asserting a capability that does
not exist. Leaving them provisioned-but-dead makes every future reviewer assume durable dedupe and a
DLQ are present.

**Affected surface (ripple set):**

```text
apps/farm-service/src/database/migrations/1800700000000-CreateCanonicalOutboxInbox.ts
```

- `libs/backend-common/src/database/schema-manager.service.ts`
- `apps/farm-service/src/events/listeners/harvest-completed.listener.ts`
- `apps/farm-service/src/events/listeners/mortality-recorded.listener.ts`
- `platform/libs/outbox/src/index.ts`

**Expected closer:**

platform-kernel-expert (inbox is a platform primitive) with data-expert as CATCHER on the farm
wiring

### DATA-MEDIUM-016

**Title:** Nine farm event contracts have zero producers, including the three feed-lot traceability
events whose docstrings claim an always-fire guarantee

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `DATA-MEDIUM-006` by `data-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- libs/event-contracts/src/farm-events.ts:201 — FeedInventoryReceivedEvent, documented at :195 as
  'the primary lot-traceability anchor' for FDA 21 CFR 507 / EU 183/2005; no producer exists
  anywhere in the repo
- libs/event-contracts/src/farm-events.ts:1176 — FeedInventoryConsumedEvent, documented as the
  'always-fire partner' to Received; no producer
- libs/event-contracts/src/farm-events.ts:1142 — FeedInventoryAdjustedEvent, documented as
  'audit-trail-critical'; no producer
- libs/event-contracts/src/farm-events.ts:50 — FarmCreatedEvent / FarmUpdatedEvent (:62) /
  PondCreatedEvent (:75) / TankDensityAlertEvent (:530) / LegacyFarmDataMigratedEvent (:1218) /
  LegacyFarmTableConvertedEvent (:1268); the migrate-legacy-farm CLI referenced at :1205 does not
  exist in any .ts file
- apps/gateway-api/src/websocket/farm-nats-bridge.service.ts:387 — case 'FeedInventoryLow' is a live
  bridge branch for an event with no producer (its successor LowStockDetected is emitted at
  apps/farm-service/src/storage/services/stock-movement.service.ts:316)

**Rule violated:**

CLAUDE.md Event Contract Rules \+ layer-2 event flat pattern; a contract in the
AnyPlatformEvent/FarmEvent union asserts a wire surface that consumers may build against

**Proposed fix direction:**

Split the nine into two buckets and act on each. The three feed-inventory events are a genuine
product gap, not dead code — the food-safety lot ledger they document does not exist, so either emit
them from the storage/feed-inventory mutation sink (the same place LowStockDetected is emitted) or
amend the docstrings to stop asserting a guarantee the system does not provide. The legacy
farm/pond/tank-density/legacy-migration contracts should be removed from `FarmEvent` and the file
with a BREAKING CHANGE footer plus a retirement upcaster entry, and the dead
`case 'FeedInventoryLow'` branch removed from the gateway bridge. Add a CI invariant asserting every
member of the FarmEvent union has at least one producer or an explicit `// retired:` marker.

**Affected surface (ripple set):**

- `libs/event-contracts/src/farm-events.ts`
- `libs/event-contracts/src/schemas/farm-events.schema.ts`
- `apps/gateway-api/src/websocket/farm-nats-bridge.service.ts`
- `apps/farm-service/src/feeding/entities/feed-inventory.entity.ts`
- `apps/farm-service/src/storage/services/stock-movement.service.ts`

**Expected closer:**

farm-expert owns the feed-inventory product decision; data-expert WRITER mode for the contract
retirement \+ invariant

### DATA-MEDIUM-017

**Title:** Meal-engine numeric columns skip DecimalTransformer while 51 sibling farm entities use
it, so the entity types lie about the runtime shape

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:** `DATA-MEDIUM-007` by `data-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/feeding-protocol/entities/feeding-meal.entity.ts:115 — @Column({ type:
  'numeric', precision: 6, scale: 2 }) percentOfDaily!: number (also :119 plannedKg, :128 actualKg,
  :137 varianceKg, :141 variancePercent) with no transformer
- apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts:168 — plannedTotalKg!:
  number and :173 unplannedActualKg!: number, same pattern
- apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts:204 — meal.actualKg =
  round3(Number(meal.actualKg || 0) \+ params.pourKg); compensating Number() coercions repeated at
  :230, :266, :268-269, :309
- apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts:704 — raw row typed
  `plannedTotalKg: string | number` (also :435, :705-706), an explicit admission that the DB returns
  strings
- apps/farm-service/src/finance/entities/finance-expense-entry.entity.ts:87 — the correct in-repo
  pattern: type 'decimal' \+ transformer: new DecimalTransformer()

**Rule violated:**

layer-1-typeorm column-type discipline \+ data-expert NUMERIC/DECIMAL invariant (pg returns numeric
as string; missing transformer = silent arithmetic corruption)

**Proposed fix direction:**

Apply `DecimalTransformer` to the seven meal-engine numeric columns so the entity type and the
runtime type agree at the persistence boundary, then delete the scattered `Number(...)` coercions at
the call sites — those are the compensating shim the transformer exists to make unnecessary. This
matters beyond style because MealFedEvent.actualKg / MealUnderfedEvent.plannedKg are declared
`number` in the contract and validated by JSON Schema `{ type: 'number' }`, so any un-coerced path
emits a payload the gateway bridge fail-closes and drops.

**Affected surface (ripple set):**

- `apps/farm-service/src/feeding-protocol/entities/feeding-meal.entity.ts`
- `apps/farm-service/src/feeding-protocol/entities/feeding-day-plan.entity.ts`
- `apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts`
- `apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts`
- `apps/farm-service/src/feeding-protocol/services/day-plan-recalc.service.ts`

**Expected closer:**

data-expert WRITER mode (entity-only change, no migration needed — the DB type is already numeric)

### DATA-MEDIUM-018

**Title:** JSON Schema validator coverage stops at the gateway bridge subset; cross-service farm
events including the PII-bearing varsling trio are unvalidated at the NATS trust boundary

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `DATA-MEDIUM-008` by `data-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- libs/event-contracts/src/schemas/farm-events.schema.ts:1868 — FarmEventType enumerates 50 types;
  FARM_EVENT_SCHEMAS at :1933 maps exactly those
- libs/event-contracts/src/farm-events.ts:1637 — the FarmEvent union carries ~75 members;
  CleanerFishDeployed/Removed/Transferred/MortalityRecorded/BatchCreated, BatchGraded,
  BatchMetadataUpdated, HarvestRecordUpdated/Cancelled, FeedingRecordUpdated, GrowthSampleRecorded,
  EscapeIncidentRecorded have no schema entry
- libs/event-contracts/src/farm-events.ts:1389 — WelfareEventReported, :1418 EscapeReported, :1464
  DiseaseOutbreakReported cross to notification-service and carry free-text
  description/clinicalSigns/immediateActions plus PII, with no schema entry
- libs/event-contracts/src/schemas/farm-events.schema.ts:13 — the module docstring scopes itself to
  'the farm domain events forwarded by FarmNatsBridgeService', i.e. validation was designed for one
  boundary only

**Rule violated:**

CLAUDE.md Event Contract Rules (add a JSON Schema validator for trust-boundary crossings) \+
DATA-MEDIUM-004 precedent

**Proposed fix direction:**

Treat the farm→NATS publish as the trust boundary rather than the gateway→websocket hop, and
validate on the outbox publish path so a malformed event is rejected before it reaches the
append-only ledger instead of after. Prioritise the three varsling events (they cross a service
boundary, carry uncapped free text, and feed an outbound email template) and the cleaner-fish
quartet. The per-event `JSONSchemaType<T>` annotation already gives compile-time contract-to-schema
drift detection, so extending coverage also buys drift protection for those types.

**Affected surface (ripple set):**

- `libs/event-contracts/src/schemas/farm-events.schema.ts`
- `libs/event-contracts/src/schemas/validator.ts`
- `platform/libs/outbox/src/outbox-publisher.service.ts`
- `apps/notification-service (varsling email consumers)`
- `apps/gateway-api/src/websocket/farm-nats-bridge.service.ts`

**Expected closer:**

data-expert WRITER mode authors the schemas; test-runner enforces coverage

### LOW

### DATA-LOW-019

**Title:** FarmOutbox entity declares a polling index that no migration creates and
synchronize:false guarantees never will

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `DATA-LOW-009` by `data-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/outbox/farm-outbox.entity.ts:19 — @Index('idx_outbox_events_poll_entity',
  ['createdAt'], { where: '"publishedAt" IS NULL AND "isDeadLettered" = false' })
- apps/farm-service/src/outbox/farm-outbox.entity.ts:18 — @Entity({ schema: 'farm', name:
  'outbox_events', synchronize: false })
- apps/farm-service/src/database/migrations/1800700000000-CreateCanonicalOutboxInbox.ts:59 — the
  migration creates the same predicate under a different name, 'idx_outbox_events_poll'

**Rule violated:**

ADR-012 entity↔migration drift prevention; layer-1-typeorm (decorator metadata is the
SchemaDriftValidator's ground truth)

**Proposed fix direction:**

Rename the decorator's index to match the physical index the migration created so entity metadata
and pg_catalog agree — the drift validator reflects decorator metadata, so a name that exists only
in TypeScript is a permanent false signal. No DDL change is required; only the decorator literal
moves.

**Affected surface (ripple set):**

- `apps/farm-service/src/outbox/farm-outbox.entity.ts`

**Expected closer:**

data-expert WRITER mode

### DATA-LOW-020

**Title:** Migration lock/statement-timeout envelope is applied inconsistently and no gate rule
enforces it

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `DATA-LOW-010` by `data-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** not adversarially verified (only CRITICAL/HIGH claims entered the verify stage)

**Evidence:**

- apps/farm-service/src/database/migrations/1802000000000-AddBatchProtocolId.ts — carries the SET
  LOCAL lock_timeout/statement_timeout envelope (4 occurrences), as do 45 other active migration
  files
- tools/gates/migration-sql-lint.ts:350 — the RULES registry implements R1-R12 (destructive marker,
  NOT NULL, index idempotency, session search_path, exception width, replayability) but has no rule
  requiring lock_timeout / statement_timeout
- tools/gates/migration-sql-lint.ts:767 — the gate runs only on migrations ADDED in the change set
  (--diff-filter=A), so the envelope is never retro-checked

**Rule violated:**

data-expert migration envelope invariant (missing SET LOCAL lock_timeout / statement_timeout at the
top of a DDL transaction = MEDIUM); layer-1-typeorm lock management

**Proposed fix direction:**

Add an R13 rule to migration-sql-lint.ts requiring any chunk containing DDL to also set lock_timeout
and statement_timeout, so the majority convention already followed by 46 of 76 farm migrations
becomes the enforced default for new ones rather than author discipline. Existing migrations stay
grandfathered under the gate's ADDED-only policy, which is correct since amending an applied
migration is forbidden.

**Affected surface (ripple set):**

- `tools/gates/migration-sql-lint.ts`
- `tools/gates/migration-sql-lint.spec.ts`
- `apps/farm-service/src/database/migrations/`

**Expected closer:**

infra-expert owns the gate wiring; data-expert authors the rule shape

## Refuted by adversarial verification

These were raised as CRITICAL/HIGH and did **not** survive independent re-checking.
They are recorded so the same claim is not re-raised next cycle.

### ~~DATA-HIGH-001~~

**Title:** The CLAUDE.md-named schema-routing invariant is stale and currently red — its allowlist
omits two entities its own regex flags

**Raised as:** HIGH · **Result:** REFUTED

Mechanism CONFIRMED — I re-implemented the spec's exact filter in Node against apps/farm-service/src
and it returns
['compliance/entities/tenant-erasure-audit.entity.ts','database/entities/audit-log.entity.ts'], so
the spec is genuinely red, and jest.config.ts:15 does exclude `src/**tests**/e2e/` from the default
`test` target (it runs only via jest.integration.config.ts testMatch
'`<rootDir>/src/**tests**/e2e/**/*.architecture.spec.ts`'). But the claim is refuted as HIGH on
three grounds. (1) Not novel and not unguarded: it is already an OPEN, tracked finding —
docs/reviews/orphan-findings.md:4509 'ORPHAN-MEDIUM-118 — farm tenant-routing architecture spec
allowlists only farm-outbox, but its regex also matches two other legitimately cross-tenant farm
tables', Severity: MEDIUM, naming the exact same two entity files. (2) It is documented in the
service's own steering file: apps/farm-service/CLAUDE.md states 'Its schema:\'farm\' allowlist
currently only names the outbox; farm_audit_logs \+ tenant_erasure_audit also legitimately declare
schema:\'farm\' (tracked: ORPHAN-MEDIUM-118)'. (3) Zero production/data impact: both entities are
CORRECT — they are in farm's MODULE_SCHEMAS[].infrastructureTables and MUST carry schema:'farm'; the
load-bearing direction (cross-tenant tables MUST declare schema:) is enforced by
e2e/tests/integration/schema-invariants.spec.ts B.1/B.2, which is green and CI-wired
(.github/workflows/db-migration-check.yml:96). This is stale-test hygiene, already triaged MEDIUM by
a prior audit — not a HIGH.

### ~~DATA-HIGH-002~~

**Title:** Raw operator PII (name/email/phone) in three immutable regulatory events, no crypto-shred
key, and GDPR erasure never sweeps farm.outbox_events

**Raised as:** HIGH · **Result:** REFUTED

Every cited line reads as described (farm-events.ts:1375
RegulatoryContactPerson{navn,epost,telefonnummer}; embedded on the three varsling events;
base-event.ts:162 PII_BEARING_EVENT_TYPES=['PasswordResetRequested']; regulatory-varsling.service.ts
copies kontaktperson verbatim; tenant-erasure.service.ts never DELETEs outbox_events —
FARM_OUTBOX_TABLE at :132 is used only for an idempotency COUNT at :826;
outbox-worker.service.ts:519 GCs only publishedAt `<` now-7d). The HIGH grading is nonetheless
refuted. (a) The claim's own remedy is architecturally excluded by the documented design:
farm-events.ts:1360-1369 states the event carries the full Mattilsynet identity block 'so the
consumer needs no callback into farm-service' — notification-service must render
navn/epost/telefonnummer verbatim into a legally-immediate government email
(`varsling.akva@mattilsynet.no`). Reference-by-ID cannot work across that trust boundary, and
crypto-shredding would destroy a legally-mandated record. (b) The claim asserts a GDPR erasure gap
that contradicts an already-reviewed, already-implemented compliance decision in the very file it
cites: tenant-erasure.service.ts:147-171 (COMPLIANCE-HIGH-003) implements the GDPR Art 17(3)(b)
legal-obligation carve-out — STATUTORY_RETENTION_POLICY marks 'regulatory_reports' as RETAINED,
never hard-deleted, with only submittedBy hashed. The identical kontaktperson block is persisted in
regulatory_reports.payload (regulatory-report.entity.ts:203-204, written at
regulatory-varsling.service.ts recordQueued with payload: input) and is DELIBERATELY kept. Demanding
the transient outbox copy be swept while the authoritative statutory copy is intentionally preserved
is not a coherent GDPR finding. (c) The retention framing is overstated: normal rows are GC'd 7 days
after publish; only dead-lettered rows (publishedAt NULL, `retryCount>=MAX`) persist. (d) No gate is
violated: tests/invariants/pii-events-mandatory-crypto-shred.spec.ts only enforces the forward
direction (entries in PII_BEARING_EVENT_TYPES must declare mandatory cryptoShredKeyId);
base-event.ts:147-151 explicitly labels the reverse PII-field sweep '(Future-extension)'. Residual
real issue: dead-lettered farm outbox rows retain the contact block indefinitely — LOW.

### ~~DATA-HIGH-003~~

**Title:** Both farm NATS listeners swallow handler errors, so the bus ACKs and the mortality alert
\+ harvest traceability follow-ups are lost permanently

**Raised as:** HIGH · **Result:** REFUTED

Mechanism CONFIRMED at the code level: both listeners catch without rethrowing
(harvest-completed.listener.ts:219-230, mortality-recorded.listener.ts:198-208), and
nats-event-bus.ts:1244-1261 only nak()s when a handler THREW, so a resolved handler is acked. But
the HIGH grading and the 'accidental swallow / violates the bus's own rule' framing are refuted. (1)
This is a deliberate, documented, and unit-TESTED design decision, not an oversight:
mortality-recorded.listener.ts:145-149 states 'Errors are logged and swallowed so NATS does not
redeliver a poison message indefinitely', and
`apps/farm-service/src/events/listeners/**tests**/mortality-recorded.listener.spec.ts:228` is an
explicit test named 'swallows downstream errors so NATS does not redeliver a poison message'
asserting handle() resolves. Changing it is a design reversal requiring a test rewrite, not a bug
fix. (2) The cited bus comment (nats-event-bus.ts:1238) is a rule about the BUS layer, and the bus
obeys it — it naks on a thrown handler. It is not a contract the listener is breaking. (3) 'Lost
permanently' overstates the delta: nats-event-bus.ts:1173 sets max_deliver: 3, so rethrowing buys at
most 2 extra bounded retries before the message is terminated anyway — the difference is 1 attempt
vs 3, not durable vs lost. (4) No data corruption: the source writes (mortality record, harvest) are
already committed via the outbox; only the derived alert/traceability follow-up is skipped, and only
on the error path. Real residual: on a transient failure the MortalityAlertRaised /
HarvestRegulatoryRecorded follow-up is dropped after one attempt, and the releaseEvent() comment at
mortality-recorded.listener.ts:200 is misleading — it only helps the crash-before-ack path, never
the caught-error path. That is a MEDIUM reliability/comment-accuracy defect.

### ~~DATA-HIGH-004~~

**Title:** Direct eventBus.publish inside a write transaction with a swallow-catch, in the exact
file shape the farm outbox invariant does not scan

**Raised as:** HIGH · **Result:** REFUTED

The load-bearing half of the claim is factually WRONG. I read
apps/farm-service/src/task/services/auto-rule-trigger.service.ts:113-147 in full: handleEvent()
calls dataSource.createQueryRunner() then queryRunner.connect() and SET search_path — it NEVER calls
startTransaction(), and there is no commitTransaction/rollbackTransaction anywhere in the file (the
finally block only does RESET search_path \+ release()). So the publish at :188-191 is NOT 'inside a
write transaction', the saves at :181/:186 autocommit individually, and the claimed failure mode
'at-most-once on transaction rollback' cannot occur — there is no transaction to roll back.
Secondary refutation: the claim says the writer is 'invisible', but the ESLint rule DOES flag it —
tools/eslint-rules/rules/no-direct-event-publish.ts matches callee.property.name==='publish' with
identifierName(this.eventBus)==='eventBus' (EVENT_BUS_HINTS), and .service.ts under apps/**/src/**
is in the override-9 glob (eslint.config.mjs:469) with no exemption. Its own docstring names this
exact finding and its rollout state: 'Progressive rollout: severity starts at warn ... promotes to
error after the 9-service outbox migration sweep (farm/hr/messaging currently covered — 3/12 per
DATA-HIGH-004)'. So this is a knowingly-scheduled, tier-3-detectable item already carrying the ID
being re-reported, not an undetected HIGH. The invariant-scope observations
(farm-outbox-publish-ssot.spec.ts:42/:56 restricted to `*.handler.ts` containing ICommandHandler)
and the correct sibling at task.service.ts:189 (outboxPublisher.enqueue) are accurate, but the
residual — one direct publish of a non-critical TaskCreated notification that can be dropped on a
NATS blip, already lint-flagged — is LOW.

## Inventory — what exists / what is missing

| Status          | Area                                                                      | Note                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MISSING**     | Event DLQ                                                                 | farm.event_dlq exists as a table with source/tenantId/eventId/error/failedAt columns and two indexes, and is registered in infrastructureTables, but has zero writers and zero readers.                                                                                                                                                                      |
| **MISSING**     | Inbox (durable consumer dedupe ledger)                                    | farm.inbox_messages exists as a table with a (consumerName, tenantId, eventId) unique index and is registered in infrastructureTables, but no entity, repository, or query references it anywhere in the repo. Listeners use volatile Redis setNx instead.                                                                                                   |
| **PARTIAL**     | @Entity schema discipline (per-tenant omit / cross-tenant keep)           | Runtime placement is correct: exactly three entities declare schema:'farm' and all three are in infrastructureTables. The guard spec named by CLAUDE.md is stale and red — see DATA-HIGH-001.                                                                                                                                                                |
| **PARTIAL**     | Consumer-side tenantId guard \+ idempotency                               | Both listeners validate inbound tenantId with isValidUUID and fail closed before any repository work, and wrap side effects in withTenantContext. Idempotency is a Redis setNx claim that fails open when Redis is down, and the surrounding swallow makes redelivery unreachable. See DATA-HIGH-003.                                                        |
| **PARTIAL**     | DecimalTransformer coverage on money/mass columns                         | 51 farm entities use DecimalTransformer on decimal columns, including finance_expense_entries. The two meal-engine entities added most recently use bare numeric with no transformer. See DATA-MEDIUM-007.                                                                                                                                                   |
| **PARTIAL**     | Farm domain state changes with no event                                   | Feed-inventory receive/consume/adjust have declared contracts but no producer, so lot-level feed traceability emits nothing (DATA-MEDIUM-006). Separately weather_settings is registered in TypeOrmModule.forFeature but is a frozen table with no reader or writer — an entity with no read path retained only for existing-tenant schema compatibility.    |
| **PARTIAL**     | JSON Schema validators for farm events                                    | FARM_EVENT_SCHEMAS covers 50 event types with additionalProperties:false and `JSONSchemaType<T>` compile-time drift binding, but is scoped to the gateway websocket bridge. ~25 union members including the PII-bearing varsling trio and the cleaner-fish quartet are unvalidated. See DATA-MEDIUM-008.                                                     |
| **PARTIAL**     | Migration hygiene — lock/statement timeout envelope                       | 46 of 76 active migration files reference lock_timeout/statement_timeout/idle_in_transaction_session_timeout. No gate rule enforces it, so it rests on author discipline. See DATA-LOW-010.                                                                                                                                                                  |
| **PARTIAL**     | Outbox GC                                                                 | Nightly 03:00 cron deletes published rows older than 7 days, running in a system context so tenant RLS does not hide them. Dead-lettered and never-published rows are retained forever by design, which is correct for forensics but means their payloads outlive tenant erasure.                                                                            |
| **PARTIAL**     | Outbox × legal hold / GDPR erasure                                        | LegalHoldService.assertNoHold gates the erasure entry point, and farm_audit_logs are anonymised in place under the Art 17(3)(b) carve-out. But the erasure target plan is derived from moduleSchema.tables only, so outbox_events/inbox_messages/event_dlq rows for an erased tenant are never purged. See DATA-HIGH-002.                                    |
| **IMPLEMENTED** | Entity → MODULE_SCHEMAS classification                                    | All 98 production @Entity declarations under apps/farm-service/src map to a MODULE_SCHEMAS['farm'] entry — tables, referenceDataTables, or infrastructureTables. No unclassified entity, no orphan table in the registry, nothing in `public`.                                                                                                               |
| **IMPLEMENTED** | Flat events (ADR-006) \+ PascalCase eventType                             | No nested payload/metadata wrappers in farm-events.ts; BatchProductionCompleted is explicitly flattened from former nested production/performance objects. All eventType literals are PascalCase.                                                                                                                                                            |
| **IMPLEMENTED** | Hand-edited migration prevention                                          | Gate runs --diff-filter=A only, and manifest comments document renumbering (not body edits) when timestamps collided on main merges. Pre-baseline chain frozen in .archive/2026-05-18T09-42-08-277Z/.                                                                                                                                                        |
| **IMPLEMENTED** | Migration hygiene — blue-green NOT NULL, destructive markers, idempotency | migration-sql-lint.ts R1-R12 gate covers destructive-without-marker, single-step ADD COLUMN NOT NULL, index CONCURRENTLY/IF NOT EXISTS, session search_path, overbroad EXCEPTION, and CREATE TABLE/TYPE/CONSTRAINT/COLUMN replayability. No active farm migration uses CREATE INDEX CONCURRENTLY co-located with other DDL.                                  |
| **IMPLEMENTED** | Migration hygiene — session-scoped SET search_path                        | Zero active migrations carry a bare session-scoped SET search_path. The only occurrence is `SET search_path = pg_catalog` as a CREATE FUNCTION declaration option, which the linter's routine-configuration tokenizer correctly exempts. All remaining hits are in .archive/.                                                                                |
| **IMPLEMENTED** | Migration manifest completeness                                           | manifest.ts FARM_MIGRATIONS lists 76 classes matching the 76 non-archive migration files on disk, in timestamp order, with the pre-baseline chain archived under .archive/. Guarded by tests/invariants/farm-service-migration-array-completeness.spec.ts.                                                                                                   |
| **IMPLEMENTED** | Migration runner registration \+ DATABASE_MIGRATIONS_RUN discipline       | createServiceTypeOrmConfig wires serviceName/schema 'farm' with migrationsRun defaulting false and migrationsRunFromEnv reading DATABASE_MIGRATIONS_RUN (default 'false'); db-migrate container owns production application.                                                                                                                                 |
| **IMPLEMENTED** | Outbox adoption across producers                                          | OutboxPublisher.enqueue is used across ~119 farm files covering batch, site, system, tank, department, equipment, feeding, feeding-protocol, harvest, storage, growth, finance, task, water-quality, regulatory, fish-health and compliance. One remaining direct-publish writer (DATA-HIGH-004) plus three consumer-side derived publishes (DATA-HIGH-003). |
| **IMPLEMENTED** | Outbox idempotency key                                                    | Partial unique index on (tenantId, idempotencyKey) WHERE idempotencyKey IS NOT NULL; used e.g. by the regulatory deadline sweep key `deadline:{draftId}:{bucket}`.                                                                                                                                                                                           |
| **IMPLEMENTED** | SchemaDriftModule registration                                            | SchemaDriftModule.forRoot({ serviceName: 'farm' }) registered in AppModule imports; runtime validator fires at cold start per ADR-012.                                                                                                                                                                                                                       |
| **IMPLEMENTED** | Transactional outbox — table, entity, worker                              | farm.outbox_events with lease columns, retryCount, nextAttemptAt backoff, isDeadLettered flag; OutboxWorkerService drains via LISTEN/NOTIFY plus a 5s cron with FOR UPDATE SKIP LOCKED leases and bounded publish concurrency.                                                                                                                               |
| **IMPLEMENTED** | Upcaster chain                                                            | batchHarvestedUpcaster registers the v1→v2 identity bump for the additive isFinal field, and the producer correctly mints version: 2. The upcaster deliberately does not fabricate isFinal, leaving the tolerant-reader default on the consumer.                                                                                                             |
| **IMPLEMENTED** | createBaseEvent / branded EventId                                         | Every farm event construction site inspected spreads createBaseEvent — no inline event literal in production code. The two direct-publish sites also use the factory, so the branded-EventId compile gate holds even where the outbox is bypassed.                                                                                                           |
| **IMPLEMENTED** | data-source.ts (TypeORM CLI entry)                                        | Present with schema:'farm', synchronize:false, migrationsRun:false, and a docstring explaining operator-only scope. Closes the prior DATA-MEDIUM-005 cycle finding.                                                                                                                                                                                          |
| **IMPLEMENTED** | tenantId column typing \+ indexing                                        | Every farm entity inspected declares tenantId as @Column('uuid') with a dedicated @Index plus composite (tenantId, …) indexes. One entity uses the snake_case physical name tenant_id, which apply-tenant-rls.helper's DEFAULT_TENANT_ID_COLUMNS already handles.                                                                                            |

## Verdict

CONDITIONAL

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/data-expert.md`
- Rule SSoT: `CLAUDE.md`
