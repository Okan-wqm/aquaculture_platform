# ADR-052 — Module-keyed common registry and one owner per common kind

- **Status:** Proposed, revision 2; approved by the architectural-arbiter on 2026-10-26 after its
  review. No package below merges before this record is Accepted (PKG-00 gate of the
  module-boundaries plan).
- **Date:** 2026-10-26
- **Owner:** platform operator (owner decisions D1, D4, D5, D7 and D8 of 2026-10-26)
- **Tracking:** finding IDs allocated by `npm run findings:add` in PKG-00 (branch
  `chore/module-boundaries-governance`, not yet merged; the rows name the review file
  `docs/reviews/claude/2026-10-26-module-boundaries.md`): HR-MEDIUM-064 (PKG-01), FARM-MEDIUM-470
  (PKG-13), FARM-MEDIUM-471 (PKG-14), FARM-MEDIUM-473 (PKG-15), FARM-MEDIUM-472 (PKG-16),
  HR-MEDIUM-068 and HR-MEDIUM-069 (PKG-18), HR-HIGH-070 (PKG-19), HR-MEDIUM-071 (PKG-20),
  FARM-MEDIUM-474 (PKG-21), RBAC-MEDIUM-040 (PKG-33), FARM-HIGH-475 and FARM-MEDIUM-476 (PKG-37),
  FARM-MEDIUM-477 and FARM-MEDIUM-478 (PKG-38), HR-MEDIUM-073 (PKG-39), SEC-MEDIUM-211 (erasure
  sort, Decision 6), RBAC-MEDIUM-041 (PKG-40). Existing open findings dispositioned here:
  HR-MEDIUM-053 (Decision 1, partly rejected) and HR-LOW-057 (Decision 6, rule half closed)
  (`docs/reviews/_registry/findings.jsonl:3083,3087`).
- **Relates to:** ADR-006 (flat events), ADR-011 (schema ownership), ADR-012 (schema drift),
  ADR-051 (module access layers: `decideAccess`, `scoped('common-registry')`, the `moduleAccess`
  claim), ADR-053 (catalog-only `ADD COLUMN … NOT NULL DEFAULT <constant>` on PG16).
- **Evidence:** D = `/var/lib/aqua/deploy/checkout` at 33de2433b (the plan cites its ancestor
  5852fe55d). Paths are D-relative; every cited line was re-read at 33de2433b.

## Context

D1 makes Company the umbrella over each module's common kinds (sites, site departments, suppliers,
consumables, finance, organisation structure, workforce); D2 keeps the rest module-private. Today:

- **The registry is seven farm-service tables without a module column:** `sites`
  (`apps/farm-service/src/site/entities/site.entity.ts:139-145`), `departments`
  (`apps/farm-service/src/department/entities/department.entity.ts:79-82`), `suppliers` and
  `supplier_sites` (`apps/farm-service/src/supplier/entities/supplier.entity.ts:82-86`,
  `supplier-site.entity.ts:35-38`), `consumables`
  (`apps/farm-service/src/consumable/entities/consumable.entity.ts:51-54`), `finance_categories`
  and `finance_expense_entries`
  (`apps/farm-service/src/finance/entities/finance-category.entity.ts:72-73`,
  `finance-expense-entry.entity.ts:33`). Uniqueness is tenant-wide and total: site code and name
  (`site.entity.ts:140-141`), department, supplier and consumable codes
  (`department.entity.ts:80`, `supplier.entity.ts:83`, `consumable.entity.ts:52`).
- **The ledger encodes its module in a private enum.** `FinanceCategoryScope` = `FARM_OPEX |
FARM_REVENUE`, "which farm finance ledger a category belongs to"
  (`finance-category.entity.ts:37-45`, column `:98-104`). Codes are unique per `(tenant, scope,
code)` where a code exists, which is the seed's `ON CONFLICT` target; active names are unique
  per `(tenant, scope, lower(name))`
  (`apps/farm-service/src/database/migrations/1804600000000-CreateFinanceTables.ts:159-170`,
  `apps/farm-service/src/finance/services/finance-category-seed.service.ts:143`). `kind` does not
  follow scope: a user category is `EXPENSE` unless the input says otherwise, in either scope
  (`apps/farm-service/src/finance/handlers/create-finance-category.handler.ts:42-60`). The
  computed rule `PERCENT_OF_SCOPE_TOTAL` takes its base from the non-computed categories of the
  same scope and period (`finance-category.entity.ts:57-69`,
  `apps/farm-service/src/finance/services/computed-rule-evaluator.ts:61-72`,
  `finance-ledger-query.service.ts:410-419`). Entries carry an optional `batchId`
  (`1804600000000-CreateFinanceTables.ts:130`). HR finance lives apart in `hr_finance_categories`
  and `hr_finance_entries` (`libs/backend-common/src/database/schema-manager.service.ts:693-694`),
  as D6 requires.
- **Other modules already use farm sites as physical locations, with no foreign key.** Sensor rows
  carry `site_id` (`apps/sensor-service/src/database/entities/sensor.entity.ts:232-236`,
  `apps/sensor-service/src/edge-device/entities/edge-device.entity.ts:174-176`); no sensor or hr
  migration references `sites`. auth's `user_site_assignments.siteId` is a cross-service id with
  deliberately no FK
  (`apps/auth-service/src/modules/authentication/entities/user-site-assignment.entity.ts:38-43`).
  hr filters schedules by `employees.farmId` as a site id
  (`apps/hr-service/src/scheduling/query-handlers/get-weekly-plans.handler.ts:51`,
  `get-team-weekly-overview.handler.ts:146`; column
  `apps/hr-service/src/hr/entities/employee.entity.ts:277-279`). The sensor and HR web modules
  read farm's site lists (`web/modules/sensor-module/src/hooks/useLocationHierarchy.ts:3,52-54`,
  `web/modules/hr-module/src/graphql/site-responsibility.operations.ts:18-20`).
