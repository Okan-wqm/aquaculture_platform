/**
 * useFilters Hook Tests
 *
 * Comprehensive tests for the filter management hook.
 * Tests cover state management, debouncing, URL sync, and edge cases.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useFilters } from '../useFilters';

// Wrapper component for router context
const createWrapper = (initialEntries: string[] = ['/']) => {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(MemoryRouter, { initialEntries }, children);
  return Wrapper;
};

interface TestFilters {
  search: string;
  status: string;
  category: string[];
  minPrice: number;
  isActive: boolean;
}

const defaultFilters: TestFilters = {
  search: '',
  status: 'all',
  category: [],
  minPrice: 0,
  isActive: false,
};

describe('useFilters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ============================================================================
  // Initial State Tests
  // ============================================================================

  describe('Initial State', () => {
    it('should have correct initial values', () => {
      const { result } = renderHook(
        () => useFilters({ initialFilters: defaultFilters }),
        { wrapper: createWrapper() }
      );

      expect(result.current.filters).toEqual(defaultFilters);
      expect(result.current.debouncedFilters).toEqual(defaultFilters);
      expect(result.current.hasActiveFilters).toBe(false);
      expect(result.current.activeFilterCount).toBe(0);
    });

    it('should read initial values from URL when syncUrl=true', () => {
      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: defaultFilters,
            syncUrl: true,
          }),
        { wrapper: createWrapper(['/?status=active&minPrice=100']) }
      );

      expect(result.current.filters.status).toBe('active');
      expect(result.current.filters.minPrice).toBe(100);
    });

    it('should parse JSON values from URL', () => {
      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: defaultFilters,
            syncUrl: true,
          }),
        { wrapper: createWrapper(['/?category=["electronics","books"]']) }
      );

      expect(result.current.filters.category).toEqual(['electronics', 'books']);
    });
  });

  // ============================================================================
  // Filter Setting Tests
  // ============================================================================

  describe('setFilter', () => {
    it('should set a single filter value', () => {
      const { result } = renderHook(
        () => useFilters({ initialFilters: defaultFilters }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilter('status', 'active');
      });

      expect(result.current.filters.status).toBe('active');
    });

    it('should set multiple filter values', () => {
      const { result } = renderHook(
        () => useFilters({ initialFilters: defaultFilters }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilters({
          status: 'active',
          minPrice: 100,
          isActive: true,
        });
      });

      expect(result.current.filters.status).toBe('active');
      expect(result.current.filters.minPrice).toBe(100);
      expect(result.current.filters.isActive).toBe(true);
    });

    it('should handle array filter values', () => {
      const { result } = renderHook(
        () => useFilters({ initialFilters: defaultFilters }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilter('category', ['electronics', 'books', 'toys']);
      });

      expect(result.current.filters.category).toEqual([
        'electronics',
        'books',
        'toys',
      ]);
    });
  });

  // ============================================================================
  // Debounce Tests
  // ============================================================================

  describe('Debouncing', () => {
    it('should debounce filter changes', async () => {
      const onChange = vi.fn();
      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: defaultFilters,
            debounceDelay: 300,
            onChange,
          }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilter('search', 'test');
      });

      // Immediate: filters updated, debouncedFilters not yet
      expect(result.current.filters.search).toBe('test');
      expect(onChange).not.toHaveBeenCalled();

      // Fast-forward debounce
      await act(async () => {
        vi.advanceTimersByTime(350);
      });

      expect(result.current.debouncedFilters.search).toBe('test');
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'test' })
      );
    });

    it('should not debounce non-debounced keys', () => {
      const onChange = vi.fn();
      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: defaultFilters,
            debounceDelay: 300,
            debounceKeys: ['search'],
            onChange,
          }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilter('status', 'active');
      });

      // Non-debounced key should update immediately
      expect(result.current.filters.status).toBe('active');
      expect(result.current.debouncedFilters.status).toBe('active');
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' })
      );
    });

    it('should cancel pending debounce on new value', async () => {
      const onChange = vi.fn();
      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: defaultFilters,
            debounceDelay: 300,
            onChange,
          }),
        { wrapper: createWrapper() }
      );

      // Type quickly
      act(() => {
        result.current.setFilter('search', 't');
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      act(() => {
        result.current.setFilter('search', 'te');
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
      });

      act(() => {
        result.current.setFilter('search', 'test');
      });

      // Only advance past debounce delay once
      await act(async () => {
        vi.advanceTimersByTime(350);
      });

      // Should only call onChange once with final value
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'test' })
      );
    });
  });

  // ============================================================================
  // Reset and Clear Tests
  // ============================================================================

  describe('Reset and Clear', () => {
    it('should reset filters to initial values', () => {
      const onChange = vi.fn();
      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: defaultFilters,
            onChange,
          }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilters({
          search: 'test',
          status: 'active',
          minPrice: 100,
        });
      });

      act(() => {
        result.current.resetFilters();
      });

      expect(result.current.filters).toEqual(defaultFilters);
      expect(result.current.debouncedFilters).toEqual(defaultFilters);
      expect(onChange).toHaveBeenLastCalledWith(defaultFilters);
    });

    it('should clear filters to empty/default values', () => {
      const onChange = vi.fn();
      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: {
              search: 'default search',
              status: 'all',
              category: ['default'],
              minPrice: 50,
              isActive: true,
            },
            onChange,
          }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.clearFilters();
      });

      expect(result.current.filters.search).toBe('');
      expect(result.current.filters.status).toBe('');
      expect(result.current.filters.category).toEqual([]);
      expect(result.current.filters.minPrice).toBe(0);
      expect(result.current.filters.isActive).toBe(false);
    });
  });

  // ============================================================================
  // Active Filter Detection Tests
  // ============================================================================

  describe('Active Filter Detection', () => {
    it('should detect active filters', () => {
      const { result } = renderHook(
        () => useFilters({ initialFilters: defaultFilters }),
        { wrapper: createWrapper() }
      );

      expect(result.current.hasActiveFilters).toBe(false);
      expect(result.current.activeFilterCount).toBe(0);

      act(() => {
        result.current.setFilter('status', 'active');
      });

      expect(result.current.hasActiveFilters).toBe(true);
      expect(result.current.activeFilterCount).toBe(1);

      act(() => {
        result.current.setFilter('minPrice', 100);
      });

      expect(result.current.activeFilterCount).toBe(2);
    });

    it('should not count empty values as active', () => {
      const { result } = renderHook(
        () => useFilters({ initialFilters: defaultFilters }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilter('search', '');
        result.current.setFilter('category', []);
      });

      expect(result.current.hasActiveFilters).toBe(false);
      expect(result.current.activeFilterCount).toBe(0);
    });

    it('should not count unchanged values as active', () => {
      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: { ...defaultFilters, status: 'all' },
          }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilter('status', 'all');
      });

      expect(result.current.hasActiveFilters).toBe(false);
    });
  });

  // ============================================================================
  // getFilter Tests
  // ============================================================================

  describe('getFilter', () => {
    it('should return specific filter value', () => {
      const { result } = renderHook(
        () => useFilters({ initialFilters: defaultFilters }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilter('status', 'pending');
      });

      expect(result.current.getFilter('status')).toBe('pending');
      expect(result.current.getFilter('search')).toBe('');
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle null and undefined values', () => {
      interface NullableFilters {
        name: string | null;
        age: number | null;
      }

      const { result } = renderHook(
        () =>
          useFilters<NullableFilters>({
            initialFilters: { name: null, age: null },
          }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilter('name', 'John');
      });

      expect(result.current.filters.name).toBe('John');
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should handle rapid filter changes', async () => {
      const onChange = vi.fn();
      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: defaultFilters,
            debounceDelay: 100,
            onChange,
          }),
        { wrapper: createWrapper() }
      );

      // Rapid changes
      for (let i = 0; i < 50; i++) {
        act(() => {
          result.current.setFilter('search', `search-${i}`);
        });
      }

      // Advance past debounce
      await act(async () => {
        vi.advanceTimersByTime(150);
      });

      // Should only call onChange with final value
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'search-49' })
      );
    });

    it('should handle complex nested filter values', () => {
      interface ComplexFilters {
        dateRange: { start: string; end: string };
        settings: { notify: boolean; threshold: number };
      }

      const { result } = renderHook(
        () =>
          useFilters<ComplexFilters>({
            initialFilters: {
              dateRange: { start: '', end: '' },
              settings: { notify: false, threshold: 0 },
            },
          }),
        { wrapper: createWrapper() }
      );

      act(() => {
        result.current.setFilter('dateRange', {
          start: '2025-01-01',
          end: '2025-12-31',
        });
      });

      expect(result.current.filters.dateRange).toEqual({
        start: '2025-01-01',
        end: '2025-12-31',
      });
    });
  });

  // ============================================================================
  // E2E Style Integration Tests
  // ============================================================================

  describe('E2E Style Integration', () => {
    it('should handle complete search and filter workflow', async () => {
      const onFilterChange = vi.fn();

      const { result } = renderHook(
        () =>
          useFilters({
            initialFilters: {
              search: '',
              status: 'all',
              sortBy: 'name',
              sortOrder: 'asc' as const,
            },
            debounceDelay: 300,
            debounceKeys: ['search'],
            onChange: onFilterChange,
          }),
        { wrapper: createWrapper() }
      );

      // User types in search
      act(() => {
        result.current.setFilter('search', 'aqua');
      });

      // Search is debounced, other filters are not
      expect(result.current.filters.search).toBe('aqua');
      expect(onFilterChange).not.toHaveBeenCalled();

      // User changes status filter (not debounced)
      act(() => {
        result.current.setFilter('status', 'active');
      });

      expect(onFilterChange).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' })
      );

      // Wait for search debounce
      await act(async () => {
        vi.advanceTimersByTime(350);
      });

      expect(result.current.debouncedFilters.search).toBe('aqua');

      // User clears search
      act(() => {
        result.current.setFilter('search', '');
      });

      await act(async () => {
        vi.advanceTimersByTime(350);
      });

      expect(result.current.debouncedFilters.search).toBe('');

      // Reset all filters
      act(() => {
        result.current.resetFilters();
      });

      expect(result.current.filters.status).toBe('all');
      expect(result.current.hasActiveFilters).toBe(false);
    });

    it('should work with typical data table filtering', async () => {
      interface TableFilters {
        search: string;
        status: string;
        dateFrom: string;
        dateTo: string;
        page: number;
        pageSize: number;
      }

      const { result } = renderHook(
        () =>
          useFilters<TableFilters>({
            initialFilters: {
              search: '',
              status: 'all',
              dateFrom: '',
              dateTo: '',
              page: 1,
              pageSize: 20,
            },
            debounceDelay: 300,
            debounceKeys: ['search'],
          }),
        { wrapper: createWrapper() }
      );

      // Simulate user filtering a data table
      act(() => {
        result.current.setFilters({
          status: 'pending',
          dateFrom: '2025-01-01',
          dateTo: '2025-01-31',
        });
      });

      expect(result.current.activeFilterCount).toBe(3);

      // API params would use debouncedFilters
      const apiFilters = result.current.debouncedFilters;
      expect(apiFilters.status).toBe('pending');
      expect(apiFilters.dateFrom).toBe('2025-01-01');

      // Change page size
      act(() => {
        result.current.setFilter('pageSize', 50);
      });

      // Clear all but keep pagination
      act(() => {
        result.current.setFilters({
          search: '',
          status: 'all',
          dateFrom: '',
          dateTo: '',
        });
      });

      expect(result.current.filters.pageSize).toBe(50);
      expect(result.current.activeFilterCount).toBe(1); // Only pageSize is different from initial
    });
  });
});
