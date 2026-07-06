/**
 * Platform-wide invariant — TENANT-FANOUT-CRITICAL-001 / Faz 1.12 + 1.13:
 *
 * **Every per-tenant entity declared in a tenant-scoped service MUST be
 * listed in `MODULE_SCHEMAS.tables` for that service. Every cross-tenant
 * entity in the same service MUST be listed in
 * `MODULE_SCHEMAS.infrastructureTables` or `referenceDataTables`.**
 *
 * # WHY
 *
 * `MODULE_SCHEMAS` (libs/backend-common/src/database/schema-manager.service.ts)
 * is the SSoT that drives tenant-schema fan-out:
 *
 *   ```ts
 *   for (const tableName of moduleSchema.tables) {
 *     CREATE TABLE "<tenant_uuid>"."<tableName>" (LIKE "<source>"."<tableName>" INCLUDING ALL)
 *   }
 *   ```
 *
 * An entity that is declared with `@Entity('foo')` but NOT listed in
 * `MODULE_SCHEMAS.tables` will:
 *
 *   - exist in the source schema (TypeORM creates it via migrations);
 *   - never be cloned into any `tenant_<uuid>` schema;
 *   - cause `column does not exist` / `relation … does not exist` errors
 *     the first time a tenant request reaches the missing-table path.
 *
 * This is the architectural cause of the "tenant N has the table but
 * tenant M does not" class of incidents. It is also the source-level
 * dual of the runtime `tenant-fanout-completeness` smoke test (Faz 6
 * smoke step) — once Faz 6 baseline reset lands, the runtime test
 * verifies live DDL parity; this source invariant verifies the SSoT
 * declarations match the entity surface at PR time.
 *
 * # SCOPE
 *
 * Tenant-scoped services only — `farm`, `sensor`, `hr`, `messaging`,
 * `hydroponics`, `ai`, `alert`. Platform-level services (auth, billing,
 * admin, notification, event-store, observability, config) have no
 * per-tenant fan-out and are excluded from this invariant.
 *
 * # CLASSIFICATION
 *
 * Mirrors `entity-schema-declaration.spec.ts` heuristics for per-tenant
 * vs cross-tenant determination — see `CROSS_TENANT_FILENAME_PATTERNS`
 * below. Kept inline here (not imported from the sibling spec) so each
 * spec is self-contained for the CI shard parallelism.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

import {
  MODULE_SCHEMAS,
  type ModuleSchema,
} from '../../libs/backend-common/src/database/schema-manager.service';

const REPO_ROOT = resolve(__dirname, '..', '..');

const TENANT_SCOPED_SERVICE_DIRS = new Map<string, string>([
  ['farm-service', 'farm'],
  ['sensor-service', 'sensor'],
  ['hr-service', 'hr'],
  ['messaging-service', 'messaging'],
  ['hydroponics-service', 'hydroponics'],
  ['alert-engine', 'alert'],
  ['ai-service', 'ai'],
]);

const CROSS_TENANT_FILENAME_PATTERNS: readonly RegExp[] = [
  /-outbox\.entity\.ts$/i,
  /outbox-.*\.entity\.ts$/i,
  /-audit-log\.entity\.ts$/i,
  /audit-log\.entity\.ts$/i,
  /-audit\.entity\.ts$/i,
  /audit\.entity\.ts$/i,
  /retention.*\.entity\.ts$/i,
  /-compliance\.entity\.ts$/i,
  /compliance.*\.entity\.ts$/i,
  /-legal-hold\.entity\.ts$/i,
  /legal-hold\.entity\.ts$/i,
  /tenant-erasure-audit\.entity\.ts$/i,
  /tool-execution-audit\.entity\.ts$/i,
  /stripe-webhook-event\.entity\.ts$/i,
  /audit-entry\.entity\.ts$/i,
  /embeddings-metadata\.entity\.ts$/i,
  // Send-idempotency ledger (DATA-HIGH-007): cross-tenant unique anchor.
  /message-send-idempotency\.entity\.ts$/i,
  // SENSOR-MEDIUM-009: global VFD vendor reference data (Danfoss/ABB register
  // addresses) — one cross-tenant table pinned to `sensor`, no per-tenant clone.
  /vfd-register-mapping\.entity\.ts$/i,
];

const TENANT_OWNED_FILENAME_OVERRIDES = new Set<string>([
  'apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts',
  'apps/messaging-service/src/compliance/entities/legal-hold.entity.ts',
  'apps/messaging-service/src/compliance/entities/retention-policy.entity.ts',
  'apps/sensor-service/src/vfd-programming/entities/vfd-parameter-audit-log.entity.ts',
]);

/**
 * Best-effort table-name extraction from an entity file. Matches both:
 *   @Entity('table_name')
 *   @Entity({ name: 'table_name', schema: 'xxx' })
 *   @Entity('table_name', { schema: 'xxx' })
 * Parameter-less @Entity() (abstract base) returns null.
 */