- **Farm-private tables point into the registry.** By FK: `tanks`, `systems`, `sub_systems`,
  `equipment` and `feed_inventory` to `departments`; `systems`, `feed_inventory`, `feed_sites` and
  `chemical_sites` to `sites`; `feeds`, `chemicals` and `spare_parts` to `suppliers`
  (`apps/farm-service/src/database/migrations/1800000000000-Baseline.ts:585-637`). By bare uuid with
  no relation, for example `water_quality_measurements`, `tasks`, `lice_counts` and
  `storage_locations` (`siteId` in their entities). The weather and satellite observation tables
  reference `sites(tenantId, id)`
  (`1807100000000-CreateEnvironmentalObservationFoundation.ts:61,72,460,519`,
  `1808000000000-AddSatelliteCoverageProvenance.ts:34`).
- **Organisation units have an optional module.** `departments_hr.moduleCode` is nullable, "null =
  company-wide" (`apps/hr-service/src/hr/entities/department.entity.ts:33-36`), and its enum has no
  `hr` value (`apps/hr-service/src/common/enums.ts:32-36`). An employee's module membership comes
  from the unit's module (`apps/hr-service/src/common/module-scope.ts:50-61`). `siteId` and
  `parentDepartmentId` are untyped strings (hr `department.entity.ts:29-31,38-40`).
- **Farm keeps a second roster and a second department vocabulary.** `farm_workers`
  (`schema-manager.service.ts:609`, `apps/farm-service/src/worker/entities/worker.entity.ts:45`)
  sits beside HR `employees` (D8). Farm `departments` are physical areas of a site (13 types such as
  hatchery, grow-out and quarantine, `department.entity.ts:41-53`) that own tanks, systems and
  equipment; `departments_hr` is reporting structure with parent, manager and budget code (hr
  `department.entity.ts:38-40,54-60`). HR-MEDIUM-053 asks to consolidate both pairs.
- **All tenant-aware services share one namespace.** The provisioner replays every tenant-aware
  service's migrations into the same `tenant_<uuid>` schema
  (`apps/db-migrate/src/tenant-schema-provisioner.ts:962-975`). Hence the `hr_` table prefix
  (`schema-manager.service.ts:689-692`). Post-Baseline enum types are created unqualified, one per
  schema (farm `1804600000000-CreateFinanceTables.ts:76-80`, alert
  `apps/alert-engine/src/database/migrations/1801200000000-AddAlertHistorySiteAndModule.ts:14-18`).
  The farm Baseline's types are the exception: they are farm-qualified and shared by every tenant
  schema (`1800000000000-Baseline.ts:490`), so the ADD VALUE precedent skips its tenant runs
  (`apps/farm-service/src/database/migrations/1805900000000-AddChemicalTherapeuticTypes.ts:18-28,59-61`).
  Type creation is guarded by `EXCEPTION WHEN duplicate_object THEN NULL`
  (`apps/hr-service/src/database/migrations/1802400000000-AddDepartmentHrModuleCode.ts:30-32`), so
  a second service creating the same type name would silently inherit the first one's labels.
- **The shared erasure sort fails on a self-referencing FK.** The executor adds a self-edge to the
  table's own in-degree, never reaches zero and throws
  (`libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-executor.ts:554-561,582-586`).
  hr `goals.parentGoalId` references `goals`
  (`apps/hr-service/src/database/migrations/1800000000000-Baseline.ts:226`), `goals` is an hr
  module table (`schema-manager.service.ts:679`), and hr erases through that executor
  (`apps/hr-service/src/app.module.ts:331`; `tenant-erasure-target-registry.ts:210-217`). Tenant
  erasure of hr is therefore broken today: SEC-MEDIUM-211. Farm `systems` and `equipment` also
  reference themselves (`1800000000000-Baseline.ts:590,628`) but are not affected: farm-service
  registers no `TenantErasureTargetModule.forService` and erases through its own service, whose
  sort skips self-edges
  (`apps/farm-service/src/compliance/services/tenant-erasure.service.ts:1196-1197,1217`).
- **Writers and events know no module.** The site quota counts every live site against `maxFarms`
  (`apps/farm-service/src/site/handlers/create-site.handler.ts:59-67`). The name and code checks
  filter `isDeleted = false` (`:69-82`) but the indexes are total, so a soft-deleted name still
  blocks reuse. Site and Department events carry no module
  (`libs/event-contracts/src/farm-events.ts:582-648`).

## Decision

1. **One owner per concept.** Each concept has exactly one owning service:

   | Concept (D1 kind)                   | Owner        | Table(s)                                        | Module key                                  |
   | ----------------------------------- | ------------ | ----------------------------------------------- | ------------------------------------------- |
   | site, site department               | farm-service | `sites`, `departments`                          | `moduleCode` NOT NULL                       |
   | supplier, supplier site, consumable | farm-service | `suppliers`, `supplier_sites`, `consumables`    | `moduleCode` (`module_code` in consumables) |
   | module ledger                       | farm-service | `finance_categories`, `finance_expense_entries` | `moduleCode` NOT NULL, never `hr` (D6)      |
   | organisation unit                   | hr-service   | `departments_hr`                                | `moduleCode` NOT NULL (D7)                  |
   | duty in a module (D5)               | hr-service   | `hr_employee_module_assignments`                | `moduleCode` NOT NULL                       |
   | person in the workforce (D8)        | hr-service   | `employees`                                     | none; membership comes from duties          |

   farm-service hosts the registry for every owner module; `moduleCode` names the owning module,
   not the host. A sensor manager manages sensor sites through it under `scoped('common-registry')`
   (ADR-051). `supplier_types` has no `tenantId` and stays platform reference data without a module.

   **HR-MEDIUM-053 disposition.** Its `farm_workers` half is resolved by D8 and Decision 8 (one
   roster; tracked as FARM-HIGH-475 and FARM-MEDIUM-476). Its departments half is rejected: farm
   `departments` (site departments) and `departments_hr` (organisation units) are two kinds D1 names
   separately, with a distinguishing invariant. A site department is a physical area keyed by its
   site that owns tanks, systems and equipment (`Baseline.ts:583,585,626`). An organisation unit is
   reporting structure (parent, manager, budget code) in which employees are placed, and needs no
   site. PKG-00 records both halves in the finding's notes through context-manager, which owns the
   finding state machine.

