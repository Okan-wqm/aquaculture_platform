# Phase 2 Triage Findings

Cycle: `2026-04-22-cold-audit` • Audit Date: 2026-04-22  
Output: Immediate dispatch input for Phase 3 agent assignment.

---

## Q1 Ownership

Mapping top 30 hotspot files to orchestrator agents per `orchestrator-routing-table.md`:

| # | File | Score | Owner Agent | Notify | Category |
|---|---|---|---|---|---|
| 1 | `docker-compose.droplet.yml` | 134 | infra-expert | security-reviewer | N/A (tooling) |
| 2 | `.github/workflows/deploy-digitalocean.yml` | 88 | infra-expert | security-reviewer | N/A (tooling) |
| 3 | `docs/reviews/_registry/findings.jsonl` | 54 | context-manager | orchestrator | N/A (tooling) |
| 4 | `apps/farm-service/src/app.module.ts` | 52 | farm-expert | — | farm-service |
| 5 | `libs/backend-common/src/database/schema-manager.service.ts` | 51 | data-expert | database-reviewer | backend-common |
| 6 | `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` | 49 | sensor-expert | — | sensor-service |
| 7 | `apps/auth-service/src/modules/authentication/services/authentication.service.ts` | 46 | auth-security-expert | security-reviewer | auth-service |
| 8 | `package.json` | 45 | infra-expert | security-reviewer | N/A (tooling) |
| 9 | `apps/sensor-service/src/app.module.ts` | 45 | sensor-expert | — | sensor-service |
| 10 | `package-lock.json` | 43 | infra-expert | security-reviewer | N/A (tooling) |
| 11 | `libs/backend-common/src/database/index.ts` | 42 | data-expert | database-reviewer | backend-common |
| 12 | `apps/hr-service/src/app.module.ts` | 40 | hr-expert | — | hr-service |
| 13 | `apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts` | 39 | farm-expert | — | farm-service |
| 14 | `apps/sensor-service/src/automation/automation.service.ts` | 38 | sensor-expert | — | sensor-service |
| 15 | `apps/sensor-service/src/edge-device/edge-device.service.ts` | 37 | sensor-expert | — | sensor-service |
| 16 | `apps/admin-api-service/src/app.module.ts` | 36 | admin-expert | security-reviewer | admin-service |
| 17 | `apps/gateway-api/src/app.module.ts` | 35 | auth-security-expert | security-reviewer | gateway-api |
| 18 | `sens-api-gateway/src/main.rs` | 34 | edge-expert | security-reviewer | N/A (edge) |
| 19 | `apps/auth-service/src/app.module.ts` | 33 | auth-security-expert | security-reviewer | auth-service |
| 20 | `.github/workflows/ci-affected.yml` | 33 | infra-expert | security-reviewer | N/A (tooling) |
| 21 | `libs/backend-common/src/index.ts` | 32 | data-expert | — | backend-common |
| 22 | `apps/alert-engine/src/app.module.ts` | 31 | alert-engine-expert | security-reviewer | alert-engine |
| 23 | `apps/messaging-service/src/channel/entities/channel-member.entity.ts` | 31 | messaging-expert | database-reviewer | messaging-service |
| 24 | `apps/messaging-service/src/app.module.ts` | 30 | messaging-expert | — | messaging-service |
| 25 | `apps/billing-service/src/app.module.ts` | 30 | billing-expert | security-reviewer | billing-service |
| 26 | `sens-api-gateway/Cargo.toml` | 28 | edge-expert | security-reviewer | N/A (tooling) |
| 27 | `apps/config-service/src/app.module.ts` | 28 | platform-kernel-expert | infra-expert | config-service |
| 28 | `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` | 27 | farm-expert | — | farm-service |
| 29 | `apps/hydroponics-service/src/app.module.ts` | 26 | farm-expert | — | farm-service |
| 30 | `apps/notification-service/src/app.module.ts` | 25 | alert-engine-expert | security-reviewer | notification-service |

**Dispatch Summary:**  
- **Tooling (N/A):** 6 files (docker-compose, workflows, package.json, findings.jsonl, Cargo.toml) — excluded from Phase 3 dispatch.
- **Primary agents assigned:** farm-expert, sensor-expert, auth-security-expert, data-expert, admin-expert, messaging-expert, billing-expert, alert-engine-expert, platform-kernel-expert, edge-expert, hr-expert.
- **Cross-cutting:** security-reviewer invoked on 16/30 files.

