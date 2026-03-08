import { useState, useCallback } from 'react';
import { useAuth } from './useAuth';
import type { AttendanceRecord, AttendanceSummary, GraphQLResponse } from '@/types';
import {
  GET_MY_ATTENDANCE_RECORDS,
  GET_MY_ATTENDANCE_SUMMARY,
  GET_TODAYS_ATTENDANCE,
} from '@/graphql/operations';

function useGraphQLQuery<T>(query: string) {
  const { accessToken } = useAuth();

  return useCallback(
    async (variables?: Record<string, unknown>): Promise<T> => {
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
    [accessToken, query],
  );
}

export function useMyAttendanceRecords() {
  const [data, setData] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useGraphQLQuery<{ myAttendanceRecords: AttendanceRecord[] }>(GET_MY_ATTENDANCE_RECORDS);

  const fetch = useCallback(
    async (startDate?: string, endDate?: string, limit = 30) => {
      setLoading(true);
      setError(null);
      try {
        const result = await execute({ startDate, endDate, limit });
        setData(result.myAttendanceRecords);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch attendance');
      } finally {
        setLoading(false);
      }
    },
    [execute],
  );

  return { data, loading, error, fetch };
}

export function useMyAttendanceSummary() {
  const [data, setData] = useState<AttendanceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useGraphQLQuery<{ myAttendanceSummary: AttendanceSummary }>(GET_MY_ATTENDANCE_SUMMARY);

  const fetch = useCallback(
    async (month: number, year: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await execute({ month, year });
        setData(result.myAttendanceSummary);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch summary');
      } finally {
        setLoading(false);
      }
    },
    [execute],
  );

  return { data, loading, error, fetch };
}

export function useTodaysAttendance() {
  const [data, setData] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const execute = useGraphQLQuery<{ todaysAttendance: AttendanceRecord[] }>(GET_TODAYS_ATTENDANCE);

  const fetch = useCallback(
    async (employeeId?: string) => {
      setLoading(true);
      try {
        const result = await execute({ employeeId });
        setData(result.todaysAttendance);
      } catch {
        // silently fail - today's attendance is not critical
      } finally {
        setLoading(false);
      }
    },
    [execute],
  );

  return { data, loading, fetch };
}
