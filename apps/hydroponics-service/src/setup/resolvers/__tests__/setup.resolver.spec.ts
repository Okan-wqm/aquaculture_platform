/**
 * SetupResolver Unit Tests
 *
 * Covers the security-critical paths AND the full resolver behaviour surface:
 * - @Roles(Role.MODULE_USER) decorator is present on every resolver method
 *   (guards against unauthenticated access) and no @Public() bypass exists.
 * - hydroponicsStatus returns the expected static status response.
 * - Full CRUD lifecycle (create / list / get / update / delete) through an
 *   in-memory repository double that enforces the entity's
 *   UNIQUE(tenantId, configName) constraint.
 * - Cross-tenant isolation, default values, and full-replacement settings
 *   semantics.
 *
 * The CRUD + isolation cases (Tests 2-16 below) were merged in from the former
 * e2e/tests/modules/hydroponics/hydroponics-config.spec.ts so the coverage now
 * lives in the same Nx project as the SetupResolver it exercises (no
 * cross-project relative import / module-boundary violation).
 */

import { NotFoundException } from '@nestjs/common';
import { ROLES_KEY, Role } from '@aquaculture/backend-common/decorators';
import type { CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { DeleteResult, Repository } from 'typeorm';

import { HydroponicsConfig } from '../../entities/hydroponics-config.entity';
import { SetupResolver } from '../setup.resolver';

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
 * The subset of Repository<HydroponicsConfig> the SetupResolver touches, plus
 * the `_store` window the assertions read. Typing the double precisely (rather
 * than casting through `unknown`) keeps the mock honest: a resolver call to a
 * repository method this type omits is a compile error, not a runtime surprise.
 */
type MockConfigRepository = Pick<
  Repository<HydroponicsConfig>,
  'find' | 'findOne' | 'count' | 'create' | 'save' | 'delete'
> & { _store: HydroponicsConfig[] };

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
function createMockRepository(): MockConfigRepository {
  const store: HydroponicsConfig[] = [];

  const repo: MockConfigRepository = {
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
  };

  return repo;
}

/**
 * Build a fake GQL context with tenantId on req.user.
 */
function gqlContext(tenantId: string): { req: { user: { tenantId: string } } } {
  return { req: { user: { tenantId } } };
}

/**
 * Construct a SetupResolver wired to the in-memory repository double through
 * Nest DI — `useValue` is the cast-free way to inject a partial repository
 * (the DI container does not type-check the value against the entity token),
 * so the resolver stays exactly typed while the double stays honest.
 */
async function buildResolver(repo: MockConfigRepository): Promise<SetupResolver> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [SetupResolver, { provide: getRepositoryToken(HydroponicsConfig), useValue: repo }],
  }).compile();
  return moduleRef.get(SetupResolver);
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('SetupResolver', () => {
  let resolver: SetupResolver;
  let repo: MockConfigRepository;

  beforeEach(async () => {
    uuidCounter = 0;
    repo = createMockRepository();
    resolver = await buildResolver(repo);
  });

  describe('hydroponicsStatus query', () => {
    it('returns the expected static status response when no configs exist', async () => {
      const result = await resolver.hydroponicsStatus(gqlContext(TENANT_A));

      expect(result).toEqual({
        configured: false,
        moduleName: 'Hydroponics Management',
      });
    });

    it('returns the correct module name', async () => {
      const result = await resolver.hydroponicsStatus(gqlContext(TENANT_A));

      expect(result.moduleName).toBe('Hydroponics Management');
    });
  });

  // ---------------------------------------------------------------------------
  // CRUD lifecycle + isolation (merged from e2e hydroponics-config.spec.ts)
  // ---------------------------------------------------------------------------

  it('createHydroponicsConfiguration creates a config — status becomes configured: true', async () => {
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

  it('hydroponicsConfigurations lists created configs', async () => {
    await resolver.createHydroponicsConfiguration(
      { configName: 'Config Alpha', settings: { ph: 6.0 } },
      TENANT_A,
    );

    const list = await resolver.listConfigurations(TENANT_A);

    expect(list).toHaveLength(1);
    // toHaveLength(1) above proves index 0 is present; the non-null assertion
    // is permitted in hydroponics-service test files.
    expect(list[0]!.configName).toBe('Config Alpha');
    expect(list[0]!.settings).toEqual({ ph: 6.0 });
  });

  it('hydroponicsConfiguration returns a single config by ID', async () => {
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

  it('updateHydroponicsConfiguration updates configName and leaves settings untouched', async () => {
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

  it('settings update is FULL REPLACEMENT — old keys disappear', async () => {
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

  it('deleteHydroponicsConfiguration removes config and returns true', async () => {
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

  it('deleteHydroponicsConfiguration with non-existent ID returns false (not an error)', async () => {
    const result = await resolver.deleteHydroponicsConfiguration(
      'ffffffff-ffff-4fff-afff-ffffffffffff',
      TENANT_A,
      TENANT_ADMIN_USER,
    );

    expect(result).toBe(false);
  });

  it('duplicate (tenantId, configName) triggers unique constraint violation', async () => {
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

  it('default values — configName="Default", settings={}', async () => {
    const created = await resolver.createHydroponicsConfiguration({}, TENANT_A);

    expect(created.configName).toBe('Default');
    expect(created.settings).toEqual({});
  });

  it('cross-tenant — Tenant A config not visible in Tenant B list', async () => {
    await resolver.createHydroponicsConfiguration(
      { configName: 'Tenant A Only', settings: { secret: 'data' } },
      TENANT_A,
    );

    const tenantBList = await resolver.listConfigurations(TENANT_B);
    expect(tenantBList).toHaveLength(0);
  });

  it('cross-tenant — Tenant B gets NotFoundException for Tenant A config ID', async () => {
    const created = await resolver.createHydroponicsConfiguration(
      { configName: 'Secret Config', settings: { classified: true } },
      TENANT_A,
    );

    await expect(resolver.getConfiguration(created.id, TENANT_B)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('hydroponicsStatus reflects each tenant independently', async () => {
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

  it('same tenant can have multiple configs with different names', async () => {
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

  it('hydroponicsConfigurations(type) filters by configName', async () => {
    await resolver.createHydroponicsConfiguration({ configName: 'Alpha', settings: {} }, TENANT_A);
    await resolver.createHydroponicsConfiguration({ configName: 'Beta', settings: {} }, TENANT_A);
    await resolver.createHydroponicsConfiguration({ configName: 'Alpha', settings: {} }, TENANT_B);

    // Filter Tenant A by type 'Alpha'
    const filtered = await resolver.listConfigurations(TENANT_A, 'Alpha');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.configName).toBe('Alpha');
    expect(filtered[0]!.tenantId).toBe(TENANT_A);

    // Filter Tenant A by type 'Beta'
    const betaFiltered = await resolver.listConfigurations(TENANT_A, 'Beta');
    expect(betaFiltered).toHaveLength(1);
    expect(betaFiltered[0]!.configName).toBe('Beta');

    // Filter Tenant A by non-existent type
    const emptyFiltered = await resolver.listConfigurations(TENANT_A, 'Gamma');
    expect(emptyFiltered).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Authorization metadata — every resolver method requires Role.MODULE_USER
  // and no @Public() bypass exists. (Merged + broadened from the e2e Test 16
  // and the prior 4 single-method authorization-metadata cases.)
  // ---------------------------------------------------------------------------

  describe('authorization metadata', () => {
    const reflector = new Reflector();
    const RESOLVER_METHODS = [
      'hydroponicsStatus',
      'listConfigurations',
      'getConfiguration',
      'createHydroponicsConfiguration',
      'updateHydroponicsConfiguration',
      'deleteHydroponicsConfiguration',
    ] as const;

    it.each(RESOLVER_METHODS)(
      '%s requires Role.MODULE_USER — prevents unauthenticated access',
      (method) => {
        const roles = reflector.get<string[]>(ROLES_KEY, SetupResolver.prototype[method]);
        expect(roles).toBeDefined();
        expect(Array.isArray(roles)).toBe(true);
        expect(roles).toContain(Role.MODULE_USER);
      },
    );

    it('does NOT carry the @Public() decorator on hydroponicsStatus — callers must be authenticated', () => {
      // @Public() sets IS_PUBLIC_KEY metadata. If present, RolesGuard skips auth.
      const IS_PUBLIC_KEY = 'isPublic';
      const flag = Reflect.getMetadata(IS_PUBLIC_KEY, SetupResolver.prototype.hydroponicsStatus);
      expect(flag).toBeUndefined();
    });

    it('does NOT carry the @Public() decorator on the resolver class itself', () => {
      const IS_PUBLIC_KEY = 'isPublic';
      const flag = Reflect.getMetadata(IS_PUBLIC_KEY, SetupResolver);
      expect(flag).toBeUndefined();
    });
  });
});
