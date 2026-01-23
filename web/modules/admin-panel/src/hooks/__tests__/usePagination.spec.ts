/**
 * usePagination Hook Tests
 *
 * Comprehensive tests for the pagination hook.
 * Tests cover navigation, limits, URL sync, and edge cases.
 */

import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { usePagination } from '../usePagination';

// Wrapper component for router context
const createWrapper = (initialEntries: string[] = ['/']) => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    React.createElement(MemoryRouter, { initialEntries }, children)
  );
  return Wrapper;
};

describe('usePagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // Initial State Tests
  // ============================================================================

  describe('Initial State', () => {
    it('should have correct default values', () => {
      const { result } = renderHook(() => usePagination(), {
        wrapper: createWrapper(),
      });

      expect(result.current.page).toBe(1);
      expect(result.current.limit).toBe(20);
      expect(result.current.total).toBe(0);
      expect(result.current.totalPages).toBe(1);
      expect(result.current.offset).toBe(0);
      expect(result.current.canPrev).toBe(false);
      expect(result.current.canNext).toBe(false);
      expect(result.current.pageSizeOptions).toEqual([10, 20, 50, 100]);
    });

    it('should accept custom initial values', () => {
      const { result } = renderHook(
        () =>
          usePagination({
            initialPage: 3,
            initialLimit: 50,
            initialTotal: 200,
            pageSizeOptions: [25, 50, 75, 100],
          }),
        { wrapper: createWrapper() }
      );

      expect(result.current.page).toBe(3);
      expect(result.current.limit).toBe(50);
      expect(result.current.total).toBe(200);
      expect(result.current.totalPages).toBe(4);
      expect(result.current.offset).toBe(100); // (3-1) * 50
      expect(result.current.pageSizeOptions).toEqual([25, 50, 75, 100]);
    });

    it('should read initial values from URL when syncUrl=true', () => {
      const { result } = renderHook(
        () => usePagination({ syncUrl: true }),
        { wrapper: createWrapper(['/?page=5&limit=50']) }
      );

      expect(result.current.page).toBe(5);
      expect(result.current.limit).toBe(50);
    });
  });

  // ============================================================================
  // Navigation Tests
  // ============================================================================

  describe('Navigation', () => {
    it('should go to specific page', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 100 }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.goToPage(3);
      });

      expect(result.current.page).toBe(3);
      expect(result.current.offset).toBe(40); // (3-1) * 20
    });

    it('should go to next page', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 100 }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.nextPage();
      });

      expect(result.current.page).toBe(2);
    });

    it('should go to previous page', () => {
      const { result } = renderHook(
        () => usePagination({ initialPage: 3, initialTotal: 100 }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.prevPage();
      });

      expect(result.current.page).toBe(2);
    });

    it('should go to first page', () => {
      const { result } = renderHook(
        () => usePagination({ initialPage: 5, initialTotal: 100 }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.firstPage();
      });

      expect(result.current.page).toBe(1);
    });

    it('should go to last page', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 100, initialLimit: 20 }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.lastPage();
      });

      expect(result.current.page).toBe(5); // 100 / 20 = 5 pages
    });

    it('should not go below page 1', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 100 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.canPrev).toBe(false);

      act(() => {
        result.current.prevPage();
      });

      expect(result.current.page).toBe(1);

      act(() => {
        result.current.goToPage(0);
      });

      expect(result.current.page).toBe(1);

      act(() => {
        result.current.goToPage(-5);
      });

      expect(result.current.page).toBe(1);
    });

    it('should not go above total pages', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 100, initialLimit: 20, initialPage: 5 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.canNext).toBe(false);

      act(() => {
        result.current.nextPage();
      });

      expect(result.current.page).toBe(5);

      act(() => {
        result.current.goToPage(10);
      });

      expect(result.current.page).toBe(5);
    });
  });

  // ============================================================================
  // Limit/Page Size Tests
  // ============================================================================

  describe('Page Size', () => {
    it('should change page size and reset to page 1', () => {
      const { result } = renderHook(
        () => usePagination({ initialPage: 3, initialTotal: 100 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.page).toBe(3);

      act(() => {
        result.current.setLimit(50);
      });

      expect(result.current.limit).toBe(50);
      expect(result.current.page).toBe(1); // Reset to page 1
      expect(result.current.totalPages).toBe(2); // 100 / 50 = 2
    });

    it('should recalculate total pages when limit changes', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 100, initialLimit: 10 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.totalPages).toBe(10);

      act(() => {
        result.current.setLimit(25);
      });

      expect(result.current.totalPages).toBe(4);
    });
  });

  // ============================================================================
  // Total Updates Tests
  // ============================================================================

  describe('Total Updates', () => {
    it('should update total and recalculate pages', () => {
      const { result } = renderHook(
        () => usePagination({ initialLimit: 20 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.total).toBe(0);
      expect(result.current.totalPages).toBe(1);

      act(() => {
        result.current.setTotal(250);
      });

      expect(result.current.total).toBe(250);
      expect(result.current.totalPages).toBe(13); // Math.ceil(250/20)
    });

    it('should handle total becoming less than current page offset', () => {
      const { result } = renderHook(
        () => usePagination({ initialPage: 5, initialTotal: 100, initialLimit: 20 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.page).toBe(5);

      act(() => {
        result.current.setTotal(50);
      });

      // Total pages is now 3, but page stays at 5 until explicitly changed
      expect(result.current.totalPages).toBe(3);

      // Going to a valid page should work
      act(() => {
        result.current.goToPage(5);
      });

      expect(result.current.page).toBe(3); // Clamped to max
    });
  });

  // ============================================================================
  // Reset Tests
  // ============================================================================

  describe('Reset', () => {
    it('should reset to initial values', () => {
      const { result } = renderHook(
        () =>
          usePagination({
            initialPage: 1,
            initialLimit: 20,
            initialTotal: 0,
          }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.goToPage(5);
        result.current.setLimit(50);
        result.current.setTotal(500);
      });

      expect(result.current.page).not.toBe(1);

      act(() => {
        result.current.reset();
      });

      expect(result.current.page).toBe(1);
      expect(result.current.limit).toBe(20);
      expect(result.current.total).toBe(0);
    });
  });

  // ============================================================================
  // API Params Tests
  // ============================================================================

  describe('getApiParams', () => {
    it('should return correct API params', () => {
      const { result } = renderHook(
        () => usePagination({ initialPage: 3, initialLimit: 25, initialTotal: 100 }),
        { wrapper: createWrapper() }
      );

      const params = result.current.getApiParams();

      expect(params).toEqual({
        page: 3,
        limit: 25,
        offset: 50, // (3-1) * 25
      });
    });

    it('should update params after navigation', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 100 }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.goToPage(4);
      });

      const params = result.current.getApiParams();

      expect(params).toEqual({
        page: 4,
        limit: 20,
        offset: 60,
      });
    });
  });

  // ============================================================================
  // Can Prev/Next Tests
  // ============================================================================

  describe('Navigation Availability', () => {
    it('should correctly report canPrev and canNext', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 60, initialLimit: 20 }),
        { wrapper: createWrapper() }
      );

      // Page 1 of 3
      expect(result.current.canPrev).toBe(false);
      expect(result.current.canNext).toBe(true);

      act(() => {
        result.current.nextPage();
      });

      // Page 2 of 3
      expect(result.current.canPrev).toBe(true);
      expect(result.current.canNext).toBe(true);

      act(() => {
        result.current.nextPage();
      });

      // Page 3 of 3
      expect(result.current.canPrev).toBe(true);
      expect(result.current.canNext).toBe(false);
    });

    it('should handle single page correctly', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 10, initialLimit: 20 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.totalPages).toBe(1);
      expect(result.current.canPrev).toBe(false);
      expect(result.current.canNext).toBe(false);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle zero total', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 0 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.totalPages).toBe(1);
      expect(result.current.canPrev).toBe(false);
      expect(result.current.canNext).toBe(false);
    });

    it('should handle total less than limit', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 5, initialLimit: 20 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.totalPages).toBe(1);
    });

    it('should handle total exactly divisible by limit', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 100, initialLimit: 20 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.totalPages).toBe(5);
    });

    it('should handle total not divisible by limit', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 101, initialLimit: 20 }),
        { wrapper: createWrapper() }
      );

      expect(result.current.totalPages).toBe(6);
    });
  });

  // ============================================================================
  // E2E Style Integration Tests
  // ============================================================================

  describe('E2E Style Integration', () => {
    it('should handle complete pagination workflow', () => {
      const { result } = renderHook(
        () => usePagination({ initialLimit: 10 }),
        { wrapper: createWrapper() }
      );

      // Simulate receiving data from API
      act(() => {
        result.current.setTotal(95);
      });

      expect(result.current.totalPages).toBe(10);
      expect(result.current.page).toBe(1);

      // Navigate through pages
      act(() => {
        result.current.nextPage();
        result.current.nextPage();
        result.current.nextPage();
      });

      expect(result.current.page).toBe(4);
      expect(result.current.offset).toBe(30);

      // Change page size
      act(() => {
        result.current.setLimit(25);
      });

      expect(result.current.page).toBe(1);
      expect(result.current.totalPages).toBe(4);

      // Go to last page
      act(() => {
        result.current.lastPage();
      });

      expect(result.current.page).toBe(4);
      expect(result.current.canNext).toBe(false);

      // Reset
      act(() => {
        result.current.reset();
      });

      expect(result.current.page).toBe(1);
      expect(result.current.limit).toBe(10);
    });

    it('should handle API response pattern', () => {
      // Simulate typical API response handling
      const { result } = renderHook(
        () => usePagination({ initialLimit: 20 }),
        { wrapper: createWrapper() }
      );

      // Get params for API call
      let params = result.current.getApiParams();
      expect(params).toEqual({ page: 1, limit: 20, offset: 0 });

      // Simulate API response
      act(() => {
        result.current.setTotal(157);
      });

      expect(result.current.totalPages).toBe(8);

      // User navigates to page 4
      act(() => {
        result.current.goToPage(4);
      });

      params = result.current.getApiParams();
      expect(params).toEqual({ page: 4, limit: 20, offset: 60 });

      // User changes page size
      act(() => {
        result.current.setLimit(50);
      });

      params = result.current.getApiParams();
      expect(params).toEqual({ page: 1, limit: 50, offset: 0 });
    });

    it('should handle rapid navigation', () => {
      const { result } = renderHook(
        () => usePagination({ initialTotal: 200, initialLimit: 10 }),
        { wrapper: createWrapper() }
      );

      // Rapid navigation
      act(() => {
        result.current.nextPage();
        result.current.nextPage();
        result.current.nextPage();
        result.current.prevPage();
        result.current.goToPage(10);
        result.current.firstPage();
        result.current.lastPage();
      });

      expect(result.current.page).toBe(20);
    });
  });
});
