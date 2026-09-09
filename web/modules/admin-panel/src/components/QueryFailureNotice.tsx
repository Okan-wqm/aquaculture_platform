/**
 * QueryFailureNotice — the one way an admin page reports a failed read
 * (ADMIN-HIGH-121).
 *
 * ## The bug this replaces, four times over
 *
 * Every multi-query admin page had written the same careful thing and then
 * thrown it away. `AuditTrailPage` spends sixty-six lines collecting a
 * `failures[]` from four settled promises; `SecurityDashboardPage` does it for
 * four; `ActivityLogPage` for two — and all three then render it under
 * `error && <the list> .length === 0`. So the case that actually happens —
 * some queries succeed, one fails — showed empty sections with **no
 * indication anything had failed at all**. On the platform's security
 * dashboard that is an operator reading "no incidents" off a request that
 * never returned.
 *
 * The audit's own correction C7 credited `SecurityDashboardPage` with
 * "surfacing a failures[] list". It collects one. The render discards it.
 *
 * ## Why a component and not a fourth banner
 *
 * The three pages did not disagree about what to show; they disagreed by
 * accident about *when*. Writing the condition once makes the correct
 * behaviour the zero-effort default for the forty pages still to migrate,
 * which is the only version of this fix that stays fixed.
 *
 * The rule it encodes:
 *
 *   - **no errors** → nothing renders;
 *   - **errors, and some data loaded** → an inline banner above the content.
 *     The part the operator can still trust stays on screen, and the part
 *     that failed says which part;
 *   - **errors, and nothing loaded** → the full-page state, because there is
 *     no content to sit above.
 *
 * Both branches offer the same retry, so a page never has one path that can
 * recover and another that cannot.
 *
 * @example
 * ```tsx
 * <QueryFailureNotice
 *   errors={[entriesQuery.error, summaryQuery.error]}
 *   hasContent={entries.length > 0}
 *   onRetry={reload}
 * />
 * ```
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';

export interface QueryFailureNoticeProps {
  /**
   * One entry per query that could fail, in the order they should be read.
   * `null` / `undefined` entries — the queries that succeeded — are dropped,
   * so a caller passes `query.error` directly and never pre-filters.
   */
  readonly errors: ReadonlyArray<Error | null | undefined>;
  /**
   * Whether the page has anything to show. Drives banner-vs-full-page; it is
   * the caller's because only the page knows which of its queries carries the
   * content and which carry the trimmings.
   */
  readonly hasContent: boolean;
  /** Re-runs the page's queries. Offered identically in both states. */
  readonly onRetry: () => void;
}

export const QueryFailureNotice: React.FC<QueryFailureNoticeProps> = ({
  errors,
  hasContent,
  onRetry,
}) => {
  const messages = errors
    .filter((error): error is Error => error instanceof Error)
    .map((error) => error.message);

  if (messages.length === 0) return null;

  const text = messages.join('; ');

  if (!hasContent) {
    return (
      <div className="flex h-64 flex-col items-center justify-center" role="alert">
        <AlertTriangle className="mb-4 h-12 w-12 text-red-500" />
        <p className="mb-4 text-red-600">{text}</p>
        <button
          onClick={onRetry}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
      <p className="flex-1 text-sm text-amber-800">{text}</p>
      <button
        onClick={onRetry}
        className="shrink-0 rounded-lg border border-amber-300 px-3 py-1 text-sm font-medium text-amber-800 hover:bg-amber-100"
      >
        Retry
      </button>
    </div>
  );
};
