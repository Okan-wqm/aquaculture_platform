import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDailyReport } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { formatBytes } from '../../design/format.ts';
import { MarkdownText } from './MarkdownText.tsx';

export function ReportReaderPage(): ReactNode {
  const { date } = useParams<{ date: string }>();
  const reportDate = date ?? '';
  const { state, reload } = useRequest((signal) => getDailyReport(reportDate, signal), [reportDate]);
  if (reportDate === '') {
    return <Callout tone="danger">Rapor tarihi eksik.</Callout>;
  }
  return (
    <>
      <PageHeader
        title={`Günlük rapor · ${reportDate}`}
        breadcrumb={<Link to={ROUTES.reports}>Raporlar</Link>}
        subtitle={state.status === 'success' ? `${formatBytes(new TextEncoder().encode(state.data.markdown).length)} markdown · metin olarak gösterilir` : 'reports/daily/'}
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(data) => (
          <Card>
            <MarkdownText markdown={data.markdown} />
          </Card>
        )}
      </AsyncState>
    </>
  );
}
