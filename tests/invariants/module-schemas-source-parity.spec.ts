import { resolve } from 'node:path';

import { MODULE_SCHEMAS } from '../../libs/backend-common/src/database/schema-manager.service';
import { readModuleSchemasSource } from '../../tools/aria-adapters/module-schemas-source';

/**
 * ARIA-MEDIUM-588 — the adapter-side MODULE_SCHEMAS reader must yield the SAME
 * registry as the runtime value the gates import.
 *
 * `MODULE_SCHEMAS` (libs/backend-common/src/database/schema-manager.service.ts)
 * is the single source of truth for which tables of a module are per-tenant,
 * reference data, or cross-tenant infrastructure. The runtime value spreads an
 * imported constant into every module's `infrastructureTables`
 * (`...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES`, whose single element
 * `TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE` is imported from `@platform/outbox`
 * through the tsconfig path map). The adapters read the SAME declaration as
 * source text (they must observe the workspace under analysis, fixtures
 * included, so they cannot execute it), and their reader dropped every spread
 * element — silently: `tenant_erasure_target_proofs` vanished from the
 * adapter-side registry while the runtime kept classifying it as cross-tenant
 * infrastructure. Every consumer of the adapter-side reading (the entity-schema
 * ownership policy, the module_schema declared-table diff, and the tenant-aware
 * qualified-DDL guard's adapter projection) then disagreed with the runtime
 * verdicts without anyone noticing.
 *
 * This spec pins the parity at both real entry points: the reader
 * (`tools/aria-adapters/module-schemas-source.ts`) field by field against the
 * runtime `MODULE_SCHEMAS`, and the typeorm adapter's own module_schema
 * observation over this repository. A reader that cannot resolve an element
 * must name it as a parse error, never drop it.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

const runtimeByModule = new Map(MODULE_SCHEMAS.map((entry) => [entry.moduleName, entry]));

describe('the adapter-side MODULE_SCHEMAS reading equals the runtime registry', () => {
  it('resolves every element of every module with no named errors', () => {
    const source = readModuleSchemasSource(REPO_ROOT);
    expect(source.errors).toEqual([]);
    expect(source.modules.map((module) => module.moduleName)).toEqual([...runtimeByModule.keys()]);
    // The registry came from exactly these files. If the SSoT's import chain
    // ever changes, this list changes with it — and the adapter manifests'
    // allowed_read_globs must be widened in the same change or the read is out
    // of policy.
    expect(source.readPaths).toEqual([
      'libs/backend-common/src/database/schema-manager.service.ts',
      'platform/libs/outbox/src/index.ts',
      'platform/libs/outbox/src/outbox-migration.ts',
      'tsconfig.base.json',
    ]);
  });

  it('matches the runtime registry field by field for every module', () => {
    const source = readModuleSchemasSource(REPO_ROOT);
    expect(source.modules.length).toBe(MODULE_SCHEMAS.length);
    for (const module of source.modules) {
      const runtime = runtimeByModule.get(module.moduleName);
      expect(runtime).toBeDefined();
      const expected = {
        moduleName: runtime!.moduleName,
        sourceSchema: runtime!.sourceSchema,
        strictOwnership: runtime!.strictOwnership === true,
        tables: runtime!.tables,
        referenceDataTables: runtime!.referenceDataTables ?? [],
        infrastructureTables: runtime!.infrastructureTables ?? [],
      };
      const actual = {
        moduleName: module.moduleName,
        sourceSchema: module.sourceSchema,
        strictOwnership: module.strictOwnership,
        tables: module.tables,
        referenceDataTables: module.referenceDataTables,
        infrastructureTables: module.infrastructureTables,
      };
      // A set comparison, not a list comparison: the runtime and the reader
      // both preserve declaration order today, but the CONTRACT is the set of
      // tables each side declares — ordering is not part of the registry.
      expect({ ...actual, tables: [...actual.tables].sort() }).toEqual({
        ...expected,
        tables: [...expected.tables].sort(),
      });
      expect([...actual.referenceDataTables].sort()).toEqual(
        [...expected.referenceDataTables].sort(),
      );
      expect([...actual.infrastructureTables].sort()).toEqual(
        [...expected.infrastructureTables].sort(),
      );
    }
  });

  it('carries the spread-resolved tenant_erasure_target_proofs in every module that declares the spread', () => {
    const source = readModuleSchemasSource(REPO_ROOT);
    for (const module of source.modules) {
      const runtime = runtimeByModule.get(module.moduleName);
      const runtimeCarries = (runtime!.infrastructureTables ?? []).includes(
        'tenant_erasure_target_proofs',
      );
      expect({
        module: module.moduleName,
        carries: module.infrastructureTables.includes('tenant_erasure_target_proofs'),
      }).toEqual({ module: module.moduleName, carries: runtimeCarries });
    }
  });

  it("the typeorm adapter's sensor observation counts every infrastructure table the runtime declares", async () => {
    const { analyzeTypeOrmEntities } = await import(
      '../../tools/aria-adapters/typeorm-entity-schema-adapter'
    );
    const runtime = runtimeByModule.get('sensor');
    expect(runtime).toBeDefined();
    const runtimeInfrastructure = (runtime!.infrastructureTables ?? []).length;

    const output = analyzeTypeOrmEntities(
      { root: 'apps/sensor-service/src', serviceName: 'sensor', checks: ['module_schema'] },
      REPO_ROOT,
    );
    const observation = output.observations.find((item) => item.id === 'module-schema:sensor');
    expect(observation).toBeDefined();
    expect(observation?.details?.infrastructureTables).toBe(runtimeInfrastructure);
    expect(observation?.details?.tables).toBe(runtime!.tables.length);
    expect(observation?.details?.referenceDataTables).toBe(
      runtime!.referenceDataTables?.length ?? 0,
    );
    expect(observation?.details?.strictOwnership).toBe(runtime!.strictOwnership === true);
    // The reading touched exactly the files the registry came from: the SSoT,
    // the tsconfig path map and the resolved outbox modules.
    for (const path of readModuleSchemasSource(REPO_ROOT).readPaths) {
      expect(output.read_paths).toContain(path);
    }
  });
});
