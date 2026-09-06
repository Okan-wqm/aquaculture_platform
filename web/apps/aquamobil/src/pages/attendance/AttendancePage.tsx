import { clsx } from 'clsx';
import { ArrowLeft, MapPin, Clock, AlertCircle, LogIn, LogOut } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import { useMyAttendanceRecords, useMyAttendanceSummary, useTodaysAttendance } from '@/hooks/useAttendance';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { GeoLocation, AttendanceRecord } from '@/types';


const STATUS_COLORS: Record<string, string> = {
  PRESENT: 'bg-green-100 text-green-700',
  LATE: 'bg-amber-100 text-amber-700',
  ABSENT: 'bg-red-100 text-red-700',
  ON_LEAVE: 'bg-blue-100 text-blue-700',
  OFFSHORE: 'bg-cyan-100 text-cyan-700',
  EARLY_LEAVE: 'bg-orange-100 text-orange-700',
  HALF_DAY: 'bg-purple-100 text-purple-700',
  WORK_FROM_HOME: 'bg-indigo-100 text-indigo-700',
};

function formatTime(isoString: string | null | undefined): string {
  if (!isoString) return '--:--';
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function AttendancePage(): JSX.Element {
  const navigate = useNavigate();
  const { addToQueue, isOnline } = useOfflineQueue();

  // WHY React Query hooks accept params directly instead of imperative fetch():
  // React Query auto-fetches when params change, deduplicates identical requests,
  // and serves stale data instantly while revalidating in the background.
  const { data: todayRecords, refetch: refetchToday } = useTodaysAttendance();
  const { data: recentRecords } = useMyAttendanceRecords({
    startDate: new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    limit: 7,
  });
  const { data: summary } = useMyAttendanceSummary();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  // C7: Track the operationId for two-phase success UX
  const [queuedOperationId, setQueuedOperationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<GeoLocation | null>(null);
  const [isGettingLocation, setIsGettingLocation] = useState(false);

  const todayRecord = todayRecords?.find((r) => r.clockIn || r.clockOut);
  const isClockedIn = todayRecord?.clockIn && !todayRecord?.clockOut;

  const getLocation = useCallback(async (): Promise<GeoLocation | null> => {
    if (!navigator.geolocation) return null;
    setIsGettingLocation(true);

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const loc: GeoLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          };
          setLocation(loc);
          setIsGettingLocation(false);
          resolve(loc);
        },
        () => {
          setIsGettingLocation(false);
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      );
    });
  }, []);

  const handleClockIn = async (): Promise<void> => {
    setIsSubmitting(true);
    setError(null);
    try {
      const loc = await getLocation();
      // FE-HIGH-050: addToQueue returns a discriminated result; .id tracks the
      // queued (or, on dedup, existing) op for QueuedStatusBadge.
      const { id: opId } = await addToQueue('clockIn', {
        method: 'MOBILE' as const,
        location: loc || undefined,
      });
      // C7: Store operationId for QueuedStatusBadge tracking
      setQueuedOperationId(opId);
      setShowSuccess(true);
      setTimeout(() => {
        setShowSuccess(false);
        void refetchToday();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clock in');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClockOut = async (): Promise<void> => {
    setIsSubmitting(true);
    setError(null);
    try {
      const loc = await getLocation();
      const { id: opId } = await addToQueue('clockOut', {
        method: 'MOBILE' as const,
        location: loc || undefined,
      });
      // C7: Store operationId for QueuedStatusBadge tracking
      setQueuedOperationId(opId);
      setShowSuccess(true);
      setTimeout(() => {
        setShowSuccess(false);
        void refetchToday();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clock out');
    } finally {
      setIsSubmitting(false);
    }
  };

  // C7: Two-phase success UX -- show honest sync status via QueuedStatusBadge
  // instead of premature green checkmark with "Recorded!" message.
  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-amber-50 dark:bg-amber-900/10">
        <QueuedStatusBadge operationId={queuedOperationId} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 pb-24">
      {/* Header */}
      <div className={clsx(
        'text-white',
        isClockedIn
          ? 'bg-gradient-to-r from-green-600 to-green-500'
          : 'bg-gradient-to-r from-ocean-600 to-ocean-500',
      )}>
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <MapPin size={22} />
            <h1 className="text-lg font-bold">Attendance</h1>
          </div>
        </div>
      </div>

      {/* Clock In/Out Button */}
      <div className="px-4 mt-5">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-6 border border-gray-100 dark:border-gray-800 text-center">
          <div className="text-4xl font-bold text-gray-900 dark:text-white tabular-nums mb-2">
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          <p className="text-sm text-gray-500 mb-5">
            {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>

          {error && (
            <div className="mb-4 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center gap-2 border border-red-200 dark:border-red-800">
              <AlertCircle size={16} className="text-red-500 flex-shrink-0" />
              <span className="text-red-600 dark:text-red-300 text-sm">{error}</span>
            </div>
          )}

          {!isClockedIn ? (
            <button
              onClick={() => { void handleClockIn(); }}
              disabled={isSubmitting || isGettingLocation}
              className="w-full py-4 bg-gradient-to-r from-green-600 to-green-500 text-white font-bold rounded-2xl shadow-lg shadow-green-500/25 disabled:opacity-50 touch-feedback transition-all flex items-center justify-center gap-3"
            >
              {isSubmitting || isGettingLocation ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                  {isGettingLocation ? 'Getting location...' : 'Recording...'}
                </>
              ) : (
                <>
                  <LogIn size={22} />
                  Clock In
                </>
              )}
            </button>
          ) : (
            <button
              onClick={() => { void handleClockOut(); }}
              disabled={isSubmitting || isGettingLocation}
              className="w-full py-4 bg-gradient-to-r from-red-600 to-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-500/25 disabled:opacity-50 touch-feedback transition-all flex items-center justify-center gap-3"
            >
              {isSubmitting || isGettingLocation ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                  {isGettingLocation ? 'Getting location...' : 'Recording...'}
                </>
              ) : (
                <>
                  <LogOut size={22} />
                  Clock Out
                </>
              )}
            </button>
          )}

          {!isOnline && (
            <p className="text-center text-amber-500 text-sm mt-3 font-medium">
              Offline - will sync when connected
            </p>
          )}

          {location && (
            <p className="text-xs text-gray-400 mt-2">
              GPS: {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
              {location.accuracy && ` (±${Math.round(location.accuracy)}m)`}
            </p>
          )}
        </div>
      </div>

      {/* Today's Record */}
      {todayRecord && (
        <div className="px-4 mt-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Today</h3>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-xs text-gray-400">Clock In</p>
                <p className="font-semibold text-gray-900 dark:text-white">{formatTime(todayRecord.clockIn)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Clock Out</p>
                <p className="font-semibold text-gray-900 dark:text-white">{formatTime(todayRecord.clockOut)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Worked</p>
                <p className="font-semibold text-gray-900 dark:text-white">
                  {todayRecord.workedMinutes > 0 ? formatMinutes(todayRecord.workedMinutes) : '--'}
                </p>
              </div>
            </div>
            {todayRecord.remarks?.startsWith('[Unscheduled]') && (
              <p className="text-xs text-amber-500 mt-2 text-center font-medium">Unscheduled shift</p>
            )}
          </div>
        </div>
      )}

      {/* Monthly Summary */}
      {summary && (
        <div className="px-4 mt-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">This Month</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white dark:bg-gray-900 rounded-xl p-3 border border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-400">Total Worked</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{formatMinutes(summary.totalWorkedMinutes)}</p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-xl p-3 border border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-400">Overtime</p>
              <p className="text-lg font-bold text-orange-600">{formatMinutes(summary.totalOvertimeMinutes)}</p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-xl p-3 border border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-400">Present Days</p>
              <p className="text-lg font-bold text-green-600">{summary.presentDays}/{summary.totalWorkingDays}</p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-xl p-3 border border-gray-100 dark:border-gray-800">
              <p className="text-xs text-gray-400">Attendance</p>
              <p className="text-lg font-bold text-ocean-600">{summary.attendanceRate}%</p>
            </div>
          </div>
        </div>
      )}

      {/* Recent Records */}
      <div className="px-4 mt-5">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Recent (7 Days)</h3>
        <div className="space-y-2">
          {(recentRecords ?? []).map((record: AttendanceRecord) => (
            <div
              key={record.id}
              className="bg-white dark:bg-gray-900 rounded-xl p-3 border border-gray-100 dark:border-gray-800 flex items-center justify-between"
            >
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  {new Date(record.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                </p>
                <p className="text-xs text-gray-400">
                  {formatTime(record.clockIn)} - {formatTime(record.clockOut)}
                  {record.workedMinutes > 0 && ` · ${formatMinutes(record.workedMinutes)}`}
                </p>
              </div>
              <span className={clsx('px-2 py-0.5 rounded-full text-xs font-semibold', STATUS_COLORS[record.status] || 'bg-gray-100 text-gray-600')}>
                {record.status.replace('_', ' ')}
              </span>
            </div>
          ))}
          {(!recentRecords || recentRecords.length === 0) && (
            <div className="text-center py-6 text-gray-400">
              <Clock size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">No recent records</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
