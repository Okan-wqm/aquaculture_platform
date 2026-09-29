# Farm data sources for tasks and tracking — farm-expert, 2026-09-29

Raised in the 2026-09-29 adversarial review of the ai-service program plan (automatic tasks,
tracking agents, AI configuration). Four reviewers (alert-engine, AI safety, farm domain,
architecture) attacked plan rev 2 against origin/main `dae95efb3`; the main session re-verified the
load-bearing claims in code, and ALERT-CRITICAL-004 on the live database. Later entries
(MT-HIGH-064, MT-MEDIUM-065, ALERT-CRITICAL-009, FARM-MEDIUM-355) come from the implementation
lanes. Each finding names the plan PR that closes it.

## FARM-HIGH-334

Mortality daily-rate check never counts today's deaths: recordDate is a date column filtered with
MoreThan(local midnight).

- **Severity:** HIGH. **Deadline:** 2026-10-15. **Closes in:** plan PR-S1.
- **Evidence:** `apps/farm-service/src/events/listeners/mortality-recorded.listener.ts:282` —
  MoreThan(today) on a date column.
- **Rule:** Correct alarm arithmetic.

Static reading; Postgres proof is part of plan PR-S1. Cumulative-rate re-fires on every later record
(same listener).

## FARM-HIGH-335

Low-stock surfaces compare the denormalized catalog quantity instead of the storage ledger, and the
ledger sum ignores sites.

- **Severity:** HIGH. **Deadline:** 2026-10-31. **Closes in:** plan PR-B1a-1.
- **Evidence:** `apps/farm-service/src/storage/handlers/get-warehouse-summary.handler.ts:208` —
  f.quantity <= f.minStock on the catalog row.
- **Rule:** Single stock SSoT (ledger).

Ledger SUM at stock-movement.service.ts:387 is tenant-wide. Closed by plan PR-B1a-1.

## FARM-HIGH-336

minStock exists only on the tenant-wide item catalog while inventory is per site, and
LowStockDetected carries no siteId.

- **Severity:** HIGH. **Deadline:** 2026-10-31. **Closes in:** plan PR-B1a-1.
- **Evidence:** `apps/farm-service/src/feed/entities/feed.entity.ts:235` — catalog-level minStock,
  no site dimension.
- **Rule:** Per-site stock truth (plan K8).

Closed by plan PR-B1a-1 (storage_item_site_policies + two-tier evaluator).

## FARM-HIGH-337

Item update inputs inherit quantity from the create input, so feed, chemical and consumable
quantities can be overwritten outside the ledger.

- **Severity:** HIGH. **Deadline:** 2026-10-31. **Closes in:** plan PR-B1a-1.
- **Evidence:** `apps/farm-service/src/feed/dto/update-feed.input.ts:10` — PartialType of the create
  input that carries quantity.
- **Rule:** Ledger is the only writer of quantity.

Same for chemical/consumable update inputs. minStock changes do not recompute status. Closed by plan
PR-B1a-1.

## FARM-HIGH-338

Spare-part stock is a mutable counter with no persisted movements, so its quantity cannot be audited
or trusted.

- **Severity:** HIGH. **Deadline:** 2026-10-31. **Closes in:** plan PR-B1a-1.
- **Evidence:** `apps/farm-service/src/maintenance/services/spare-part.service.ts:241` — quantity
  mutated in place.
- **Rule:** Stock ledger SSoT.

Closed by plan PR-B1a-1 (spare parts join the storage ledger).

## FARM-HIGH-339

The AutoRule engine is inert: its NATS subscription fails name validation silently, nothing
publishes its events, it sets no RLS context and the UI button is unbound.

- **Severity:** HIGH. **Deadline:** 2026-11-15. **Closes in:** plan PR-B1a-2.
- **Evidence:** `apps/farm-service/src/task/services/auto-rule-trigger.service.ts:1` — in-process
  event map, session-level search_path.
- **Rule:** Working automatic task creation.

Live DB: 0 rules, 0 auto tasks. Closed by plan PR-B1a-2 (reconciler).

## FARM-HIGH-340

Unionized ammonia (NH3) and DO saturation are never derived: operators measure TAN, so toxic NH3 is
never evaluated although the engines exist.

- **Severity:** HIGH. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0a.
- **Evidence:**
  `apps/farm-service/src/water-quality/services/water-quality-evaluation.service.ts:66` — raw
  parameters vs static bands only.
- **Rule:** Correct water-chemistry evaluation.

calcNH3/doSaturationWeiss exist in libs/aquaculture-engines. Closed by plan PR-C0a.

## FARM-HIGH-341

Water-quality limits exist only tenant-wide and speciesLimits is never applied, so a sea-cage site
and a freshwater RAS hatchery share one DO/pH/salinity band.

- **Severity:** HIGH. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0b.
- **Evidence:**
  `apps/farm-service/src/water-quality/services/water-quality-evaluation.service.ts:100` —
  speciesCode never passed.
- **Rule:** Single hierarchical threshold owner.

Closed by plan PR-C0b (EffectiveLimitResolver).

## FARM-MEDIUM-342

Tank density defaults disagree (25 vs 30 kg/m3) and stored density goes stale as growth is applied.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0a.
- **Evidence:** `apps/farm-service/src/tank/handlers/get-tank-capacity.handler.ts:54` — || 25
  fallback vs DEFAULT_MAX_DENSITY_KG_M3=30.
- **Rule:** Single capacity SSoT.

Closed by plan PR-C0a.

## FARM-MEDIUM-343

Health events (disease outbreak, symptoms, treatments) publish no domain event, so no service can
react to them.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0a.
- **Evidence:** `apps/farm-service/src/fish-health/services/health-event.service.ts:1` — no outbox
  publish on create/status change.
