import { clsx } from 'clsx';
import { CalendarOff, Plus, Clock } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { LeaveTypeSwatch } from '@/components/LeaveTypeSwatch';
import { PageHeader } from '@/components/ui/PageHeader';
import { Spinner } from '@/components/ui/Spinner';
import { ToggleButton } from '@/components/ui/ToggleButton';
import {
  useMyLeaveBalances,
  useMyLeaveRequests,
  useCancelLeaveRequest,
  useLeaveTypes,
} from '@/hooks/useLeave';
import type { LeaveBalance, LeaveRequest } from '@/types';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  PENDING: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
};

type Tab = 'balances' | 'requests';

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
  // The HR LeaveBalance type carries only leaveTypeId; the display type is
  // joined client-side against the leaveTypes list (MOB-HIGH-022 — the old
  // `balance.leaveType` read a field the schema never had).
  const { data: leaveTypes = [] } = useLeaveTypes();
  const leaveTypeById = new Map(leaveTypes.map((type) => [type.id, type]));

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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <PageHeader
        tone="violet"
        icon={CalendarOff}
        title="Leave"
        actions={
          <button
            onClick={() => navigate('/leave/request')}
            className="p-2 rounded-xl bg-white/20 dark:bg-gray-900/20 hover:bg-white/30 dark:hover:bg-gray-800/30 touch-feedback"
          >
            <Plus size={20} />
          </button>
        }
      />

      {/* Tabs */}
      <div className="px-4 mt-4 flex gap-2">
        <ToggleButton
          onClick={() => setActiveTab('balances')}
          pressed={activeTab === 'balances'}
          className="flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all"
          pressedClassName="bg-violet-600 text-white shadow-md"
          idleClassName="bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700"
        >
          Balances
        </ToggleButton>
        <ToggleButton
          onClick={() => setActiveTab('requests')}
          pressed={activeTab === 'requests'}
          className="flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all"
          pressedClassName="bg-violet-600 text-white shadow-md"
          idleClassName="bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700"
        >
          Requests
        </ToggleButton>
      </div>

      {/* Balances Tab */}
      {activeTab === 'balances' && (
        <div className="px-4 mt-4 space-y-3">
          {balancesLoading && (
            <div className="flex justify-center py-8">
              <Spinner size="lg" />
            </div>
          )}
          {balances.map((balance: LeaveBalance) => (
            <div
              key={balance.id}
              className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <LeaveTypeSwatch color={leaveTypeById.get(balance.leaveTypeId)?.color} />
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    {leaveTypeById.get(balance.leaveTypeId)?.name || 'Leave'}
                  </h3>
                </div>
                <span className="text-sm text-gray-400 dark:text-gray-500">{balance.year}</span>
              </div>

              <div className="grid grid-cols-4 gap-2 text-center">
                <div>
                  <p className="text-xs text-gray-400 dark:text-gray-500">Total</p>
                  <p className="font-bold text-gray-900 dark:text-white">
                    {balance.totalEntitlement}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 dark:text-gray-500">Used</p>
                  <p className="font-bold text-red-500">{balance.usedDays}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 dark:text-gray-500">Pending</p>
                  <p className="font-bold text-amber-500">{balance.pendingDays}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 dark:text-gray-500">Left</p>
                  <p className="font-bold text-green-600">{balance.remainingDays}</p>
                </div>
              </div>

              {/* Progress bar */}
              <div className="mt-3 h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-violet-500 rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, (balance.usedDays / balance.totalEntitlement) * 100)}%`,
                  }}
                />
              </div>
            </div>
          ))}
          {!balancesLoading && balances.length === 0 && (
            <div className="text-center py-8 text-gray-400 dark:text-gray-500">
              <CalendarOff size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">No leave balances found</p>
            </div>
          )}
        </div>
      )}

      {/* Requests Tab */}
      {activeTab === 'requests' && (
        <div className="px-4 mt-4 space-y-3">
          {requestsLoading && (
            <div className="flex justify-center py-8">
              <Spinner size="lg" />
            </div>
          )}
          {requests.map((request: LeaveRequest) => (
            <div
              key={request.id}
              className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-gray-900 dark:text-white">
                  {request.leaveType?.name || 'Leave'}
                </h3>
                <span
                  className={clsx(
                    'px-2 py-0.5 rounded-full text-xs font-semibold',
                    STATUS_COLORS[request.status],
                  )}
                >
                  {request.status}
                </span>
              </div>

              <div className="text-sm text-gray-500 dark:text-gray-400 space-y-1">
                <p>
                  {new Date(request.startDate).toLocaleDateString()} -{' '}
                  {new Date(request.endDate).toLocaleDateString()}
                </p>
                <p>
                  {request.totalDays} day{request.totalDays !== 1 ? 's' : ''}
                  {request.isHalfDayStart || request.isHalfDayEnd ? ' (half day)' : ''}
                </p>
                {request.reason && (
                  <p className="text-gray-400 dark:text-gray-500 italic">{request.reason}</p>
                )}
              </div>

              {(request.status === 'PENDING' || request.status === 'DRAFT') && (
                <button
                  onClick={() => {
                    void handleCancel(request.id);
                  }}
                  disabled={cancelling}
                  className="mt-3 w-full py-2 text-sm font-semibold text-red-600 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 touch-feedback"
                >
                  Cancel Request
                </button>
              )}
            </div>
          ))}
          {!requestsLoading && requests.length === 0 && (
            <div className="text-center py-8 text-gray-400 dark:text-gray-500">
              <Clock size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">No leave requests</p>
            </div>
          )}

          {/* New Request Button */}
          <button
            onClick={() => navigate('/leave/request')}
            className="w-full py-4 bg-gradient-to-r from-violet-600 to-violet-500 text-white font-bold rounded-2xl shadow-lg shadow-violet-500/25 touch-feedback transition-all flex items-center justify-center gap-2"
          >
            <Plus size={20} />
            New Leave Request
          </button>
        </div>
      )}
    </div>
  );
}
