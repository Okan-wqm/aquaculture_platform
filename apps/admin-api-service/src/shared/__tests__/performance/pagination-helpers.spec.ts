import { calculateHasMore, createPaginatedResult, IPaginatedResult } from '@aquaculture/backend-common/pagination';

describe('Pagination Helpers', () => {
  // ---------------------------------------------------------------------------
  // calculateHasMore
  // ---------------------------------------------------------------------------

  describe('calculateHasMore', () => {
    it('should return true when there are more items', () => {
      expect(calculateHasMore(100, 0, 20)).toBe(true);  // 0+20 < 100
      expect(calculateHasMore(50, 20, 20)).toBe(true);   // 20+20 < 50
    });

    it('should return false when at the last page', () => {
      expect(calculateHasMore(100, 80, 20)).toBe(false); // 80+20 = 100
      expect(calculateHasMore(50, 40, 20)).toBe(false);  // 40+20 > 50
    });

    it('should return false when offset exceeds total', () => {
      expect(calculateHasMore(10, 100, 20)).toBe(false);
    });

    it('should return false when total is 0', () => {
      expect(calculateHasMore(0, 0, 20)).toBe(false);
    });

    it('should handle single item result', () => {
      expect(calculateHasMore(1, 0, 1)).toBe(false);
      expect(calculateHasMore(2, 0, 1)).toBe(true);
    });

    it('should return false when offset + limit equals total exactly', () => {
      expect(calculateHasMore(20, 0, 20)).toBe(false);
      expect(calculateHasMore(40, 20, 20)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // createPaginatedResult
  // ---------------------------------------------------------------------------

  describe('createPaginatedResult', () => {
    it('should create a valid paginated result', () => {
      const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const result = createPaginatedResult(items, 10, 0, 3);

      expect(result.items).toEqual(items);
      expect(result.total).toBe(10);
      expect(result.hasMore).toBe(true);
    });

    it('should set hasMore to false on last page', () => {
      const items = [{ id: 8 }, { id: 9 }, { id: 10 }];
      const result = createPaginatedResult(items, 10, 7, 3);

      expect(result.items).toEqual(items);
      expect(result.total).toBe(10);
      expect(result.hasMore).toBe(false);
    });

    it('should handle empty result set', () => {
      const result = createPaginatedResult([], 0, 0, 20);

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should handle page beyond total returning empty items', () => {
      const result = createPaginatedResult([], 50, 100, 20);

      expect(result.items).toEqual([]);
      expect(result.total).toBe(50);
      expect(result.hasMore).toBe(false);
    });

    it('should conform to IPaginatedResult interface', () => {
      const result: IPaginatedResult<{ name: string }> = createPaginatedResult(
        [{ name: 'test' }],
        1,
        0,
        20,
      );

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('hasMore');
      expect(result.items[0]!.name).toBe('test');
    });

    it('should work with various entity types', () => {
      // String items
      const strResult = createPaginatedResult(['a', 'b', 'c'], 3, 0, 10);
      expect(strResult.items).toEqual(['a', 'b', 'c']);

      // Number items
      const numResult = createPaginatedResult([1, 2, 3], 100, 0, 3);
      expect(numResult.hasMore).toBe(true);

      // Complex objects
      const objResult = createPaginatedResult(
        [{ id: '1', nested: { value: 42 } }],
        1,
        0,
        20,
      );
      expect(objResult.items[0]!.nested.value).toBe(42);
    });
  });
});