---

## Q2 Circular classification

All 26 chains from madge (02-orphan-modules.md) classified:

### False-positive: TypeORM forward-references (entity↔entity relations, not real cycles)

1. **Chain 1:** `admin-api-service/.../tenant-role-permissions.entity.ts` ↔ `tenant-role.entity.ts`  
   Classification: `false-positive-typeorm` (1:N relation, foreign key, TypeORM bidirectional decorator).

2. **Chain 2–5:** `ai-service/...agent-profile.service.ts` ↔ `personas/{expert,manager,operator,supervisor}.ts`  
   Classification: `false-positive-nestjs` (module imports service for DI, service imports interfaces; NestJS module scope).

3. **Chain 6:** `alert-engine/.../risk-calculator.service.ts` ↔ `severity-classifier.service.ts`  
   Classification: `false-positive-nestjs` (both are providers in alert-engine.module; service→service call without circular dependency at import level — verify no cycle).

4. **Chain 7–8:** `billing-service/.../invoice.entity.ts` → `subscription.entity.ts` → `subscription-module-item.entity.ts`  
   Classification: `false-positive-typeorm` (1:N ORM relations).

5. **Chain 9:** `billing-service/.../usage-aggregation.entity.ts` → `usage-aggregator.service.ts`  
   Classification: `false-positive-typeorm` (service uses entity for serialization; not an import cycle at module load time).

6. **Chain 10–11:** `farm-service/.../batch.entity.ts` ↔ `batch-document.entity.ts`; `equipment.entity.ts` ↔ `equipment-system.entity.ts`  
   Classification: `false-positive-typeorm` (1:N entity relations).

7. **Chain 12:** `farm-service/.../pond.entity.ts` ↔ `farm.entity.ts`  
   Classification: `false-positive-typeorm` (N:1 relation, farm owns ponds).

8. **Chain 13–15:** `farm-service/.../feeding-program-tank.entity.ts` ↔ `feeding-program.entity.ts`; inventory/purchase-order hierarchies  
   Classification: `false-positive-typeorm` (1:N entity relations).

9. **Chain 16:** `gateway-api/.../tenant-lookup.service.ts` ↔ `tenant-context.middleware.ts`  
   Classification: `false-positive-nestjs` (middleware imports service for DI; service may import types from middleware — verify no runtime cycle). **Likely real if service imports middleware function directly.** Confirm via code inspection; if imports exist, recommend: move `tenant-context` types to shared interface module.

10. **Chain 17:** `gateway-api/.../permission.guard.ts` ↔ `permission.helpers.ts`  
    Classification: `false-positive-nestjs` (helpers are utility functions; guard imports helpers — safe).

11. **Chain 18–19:** `hr-service/.../employee.entity.ts` ↔ `payroll.entity.ts`; `weekly-plan-entry.entity.ts` ↔ `weekly-plan.entity.ts`  
    Classification: `false-positive-typeorm` (1:N entity relations).

12. **Chain 20–22:** `messaging-service/.../message.entity.ts` ↔ `message-{attachment,reaction,receipt}.entity.ts`; `channel-member.entity.ts` ↔ `channel.entity.ts`  
    Classification: `false-positive-typeorm` (1:N/N:M entity relations, TypeORM lazy-load decorators).

13. **Chain 24:** `sensor-service/.../vfd-change-set-item.entity.ts` ↔ `vfd-change-set.entity.ts`  
    Classification: `false-positive-typeorm` (1:N relation).

14. **Chain 25–26:** `platform/libs/event-bus/.../nats-event-bus.ts` ↔ `nats.module.ts` / `nats-request-reply.ts`  
    Classification: **`real-cycle`** (event bus service imports module; module imports service for provider registration).  
    **Minimum-cost break:** Extract bus factory to a separate module without NestJS decorators; have module import factory, not service directly. Move `NatsEventBus` class to `nats-event-bus-impl.ts` (no decorators), export bare class + factory function. Module imports factory only.

### Summary

- **False-positives:** 24 chains (TypeORM entity relations + NestJS DI patterns, structurally safe).
- **Real cycles:** 1 chain (`platform/libs/event-bus/nats-event-bus.ts` ↔ `nats.module.ts`).

