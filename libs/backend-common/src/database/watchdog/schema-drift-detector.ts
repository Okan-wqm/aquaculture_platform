import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { MODULE_SCHEMAS } from '../schema-manager.service';
import { listTenantSchemas } from '../tenant-schema.utils';

import { WatchdogViolation } from './source-schema-scanner';

/**
 * SchemaDriftDetector verifies that all tenant schemas match the MODULE_SCHEMAS definition
 * and are consistent with each other.
 *
 * Drift can occur when:
 * - A new table is added to MODULE_SCHEMAS but existing tenant schemas aren't migrated
 * - A table is manually dropped from a tenant schema
 * - A service's TypeORM synchronize creates unexpected tables
 * - A migration runs only on some tenant schemas (partial deployment)
 */
export class SchemaDriftDetector {
  private readonly logger = new Logger(SchemaDriftDetector.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Detect schema drift across all tenant schemas.
   *
   * Checks:
   * 1. Every table in MODULE_SCHEMAS should exist in every tenant schema
   * 2. All tenant schemas should have the same set of tables (consistency)
   *
   * @returns Array of violations found (empty = no drift)
   */
  async detect(): Promise<WatchdogViolation[]> {
    const violations: WatchdogViolation[] = [];
    const schemas = await listTenantSchemas(this.dataSource);

    if (schemas.length === 0) {
      this.logger.debug('No tenant schemas found -- nothing to check for drift');
      return violations;
    }

    const expectedTables = MODULE_SCHEMAS.flatMap((m) => m.tables).sort();

    // Track table sets per schema for cross-schema consistency check
    const schemaTableSets = new Map<string, string[]>();

    for (const schema of schemas) {
      try {
        const tables: { table_name: string }[] = await this.dataSource.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 ORDER BY table_name`,
          [schema],
        );
        const tableNames = tables.map((t) => t.table_name).sort();
        schemaTableSets.set(schema, tableNames);

        // Check 1: Every expected table should exist
        for (const expected of expectedTables) {
          if (!tableNames.includes(expected)) {
            // Determine which module this table belongs to
            const ownerModule = MODULE_SCHEMAS.find((m) => m.tables.includes(expected));
            violations.push({
              type: 'MISSING_TABLE',
              severity: 'HIGH',
              schema,
              table: expected,
              details:
                `Table "${expected}" (module: ${ownerModule?.moduleName ?? 'unknown'}) is defined in ` +
                `MODULE_SCHEMAS but missing from tenant schema "${schema}". ` +
                `Run schema migration or re-provision this tenant.`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Check 2: Detect unexpected extra tables (informational, not necessarily bad)
        const extraTables = tableNames.filter((t) => !expectedTables.includes(t));
        if (extraTables.length > 0) {
          this.logger.debug(
            `Schema ${schema} has ${extraTables.length} extra tables not in MODULE_SCHEMAS: ${extraTables.join(', ')}`,
          );
        }
      } catch (err) {
        this.logger.warn(`Could not query tables for schema ${schema}: ${(err as Error).message}`);
      }
    }

    // Check 3: Cross-schema consistency -- all tenant schemas should match each other.
    // Use majority-vote to determine the "canonical" table set instead of arbitrarily
    // picking the first schema as reference. This prevents a single drifted schema
    // from making all other schemas appear inconsistent.
    if (schemaTableSets.size >= 2) {
      const entries = [...schemaTableSets.entries()];

      // Build a canonical set: for each table, count how many schemas have it.
      // A table is "canonical" if it appears in > 50% of schemas.
      const tableCounts = new Map<string, number>();
      for (const [, tables] of entries) {
        for (const t of tables) {
          tableCounts.set(t, (tableCounts.get(t) || 0) + 1);
        }
      }
      const threshold = Math.ceil(entries.length / 2);
      const canonicalTables = [...tableCounts.entries()]
        .filter(([, count]) => count >= threshold)
        .map(([table]) => table)
        .sort();

      for (const [schema, tables] of entries) {
        const missingFromCanonical = canonicalTables.filter((t) => !tables.includes(t));
        const extraVsCanonical = tables.filter((t) => !canonicalTables.includes(t));

        if (missingFromCanonical.length > 0) {
          violations.push({
            type: 'SCHEMA_DRIFT',
            severity: 'HIGH',
            schema,
            table: missingFromCanonical.join(', '),
            details:
              `Schema "${schema}" is missing ${missingFromCanonical.length} tables present in ` +
              `the majority of tenant schemas: [${missingFromCanonical.join(', ')}]. ` +
              `This indicates inconsistent provisioning or partial migration.`,
            timestamp: new Date().toISOString(),
          });
        }

        if (extraVsCanonical.length > 0) {
          violations.push({
            type: 'SCHEMA_DRIFT',
            severity: 'MEDIUM',
            schema,
            table: extraVsCanonical.join(', '),
            details:
              `Schema "${schema}" has ${extraVsCanonical.length} extra tables not present in ` +
              `the majority of tenant schemas: [${extraVsCanonical.join(', ')}]. ` +
              `This may indicate a partial migration that ran only on some tenants.`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    return violations;
  }
}
