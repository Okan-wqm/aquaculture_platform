import { DataSource, Repository, EntityTarget, SelectQueryBuilder } from 'typeorm';

import { requestContextStorage, RequestContext } from '../../logging/request-context';
import { TenantEntity } from '../tenant-aware.repository';
import { TenantScopedRepository, tenantManagerRepo } from '../tenant-scoped-repository';

interface TestEntity extends TenantEntity {
  id: string;
  tenantId: string;
  name: string;
  sensorId?: string;
  status?: string;
  ownerId?: string;
}

describe('TenantScopedRepository', () => {
  let repo: TenantScopedRepository<TestEntity>;
  let mockRepository: jest.Mocked<Repository<TestEntity>>;
  let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<TestEntity>>;
  let mockDataSource: jest.Mocked<DataSource>;

  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    mockQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      getMany: jest.fn(),
      getCount: jest.fn(),
    } as unknown as jest.Mocked<SelectQueryBuilder<TestEntity>>;

    mockRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn().mockImplementation((entity: TestEntity) => Promise.resolve(entity)),
      create: jest.fn().mockImplementation((entity: TestEntity) => entity),
      update: jest.fn().mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
      delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
      softDelete: jest.fn().mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
      metadata: {
        findColumnWithPropertyName: jest.fn().mockReturnValue({ databaseName: 'tenant_id' }),
      },
    } as unknown as jest.Mocked<Repository<TestEntity>>;

    mockDataSource = {
      getRepository: jest.fn().mockReturnValue(mockRepository),
    } as unknown as jest.Mocked<DataSource>;
  });

  // ── Factory tests ──

  describe('static create()', () => {
    it('should create repository with explicit tenantId', () => {
      const result = TenantScopedRepository.create(
        mockDataSource,
        {} as EntityTarget<TestEntity>,
        tenantId,
      );
      expect(result).toBeInstanceOf(TenantScopedRepository);
      expect(result.getTenantId()).toBe(tenantId);
    });

    it('should create repository without explicit tenantId (uses AsyncLocalStorage)', () => {
      const result = TenantScopedRepository.create(mockDataSource, {} as EntityTarget<TestEntity>);
      expect(result).toBeInstanceOf(TenantScopedRepository);
    });
  });

  describe('static fromRepository()', () => {
    it('should wrap an existing TypeORM Repository', () => {
      const result = TenantScopedRepository.fromRepository(mockRepository, tenantId);
      expect(result).toBeInstanceOf(TenantScopedRepository);
      expect(result.getTenantId()).toBe(tenantId);
    });
  });

  // ── Tenant resolution tests ──

  describe('tenant ID resolution', () => {
    it('should use explicit tenantId when provided', () => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
      expect(repo.getTenantId()).toBe(tenantId);
    });

    it('should fall back to AsyncLocalStorage when no explicit tenantId', async () => {
      repo = TenantScopedRepository.fromRepository(mockRepository);

      const context: RequestContext = { tenantId };

      await requestContextStorage.run(context, () => {
        expect(repo.getTenantId()).toBe(tenantId);
        return Promise.resolve();
      });
    });

    it('should throw when no tenant context is available', () => {
      repo = TenantScopedRepository.fromRepository(mockRepository);
      expect(() => repo.getTenantId()).toThrow('No tenant context available');
    });

    it('should prefer explicit tenantId over AsyncLocalStorage', async () => {
      const explicitTenant = '660e8400-e29b-41d4-a716-446655440000';
      repo = TenantScopedRepository.fromRepository(mockRepository, explicitTenant);

      const context: RequestContext = { tenantId };

      await requestContextStorage.run(context, () => {
        expect(repo.getTenantId()).toBe(explicitTenant);
        return Promise.resolve();
      });
    });
  });

  // ── Read operations ──

  describe('find()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into where clause', async () => {
      await repo.find({ where: { name: 'test' } });
      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { tenantId, name: 'test' },
      });
    });

    it('should add tenantId when called without options', async () => {
      await repo.find();
      expect(mockRepository.find).toHaveBeenCalledWith({ where: { tenantId } });
    });

    it('should inject tenantId into every OR where branch', async () => {
      await repo.find({
        where: [{ status: 'active' }, { ownerId: 'user-1' }],
      });

      expect(mockRepository.find).toHaveBeenCalledWith({
        where: [
          { tenantId, status: 'active' },
          { tenantId, ownerId: 'user-1' },
        ],
      });
    });

    it('should preserve additional options (order, take, skip)', async () => {
      await repo.find({ where: { name: 'x' }, take: 10, skip: 5, order: { name: 'ASC' } });
      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { tenantId, name: 'x' },
        take: 10,
        skip: 5,
        order: { name: 'ASC' },
      });
    });
  });

  describe('findOne()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into where clause', async () => {
      await repo.findOne({ where: { id: 'abc' } });
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { tenantId, id: 'abc' },
      });
    });
  });

  describe('findOneOrFail()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should return entity when found', async () => {
      const entity = { id: '1', tenantId, name: 'test' };
      mockRepository.findOne.mockResolvedValue(entity);
      const result = await repo.findOneOrFail({ where: { id: '1' } });
      expect(result).toEqual(entity);
    });

    it('should throw when entity not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      await expect(repo.findOneOrFail({ where: { id: 'missing' } })).rejects.toThrow(
        'Entity not found within tenant scope',
      );
    });
  });

  describe('findById()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should query by id and tenantId', async () => {
      await repo.findById('entity-1');
      expect(mockRepository.createQueryBuilder).toHaveBeenCalledWith('entity');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('entity.id = :id', { id: 'entity-1' });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('entity."tenantId" = :tenantId', {
        tenantId,
      });
      expect(mockQueryBuilder.getOne).toHaveBeenCalled();
    });
  });

  describe('count()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId', async () => {
      mockRepository.count.mockResolvedValue(42);
      const result = await repo.count();
      expect(result).toBe(42);
      expect(mockRepository.count).toHaveBeenCalledWith({ where: { tenantId } });
    });

    it('should merge custom where with tenantId', async () => {
      await repo.count({ where: { name: 'active' } });
      expect(mockRepository.count).toHaveBeenCalledWith({
        where: { tenantId, name: 'active' },
      });
    });
  });

  describe('exists()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should return true when entity found', async () => {
      mockQueryBuilder.getOne.mockResolvedValue({ id: '1', tenantId, name: 'test' });
      const result = await repo.exists('1');
      expect(result).toBe(true);
    });

    it('should return false when entity not found', async () => {
      mockQueryBuilder.getOne.mockResolvedValue(null);
      const result = await repo.exists('missing');
      expect(result).toBe(false);
    });
  });

  // ── Write operations ──

  describe('save()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should set tenantId on entity before saving', async () => {
      await repo.save({ name: 'new-sensor' });
      expect(mockRepository.create).toHaveBeenCalledWith({ name: 'new-sensor', tenantId });
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it('should overwrite foreign tenantId', async () => {
      const foreignTenant = '770e8400-e29b-41d4-a716-446655440000';
      await repo.save({ name: 'hijacked', tenantId: foreignTenant });
      expect(mockRepository.create).toHaveBeenCalledWith({ name: 'hijacked', tenantId });
    });
  });

  describe('saveMany()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should set tenantId on all entities', async () => {
      await repo.saveMany([{ name: 'sensor-1' }, { name: 'sensor-2' }]);
      expect(mockRepository.create).toHaveBeenCalledWith([
        { name: 'sensor-1', tenantId },
        { name: 'sensor-2', tenantId },
      ]);
    });
  });

  // ── CRITICAL: delete() tenant scoping (SENSOR-CRITICAL-002 root cause fix) ──

  describe('delete()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into delete criteria', async () => {
      await repo.delete({ sensorId: 'sensor-1' });
      expect(mockRepository.delete).toHaveBeenCalledWith({ sensorId: 'sensor-1', tenantId });
    });

    it('should add tenantId even with empty criteria', async () => {
      await repo.delete({});
      expect(mockRepository.delete).toHaveBeenCalledWith({ tenantId });
    });

    it('should throw when no tenant context (prevents unscoped delete)', async () => {
      const unscopedRepo = TenantScopedRepository.fromRepository(mockRepository);
      await expect(unscopedRepo.delete({ sensorId: 'x' })).rejects.toThrow(
        'No tenant context available',
      );
    });
  });

  describe('update()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into update criteria', async () => {
      await repo.update({ sensorId: 'sensor-1' }, { name: 'updated' });
      expect(mockRepository.update).toHaveBeenCalledWith(
        { sensorId: 'sensor-1', tenantId },
        { name: 'updated' },
      );
    });

    it('should strip tenantId from the update payload (prevent reassignment)', async () => {
      const foreignTenant = '770e8400-e29b-41d4-a716-446655440000';
      await repo.update({ id: '1' }, { name: 'updated', tenantId: foreignTenant });
      expect(mockRepository.update).toHaveBeenCalledWith(
        { id: '1', tenantId },
        { name: 'updated' },
      );
    });
  });

  describe('softDelete()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into soft delete criteria', async () => {
      await repo.softDelete({ sensorId: 'sensor-1' });
      expect(mockRepository.softDelete).toHaveBeenCalledWith({ sensorId: 'sensor-1', tenantId });
    });
  });

  // ── Query builder ──

  describe('createQueryBuilder()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should create query builder with tenant WHERE clause', () => {
      const where = mockQueryBuilder.where;
      repo.createQueryBuilder('channel');
      expect(mockRepository.createQueryBuilder).toHaveBeenCalledWith('channel');
      expect(where).toHaveBeenCalledWith('channel."tenant_id" = :tenantId', { tenantId });
    });

    it('should use default alias "entity" when none provided', () => {
      const where = mockQueryBuilder.where;
      repo.createQueryBuilder();
      expect(mockRepository.createQueryBuilder).toHaveBeenCalledWith('entity');
      expect(where).toHaveBeenCalledWith('entity."tenant_id" = :tenantId', { tenantId });
    });

    it('should reject predicate resetters after tenant scope is installed', () => {
      const queryBuilder = repo.createQueryBuilder('channel');
      const where = Reflect.get(queryBuilder, 'where') as () => never;
      const orWhere = Reflect.get(queryBuilder, 'orWhere') as () => never;

      expect(where).toThrow('TenantScopedRepository query builders are already tenant-scoped');
      expect(orWhere).toThrow('TenantScopedRepository query builders are already tenant-scoped');
    });
  });

  // ── AsyncLocalStorage integration (simulates HTTP and MQTT paths) ──

  describe('AsyncLocalStorage integration', () => {
    let asyncRepo: TenantScopedRepository<TestEntity>;

    beforeEach(() => {
      asyncRepo = TenantScopedRepository.fromRepository(mockRepository);
    });

    it('should resolve tenantId from HTTP request context', async () => {
      const context: RequestContext = { tenantId, method: 'GET', url: '/api/sensors' };

      await requestContextStorage.run(context, async () => {
        await asyncRepo.find();
        expect(mockRepository.find).toHaveBeenCalledWith({ where: { tenantId } });
      });
    });

    it('should resolve tenantId from withTenantContext (MQTT/cron simulation)', async () => {
      const mqttTenantId = '880e8400-e29b-41d4-a716-446655440000';
      const context: RequestContext = {
        tenantId: mqttTenantId,
        schemaName: 'tenant_880e8400e29b41d4',
      };

      await requestContextStorage.run(context, async () => {
        await asyncRepo.delete({ sensorId: 'mqtt-sensor' });
        expect(mockRepository.delete).toHaveBeenCalledWith({
          sensorId: 'mqtt-sensor',
          tenantId: mqttTenantId,
        });
      });
    });

    it('should fail gracefully outside any context', async () => {
      await expect(asyncRepo.find()).rejects.toThrow('No tenant context available');
    });
  });
});

