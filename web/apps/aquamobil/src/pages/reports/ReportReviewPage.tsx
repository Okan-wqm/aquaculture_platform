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
import { CheckCircle2, CloudOff, FileText, ShieldAlert } from 'lucide-react';
import { type JSX, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Button, Card, CardDivider, EmptyState, Skeleton } from '@/components/ui';
import type {
  MobileApproveAndSubmitReportDraftMutation,
  MobileReportDraftsQuery,
} from '@/generated/graphql';
import { MOBILE_APPROVE_AND_SUBMIT_REPORT_DRAFT, MOBILE_REPORT_DRAFTS } from '@/graphql/operations';
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
    return <span className="text-ink-3">—</span>;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-ink-1 break-all">{String(value)}</span>;
  }
  if (typeof value !== 'object') {
    // Symbols/functions never appear in a JSON wire payload; render a marker.
    return <span className="text-ink-3">(unrenderable)</span>;
  }
  const entries: ReadonlyArray<readonly [string, unknown]> = Array.isArray(value)
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return <span className="text-ink-3">{Array.isArray(value) ? '[]' : '{}'}</span>;
  }
  return (
    <div className={depth > 0 ? 'pl-3 border-l border-line' : ''}>
      {entries.map(([key, v]) => (
        <div key={key} className="py-0.5">
          <span className="text-ink-3 font-medium">{key}: </span>
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
    <div className="pb-28">
      {/* Back goes to /reports rather than history — a manager reaches this page
          from the deadline list and expects to land back on it. */}
      <AppHeader title="Review Draft" onBack={() => navigate('/reports')} showAvatar={false} />

      <div className="px-4 flex flex-col gap-4">
        {!isOnline && (
          <Card className="p-4 flex items-center gap-3 border-warn">
            <span className="w-9 h-9 shrink-0 rounded-xl bg-warn-dim text-warn inline-flex items-center justify-center">
              <CloudOff size={18} />
            </span>
            <p className="text-body text-ink-1">
              Approval needs a live connection — reconnect to review and submit.
            </p>
          </Card>
        )}

        {isOnline && draftsQuery.isLoading && <Skeleton variant="tile" count={2} />}

        {isOnline && draftsQuery.isSuccess && !draft && (
          <EmptyState
            tone="error"
            icon={<FileText size={22} />}
            title="Draft not found"
            description="It may have been submitted or dismissed elsewhere."
          />
        )}

        {draft && (
          <>
            <Card className="p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-title font-semibold text-ink-1">{draft.reportType}</span>
                {/* The status is a machine value, so it keeps its mono/uppercase
                    treatment — "uppercase survives only where a machine speaks". */}
                <span className="text-meta font-mono font-semibold text-ink-3 uppercase tracking-wide shrink-0">
                  {draft.status}
                </span>
              </div>
              <div className="text-body text-ink-2">
                {draft.periodYear}
                {draft.periodWeek != null ? ` · W${draft.periodWeek}` : ''}
                {draft.periodMonth != null ? `-${String(draft.periodMonth).padStart(2, '0')}` : ''}
                {draft.dueAt ? ` · due ${String(draft.dueAt)}` : ''}
              </div>
              <div className="text-meta text-ink-3">
                Schema {draft.schemaValid === false ? 'INVALID' : 'valid'} · {fieldMeta.length}{' '}
                assembled fields · {manualFields.length} manual
              </div>
            </Card>

            {blockingFields.length > 0 && (
              <Card className="p-4 border-crit">
                <div className="flex items-start gap-3">
                  <span className="w-9 h-9 shrink-0 rounded-xl bg-crit-dim text-crit inline-flex items-center justify-center">
                    <ShieldAlert size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-body font-semibold text-ink-1">
                      {blockingFields.length} blocking field
                      {blockingFields.length > 1 ? 's' : ''} — complete on the Reports desk first
                    </p>
                    <ul className="mt-1 space-y-1">
                      {blockingFields.slice(0, 5).map((f, i) => (
                        <li key={f.path ?? i} className="text-meta text-ink-2">
                          {f.path}: {f.message ?? 'manual value required'}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </Card>
            )}

            <Card className="overflow-hidden">
              <div className="p-3">
                <h3 className="text-meta font-semibold text-ink-3">
                  Assembled payload (read-only)
                </h3>
              </div>
              <CardDivider />
              <div className="p-3 text-meta overflow-x-auto max-h-96 overflow-y-auto">
                <PayloadTree value={draft.assembledPayload} />
              </div>
            </Card>

            {submitResult?.success && (
              <Card className="p-4 flex items-start gap-3 border-ok">
                <span className="w-9 h-9 shrink-0 rounded-xl bg-surface-2 text-ok inline-flex items-center justify-center">
                  <CheckCircle2 size={18} />
                </span>
                <div className="min-w-0">
                  <p className="text-body font-semibold text-ink-1">Submitted to Mattilsynet</p>
                  {submitResult.referanse && (
                    <p className="text-meta font-mono text-ink-2 mt-1 break-all">
                      Referanse: {submitResult.referanse}
                    </p>
                  )}
                </div>
              </Card>
            )}

            {submitResult && !submitResult.success && (
              <Card className="p-4 border-crit">
                <p className="text-body font-semibold text-ink-1">
                  Submission failed{submitResult.feilmelding ? `: ${submitResult.feilmelding}` : ''}
                </p>
                {(submitResult.valideringsfeil ?? []).slice(0, 5).map((v, i) => (
                  <p key={v?.felt ?? i} className="text-meta text-ink-2 mt-1">
                    {v?.felt}: {v?.melding}
                  </p>
                ))}
              </Card>
            )}

            {approveMutation.isError && !submitResult && (
              <Card className="p-4 border-crit">
                <p className="text-body text-ink-1">
                  {approveMutation.error instanceof Error
                    ? approveMutation.error.message
                    : 'Submission failed'}
                </p>
              </Card>
            )}

            <Button
              variant="primary"
              size="save"
              block
              onClick={() => approveMutation.mutate()}
              disabled={!canSubmit}
            >
              {approveMutation.isPending ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                  Submitting…
                </>
              ) : (
                <>
                  <CheckCircle2 size={20} />
                  Approve &amp; Submit
                </>
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
