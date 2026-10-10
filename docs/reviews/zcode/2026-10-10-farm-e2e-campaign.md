# Farm Module End-to-End Campaign — 2026-10-10

Agent: zcode (GUI browser session + 12 parallel per-tab agents, live stack
`app.suderra.com`, tenant `7f6b08ab-90e2-46d3-a260-cb985f1fd897`, user
`codex-test-202605240515@suderra.test`).

Method: real-browser CRUD flows (sites/tank/feed), then one agent per farm
sidebar section exercising UI-source mapping, live GraphQL CRUD and row-level
DB verification. Deployed image `323f9f60` == `origin/main` at test time; the
droplet checkout tree was ~2548 commits stale and was NOT used as evidence.

## Fixed in this review's commits

- **FARM-CRITICAL-405** — CRITICAL (backend): plan-quota and duplicate-name/code
  checks counted soft-deleted rows (`create-site.handler.ts` lacked
  `isDeleted: false`; `create-tank.handler.ts` lacked `isActive: true`), so a
  tenant with 2 live sites and 3 deleted ones could never create a site.
- **FARM-CRITICAL-406** — CRITICAL (backend): PostgreSQL `date` columns hydrate as
  strings; GraphQL `DateTime` refuses them, killing every read that selects
  them (`feedingRecords`, `harvestPlans`/`harvests`, `storageInventory`
  expiry, `updateTask` dueDate ISO serialization). Fixed with the shared
  `DateColumnTransformer` on the six verified-broken entities.
- **FARM-MEDIUM-424** — tracked follow-up (owner: database-reviewer): 45
  further Date-typed `date` columns across farm/hr/billing/admin are listed in
  the new invariant's allowlist and need the same conversion, each verified
  for `YYYY-MM-DD` string-format dependencies first.
- **FARM-CRITICAL-407** — CRITICAL (deploy config): `farm_workers` PII columns
  fail-closed without `EMPLOYEE_PII_ENCRYPTION_KEY` /
  `EMPLOYEE_PII_BLIND_INDEX_KEY`; the droplet env lacked them, so the entire
  Workers tab returned INTERNAL_SERVER_ERROR. Both vars are now required in
  `docker-compose.droplet.yml` (farm-service gets both, hr-service the shared
  encryption key). Operator action: set both in the droplet `.env` before the
  next deploy (blind-index key already present; generate the encryption key).
- **FARM-MEDIUM-414** — MEDIUM (backend): `stockMovements` filter compared raw
  client strings against lowercase DB values while the response serializes
  UPPERCASE enum names; the handler now accepts both spellings.
- **FARM-CRITICAL-408** — CRITICAL (frontend): `useTasks` called
  `startTask(id:)` / `completeTask(id:)` while the schema requires
  `input: TaskLifecycleInput!` with the at-most-once envelope — the buttons
  could never work. Now sends the envelope via `buildCommandEnvelope`.
- **FARM-CRITICAL-409** — CRITICAL (frontend/backend enum-case family): UIs sent
  lowercase DB values where the wire wants the UPPERCASE enum name — Health
  Events (all five enums, module-dead), Tanks mortality/cull reasons
  (module-dead for those flows), Harvest page (create/update payloads), the
  Chemicals category dropdown (catalog codes) and `PH_ADJUSTER` → schema
  `pH_ADJUSTER`. Fixed at each boundary; the harvest hook gained explicit
  wire↔UI translation because that page's whole vocabulary is lowercase.
- **FARM-HIGH-412** — HIGH (frontend): Departments offered a `STORAGE` type the
  backend `DepartmentType` enum does not define and hid six real ones;
  option list now mirrors the enum exactly.
- **FARM-HIGH-413** — HIGH (frontend): `FALLBACK_FEED_TYPES` listed
  `HATCHERY`/`NURSERY` which are not `FeedType` members — picking them made
  feed creation fail schema validation with no visible error. Fallback now
  mirrors the enum.
- **FARM-CRITICAL-410** — CRITICAL (backend DTOs): `ReportPrefillInput` and
  `CreateFinanceCategoryInput.scope/kind` carried `@Field` without
  class-validator decorators, so the global whitelist pipe rejected the DTOs'
  own fields ("property reportType should not exist") — `reportPrefill` and
  finance category creation were uncallable. Validators added.
- **FARM-CRITICAL-411** — CRITICAL (backend): `derived-cost-sources.ts` compared
  `wo."status" != 'CANCELLED'` against a lowercase-only DB enum, crashing
  `financeSummary` and derived `financeLedger`; now uses the
  `WorkOrderStatus.CANCELLED` value.
- **FARM-MEDIUM-415** — MEDIUM (backend response): `EquipmentResponse` lacked
  `operatingHours`/`maintenanceSchedule` although both are writable and
  persisted; the fields were unreadable over GraphQL. Added.

## Not fixed here (tracked, separate scopes)

- FARM-HIGH-416 — sub-equipment type catalog never seeded (`sub_equipment_types`
  empty; UI flow dead).
- FARM-HIGH-417 — species `optimal` temperature required server-side but
  optional in UI; `feedIds` accepted and silently dropped.
- FARM-HIGH-418 — supplier `code` required server-side but optional in UI;
  `products`/flat `city` silently dropped on create.
- FARM-MEDIUM-419 — chemical storage fields dropped on create (persisted only on
  update); `withdrawalPeriodDays` never sent; multi-site chemical management
  absent (`chemical_sites` orphaned on delete).
- FARM-MEDIUM-420 — maintenance "delete" mutations are status flips reporting
  success; `deleteFeed` leaks raw Postgres errors on non-UUID ids; soft-deleted
  feed stays readable via `feed(id)`; harvest delete absent for biomass
  reports; `restore*` mutations unused by any UI.
- FARM-MEDIUM-421 — shell/session robustness: expired token + rotated refresh
  cookie leaves the SPA on an infinite "Dashboard loading…" without redirect;
  an unauthenticated background query polls forever.
- FARM-MEDIUM-422 — Workers tab UX: status badge dead (not writable), department
  hardcoded 'operations', delete button shown to roles that cannot delete,
  soft-deleted emails permanently blocked (blind-index not filtered).
- FARM-MEDIUM-423 — environment monitoring disabled by config
  (`FARM_ENVIRONMENT_MONITORING_ENABLED` unset): decide intent and either
  enable or surface a proper "feature disabled" state.
