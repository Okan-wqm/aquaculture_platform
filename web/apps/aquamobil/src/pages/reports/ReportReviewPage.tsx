/**
 * ReportReviewPage — read-only draft review + approve-and-submit
 * (FARM-HIGH-214 / RPT-019). ONLINE-ONLY: the approve mutation is guarded by
 * live network status — a regulator submission is called live or not at all,
 * never parked in the offline queue.
 *
 * The page renders the ASSEMBLED payload and the per-field provenance meta
 * the server computed; nothing is editable here. Manual overrides and source
 * corrections stay on the desktop Reports desk — mobile approval is for the
 * manager who has reviewed the draft and wants to file it from the field.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, CloudOff, FileText, ShieldAlert } from 'lucide-react';
import { type JSX, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type {
  MobileApproveAndSubmitReportDraftMutation,
  MobileReportDraftsQuery,
} from '@/generated/graphql';
import {
  MOBILE_APPROVE_AND_SUBMIT_REPORT_DRAFT,
  MOBILE_REPORT_DRAFTS,
} from '@/graphql/operations';
import { useAuth } from '@/hooks/useAuth';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

type DraftRow = MobileReportDraftsQuery['reportDrafts'][number];

interface FieldMetaEntry {
  path?: string;
  provenance?: string;
  blocking?: boolean;
  message?: string;
}

function readFieldMeta(draft: DraftRow): FieldMetaEntry[] {
  const meta: unknown = draft.fieldMeta;
  return Array.isArray(meta) ? (meta as FieldMetaEntry[]) : [];
}

const SUBMITTABLE_STATUSES = new Set(['DRAFT', 'READY', 'APPROVED']);

/**
 * Read-only recursive renderer for the assembled wire payload. Structured
 * rows read far better on a phone than a raw JSON blob, and the multi-line
 * JSON.stringify form is banned repo-wide (structured-logging rule).
 */