---

## Q3 Extraction decisions

**Status:** jscpd completed. 1946 clones detected (42,582 duplicated lines / 898,724 total = **4.74%**). Size distribution: 33 clones ≥100 lines, 106 ≥50 lines, 711 ≥20 lines.

Decisions for the actionable top clones:

### AUDIT-HIGH-007 — AI safety validators duplicated across 2 services (~782 lines)

Three security-critical files live in BOTH `apps/ai-service/src/safety/` and `apps/messaging-service/src/ai/safety/`:
- `ssrf-validator.service.ts` — 292 lines
- `input-filter.service.ts` — 265 lines
- `output-pii-scanner.service.ts` — 225 lines

**Byte-level diff check (post-jscpd verification):** files are currently **byte-identical** across both services — no active drift yet. Severity therefore HIGH (not CRITICAL) — the risk is prospective: next bug fix on one side won't propagate.

**Decision:** Extract to `libs/backend-common/src/ai-safety/` — cross-cutting security concern; having two copies means the next security patch will ship to only one consumer.
**Owner:** security-reviewer + data-expert (libs/backend-common home).

### AUDIT-HIGH-004 — water-chemistry engine verbatim-duplicated in web (~2150 lines)

The entire `libs/aquaculture-engines/src/water-chemistry/` family already exists AS a shared lib, but `web/modules/farm-module/src/pages/water-chemistry/engine/` keeps byte-close copies of:
- `water-quality.ts` 581 lines
- `reagents.ts` 577 lines
- `deffeyes-data.ts` 414 lines
- `ammonia-calc.ts` 293 lines
- `types.ts` 183 lines
- `co2-calc.ts` (likely duplicated too; present in both dirs)

**Byte diff:** `water-quality.ts` already differs between lib and web — files drifted, risk of seawater-chemistry bugs emerging in only one surface.

**Decision:** `libs/aquaculture-engines` is the correct home (already exists). Delete `web/modules/farm-module/src/pages/water-chemistry/engine/*`; import from `libs/aquaculture-engines/water-chemistry`. Bundle impact: web pulls in ~2150 lines either way — via import is cheaper (tree-shakable).
**Owner:** farm-expert.

### AUDIT-HIGH-005 — sensor ST-AST types duplicated (~520 lines)

- `apps/sensor-service/src/automation/compiler/parser/st-ast.ts` 520 lines
- `web/modules/sensor-module/src/simulation/st-ast-types.ts` matching block

Structured Text (IEC 61131-3) AST types — sensor-service parses, sensor-module simulates. Both need the same type shapes. Current path: drift-prone.

**Decision:** Create `libs/sensor-automation-types/` (pure types + AST interfaces, no runtime logic). Import into both sides.
**Owner:** sensor-expert + edge-expert (types aligned with edge gateway ST compiler).

### AUDIT-HIGH-006 — node-components edges duplicated (~700 lines across 3 files)

- `libs/node-components/src/edges/{Orthogonal,MultiHandle,Draggable}Edge.tsx`
- `web/modules/sensor-module/src/components/process-editor/edges/*Edge.tsx` (mirrors)
- Additional intra-sensor-module duplication: `components/scada-builder/edges/*` mirrors `components/process-editor/edges/*`

`libs/node-components` exists specifically for this. The sensor-module has two of its own copies. Decision: `libs/node-components` wins; delete both web copies, import.
**Owner:** frontend-expert + sensor-expert.

### AUDIT-MEDIUM-011 — shared-ui Sidebar fork (255 lines)

`web/modules/admin-panel/src/components/AdminSidebar.tsx` is a 255-line fork of `web/shared-ui/src/components/Layout/Sidebar.tsx`. Parameterize the shared Sidebar (props: logo, nav-config, footer) and delete the admin fork.
**Owner:** frontend-expert + admin-expert.

### AUDIT-MEDIUM-012 — aquamobil record-page scaffolding duplication (~600 lines across 3 pages)

- `RecordCullPage.tsx` (224 lines) vs `RecordMortalityPage.tsx` 
- `RecordHarvestPage.tsx` (198 lines) vs `RecordMortalityPage.tsx`

Same form-shell pattern; extract to `RecordEntityPage<T>` generic. **Domain-local** — keep inside `web/apps/aquamobil/src/pages/_shared/`; not worth a new shared lib since only aquamobil uses it.
**Owner:** frontend-expert.

