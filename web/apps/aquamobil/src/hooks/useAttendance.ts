import { useState, useCallback } from 'react';
import type { AttendanceRecord, AttendanceSummary } from '@/types';
import { graphqlRequest } from '@/services/authenticated-fetch';
import {
  GET_MY_ATTENDANCE_RECORDS,
  GET_MY_ATTENDANCE_SUMMARY,
  GET_TODAYS_ATTENDANCE,
} from '@/graphql/operations';

export function useMyAttendanceRecords() {
  const [data, setData] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(
    async (startDate?: string, endDate?: string, limit = 30) => {
      setLoading(true);
      setError(null);
      try {
        const result = await graphqlRequest<{ myAttendanceRecords: AttendanceRecord[] }>(
          GET_MY_ATTENDANCE_RECORDS,
          { startDate, endDate, limit },
        );
        setData(result.myAttendanceRecords);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch attendance');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { data, loading, error, fetch };
}

export function useMyAttendanceSummary() {
  const [data, setData] = useState<AttendanceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(
    async (month: number, year: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await graphqlRequest<{ myAttendanceSummary: AttendanceSummary }>(
          GET_MY_ATTENDANCE_SUMMARY,
          { month, year },
        );
        setData(result.myAttendanceSummary);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch summary');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { data, loading, error, fetch };
}

export function useTodaysAttendance() {
  const [data, setData] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(
    async (employeeId?: string) => {
      setLoading(true);
      try {
        const result = await graphqlRequest<{ todaysAttendance: AttendanceRecord[] }>(
          GET_TODAYS_ATTENDANCE,
          { employeeId },
        );
        setData(result.todaysAttendance);
      } catch {
        // silently fail - today's attendance is not critical
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { data, loading, fetch };
}
