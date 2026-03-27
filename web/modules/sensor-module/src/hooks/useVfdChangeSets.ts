import { useState, useCallback } from 'react';
import {
  VfdChangeSet,
  VfdChangeSetStatus,
  CreateChangeSetInput,
} from '../types/vfd.types';
import { graphqlFetch } from '../config/api';
import {
  VFD_CHANGE_SETS_QUERY,
  VFD_CHANGE_SET_QUERY,
  CREATE_VFD_CHANGE_SET_MUTATION,
  APPROVE_VFD_CHANGE_SET_MUTATION,
  REJECT_VFD_CHANGE_SET_MUTATION,
  ROLLBACK_VFD_CHANGE_SET_MUTATION,
  SUBMIT_VFD_CHANGE_SET_MUTATION,
  CANCEL_VFD_CHANGE_SET_MUTATION,
} from '../graphql/vfd-programming.operations';

const DEFAULT_LIMIT = 20;

interface Pagination {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

interface UseVfdChangeSetsReturn {
  changeSets: VfdChangeSet[];
  selectedChangeSet: VfdChangeSet | null;
  loading: boolean;
  error: string | null;
  pagination: Pagination;
  fetchChangeSets: (vfdDeviceId: string, status?: VfdChangeSetStatus) => Promise<void>;
  fetchChangeSet: (id: string) => Promise<VfdChangeSet>;
  loadMore: () => Promise<void>;
  createChangeSet: (input: CreateChangeSetInput) => Promise<VfdChangeSet>;
  submitForApproval: (changeSetId: string) => Promise<VfdChangeSet>;
  approveChangeSet: (changeSetId: string) => Promise<VfdChangeSet>;
  rejectChangeSet: (changeSetId: string, reason: string) => Promise<VfdChangeSet>;
  applyChangeSet: (changeSetId: string) => Promise<VfdChangeSet>;
  rollbackChangeSet: (changeSetId: string, reason: string) => Promise<VfdChangeSet>;
  cancelChangeSet: (changeSetId: string) => Promise<VfdChangeSet>;
  getPendingCount: () => number;
  getByStatus: (status: VfdChangeSetStatus) => VfdChangeSet[];
}

/**
 * Hook for VFD change set CRUD with Maker-Checker workflow.
 * Full pagination, optimistic updates, and status filtering.
 */
export function useVfdChangeSets(): UseVfdChangeSetsReturn {
  const [changeSets, setChangeSets] = useState<VfdChangeSet[]>([]);
  const [selectedChangeSet, setSelectedChangeSet] = useState<VfdChangeSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDeviceId, setLastDeviceId] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<VfdChangeSetStatus | undefined>(undefined);
  const [pagination, setPagination] = useState<Pagination>({
    total: 0,
    offset: 0,
    limit: DEFAULT_LIMIT,
    hasMore: false,
  });

