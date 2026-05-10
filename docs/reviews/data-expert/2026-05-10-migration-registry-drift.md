# Migration Registry Drift — apps/farm-service/

**Escalated from:** ARIA self-audit cycle `cyc-20260510T0156Z` (operator-conducted, 2026-05-10)
**Severity:** **CRITICAL** (data corruption + production cold-start failure risk)
**Owner (Accountable):** okan-platform-operator
**Owner (Responsible):** data-expert / database-reviewer agent
**Linked findings:** `aria-findings/F-007.json` (anchor 2 — schema-drift-adapter cross-check upstream)
**Linked plan:** `docs/plans/2026-05-10-aria-self-audit-followups.md` Phase B
**ADR alignment:** ADR-011 (schema-ownership-model), ADR-012 (schema-drift-prevention)

---

## 1. Summary

ARIA's `schema-drift-adapter` and `typeorm-entity-schema-adapter` (both
SHADOW status) flagged 75 raw findings for
`migration_registry_missing_entry` in `apps/farm-service/`. Operator
cross-check (2026-05-10) reduced the SHADOW noise (the two adapters
duplicate each other — F-007 anchor 2) to **5 actual unregistered
migration files** plus **1 timestamp clash** between two migrations.

The clash is the higher-severity issue: TypeORM migration order is
declared by timestamp; two migrations with the SAME timestamp produce
**non-deterministic execution order**, which means the same database
state can take two different shapes depending on which one runs first.
This is a classic schema-drift root cause and ADR-012 (Schema Drift
Prevention) explicitly forbids it.

## 2. Verified Facts (cross-checked against repository at HEAD `2c4aea24`)

| | |
|---|---|
| Migration files on disk (`apps/farm-service/src/database/migrations/*.ts`) | 37 |
| Migration class imports in `app.module.ts` | 31 |
| Migration entries in `migrations: [...]` array (lines 205-237) | 30 |
| **Unregistered migration files** | **5 actual + 1 false positive (.spec.ts)** |
| **Timestamp clashes** | **1 pair** (`1788300000000`) |

### 2.1 Unregistered migrations (real)

| File | Class name (inferred) | Status |
|---|---|---|
| `1786900000000-AlignCodeSequencesSchema.ts` | `AlignCodeSequencesSchema1786900000000` | NOT imported, NOT in registry |
| `1788200000000-AddWaterQualitySensorReadingCorrelation.ts` | `AddWaterQualitySensorReadingCorrelation1788200000000` | NOT imported, NOT in registry |
| `1788210000000-AddWaterQualitySensorReadingCorrelationIndexes.ts` | `AddWaterQualitySensorReadingCorrelationIndexes1788210000000` | NOT imported, NOT in registry |
| `1788300000000-AddFarmAuditLogsImmutability.ts` | `AddFarmAuditLogsImmutability1788300000000` | NOT imported, NOT in registry, **TIMESTAMP CLASH with AddBiomassReports** |
| `1788500000000-CreateTenantErasureAudit.ts` | `CreateTenantErasureAudit1788500000000` | NOT imported, NOT in registry |

### 2.2 Timestamp clash (timestamp `1788300000000`)

| File | Imported / Registered? |
|---|---|
| `1788300000000-AddBiomassReports.ts` | YES (`app.module.ts:237` in array) |
| `1788300000000-AddFarmAuditLogsImmutability.ts` | NO |

**Resulting failure mode:** if `AddFarmAuditLogsImmutability` is ever added to the registry (which it must be, because audit-log immutability is a SOC 2 CC4 control), TypeORM's migration runner will sort BOTH migrations to position `1788300000000` and pick a non-deterministic order. The two migrations operate on different tables (audit logs vs biomass reports), so the immediate database state may not corrupt — but the migrations table itself records a non-canonical order, breaking rollback (`migration:revert` cannot deterministically undo a non-deterministic apply).

### 2.3 False positive (excluded)

- `1781200000000-ConvertFarmOutboxToIdentity.spec.ts` — `.spec.ts` is a test file; named with the timestamp because the test asserts behavior of the migration class. Not a migration that needs registration. ARIA's `migration_registry_missing_entry` rule should exclude `.spec.ts` extensions. This is a separate adapter calibration concern → tracked in F-007 anchor 3.

## 3. Risk

