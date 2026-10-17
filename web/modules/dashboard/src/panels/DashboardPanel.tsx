/**
 * A dashboard panel: the console's blueprint frame (shared-ui `sd-card`)
 * with a heading row — title, an optional status line and an optional action
 * — the panel's content and an optional footnote.
 *
 * WHY one component: the four panels of every module dashboard share the
 * frame, the heading level (h3 under the page's h2, itself under the
 * console's h1) and the spacing; each panel only brings its content.
 */
import type { ReactElement, ReactNode } from 'react';

export interface DashboardPanelProps {
  /** id of the heading, which names the section for assistive technology. */
  readonly headingId: string;
  readonly title: string;
  readonly status?: ReactNode;
  readonly action?: ReactNode;
  readonly footnote?: ReactNode;
  readonly children: ReactNode;
}

export function DashboardPanel({
  headingId,
  title,
  status,
  action,
  footnote,
  children,
}: DashboardPanelProps): ReactElement {
  return (
    <section aria-labelledby={headingId} className="sd-card flex min-w-0 flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-sd-rule px-6 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 id={headingId} className="m-0 font-display-sd text-2xl font-semibold text-sd-ink">
            {title}
          </h3>
          {status !== undefined && (
            <span className="text-sm text-sd-neutral-700 tabular-nums">{status}</span>
          )}
        </div>
        {action}
      </div>
      {children}
      {footnote !== undefined && (
        <p className="m-0 border-t border-sd-rule px-6 py-2.5 text-sm text-sd-neutral-700">
          {footnote}
        </p>
      )}
    </section>
  );
}