  const fetchChangeSets = useCallback(
    async (vfdDeviceId: string, status?: VfdChangeSetStatus) => {
      setLoading(true);
      setError(null);
      setLastDeviceId(vfdDeviceId);
      setLastStatus(status);

      try {
        const variables: Record<string, unknown> = {
          vfdDeviceId,
          limit: DEFAULT_LIMIT,
          offset: 0,
        };
        if (status) {
          variables.status = status;
        }

        const data = await graphqlFetch<{
          vfdChangeSets: VfdChangeSet[];
        }>(VFD_CHANGE_SETS_QUERY, variables);

        const sorted = [...data.vfdChangeSets].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

        setChangeSets(sorted);
        setPagination({
          total: sorted.length,
          offset: 0,
          limit: DEFAULT_LIMIT,
          hasMore: sorted.length === DEFAULT_LIMIT,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch change sets';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadMore = useCallback(async () => {
    if (!lastDeviceId || loading) return;

    setLoading(true);
    setError(null);
    const newOffset = pagination.offset + pagination.limit;

    try {
      const variables: Record<string, unknown> = {
        vfdDeviceId: lastDeviceId,
        limit: DEFAULT_LIMIT,
        offset: newOffset,
      };
      if (lastStatus) {
        variables.status = lastStatus;
      }

      const data = await graphqlFetch<{
        vfdChangeSets: VfdChangeSet[];
      }>(VFD_CHANGE_SETS_QUERY, variables);

      const sorted = [...data.vfdChangeSets].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      setChangeSets((prev) => [...prev, ...sorted]);
      setPagination({
        total: pagination.total + sorted.length,
        offset: newOffset,
        limit: DEFAULT_LIMIT,
        hasMore: sorted.length === DEFAULT_LIMIT,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load more change sets';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [lastDeviceId, lastStatus, loading, pagination]);

  const fetchChangeSet = useCallback(async (id: string): Promise<VfdChangeSet> => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{
        vfdChangeSet: VfdChangeSet;
      }>(VFD_CHANGE_SET_QUERY, { id });

      setSelectedChangeSet(data.vfdChangeSet);
      return data.vfdChangeSet;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch change set';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAfterMutation = useCallback(
    (updatedChangeSet: VfdChangeSet) => {
      setChangeSets((prev) => {
        const idx = prev.findIndex((cs) => cs.id === updatedChangeSet.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = updatedChangeSet;
          return next;
        }
        return [updatedChangeSet, ...prev];
      });
      setSelectedChangeSet(updatedChangeSet);
    },
    [],
  );

  const createChangeSet = useCallback(
    async (input: CreateChangeSetInput): Promise<VfdChangeSet> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          createVfdChangeSet: VfdChangeSet;
        }>(CREATE_VFD_CHANGE_SET_MUTATION, { input });

        const created = data.createVfdChangeSet;
        setChangeSets((prev) => [created, ...prev]);
        setSelectedChangeSet(created);
        return created;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create change set';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const submitForApproval = useCallback(
    async (changeSetId: string): Promise<VfdChangeSet> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          submitVfdChangeSetForApproval: VfdChangeSet;
        }>(SUBMIT_VFD_CHANGE_SET_MUTATION, { changeSetId });

        const updated = data.submitVfdChangeSetForApproval;
        refreshAfterMutation(updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to submit for approval';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [refreshAfterMutation],
  );

  const approveChangeSet = useCallback(
    async (changeSetId: string): Promise<VfdChangeSet> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          approveVfdChangeSet: VfdChangeSet;
        }>(APPROVE_VFD_CHANGE_SET_MUTATION, { changeSetId });

        const updated = data.approveVfdChangeSet;
        refreshAfterMutation(updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to approve change set';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [refreshAfterMutation],
  );

  const rejectChangeSet = useCallback(
    async (changeSetId: string, reason: string): Promise<VfdChangeSet> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          rejectVfdChangeSet: VfdChangeSet;
        }>(REJECT_VFD_CHANGE_SET_MUTATION, { input: { changeSetId, reason } });

        const updated = data.rejectVfdChangeSet;
        refreshAfterMutation(updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to reject change set';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [refreshAfterMutation],
  );

  const applyChangeSet = useCallback(
    async (changeSetId: string): Promise<VfdChangeSet> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          approveVfdChangeSet: VfdChangeSet;
        }>(APPROVE_VFD_CHANGE_SET_MUTATION, { changeSetId });

        const updated = data.approveVfdChangeSet;
        refreshAfterMutation(updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to apply change set';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [refreshAfterMutation],
  );

  const rollbackChangeSet = useCallback(
    async (changeSetId: string, reason: string): Promise<VfdChangeSet> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          rollbackVfdChangeSet: VfdChangeSet;
        }>(ROLLBACK_VFD_CHANGE_SET_MUTATION, { input: { changeSetId, reason } });

        const updated = data.rollbackVfdChangeSet;
        refreshAfterMutation(updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to rollback change set';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [refreshAfterMutation],
  );

  const cancelChangeSet = useCallback(
    async (changeSetId: string): Promise<VfdChangeSet> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          cancelVfdChangeSet: VfdChangeSet;
        }>(CANCEL_VFD_CHANGE_SET_MUTATION, { changeSetId });

        const updated = data.cancelVfdChangeSet;
        refreshAfterMutation(updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to cancel change set';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [refreshAfterMutation],
  );

  const getPendingCount = useCallback(() => {
    return changeSets.filter(
      (cs) => cs.status === VfdChangeSetStatus.PENDING_APPROVAL,
    ).length;
  }, [changeSets]);

  const getByStatus = useCallback(
    (status: VfdChangeSetStatus) => {
      return changeSets.filter((cs) => cs.status === status);
    },
    [changeSets],
  );

  return {
    changeSets,
    selectedChangeSet,
    loading,
    error,
    pagination,
    fetchChangeSets,
    fetchChangeSet,
    loadMore,
    createChangeSet,
    submitForApproval,
    approveChangeSet,
    rejectChangeSet,
    applyChangeSet,
    rollbackChangeSet,
    cancelChangeSet,
    getPendingCount,
    getByStatus,
  };
}
