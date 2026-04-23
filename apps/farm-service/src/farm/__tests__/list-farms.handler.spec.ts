/**
 * ListFarmsQueryHandler Unit Tests
 *
 * Phase 5.6 repair — the spec predated the `PaginatedQueryResult<T>`
 * shape change (flat `items / total / page / totalPages / hasNext`
 * → nested `data + pagination { page, limit, total, totalPages,
 * hasNextPage, hasPreviousPage }`) and stopped compiling. It also
 * asserted properties the handler no longer returns. This rewrite
 * keeps the original test surface (pagination math, tenant
 * filtering, search escaping, relation loading, ordering, skip
 * offset) but against the current shape.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';

import { ListFarmsQueryHandler } from '../query-handlers/list-farms.handler';
import { ListFarmsQuery } from '../queries/list-farms.query';
import { Farm } from '../entities/farm.entity';

describe('ListFarmsQueryHandler', () => {
  let handler: ListFarmsQueryHandler;
  let farmRepository: jest.Mocked<Repository<Farm>>;

  const mockTenantId = 'tenant-123';

  const createMockFarm = (index: number, overrides: Partial<Farm> = {}): Farm =>
    ({
      id: `farm-${index}`,
      name: `Farm ${index}`,
      location: { lat: 10.0 + index, lng: 20.0 + index },
      tenantId: mockTenantId,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
      ...overrides,
    }) as Farm;

  beforeEach(async () => {
    const mockFarmRepository = {
      findAndCount: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListFarmsQueryHandler,
        {
          provide: getRepositoryToken(Farm),
          useValue: mockFarmRepository,
        },
      ],
    }).compile();

    handler = module.get<ListFarmsQueryHandler>(ListFarmsQueryHandler);
    farmRepository = module.get(getRepositoryToken(Farm));
  });

  describe('execute', () => {
    it('returns a paginated result on the canonical shape', async () => {
      const farms = [createMockFarm(1), createMockFarm(2), createMockFarm(3)];
      farmRepository.findAndCount.mockResolvedValue([farms, 3]);

      const query = new ListFarmsQuery(mockTenantId, { page: 1, limit: 10 });
      const result = await handler.execute(query);

      expect(result.data).toHaveLength(3);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 3,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });

    it('calculates pagination metadata on a partial page', async () => {
      const farms = [createMockFarm(1), createMockFarm(2)];
      farmRepository.findAndCount.mockResolvedValue([farms, 25]);

      const query = new ListFarmsQuery(mockTenantId, { page: 2, limit: 2 });
      const result = await handler.execute(query);

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(25);
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.limit).toBe(2);
      expect(result.pagination.totalPages).toBe(13); // ceil(25/2)
      expect(result.pagination.hasNextPage).toBe(true);
      expect(result.pagination.hasPreviousPage).toBe(true);
    });

    it('filters by tenant', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: mockTenantId }),
        }),
      );
    });

    it('filters by isActive when provided', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(
        mockTenantId,
        { page: 1, limit: 10 },
        { isActive: true },
      );
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: mockTenantId,
            isActive: true,
          }),
        }),
      );
    });

    it('filters by search term with escaped LIKE wildcards', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(
        mockTenantId,
        { page: 1, limit: 10 },
        { search: 'coastal' },
      );
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ name: Like('%coastal%') }),
        }),
      );
    });

    it('escapes % and _ in the search term to prevent LIKE pattern injection', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(
        mockTenantId,
        { page: 1, limit: 10 },
        { search: '50%_off' },
      );
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ name: Like('%50\\%\\_off%') }),
        }),
      );
    });

    it('includes ponds relation when requested', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(
        mockTenantId,
        { page: 1, limit: 10 },
        undefined,
        true,
      );
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ relations: ['ponds'] }),
      );
    });

    it('loads no relations by default', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ relations: [] }),
      );
    });

    it('returns zero-total result when no farms match', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      const result = await handler.execute(query);

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
      // `createPaginatedQueryResult` floors totalPages at 1 even
      // when the result is empty — page-1 of zero is still a valid
      // "empty page" for the frontend's pagination control.
      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    it('handles last-page metadata correctly', async () => {
      const farms = [createMockFarm(1)];
      farmRepository.findAndCount.mockResolvedValue([farms, 21]);

      const query = new ListFarmsQuery(mockTenantId, { page: 3, limit: 10 });
      const result = await handler.execute(query);

      expect(result.data).toHaveLength(1);
      expect(result.pagination.page).toBe(3);
      expect(result.pagination.totalPages).toBe(3);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(true);
    });

    it('translates (page, limit) into the correct SKIP / TAKE', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId, { page: 3, limit: 5 });
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10, // (3-1) * 5
          take: 5,
        }),
      );
    });

    it('orders by createdAt descending', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ order: { createdAt: 'DESC' } }),
      );
    });
  });

  describe('pagination edge cases', () => {
    it('first page flags hasPreviousPage=false, hasNextPage=true when more pages exist', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 20]);

      const query = new ListFarmsQuery(mockTenantId, { page: 1, limit: 10 });
      const result = await handler.execute(query);

      expect(result.pagination.hasPreviousPage).toBe(false);
      expect(result.pagination.hasNextPage).toBe(true);
    });

    it('single-page result flags both hasPreviousPage and hasNextPage false', async () => {
      const farms = [createMockFarm(1)];
      farmRepository.findAndCount.mockResolvedValue([farms, 1]);

      const query = new ListFarmsQuery(mockTenantId, { page: 1, limit: 10 });
      const result = await handler.execute(query);

      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    it('defaults to page 1, limit 10 when pagination is omitted', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 10 }),
      );
    });
  });
});
