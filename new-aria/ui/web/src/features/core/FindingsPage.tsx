import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { FindingView } from '../../../../shared/api-contract.ts';
import { getFindings } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber, textOrEmpty } from '../../design/format.ts';
import { ByCountStats } from './ByCountStats.tsx';
import { EvidenceRefs } from './EvidenceRefs.tsx';
import { toneForSeverity, toneForStatus } from './tones.ts';

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as const;

const COLUMNS: ReadonlyArray<ColumnDef<FindingView>> = [
  {
    id: 'severity',
    header: 'severity',
    render: (row) => <Badge tone={toneForSeverity(row.severity)}>{row.severity ?? 'unknown'}</Badge>,
    sortValue: (row) => {
      const index = (SEVERITIES as ReadonlyArray<string>).indexOf((row.severity ?? '').toUpperCase());
      return index === -1 ? SEVERITIES.length : index;
    },
    nowrap: true,
  },
  { id: 'rule', header: 'rule', render: (row) => <span className="mono">{textOrEmpty(row.rule)}</span>, sortValue: (row) => row.rule },
  {
    id: 'location',
    header: 'Konum',
    render: (row) => (
      <span className="mono" title={row.path ?? undefined}>
        {row.path === null ? EMPTY : `${row.path}${row.line === null ? '' : `:${row.line}`}`}
      </span>
    ),
    sortValue: (row) => row.path,
  },
  { id: 'message', header: 'Mesaj', render: (row) => textOrEmpty(row.message) },
  { id: 'tool', header: 'tool_id', render: (row) => <span className="mono">{textOrEmpty(row.toolId)}</span>, sortValue: (row) => row.toolId, nowrap: true },
  {
    id: 'cycle',
    header: 'cycle_id',
    render: (row) =>
      row.cycleId === null ? (
        <span className="muted">{EMPTY}</span>
      ) : (
        <Link className="mono" to={ROUTES.cycle(row.cycleId)}>
          {row.cycleId}
        </Link>
      ),
    nowrap: true,
  },
  { id: 'evidence', header: 'Kanıt referansları', render: (row) => <EvidenceRefs refs={row.evidenceRefs} /> },
  {
    id: 'feedback',
    header: 'feedback',
    render: (row) => (row.feedback === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.feedback)}>{row.feedback}</Badge>),
    sortValue: (row) => row.feedback,
  },
  { id: 'at', header: 'Zaman', render: (row) => <Timestamp value={row.at} />, sortValue: (row) => row.at, nowrap: true },
];

export function FindingsPage(): ReactNode {
  const [severity, setSeverity] = useState('');
  const [tool, setTool] = useState('');
  const [limit, setLimit] = useState(200);
  const { state, reload } = useRequest(
    (signal) => getFindings({ severity: severity === '' ? undefined : severity, tool: tool === '' ? undefined : tool, limit }, signal),
    [severity, tool, limit],
  );

  return (
    <>
      <PageHeader
        title="Bulgular"
        subtitle={state.status === 'success' ? `${formatNumber(state.data.total)} toplam · ${formatNumber(state.data.findings.length)} gösteriliyor` : 'raw-findings.jsonl + findings.jsonl'}
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <div className="stack">
        <div className="toolbar">
          <label className="field" htmlFor="findings-severity">
            <span>severity</span>
            <select id="findings-severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
              <option value="">(hepsi)</option>
              {SEVERITIES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="findings-tool">
            <span>tool_id</span>
            <input id="findings-tool" type="text" value={tool} onChange={(event) => setTool(event.target.value)} placeholder="tam eşleşme" autoComplete="off" />
          </label>
          <label className="field" htmlFor="findings-limit">
            <span>Limit</span>
            <select id="findings-limit" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {[100, 200, 500, 1000].map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </div>
        <AsyncState state={state} onRetry={reload}>
          {(data) => (
            <>
              <ByCountStats counts={data.bySeverity} kind="severity" emptyMessage="Şiddet dağılımı yok." />
              <Card flush>
                <DataTable
                  columns={COLUMNS}
                  rows={data.findings}
                  rowKey={(row) => row.id}
                  caption="Bulgu listesi"
                  emptyMessage="Bu filtrelerle bulgu yok."
                  filter={{
                    placeholder: 'rule / path / mesaj ara…',
                    predicate: (row, query) => `${row.rule ?? ''} ${row.path ?? ''} ${row.message ?? ''} ${row.toolId ?? ''}`.toLocaleLowerCase('tr').includes(query),
                  }}
                  initialSort={{ columnId: 'severity', direction: 'asc' }}
                />
              </Card>
            </>
          )}
        </AsyncState>
      </div>
    </>
  );
}