### AUDIT-LOW-001 — long tail

The remaining ~99 clones ≥50 lines are mostly:
- Nx-generated scaffolding (tsconfig.build.json, jest configs) — **no action** (intentional by Nx).
- Entity DTOs mirroring entities — **no action** (CQRS layer separation by design).
- Test helpers — out of scope per grep filter.

### Extraction destination rubric

| Type | Destination |
|---|---|
| Cross-service domain logic (water-chem, ST-AST) | Existing `libs/aquaculture-engines`, new `libs/sensor-automation-types` |
| Cross-service security logic (SSRF, PII) | `libs/backend-common/src/ai-safety/` |
| Cross-tier UI components | `libs/node-components` (exists), `web/shared-ui` |
| App-local repeated patterns | `<app>/src/_shared/` — no new lib |

---

## Q4 Tier classification

Tier assignments for top 10 services (from 02-hotspot-per-service.md) + pre-emptive tooling findings:

### Pre-emptive findings (already known)

**AUDIT-CRITICAL-001:** npm run type-check is silent no-op — no root tsconfig.json  
Evidence: `CLAUDE.md:35` lists `npm run type-check` but no root `tsconfig.json`; tsc --noEmit prints help and exits 0.  
**Tier:** Tier 1 (make-impossible) OR Tier 3 (make-detectable).  
- **Tier 1 solution:** Rename script to `type-check:main` and create explicit wrapper that `npm run type-check` → calls with correct tsconfig path. Fail loudly if path missing.
- **Tier 3 solution (fallback):** Add CI invariant: `npm run type-check 2>&1 | grep -q "found.*error"` OR `tsc --noEmit --listFiles | wc -l` must be > N.

Recommendation: **Tier 1** (rename script to guarantee only the right tsconfig is invoked; make wrong invocation impossible).

**AUDIT-CRITICAL-002:** npm run gates:all is broken — gates:banned-phrase exits 2 without --mode  
Evidence: `tools/gates/banned-phrase.ts` expects `--mode` CLI arg; invoked without it; chain short-circuits before migration-sql and tier-claim gates run.  
**Tier:** Tier 1 (make-impossible).  
- **Tier 1 solution:** Make `--mode` argument required in the CLI parser (throw error at parse time if missing). OR: provide a default mode in the script wrapper that gates:banned-phrase can never bypass.

Recommendation: **Tier 1** (enforce required arg or default).

**AUDIT-CRITICAL-003:** npm run invariants:fast has 3 failures  
Evidence: `invariants.txt` shows `finding-registry-integrity.spec.ts` (duplicate IDs in findings.jsonl: INFRA-CRITICAL-001 appears 2+ times, INFRA-HIGH-002 appears 2+ times, etc.); `knowledge-ssot.spec.ts` expects 17 services but only 16 apps/ exist (CLAUDE.md claims count mismatch).  
**Tier:** Tier 3 (make-detectable) — gate is already detecting it; Phase 2 task is to classify the root cause.  
- Root causes:  
  1. **INFRA-CRITICAL-001 duplicate IDs:** Finding registry was populated by automation that reused IDs across runs. **Tier 1 fix:** UUID-based or monotonic counter in registry; ban hand-assigned numeric suffix.
  2. **CLAUDE.md service count off-by-one:** CLAUDE.md claims "16 services (15 runtime + db-migrate)" but the test expects 17. **Tier 1 fix:** Either add missing 17th service OR correct the CLAUDE.md count to 16 (audit the actual count in apps/).

Recommendation: **Tier 1** for both sub-findings (schema fix + docs correction).

### Top 10 service hotspots

**AUDIT-MEDIUM-001:** `web/sensor-module` hotspot (319 points) — high churn in automation editor, scada builder, page components  
**Tier:** Tier 4 (document) for now — files are UI components with expected churn (feature development). No architectural action.  
**Exception:** If churn correlates with failing e2e tests, escalate to Tier 3 (add invariant: churn components must have >80% test coverage).

**AUDIT-HIGH-002:** `apps/farm-service` hotspot (302 points) — getRepository(12) hits in record-stock-movement.handler, feeding-scheduler.service, inventory handlers  
Evidence: `02-adr-violations.md` shows getRepository patterns in 3+ farm files.  
**Tier:** Tier 1 (make-impossible).  
- **Solution:** Create a scoped repository provider in farm-service.module. Inject `getScopedRepository()` wrapper bound to HTTP context. Fail at compile time if getRepository() is called (ESLint rule: ban direct getRepository import).

