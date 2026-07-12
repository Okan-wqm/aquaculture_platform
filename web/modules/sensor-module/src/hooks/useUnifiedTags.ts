import { useState, useEffect, useCallback, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { graphqlFetch } from '../config/api';
import {
  GET_UNIFIED_TAG,
  GET_UNIFIED_TAGS,
  SEARCH_TAGS,
  CREATE_UNIFIED_TAG,
  UPDATE_UNIFIED_TAG,
  DELETE_UNIFIED_TAG,
  RETIRE_UNIFIED_TAG,
  DISCOVER_TAGS,
  AUTO_BIND_TAGS,
} from '../graphql/unified-tag.queries';

// ============================================================================
// Types
// ============================================================================

export interface UnifiedTag {
  id: string;
  tenantId: string;
  fqn: string;
  localName: string;
  displayName?: string;
  description?: string;
  ioType: string;
  dataType: string;
  direction: string;
  engUnit?: string;
  engMin?: number;
  engMax?: number;
  alarmHH?: number;
  alarmH?: number;
  alarmL?: number;
  alarmLL?: number;
  deadband?: number;
  source: Record<string, unknown>;
  hierarchy: Record<string, unknown>;
  /** Lifecycle: 'draft' | 'active' | 'retired'. Retired tags never resolve. */
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface UnifiedTagListResult {
  items: UnifiedTag[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface TagFilterInput {
  searchTerm?: string;
  ioType?: string;
  dataType?: string;
  direction?: string;
  equipmentId?: string;
  edgeDeviceId?: string;
}

export interface TagDiscoveryResult {
  success: boolean;
  message?: string;
  discoveredCount: number;
  createdCount: number;
  tags: UnifiedTag[];
}

export interface CreateTagInput {
  fqn: string;
  localName: string;
  displayName?: string;
  description?: string;
  ioType: string;
  dataType: string;
  direction?: string;
  engUnit?: string;
  engMin?: number;
  engMax?: number;
  alarmHH?: number;
  alarmH?: number;
  alarmL?: number;
  alarmLL?: number;
  deadband?: number;
  source?: Record<string, unknown>;
  hierarchy?: Record<string, unknown>;
}

export interface UpdateTagInput {
  id: string;
  fqn?: string;
  localName?: string;
  displayName?: string;
  description?: string;
  ioType?: string;
  dataType?: string;
  direction?: string;
  engUnit?: string;
  engMin?: number;
  engMax?: number;
  alarmHH?: number;
  alarmH?: number;
  alarmL?: number;
  alarmLL?: number;
  deadband?: number;
  source?: Record<string, unknown>;
  hierarchy?: Record<string, unknown>;
}

// ============================================================================
// Query Hooks
// ============================================================================

/** Fetch a single unified tag by ID */
export function useUnifiedTag(id: string | undefined) {
  const [tag, setTag] = useState<UnifiedTag | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTag = useCallback(async () => {
    if (!id) {
      setTag(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ unifiedTag: UnifiedTag | null }>(
        GET_UNIFIED_TAG,
        { id },
      );
      setTag(result.unifiedTag);
    } catch (err) {
      setError((err as Error).message);
      setTag(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchTag();
  }, [fetchTag]);

  const refetch = useCallback(() => {
    fetchTag();
  }, [fetchTag]);

  return { tag, loading, error, refetch };
}

/** Fetch a paginated list of unified tags with optional filter */
export function useUnifiedTags(
  filter?: TagFilterInput,
  pagination?: { page?: number; limit?: number },
) {
  const [tags, setTags] = useState<UnifiedTag[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<(ReturnType<typeof setTimeout>) | undefined>(undefined);

  const filterSearchTerm = filter?.searchTerm;
  const filterIoType = filter?.ioType;
  const filterDataType = filter?.dataType;
  const filterDirection = filter?.direction;
  const filterEquipmentId = filter?.equipmentId;
  const filterEdgeDeviceId = filter?.edgeDeviceId;
  const paginationPage = pagination?.page;
  const paginationLimit = pagination?.limit;

  const fetchTags = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ unifiedTags: UnifiedTagListResult }>(
        GET_UNIFIED_TAGS,
        {
          filter: {
            searchTerm: filterSearchTerm,
            ioType: filterIoType,
            dataType: filterDataType,
            direction: filterDirection,
            equipmentId: filterEquipmentId,
            edgeDeviceId: filterEdgeDeviceId,
          },
          pagination: {
            page: paginationPage,
            limit: paginationLimit,
          },
        },
      );
      setTags(result.unifiedTags.items);
      setTotal(result.unifiedTags.total);
    } catch (err) {
      console.error('Failed to fetch unified tags:', err);
      setError((err as Error).message);
      setTags([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [filterSearchTerm, filterIoType, filterDataType, filterDirection, filterEquipmentId, filterEdgeDeviceId, paginationPage, paginationLimit]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(fetchTags, filterSearchTerm ? 300 : 0);
    return () => clearTimeout(debounceRef.current);
  }, [fetchTags, filterSearchTerm]);

  const refetch = useCallback(() => {
    fetchTags();
  }, [fetchTags]);

  return { tags, total, loading, error, refetch };
}

/** Search tags by query string */
export function useSearchTags(query: string, limit?: number) {
  const [tags, setTags] = useState<UnifiedTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<(ReturnType<typeof setTimeout>) | undefined>(undefined);

  const fetchTags = useCallback(async () => {
    if (!query.trim()) {
      setTags([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ searchTags: UnifiedTag[] }>(
        SEARCH_TAGS,
        { query, limit },
      );
      setTags(result.searchTags);
    } catch (err) {
      console.error('Failed to search tags:', err);
      setError((err as Error).message);
      setTags([]);
    } finally {
      setLoading(false);
    }
  }, [query, limit]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(fetchTags, 300);
    return () => clearTimeout(debounceRef.current);
  }, [fetchTags]);

  const refetch = useCallback(() => {
    fetchTags();
  }, [fetchTags]);

  return { tags, loading, error, refetch };
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/** Create a new unified tag */
export function useCreateTag() {
  return useMutation({
    mutationFn: async (input: CreateTagInput) => {
      const data = await graphqlFetch<{ createUnifiedTag: UnifiedTag }>(
        CREATE_UNIFIED_TAG,
        { input },
      );
      return data.createUnifiedTag;
    },
  });
}

/** Update an existing unified tag */
export function useUpdateTag() {
  return useMutation({
    mutationFn: async (input: UpdateTagInput) => {
      const data = await graphqlFetch<{ updateUnifiedTag: UnifiedTag }>(
        UPDATE_UNIFIED_TAG,
        { input },
      );
      return data.updateUnifiedTag;
    },
  });
}

/** Retire a unified tag (terminal lifecycle state; the removal path for non-DRAFT tags) */
export function useRetireTag() {
  return useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ retireUnifiedTag: UnifiedTag }>(
        RETIRE_UNIFIED_TAG,
        { id },
      );
      return data.retireUnifiedTag;
    },
  });
}

/** Delete a unified tag by ID (server allows this only while status=DRAFT) */
export function useDeleteTag() {
  return useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{ deleteUnifiedTag: boolean }>(
        DELETE_UNIFIED_TAG,
        { id },
      );
      return data.deleteUnifiedTag;
    },
  });
}

/** Discover tags from an edge device */
export function useDiscoverTags() {
  return useMutation({
    mutationFn: async (deviceId: string) => {
      const data = await graphqlFetch<{ discoverTags: TagDiscoveryResult }>(
        DISCOVER_TAGS,
        { deviceId },
      );
      return data.discoverTags;
    },
  });
}

/** Auto-bind discovered tags to a process */
export function useAutoBindTags() {
  return useMutation({
    mutationFn: async ({ processId, deviceId }: { processId: string; deviceId: string }) => {
      const data = await graphqlFetch<{ autoBindTags: TagDiscoveryResult }>(
        AUTO_BIND_TAGS,
        { processId, deviceId },
      );
      return data.autoBindTags;
    },
  });
}
