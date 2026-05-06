/**
 * List Farms Handler Unit Tests
 *
 * Tests for farm list/read operations via CQRS query handler
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
    it('should return paginated farms', async () => {
      const farms = [createMockFarm(1), createMockFarm(2), createMockFarm(3)];
      farmRepository.findAndCount.mockResolvedValue([farms, 3]);

      const query = new ListFarmsQuery(mockTenantId, { page: 1, limit: 10 });
      const result = await handler.execute(query);

      expect(result.data).toHaveLength(3);
      expect(result.pagination.total).toBe(3);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    it('should correctly calculate pagination metadata', async () => {
      const farms = [
        createMockFarm(1),
        createMockFarm(2),
      ];
      farmRepository.findAndCount.mockResolvedValue([farms, 25]);

      const query = new ListFarmsQuery(mockTenantId, { page: 2, limit: 2 });
      const result = await handler.execute(query);

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(25);
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.limit).toBe(2);
      expect(result.pagination.totalPages).toBe(13); // 25/2 = 12.5, ceil = 13
      expect(result.pagination.hasNextPage).toBe(true);
      expect(result.pagination.hasPreviousPage).toBe(true);
    });

    it('should filter farms by tenant', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: mockTenantId,
          }),
        }),
      );
    });

    it('should filter by isActive when provided', async () => {
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

    it('should filter by search term', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(
        mockTenantId,
        { page: 1, limit: 10 },
        { search: 'coastal' },
      );
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            name: Like('%coastal%'),
          }),
        }),
      );
    });

    it('should include ponds when requested', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(
        mockTenantId,
        { page: 1, limit: 10 },
        undefined,
        true, // includePonds
      );
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          relations: ['ponds'],
        }),
      );
    });

    it('should not include ponds by default', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          relations: [],
        }),
      );
    });

    it('should return empty result when no farms found', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      const result = await handler.execute(query);

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    it('should handle last page correctly', async () => {
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

    it('should calculate correct skip offset', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId, { page: 3, limit: 5 });
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10, // (3-1) * 5 = 10
          take: 5,
        }),
      );
    });

    it('should order by createdAt descending', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { createdAt: 'DESC' },
        }),
      );
    });
  });

  describe('pagination edge cases', () => {
    it('should handle first page', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 20]);

      const query = new ListFarmsQuery(mockTenantId, { page: 1, limit: 10 });
      const result = await handler.execute(query);

      expect(result.pagination.hasPreviousPage).toBe(false);
      expect(result.pagination.hasNextPage).toBe(true);
    });

    it('should handle single page result', async () => {
      const farms = [createMockFarm(1)];
      farmRepository.findAndCount.mockResolvedValue([farms, 1]);

      const query = new ListFarmsQuery(mockTenantId, { page: 1, limit: 10 });
      const result = await handler.execute(query);

      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    it('should default to page 1, limit 10', async () => {
      farmRepository.findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(farmRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 10,
        }),
      );
    });
  });
});
