import { useState, useCallback } from 'react';
import type { LeaveRequest, LeaveBalance, LeaveType } from '@/types';
import { graphqlRequest } from '@/services/authenticated-fetch';
import {
  GET_MY_LEAVE_REQUESTS,
  GET_MY_LEAVE_BALANCES,
  GET_LEAVE_TYPES,
  SUBMIT_LEAVE_REQUEST,
  CANCEL_LEAVE_REQUEST,
} from '@/graphql/operations';

export function useMyLeaveBalances() {
  const [data, setData] = useState<LeaveBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(
    async (year: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await graphqlRequest<{ myLeaveBalances: LeaveBalance[] }>(GET_MY_LEAVE_BALANCES, { year });
        setData(result.myLeaveBalances);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch leave balances');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { data, loading, error, fetch };
}

export function useMyLeaveRequests() {
  const [data, setData] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(
    async (status?: string, limit = 20) => {
      setLoading(true);
      setError(null);
      try {
        const result = await graphqlRequest<{ myLeaveRequests: LeaveRequest[] }>(GET_MY_LEAVE_REQUESTS, { status, limit });
        setData(result.myLeaveRequests);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch leave requests');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { data, loading, error, fetch };
}

export function useLeaveTypes() {
  const [data, setData] = useState<LeaveType[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const result = await graphqlRequest<{ leaveTypes: LeaveType[] }>(GET_LEAVE_TYPES);
      setData(result.leaveTypes);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, fetch };
}

export function useSubmitLeaveRequest() {
  const [loading, setLoading] = useState(false);

  const submit = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        await graphqlRequest(SUBMIT_LEAVE_REQUEST, { id });
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { submit, loading };
}

export function useCancelLeaveRequest() {
  const [loading, setLoading] = useState(false);

  const cancel = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        await graphqlRequest(CANCEL_LEAVE_REQUEST, { id });
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { cancel, loading };
}
