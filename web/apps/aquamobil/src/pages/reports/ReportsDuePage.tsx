/**
 * ReportsDuePage — scheduled regulatory report drafts with deadline chips
 * (FARM-HIGH-214 / RPT-019). ONLINE-ONLY by design: report review/approval
 * talks to the live draft state — a regulator submission never sits in a
 * device queue. Offline, the page shows an honest connectivity notice
 * instead of stale deadlines.
 */
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CloudOff, FileText } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import type { MobileReportDeadlinesQuery } from '@/generated/graphql';
import { MOBILE_REPORT_DEADLINES } from '@/graphql/operations';
import { useAuth } from '@/hooks/useAuth';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

type DeadlineRow = MobileReportDeadlinesQuery['reportDeadlines'][number];

const REPORT_TYPE_LABELS: Record<string, string> = {
  SEA_LICE: 'Sea Lice (weekly)',
  CLEANER_FISH: 'Cleaner Fish (monthly)',
  SMOLT: 'Smolt (monthly)',
  SLAUGHTER_PLANNED: 'Slaughter Planned',
  SLAUGHTER_EXECUTED: 'Slaughter Executed',
  BIOMASS: 'Biomass (Altinn)',
};

function periodLabel(row: DeadlineRow): string {
  if (row.periodWeek != null) return `${row.periodYear} · W${row.periodWeek}`;
  if (row.periodMonth != null) return `${row.periodYear}-${String(row.periodMonth).padStart(2, '0')}`;
  return String(row.periodYear);
}

function DueChip({ row }: { row: DeadlineRow }): JSX.Element {
  if (row.overdue) {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
        Overdue
      </span>
    );
  }
  if (row.daysUntilDue != null && row.daysUntilDue <= 2) {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
        Due in {row.daysUntilDue}d
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
      {row.dueAt ? `Due ${row.dueAt}` : 'Unscheduled'}
    </span>
  );
}

export function ReportsDuePage(): JSX.Element {
  const navigate = useNavigate();
  const isOnline = useNetworkStatus();
  const { tenantId, isAuthenticated } = useAuth();

  const deadlinesQuery = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'reportDeadlines'),
    queryFn: async () => {
      const result = await graphqlRequest<MobileReportDeadlinesQuery>(MOBILE_REPORT_DEADLINES, {});
      return result.reportDeadlines;
    },
    enabled: isAuthenticated && !!tenantId && isOnline,
    staleTime: 1000 * 60,
  });

  const rows = (deadlinesQuery.data ?? [])
    .slice()
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="bg-gradient-to-br from-indigo-700 via-indigo-600 to-indigo-500 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
              <FileText size={22} className="text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Reports Due</h1>
              <p className="text-xs text-white/85">Mattilsynet scheduled drafts</p>
            </div>
          </div>
        </div>
        <div className="relative">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      <div className="px-5 pt-4 space-y-3 pb-28">
        {!isOnline && (
          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-2xl p-4 border border-amber-200 dark:border-amber-800 flex items-center gap-3">
            <CloudOff size={20} className="text-amber-600 flex-shrink-0" />
            <p className="text-amber-700 dark:text-amber-300 text-sm font-medium">
              Reports need a connection — regulator submissions are never queued on the device.
            </p>
          </div>
        )}

        {isOnline && deadlinesQuery.isLoading && (
          <div className="text-center py-12 text-gray-400">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mx-auto" />
          </div>
        )}

        {isOnline && deadlinesQuery.isError && (
          <div className="bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border border-red-200 dark:border-red-800">
            <p className="text-red-600 dark:text-red-300 text-sm">
              Could not load report deadlines. Pull to retry or check your access.
            </p>
          </div>
        )}

        {isOnline && deadlinesQuery.isSuccess && rows.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <FileText size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No reports due</p>
            <p className="text-sm mt-1">Scheduled drafts appear here each period.</p>
          </div>
        )}

        {rows.map((row) => (
          <button
            key={row.id}
            onClick={() => navigate(`/reports/${row.id}`)}
            className={clsx(
              'w-full text-left bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border touch-feedback transition-all active:scale-[0.99]',
              row.overdue
                ? 'border-red-200 dark:border-red-800'
                : 'border-gray-100 dark:border-gray-800',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-gray-900 dark:text-white text-sm">
                {REPORT_TYPE_LABELS[row.reportType] ?? row.reportType}
              </span>
              <DueChip row={row} />
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-gray-500">{periodLabel(row)}</span>
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                {row.status}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
