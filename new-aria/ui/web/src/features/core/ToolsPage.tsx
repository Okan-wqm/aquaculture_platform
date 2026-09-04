import type { ReactNode } from 'react';
import type { ToolView } from '../../../../shared/api-contract.ts';
import { getTools } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber, textOrEmpty } from '../../design/format.ts';
import { toneForStatus } from './tones.ts';

const COLUMNS: ReadonlyArray<ColumnDef<ToolView>> = [
  { id: 'id', header: 'tool_id', render: (row) => <span className="mono">{row.toolId}</span>, sortValue: (row) => row.toolId, nowrap: true },
  { id: 'kind', header: 'kind', render: (row) => textOrEmpty(row.kind), sortValue: (row) => row.kind, nowrap: true },
  { id: 'status', header: 'status', render: (row) => <Badge tone={toneForStatus(row.status)}>{row.status}</Badge>, sortValue: (row) => row.status, nowrap: true },
  { id: 'version', header: 'version', render: (row) => <span className="mono">{textOrEmpty(row.version)}</span>, sortValue: (row) => row.version, nowrap: true },
  {
    id: 'scope',
    header: 'declared_scope',
    render: (row) =>
      row.declaredScope.length === 0 ? (
        <span className="muted">{EMPTY}</span>
      ) : (
        <ul className="chip-list">
          {row.declaredScope.map((scope) => (
            <li key={scope} className="chip" title={scope}>
              {scope}
            </li>
          ))}
        </ul>
      ),
  },
  { id: 'lastRunAt', header: 'Son koşu', render: (row) => <Timestamp value={row.lastRunAt} />, sortValue: (row) => row.lastRunAt, nowrap: true },
  {
    id: 'lastRunStatus',
    header: 'Son koşu durumu',
    render: (row) => (row.lastRunStatus === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.lastRunStatus)}>{row.lastRunStatus}</Badge>),
    sortValue: (row) => row.lastRunStatus,
    nowrap: true,
  },
  { id: 'runCount', header: 'Koşu sayısı', render: (row) => formatNumber(row.runCount), sortValue: (row) => row.runCount, align: 'end' },
];

export function ToolsPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getTools(signal), []);
  return (
    <>
      <PageHeader
        title="Araçlar"
        subtitle="registry.json + runs.jsonl"
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(data) => (
          <Card flush>
            <DataTable
              columns={COLUMNS}
              rows={data.tools}
              rowKey={(row) => row.toolId}
              caption="Araç kayıt defteri"
              emptyMessage="Kayıtlı araç yok."
              filter={{
                placeholder: 'tool_id / kind / status ara…',
                predicate: (row, query) => `${row.toolId} ${row.kind ?? ''} ${row.status} ${row.declaredScope.join(' ')}`.toLocaleLowerCase('tr').includes(query),
              }}
              initialSort={{ columnId: 'id', direction: 'asc' }}
            />
          </Card>
        )}
      </AsyncState>
    </>
  );
}