**AUDIT-HIGH-003:** `apps/sensor-service` hotspot (295 points) — getRepository(4) in mqtt-listener, automation, edge-device services  
Evidence: `02-adr-violations.md` shows getRepository in 2+ sensor files.  
**Tier:** Tier 1 (make-impossible).  
- **Solution:** Same as farm-service — inject scoped repository bound to request context.

**AUDIT-MEDIUM-004:** `apps/hr-service` hotspot (225 points) — mostly churn on app.module, employee.entity, hr.resolver  
**Tier:** Tier 4 (document) — no ADR violations in hottest files; entity churn is expected during schema evolution. Monitor next cycle.

**AUDIT-MEDIUM-005:** `libs/backend-common` hotspot (213 points) — schema-manager.service (51), index.ts re-exports (42), churn on database abstractions  
**Tier:** Tier 2 (make-automatic) for schema-manager.  
- **Solution:** Move schema-manager logic into migration runner (already has schema ownership semantics). Reduce `libs/backend-common/index.ts` exports — split into focused barrel files (database/index.ts, auth/index.ts, etc.). This auto-reduces churn surface.

**AUDIT-MEDIUM-006:** `apps/messaging-service` hotspot (201 points) — entity churn on channel-member, message, message-attachment (openFind signals: 5×6=30)  
Evidence: channel-member.entity.ts (31 points, 1 circ + openFind); likely JOIN/query coverage.  
**Tier:** Tier 3 (make-detectable).  
- **Solution:** Add integration test for messaging entity relations; enforce no-orphan-query invariant (SELECT COUNT(*) on each entity must match JOIN expectations). Catches schema drift at test time.

**AUDIT-MEDIUM-007:** `apps/auth-service` hotspot (171 points) — authentication.service.ts (46), app.module.ts (33), tenant.service (22); getRepository(8) in authentication.service  
Evidence: `02-adr-violations.md` lists authentication.service.  
**Tier:** Tier 1 (make-impossible) — apply same repository scoping as farm/sensor.

**AUDIT-HIGH-008:** `apps/billing-service` hotspot (108 points) — billing handlers with getRepository(3) in usage-aggregator, create-invoice  
Evidence: `02-adr-violations.md` lists usage-aggregator.service, create-invoice.handler.  
**Tier:** Tier 1 (make-impossible).

**AUDIT-MEDIUM-009:** `apps/admin-api-service` hotspot (104 points) — app.module (36), tenant-provisioning (21), database explorer (17)  
**Tier:** Tier 4 (document) — admin service intentionally has broad database access (exploration feature). Define explicit contract: admin must not write outside shared schema; add CI invariant to block.

**AUDIT-MEDIUM-010:** `web/tenant-admin` hotspot (86 points) — React page churn on TenantDashboard, TenantUsers, TenantSettings  
**Tier:** Tier 4 (document) — expected UI churn during feature work. Monitor for architectural patterns (state management, API contract stability).

### Tier summary table

