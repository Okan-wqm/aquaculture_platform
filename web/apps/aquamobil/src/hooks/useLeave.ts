import { useState, useCallback } from 'react';
import { useAuth } from './useAuth';
import type { LeaveRequest, LeaveBalance, LeaveType, GraphQLResponse } from '@/types';
import {
  GET_MY_LEAVE_REQUESTS,
  GET_MY_LEAVE_BALANCES,
  GET_LEAVE_TYPES,
  SUBMIT_LEAVE_REQUEST,
  CANCEL_LEAVE_REQUEST,
} from '@/graphql/operations';

function useGraphQLFetch() {
  const { accessToken } = useAuth();

  return useCallback(
    async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

      const result: GraphQLResponse<T> = await response.json();
      if (result.errors?.length) throw new Error(result.errors[0]?.message || 'GraphQL error');
      if (!result.data) throw new Error('No data returned');

      return result.data;
    },
    [accessToken],
  );
}

export function useMyLeaveBalances() {
  const [data, setData] = useState<LeaveBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gqlFetch = useGraphQLFetch();

  const fetch = useCallback(
    async (year: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await gqlFetch<{ myLeaveBalances: LeaveBalance[] }>(GET_MY_LEAVE_BALANCES, { year });
        setData(result.myLeaveBalances);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch leave balances');
      } finally {
        setLoading(false);
      }
    },
    [gqlFetch],
  );

  return { data, loading, error, fetch };
}

export function useMyLeaveRequests() {
  const [data, setData] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gqlFetch = useGraphQLFetch();

  const fetch = useCallback(
    async (status?: string, limit = 20) => {
      setLoading(true);
      setError(null);
      try {
        const result = await gqlFetch<{ myLeaveRequests: LeaveRequest[] }>(GET_MY_LEAVE_REQUESTS, { status, limit });
        setData(result.myLeaveRequests);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch leave requests');
      } finally {
        setLoading(false);
      }
    },
    [gqlFetch],
  );

  return { data, loading, error, fetch };
}

export function useLeaveTypes() {
  const [data, setData] = useState<LeaveType[]>([]);
  const [loading, setLoading] = useState(false);
  const gqlFetch = useGraphQLFetch();

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const result = await gqlFetch<{ leaveTypes: LeaveType[] }>(GET_LEAVE_TYPES);
      setData(result.leaveTypes);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [gqlFetch]);

  return { data, loading, fetch };
}

export function useSubmitLeaveRequest() {
  const [loading, setLoading] = useState(false);
  const gqlFetch = useGraphQLFetch();

  const submit = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        await gqlFetch(SUBMIT_LEAVE_REQUEST, { id });
      } finally {
        setLoading(false);
      }
    },
    [gqlFetch],
  );

  return { submit, loading };
}

export function useCancelLeaveRequest() {
  const [loading, setLoading] = useState(false);
  const gqlFetch = useGraphQLFetch();

  const cancel = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        await gqlFetch(CANCEL_LEAVE_REQUEST, { id });
      } finally {
        setLoading(false);
      }
    },
    [gqlFetch],
  );

  return { cancel, loading };
}
