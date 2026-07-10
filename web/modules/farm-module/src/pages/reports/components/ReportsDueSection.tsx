/**
 * ReportsDueSection (RPT-003) — the operator's "reports due" surface.
 *
 * Lists the tenant's scheduled report drafts the backend assembled each period,
 * with the deadline resolved server-side (overdue / days-until in the Oslo
 * calendar) shown via the data-driven DeadlineIndicator. A READY draft (no
 * blocking fields) can be approved & submitted straight to Mattilsynet; any
 * draft can be re-assembled from source records (refresh) or dismissed.
 *
 * Expanding a row (Review) opens the DraftReviewPanel — every assembled field
 * shown read-only with its provenance, and ONLY the MANUAL_REQUIRED fields
 * editable (Phase 4). Corrections to RECORDS/SENSOR values still flow to the
 * source records, never the report.
 */
import React, { useState } from 'react';

import {
  ReportDeadline,
  ReportSubmissionResult,
  useApproveAndSubmitReportDraft,
  useDismissReportDraft,
  useRefreshReportDraft,
  useReportDeadlines,
} from '../../../hooks/useReportDeadlines';
import { DeadlineIndicator } from './common/DeadlineIndicator';
import { DraftReviewPanel } from './DraftReviewPanel';
import { ReportStatus } from '../types/reports.types';

const REPORT_TYPE_LABELS: Record<string, string> = {
  BIOMASS: 'Biomass',
  SEA_LICE: 'Sea Lice',
  CLEANER_FISH: 'Cleaner Fish',
  SMOLT: 'Smolt',
  SLAUGHTER_PLANNED: 'Planned Slaughter',
  SLAUGHTER_EXECUTED: 'Executed Slaughter',
};

function reportTypeLabel(reportType: string): string {
  return REPORT_TYPE_LABELS[reportType] ?? reportType;
}

function periodLabel(d: ReportDeadline): string {
  if (d.periodWeek != null) return `${d.periodYear} · Week ${d.periodWeek}`;
  if (d.periodMonth != null) return `${d.periodYear} · Month ${d.periodMonth}`;
  return `${d.periodYear}`;
}

function toIndicatorStatus(status: ReportDeadline['status']): ReportStatus {
  // reportDeadlines only returns non-terminal drafts (DRAFT / READY / APPROVED);
  // READY has no ReportStatus equivalent, so it renders as an active draft. The
  // wire status is the uppercase GraphQL enum key.
  return status === 'APPROVED' ? 'approved' : 'draft';
}

interface RowResult {
  ok: boolean;
  text: string;
}

function submissionRowResult(result: ReportSubmissionResult): RowResult {
  if (result.success) {
    return { ok: true, text: `Submitted — Mattilsynet ref ${result.referanse ?? 'received'}` };
  }
  const details =
    result.valideringsfeil?.map((v) => `${v.felt}: ${v.melding}`).join('; ') ?? result.feilmelding;
  return { ok: false, text: details ?? 'Submission failed' };
}

export const ReportsDueSection: React.FC = () => {
  const { data: deadlines, isLoading, isError } = useReportDeadlines();
  const approve = useApproveAndSubmitReportDraft();
  const refresh = useRefreshReportDraft();
  const dismiss = useDismissReportDraft();
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const busyId =
    (approve.isPending && approve.variables) ||
    (refresh.isPending && refresh.variables) ||
    (dismiss.isPending && dismiss.variables) ||
    null;

  const handleApprove = (draftId: string): void => {
    approve.mutate(draftId, {
      onSuccess: (result) =>
        setResults((prev) => ({ ...prev, [draftId]: submissionRowResult(result) })),
      onError: (error) =>
        setResults((prev) => ({ ...prev, [draftId]: { ok: false, text: error.message } })),
    });
  };

  return (
    <section
      className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4"
      aria-label="Reports due"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Scheduled reports due</h2>
        {deadlines && deadlines.length > 0 && (
          <span className="text-xs text-gray-500">{deadlines.length} draft(s)</span>
        )}
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading scheduled reports…</p>}
      {isError && (
        <p className="text-sm text-red-600">Could not load scheduled reports. Try again.</p>
      )}
      {!isLoading && !isError && (!deadlines || deadlines.length === 0) && (
        <p className="text-sm text-gray-500">
          No scheduled reports are due. Drafts appear here automatically each reporting period.
        </p>
      )}

      {!isLoading && deadlines && deadlines.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {deadlines.map((d) => {
            const rowResult = results[d.id];
            const isBusy = busyId === d.id;
            const isReviewing = reviewingId === d.id;
            return (
              <li key={d.id} className="py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900">
                      {reportTypeLabel(d.reportType)}
                    </p>
                    <p className="text-xs text-gray-500">{periodLabel(d)}</p>
                    {rowResult && (
                      <p
                        className={`text-xs mt-1 ${rowResult.ok ? 'text-green-700' : 'text-red-600'}`}
                      >
                        {rowResult.text}
                      </p>
                    )}
                  </div>

                  {d.dueAt && (
                    <DeadlineIndicator
                      deadline={new Date(d.dueAt)}
                      status={toIndicatorStatus(d.status)}
                      daysUntilDue={d.daysUntilDue ?? undefined}
                      overdue={d.overdue}
                      size="sm"
                    />
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setReviewingId(isReviewing ? null : d.id)}
                      aria-expanded={isReviewing}
                      className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md text-gray-700 bg-white border border-gray-300 hover:bg-gray-50"
                    >
                      {isReviewing ? 'Hide' : 'Review'}
                    </button>
                    {d.status === 'READY' && (
                      <button
                        type="button"
                        onClick={() => handleApprove(d.id)}
                        disabled={isBusy}
                        className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                      >
                        Approve &amp; Submit
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => refresh.mutate(d.id)}
                      disabled={isBusy}
                      className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      onClick={() => dismiss.mutate(d.id)}
                      disabled={isBusy}
                      className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md text-gray-500 hover:text-gray-700 disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
                {isReviewing && <DraftReviewPanel draftId={d.id} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default ReportsDueSection;
