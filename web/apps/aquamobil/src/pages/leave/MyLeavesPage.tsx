import { clsx } from 'clsx';
import { CalendarOff, Plus, Clock } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Button, Card, EmptyState, IconButton, SegmentedControl, Skeleton } from '@/components/ui';
import { useMyLeaveBalances, useMyLeaveRequests, useCancelLeaveRequest } from '@/hooks/useLeave';
import type { LeaveBalance, LeaveRequest } from '@/types';

/**
 * Request status → badge tone. DRAFT and CANCELLED share the neutral treatment
 * because neither is asking anything of the worker; the badge text is what
 * separates them.
 */
const STATUS_TONES: Record<string, string> = {
  DRAFT: 'bg-surface-2 text-ink-2',
  PENDING: 'bg-warn-dim text-warn',
  APPROVED: 'bg-surface-2 text-ok',
  REJECTED: 'bg-crit-dim text-crit',
  CANCELLED: 'bg-surface-2 text-ink-3',
};

type Tab = 'balances' | 'requests';

const TABS = [
  { value: 'balances' as const, label: 'Balances' },
  { value: 'requests' as const, label: 'Requests' },
];

export function MyLeavesPage(): JSX.Element {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('balances');

  // WHY refetchOnMount 'always': when the user navigates back from
  // LeaveRequestPage after submitting, React Query would otherwise serve
  // stale cached data for up to staleTime (2-5 min). Forcing a refetch on
  // every mount ensures the readback converges immediately post-submit.
  const currentYear = new Date().getFullYear();
  const { data: balances = [], isLoading: balancesLoading } = useMyLeaveBalances(currentYear, {
    refetchOnMount: 'always',
  });
  const { data: requests = [], isLoading: requestsLoading } = useMyLeaveRequests(undefined, 30, {
    refetchOnMount: 'always',
  });
  const { cancel, loading: cancelling } = useCancelLeaveRequest();

  // WHY: no manual invalidateQueries here — useCancelLeaveRequest now
  // invalidates leaveRequests and leaveBalances caches in its onSuccess
  // callback, keeping cache invalidation co-located with the mutation.
  const handleCancel = async (id: string): Promise<void> => {
    try {
      await cancel(id);
    } catch {
      // error handled internally by the mutation hook
    }
  };

  return (
    <div className="pb-32">
      <AppHeader
        title="Leave"
        onBack={() => navigate(-1)}
        showAvatar={false}
        actions={
          <IconButton
            aria-label="New leave request"
            onClick={() => navigate('/leave/request')}
            className="bg-surface-2 rounded-xl"
          >
            <Plus size={20} className="text-ink-2" />
          </IconButton>
        }
      />

      {/* Tabs */}
      <div className="px-4">
        <SegmentedControl
          label="Leave view"
          options={TABS}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {/* Balances Tab */}
      {activeTab === 'balances' && (
        <div className="px-4 mt-4 space-y-3">
          {balancesLoading && <Skeleton variant="tile" count={2} />}
          {balances.map((balance: LeaveBalance) => (
            <Card key={balance.id} className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {/* Tenant-configured colour for this leave type — data, not a
                      design token, so it stays inline. */}
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: balance.leaveType?.color || '#6366f1' }}
                  />
                  <h3 className="text-title font-semibold text-ink-1">
                    {balance.leaveType?.name || 'Leave'}
                  </h3>
                </div>
                <span className="text-body font-mono text-ink-3">{balance.year}</span>
              </div>

              <div className="grid grid-cols-4 gap-2 text-center">
                <div>
                  <p className="text-meta text-ink-3">Total</p>
                  <p className="text-title font-mono font-bold text-ink-1 tabular-nums">
                    {balance.totalEntitlement}
                  </p>
                </div>
                <div>
                  <p className="text-meta text-ink-3">Used</p>
                  <p className="text-title font-mono font-bold text-ink-2 tabular-nums">
                    {balance.usedDays}
                  </p>
                </div>
                <div>
                  <p className="text-meta text-ink-3">Pending</p>
                  <p className="text-title font-mono font-bold text-warn tabular-nums">
                    {balance.pendingDays}
                  </p>
                </div>
                <div>
                  <p className="text-meta text-ink-3">Left</p>
                  <p className="text-title font-mono font-bold text-ok tabular-nums">
                    {balance.remainingDays}
                  </p>
                </div>
              </div>

              {/* Progress bar */}
              <div className="mt-3 h-2 bg-surface-2 rounded-full overflow-hidden">
                <div
                  className="h-full bg-acc rounded-full motion-safe:transition-all"
                  style={{
                    width: `${Math.min(100, (balance.usedDays / balance.totalEntitlement) * 100)}%`,
                  }}
                />
              </div>
            </Card>
          ))}
          {!balancesLoading && balances.length === 0 && (
            <EmptyState
              icon={<CalendarOff size={22} />}
              title="No leave balances found"
              className="py-8"
            />
          )}
        </div>
      )}

      {/* Requests Tab */}
      {activeTab === 'requests' && (
        <div className="px-4 mt-4 space-y-3">
          {requestsLoading && <Skeleton variant="tile" count={2} />}
          {requests.map((request: LeaveRequest) => (
            <Card key={request.id} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-title font-semibold text-ink-1">
                  {request.leaveType?.name || 'Leave'}
                </h3>
                <span
                  className={clsx(
                    'px-2 py-0.5 rounded-full text-meta font-semibold',
                    STATUS_TONES[request.status] ?? 'bg-surface-2 text-ink-2',
                  )}
                >
                  {request.status}
                </span>
              </div>

              <div className="text-body text-ink-2 space-y-1">
                <p>
                  {new Date(request.startDate).toLocaleDateString()} -{' '}
                  {new Date(request.endDate).toLocaleDateString()}
                </p>
                <p>
                  {request.totalDays} day{request.totalDays !== 1 ? 's' : ''}
                  {request.isHalfDayStart || request.isHalfDayEnd ? ' (half day)' : ''}
                </p>
                {request.reason && <p className="text-ink-3 italic">{request.reason}</p>}
              </div>

              {(request.status === 'PENDING' || request.status === 'DRAFT') && (
                <Button
                  variant="danger"
                  block
                  onClick={() => {
                    void handleCancel(request.id);
                  }}
                  disabled={cancelling}
                  className="mt-3"
                >
                  Cancel Request
                </Button>
              )}
            </Card>
          ))}
          {!requestsLoading && requests.length === 0 && (
            <EmptyState icon={<Clock size={22} />} title="No leave requests" className="py-8" />
          )}

          {/* New Request Button */}
          <Button variant="primary" size="save" block onClick={() => navigate('/leave/request')}>
            <Plus size={20} />
            New Leave Request
          </Button>
        </div>
      )}
    </div>
  );
}
