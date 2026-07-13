import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';

import { TenantListItemDto } from '../../dto/tenant-detail.dto';
import { Tenant, TenantStatus, TenantPlan } from '../../entities/tenant.entity';
import { ListTenantsQuery } from '../../queries/tenant.queries';
import { ListTenantsHandler, PaginatedResult } from '../../query-handlers/tenant-query.handlers';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  Object.assign(tenant, {
    id: `tenant-${Math.random().toString(36).substr(2, 8)}`,
    name: 'Test Tenant',
    slug: 'test-tenant',
    status: TenantStatus.ACTIVE,
    plan: TenantPlan.STARTER,
    maxUsers: 10,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-06-01'),
    ...overrides,
  });
  return tenant;
};

const createMockTenants = (count: number): Tenant[] =>
  Array.from({ length: count }, (_, i) =>
    createMockTenant({
      id: `tenant-${i}`,
      name: `Tenant ${i}`,
      slug: `tenant-${i}`,
      createdAt: new Date(2024, 0, i + 1),
    }),
  );

// =============================================================================
// Tests
// =============================================================================

describe('ListTenantsHandler - Pagination', () => {
  let handler: ListTenantsHandler;
  let mockQueryBuilder: jest.Mocked<Partial<SelectQueryBuilder<Tenant>>>;

  beforeEach(async () => {
    mockQueryBuilder = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
    };

    const mockRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListTenantsHandler,
        {
          provide: getRepositoryToken(Tenant),
          useValue: mockRepository,
        },
        {
          // The handler batch-counts per-tenant farms/sensors via raw SQL.
          // These pagination fixtures use non-UUID tenant ids, so the count
          // path short-circuits before touching the DataSource — the mock only
          // satisfies DI (DTO-mapping behaviour is pinned in
          // ../list-tenants-contract.spec.ts).
          provide: DataSource,
          useValue: { query: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    handler = module.get<ListTenantsHandler>(ListTenantsHandler);
  });

  // ---------------------------------------------------------------------------
  // Default Pagination
  // ---------------------------------------------------------------------------

  describe('default pagination', () => {
    it('should return page 1 with limit 20 when no pagination params provided', async () => {
      const tenants = createMockTenants(20);
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([tenants, 50]);

      const result = await handler.execute(new ListTenantsQuery());

      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(0);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(20);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.data).toHaveLength(20);
      expect(result.total).toBe(50);
      expect(result.totalPages).toBe(3);
    });

    it('should default sort by createdAt DESC', async () => {
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

      await handler.execute(new ListTenantsQuery());

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'tenant.createdAt',
        'DESC',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Custom Page and Limit
  // ---------------------------------------------------------------------------

  describe('custom page and limit', () => {
    it('should apply custom page and limit', async () => {
      const tenants = createMockTenants(10);
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([tenants, 100]);

      const result = await handler.execute(
        new ListTenantsQuery(undefined, { page: 3, limit: 10 }),
      );

      // page 3, limit 10 => skip = (3-1) * 10 = 20
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(20);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(10);
      expect(result.page).toBe(3);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(10);
    });

    it('should cap limit at 100', async () => {
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

      const result = await handler.execute(
        new ListTenantsQuery(undefined, { page: 1, limit: 500 }),
      );

      expect(mockQueryBuilder.take).toHaveBeenCalledWith(100);
      expect(result.limit).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // Page Beyond Total
  // ---------------------------------------------------------------------------

  describe('page beyond total', () => {
    it('should return empty data when page exceeds total pages', async () => {
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 50]);

      const result = await handler.execute(
        new ListTenantsQuery(undefined, { page: 100, limit: 20 }),
      );

      expect(result.data).toEqual([]);
      expect(result.total).toBe(50);
      expect(result.page).toBe(100);
      expect(result.totalPages).toBe(3);
    });

    it('should not throw error for page 0 or negative (treated as page 1)', async () => {
      const tenants = createMockTenants(5);
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([tenants, 5]);

      const result = await handler.execute(
        new ListTenantsQuery(undefined, { page: 0, limit: 20 }),
      );

      // page || 1 => page 0 becomes page 1
      expect(result.page).toBe(1);
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Sorting
  // ---------------------------------------------------------------------------

  describe('sorting', () => {
    it('should apply custom sort field and order', async () => {
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

      await handler.execute(
        new ListTenantsQuery(undefined, undefined, {
          field: 'name',
          order: 'ASC',
        }),
      );

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'tenant.name',
        'ASC',
      );
    });

    it('should fall back to createdAt DESC for disallowed sort fields', async () => {
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

      await handler.execute(
        new ListTenantsQuery(undefined, undefined, {
          field: 'maliciousField',
          order: 'ASC',
        }),
      );

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'tenant.createdAt',
        'DESC',
      );
    });

    it('should allow all whitelisted sort fields', async () => {
      const allowedFields = ['name', 'createdAt', 'updatedAt', 'status', 'plan', 'maxUsers'];

      for (const field of allowedFields) {
        (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);
        jest.clearAllMocks();

        // Re-setup mock chain
        mockQueryBuilder.andWhere = jest.fn().mockReturnValue(mockQueryBuilder);
        mockQueryBuilder.orderBy = jest.fn().mockReturnValue(mockQueryBuilder);
        mockQueryBuilder.skip = jest.fn().mockReturnValue(mockQueryBuilder);
        mockQueryBuilder.take = jest.fn().mockReturnValue(mockQueryBuilder);
        mockQueryBuilder.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);

        await handler.execute(
          new ListTenantsQuery(undefined, undefined, { field, order: 'ASC' }),
        );

        expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
          `tenant.${field}`,
          'ASC',
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  describe('filtering with pagination', () => {
    it('should apply status filter', async () => {
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

      await handler.execute(
        new ListTenantsQuery({ status: TenantStatus.ACTIVE }),
      );

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'tenant.status = :status',
        { status: TenantStatus.ACTIVE },
      );
    });

    it('should apply plan filter', async () => {
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

      await handler.execute(
        new ListTenantsQuery({ plan: TenantPlan.ENTERPRISE }),
      );

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'tenant.plan = :plan',
        { plan: TenantPlan.ENTERPRISE },
      );
    });

    it('should apply search filter with ILIKE', async () => {
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

      await handler.execute(
        new ListTenantsQuery({ search: 'aqua' }),
      );

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(tenant.name ILIKE :search OR tenant.slug ILIKE :search OR tenant.customDomain ILIKE :search)',
        { search: '%aqua%' },
      );
    });

    it('should combine filters with pagination', async () => {
      const tenants = createMockTenants(5);
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([tenants, 15]);

      const result = await handler.execute(
        new ListTenantsQuery(
          { status: TenantStatus.ACTIVE, plan: TenantPlan.PROFESSIONAL },
          { page: 2, limit: 5 },
          { field: 'name', order: 'ASC' },
        ),
      );

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledTimes(2);
      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(5);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(5);
      expect(result.data).toHaveLength(5);
      expect(result.total).toBe(15);
      expect(result.totalPages).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Response Shape
  // ---------------------------------------------------------------------------

  describe('response shape', () => {
    it('should return PaginatedResult with correct structure', async () => {
      const tenants = createMockTenants(3);
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([tenants, 3]);

      const result: PaginatedResult<TenantListItemDto> = await handler.execute(
        new ListTenantsQuery(),
      );

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('page');
      expect(result).toHaveProperty('limit');
      expect(result).toHaveProperty('totalPages');
      expect(Array.isArray(result.data)).toBe(true);
      expect(typeof result.total).toBe('number');
      expect(typeof result.page).toBe('number');
      expect(typeof result.limit).toBe('number');
      expect(typeof result.totalPages).toBe('number');
    });

    it('should calculate totalPages correctly', async () => {
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

      const result = await handler.execute(
        new ListTenantsQuery(undefined, { page: 1, limit: 10 }),
      );

      expect(result.totalPages).toBe(0); // Math.ceil(0 / 10) = 0
    });

    it('should calculate totalPages correctly for exact page boundary', async () => {
      const tenants = createMockTenants(10);
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([tenants, 30]);

      const result = await handler.execute(
        new ListTenantsQuery(undefined, { page: 1, limit: 10 }),
      );

      expect(result.totalPages).toBe(3); // Math.ceil(30 / 10) = 3
    });

    it('should calculate totalPages correctly for partial last page', async () => {
      const tenants = createMockTenants(10);
      (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([tenants, 25]);

      const result = await handler.execute(
        new ListTenantsQuery(undefined, { page: 1, limit: 10 }),
      );

      expect(result.totalPages).toBe(3); // Math.ceil(25 / 10) = 3
    });
  });
});
