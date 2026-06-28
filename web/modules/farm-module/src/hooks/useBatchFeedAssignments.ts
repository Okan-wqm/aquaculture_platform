/**
 * BatchFeedAssignment hooks
 *
 * Phase 3 Tier 1 + Tier 2 of the "Farm modülü kalan kör noktalar"
 * plan. Expose the `assignFeedsToBatch`, `updateBatchFeedAssignment`,
 * and `deleteBatchFeedAssignment` mutations so the batch detail
 * page gets a first-class "Feed Assignment" tab.
 *
 * A batch feed assignment is a one-to-many mapping of
 * (fish weight range → feed product). The backend enforces that the
 * ranges partition the growth curve (no gaps, no overlaps unless
 * priority disambiguates).
 */
import {
  useAuth,
  graphqlClient,
  createTenantQueryKey, createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface FeedAssignmentEntry {
  feedId: string;
  feedCode: string;
  feedName: string;
  minWeightG: number;
  maxWeightG: number;
  priority?: number;
}

export interface BatchFeedAssignment {
  id: string;
  batchId: string;
  feedAssignments: FeedAssignmentEntry[];
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssignFeedsToBatchInput {
  batchId: string;
  feedAssignments: FeedAssignmentEntry[];
  notes?: string;
}

export interface UpdateBatchFeedAssignmentInput {
  id: string;
  feedAssignments?: FeedAssignmentEntry[];
  notes?: string;
  isActive?: boolean;
}

const GET_BATCH_FEED_ASSIGNMENT_QUERY = `
  query GetBatchFeedAssignment($batchId: ID!) {
    batchFeedAssignment(batchId: $batchId) {
      id
      batchId
      feedAssignments {
        feedId
        feedCode
        feedName
        minWeightG
        maxWeightG
        priority
      }
      notes
      isActive
      createdAt
      updatedAt
    }
  }
`;

const ASSIGN_FEEDS_TO_BATCH_MUTATION = `
  mutation AssignFeedsToBatch($input: AssignFeedsToBatchInput!) {
    assignFeedsToBatch(input: $input) {
      id
      batchId
      feedAssignments {
        feedId
        feedCode
        feedName
        minWeightG
        maxWeightG
        priority
      }
    }
  }
`;

const UPDATE_BATCH_FEED_ASSIGNMENT_MUTATION = `
  mutation UpdateBatchFeedAssignment($input: UpdateBatchFeedAssignmentInput!) {
    updateBatchFeedAssignment(input: $input) {
      id
      batchId
      feedAssignments {
        feedId
        feedCode
        feedName
        minWeightG
        maxWeightG
        priority
      }
      isActive
    }
  }
`;

const DELETE_BATCH_FEED_ASSIGNMENT_MUTATION = `
  mutation DeleteBatchFeedAssignment($id: ID!) {
    deleteBatchFeedAssignment(id: $id)
  }
`;

export function useBatchFeedAssignment(batchId: string | undefined) {
  const { tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(
      tenantId,
      'batchFeedAssignments',
      batchId ?? 'none',
    ),
    queryFn: async () => {
      if (!batchId) return null;
      const data = await graphqlClient.request<{
        batchFeedAssignment: BatchFeedAssignment | null;
      }>(GET_BATCH_FEED_ASSIGNMENT_QUERY, { batchId });
      return data.batchFeedAssignment;
    },
    enabled: !!tenantId && !!batchId,
  });
}

export function useAssignFeedsToBatch() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AssignFeedsToBatchInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{
        assignFeedsToBatch: BatchFeedAssignment;
      }>(ASSIGN_FEEDS_TO_BATCH_MUTATION, { input });
      return data.assignFeedsToBatch;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(
          tenantId,
          'batchFeedAssignments',
          variables.batchId,
        ),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'batches'),
      });
    },
  });
}

export function useUpdateBatchFeedAssignment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateBatchFeedAssignmentInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{
        updateBatchFeedAssignment: BatchFeedAssignment;
      }>(UPDATE_BATCH_FEED_ASSIGNMENT_MUTATION, { input });
      return data.updateBatchFeedAssignment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'batchFeedAssignments'),
      });
    },
  });
}

export function useDeleteBatchFeedAssignment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{
        deleteBatchFeedAssignment: boolean;
      }>(DELETE_BATCH_FEED_ASSIGNMENT_MUTATION, { id });
      return data.deleteBatchFeedAssignment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, 'batchFeedAssignments'),
      });
    },
  });
}
