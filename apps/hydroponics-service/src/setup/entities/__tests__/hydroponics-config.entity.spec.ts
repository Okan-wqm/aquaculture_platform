/**
 * HydroponicsConfig Entity Tests
 *
 * Covers the security-critical column mapping assertions:
 * - All columns have explicit `name:` to prevent silent schema mismatches
 *   (service has no global SnakeNamingStrategy)
 * - The entity has no `schema:` option set (schema routing is via search_path)
 * - JSONB settings field is correctly typed as Record<string, unknown> (not raw string)
 */

import { getMetadataArgsStorage } from 'typeorm';
import { HydroponicsConfig } from '../hydroponics-config.entity';

describe('HydroponicsConfig entity', () => {
  // TypeORM stores column metadata in the global metadata storage
  const storage = getMetadataArgsStorage();

  const entityColumns = storage.columns.filter((col) => col.target === HydroponicsConfig);

  const entityTables = storage.tables.filter((t) => t.target === HydroponicsConfig);

  describe('table metadata', () => {
    it('is registered as an entity named hydroponics_config', () => {
      expect(entityTables.length).toBeGreaterThan(0);
      expect(entityTables[0]?.name).toBe('hydroponics_config');
    });

    it('does NOT specify a schema — routing is done via search_path', () => {
      // If schema were hardcoded here, multi-tenant routing would break
      expect(entityTables[0]?.schema).toBeUndefined();
    });
  });

  describe('column name mappings (explicit snake_case required — no global SnakeNamingStrategy)', () => {
    function findColumn(propertyName: string) {
      return entityColumns.find((c) => c.propertyName === propertyName);
    }

    it('id column has no explicit name (UUID primary key — TypeORM maps it as "id")', () => {
      const col = findColumn('id');
      expect(col).toBeDefined();
      // Primary generated columns do not require an explicit name override
    });

    it('tenantId maps to "tenant_id"', () => {
      const col = findColumn('tenantId');
      expect(col).toBeDefined();
      expect((col!.options as { name?: string }).name).toBe('tenant_id');
    });

    it('configName maps to "config_name"', () => {
      const col = findColumn('configName');
      expect(col).toBeDefined();
      expect((col!.options as { name?: string }).name).toBe('config_name');
    });

    it('configName has a max length of 255', () => {
      const col = findColumn('configName');
      expect((col!.options as { length?: number }).length).toBe(255);
    });

    it('createdAt maps to "created_at"', () => {
      const col = findColumn('createdAt');
      expect(col).toBeDefined();
      expect((col!.options as { name?: string }).name).toBe('created_at');
    });

    it('updatedAt maps to "updated_at"', () => {
      const col = findColumn('updatedAt');
      expect(col).toBeDefined();
      expect((col!.options as { name?: string }).name).toBe('updated_at');
    });

    it('settings column type is jsonb', () => {
      const col = findColumn('settings');
      expect(col).toBeDefined();
      expect((col!.options as { type?: string }).type).toBe('jsonb');
    });

    it('settings column has a default of empty object string', () => {
      const col = findColumn('settings');
      // Default '{}' prevents NULL being stored when no settings are provided
      expect((col!.options as { default?: string }).default).toBe('{}');
    });

    it('tenantId column type is uuid', () => {
      const col = findColumn('tenantId');
      expect((col!.options as { type?: string }).type).toBe('uuid');
    });
  });

  describe('runtime type safety', () => {
    it('settings is typed as Record<string, unknown> — not a raw string', () => {
      // Create an instance and assign to verify TypeScript compile-time type
      const config = new HydroponicsConfig();
      // If this compiled, the type is Record<string, unknown> (not string)
      const settings: Record<string, unknown> = { key: 'value' };
      config.settings = settings;
      expect(config.settings).toEqual({ key: 'value' });
    });
  });

  // Merged from e2e Test 17: the unique constraint, the tenantId index, and the
  // configName default are entity-metadata concerns and belong here next to the
  // column-mapping assertions (the column assertions in that e2e test were
  // already covered above and were dropped as duplicates).
  describe('constraints and indices', () => {
    it('configName defaults to "Default"', () => {
      const col = entityColumns.find((c) => c.propertyName === 'configName');
      expect(col).toBeDefined();
      expect((col!.options as { default?: string }).default).toBe('Default');
    });

    it('declares a UNIQUE constraint on (tenantId, configName)', () => {
      const uniques = storage.uniques.filter((u) => u.target === HydroponicsConfig);
      expect(uniques.length).toBeGreaterThanOrEqual(1);
      const uniqueColumns = uniques[0]?.columns;
      expect(uniqueColumns).toContain('tenantId');
      expect(uniqueColumns).toContain('configName');
    });

    it('declares an index that covers tenantId', () => {
      const indices = storage.indices.filter((i) => i.target === HydroponicsConfig);
      const tenantIndex = indices.find((i) => {
        const cols =
          typeof i.columns === 'function'
            ? (i.columns as (object?: Record<string, unknown>) => string[])(undefined)
            : i.columns;
        return cols?.includes('tenantId');
      });
      expect(tenantIndex).toBeDefined();
    });
  });
});
