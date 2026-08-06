import { clsx } from 'clsx';
import { Clock, AlertCircle, LogIn, LogOut } from 'lucide-react';
import type { JSX } from 'react';
import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import { Button, Card, Chip, EmptyState, ListRow, StatusDot } from '@/components/ui';
import { useMyAttendanceRecords, useMyAttendanceSummary, useTodaysAttendance } from '@/hooks/useAttendance';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { GeoLocation, AttendanceRecord } from '@/types';

/**
 * Attendance status → the badge tone it wears.
 *
 * Eight statuses, four tones: v4 has one alarm colour, one watch colour, one
 * confirm colour and the accent, so a status cannot have a hue of its own. The
 * badge always renders the status TEXT, which is what tells OFFSHORE from
 * WORK_FROM_HOME — the tone only says how much attention it wants.
 */
const STATUS_TONES: Record<string, string> = {
  PRESENT: 'bg-surface-2 text-ok',
  LATE: 'bg-warn-dim text-warn',
  ABSENT: 'bg-crit-dim text-crit',
  ON_LEAVE: 'bg-acc-dim text-acc',
  OFFSHORE: 'bg-acc-dim text-acc',
  EARLY_LEAVE: 'bg-warn-dim text-warn',
  HALF_DAY: 'bg-surface-2 text-ink-2',
  WORK_FROM_HOME: 'bg-surface-2 text-ink-2',
};

function formatTime(isoString?: string): string {
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
  // instead of premature green checkmark with "Recorded!" message. The screen
  // keeps the WATCH tone (amber before v4, `warn` now): the punch is queued on
  // this device, not confirmed by the farm, and those are different facts.
  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-warn-dim">
        <QueuedStatusBadge operationId={queuedOperationId} />
      </div>
    );
  }

  return (
    <div className="pb-32">
      <AppHeader
        title="Attendance"
        onBack={() => navigate(-1)}
        showAvatar={false}
        // The header used to turn green when the worker was clocked in — that
        // was the ONLY on-duty signal besides the button label, so it moves onto
        // a chip rather than being dropped with the gradient.
        actions={
          <Chip tone={isClockedIn ? 'ok' : 'neutral'}>
            <StatusDot tone={isClockedIn ? 'ok' : 'warn'} live={Boolean(isClockedIn)} />
            {isClockedIn ? 'On duty' : 'Off duty'}
          </Chip>
        }
      />

      <div className="px-4 flex flex-col gap-4">
        {/* Clock In/Out */}
        <Card className="p-6 text-center">
          <div className="text-hero font-mono font-bold text-ink-1 tabular-nums mb-2">
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          <p className="text-body text-ink-3 mb-5">
            {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>

          {error && (
            <div className="mb-4 bg-crit-dim rounded-xl p-3 flex items-center gap-2 border border-crit">
              <AlertCircle size={16} className="text-crit flex-shrink-0" />
              <span className="text-crit text-body">{error}</span>
            </div>
          )}

          {!isClockedIn ? (
            <Button
              variant="primary"
              size="save"
              block
              onClick={() => {
                void handleClockIn();
              }}
              disabled={isSubmitting || isGettingLocation}
            >
              {isSubmitting || isGettingLocation ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                  {isGettingLocation ? 'Getting location...' : 'Recording...'}
                </>
              ) : (
                <>
                  <LogIn size={22} />
                  Clock In
                </>
              )}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="save"
              block
              onClick={() => {
                void handleClockOut();
              }}
              disabled={isSubmitting || isGettingLocation}
            >
              {isSubmitting || isGettingLocation ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                  {isGettingLocation ? 'Getting location...' : 'Recording...'}
                </>
              ) : (
                <>
                  <LogOut size={22} />
                  Clock Out
                </>
              )}
            </Button>
          )}

          {!isOnline && (
            <p className="text-center text-warn text-body mt-3 font-medium">
              Offline - will sync when connected
            </p>
          )}

          {location && (
            <p className="text-meta text-ink-3 mt-2 font-mono">
              GPS: {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
              {location.accuracy && ` (±${Math.round(location.accuracy)}m)`}
            </p>
          )}
        </Card>

        {/* Today's Record */}
        {todayRecord && (
          <Card className="p-4">
            <h3 className="text-body font-semibold text-ink-3 mb-3">Today</h3>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-meta text-ink-3">Clock In</p>
                <p className="text-title font-mono font-semibold text-ink-1 tabular-nums">
                  {formatTime(todayRecord.clockIn)}
                </p>
              </div>
              <div>
                <p className="text-meta text-ink-3">Clock Out</p>
                <p className="text-title font-mono font-semibold text-ink-1 tabular-nums">
                  {formatTime(todayRecord.clockOut)}
                </p>
              </div>
              <div>
                <p className="text-meta text-ink-3">Worked</p>
                <p className="text-title font-mono font-semibold text-ink-1 tabular-nums">
                  {todayRecord.workedMinutes > 0 ? formatMinutes(todayRecord.workedMinutes) : '--'}
                </p>
              </div>
            </div>
            {todayRecord.remarks?.startsWith('[Unscheduled]') && (
              <p className="text-meta text-warn mt-2 text-center font-medium">Unscheduled shift</p>
            )}
          </Card>
        )}

        {/* Monthly Summary */}
        {summary && (
          <section className="flex flex-col gap-2">
            <h3 className="text-body font-semibold text-ink-3 px-1">This Month</h3>
            <div className="grid grid-cols-2 gap-2">
              <Card className="p-3">
                <p className="text-meta text-ink-3">Total Worked</p>
                <p className="text-head font-mono font-bold text-ink-1 tabular-nums">
                  {formatMinutes(summary.totalWorkedMinutes)}
                </p>
              </Card>
              <Card className="p-3">
                <p className="text-meta text-ink-3">Overtime</p>
                <p className="text-head font-mono font-bold text-warn tabular-nums">
                  {formatMinutes(summary.totalOvertimeMinutes)}
                </p>
              </Card>
              <Card className="p-3">
                <p className="text-meta text-ink-3">Present Days</p>
                <p className="text-head font-mono font-bold text-ok tabular-nums">
                  {summary.presentDays}/{summary.totalWorkingDays}
                </p>
              </Card>
              <Card className="p-3">
                <p className="text-meta text-ink-3">Attendance</p>
                <p className="text-head font-mono font-bold text-acc tabular-nums">
                  {summary.attendanceRate}%
                </p>
              </Card>
            </div>
          </section>
        )}

        {/* Recent Records */}
        <section className="flex flex-col gap-2">
          <h3 className="text-body font-semibold text-ink-3 px-1">Recent (7 Days)</h3>
          {(recentRecords ?? []).map((record: AttendanceRecord) => (
            <ListRow
              key={record.id}
              title={new Date(record.date).toLocaleDateString([], {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
              subtitle={`${formatTime(record.clockIn)} - ${formatTime(record.clockOut)}${
                record.workedMinutes > 0 ? ` · ${formatMinutes(record.workedMinutes)}` : ''
              }`}
              trailing={
                <span
                  className={clsx(
                    'px-2 py-0.5 rounded-full text-meta font-semibold',
                    STATUS_TONES[record.status] || 'bg-surface-2 text-ink-2',
                  )}
                >
                  {record.status.replace('_', ' ')}
                </span>
              }
            />
          ))}
          {(!recentRecords || recentRecords.length === 0) && (
            <EmptyState icon={<Clock size={22} />} title="No recent records" className="py-6" />
          )}
        </section>
      </div>
    </div>
  );
}
