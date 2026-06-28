/**
 * List Farms Handler Unit Tests
 *
 * Tests for farm list/read operations via CQRS query handler. Reads run through
 * the fail-closed tenant boundary (runInTenantRead), so the handler is exercised
 * with the @aquaculture/testing mock-datasource factory and a valid-UUID tenant.
 */

import { createMockDataSource } from '@aquaculture/testing';
import { Like } from 'typeorm';

import { Farm } from '../entities/farm.entity';
import { ListFarmsQuery } from '../queries/list-farms.query';
import { ListFarmsQueryHandler } from '../query-handlers/list-farms.handler';

describe('ListFarmsQueryHandler', () => {
  // Must be a valid UUID — the tenant boundary (withTenantContext) rejects others.
  const mockTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  let handler: ListFarmsQueryHandler;
  let findAndCount: jest.Mock;

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

  beforeEach(() => {
    const { mockDataSource, mockManager } = createMockDataSource();
    findAndCount = mockManager.findAndCount as jest.Mock;
    handler = new ListFarmsQueryHandler(mockDataSource);
  });

  describe('execute', () => {
    it('should return paginated farms', async () => {
      const farms = [createMockFarm(1), createMockFarm(2), createMockFarm(3)];
      findAndCount.mockResolvedValue([farms, 3]);

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
      const farms = [createMockFarm(1), createMockFarm(2)];
      findAndCount.mockResolvedValue([farms, 25]);

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
      findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(findAndCount).toHaveBeenCalledWith(
        Farm,
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: mockTenantId }),
        }),
      );
    });

    it('should filter by isActive when provided', async () => {
      findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(
        mockTenantId,
        { page: 1, limit: 10 },
        { isActive: true },
      );
      await handler.execute(query);

      expect(findAndCount).toHaveBeenCalledWith(
        Farm,
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: mockTenantId, isActive: true }),
        }),
      );
    });

    it('should filter by search term', async () => {
      findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(
        mockTenantId,
        { page: 1, limit: 10 },
        { search: 'coastal' },
      );
      await handler.execute(query);

      expect(findAndCount).toHaveBeenCalledWith(
        Farm,
        expect.objectContaining({
          where: expect.objectContaining({ name: Like('%coastal%') }),
        }),
      );
    });

    it('should include ponds when requested', async () => {
      findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(
        mockTenantId,
        { page: 1, limit: 10 },
        undefined,
        true, // includePonds
      );
      await handler.execute(query);

      expect(findAndCount).toHaveBeenCalledWith(
        Farm,
        expect.objectContaining({ relations: ['ponds'] }),
      );
    });

    it('should not include ponds by default', async () => {
      findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(findAndCount).toHaveBeenCalledWith(
        Farm,
        expect.objectContaining({ relations: [] }),
      );
    });

    it('should return empty result when no farms found', async () => {
      findAndCount.mockResolvedValue([[], 0]);

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
      findAndCount.mockResolvedValue([farms, 21]);

      const query = new ListFarmsQuery(mockTenantId, { page: 3, limit: 10 });
      const result = await handler.execute(query);

      expect(result.data).toHaveLength(1);
      expect(result.pagination.page).toBe(3);
      expect(result.pagination.totalPages).toBe(3);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(true);
    });

    it('should calculate correct skip offset', async () => {
      findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId, { page: 3, limit: 5 });
      await handler.execute(query);

      expect(findAndCount).toHaveBeenCalledWith(
        Farm,
        expect.objectContaining({ skip: 10, take: 5 }),
      );
    });

    it('should order by createdAt descending', async () => {
      findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(findAndCount).toHaveBeenCalledWith(
        Farm,
        expect.objectContaining({ order: { createdAt: 'DESC' } }),
      );
    });
  });

  describe('pagination edge cases', () => {
    it('should handle first page', async () => {
      findAndCount.mockResolvedValue([[], 20]);

      const query = new ListFarmsQuery(mockTenantId, { page: 1, limit: 10 });
      const result = await handler.execute(query);

      expect(result.pagination.hasPreviousPage).toBe(false);
      expect(result.pagination.hasNextPage).toBe(true);
    });

    it('should handle single page result', async () => {
      const farms = [createMockFarm(1)];
      findAndCount.mockResolvedValue([farms, 1]);

      const query = new ListFarmsQuery(mockTenantId, { page: 1, limit: 10 });
      const result = await handler.execute(query);

      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNextPage).toBe(false);
      expect(result.pagination.hasPreviousPage).toBe(false);
    });

    it('should default to page 1, limit 10', async () => {
      findAndCount.mockResolvedValue([[], 0]);

      const query = new ListFarmsQuery(mockTenantId);
      await handler.execute(query);

      expect(findAndCount).toHaveBeenCalledWith(
        Farm,
        expect.objectContaining({ skip: 0, take: 10 }),
      );
    });
  });
});
