import {
  DEFAULT_TENANT_MODULES,
  MODULE_SCHEMAS,
  PLATFORM_LEVEL_MODULES,
  TENANT_SCOPED_MODULES,
} from '../schema-manager.service';

describe('Tenant Isolation Static Analysis', () => {
  describe('MODULE_SCHEMAS completeness', () => {
    it('should have entries for all default tenant modules', () => {
      const moduleNames = MODULE_SCHEMAS.map((m) => m.moduleName);
      expect(moduleNames).toEqual(expect.arrayContaining(DEFAULT_TENANT_MODULES));
    });

    it('every module declares at least one table (per-tenant OR infrastructure)', () => {
      // Registry-completeness entries for raw-SQL/infra-only schemas
      // (compliance, platform, observability — ORPHAN-HIGH-365) legitimately
      // have tables: [] because nothing fans out per-tenant; they still MUST
      // declare their surface via infrastructureTables.
      for (const mod of MODULE_SCHEMAS) {
        expect(mod.tables.length + (mod.infrastructureTables?.length ?? 0)).toBeGreaterThan(0);
      }
    });

    it('no duplicate table names within the tenant-scoped fan-out namespace', () => {
      // Uniqueness matters where names share ONE physical namespace: the
      // tenant_<uuid> schema every tenant-scoped module fans out into. A
      // platform-level schema reusing a name (admin.messages vs the tenant
      // messaging tables, admin.retention_policies vs messaging's) is
      // schema-qualified and legitimate — the old all-modules check
      // false-positived on exactly those.
      const tenantTables = MODULE_SCHEMAS.filter((m) =>
        TENANT_SCOPED_MODULES.has(m.moduleName),
      ).flatMap((m) => m.tables);
      const duplicates = tenantTables.filter((t, i) => tenantTables.indexOf(t) !== i);
      expect(duplicates).toEqual([]);
    });

    it('referenceDataTables should be subset of tables', () => {
      for (const mod of MODULE_SCHEMAS) {
        for (const ref of mod.referenceDataTables ?? []) {
          expect(mod.tables).toContain(ref);
        }
      }
    });

    it('tenant-scoped fan-out table count is pinned (consciousness check)', () => {
      // Pinned to the TENANT-SCOPED total only: that is the per-tenant DDL
      // surface (CREATE TABLE LIKE fan-out) a new table silently expands.
      // Platform-level `tables` lists churn with registry completeness and are
      // not fan-out relevant — the old whole-registry total (170) had drifted
      // far from reality without anyone noticing (quarantined test).
      const tenantTotal = MODULE_SCHEMAS.filter((m) =>
        TENANT_SCOPED_MODULES.has(m.moduleName),
      ).reduce((sum, m) => sum + m.tables.length, 0);
      // 183 → 190: six durable farm feeding/incident tables plus
      // ai_proposed_actions were registered after the previous pin.
      // 190 → 194: the farm environmental SSoT adds satellite scene and
      // versioned coverage-assessment provenance, per-site/provider sync state,
      // and metric-level sync outcomes; weather/marine observations reuse
      // existing tables.
      // 194 → 195: sensor's telemetry_archive_events ledger moved to the
      // per-tenant clone list (ADR-011 tenant_id rule) — erasure drops a
      // tenant's archive history with its schema.
      expect(tenantTotal).toBe(195);
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
      const names = MODULE_SCHEMAS.map((m) => m.moduleName);
      const unique = [...new Set(names)];
      expect(names).toEqual(unique);
    });

    it('should have expected tenant-scoped module table counts', () => {
      const counts: Record<string, number> = {};
      for (const mod of MODULE_SCHEMAS) {
        counts[mod.moduleName] = mod.tables.length;
      }
      // Pinned counts for the tenant-scoped (fan-out) modules — update
      // deliberately when a migration adds/removes a per-tenant table.
      // (Platform-level modules are intentionally not pinned here; their
      // `tables` lists churn with registry completeness, not fan-out.)
      // 46 → 47: telemetry_archive_events joined the per-tenant clone list
      // (ADR-011 tenant_id rule — erasure drops the archive history with
      // the schema).
      expect(counts['sensor']).toBe(47);
      // 85 → 91: feeding_protocols_v2, feeding_protocol_assignments,
      // feeding_day_plans, feeding_meals, feeding_forecast_snapshots and
      // farm_incident_media. 91 → 95: environmental scene, versioned coverage
      // assessment, sync-state, and metric-outcome SSoT.
      expect(counts['farm']).toBe(95);
      expect(counts['hr']).toBe(29);
      expect(counts['hydroponics']).toBe(1);
      expect(counts['alert']).toBe(4);
      // 3 → 4: ai_proposed_actions is now a tenant-scoped durable workflow table.
      expect(counts['ai']).toBe(4);
      expect(counts['messaging']).toBe(15);
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
      const derived = MODULE_SCHEMAS.filter((m) => TENANT_SCOPED_MODULES.has(m.moduleName)).map(
        (m) => m.moduleName,
      );
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
    it('no table should appear in multiple TENANT-SCOPED modules (shared fan-out namespace)', () => {
      // Same scoping rationale as the duplicate check above: only tenant-scoped
      // modules share the tenant_<uuid> physical namespace. Platform-level
      // schemas reusing a name (admin.messages vs messaging's per-tenant
      // messages) are schema-qualified and legitimate.
      const tablesToModules = new Map<string, string[]>();
      for (const mod of MODULE_SCHEMAS) {
        if (!TENANT_SCOPED_MODULES.has(mod.moduleName)) continue;
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
