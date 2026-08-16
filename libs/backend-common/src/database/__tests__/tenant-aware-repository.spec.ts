import { DataSource, Repository, EntityTarget, SelectQueryBuilder } from 'typeorm';

import type { TenantRequest } from '../../types/tenant-request.interface';
import { SchemaManagerService } from '../schema-manager.service';
import { TenantAwareRepository, TenantEntity } from '../tenant-aware.repository';

interface TestEntity extends TenantEntity {
  id: string;
  tenantId: string;
  name: string;
}

function tenantRequest(tenantId?: string): TenantRequest {
  const request: Partial<TenantRequest> = {
    headers: {},
    ...(tenantId === undefined ? {} : { user: { sub: 'user-1', tenantId } }),
  };
  return request as TenantRequest;
}

describe('TenantAwareRepository', () => {
  let repo: TenantAwareRepository<TestEntity>;
  let mockDataSource: jest.Mocked<DataSource>;
  let mockSchemaManager: jest.Mocked<SchemaManagerService>;
  let mockRepository: jest.Mocked<Repository<TestEntity>>;
  let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<TestEntity>>;
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
      find: jest.fn(),
      findOne: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
      create: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<TestEntity>>;

    mockDataSource = {
      getRepository: jest.fn().mockReturnValue(mockRepository),
      query: jest.fn(),
      transaction: jest.fn(),
    } as unknown as jest.Mocked<DataSource>;

    mockSchemaManager = {
      getTenantSchemaName: jest.fn().mockReturnValue('tenant_550e8400e29b41d4'),
      setTenantSearchPathInTransaction: jest.fn(),
    } as unknown as jest.Mocked<SchemaManagerService>;

    repo = new TenantAwareRepository<TestEntity>(
      mockDataSource,
      mockSchemaManager,
      tenantRequest(tenantId),
      {} as EntityTarget<TestEntity>,
    );
  });

  describe('getRepository() deprecation', () => {
    it('should throw an error explaining deprecation', () => {
      const deprecatedGetRepository = repo.getRepository.bind(repo);
      expect(deprecatedGetRepository).toThrow(/deprecated/i);
      expect(deprecatedGetRepository).toThrow(/getScopedRepository/i);
    });
  });

  describe('getScopedRepository()', () => {
    it('should return a proxy object', () => {
      const scoped = repo.getScopedRepository();
      expect(scoped).toBeDefined();
      expect(typeof scoped.find).toBe('function');
      expect(typeof scoped.findOne).toBe('function');
      expect(typeof scoped.count).toBe('function');
      expect(typeof scoped.createQueryBuilder).toBe('function');
    });

    it('find should automatically add tenant filter', async () => {
      mockRepository.find.mockResolvedValue([]);
      const scoped = repo.getScopedRepository();
      await scoped.find({ where: { name: 'test' } });
      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { tenantId, name: 'test' },
      });
    });

    it('find without options should add tenant filter', async () => {
      mockRepository.find.mockResolvedValue([]);
      const scoped = repo.getScopedRepository();
      await scoped.find();
      expect(mockRepository.find).toHaveBeenCalledWith({ where: { tenantId } });
    });

    it('findOne should automatically add tenant filter', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      const scoped = repo.getScopedRepository();
      await scoped.findOne({ where: { id: 'abc' } });
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { tenantId, id: 'abc' },
      });
    });

    it('count should automatically add tenant filter', async () => {
      mockRepository.count.mockResolvedValue(5);
      const scoped = repo.getScopedRepository();
      const result = await scoped.count();
      expect(mockRepository.count).toHaveBeenCalledWith({ where: { tenantId } });
      expect(result).toBe(5);
    });

    it('createQueryBuilder should add tenant where clause', () => {
      const scoped = repo.getScopedRepository();
      scoped.createQueryBuilder('entity');
      expect(mockRepository.createQueryBuilder).toHaveBeenCalledWith('entity');
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('"tenantId" = :tenantId', {
        tenantId,
      });
    });
  });

  describe('getUnfilteredRepository()', () => {
    it('should return the raw repository without tenant filtering', () => {
      const unfiltered = repo.getUnfilteredRepository();
      expect(unfiltered).toBe(mockRepository);
    });

    it('should allow operations without tenant filter', async () => {
      mockRepository.find.mockResolvedValue([]);
      const unfiltered = repo.getUnfilteredRepository();
      await unfiltered.find({});
      expect(mockRepository.find).toHaveBeenCalledWith({});
    });
  });

  describe('tenant context requirement', () => {
    it('getScopedRepository should throw when no tenant context', () => {
      const noTenantRepo = new TenantAwareRepository<TestEntity>(
        mockDataSource,
        mockSchemaManager,
        tenantRequest(),
        {} as EntityTarget<TestEntity>,
      );
      expect(() => noTenantRepo.getScopedRepository()).toThrow('Tenant context is required');
    });
  });
});