// ============================================================================
// tenantManagerRepo() — the canonical helper used by Phase B migrations.
// ============================================================================
//
// tenantManagerRepo(manager, entity, explicitTenantId?) is the factory every
// transaction-scoped handler uses post-AUDIT-HIGH-002/003/008 / MEDIUM-007.
// It wraps `manager.getRepository(entity)` into a TenantScopedRepository so
// the tenant-id auto-injection discipline carries into the transaction path.
//
// These tests cover the ARCHITECTURAL contract the helper is expected to
// provide for Phase B consumers (SEC-REVIEW-007 unit-level complement):
//
//   1. Returns a TenantScopedRepository bound to the right entity.
//   2. Explicit tenantId wins over AsyncLocalStorage context.
//   3. Falls back to AsyncLocalStorage when no explicit tenantId.
//   4. Throws when neither explicit nor context-provided tenantId is
//      available — NO silent tenant-less repo inside a transaction.
//   5. find / findOne / update / delete all carry tenantId in the WHERE
//      (inherited from the TenantScopedRepository contract, verified here
//      through the factory to prove the wiring is intact).

interface MockManager {
  getRepository: jest.Mock;
}

describe('tenantManagerRepo() — factory contract', () => {
  let mockInnerRepo: jest.Mocked<Repository<TestEntity>>;
  let mockQB: jest.Mocked<SelectQueryBuilder<TestEntity>>;
  let mockManager: MockManager;

  const explicitTenantId = '550e8400-e29b-41d4-a716-446655440001';
  const contextTenantId = '550e8400-e29b-41d4-a716-446655440002';

  beforeEach(() => {
    mockQB = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      getMany: jest.fn(),
    } as unknown as jest.Mocked<SelectQueryBuilder<TestEntity>>;

    mockInnerRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((entity: TestEntity) => Promise.resolve(entity)),
      create: jest.fn().mockImplementation((entity: TestEntity) => entity),
      update: jest.fn().mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
      delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
      createQueryBuilder: jest.fn().mockReturnValue(mockQB),
    } as unknown as jest.Mocked<Repository<TestEntity>>;

    mockManager = {
      getRepository: jest.fn().mockReturnValue(mockInnerRepo),
    };
  });

  const callFactory = (tid?: string): TenantScopedRepository<TestEntity> =>
    tenantManagerRepo(
      mockManager as unknown as Parameters<typeof tenantManagerRepo>[0],
      {} as EntityTarget<TestEntity>,
      tid,
    );

  it('returns a TenantScopedRepository instance', () => {
    const repo = callFactory(explicitTenantId);
    expect(repo).toBeInstanceOf(TenantScopedRepository);
  });

  it('calls manager.getRepository(entity) exactly once per invocation', () => {
    callFactory(explicitTenantId);
    expect(mockManager.getRepository).toHaveBeenCalledTimes(1);
  });

  it('explicit tenantId wins over AsyncLocalStorage context', async () => {
    const context: RequestContext = {
      tenantId: contextTenantId,
      userId: 'user-1',
      correlationId: 'req-1',
    };
    await requestContextStorage.run(context, async () => {
      const repo = callFactory(explicitTenantId);
      await repo.find();
      expect(mockInnerRepo.find).toHaveBeenCalledWith({
        where: { tenantId: explicitTenantId },
      });
    });
  });

  it('falls back to AsyncLocalStorage when no explicit tenantId', async () => {
    const context: RequestContext = {
      tenantId: contextTenantId,
      userId: 'user-1',
      correlationId: 'req-1',
    };
    await requestContextStorage.run(context, async () => {
      const repo = callFactory(); // no explicit
      await repo.find();
      expect(mockInnerRepo.find).toHaveBeenCalledWith({
        where: { tenantId: contextTenantId },
      });
    });
  });

  it('throws when neither explicit nor context tenantId is available', async () => {
    // Outside any requestContextStorage.run — no context present.
    const repo = callFactory();
    await expect(repo.find()).rejects.toThrow('No tenant context available');
  });

  it('save() auto-injects tenantId into persisted entity', async () => {
    const repo = callFactory(explicitTenantId);
    const entity = { id: 'e1', name: 'test' } as TestEntity;
    await repo.save(entity);
    expect(mockInnerRepo.save).toHaveBeenCalledWith({
      id: 'e1',
      name: 'test',
      tenantId: explicitTenantId,
    });
  });

  it('update() carries tenantId in the WHERE clause', async () => {
    const repo = callFactory(explicitTenantId);
    await repo.update({ id: 'e1' }, { name: 'renamed' });
    expect(mockInnerRepo.update).toHaveBeenCalledWith(
      { id: 'e1', tenantId: explicitTenantId },
      { name: 'renamed' },
    );
  });

  it('delete() carries tenantId in the WHERE clause (cross-tenant DELETE is impossible by construction)', async () => {
    const repo = callFactory(explicitTenantId);
    await repo.delete({ id: 'e1' });
    expect(mockInnerRepo.delete).toHaveBeenCalledWith({ id: 'e1', tenantId: explicitTenantId });
  });

  it('findOne() carries tenantId in the WHERE clause', async () => {
    const repo = callFactory(explicitTenantId);
    await repo.findOne({ where: { id: 'e1' } });
    expect(mockInnerRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'e1', tenantId: explicitTenantId },
    });
  });
});