function PayloadTree({ value, depth = 0 }: { value: unknown; depth?: number }): JSX.Element {
  if (value === null || value === undefined) {
    return <span className="text-gray-400">—</span>;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-gray-800 dark:text-gray-200 break-all">{String(value)}</span>;
  }
  if (typeof value !== 'object') {
    // Symbols/functions never appear in a JSON wire payload; render a marker.
    return <span className="text-gray-400">(unrenderable)</span>;
  }
  const entries: ReadonlyArray<readonly [string, unknown]> = Array.isArray(value)
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return <span className="text-gray-400">{Array.isArray(value) ? '[]' : '{}'}</span>;
  }
  return (
    <div className={depth > 0 ? 'pl-3 border-l border-gray-100 dark:border-gray-800' : ''}>
      {entries.map(([key, v]) => (
        <div key={key} className="py-0.5">
          <span className="text-gray-500 font-medium">{key}: </span>
          <PayloadTree value={v} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

export function ReportReviewPage(): JSX.Element {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
  const isOnline = useNetworkStatus();
  const { tenantId, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [submitResult, setSubmitResult] = useState<
    MobileApproveAndSubmitReportDraftMutation['approveAndSubmitReportDraft'] | null
  >(null);

  const draftsQuery = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'reportDrafts'),
    queryFn: async () => {
      const result = await graphqlRequest<MobileReportDraftsQuery>(MOBILE_REPORT_DRAFTS, {});
      return result.reportDrafts;
    },
    enabled: isAuthenticated && !!tenantId && isOnline,
    staleTime: 1000 * 30,
  });

  const draft = draftsQuery.data?.find((d) => d.id === draftId);
  const fieldMeta = draft ? readFieldMeta(draft) : [];
  const blockingFields = fieldMeta.filter((f) => f.blocking);
  const manualFields = fieldMeta.filter((f) => f.provenance === 'MANUAL_REQUIRED');

  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!draftId) throw new Error('Missing draft id');
      const result = await graphqlRequest<MobileApproveAndSubmitReportDraftMutation>(
        MOBILE_APPROVE_AND_SUBMIT_REPORT_DRAFT,
        { draftId },
      );
      return result.approveAndSubmitReportDraft;
    },
    onSuccess: async (result) => {
      setSubmitResult(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'reportDrafts') }),
        queryClient.invalidateQueries({
          queryKey: createTenantQueryKey(tenantId, 'reportDeadlines'),
        }),
      ]);
    },
  });

  const canSubmit =
    isOnline &&
    !!draft &&
    SUBMITTABLE_STATUSES.has(draft.status) &&
    draft.schemaValid !== false &&
    blockingFields.length === 0 &&
    !approveMutation.isPending &&
    !submitResult?.success;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="bg-gradient-to-r from-indigo-700 to-indigo-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button
            onClick={() => navigate('/reports')}
            className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback"
          >
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <FileText size={22} />
            <h1 className="text-lg font-bold">Review Draft</h1>
          </div>
        </div>
      </div>

      <div className="px-4 pt-4 space-y-4 pb-28">
        {!isOnline && (
          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-2xl p-4 border border-amber-200 dark:border-amber-800 flex items-center gap-3">
            <CloudOff size={20} className="text-amber-600 flex-shrink-0" />
            <p className="text-amber-700 dark:text-amber-300 text-sm font-medium">
              Approval needs a live connection — reconnect to review and submit.
            </p>
          </div>
        )}

        {isOnline && draftsQuery.isLoading && (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mx-auto" />
          </div>
        )}

        {isOnline && draftsQuery.isSuccess && !draft && (
          <div className="bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border border-red-200 dark:border-red-800">
            <p className="text-red-600 dark:text-red-300 text-sm">
              Draft not found — it may have been submitted or dismissed elsewhere.
            </p>
          </div>
        )}

        {draft && (
          <>
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-gray-900 dark:text-white">{draft.reportType}</span>
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  {draft.status}
                </span>
              </div>
              <div className="text-sm text-gray-500">
                {draft.periodYear}
                {draft.periodWeek != null ? ` · W${draft.periodWeek}` : ''}
                {draft.periodMonth != null ? `-${String(draft.periodMonth).padStart(2, '0')}` : ''}
                {draft.dueAt ? ` · due ${String(draft.dueAt)}` : ''}
              </div>
              <div className="text-xs text-gray-400">
                Schema {draft.schemaValid === false ? 'INVALID' : 'valid'} · {fieldMeta.length}{' '}
                assembled fields · {manualFields.length} manual
              </div>
            </div>

            {blockingFields.length > 0 && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border border-red-200 dark:border-red-800">
                <div className="flex items-start gap-2">
                  <ShieldAlert size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-red-700 dark:text-red-300 text-sm font-bold">
                      {blockingFields.length} blocking field
                      {blockingFields.length > 1 ? 's' : ''} — complete on the Reports desk first
                    </p>
                    <ul className="mt-1 space-y-1">
                      {blockingFields.slice(0, 5).map((f, i) => (
                        <li key={f.path ?? i} className="text-xs text-red-600 dark:text-red-400">
                          {f.path}: {f.message ?? 'manual value required'}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
              <div className="p-3 border-b border-gray-100 dark:border-gray-800">
                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                  Assembled payload (read-only)
                </h3>
              </div>
              <div className="p-3 text-xs overflow-x-auto max-h-96 overflow-y-auto">
                <PayloadTree value={draft.assembledPayload} />
              </div>
            </div>

            {submitResult?.success && (
              <div className="bg-green-50 dark:bg-green-900/20 rounded-2xl p-4 border border-green-200 dark:border-green-800 flex items-start gap-3">
                <CheckCircle2 size={22} className="text-green-600 flex-shrink-0" />
                <div>
                  <p className="text-green-700 dark:text-green-300 font-bold text-sm">
                    Submitted to Mattilsynet
                  </p>
                  {submitResult.referanse && (
                    <p className="text-green-600 dark:text-green-400 text-xs mt-1">
                      Referanse: {submitResult.referanse}
                    </p>
                  )}
                </div>
              </div>
            )}

            {submitResult && !submitResult.success && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border border-red-200 dark:border-red-800">
                <p className="text-red-700 dark:text-red-300 text-sm font-bold">
                  Submission failed{submitResult.feilmelding ? `: ${submitResult.feilmelding}` : ''}
                </p>
                {(submitResult.valideringsfeil ?? []).slice(0, 5).map((v, i) => (
                  <p key={v?.felt ?? i} className="text-xs text-red-600 dark:text-red-400 mt-1">
                    {v?.felt}: {v?.melding}
                  </p>
                ))}
              </div>
            )}

            {approveMutation.isError && !submitResult && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border border-red-200 dark:border-red-800">
                <p className="text-red-600 dark:text-red-300 text-sm">
                  {approveMutation.error instanceof Error
                    ? approveMutation.error.message
                    : 'Submission failed'}
                </p>
              </div>
            )}

            <button
              onClick={() => approveMutation.mutate()}
              disabled={!canSubmit}
              className="w-full py-4 text-white font-bold rounded-2xl shadow-lg bg-gradient-to-r from-indigo-600 to-indigo-500 shadow-indigo-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
            >
              {approveMutation.isPending ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                  Submitting…
                </>
              ) : (
                <>
                  <CheckCircle2 size={20} />
                  Approve & Submit
                </>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