| Vector | Severity | Likelihood |
|---|---|---|
| Migration order non-deterministic (timestamp clash) → migrations table corruption / rollback impossible | **CRITICAL** | Medium (only triggers when the unregistered migration is added) |
| Production cold-start fails because SchemaDriftValidator (ADR-012) detects entity ↔ table mismatch from missing migrations | **HIGH** | High (5 migrations represent real schema changes; their absence at production runtime IS schema drift) |
| TenantErasureAudit unregistered → GDPR Art 17 erasure cascade audit table missing in production | **HIGH** (compliance) | High |
| AuditLogImmutability unregistered → SOC 2 CC4 audit log control absent | **HIGH** (compliance) | High |

## 4. Required Actions (data-expert / database-reviewer)

### 4.1 Immediate triage (do not deploy until resolved)

1. **Determine production deployment status of each unregistered migration:**
   - Run `db-migrate` CLI list against the production migrations table and compare against the 5 unregistered file names
   - If a file's class is in the production migrations table but not imported in `app.module.ts`, that's a deployment regression — the migration ran historically but the import was lost
   - If a file's class is NOT in the production migrations table AND not imported, the migration has never run (true drift)

2. **For the timestamp clash:**
   - **Preferred fix**: rename `1788300000000-AddFarmAuditLogsImmutability.ts` to a new timestamp (e.g. `1788301000000-AddFarmAuditLogsImmutability.ts`); update class name accordingly
   - **Alternative if migration already in production table**: leave the file timestamp as-is, document the clash via ADR addendum, and accept that any future migration touching this timestamp range must avoid clash by inspection
   - Decision criterion: production deployment status (step 1)

3. **Register the 5 unregistered migrations** in `app.module.ts`:
   - Add `import` line for each
   - Add class to `migrations: [...]` array at correct timestamp position
   - Verify timestamp ordering ascending

### 4.2 Verification

After fix:

- [ ] `e2e/tests/integration/schema-invariants.spec.ts` green
- [ ] `npm run type-check` green
- [ ] `nx affected --target=test` (farm-service scope) green
- [ ] Production deploy dry-run with `DATABASE_MIGRATIONS_RUN=true` in e2e env yeşil
- [ ] `db-migrate` CLI dry-run output shows deterministic migration order
- [ ] SchemaDriftValidator boot logs no drift event

### 4.3 Compliance follow-up

- [ ] If `CreateTenantErasureAudit` unregistered for >30 days in production → GDPR Art 30 (records of processing) audit gap; compliance-expert review
- [ ] If `AddFarmAuditLogsImmutability` unregistered → SOC 2 CC4 audit-log immutability control absent; compliance-expert review
- [ ] Update `docs/security/audit-reports/` with the resolution

## 5. Rollback strategy

- **Pre-merge**: review feedback → revise registry; no production touched
- **Post-merge bug**: each migration registration is an independent commit; revert the bad one
- **Production-side**: blue-green safe — if a registered migration starts failing on rollout, automatic rollback to previous container image (which lacks the new import) reverts the runtime; the migrations table state is consistent regardless

## 6. Out of Scope (for this escalation)

- ❌ Other services' migration registries (`apps/admin-api-service`, `apps/sensor-service`, etc.) — not flagged by ARIA cycle but should get a follow-up sweep
- ❌ Adapter consolidation (schema-drift vs typeorm-entity-schema duplicate work) — F-007 anchor 2 owns this
- ❌ ARIA SHADOW → ACTIVE promotion gating — F-007 anchor 1 owns this
- ❌ The single `.spec.ts` false-positive in ARIA's adapter — F-007 anchor 3 owns this

## 7. Evidence trail

| Artifact | Path |
|---|---|
| Raw ARIA findings (cycle `cyc-20260510T0156Z`) | `/tmp/aria-sandbox/tools/raw-findings.jsonl` (preserved at `docs/aria/cycle-snapshots/cyc-20260510T0156Z/raw-findings.jsonl` if Plan v2 OQ6=yes) |
| Cross-check session | conversation 2026-05-10 (operator + Claude) |
| Linked finding | `aria-findings/F-007.json#F-007-anchor-2` |
| Linked plan | `docs/plans/2026-05-10-aria-self-audit-followups.md` Phase B |

## 8. Sign-off

- [ ] data-expert triage complete (5 unregistered migrations + timestamp clash resolved)
- [ ] e2e/integration tests green
- [ ] Production deploy dry-run green
- [ ] compliance-expert review (if compliance-impact migrations confirmed)
- [ ] Operator (okan-platform-operator) sign-off
- [ ] This file updated with resolution notes + closing PR link
