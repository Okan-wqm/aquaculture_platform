import {
  DEFAULT_TENANT_MODULES,
  MODULE_SCHEMAS,
  PLATFORM_LEVEL_MODULES,
  TENANT_SCOPED_MODULES,
} from '../schema-manager.service';

describe('Tenant Isolation Static Analysis', () => {

  describe('MODULE_SCHEMAS completeness', () => {
    it('should have entries for all default tenant modules', () => {
      const moduleNames = MODULE_SCHEMAS.map(m => m.moduleName);
      expect(moduleNames).toEqual(expect.arrayContaining(DEFAULT_TENANT_MODULES));
    });

    it('every module should have at least 1 table', () => {
      for (const mod of MODULE_SCHEMAS) {
        expect(mod.tables.length).toBeGreaterThan(0);
      }
    });

    it('no duplicate table names across modules', () => {
      const allTables = MODULE_SCHEMAS.flatMap(m => m.tables);
      const duplicates = allTables.filter((t, i) => allTables.indexOf(t) !== i);
      expect(duplicates).toEqual([]);
    });

    it('referenceDataTables should be subset of tables', () => {
      for (const mod of MODULE_SCHEMAS) {
        for (const ref of (mod.referenceDataTables ?? [])) {
          expect(mod.tables).toContain(ref);
        }
      }
    });

    it('total table count should be 170', () => {
      const total = MODULE_SCHEMAS.reduce((sum, m) => sum + m.tables.length, 0);
      expect(total).toBe(170);
    });

    it('every module should have a sourceSchema', () => {
      for (const mod of MODULE_SCHEMAS) {
        expect(mod.sourceSchema).toBeTruthy();
        expect(typeof mod.sourceSchema).toBe('string');
        expect(mod.sourceSchema.length).toBeGreaterThan(0);
      }
    });

    it('sourceSchema should match moduleName by convention', () => {
      // In this codebase, sourceSchema === moduleName for all modules
      for (const mod of MODULE_SCHEMAS) {
        expect(mod.sourceSchema).toBe(mod.moduleName);
      }
    });

    it('table names should be valid SQL identifiers (lowercase snake_case)', () => {
      const validIdentifier = /^[a-z][a-z0-9_]*$/;
      for (const mod of MODULE_SCHEMAS) {
        for (const table of mod.tables) {
          expect(table).toMatch(validIdentifier);
        }
      }
    });

    it('referenceDataTables should default to empty array when not provided', () => {
      for (const mod of MODULE_SCHEMAS) {
        const refTables = mod.referenceDataTables ?? [];
        expect(Array.isArray(refTables)).toBe(true);
      }
    });

    it('module names should be unique', () => {
      const names = MODULE_SCHEMAS.map(m => m.moduleName);
      const unique = [...new Set(names)];
      expect(names).toEqual(unique);
    });

    it('should have expected module table counts', () => {
      const counts: Record<string, number> = {};
      for (const mod of MODULE_SCHEMAS) {
        counts[mod.moduleName] = mod.tables.length;
      }
      // These are the known counts from the codebase
      expect(counts['sensor']).toBe(45);
      expect(counts['farm']).toBe(73);
      expect(counts['hr']).toBe(25);
      expect(counts['hydroponics']).toBe(1);
      expect(counts['alert']).toBe(4);
      expect(counts['ai']).toBe(2);
      expect(counts['messaging']).toBe(15);
      expect(counts['auth']).toBe(3);
      expect(counts['notification']).toBe(2);
    });
  });

  describe('DEFAULT_TENANT_MODULES', () => {
    it('should include all tenant-scoped modules', () => {
      expect(DEFAULT_TENANT_MODULES).toHaveLength(7);
      expect(DEFAULT_TENANT_MODULES).toContain('sensor');
      expect(DEFAULT_TENANT_MODULES).toContain('farm');
      expect(DEFAULT_TENANT_MODULES).toContain('hr');
      expect(DEFAULT_TENANT_MODULES).toContain('hydroponics');
      expect(DEFAULT_TENANT_MODULES).toContain('alert');
      expect(DEFAULT_TENANT_MODULES).toContain('ai');
      expect(DEFAULT_TENANT_MODULES).toContain('messaging');
    });

    it('should be derived from tenant-scoped MODULE_SCHEMAS only (no drift)', () => {
      const derived = MODULE_SCHEMAS
        .filter((m) => TENANT_SCOPED_MODULES.has(m.moduleName))
        .map(m => m.moduleName);
      expect(DEFAULT_TENANT_MODULES).toEqual(derived);
    });

    it('should not include platform-level schemas', () => {
      for (const moduleName of DEFAULT_TENANT_MODULES) {
        expect(PLATFORM_LEVEL_MODULES.has(moduleName)).toBe(false);
      }
    });

    it('order should match tenant-scoped MODULE_SCHEMAS order', () => {
      const tenantScopedModules = MODULE_SCHEMAS.filter((m) =>
        TENANT_SCOPED_MODULES.has(m.moduleName),
      );
      for (let i = 0; i < DEFAULT_TENANT_MODULES.length; i++) {
        const expectedModule = tenantScopedModules[i];
        expect(expectedModule).toBeDefined();
        expect(DEFAULT_TENANT_MODULES[i]).toBe(expectedModule?.moduleName);
      }
    });
  });

  describe('Cross-module reference integrity', () => {
    it('no table should appear in multiple modules', () => {
      const tablesToModules = new Map<string, string[]>();
      for (const mod of MODULE_SCHEMAS) {
        for (const table of mod.tables) {
          const existing = tablesToModules.get(table) ?? [];
          existing.push(mod.moduleName);
          tablesToModules.set(table, existing);
        }
      }
      const conflicts = [...tablesToModules.entries()]
        .filter(([, modules]) => modules.length > 1)
        .map(([table, modules]) => `${table} -> [${modules.join(', ')}]`);
      expect(conflicts).toEqual([]);
    });

    it('reference data tables for each module should exist in correct source schema mapping', () => {
      for (const mod of MODULE_SCHEMAS) {
        const refTables = mod.referenceDataTables ?? [];
        for (const ref of refTables) {
          // The reference table must belong to the same module
          expect(mod.tables).toContain(ref);
        }
      }
    });
  });
});