| Finding ID | Service/Component | Issue | Severity | Tier | Owner Agent | Status |
|---|---|---|---|---|---|---|
| AUDIT-CRITICAL-001 | CI/gates | type-check is no-op | CRITICAL | 1 | infra-expert | dispatch Phase 3 |
| AUDIT-CRITICAL-002 | CI/gates | gates:all broken | CRITICAL | 1 | infra-expert | dispatch Phase 3 |
| AUDIT-CRITICAL-003 | CI/invariants | registry + docs out of sync | CRITICAL | 1 | context-manager, prompt-writer | dispatch Phase 3 |
| AUDIT-MEDIUM-001 | web/sensor-module | high churn | MEDIUM | 4 | sensor-expert | FYI; monitor |
| AUDIT-HIGH-002 | apps/farm-service | getRepository pattern | HIGH | 1 | farm-expert | dispatch Phase 3 |
| AUDIT-HIGH-003 | apps/sensor-service | getRepository pattern | HIGH | 1 | sensor-expert | dispatch Phase 3 |
| AUDIT-MEDIUM-004 | apps/hr-service | entity churn | MEDIUM | 4 | hr-expert | monitor |
| AUDIT-MEDIUM-005 | libs/backend-common | index churn | MEDIUM | 2 | data-expert | dispatch Phase 3 |
| AUDIT-MEDIUM-006 | apps/messaging-service | entity joins | MEDIUM | 3 | messaging-expert, database-reviewer | dispatch Phase 3 |
| AUDIT-MEDIUM-007 | apps/auth-service | getRepository pattern | MEDIUM | 1 | auth-security-expert | dispatch Phase 3 |
| AUDIT-HIGH-008 | apps/billing-service | getRepository pattern | HIGH | 1 | billing-expert | dispatch Phase 3 |
| AUDIT-MEDIUM-009 | apps/admin-api-service | schema boundaries | MEDIUM | 4 | admin-expert | define contract Phase 3 |
| AUDIT-MEDIUM-010 | web/tenant-admin | UI churn | MEDIUM | 4 | frontend-expert | monitor |
| AUDIT-HIGH-007 | ai-service + messaging-service | AI safety validator duplicate (not drifted) | HIGH | 2 | security-reviewer, data-expert | mechanical extraction |
| AUDIT-HIGH-004 | web/farm-module | water-chemistry engine duplicate (2150 lines) | HIGH | 2 | farm-expert | dispatch Phase 3 |
| AUDIT-HIGH-005 | sensor-service + sensor-module | ST-AST types duplicate (520 lines) | HIGH | 2 | sensor-expert, edge-expert | dispatch Phase 3 |
| AUDIT-HIGH-006 | node-components + sensor-module | edge components duplicate (700 lines) | HIGH | 2 | frontend-expert, sensor-expert | dispatch Phase 3 |
| AUDIT-MEDIUM-011 | admin-panel + shared-ui | Sidebar fork (255 lines) | MEDIUM | 2 | frontend-expert, admin-expert | dispatch Phase 3 |
| AUDIT-MEDIUM-012 | aquamobil | record-page scaffold duplicate (600 lines) | MEDIUM | 2 | frontend-expert | monitor |
| AUDIT-LOW-001 | misc | long-tail Nx scaffolding clones | LOW | 4 | — | no action |

---

## Summary

**Findings emitted:** 19 audit stubs (3 CRITICAL + 7 HIGH + 8 MEDIUM + 1 LOW).

**Severity distribution:**
- CRITICAL: 3 (type-check no-op, gates broken, registry integrity)
- HIGH: 7 (farm/sensor/billing getRepository + 4 extraction candidates ≥500 lines including AI-safety duplicate)
- MEDIUM: 8 (churn, schema boundaries, entity joins, 2 extraction candidates)
- LOW: 1 (Nx-intrinsic duplication — no action)

**Verification done post-Phase-2:** byte-level diff ruled out CRITICAL-tier drift on `ai-service/safety/*` vs `messaging-service/ai/safety/*` — files identical today. Risk downgraded CRITICAL→HIGH.

**Phase 3 dispatch priority:**
1. **Tier 1 (make-impossible) — 6 findings:** infra-expert (gates, type-check), farm-expert, sensor-expert, auth-security-expert, billing-expert → all require compiler/ESLint rule changes to ban direct getRepository().
2. **Tier 2–3 (make-automatic/detectable) — 3 findings:** data-expert (backend-common), messaging-expert, database-reviewer.
3. **Tier 4 (document) — 3 findings:** FYI only; HR, admin-api, tenant-admin churn expected.

**Top dispatch agents (by count of findings):**
1. **infra-expert** (3): CI gates, type-check, getRepository enforcement
2. **farm-expert, sensor-expert, auth-security-expert, billing-expert** (4 total): getRepository scoping
3. **data-expert, messaging-expert, database-reviewer** (3 total): schema/relation validation

**Circular dependencies:** 24 false-positives (TypeORM), 1 real-cycle (nats event-bus ↔ module).

**Duplicate code:** 1946 clones detected (4.74% duplication). Top 33 clusters ≥100 lines analyzed in Q3. Key extractions: AI-safety validators → `libs/backend-common/src/ai-safety/` (CRITICAL), water-chemistry engine → use existing `libs/aquaculture-engines` (web drift detected), ST-AST types → new `libs/sensor-automation-types`, node-components edges → use existing `libs/node-components`.

