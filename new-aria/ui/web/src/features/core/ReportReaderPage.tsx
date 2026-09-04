// One daily report, rendered as text.
//
// WHY: a report is evidence the kernel wrote; the console must show exactly what
// is in the file and must never let that file's content become markup. WHAT: the
// markdown is parsed for block structure only and handed to React as text, and
// the header states the size so a truncated or empty report is visible before
// the operator starts reading.
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDailyReport } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { CopyButton } from '../../design/CopyButton.tsx';
import { Icon } from '../../design/Icon.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { formatBytes } from '../../design/format.ts';
import { MarkdownText } from './MarkdownText.tsx';

/** Byte length of the report as it sits on disk, so the header matches the index page. */
function markdownBytes(markdown: string): number {
  return new TextEncoder().encode(markdown).length;
}

export function ReportReaderPage(): ReactNode {
  const { date } = useParams<{ date: string }>();
  const reportDate = date ?? '';
  const { state, reload } = useRequest((signal) => getDailyReport(reportDate, signal), [reportDate]);
  if (reportDate === '') {
    return (
      <>
        <PageHeader title="Daily report" breadcrumb={<Link to={ROUTES.reports}>Reports</Link>} />
        <Callout tone="danger" role="alert" title="No report date in the address">
          This page reads one report per day and the address carries no date. Open a day from <Link to={ROUTES.reports}>Reports</Link>.
        </Callout>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={`Daily report · ${reportDate}`}
        breadcrumb={<Link to={ROUTES.reports}>Reports</Link>}
        subtitle={
          state.status === 'success'
            ? `${formatBytes(markdownBytes(state.data.markdown))} of markdown · rendered as text, never as markup`
            : 'reports/daily/'
        }
        actions={
          <button type="button" className="button" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="text" errorTitle={`Could not load the report for ${reportDate}`}>
        {(data) => (
          <Card actions={<CopyButton value={data.markdown} label="Copy markdown source" withText />}>
            <MarkdownText markdown={data.markdown} />
          </Card>
        )}
      </AsyncState>
    </>
  );
}
