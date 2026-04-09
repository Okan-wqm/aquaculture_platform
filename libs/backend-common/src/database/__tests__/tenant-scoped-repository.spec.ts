import { DataSource, Repository, EntityTarget, SelectQueryBuilder } from 'typeorm';
import { TenantScopedRepository } from '../tenant-scoped-repository';
import { TenantEntity } from '../tenant-aware.repository';
import { requestContextStorage, RequestContext } from '../../logging/request-context';

interface TestEntity extends TenantEntity {
  id: string;
  tenantId: string;
  name: string;
  sensorId?: string;
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
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      create: jest.fn().mockImplementation((entity) => entity),
      update: jest.fn().mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
      delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
      softDelete: jest.fn().mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
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
      const result = TenantScopedRepository.create(
        mockDataSource,
        {} as EntityTarget<TestEntity>,
      );
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

      await requestContextStorage.run(context, async () => {
        expect(repo.getTenantId()).toBe(tenantId);
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

      await requestContextStorage.run(context, async () => {
        expect(repo.getTenantId()).toBe(explicitTenant);
      });
    });
  });

  // ── Read operations ──

  describe('find()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into where clause', async () => {
      await repo.find({ where: { name: 'test' } as any });
      expect(mockRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId, name: 'test' }),
        }),
      );
    });

    it('should add tenantId when called without options', async () => {
      await repo.find();
      expect(mockRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId }),
        }),
      );
    });

    it('should preserve additional options (order, take, skip)', async () => {
      await repo.find({ where: { name: 'x' } as any, take: 10, skip: 5, order: { name: 'ASC' } as any });
      expect(mockRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId, name: 'x' }),
          take: 10,
          skip: 5,
          order: { name: 'ASC' },
        }),
      );
    });
  });

  describe('findOne()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into where clause', async () => {
      await repo.findOne({ where: { id: 'abc' } as any });
      expect(mockRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId, id: 'abc' }),
        }),
      );
    });
  });

  describe('findOneOrFail()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should return entity when found', async () => {
      const entity = { id: '1', tenantId, name: 'test' };
      mockRepository.findOne.mockResolvedValue(entity as TestEntity);
      const result = await repo.findOneOrFail({ where: { id: '1' } as any });
      expect(result).toEqual(entity);
    });

    it('should throw when entity not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      await expect(repo.findOneOrFail({ where: { id: 'missing' } as any }))
        .rejects.toThrow('Entity not found within tenant scope');
    });
  });

  describe('findById()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should query by id and tenantId', async () => {
      await repo.findById('entity-1');
      expect(mockRepository.createQueryBuilder).toHaveBeenCalledWith('entity');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'entity.id = :id',
        { id: 'entity-1' },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'entity."tenantId" = :tenantId',
        { tenantId },
      );
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
      expect(mockRepository.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId }),
        }),
      );
    });

    it('should merge custom where with tenantId', async () => {
      await repo.count({ where: { name: 'active' } as any });
      expect(mockRepository.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId, name: 'active' }),
        }),
      );
    });
  });

  describe('exists()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should return true when entity found', async () => {
      mockQueryBuilder.getOne.mockResolvedValue({ id: '1', tenantId, name: 'test' } as TestEntity);
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
      await repo.save({ name: 'new-sensor' } as any);
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'new-sensor', tenantId }),
      );
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it('should overwrite foreign tenantId', async () => {
      const foreignTenant = '770e8400-e29b-41d4-a716-446655440000';
      await repo.save({ name: 'hijacked', tenantId: foreignTenant } as any);
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'hijacked', tenantId }),
      );
    });
  });

  describe('saveMany()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should set tenantId on all entities', async () => {
      await repo.saveMany([
        { name: 'sensor-1' } as any,
        { name: 'sensor-2' } as any,
      ]);
      expect(mockRepository.create).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'sensor-1', tenantId }),
        expect.objectContaining({ name: 'sensor-2', tenantId }),
      ]);
    });
  });

  // ── CRITICAL: delete() tenant scoping (SENSOR-CRITICAL-002 root cause fix) ──

  describe('delete()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into delete criteria', async () => {
      await repo.delete({ sensorId: 'sensor-1' } as any);
      expect(mockRepository.delete).toHaveBeenCalledWith(
        expect.objectContaining({ sensorId: 'sensor-1', tenantId }),
      );
    });

    it('should add tenantId even with empty criteria', async () => {
      await repo.delete({} as any);
      expect(mockRepository.delete).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId }),
      );
    });

    it('should throw when no tenant context (prevents unscoped delete)', () => {
      const unscopedRepo = TenantScopedRepository.fromRepository(mockRepository);
      expect(unscopedRepo.delete({ sensorId: 'x' } as any)).rejects.toThrow(
        'No tenant context available',
      );
    });
  });

  describe('update()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into update criteria', async () => {
      await repo.update(
        { sensorId: 'sensor-1' } as any,
        { name: 'updated' } as any,
      );
      expect(mockRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ sensorId: 'sensor-1', tenantId }),
        expect.objectContaining({ name: 'updated' }),
      );
    });

    it('should strip tenantId from the update payload (prevent reassignment)', async () => {
      const foreignTenant = '770e8400-e29b-41d4-a716-446655440000';
      await repo.update(
        { id: '1' } as any,
        { name: 'updated', tenantId: foreignTenant } as any,
      );
      expect(mockRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: '1', tenantId }),
        expect.not.objectContaining({ tenantId: foreignTenant }),
      );
    });
  });

  describe('softDelete()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should auto-inject tenantId into soft delete criteria', async () => {
      await repo.softDelete({ sensorId: 'sensor-1' } as any);
      expect(mockRepository.softDelete).toHaveBeenCalledWith(
        expect.objectContaining({ sensorId: 'sensor-1', tenantId }),
      );
    });
  });

  // ── Query builder ──

  describe('createQueryBuilder()', () => {
    beforeEach(() => {
      repo = TenantScopedRepository.fromRepository(mockRepository, tenantId);
    });

    it('should create query builder with tenant WHERE clause', () => {
      repo.createQueryBuilder('channel');
      expect(mockRepository.createQueryBuilder).toHaveBeenCalledWith('channel');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'channel."tenantId" = :tenantId',
        { tenantId },
      );
    });

    it('should use default alias "entity" when none provided', () => {
      repo.createQueryBuilder();
      expect(mockRepository.createQueryBuilder).toHaveBeenCalledWith('entity');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'entity."tenantId" = :tenantId',
        { tenantId },
      );
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
        expect(mockRepository.find).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ tenantId }),
          }),
        );
      });
    });

    it('should resolve tenantId from withTenantContext (MQTT/cron simulation)', async () => {
      const mqttTenantId = '880e8400-e29b-41d4-a716-446655440000';
      const context: RequestContext = { tenantId: mqttTenantId, schemaName: 'tenant_880e8400e29b41d4' };

      await requestContextStorage.run(context, async () => {
        await asyncRepo.delete({ sensorId: 'mqtt-sensor' } as any);
        expect(mockRepository.delete).toHaveBeenCalledWith(
          expect.objectContaining({ sensorId: 'mqtt-sensor', tenantId: mqttTenantId }),
        );
      });
    });

    it('should fail gracefully outside any context', async () => {
      await expect(asyncRepo.find()).rejects.toThrow('No tenant context available');
    });
  });
});