function extractTableName(src: string): string | null {
  // Match @Entity( ... ) with brace/quote balancing
  const m = /(^|[^A-Za-z_])@Entity\s*\(\s*(?:['"]([a-z_][a-z0-9_]*)['"])/m.exec(
    src,
  );
  if (m && m[2]) return m[2];
  const objForm = /@Entity\s*\(\s*\{\s*name\s*:\s*['"]([a-z_][a-z0-9_]*)['"]/m.exec(
    src,
  );
  if (objForm && objForm[1]) return objForm[1];
  return null;
}

function listEntityFiles(serviceDir: string): string[] {
  let out: string;
  try {
    out = execSync(
      `git -C ${REPO_ROOT} grep -lE '@Entity\\(' -- 'apps/${serviceDir}/src/**/*.entity.ts'`,
      { encoding: 'utf8' },
    );
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
  return out.split('\n').filter(Boolean);
}

interface Violation {
  service: string;
  reason: string;
  details: string;
}

describe('INVARIANT — tenant-fanout entity ↔ MODULE_SCHEMAS parity (TENANT-FANOUT-CRITICAL-001)', () => {
  const moduleSchemaByName = new Map<string, ModuleSchema>(
    MODULE_SCHEMAS.map((m) => [m.moduleName, m]),
  );

  it('every tenant-scoped service has a MODULE_SCHEMAS entry', () => {
    const missing: string[] = [];
    for (const [, schemaName] of TENANT_SCOPED_SERVICE_DIRS) {
      if (!moduleSchemaByName.has(schemaName)) {
        missing.push(schemaName);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every per-tenant entity is listed in MODULE_SCHEMAS.tables; every cross-tenant entity is in infrastructureTables/referenceDataTables', () => {
    const violations: Violation[] = [];

    for (const [serviceDir, schemaName] of TENANT_SCOPED_SERVICE_DIRS) {
      const ms = moduleSchemaByName.get(schemaName);
      if (!ms) continue; // Covered by the prior test.

      const perTenantTables = new Set(ms.tables);
      const allowedNonTenantTables = new Set<string>([
        ...(ms.referenceDataTables ?? []),
        ...(ms.infrastructureTables ?? []),
      ]);

      const entityFiles = listEntityFiles(serviceDir);
      for (const relPath of entityFiles) {
        const fullPath = resolve(REPO_ROOT, relPath);
        const src = readFileSync(fullPath, 'utf8');

        // Skip if @Entity() is parameterless (abstract base class)
        const tableName = extractTableName(src);
        if (!tableName) continue;

        const isCrossTenant =
          !TENANT_OWNED_FILENAME_OVERRIDES.has(relPath) &&
          CROSS_TENANT_FILENAME_PATTERNS.some((re) => re.test(basename(relPath)));

        if (isCrossTenant) {
          // Cross-tenant entities should NOT be in `tables` (would
          // attempt to clone an outbox per tenant — nonsensical) but
          // SHOULD be in infrastructureTables or referenceDataTables
          // (or be considered acceptable platform-level surface).
          if (perTenantTables.has(tableName) && !allowedNonTenantTables.has(tableName)) {
            violations.push({
              service: schemaName,
              reason: `cross-tenant entity ${tableName} (file ${relPath}) is in MODULE_SCHEMAS.tables — would be cloned per-tenant, breaking the cross-tenant semantic`,
              details: `entity-file: ${relPath}`,
            });
          } else if (!allowedNonTenantTables.has(tableName)) {
            // Cross-tenant entity but not in any non-tenant list — soft warn.
            // The MAINTENANCE CONTRACT calls for it to be listed in
            // infrastructureTables when SourceSchemaBootstrapService
            // strictOwnership is enabled; otherwise it is implicitly
            // tolerated. We still surface this so it can be fixed.
            violations.push({
              service: schemaName,
              reason: `cross-tenant entity ${tableName} (file ${relPath}) is NOT listed in MODULE_SCHEMAS.infrastructureTables nor referenceDataTables`,
              details: `entity-file: ${relPath}`,
            });
          }
        } else {
          // Per-tenant entity — MUST be in MODULE_SCHEMAS.tables.
          if (!perTenantTables.has(tableName)) {
            violations.push({
              service: schemaName,
              reason: `per-tenant entity ${tableName} (file ${relPath}) is NOT listed in MODULE_SCHEMAS.tables — would never be cloned into tenant_<uuid> schemas, causing missing-table failures on tenant requests`,
              details: `entity-file: ${relPath}`,
            });
          }
        }
      }

      // Reverse check: MODULE_SCHEMAS.tables entries must have a backing entity.
      const declaredEntityTables = new Set<string>();
      for (const relPath of entityFiles) {
        const fullPath = resolve(REPO_ROOT, relPath);
        const src = readFileSync(fullPath, 'utf8');
        const t = extractTableName(src);
        if (t) declaredEntityTables.add(t);
      }
      for (const tbl of ms.tables) {
        if (!declaredEntityTables.has(tbl)) {
          // Soft warn — could be a legacy table dropped from entity layer
          // but still listed for fan-out. Surfacing for explicit cleanup
          // during Faz 6 baseline reset.
          violations.push({
            service: schemaName,
            reason: `MODULE_SCHEMAS.tables lists "${tbl}" but no entity file under apps/${serviceDir}/src declares it — orphan fan-out entry`,
            details: `module-schemas-entry: ${schemaName} -> tables`,
          });
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - ${v.service}: ${v.reason}\n      ${v.details}`)
        .join('\n');
      throw new Error(
        `tenant-fanout entity ↔ MODULE_SCHEMAS parity violated:\n${detail}\n\n` +
          `Resolution:\n` +
          `  1. For per-tenant entities missing from MODULE_SCHEMAS.tables: add the\n` +
          `     table name to the relevant module's tables array in\n` +
          `     libs/backend-common/src/database/schema-manager.service.ts.\n` +
          `  2. For orphan MODULE_SCHEMAS entries (no backing entity): either\n` +
          `     restore the entity or drop the entry (Faz 6 baseline cleanup).\n` +
          `  3. For cross-tenant entities missing from infrastructureTables:\n` +
          `     add the table name to ms.infrastructureTables — required when\n` +
          `     strictOwnership=true on the module.\n` +
          `  4. CODEOWNERS review by database-reviewer for any of the above.\n`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