2. **The module key.** Values come from the one module dictionary (PKG-01). The key is set at
   create and never changes: a BEFORE UPDATE trigger rejects a change (trigger precedent
   `apps/farm-service/src/database/migrations/1806900000000-AddSiteMonitoringContract.ts:72-102`).
   The registry adds the column as `NOT NULL DEFAULT 'farm'`, which every existing row is by
   construction; the runbook bans that form today (`docs/runbooks/migration-authoring.md:178`) and
   ADR-053 amends it. The default exists only so old containers, which never write the column,
   keep inserting during R6. PKG-13 PR2 drops it in R7, before non-farm writes open in R8; from
   then a writer that omits the module fails at INSERT. Writable modules are a typed constant:
   `farm` until PKG-15, then farm, hr and sensor; hydroponics is reserved and refused (D3).
   A child takes its parent's module: a site department its site's, a supplier site its
   supplier's, a consumable must match its supplier. Composite FKs over `(tenantId, id,
moduleCode)` (identity precedent `uq_sites_tenant_identity`, `site.entity.ts:145`) make every
   link inside the registry same-module; the finance-entry site FK stays NOT VALID until PKG-38
   counts orphans (FARM-MEDIUM-477). These CHECKs are added by PKG-13 PR1 and declared with entity
   `@Check`, so drift class G
   (`libs/backend-common/src/database/schema-drift/drift-classes.ts:155-170`) compares them:
   - `finance_categories` and `finance_expense_entries`: `"moduleCode" <> 'hr'` (D6).
   - `finance_expense_entries`: `"moduleCode" = 'farm' OR "batchId" IS NULL`. Batches are
     farm-private (D2), so a non-farm ledger entry can never name one. Every existing entry is farm,
     so the CHECK validates by construction.

3. **Placement semantics (OQ3 default).** A row outside the registry, owned by module A, may name
   a live registry site of module B as its physical location: a sensor or an HR unit at a farm
   site. No re-homing migration runs, and placement grants nothing on B. Module A reads only labels
   `{id, code, name, moduleCode}`, only for the site ids its own rows reference, through
   `request.farm.resolveSiteLabels` (at most 200 ids, exact-key guards) and `placementSites`. The
   responder ships in R2 and its `placementSites` callers in R3, one release apart (C5). Managing
   the site stays with B. farm-service validates an HR unit's `siteId` over NATS, failing closed
   (PKG-18). A site delete asks sensor, hr and auth for counts and is refused on open references
   or an unavailable census (PKG-21). Farm-private code sees farm sites only, through
   `site/services/farm-scope.ts` (PKG-15) and Decision 10; farm-only attributes are impossible on
   other modules' sites (CHECK + `site-type-policy.ts`, PKG-14). Each of these claims has a named
   test under Enforcement.

4. **Type names and hr table names have one owning service.** No type name is created by two
   tenant-aware services; module types carry their owner in the name: `farm_registry_module_enum`
   (farm; one type for the seven tables, as composite FKs require), `departments_hr_modulecode_enum`
   (hr, existing), `hr_employee_module_assignments_modulecode_enum` (hr), `channels_modulecode_enum`
   (messaging), `alert_history_module_enum` (alert-engine, existing). No shared `owner_module_enum`.
   `farm_registry_module_enum` and the new `finance_category_ledger_enum` (Decision 5) are created
   unqualified, one per schema, like `1804600000000-CreateFinanceTables.ts:76-80`, not
   farm-qualified like the Baseline's types. Labels are added only by a type-guarded `ADD VALUE`
   with `transaction = false` (shape of
   `apps/farm-service/src/database/migrations/1805900000000-AddChemicalTherapeuticTypes.ts:46-85`).
   For these per-schema types the guard finds the type in every schema, so the `ADD VALUE` runs in
   the farm schema and in every tenant schema and skips none; the module-dictionary invariant
   asserts the replayed labels in a tenant schema. PKG-01 adds `hr` this way in R1. New hr tables
   take the `hr_` prefix (PKG-19, PKG-37).

5. **Uniqueness per module.** Each index is partial on the table's live predicate: `isDeleted =
false` on sites, departments and suppliers, `is_deleted = false` on consumables; on finance
   categories names stay partial on `isActive = true` and codes on `code IS NOT NULL` (archived
   system categories keep their code, as today). A site code is unique per tenant, as the
   cross-module handle of a physical site. Site names and department, supplier and consumable codes
   are unique per `(tenant, module)`. `supplier_sites` keeps its `(supplierId, siteId)` key
   (`supplier-site.entity.ts:36`). These swaps only loosen, so none can fail on existing data.

   **Finance keeps a ledger discriminator.** `FinanceCategoryScope` retires into two attributes:
   `moduleCode` and a module-neutral `ledger` (`finance_category_ledger_enum`: `OPEX | REVENUE`),
   with `FARM_OPEX → (farm, OPEX)` and `FARM_REVENUE → (farm, REVENUE)`. Category codes become
   unique per `(tenant, module, ledger, code)` and active names per `(tenant, module, ledger,
lower(name))`. For existing rows (all farm) the map is one-to-one, so the new keys accept and
   refuse exactly what the scope keys do: the swap cannot fail on existing data and needs no
   count. Keying on `kind` instead would tighten (see Alternatives). Steps:
   - R6, PKG-13 PR1: add `ledger` nullable, backfill it from `scope`; writers set both, and the
     entity keeps `ledger` nullable (C3). An optional `ledger` input, which must agree with `scope`
     when both are sent, joins the create input.
   - R7, PKG-13 PR2: re-run the backfill for rows written by R5 containers, then `SET NOT NULL`. The
     backfill is total over a NOT NULL `scope`, so this is not a data-dependent step.
   - R8, PKG-15: build the two new indexes CONCURRENTLY and check `indisvalid`; move the seed's
     `ON CONFLICT` target to `("tenantId", "moduleCode", "ledger", "code") WHERE "code" IS NOT NULL`
     in the same release (db-migrate builds the index before the R8 image starts,
     `scripts/deploy/droplet-up.sh:1350-1355`, and R7 containers running during the migration keep
     their scope target, whose index stays); `scope` gets DROP NOT NULL and is unmapped; the
     entity's scope index becomes `(tenantId, moduleCode, ledger, isActive)`; `scope` leaves the
     input and `ledger` becomes required (BREAKING footer), on the same C1 schedule as
     `moduleCode`.
   - R13, PKG-38: drop `scope`, its type and the scope-keyed indexes.

   **`PERCENT_OF_SCOPE_TOTAL` base.** Its scope is the category's ledger, now spelled
   `(moduleCode, ledger)`: value = percent × the sum of non-computed categories with the same
   `moduleCode` and `ledger` in the period. The evaluator and the ledger loop take that pair instead
   of a `FinanceCategoryScope` (`computed-rule-evaluator.ts:61-72`,
   `finance-ledger-query.service.ts:410-419`). Every existing rule gives the same value. The
   persisted literal keeps its name, so no stored `computedRule` is rewritten.

   Finance events v2 (PKG-15, FARM-MEDIUM-473) replace `scope` with `moduleCode` and `ledger`. No
   service subscribes to the finance category or entry event types (a search of `apps/` and `web/`
   outside the producing finance folders finds none; hr consumes only `FinanceSettingsUpdated`,
   `apps/hr-service/src/finance/services/finance-settings-updated.consumer.ts:56`), so the bump
   orders no consumer. Its upcaster registers in `createDefaultRegistry` as in Addendum A.

   New indexes are built CONCURRENTLY and checked with `indisvalid` before the old ones (found by
   definition) go. The `departments_hr` code index (hr `department.entity.ts:15`) is unchanged.

6. **Organisation units (D7).** NULL `departments_hr.moduleCode` rows, live and deleted, move to
   `hr` with per-schema counts in the migration log; rows tagged farm, sensor or hydroponics keep
   their module (OQ5). PR1 (R6) sets the default `hr` and refuses null on update while the GraphQL
   field stays nullable; PR2 (R7) re-runs the backfill, sets NOT NULL, drops the default and makes
   the field non-null (HR-MEDIUM-068). `hr/services/department-rules.ts` owns the unit rules: a
   live parent in the same module, a site per Decision 3, no module change while employees are
   placed in the unit (HR-MEDIUM-069).

   **HR-LOW-057 disposition.** These rules are the server-side rule the finding asks for. Its rule
   for a `siteId` "with a non-FARM module" becomes the OQ3 rule (any live registry site of the
   tenant, validated by farm-service), because refusing non-farm units at farm sites would
   invalidate units that already point at farm sites. PKG-18 PR2 records the rule half as closed
   in the finding's notes. The finding stays OPEN, under its owner and its deadline 2026-11-21, for
   its other two parts, which this record does not decide: the missing editor for `managerId` and
   `parentDepartmentId`, and employees linked to a soft-deleted unit.

   `siteId` and `parentDepartmentId` become `uuid` at a zero count of non-uuid values (PKG-39,
   HR-MEDIUM-073). The parent self-FK is added only once the erasure sort accepts self-edges.
   That fix is SEC-MEDIUM-211, an existing defect (Context), with its own owner and deadline.
   It does not belong to this program: the shared executor must skip a self-edge as farm's sort does
   (`tenant-erasure.service.ts:1217`), proven by a real-Postgres spec in which a self-referencing
   table erases and a two-table cycle still throws. PKG-39 consumes the fix. PKG-19's hr erasure
   spec also needs it, because the replayed hr schema contains `goals`; so the fix merges before
   PKG-19 (R8), and PKG-00 aligns the finding's deadline with R8 through context-manager. No live
   count runs without operator approval (D7).

7. **Duty assignments (D5).** `hr_employee_module_assignments` is the one record of "employee X is
   on duty in module M", optionally at a site (HR-HIGH-070). States: PENDING, APPROVED, REJECTED,
   CANCELLED; ending is `effectiveTo` plus `endedBy`/`endedAt`, not a state. HR's rows are
   APPROVED; a module manager creates only PENDING rows for a module they manage; only HR decides,
   and nobody decides their own request. CHECKs make a PENDING row created by HR impossible and
   forbid `decidedBy = requestedBy`. There is no self-FK, for a reason of its own: succession is
   already ordered by the effective dates of one employee's rows in one module, and superseding
   ends the old row in the same transaction, so a `supersedesAssignmentId` pointer would be a second
   record of the same order. Placing an employee in a unit creates an `HR_PLACEMENT` row and ends
   the previous unit's row in that transaction; termination ends or cancels the employee's rows.
   The seed reads only the unit's module and counts `farmId`-only mismatches. From PKG-20 membership
   is one EXISTS over APPROVED, effective rows (HR-MEDIUM-071); `common/module-scope.ts` is deleted
   and `employees.farmId` is dropped in PKG-39. A duty never writes auth `user_module_assignments`.

8. **One roster (D8).** A farm worker is an HR employee plus an APPROVED farm assignment. PKG-37
   counts (W0), imports through an HR queue (W1), lets farm stamp its own `farm_workers.resolvedAt`
   and remap tasks, templates and treatments (W2), then removes the roster API (W3). PKG-38 drops
   `farm_workers`, and its `MODULE_SCHEMAS` entry, once farm's own data shows every row resolved.

9. **Company reads.** Company reads common kinds only through nullable company-layer projections
   (PKG-33): registry nodes, headcount, units and a directory without contact data, national id or
   salary. For finance, the OQ2 default applies until the R10 entry gate ("OQ2 answered"): manual
   ledger totals per module and month, never HR, never batch links. If the owner answers otherwise,
   PKG-33 follows the answer and this decision is amended before R10. Site and Department events
   are decided in Addendum A.

10. **Links from farm-private rows into the registry are farm-only, enforced in the database.**
    D2 and Decision 3 make every farm-private reference to a site, site department, supplier or
    consumable a reference to a farm row. PKG-15's R8 migration runs before non-farm writes open.
    It creates one trigger function, `assert_farm_registry_reference`, unqualified per schema, and
    attaches it as `BEFORE INSERT OR UPDATE OF <column>` to each `(table, column, registry table)`
    in the typed list `FARM_PRIVATE_REGISTRY_REFERENCES` (new, beside `farm-scope.ts`). It raises
    unless the named row exists in `TG_TABLE_SCHEMA` with `moduleCode = 'farm'`; a NULL reference
    passes. This is tier 1. Existing rows need no validation, because every registry row is farm
    until R8. The module key never changes (Decision 2), so a reference valid at write stays valid.
    Completeness is tier 3: the `farm-private-common-kind-scope` invariant fails when a farm-service
    entity outside the registry and company-layer folders has a uuid column ending in `siteId`,
    `departmentId`, `supplierId` or `consumableId` that the list does not name. The harness spec
    asserts that every listed pair carries the trigger in a replayed tenant schema. Whether the
    weather and satellite observation tables (Context) are farm-private or part of the site
    aggregate is a site-type question: PKG-14 decides it and records the answer, as a list entry or
    as a named exception with a reason. Why not a constant pin column plus a composite FK: an FK
    requires every existing value to name a row. Most of these columns are bare uuids whose orphans
    have never been counted, so each pin would first be a C7 data-dependent step (FARM-MEDIUM-477
    is that step for the ledger alone). The trigger checks writes only, needs no count, and is one
    mechanism for FK and bare columns alike.

11. **Integration pattern and review routing.** The registry is an Open Host Service of
    farm-service. Its Published Language is `libs/event-contracts/src/site-label-queries.ts`, the
    placement and census queries (PKG-18, PKG-21) and the v2 Site and Department events
    (Addendum A). sensor-service and hr-service are customers that conform to it. They hold
    registry ids and labels and never a copy. In PKG-13, a prompt-writer maintenance pass adds a
    routing row `apps/farm-service/src/{site,department,supplier,consumable,finance}/**` with
    primary farm-expert and also notify sensor-expert and hr-expert to
    `.claude/shared/orchestrator-routing-table.md` (today `apps/farm-service/**` → farm-expert only,
    `:13`). The same pass gives the three expert prompts the review rules of this record: a module
    key on every registry write, no farm-private reference to a non-farm row, and customers use only
    the Published Language. `tests/invariants/orchestrator-routing-coverage.spec.ts` checks that
    the row's agents exist.

12. **The site quota keeps today's meaning.** The quota keeps counting every live registry site
    against `maxFarms`, whatever its module (`create-site.handler.ts:59-67` unchanged). The handler
    is registry code, so `farm-scope.ts` does not apply to it. A per-module quota is a billing
    change the owner has not decided. It is recorded as **OQ7** ("should sensor and hr sites count
    against `maxFarms`, against a per-module limit, or not at all?"). An approved answer lands as
    its own package. No release gate depends on it, because nothing changes until then. This
    record withdraws the plan's PKG-15 step "the site quota counts farm sites only".

## Addendum A — Site and Department event contract v2 (PKG-16, FARM-MEDIUM-472)

- **Change.** `SiteCreated`, `SiteUpdated`, `SiteDeleted`, `DepartmentCreated`,
  `DepartmentUpdated` and `DepartmentDeleted` (`farm-events.ts:582-648`) gain a required
  `moduleCode`, and `version` goes from 1 (the `createBaseEvent` default,
  `libs/event-contracts/src/base-event.ts:242`) to 2. The subjects stay
  `events.<tenant>.<EventType>`.
- **Classification: breaking.** The field is required in the TS interfaces, so a producer that
  omits it no longer compiles. It is also required in the strict wire schema, and every farm schema
  has `additionalProperties: false`
  (`libs/event-contracts/src/schemas/farm-events.schema.ts:38-40`), so a bridge from before R6
  would drop a v2 event. PKG-16 PR2 carries the BREAKING CHANGE footer.
- **Producers.** farm-service only: `create-site.handler.ts:127-128`,
  `update-site.handler.ts:192-193`, `delete-site.handler.ts:199-200`,
  `create-department.handler.ts:94-95`, `update-department.handler.ts:93-94`,
  `delete-department.handler.ts:160-161` (all under
  `apps/farm-service/src/{site,department}/handlers/`). The NATS publish ACL lists exactly these
  six subjects for farm_service (`infrastructure/nats/services.yaml:59-61,105-107`).
- **Consumers.** Two services may subscribe to these subjects: gateway_service and
  messaging_service, both through `events.>` (`services.yaml:409,716`). No other service may, and
  the event store has no `events` subscription (`services.yaml:818-824`).
  - gateway-api `apps/gateway-api/src/websocket/farm-nats-bridge.service.ts` subscribes to the six
    subjects (`:121-126`) with a core subscription (`:233`), validates (`:304`) and dispatches
    (`:393-409`) to `farm.gateway.ts:328-356`, which emits `siteCreated` … `departmentDeleted` to
    sockets.
  - The browser side, `web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts:141-147`, maps
    those socket names to query invalidations and reads no payload field (`:18`).
  - messaging-service subscribes only to `UserDeleted` and `TenantProvisioned`
    (`apps/messaging-service/src/event-handlers/messaging-nats.handler.ts:511,715`).
  - A search of `apps/`, `libs/` and `web/` for the six type names finds no other subscriber.
- **Compatibility: backward-transitive.** From R6 every consumer reads v1 and v2: v1 is upcast to
  v2 before validation. `EventUpcasterRegistry` chains by `fromVersion`
  (`libs/event-contracts/src/upcasters/event-upcaster.ts:38-66`), so a later v3 extends the chain.
- **Upcaster.** `upcasters/site-department-module-v1-to-v2.upcaster.ts` registers one entry per
  event type in `createDefaultRegistry` (`upcasters/index.ts:41-60`). `NatsEventBus` already applies
  that registry (`platform/libs/event-bus/src/nats/nats.module.ts:114,159`,
  `nats-event-bus.ts:1702-1703`), as does the gateway's `nats-bridge.service.ts:66,178`.
  `farm-nats-bridge` gains the same upcast before `validateFarmEvent`; it has none today. The
  upcaster is pure: v1 → `{...event, moduleCode: 'farm', version: 2}`. That is true, not invented:
  v1 is produced only up to R6, and every registry row is farm until non-farm writes open in R8
  (the writable-module constant of Decision 2).
- **Order (C5).** PR1 (R6) ships the schema, the upcaster and the bridge, and the bridge routes by
  module. PR2 (R7) ships the interfaces and the v2 producers. R6 and R7 carry migrations, so no
  image rollback crosses them (plan §6).
- **Why no `.v2` subject and no double-publish.** The repo versions the payload and keeps the
  subject: SensorReading v1→v3, AlertTriggered and BatchHarvested all do so through the same
  registry. A suffix would add six publish entries and a new gateway subscription in
  `services.yaml`, with a double-publish window to serve consumers that cannot read v2. After R6
  there are none, and two copies of each event would double every socket invalidation.
- **HrDepartment events** (PKG-18) are new event types, not a shape change, so they take no version
  bump.

## Enforcement

| Gate                                                                                                                                                                                                                                                                                     | What it pins                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/invariants/common-kind-module-key.spec.ts` (PKG-13)                                                                                                                                                                                                                               | Each registered kind (the seven tables, `DepartmentHR`, the assignment entity) has a non-null module column bound to the dictionary, non-null in GraphQL, absent from update inputs; triggers, CHECKs and composite FKs exist where declared; a module column on an unregistered entity fails. |
| `tests/invariants/module-dictionary-ssot.spec.ts` (PKG-01)                                                                                                                                                                                                                               | No type name is created by two `TENANT_AWARE_SCHEMAS` services; labels replayed into a tenant schema equal the dictionary, which proves each per-schema `ADD VALUE` ran there. Replaces `hr-module-code-parity.spec.ts`.                                                                       |
| `tests/invariants/farm-private-common-kind-scope.spec.ts` (PKG-15)                                                                                                                                                                                                                       | Outside the registry and company-layer folders, no query over Site, Department or Supplier bypasses `farm-scope.ts`, and every farm-private registry-reference column is in `FARM_PRIVATE_REGISTRY_REFERENCES` (Decision 10).                                                                  |
| `tests/invariants/hr-module-membership-ssot.spec.ts` (PKG-20)                                                                                                                                                                                                                            | Only `module-membership.ts` reads assignments for membership; nothing imports `common/module-scope`; no hr source reads `employees.farmId`.                                                                                                                                                    |
| `tests/invariants/company-layer-projection.spec.ts` (PKG-33)                                                                                                                                                                                                                             | Company DTOs declare only allowlisted fields and import no entity; every `company*` resolver is a Query gated by `company:view`.                                                                                                                                                               |
| `tests/invariants/farm-no-worker-roster.spec.ts` (PKG-37)                                                                                                                                                                                                                                | No second workforce roster in farm-service.                                                                                                                                                                                                                                                    |
| `tests/invariants/contract-drop-orphan-first.spec.ts` (rule C4)                                                                                                                                                                                                                          | Every dropped column (`finance_categories.scope`, `employees.farmId`, `tenant_modules.managerId`, …) is already absent from the entities on the PR merge base.                                                                                                                                 |
| `apps/farm-service/src/site/__tests__/resolve-site-labels.responder.spec.ts` (R2)                                                                                                                                                                                                        | 201 ids, an unknown key or an extra key → INVALID_REQUEST; the reply carries exactly `{id, code, name, moduleCode}`; another tenant's id and a deleted site are absent.                                                                                                                        |
| `placementSites` resolver specs in sensor-service and hr-service (PKG-08 PR1)                                                                                                                                                                                                            | Labels only, and only for site ids the caller's own rows reference.                                                                                                                                                                                                                            |
| `apps/farm-service/src/site/__tests__/registry-record-scope.spec.ts` (PKG-13)                                                                                                                                                                                                            | Placement grants nothing on B: a sensor-only caller whose sensors sit at farm site S gets FORBIDDEN on `site(S)`, `updateSite(S)`, `deleteSite(S)` and S's departments. PKG-41 repeats it as a matrix cell.                                                                                    |
| `apps/farm-service/src/site/__tests__/validate-site-placement.responder.spec.ts` and `apps/hr-service/src/common/__tests__/placement-authority.client.spec.ts` (PKG-18)                                                                                                                  | An unknown, deleted or other-tenant site is refused; a NATS timeout, a missing responder or a malformed reply refuses the HR unit create or update (fail closed).                                                                                                                              |
| `apps/hr-service/src/hr/services/__tests__/department-rules.spec.ts` (PKG-18)                                                                                                                                                                                                            | A parent must be live and in the same module; the module cannot change while employees are placed in the unit.                                                                                                                                                                                 |
| `apps/farm-service/src/site/__tests__/site-reference-census.spec.ts` and the census responder specs in sensor, hr and auth (PKG-21)                                                                                                                                                      | The delete is refused on any non-zero count, and also when any responder times out, errors or replies malformed; responders return counts only.                                                                                                                                                |
| `apps/hr-service/src/module-assignment/__tests__/assignment-state-machine.spec.ts` (PKG-19)                                                                                                                                                                                              | HR-created rows are APPROVED; a module manager creates PENDING rows only for a module they manage; only an hr-grant holder approves or rejects; nobody decides their own request. PKG-41's D5 cells repeat it at the gateway.                                                                  |
| `apps/farm-service/src/site/__tests__/create-site.quota.spec.ts` (PKG-13)                                                                                                                                                                                                                | The quota counts every live registry site, whatever its module (Decision 12).                                                                                                                                                                                                                  |
| `apps/farm-service/src/database/migrations/__tests__/registry-module-key.migration.postgres.spec.ts` (PKG-13; real Postgres, FORCE RLS)                                                                                                                                                  | Legacy rows read `farm`; a cross-module FK fails; a module update raises; relfilenode unchanged (ADR-053); an `hr` finance category or entry raises check_violation; a non-farm entry with a `batchId` raises check_violation; the `ledger` backfill maps both scopes and a replay is a no-op. |
| `apps/farm-service/src/database/migrations/__tests__/finance-ledger-key.migration.postgres.spec.ts` (PKG-15)                                                                                                                                                                             | On a fixture with same-named categories in both scopes and both kinds, the new indexes accept and refuse exactly what the scope indexes did; the seed is idempotent against the new `ON CONFLICT` target; the computed rule gives the same value per `(module, ledger)`.                       |
| `apps/farm-service/src/database/migrations/__tests__/farm-registry-reference.migration.postgres.spec.ts` (PKG-15)                                                                                                                                                                        | Every listed pair carries the trigger in a replayed tenant schema; a farm-private insert or update naming a sensor or hr site, department, supplier or consumable raises; a farm one passes.                                                                                                   |
| `apps/hr-service/src/database/migrations/__tests__/department-module.migration.postgres.spec.ts` (PKG-18) and `employee-module-assignments.migration.postgres.spec.ts` (PKG-19)                                                                                                          | Live and deleted NULL units become hr and a replay is a no-op; the assignment CHECKs refuse a PENDING row created by HR and `decidedBy = requestedBy`; seed and replay.                                                                                                                        |
| `libs/backend-common/src/compliance/tenant-erasure/__tests__/tenant-erasure-target-executor.self-reference.spec.ts` (SEC-MEDIUM-211, before PKG-19), then the hr erasure spec of PKG-19                                                                                                  | A self-referencing table sorts and erases; a two-table cycle still throws; the replayed hr schema (with `goals` and, from PKG-39, the unit parent FK) erases. Farm erasure keeps its own sort.                                                                                                 |
| `libs/event-contracts/src/upcasters/__tests__/site-department-module-v1-to-v2.upcaster.spec.ts`, `libs/event-contracts/src/schemas/__tests__/site-department-module.schema.spec.ts`, `apps/gateway-api/src/websocket/__tests__/farm-nats-bridge.upcast.spec.ts`, producer specs (PKG-16) | Each of the six v1 types becomes v2 with `moduleCode: 'farm'`, other fields untouched, and v2 passes unchanged; the schema refuses v2 without `moduleCode`; the bridge upcasts v1 then validates and broadcasts; producers emit version 2 with the row's module.                               |
| e2e `tenant-provisioning-replay`, `tenant-clone-parity`, `schema-invariants`                                                                                                                                                                                                             | New types, tables and triggers replay into a tenant schema.                                                                                                                                                                                                                                    |
| existing `entity-schema-declaration`, `module-schemas-source-parity`, `tenant-fanout-entity-parity`                                                                                                                                                                                      | Stay green: each new hr table enters the hr `MODULE_SCHEMAS` tables in the commit that adds its migration.                                                                                                                                                                                     |

## Implementing packages

| Package                 | Release       | Scope under this record                                                                                                                                                                       |
| ----------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PKG-08                  | R2, R3        | `resolveSiteLabels` responder in R2; `placementSites` callers in R3 (C5)                                                                                                                      |
| PKG-13                  | R6, R7        | Farm type, module columns, `ledger` expand, per-module indexes (finance excepted), composite FKs, triggers, hr and batch CHECKs, routing row; R7 drops the default and sets `ledger` NOT NULL |
| PKG-14                  | R7            | Site types by module; farm-only attributes impossible on other sites; classifies the weather and satellite tables (Decision 10)                                                               |
| PKG-15                  | R8            | `farm-scope.ts`; farm-private reference trigger; non-farm writes open; finance keys, seed target and rule base on `(module, ledger)`; `scope` unmapped; finance events v2; quota unchanged    |
| PKG-16 (absorbs PKG-17) | R6, R7        | Addendum A                                                                                                                                                                                    |
| PKG-18                  | R6, R7        | `departments_hr` NULL→hr, NOT NULL, unit rules (HR-LOW-057 rule half), placement responder, HrDepartment events                                                                               |
| SEC-MEDIUM-211 fix      | before PKG-19 | Shared erasure sort skips self-edges; consumed by PKG-19 and PKG-39                                                                                                                           |
| PKG-19, PKG-20          | R8, R9        | `hr_employee_module_assignments`, state machine, CHECKs, seed; one membership predicate after a re-seed                                                                                       |
| PKG-21                  | R8, R9        | Site reference census (responders first), fail-closed delete                                                                                                                                  |
| PKG-33                  | R10           | Company projections (OQ2 default until the R10 gate)                                                                                                                                          |
| PKG-37                  | R12           | Farm Workers into HR                                                                                                                                                                          |
| PKG-38, PKG-39, PKG-40  | R13           | Orphan drops: farm (FK validation, `scope` with its type and indexes, `farm_workers`), hr (`farmId`, uuid casts, unit parent FK), platform                                                    |

## Consequences

- farm-service availability gates sensor and HR registry writes, HR unit placement, site labels
  and site deletes. Each path fails closed; nothing falls back to a copy.
- Create inputs require `moduleCode` from R8, and finance category inputs require `ledger` instead
  of `scope` (BREAKING footer); list arguments stay optional narrowing filters (ADR-051, rule C2).
- No billing semantic changes in this program (Decision 12, OQ7).
- During R6 the database holds `DEFAULT 'farm'` while the entities declare none. That is not boot
  drift: the validator does not compare defaults
  (`libs/backend-common/src/database/schema-drift-validator.service.ts:69-74`) and has no default
  class (`drift-classes.ts:93-203`), as ADR-053 records.
- A vendor that serves several modules is one supplier row per module. Composite FKs keep supplier
  sites and consumables inside their supplier's module, so the vendor's contact data is kept once
  per module, an edit to one row does not reach the others, and Company lists the vendor under each
  module. Codes are unique per module, so the same code can be reused. A vendor identity shared
  across modules would be a new common kind, which D1 does not name.
- Every write of a farm-private registry reference costs one primary-key lookup (Decision 10).
- Data-dependent steps (finance-entry site FK, `departments.siteId` NOT NULL, uuid casts, the
  `farm_workers` drop) each wait for zero operator counts in their own PR (C7).
- `tenant_modules.managerId`
  (`apps/auth-service/src/modules/tenant/entities/tenant-module.entity.ts:106-108`) duplicates
  `isPrimaryManager`
  (`apps/auth-service/src/modules/authentication/entities/user-module-assignment.entity.ts:68`);
  PKG-40 converts, counts and drops it (RBAC-MEDIUM-041), so the manager concept has one owner.
- The approved plan changes in these places when this record is Accepted:
  - PKG-08: the responder moves to R2.
  - PKG-13 and PKG-15: the ledger steps, the CHECKs, the reference trigger and the routing row are
    added.
  - PKG-14: classifies the observation tables.
  - PKG-15: the quota step is withdrawn.
  - SEC-MEDIUM-211: its fix is ordered before PKG-19.
  - PKG-16: its events section is replaced by Addendum A.
  - OQ7 is added.

## Alternatives considered

- **One shared `owner_module_enum` for farm and hr.** Rejected: both replay into one tenant
  schema, the type would be co-owned, and the `duplicate_object` guard would hide a label mismatch.
- **Re-home other modules' rows onto sensor- and hr-owned copies of each site.** Rejected (OQ3):
  one physical site under several ids; until the counted migrations land, the sensor location
  hierarchy and the HR site view break at R4 enforcement.
- **A registry in each owning service.** Rejected: site, supplier, consumable and ledger code once
  per service is two owners for one concept; every existing cross-service site id names a farm
  site and would need the re-homing above; a site code could no longer be unique per tenant.
- **Merge site departments into organisation units (HR-MEDIUM-053, departments half).** Rejected
  (Decision 1): one is a physical area that owns assets and is keyed by its site, the other is
  reporting structure; a merged row would need both shapes.
- **Only same-module sites for HR units.** Rejected (critic 3): it invalidates units that already
  point at farm sites.
- **Company reads registry resolvers via `company:view` with a fixed farm module.** Rejected:
  Company would reach module operations and a fixed module cannot express sensor or HR rows.
- **Keep the `farm` default.** Rejected: a forgotten module would file a sensor row as farm.
- **Every `departments_hr` row belongs to hr.** Rejected (OQ5): the column becomes a constant.
- **Finance names unique per `(tenant, module, kind)`.** Rejected: it tightens. `kind` does not
  follow scope, so two active categories with one name in `FARM_OPEX` and `FARM_REVENUE`, both
  `EXPENSE`, are legal today and would collide. It also leaves `PERCENT_OF_SCOPE_TOTAL` without a
  base.
- **The same swap gated by an operator count of `(tenant, kind, lower(name))` collisions (C7).**
  Rejected: a module-neutral ledger keeps today's strictness exactly and needs no count.
- **A constant pin column and a composite FK on each farm-private table.** Rejected (Decision 10):
  each bare-uuid column would first need its orphans counted (C7); the trigger needs no count.
- **A `supersedesAssignmentId` self-FK.** Rejected (Decision 7): effective dates already order
  succession, so the pointer would be a second record of it. The erasure sort (SEC-MEDIUM-211) is
  a separate defect, fixed on its own.
- **`.v2` subjects with a double-publish window for Site and Department events.** Rejected
  (Addendum A): no consumer remains that cannot read v2 after R6.
- **The site quota counts farm sites only.** Not adopted: it changes billing without an owner
  decision (Decision 12, OQ7).
- **A farm migration that fails closed when the hr links table is missing.** Rejected: a farm
  migration reading an hr table crosses service ownership and `SCHEMA_REGISTRY` order.
- **Re-encrypt farm workers into employees by an operator command.** Rejected: HR requires fields
  farm workers never had, and placeholder personal data is not allowed.
