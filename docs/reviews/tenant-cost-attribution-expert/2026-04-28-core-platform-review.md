# tenant-cost-attribution-expert — review — 2026-04-28 (core-platform cycle)

## Scope

Per-tenant cost-attribution pipeline across:

- `libs/backend-common/src/metrics/**` — emit-side: HTTP histogram + tenant labelling, the `orchestrator-metrics.ts` SSoT.
- `apps/observability-service/**` — declared primary surface for rollup pipeline (`cost-attribution/**`, agent file). Reality: only the migration shipped.
- `apps/observability-service/src/database/migrations/1805000000000-AddTenantCostRollup.ts` — rollup hypertable (orphaned).
- `apps/billing-service/src/modules/metering/**` — usage meters + tiered pricing (parallel meter with no link to rollup).
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts` + `billing-scheduler.service.ts` — Stripe ingress + monthly invoice cron.
- `apps/ai-service/src/agent/agent-runner.service.ts` + `apps/ai-service/src/cost/token-budget.service.ts` — Claude SDK token capture.
- `apps/alert-engine/**` — plan-tier margin SLO + cost-explosion alert wiring (declared in migration commentary, never implemented).
- `infrastructure/monitoring/prometheus/**` — cost recording rules (file declared in agent spec, missing on disk).

Triggered as part of the core/cross-cutting (auth/tenant/billing) review cycle. Coordinates with sibling findings `PLAT-CRITICAL-001` / `MT-CRITICAL-004` (unbounded `tenant` label) and `BILLING-CRITICAL-002/003` (PLAN_LIMITS dead code, METER_RACE).

## Executive summary

The cost-attribution pipeline as specified by this agent's primary-ownership chart and by the `1805000000000-AddTenantCostRollup` migration commentary is **structurally absent**. Migration ships a TimescaleDB hypertable + RLS policy at production scale, but **zero application code reads or writes it** — no entity, no service, no rollup job, no reconciliation cron, no API. The hypertable is a phantom asset that will accumulate retention pressure on a TimescaleDB chunk worker without ever serving a query.

Three fundamental control loops are unimplemented end-to-end:

1. **Emit → Rollup**: Anthropic SDK token consumption at `agent-runner.service.ts:204-207` updates only `TokenBudget` (Redis monthly counter); no Prometheus emission, no NATS event, no insert into `tenant_cost_rollup`. The other 11 cost categories (compute, storage, NATS, notifications, network egress) have **no emission site at all**.
2. **Rollup → Reconciliation**: `billing-scheduler.service.ts` generates monthly invoices using only the **subscription base price** (`sub.pricing.basePrice`); meter aggregation from `usage-metering.service.ts` is **never read** by invoice generation; Stripe `invoice.total` is **never compared** to either meter or rollup.
3. **Anomaly → Circuit-breaker**: zero implementation of per-tenant cost-explosion isolation. A prompt-injection-driven token explosion or an MQTT firehose has no platform-side throttle keyed on cost.

Top three blockers: `TENANTCOST-CRITICAL-001` (orphan hypertable / pipeline absence), `TENANTCOST-CRITICAL-002` (Stripe revenue leak — meter ↔ invoice disconnect), `TENANTCOST-HIGH-001` (no per-tenant cost circuit breaker).

## Findings (by severity)

### CRITICAL

#### TENANTCOST-CRITICAL-001 — Cost-attribution pipeline structurally absent (orphan rollup hypertable)

**Severity:** CRITICAL
**Layer:** 2 (architectural pattern absent) + 3 (ADR-011 schema-ownership)
**State:** OPEN
**Sub-kind:** `ROLLUP_MISS`

**Evidence**
- `apps/observability-service/src/database/migrations/1805000000000-AddTenantCostRollup.ts:84-127` — table + indexes + RLS shipped.
- `apps/observability-service/src/database/entities/` — only `migration-event`, `schema-object-history`, `migration-backfill-progress`, `emergency-override`. **No `tenant-cost-rollup.entity.ts`.**
- `apps/observability-service/src/` — directory listing has `metrics/`, `prometheus/`, `tracing/`, `security-events/`, `migration-audit/`, `gdpr/`, `retention/`, `health/`. **No `cost-attribution/` folder** despite agent spec declaring it as primary ownership.
- Repo-wide: zero TS reference to `tenant_cost_rollup` outside the migration file and a stale comment in `libs/backend-common/src/metrics/orchestrator-metrics.ts:38`.
- `MeteredBillingService.calculateBilling()` at `apps/billing-service/src/modules/metering/metered-billing.service.ts:647-759` reads from `UsageAggregatorService.getAggregationsInRange` (in-process aggregation) — does not touch `tenant_cost_rollup`.

**Rule violated**
- Agent operating spec: "primary ownership — `apps/observability-service/src/cost-attribution/**` (rollup pipeline, per-tenant cost aggregator)" — surface does not exist.
- Migration commentary at `1805000000000-AddTenantCostRollup.ts:11-17` declares three consumers (`tenant-cost-attribution-agent`, observability dashboards, alert-engine cost-explosion) — **none wired**.
- Layer-2 outbox/projection discipline: the rollup is a projection target with no projection writer. ADR-011 schema-ownership (`observability` schema) requires a service that owns its tables.

**Proposed fix direction**
- Tier-1 — define `TenantCostRollup` entity + `TenantCostRollupRepository` in `apps/observability-service/src/cost-attribution/`. Make the table reachable from typed code only; banned to write from raw SQL outside this module.
- Tier-2 — `CostAttributionWorker` (NestJS `@Cron`) computes hourly buckets from emitted Prometheus counters + a `cost_catalog` price table; UPSERT keyed on the existing `(bucket, tenant_id, cost_category, cost_subcategory)` UNIQUE constraint.
- Tier-3 — adoption-invariant test (`tests/invariants/cost-attribution-pipeline.spec.ts`) asserts: every cost category enumerated in the migration's CHECK constraint has an emitter registered, and the rollup table is read by ≥1 query handler.
- Until the writer lands, **do not** keep the migration in production: remove the retention worker risk by gating on `COST_ATTRIBUTION_PIPELINE_ENABLED=false` until the implementation closes.

**Affected surface (ripple set)**
- `apps/observability-service/src/cost-attribution/{entities,services,workers,query-handlers,module}.ts` (new)
- `apps/observability-service/src/cost-attribution/cost-catalog/{cost-catalog.entity.ts,cost-catalog.seed.ts}` (new)
- `apps/observability-service/src/database/migrations/180600XXXXXXX-AddCostCatalog.ts` (new — pricing table referenced in agent spec, also missing)
- `apps/observability-service/src/app.module.ts` (register module)
- `tests/invariants/cost-attribution-pipeline.spec.ts` (new)

**Expected closer**
- `implementation-planner` composes a multi-skill DAG: `add-entity` (rollup) → `add-entity` (catalog) → `add-cron-worker` (rollup) → invariant-test. CATCHER on output: this agent + data-expert (hypertable + RLS + migration sequencing).

---

#### TENANTCOST-CRITICAL-002 — Stripe ↔ meter ↔ rollup three-way reconciliation does not exist (revenue leak)

**Severity:** CRITICAL
**Layer:** 2 (event-driven cross-service consistency) + 3 (ADR-006 outbox semantics)
**State:** OPEN
**Sub-kind:** `STRIPE_DRIFT`

**Evidence**
- `apps/billing-service/src/billing/billing-scheduler.service.ts:283-352` — monthly invoice generation builds line items **only from `sub.pricing.basePrice`** (line 285: `const basePriceMoney = Money.of(sub.pricing.basePrice || 0, pricingCurrency)`). No meter read, no rollup read, no Stripe metered-usage report, no overage line.
- `apps/billing-service/src/modules/metering/usage-metering.service.ts` — captures usage per `MeterType`, persists to Redis. **Has no consumer in the invoice path.** The `metered-billing.service.ts` `calculateBilling` is invoked by **zero callers in production code paths** (only by `__tests__/`).
- `apps/billing-service/src/billing/controllers/stripe-webhook.service.ts:43-185` — handles `payment_intent.succeeded` by writing `Payment` rows; **never compares `invoice.total` to a cost-side authority.** No `invoice.finalized` handler that detects drift between `tenant_cost_rollup` SUM and Stripe-side `invoice.total`.
- Stripe SDK call surface: `grep -r "stripe.subscriptionItem|reportUsage|MeterEvent"` in `apps/billing-service/src` returns ZERO matches → no metered-usage push to Stripe either.

**Rule violated**
- Agent invariant: *Monthly reconciliation job: compare `observability.tenant_cost_rollup` monthly SUM vs Stripe `invoice.total` per tenant. Drift > 1% = MEDIUM, > 5% = HIGH.* Job does not exist; even the comparison primitives (rollup query, Stripe invoice fetch) are not wired.
- Three independent meters (Redis tenant-meter / observability rollup / Stripe invoice) with no consistency check is a textbook revenue-leak class.

**Proposed fix direction**
- Tier-1 — define a single SSoT for meterable usage events at the trust boundary (`UsageEvent` typed event in `@platform/event-contracts`). Both billing meter Redis state AND observability rollup feed from the same NATS stream so they cannot diverge by construction.
- Tier-2 — `CostReconciliationCron` (monthly, day-3 after period close) fetches Stripe `invoice.total` per tenant, queries `tenant_cost_rollup` SUM, computes drift, emits `BillingDriftDetected` event; alert-engine routes >5% to PagerDuty.
- Tier-3 — invariant test asserts: every `MeterType` enum value in `usage-metering.service.ts` has a corresponding `cost_category` entry in the rollup CHECK constraint; orphan meter type fails CI.
- Reconciliation report written to `docs/reports/cost-reconciliation/<YYYY-MM>.md` per agent spec — currently no such directory.

**Affected surface (ripple set)**
- `libs/event-contracts/src/billing-events.ts` — add `UsageMeteredEvent`, `BillingDriftDetectedEvent`
- `apps/billing-service/src/modules/metering/usage-metering.service.ts` — emit `UsageMeteredEvent` on each `processEvent`
- `apps/billing-service/src/billing/services/cost-reconciliation.service.ts` (new)
- `apps/billing-service/src/billing/billing-scheduler.service.ts` — wire metered usage into invoice line items (the `BILLING-CRITICAL-003 METER_RACE` finding from the sibling agent compounds here)
- `apps/observability-service/src/cost-attribution/cost-reconciliation.controller.ts` (read-side for billing-side comparison)
- `apps/alert-engine/src/rules-engine/cost-drift.rule.ts` (new alert rule)

**Expected closer**
- billing-expert primary (Stripe side); this agent secondary (rollup query + drift threshold). Joint CATCHER, since the design crosses two ownership lines.

---

### HIGH

#### TENANTCOST-HIGH-001 — Per-tenant cost-explosion circuit breaker is not implemented anywhere

**Severity:** HIGH
**Layer:** 2 (resilience pattern) + 4 (documented but unenforced)
**State:** OPEN
**Sub-kind:** `CIRCUIT_MISSING`

**Evidence**
- `grep -rE "circuit.?breaker|CircuitBreaker"` in `apps/observability-service/src`, `apps/billing-service/src`, `apps/ai-service/src` returns **zero matches** (all hits are inside `.claude/worktrees/` and refer to the Rust edge gateway's Modbus circuit breaker — unrelated).
- `apps/ai-service/src/cost/token-budget.service.ts:107-132` — only `checkBudget()` returns `{allowed, used, remaining}`. The budget primitive is monthly-aggregate; no hourly cost-projection check, no plan-budget-cap × 1.5 trip threshold, no degraded-mode broadcast.
- `apps/ai-service/src/agent/agent-runner.service.ts:80-90` — `chat()` enforces budget pre-call only; once budget is `allowed` the loop runs up to `maxToolLoops=10` without a per-call cost ceiling. Combined with prompt-injection (which the AI safety pipeline at `aiSafety.preProcess` blocks for content but not for cost), one tenant can drain the per-tenant monthly Anthropic budget in minutes without any circuit-breaker reaction.
- No `TenantCostExplosion` event in `libs/event-contracts/src/`.
- `apps/alert-engine/src/` — no rule keyed on cost; only sensor / water-quality alerts.

**Rule violated**
- Agent operating spec: *Per-tenant cost circuit breaker: when hourly compute_cost_dollars + claude_cost_dollars projected to exceed plan_budget_cap × 1.5, automatic actions: (1) non-critical expensive operations disabled for tenant, (2) `TenantCostExplosion` event + tenant-admin notification, (3) circuit breaker state persisted; reset requires tenant-admin acknowledgment.* None implemented.
- CLAUDE.md tier-hierarchy — currently Tier-4 (documented in agent spec only).

**Proposed fix direction**
- Tier-1 — `TenantCostBreakerService` per-tenant state machine in `apps/observability-service/src/cost-attribution/` with `OPEN | HALF_OPEN | CLOSED` keyed on `(tenantId, hourly_projection_$)`. State persisted to Redis with cluster-wide consistency (use the same WATCH/MULTI pattern the metering service has).
- Tier-2 — guards on expensive entry points (`agent-runner.service.ts.chat()`, bulk-export controller, report generator) check `breakerService.isOpen(tenantId)` before enqueuing; trip = 503 with `Retry-After: <next-budget-window>`.
- Tier-3 — invariant test enumerates every `cost_category` in the rollup CHECK and asserts an emit-side entry point exists with a breaker check.
- Reset path documented in `docs/runbooks/tenant-cost-breaker-reset.md` (new).

**Affected surface (ripple set)**
- `apps/observability-service/src/cost-attribution/cost-breaker.service.ts` (new)
- `libs/event-contracts/src/billing-events.ts` — add `TenantCostExplosionEvent`
- `apps/ai-service/src/agent/agent-runner.service.ts:62-90` — replace local `checkBudget` with breaker call
- `apps/admin-api-service/src/billing/cost-breaker.controller.ts` (acknowledge endpoint)
- `apps/notification-service/**` — tenant-admin notification template
- `apps/alert-engine/src/rules-engine/cost-explosion.rule.ts` (new)

**Expected closer**
- `circuit-breaker-auditor` is also reviewing this surface — coordinate via Phase 4 arbiter on the breaker primitive (whether to share a generic breaker or keep cost-specific). Joint CATCHER: this agent + circuit-breaker-auditor + ai-safety-auditor (for the AI entry point).

---

#### TENANTCOST-HIGH-002 — AI-token cost emission gap (Anthropic SDK consumes tokens, never instruments cost)

**Severity:** HIGH
**Layer:** 1 (Anthropic SDK contract; layer-1-ai.md) + 2 (event flat pattern)
**State:** OPEN
**Sub-kind:** `METRIC_LABEL_GAP`

**Evidence**
- `apps/ai-service/src/agent/agent-runner.service.ts:195-207` — Anthropic SDK call captures `response.usage.input_tokens`, `response.usage.output_tokens`. **No** capture of `cache_read_input_tokens`, `cache_creation_input_tokens` (Anthropic SDK 0.2.x exposes both per layer-1-ai.md cost knobs). Only `total = input + output`.
- `agent-runner.service.ts:319` — token total is fed to `tokenBudget.addUsage(tenantId, total)` (Redis monthly counter). No Prometheus counter, no `tenant_claude_tokens_total{tenant_id, model, token_type}` metric, no rollup row, no `claudeApiCallTotal` (the SSoT counter at `libs/backend-common/src/metrics/orchestrator-metrics.ts:114-119` is unwired here).
- Model identity (`profile.persona.model`) is not captured for cost — different models (Opus / Sonnet / Haiku) have 10x cost spread; without `model` label the rollup cannot price-correctly.
- Cache-hit rate cannot be observed → cache-strategy regressions invisible (and cache-misses are *3.75x* the cost of cache-reads on Sonnet, 12.5x on Opus per layer-1-ai.md).

**Rule violated**
- Agent operating spec: *`tenant_claude_tokens_total{tenant_id, model, token_type}` — Anthropic SDK token spend (input/cache_read/cache_creation/output)* — metric not registered, never incremented.
- layer-1-ai.md prompt-caching cost knob discipline.
- ADR-006 event flat pattern — should also emit `ClaudeTokensConsumedEvent` for cross-service rollup.

**Proposed fix direction**
- Tier-2 — register the four token-type `tenant_claude_tokens_total` counters in `orchestrator-metrics.ts`, increment per Anthropic response with the `(tenantId, model, token_type)` triple. Pair with `claudeApiCallTotal{model}` and `claudeApiLatencySeconds{model}` (already declared but unwired).
- Tier-1 — wrap Anthropic SDK call in a thin `AnthropicCostInstrumentor` so future call-sites cannot bypass the emission. Make the bare SDK import banned outside the wrapper via ESLint `no-restricted-imports` (extend the rule already in place for `eventBus.publish`).
- Tier-3 — invariant test on `apps/ai-service/src/**` greps for direct `anthropic.messages.create` calls; only the wrapper is allowed.

**Affected surface (ripple set)**
- `libs/backend-common/src/metrics/orchestrator-metrics.ts` — add token-family counters
- `apps/ai-service/src/cost/anthropic-cost-instrumentor.ts` (new)
- `apps/ai-service/src/agent/agent-runner.service.ts:53-55, 195-207` — route through wrapper
- `libs/event-contracts/src/ai-events.ts` — add `ClaudeTokensConsumedEvent`
- `tests/invariants/anthropic-sdk-wrapper.spec.ts` (new)

**Expected closer**
- ai-safety-auditor primary; this agent secondary. Pair-review invariant: do not route WRITER back to ai-safety-auditor's TEACHER track.

---

#### TENANTCOST-HIGH-003 — `tenant` Prometheus label is spoofable (header fallback) AND an unbounded-cardinality landmine

**Severity:** HIGH
**Layer:** 2 (cardinality budget) + 3 (ADR-011 tenant-context provenance)
**State:** OPEN
**Sub-kind:** `METRIC_LABEL_GAP`

**Evidence**
- `libs/backend-common/src/metrics/metrics.middleware.ts:39-44` — tenant resolution order is `req.tenantId || req.headers['x-tenant-id'] || 'system'`. Pre-auth requests with attacker-controlled `x-tenant-id` write into the metric series for an arbitrary tenant.
- `metrics.service.ts:60,68` — `labelNames: ['method', 'route', 'status_code', 'tenant']` — full cardinality `methods × routes × statuses × tenants`. The 100-tenant-target comment at `metrics.service.ts:111-112` is a soft assertion; nothing prevents a 1000-tenant deployment.
- Sibling agents have raised the same label as `PLAT-CRITICAL-001`/`MT-CRITICAL-004` (Tier-1 fix proposed: remove the label entirely + JWT-bind tenantId).
- Direct collision with this agent's domain: removing the `tenant` label is the right cardinality fix BUT removes the rollup's Prometheus-side input dimension → the `CostAttributionWorker` (TENANTCOST-CRITICAL-001 fix) cannot use Prometheus `tenant` label as the rollup pivot.

**Rule violated**
- Agent operating spec: *Forbidden label set on general metrics: `tenant_id` as a raw label (cardinality explosion). Use a separate cost-dedicated metric family `tenant_cost_*` that CAN carry `tenant_id` label but is scraped less frequently + routed to push-gateway + long-term storage.* — no separate family exists; the unsafe label sits on the general histogram.
- ADR-011 / W1 audit — tenant-id provenance must be JWT-anchored, not header-defaulted.

**Proposed fix direction (joint with sibling findings)**
- Tier-1 — split metric families: keep general HTTP metrics WITHOUT `tenant` label; introduce `tenant_cost_*{tenant_id, ...}` family scraped at 60s push-gateway only, with explicit cardinality budget. JWT-bind tenantId for both families.
- Tier-2 — pipe rollup input from the cost-dedicated family alone; general metrics aggregate by `service` only.
- Tier-3 — extend the existing `no-high-cardinality-metric-label` ESLint rule (referenced in `orchestrator-metrics.ts:16`) to enforce: (a) the `tenant` label appears only on metric names matching `^tenant_cost_*`; (b) header fallback for tenantId on metrics is forbidden — only JWT claim or trusted internal-service identity.
- Joint resolution with `PLAT-CRITICAL-001` and `MT-CRITICAL-004` is mandatory: solving cardinality without preserving cost-rollup attribution = our pipeline breaks; preserving the unsafe label keeps the DoS open.

**Affected surface (ripple set)**
- `libs/backend-common/src/metrics/metrics.service.ts` — drop `tenant` from general metrics
- `libs/backend-common/src/metrics/metrics.middleware.ts` — remove header fallback path
- `libs/backend-common/src/metrics/cost-metrics.ts` (new)
- `infrastructure/monitoring/prometheus/cost-metrics.yml` (new — referenced in agent spec, currently missing)
- ESLint custom rule + invariant test
- 5 services with `labelNames: [..., 'tenant']`: `messaging-metrics.service.ts`, `farm-domain-metrics.service.ts`, `gateway-api/farm.gateway.ts` — same audit, ripple.

**Expected closer**
- observability-expert primary on cardinality; this agent + multi-tenant-saas-expert + auth-security-expert co-CATCHERs (provenance + fix path). Architectural-arbiter ruling required because ≥3 agents own slices.

---

#### TENANTCOST-HIGH-004 — `cost_catalog` price table absent — rollup migration's "tokens × model_price" formula is uncomputable

**Severity:** HIGH
**Layer:** 2 (data lineage)
**State:** OPEN
**Sub-kind:** `ROLLUP_MISS`

**Evidence**
- Agent operating spec: *Cost conversion: `tokens × model_price` / `bytes × storage_price` / `seconds × compute_price` — prices in a `cost_catalog` table, versioned by `effective_from` (no retroactive price change).*
- `grep -rE "cost_catalog|cost.catalog"` in `apps/`, `libs/` returns zero matches (workspace excluding worktrees).
- Migration file count check: `apps/observability-service/src/database/migrations/` contains 5 migrations; no `*-AddCostCatalog.ts`.
- Without the catalog the rollup cannot translate `meter_primary` (tokens) to `cost_usd`, which means even if TENANTCOST-CRITICAL-001 lands a writer, the cost column will be 0 or hard-coded.

**Rule violated**
- Agent invariant on rollup pipeline (catalog versioning required for retroactive-pricing prevention).
- Layer-2 data-lineage discipline — pricing is a slowly-changing dimension; without versioning, replays produce wrong totals.

**Proposed fix direction**
- Tier-1 — `CostCatalog` entity in `apps/observability-service/src/cost-attribution/` with `(category, subcategory, effective_from, effective_to, unit_price_usd, source)` and a constraint that current-prices are unique per `(category, subcategory)` and historical rows are immutable.
- Tier-2 — seed with current Anthropic pricing per `model`, DO compute pricing per droplet size, MinIO storage rate, Stripe webhook event cost, NATS JetStream rate. Seed data ships in a separate migration so the price-curve is a tracked artifact.
- Tier-3 — invariant test asserts every `cost_category` enum value has at least one current `effective_to IS NULL` catalog row.

**Affected surface (ripple set)**
- `apps/observability-service/src/cost-attribution/cost-catalog/{entity,seed,service}.ts` (new)
- `apps/observability-service/src/database/migrations/180600XXXXXXX-AddCostCatalog.ts` (new)
- ADR amendment (the agent spec is the only doc; migrating to ADR keeps pricing decisions auditable).

**Expected closer**
- data-expert primary (catalog table is data-design); this agent CATCHER on rollup-formula correctness.

---

#### TENANTCOST-HIGH-005 — Plan-tier margin SLO and alert wiring entirely undefined

**Severity:** HIGH
**Layer:** 3 (ADR-016 SLO discipline) + 4 (documented in agent spec only)
**State:** OPEN
**Sub-kind:** `MARGIN_BREACH`

**Evidence**
- `infrastructure/monitoring/prometheus/alerts/slo-alerts.yml` exists (per `find` output) but contains NO rule keyed on `tenant_cost_*`, plan-tier, or margin %.
- Agent operating spec defines the SLO grid (Starter ≥70%, Professional ≥60%, Enterprise ≥50%) — implementation: zero. No PromQL recording rule, no alert receiver, no monthly CFO-report cron.
- Without TENANTCOST-CRITICAL-001 + TENANTCOST-HIGH-004 landing, the SLO numerator is uncomputable; this finding is downstream-blocked but must be tracked separately so it is not lost.
- `apps/billing-service/src/billing/dto/tenant-billing-response.dto.ts:169` exposes `planLimits` to the API but no consumer of margin breach.

**Rule violated**
- Agent invariant (margin grid).
- Sibling `BILLING-CRITICAL-002` (PLAN_LIMITS dead code) compounds: even if margin is computed, the enforcement primitive on the billing side is non-functional.

**Proposed fix direction**
- Tier-3 — Prometheus recording rules: `tenant:cost:hourly` from `tenant_cost_rollup` continuous aggregate; `tenant:plan_revenue:monthly` from `auth.tenants.plan` × `billing.plans.basePrice`; `tenant:margin_pct = (revenue - cost) / revenue`. Alerts at margin < tier-target for 3 consecutive months → CFO-report row + tenant-flag.
- Tier-4 (last-resort because impossible until upstream lands) — runbook `docs/runbooks/tenant-margin-breach.md` for the manual escalation path until the alert wires.

**Affected surface (ripple set)**
- `infrastructure/monitoring/prometheus/cost-metrics.yml` (new — recording rules)
- `infrastructure/monitoring/prometheus/alerts/cost-margin-alerts.yml` (new)
- `apps/billing-service/src/billing/services/cfo-margin-report.service.ts` (new — monthly cron emits the report Markdown)
- `docs/reports/cost-reconciliation/<YYYY-MM>.md` (output convention)

**Expected closer**
- billing-expert primary on revenue side; this agent primary on cost side; observability-expert reviews PromQL.

---

### MEDIUM

#### TENANTCOST-MEDIUM-001 — `infrastructure/monitoring/prometheus/cost-metrics.yml` missing — agent-spec primary surface absent

**Severity:** MEDIUM
**Layer:** 4 (documented but unenforced)
**State:** OPEN
**Sub-kind:** `METRIC_LABEL_GAP`

**Evidence**
- Agent operating spec: *`infrastructure/monitoring/prometheus/cost-metrics.yml` (new) — primary (cost-metric recording rules)* — file does not exist.
- `infrastructure/monitoring/prometheus/` contains only `prometheus-values.yaml`, `aquaculture-rules.yaml`, `alerts/slo-alerts.yml`. No cost-dedicated config.

**Rule violated**
- Layer-3 ADR-016 deploy-resilience phase A discipline — metric definitions live in the SCM-tracked Prometheus config.

**Proposed fix direction**
- Tier-2 — add the file as a YAML stub now (recording rules empty until TENANTCOST-CRITICAL-001 lands), so the wire-up point exists. Sibling-CI invariant (W2) asserts the file exists for any agent declaring it as primary.

**Affected surface**
- `infrastructure/monitoring/prometheus/cost-metrics.yml` (new)

**Expected closer**
- observability-expert.

---

#### TENANTCOST-MEDIUM-002 — Two parallel meter implementations (`UsageMeteringService` Redis vs. `tenant_cost_rollup` hypertable) with no bridge

**Severity:** MEDIUM
**Layer:** 2 (single source of truth)
**State:** OPEN
**Sub-kind:** `ROLLUP_MISS`

**Evidence**
- `apps/billing-service/src/modules/metering/usage-metering.service.ts:131-228` — Redis-backed meter, 12-meter-type taxonomy.
- `apps/observability-service/src/database/migrations/1805000000000-AddTenantCostRollup.ts:84-94` — separate 12-category taxonomy on the rollup CHECK constraint.
- The two enumerations are NOT in lockstep: `MeterType` includes `FARMS_ACTIVE`, `INTEGRATIONS`, `DATA_EXPORT`, `CUSTOM` (not in rollup CHECK); rollup includes `compute_cpu`, `compute_memory`, `network_egress`, `notification_*` categories (not in `MeterType`).
- Drift between the two will cause silent revenue/attribution mismatches once the writer lands.

**Rule violated**
- Layer-2 SSoT — one taxonomy, two consumers; not two taxonomies.
- ADR-006 event flat pattern — the missing `UsageMeteredEvent` (TENANTCOST-CRITICAL-002 fix) is the bridge that should impose the taxonomy.

**Proposed fix direction**
- Tier-1 — single TS enum in `@platform/event-contracts` consumed by both surfaces; CHECK constraint in migration regenerated from the enum at codegen time.
- Tier-3 — invariant: `MeterType` enum keys ⊇ rollup CHECK values (or = if we collapse the two).

**Affected surface**
- `libs/event-contracts/src/billing-events.ts` (canonical enum)
- `apps/billing-service/src/modules/metering/usage-metering.service.ts:18-31` (replace local enum)
- `apps/observability-service/src/database/migrations/1805000000000-AddTenantCostRollup.ts:88-94` (regenerate CHECK from enum — requires migration replacement, not edit-in-place per CLAUDE.md)

**Expected closer**
- data-expert primary (event-contracts surface).

---

#### TENANTCOST-MEDIUM-003 — `metrics-aggregator.service.ts` declares per-tenant `getTenantMetrics` but reports zeros for storage / API-calls / alert-rules

**Severity:** MEDIUM
**Layer:** 4 (documented gap)
**State:** OPEN
**Sub-kind:** `METRIC_LABEL_GAP`

**Evidence**
- `apps/observability-service/src/metrics/metrics-aggregator.service.ts:213-237` — returns `{ alertRules: 0, apiCalls24h: 0, storageUsed: 0 }` with comments `// Would require ...` for all three.
- The endpoint exposes a per-tenant view to admin/analytics consumers, which infers from the API that telemetry is wired, but the values are constants. Trust-anchor for cost-attribution UI breaks.

**Rule violated**
- Tier-4 stale-doc — comments document the gap but no finding is tracked, no skill closes it.

**Proposed fix direction**
- Tier-3 — once TENANTCOST-CRITICAL-001 lands, repoint `getTenantMetrics` reads at the rollup query API; remove the in-place zeros.
- Until then, return 503 / `null` for those fields rather than misleading zeros.

**Affected surface**
- `apps/observability-service/src/metrics/metrics-aggregator.service.ts:213-237`

**Expected closer**
- observability-expert.

---

#### TENANTCOST-MEDIUM-004 — TimescaleDB chunk worker on orphan hypertable accumulates retention-policy load with zero benefit

**Severity:** MEDIUM
**Layer:** 1 (TimescaleDB hypertable lifecycle, layer-1-timescaledb.md)
**State:** OPEN
**Sub-kind:** `ROLLUP_MISS`

**Evidence**
- `1805000000000-AddTenantCostRollup.ts:213-230` — `create_hypertable` + 90-day retention policy added.
- TimescaleDB BGW retention worker scans all registered hypertables on its interval. An orphan hypertable that never receives rows still consumes BGW worker time on every retention cycle.
- 1-day chunks (line 218) on a zero-row hypertable still register chunks via the empty-bucket pattern (depending on the timescaledb version).

**Rule violated**
- Layer-1 hypertable lifecycle: hypertables are registered when there is a writer; create-with-no-writer is an anti-pattern.

**Proposed fix direction**
- Tier-2 — guard the migration with a feature flag (`COST_ATTRIBUTION_PIPELINE_ENABLED`); skip `create_hypertable` until the writer lands. Once writer ships, a follow-up migration converts the table.
- Or: hold the migration in a separate branch until the writer is ready. Currently it ships pre-writer, which violates the "land contract + implementation in same PR" CLAUDE.md discipline.

**Affected surface**
- Migration replacement file under `apps/observability-service/src/database/migrations/` (do NOT hand-edit `1805000000000` per CLAUDE.md).

**Expected closer**
- data-expert.

---

### LOW

#### TENANTCOST-LOW-001 — Stale forward-reference in `orchestrator-metrics.ts` to "Phase 12.5" infrastructure that does not exist

**Severity:** LOW
**Layer:** 4
**State:** OPEN
**Sub-kind:** `METRIC_LABEL_GAP`

**Evidence**
- `libs/backend-common/src/metrics/orchestrator-metrics.ts:35-40` — references Phase 12.5 `tenant_cost_rollup` as the rationale for banning `tenant_id` on the orchestrator metrics. Phase 12.5 has not delivered (per TENANTCOST-CRITICAL-001).
- The doc-cite to a future deliverable is fine in principle, but creates the impression that the rollup is wired when it is not.

**Rule violated**
- Tier-4 stale doc.

**Proposed fix direction**
- Tier-4 — update the comment when TENANTCOST-CRITICAL-001 lands; meanwhile add an inline note "wiring deferred — see TENANTCOST-CRITICAL-001". (Banned-phrase exception applies because comment is in a knowledge-cite context.)

**Affected surface**
- `libs/backend-common/src/metrics/orchestrator-metrics.ts:35-40`

**Expected closer**
- prompt-writer (stale-cite cleanup) on next pass.

---

#### TENANTCOST-LOW-002 — `tenant_cost_rollup` agent-spec schema example diverges from migration on column names

**Severity:** LOW
**Layer:** 4 (doc drift)
**State:** OPEN
**Sub-kind:** `ROLLUP_MISS`

**Evidence**
- Agent spec example schema (`/var/aqua-saas/.claude/agents/tenant-cost-attribution-expert.md:53-72`) declares `period_start`, `period_end`, `compute_cost_dollars`, `db_cost_dollars`, etc.
- Migration `1805000000000-AddTenantCostRollup.ts:84-119` declares `bucket TIMESTAMPTZ`, `cost_category VARCHAR(32)`, `cost_usd NUMERIC(18,6)`, etc. — fundamentally different shape.
- The spec's pivot is "per-period TenantCostRollup row with one column per category"; the migration's pivot is "per-period-and-category TenantCostRollup row". They cannot both be right.

**Rule violated**
- Tier-4 spec drift.

**Proposed fix direction**
- Tier-4 — reconcile in the agent spec (not the migration; the migration owns canonical shape). The category-pivot in the migration is the better design (extensible, no ALTER on new categories).

**Affected surface**
- `.claude/agents/tenant-cost-attribution-expert.md:53-72` (doc only)

**Expected closer**
- prompt-writer.

## Cross-domain dependencies flagged

- TENANTCOST-CRITICAL-001 — recommend invoking **data-expert** (hypertable + RLS migration sequencing) and **implementation-planner** (multi-skill DAG composition).
- TENANTCOST-CRITICAL-002 — recommend invoking **billing-expert** (Stripe metered-usage push + `invoice.finalized` handler) AND **data-expert** (`UsageMeteredEvent` event-contract).
- TENANTCOST-HIGH-001 — recommend invoking **circuit-breaker-auditor** (already running in parallel per cycle metadata) AND **ai-safety-auditor** (entry-point integration).
- TENANTCOST-HIGH-002 — recommend invoking **ai-safety-auditor** (Anthropic SDK wrapper primary owner; layer-1-ai.md compliance).
- TENANTCOST-HIGH-003 — recommend invoking **observability-expert** (cardinality SSoT) AND **multi-tenant-saas-expert** (tenant-id provenance) AND **auth-security-expert** (header-fallback removal). **Architectural-arbiter** ruling required — three primary owners on overlapping slices.
- TENANTCOST-HIGH-005 — recommend invoking **billing-expert** (revenue-side) AND **observability-expert** (PromQL recording rules + alerts). Compounds with `BILLING-CRITICAL-002` (PLAN_LIMITS dead code).
- TENANTCOST-MEDIUM-002 — recommend invoking **data-expert** (canonical enum in event-contracts).

Sibling findings critical to my scope (carry-over from cycle metadata):

- `PLAT-CRITICAL-001` / `MT-CRITICAL-004` — joint resolution required (TENANTCOST-HIGH-003).
- `BILLING-CRITICAL-002` (PLAN_LIMITS dead code) — blocks TENANTCOST-HIGH-005.
- `BILLING-CRITICAL-003` (METER_RACE) — compounds with TENANTCOST-CRITICAL-002.
- circuit-breaker-auditor running in parallel — joint TENANTCOST-HIGH-001.

## Verdict

**BLOCK.**

Two CRITICAL findings (orphan rollup pipeline, three-way reconciliation absent) describe load-bearing infrastructure that is missing in production despite the migration shipping. The platform is currently advertising a per-tenant cost-attribution capability (via the migration commentary, the agent system's declared ownership, and the public `getTenantMetrics` API) that does not exist. Five HIGH findings each individually justify blocking a PR that touches this surface area until they are addressed.

This agent recommends Phase 4 architectural-arbiter routing for the joint resolution of TENANTCOST-HIGH-003 with `PLAT-CRITICAL-001` / `MT-CRITICAL-004` because the right cardinality fix and the right cost-attribution pivot are mutually constraining and cannot be solved by either domain alone.

## References

- Layer-1: `core.md` (TS branded types, no-floating-promises), `nestjs.md` (Nest scheduling + Cron primitives), `typeorm.md` (TypeORM hypertable repository + RLS), `ai.md` (Anthropic SDK 0.2.x cost knobs).
- Layer-2: `patterns.md` outbox pattern (TENANTCOST-CRITICAL-002 ramification), event flat pattern, CQRS layering for the new `cost-attribution` controller.
- Layer-3: ADR-006 (event flat), ADR-011 (schema ownership — observability schema), ADR-012 (drift prevention), ADR-016 (deploy resilience SLO discipline).
- CLAUDE.md — banned phrases ("for now", "interim solution"); architectural-only fix discipline; commit format `Closes:` trailer.
- Sibling reviews: `docs/reviews/multi-tenant-saas-expert/2026-04-28-core-platform-review.md#MT-MEDIUM-003` (cost-attribution telemetry absent), `docs/reviews/billing-expert/2026-04-28-core-platform-review.md` (BILLING-CRITICAL-002/003 — coordinated).
- Plan reference: `/root/.claude/plans/abstract-brewing-mochi.md#Phase-9.6` (cost-attribution agent activation), `#Phase-12.5` (rollup migration). Phase 9.6 + 12.5 marked "shipped" in plan but the application code is absent — plan-state-drift finding for context-manager.

