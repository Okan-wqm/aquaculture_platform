import { MODULE_SCHEMAS, DEFAULT_TENANT_MODULES } from '../schema-manager.service';

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

    it('total table count should be 133', () => {
      const total = MODULE_SCHEMAS.reduce((sum, m) => sum + m.tables.length, 0);
      expect(total).toBe(133);
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
      expect(counts['sensor']).toBe(34);
      expect(counts['farm']).toBe(66);
      expect(counts['hr']).toBe(24);
      expect(counts['hydroponics']).toBe(1);
      expect(counts['alert']).toBe(5);
      expect(counts['ai']).toBe(3);
    });
  });

  describe('DEFAULT_TENANT_MODULES', () => {
    it('should include all 6 modules', () => {
      expect(DEFAULT_TENANT_MODULES).toHaveLength(6);
      expect(DEFAULT_TENANT_MODULES).toContain('sensor');
      expect(DEFAULT_TENANT_MODULES).toContain('farm');
      expect(DEFAULT_TENANT_MODULES).toContain('hr');
      expect(DEFAULT_TENANT_MODULES).toContain('hydroponics');
      expect(DEFAULT_TENANT_MODULES).toContain('alert');
      expect(DEFAULT_TENANT_MODULES).toContain('ai');
    });

    it('should be derived from MODULE_SCHEMAS (no drift)', () => {
      const derived = MODULE_SCHEMAS.map(m => m.moduleName);
      expect(DEFAULT_TENANT_MODULES).toEqual(derived);
    });

    it('order should match MODULE_SCHEMAS order', () => {
      for (let i = 0; i < DEFAULT_TENANT_MODULES.length; i++) {
        expect(DEFAULT_TENANT_MODULES[i]).toBe(MODULE_SCHEMAS[i]!.moduleName);
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
