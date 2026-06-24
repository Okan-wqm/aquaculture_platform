/**
 * Hydroponics Config — E2E Test Suite
 *
 * Covers all CRUD operations, cross-tenant isolation, default values,
 * unique constraints, settings full-replacement semantics, role
 * authorization metadata, and entity-level DB schema correctness.
 *
 * 17 test cases in a single file.
 */
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository, DeleteResult } from 'typeorm';
import { getMetadataArgsStorage } from 'typeorm';

import { HydroponicsConfig } from '../../../../apps/hydroponics-service/src/setup/entities/hydroponics-config.entity';
import { SetupResolver } from '../../../../apps/hydroponics-service/src/setup/resolvers/setup.resolver';
import { CurrentUserPayload } from '../../../../libs/backend-common/src/decorators/current-user.decorator';
import { ROLES_KEY, Role } from '../../../../libs/backend-common/src/decorators/roles.decorator';
import { assertDefined } from '../../../helpers/assertions';

// =============================================================================
// HELPERS
// =============================================================================

/** Deterministic UUID generator for test stability */
let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter++;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-a000-${hex}`;
}

const TENANT_A = '11111111-1111-4111-a111-111111111111';
const TENANT_B = '22222222-2222-4222-a222-222222222222';
const TENANT_ADMIN_USER: CurrentUserPayload = {
  sub: '00000000-0000-4000-a000-000000000001',
  email: 'tenant-admin@test.local',
  tenantId: TENANT_A,
  role: Role.TENANT_ADMIN,
  roles: [Role.TENANT_ADMIN],
};

/**
 * Match a stored row against a TypeORM-style `where` clause by dynamic-key
 * equality. Reflect.get reads the dynamic key while the entity stays strongly
 * typed, so the row needs no type cast.
 */
function rowMatchesWhere(row: HydroponicsConfig, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => Reflect.get(row, key) === value);
}

/**
 * In-memory store that mimics a TypeORM Repository<HydroponicsConfig>.
 *
 * Supports: find, findOne, count, create, save, delete.
 * Enforces the UNIQUE(tenantId, configName) constraint from the entity.
 */
function createMockRepository(): Repository<HydroponicsConfig> & { _store: HydroponicsConfig[] } {
  const store: HydroponicsConfig[] = [];

  const repo = {
    _store: store,

    find: jest
      .fn()
      .mockImplementation(
        (opts?: { where?: Record<string, unknown>; order?: Record<string, string> }) => {
          let results = [...store];
          const where = opts?.where;
          if (where) {
            results = results.filter((row) => rowMatchesWhere(row, where));
          }
          if (opts?.order?.updatedAt === 'DESC') {
            results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          }
          return Promise.resolve(results);
        },
      ),

    findOne: jest.fn().mockImplementation((opts?: { where?: Record<string, unknown> }) => {
      const where = opts?.where;
      if (!where) return Promise.resolve(null);
      const match = store.find((row) => rowMatchesWhere(row, where));
      return Promise.resolve(match ?? null);
    }),

    count: jest.fn().mockImplementation((opts?: { where?: Record<string, unknown> }) => {
      const where = opts?.where;
      if (!where) return Promise.resolve(store.length);
      const matches = store.filter((row) => rowMatchesWhere(row, where));
      return Promise.resolve(matches.length);
    }),

    create: jest.fn().mockImplementation((data: Partial<HydroponicsConfig>): HydroponicsConfig => {
      const entity = new HydroponicsConfig();
      Object.assign(entity, data);
      return entity;
    }),

    save: jest.fn().mockImplementation((entity: HydroponicsConfig): Promise<HydroponicsConfig> => {
      // Enforce UNIQUE(tenantId, configName)
      const duplicate = store.find(
        (row) =>
          row.id !== entity.id &&
          row.tenantId === entity.tenantId &&
          row.configName === entity.configName,
      );
      if (duplicate) {
        const err: Error & { code: string } = Object.assign(
          new Error(`duplicate key value violates unique constraint "UQ_tenantId_configName"`),
          { code: '23505' },
        );
        return Promise.reject(err);
      }

      const now = new Date();
      if (!entity.id) {
        entity.id = nextUuid();
        entity.createdAt = now;
      }
      entity.updatedAt = now;

      const idx = store.findIndex((row) => row.id === entity.id);
      if (idx >= 0) {
        store[idx] = entity;
      } else {
        store.push(entity);
      }
      return Promise.resolve(entity);
    }),

    delete: jest
      .fn()
      .mockImplementation((criteria: { id: string; tenantId: string }): Promise<DeleteResult> => {
        const idx = store.findIndex(
          (row) => row.id === criteria.id && row.tenantId === criteria.tenantId,
        );
        if (idx >= 0) {
          store.splice(idx, 1);
          return Promise.resolve({ affected: 1, raw: [] });
        }
        return Promise.resolve({ affected: 0, raw: [] });
      }),
  } as unknown as Repository<HydroponicsConfig> & { _store: HydroponicsConfig[] };

  return repo;
}

/**
 * Build a fake GQL context with tenantId on req.user.
 */
function gqlContext(tenantId: string): { req: { user: { tenantId: string } } } {
  return { req: { user: { tenantId } } };
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('HydroponicsConfig E2E', () => {
  let resolver: SetupResolver;
  let repo: Repository<HydroponicsConfig> & { _store: HydroponicsConfig[] };

  beforeEach(() => {
    uuidCounter = 0;
    repo = createMockRepository();
    resolver = new SetupResolver(repo);
  });

  // ---------------------------------------------------------------------------
  // Test 1: hydroponicsStatus returns configured: false when no configs exist
  // ---------------------------------------------------------------------------
  it('Test 1: hydroponicsStatus returns configured: false when no configs exist', async () => {
    const status = await resolver.hydroponicsStatus(gqlContext(TENANT_A));

    expect(status.configured).toBe(false);
    expect(status.moduleName).toBe('Hydroponics Management');
  });

  // ---------------------------------------------------------------------------
  // Test 2: createHydroponicsConfiguration creates a config and status becomes configured: true
  // ---------------------------------------------------------------------------
  it('Test 2: createHydroponicsConfiguration creates config — status becomes configured: true', async () => {
    const created = await resolver.createHydroponicsConfiguration(
      { configName: 'NFT System', settings: { flowRate: 2.5, channels: 4 } },
      TENANT_A,
    );

    expect(created.id).toBeDefined();
    expect(created.tenantId).toBe(TENANT_A);
    expect(created.configName).toBe('NFT System');
    expect(created.settings).toEqual({ flowRate: 2.5, channels: 4 });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    // Status should now be configured
    const status = await resolver.hydroponicsStatus(gqlContext(TENANT_A));
    expect(status.configured).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 3: hydroponicsConfigurations returns all tenant configs
  // ---------------------------------------------------------------------------
  it('Test 3: hydroponicsConfigurations lists created configs', async () => {
    await resolver.createHydroponicsConfiguration(
      { configName: 'Config Alpha', settings: { ph: 6.0 } },
      TENANT_A,
    );

    const list = await resolver.listConfigurations(TENANT_A);

    expect(list).toHaveLength(1);
    expect(list[0].configName).toBe('Config Alpha');
    expect(list[0].settings).toEqual({ ph: 6.0 });
  });

  // ---------------------------------------------------------------------------
  // Test 4: hydroponicsConfiguration returns detail by ID
  // ---------------------------------------------------------------------------
  it('Test 4: hydroponicsConfiguration returns a single config by ID', async () => {
    const created = await resolver.createHydroponicsConfiguration(
      { configName: 'DWC Setup', settings: { bucketSize: 20, airStones: 2 } },
      TENANT_A,
    );

    const detail = await resolver.getConfiguration(created.id, TENANT_A);

    expect(detail.id).toBe(created.id);
    expect(detail.configName).toBe('DWC Setup');
    expect(detail.settings).toEqual({ bucketSize: 20, airStones: 2 });
    expect(detail.tenantId).toBe(TENANT_A);
  });

  // ---------------------------------------------------------------------------
  // Test 5: updateHydroponicsConfiguration updates configName
  // ---------------------------------------------------------------------------
  it('Test 5: updateHydroponicsConfiguration updates configName', async () => {
    const created = await resolver.createHydroponicsConfiguration(
      { configName: 'Old Name', settings: { x: 1 } },
      TENANT_A,
    );

    const updated = await resolver.updateHydroponicsConfiguration(
      { id: created.id, configName: 'New Name' },
      TENANT_A,
    );

    expect(updated.configName).toBe('New Name');
    // settings should remain unchanged
    expect(updated.settings).toEqual({ x: 1 });
  });

  // ---------------------------------------------------------------------------
  // Test 6: updateHydroponicsConfiguration replaces settings FULLY (no merge)
  // ---------------------------------------------------------------------------
  it('Test 6: settings update is FULL REPLACEMENT — old keys disappear', async () => {
    const created = await resolver.createHydroponicsConfiguration(
      {
        configName: 'Merge Test',
        settings: {
          oldKey: 'should-vanish',
          sharedKey: 'original',
          nested: { deep: true },
        },
      },
      TENANT_A,
    );

    const newSettings = { sharedKey: 'replaced', brandNew: 42 };

    const updated = await resolver.updateHydroponicsConfiguration(
      { id: created.id, settings: newSettings },
      TENANT_A,
    );

    // CRITICAL: Full replacement semantics
    expect(updated.settings).toEqual({ sharedKey: 'replaced', brandNew: 42 });
    expect(updated.settings['oldKey']).toBeUndefined();
    expect(updated.settings['nested']).toBeUndefined();

    // Verify through a fresh read
    const reloaded = await resolver.getConfiguration(created.id, TENANT_A);
    expect(reloaded.settings).toEqual({ sharedKey: 'replaced', brandNew: 42 });
    expect(reloaded.settings['oldKey']).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 7: deleteHydroponicsConfiguration removes config and returns true
  // ---------------------------------------------------------------------------
  it('Test 7: deleteHydroponicsConfiguration removes config and returns true', async () => {
    const created = await resolver.createHydroponicsConfiguration(
      { configName: 'To Delete', settings: {} },
      TENANT_A,
    );

    const result = await resolver.deleteHydroponicsConfiguration(
      created.id,
      TENANT_A,
      TENANT_ADMIN_USER,
    );
    expect(result).toBe(true);

    // Verify list is empty
    const list = await resolver.listConfigurations(TENANT_A);
    expect(list).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 8: deleteHydroponicsConfiguration with non-existent ID returns false
  // ---------------------------------------------------------------------------
  it('Test 8: deleteHydroponicsConfiguration with non-existent ID returns false (not an error)', async () => {
    const result = await resolver.deleteHydroponicsConfiguration(
      'ffffffff-ffff-4fff-afff-ffffffffffff',
      TENANT_A,
      TENANT_ADMIN_USER,
    );

    expect(result).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Unique constraint: duplicate (tenantId, configName) throws DB error
  // ---------------------------------------------------------------------------
  it('Test 9: duplicate (tenantId, configName) triggers unique constraint violation', async () => {
    await resolver.createHydroponicsConfiguration(
      { configName: 'Unique Test', settings: {} },
      TENANT_A,
    );

    await expect(
      resolver.createHydroponicsConfiguration(
        { configName: 'Unique Test', settings: { different: true } },
        TENANT_A,
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  // ---------------------------------------------------------------------------
  // Test 10: Default values — configName defaults to 'Default', settings defaults to {}
  // ---------------------------------------------------------------------------
  it('Test 10: default values — configName="Default", settings={}', async () => {
    const created = await resolver.createHydroponicsConfiguration({}, TENANT_A);

    expect(created.configName).toBe('Default');
    expect(created.settings).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Test 11: Cross-tenant isolation — Tenant A config not visible to Tenant B
  // ---------------------------------------------------------------------------
  it('Test 11: cross-tenant — Tenant A config not visible in Tenant B list', async () => {
    await resolver.createHydroponicsConfiguration(
      { configName: 'Tenant A Only', settings: { secret: 'data' } },
      TENANT_A,
    );

    const tenantBList = await resolver.listConfigurations(TENANT_B);
    expect(tenantBList).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 12: Cross-tenant — Tenant B cannot access Tenant A config by ID
  // ---------------------------------------------------------------------------
  it('Test 12: cross-tenant — Tenant B gets NotFoundException for Tenant A config ID', async () => {
    const created = await resolver.createHydroponicsConfiguration(
      { configName: 'Secret Config', settings: { classified: true } },
      TENANT_A,
    );

    await expect(resolver.getConfiguration(created.id, TENANT_B)).rejects.toThrow(
      NotFoundException,
    );
  });

  // ---------------------------------------------------------------------------
  // Test 13: hydroponicsStatus is tenant-scoped — each tenant sees own status
  // ---------------------------------------------------------------------------
  it('Test 13: hydroponicsStatus reflects each tenant independently', async () => {
    // Tenant A has a config
    await resolver.createHydroponicsConfiguration(
      { configName: 'A Config', settings: {} },
      TENANT_A,
    );

    const statusA = await resolver.hydroponicsStatus(gqlContext(TENANT_A));
    const statusB = await resolver.hydroponicsStatus(gqlContext(TENANT_B));

    expect(statusA.configured).toBe(true);
    expect(statusB.configured).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Test 14: Multi-config — same tenant, different configNames
  // ---------------------------------------------------------------------------
  it('Test 14: same tenant can have multiple configs with different names', async () => {
    await resolver.createHydroponicsConfiguration(
      { configName: 'NFT', settings: { type: 'nft' } },
      TENANT_A,
    );
    await resolver.createHydroponicsConfiguration(
      { configName: 'DWC', settings: { type: 'dwc' } },
      TENANT_A,
    );
    await resolver.createHydroponicsConfiguration(
      { configName: 'Ebb & Flow', settings: { type: 'ebbflow' } },
      TENANT_A,
    );

    const list = await resolver.listConfigurations(TENANT_A);
    expect(list).toHaveLength(3);

    const names = list.map((c) => c.configName).sort();
    expect(names).toEqual(['DWC', 'Ebb & Flow', 'NFT']);
  });

  // ---------------------------------------------------------------------------
  // Test 15: Filter by type: hydroponicsConfigurations(type: 'X') filters on configName
  // ---------------------------------------------------------------------------
  it('Test 15: hydroponicsConfigurations(type) filters by configName', async () => {
    await resolver.createHydroponicsConfiguration({ configName: 'Alpha', settings: {} }, TENANT_A);
    await resolver.createHydroponicsConfiguration({ configName: 'Beta', settings: {} }, TENANT_A);
    await resolver.createHydroponicsConfiguration({ configName: 'Alpha', settings: {} }, TENANT_B);

    // Filter Tenant A by type 'Alpha'
    const filtered = await resolver.listConfigurations(TENANT_A, 'Alpha');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].configName).toBe('Alpha');
    expect(filtered[0].tenantId).toBe(TENANT_A);

    // Filter Tenant A by type 'Beta'
    const betaFiltered = await resolver.listConfigurations(TENANT_A, 'Beta');
    expect(betaFiltered).toHaveLength(1);
    expect(betaFiltered[0].configName).toBe('Beta');

    // Filter Tenant A by non-existent type
    const emptyFiltered = await resolver.listConfigurations(TENANT_A, 'Gamma');
    expect(emptyFiltered).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 16: MODULE_USER role is the minimum required role for all operations
  // ---------------------------------------------------------------------------
  it('Test 16: all resolver methods require Role.MODULE_USER', () => {
    const reflector = new Reflector();

    // hydroponicsStatus
    const statusRoles = reflector.get<string[]>(
      ROLES_KEY,
      SetupResolver.prototype.hydroponicsStatus,
    );
    expect(statusRoles).toBeDefined();
    expect(statusRoles).toContain(Role.MODULE_USER);

    // listConfigurations
    const listRoles = reflector.get<string[]>(
      ROLES_KEY,
      SetupResolver.prototype.listConfigurations,
    );
    expect(listRoles).toBeDefined();
    expect(listRoles).toContain(Role.MODULE_USER);

    // getConfiguration
    const getRoles = reflector.get<string[]>(ROLES_KEY, SetupResolver.prototype.getConfiguration);
    expect(getRoles).toBeDefined();
    expect(getRoles).toContain(Role.MODULE_USER);

    // createHydroponicsConfiguration
    const createRoles = reflector.get<string[]>(
      ROLES_KEY,
      SetupResolver.prototype.createHydroponicsConfiguration,
    );
    expect(createRoles).toBeDefined();
    expect(createRoles).toContain(Role.MODULE_USER);

    // updateHydroponicsConfiguration
    const updateRoles = reflector.get<string[]>(
      ROLES_KEY,
      SetupResolver.prototype.updateHydroponicsConfiguration,
    );
    expect(updateRoles).toBeDefined();
    expect(updateRoles).toContain(Role.MODULE_USER);

    // deleteHydroponicsConfiguration
    const deleteRoles = reflector.get<string[]>(
      ROLES_KEY,
      SetupResolver.prototype.deleteHydroponicsConfiguration,
    );
    expect(deleteRoles).toBeDefined();
    expect(deleteRoles).toContain(Role.MODULE_USER);
  });

  // ---------------------------------------------------------------------------
  // Test 17: DB schema validation — entity metadata matches expected table structure
  // ---------------------------------------------------------------------------
  it('Test 17: entity metadata defines hydroponics_config table with correct columns', () => {
    const storage = getMetadataArgsStorage();

    // Table name
    const tables = storage.tables.filter((t) => t.target === HydroponicsConfig);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('hydroponics_config');
    // No hardcoded schema — tenant routing via search_path
    expect(tables[0].schema).toBeUndefined();

    // Columns
    const columns = storage.columns.filter((c) => c.target === HydroponicsConfig);
    const colMap = new Map(columns.map((c) => [c.propertyName, c]));

    // id — UUID primary key
    expect(colMap.has('id')).toBe(true);

    // tenantId -> tenant_id
    const tenantCol = colMap.get('tenantId');
    expect(tenantCol).toBeDefined();
    expect((assertDefined(tenantCol).options as Record<string, unknown>).name).toBe('tenant_id');
    expect((assertDefined(tenantCol).options as Record<string, unknown>).type).toBe('uuid');

    // configName -> config_name
    const configNameCol = colMap.get('configName');
    expect(configNameCol).toBeDefined();
    expect((assertDefined(configNameCol).options as Record<string, unknown>).name).toBe(
      'config_name',
    );
    expect((assertDefined(configNameCol).options as Record<string, unknown>).length).toBe(255);
    expect((assertDefined(configNameCol).options as Record<string, unknown>).default).toBe(
      'Default',
    );

    // settings — jsonb, default '{}'
    const settingsCol = colMap.get('settings');
    expect(settingsCol).toBeDefined();
    expect((assertDefined(settingsCol).options as Record<string, unknown>).type).toBe('jsonb');
    expect((assertDefined(settingsCol).options as Record<string, unknown>).default).toBe('{}');

    // createdAt -> created_at
    const createdCol = colMap.get('createdAt');
    expect(createdCol).toBeDefined();
    expect((assertDefined(createdCol).options as Record<string, unknown>).name).toBe('created_at');

    // updatedAt -> updated_at
    const updatedCol = colMap.get('updatedAt');
    expect(updatedCol).toBeDefined();
    expect((assertDefined(updatedCol).options as Record<string, unknown>).name).toBe('updated_at');

    // Unique constraint on (tenantId, configName)
    const uniques = storage.uniques.filter((u) => u.target === HydroponicsConfig);
    expect(uniques.length).toBeGreaterThanOrEqual(1);
    const uniqueColumns = uniques[0].columns;
    expect(uniqueColumns).toContain('tenantId');
    expect(uniqueColumns).toContain('configName');

    // Index on tenantId
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