- **Rule:** Event-driven integration.

Closed by plan PR-C0a (HealthEventRecorded).

## FARM-MEDIUM-344

System water-quality statistics read the legacy tanks.systemId and filter by tank, dropping
sump/biofilter measurement points and averaging away the worst tank.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0a.
- **Evidence:**
  `apps/farm-service/src/water-quality/query-handlers/get-system-water-quality-statistics.handler.ts:39`
  — legacy tanks.systemId membership.
- **Rule:** One hierarchy membership source.

Closed by plan PR-C0a (ResolveTrackingScope).

## FARM-MEDIUM-345

Mortality alarm thresholds and the feed-stockout critical window are hardcoded constants with no
tenant or species owner.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0b.
- **Evidence:** `apps/farm-service/src/events/listeners/mortality-recorded.listener.ts:71` —
  DEFAULT_THRESHOLDS.
- **Rule:** Threshold SSoT.

FEED_STOCKOUT_CRITICAL_DAYS likewise. Moves onto EffectiveLimitResolver after plan PR-C0b.

## FARM-MEDIUM-346

Inert copies of water limits live outside the owner: species optimalConditions, sensor channel
alertThresholds, the AI tool NH3 limit, MCP H2S guidance and dashboard gauge ranges.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0b.
- **Evidence:** `apps/farm-service/src/species/entities/species.entity.ts:388` — optimalConditions
  never evaluated.
- **Rule:** Single threshold owner.

Closed by plan PR-C0b.

## FARM-MEDIUM-347

Fish weight bands for feed selection exist twice: feeding-protocol-v2 bands and the legacy
batch_feed_assignments.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0a.
- **Evidence:** `apps/farm-service/src/batch/entities/batch-feed-assignment.entity.ts:36` — legacy
  band copy.
- **Rule:** Single feed-band SSoT.

protocol-v2 is the owner. Closed by plan PR-C0a.

## FARM-LOW-348

water_quality_param_equipment.alertEnabled is stored but never read.

- **Severity:** LOW. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0a.
- **Evidence:**
  `apps/farm-service/src/water-quality/entities/water-quality-param-equipment.entity.ts:127` —
  unread flag.
- **Rule:** No dead configuration.

Closed by plan PR-C0a (honoured or removed).

## FARM-MEDIUM-349

RecurringTaskService runs every tenant in one transaction without savepoints and sets a
session-level search_path without RLS context.

- **Severity:** MEDIUM. **Deadline:** 2026-11-15. **Closes in:** plan PR-B1a-2.
- **Evidence:** `apps/farm-service/src/task/services/recurring-task.service.ts:188` — SET
  search_path on a pooled connection.
- **Rule:** Tenant transaction discipline.

One failing template rolls back the tenant's other templates. Closed by plan PR-B1a-2.

## FARM-LOW-350

detectOverdueTasks compares a date-only due date with UTC now, so tasks due today can be marked
OVERDUE early.

- **Severity:** LOW. **Deadline:** 2026-11-15. **Closes in:** plan PR-B1a-2.
- **Evidence:** `apps/farm-service/src/task/services/task.service.ts:734` — UTC now vs local due
  date.
- **Rule:** Site-local dates.

Closed by plan PR-B1a-2.

## FARM-LOW-351

Tanks exist in two models (legacy tanks table and Equipment-as-tank) that share ids but not
placement or capacity fields.

- **Severity:** LOW. **Deadline:** 2026-12-31. **Closes in:** plan PR-C0a.
- **Evidence:** `apps/farm-service/src/tank/entities/tank.entity.ts:196` — legacy tanks table.
- **Rule:** Single tank model.

Plan H4: Equipment is the SSoT; C0a routes all AI/evaluator reads through it; dropping tanks is
tracked here.

## FARM-LOW-352

Site licences, permits and insurance have no data model, so their expiry cannot drive tasks.

- **Severity:** LOW. **Deadline:** 2026-12-31. **Closes in:** owner decision.
- **Evidence:** `apps/farm-service/src/batch/entities/batch-document.entity.ts:130` — batch
  documents are the only expiring document type.
- **Rule:** Product decision required.

Owner product decision (Okan).

## FARM-LOW-353

Systems have no responsible user, so system-level alerts and suggestions can only route to the
department manager.

- **Severity:** LOW. **Deadline:** 2026-12-31. **Closes in:** owner decision.
- **Evidence:** `apps/farm-service/src/system/entities/system.entity.ts:79` — no responsible-user
  column.
- **Rule:** Product decision required.

Owner product decision (Okan).

## FARM-MEDIUM-354

The only AI-confirmable farm write is createTask; transfers, grading, feed changes and purchase
drafts have no confirmable write path.

- **Severity:** MEDIUM. **Deadline:** 2026-12-31. **Closes in:** plan PR-C4.
- **Evidence:** `infrastructure/nats/services.yaml:148` — request.farm.createTask is the only AI
  write subject.
- **Rule:** Human-confirmed decision support.

Closed by plan PR-C4 except transfer/grading which need capacity and override-audit rules.

## FARM-MEDIUM-355

Mortality recordDate is derived from an ambiguous observedAt: the web sends a picked date, the
mobile app an instant, so the stored business day is the UTC date and is wrong around local midnight
for non-UTC sites.

- **Severity:** MEDIUM. **Deadline:** 2026-10-31. **Closes in:** plan PR-S1b.
- **Evidence:** `apps/farm-service/src/batch/handlers/record-mortality.handler.ts:242` — recordDate
  taken from observedAt.
- **Rule:** Site-local business days.

Found by the PR-S1 implementer. Fix splits the contract into observedAt (instant) and recordDate
(site-local LocalDate) across GraphQL, web and aquamobil. Closed by plan PR-S1b.
