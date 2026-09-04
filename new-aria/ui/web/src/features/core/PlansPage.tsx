import type { ReactNode } from 'react';
import type { PlanView } from '../../../../shared/api-contract.ts';
import { getPlans } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber, textOrEmpty } from '../../design/format.ts';
import { ByCountStats } from './ByCountStats.tsx';
import { toneForStatus } from './tones.ts';

const COLUMNS: ReadonlyArray<ColumnDef<PlanView>> = [
  { id: 'id', header: 'plan_id', render: (row) => <span className="mono">{row.planId}</span>, sortValue: (row) => row.planId, nowrap: true },
  { id: 'state', header: 'state', render: (row) => <Badge tone={toneForStatus(row.state)}>{row.state}</Badge>, sortValue: (row) => row.state, nowrap: true },
  { id: 'round', header: 'Tur', render: (row) => formatNumber(row.round), sortValue: (row) => row.round, align: 'end' },
  { id: 'pressure', header: 'pressure_event_id', render: (row) => <span className="mono">{textOrEmpty(row.pressureEventId)}</span>, sortValue: (row) => row.pressureEventId, nowrap: true },
  {
    id: 'terminal',
    header: 'terminal_state',
    render: (row) => (row.terminalState === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.terminalState)}>{row.terminalState}</Badge>),
    sortValue: (row) => row.terminalState,
    nowrap: true,
  },
  { id: 'updatedAt', header: 'Güncellendi', render: (row) => <Timestamp value={row.updatedAt} />, sortValue: (row) => row.updatedAt, nowrap: true },
];

export function PlansPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getPlans({ limit: 500 }, signal), []);
  return (
    <>
      <PageHeader
        title="Planlar"
        subtitle="plans/"
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(data) => (
          <div className="stack">
            <ByCountStats counts={data.byState} kind="status" emptyMessage="Durum dağılımı yok." />
            <Card flush>
              <DataTable
                columns={COLUMNS}
                rows={data.plans}
                rowKey={(row) => row.planId}
                caption="Plan listesi"
                emptyMessage="Kayıtlı plan yok."
                filter={{
                  placeholder: 'plan_id / state ara…',
                  predicate: (row, query) => `${row.planId} ${row.state} ${row.pressureEventId ?? ''} ${row.terminalState ?? ''}`.toLocaleLowerCase('tr').includes(query),
                }}
                initialSort={{ columnId: 'updatedAt', direction: 'desc' }}
              />
            </Card>
          </div>
        )}
      </AsyncState>
    </>
  );
}
