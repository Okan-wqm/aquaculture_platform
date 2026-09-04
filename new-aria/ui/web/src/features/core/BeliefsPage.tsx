import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { BeliefView } from '../../../../shared/api-contract.ts';
import { getBeliefs } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber, formatPercent, textOrEmpty } from '../../design/format.ts';
import { ByCountStats } from './ByCountStats.tsx';
import { EvidenceRefs } from './EvidenceRefs.tsx';
import { toneForStatus } from './tones.ts';

const STATUSES = ['supported', 'contradicted', 'needs_revalidation', 'stale', 'withdrawn'] as const;

const COLUMNS: ReadonlyArray<ColumnDef<BeliefView>> = [
  { id: 'id', header: 'belief_id', render: (row) => <span className="mono">{row.beliefId}</span>, sortValue: (row) => row.beliefId, nowrap: true },
  { id: 'statement', header: 'İfade', render: (row) => textOrEmpty(row.statement) },
  { id: 'status', header: 'status', render: (row) => <Badge tone={toneForStatus(row.status)}>{row.status}</Badge>, sortValue: (row) => row.status, nowrap: true },
  { id: 'confidence', header: 'Güven', render: (row) => formatPercent(row.confidence), sortValue: (row) => row.confidence, align: 'end' },
  { id: 'evidence', header: 'Kanıt referansları', render: (row) => <EvidenceRefs refs={row.evidenceRefs} /> },
  { id: 'verifiedAt', header: 'Doğrulandı', render: (row) => <Timestamp value={row.verifiedAt} />, sortValue: (row) => row.verifiedAt, nowrap: true },
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
];

export function BeliefsPage(): ReactNode {
  const [status, setStatus] = useState('');
  const { state, reload } = useRequest((signal) => getBeliefs({ status: status === '' ? undefined : status, limit: 500 }, signal), [status]);
  return (
    <>
      <PageHeader
        title="İnançlar"
        subtitle="memory/beliefs.jsonl · contradictions · uncertainties"
        actions={
          <>
            <label className="field field--inline" htmlFor="beliefs-status">
              <span>status</span>
              <select id="beliefs-status" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">(hepsi)</option>
                {STATUSES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button" onClick={reload}>
              Yenile
            </button>
          </>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(data) => (
          <div className="stack">
            <div className="stat-grid">
              <Stat label="Çelişki (contradictions)" value={formatNumber(data.contradictions)} tone={data.contradictions > 0 ? 'warning' : 'default'} />
              <Stat label="Belirsizlik (uncertainties)" value={formatNumber(data.uncertainties)} />
              <Stat label="Gösterilen inanç" value={formatNumber(data.beliefs.length)} />
            </div>
            <ByCountStats counts={data.byStatus} kind="status" emptyMessage="Durum dağılımı yok." />
            <Card flush>
              <DataTable
                columns={COLUMNS}
                rows={data.beliefs}
                rowKey={(row) => row.beliefId}
                caption="İnanç listesi"
                emptyMessage="Bu filtreyle inanç yok."
                filter={{
                  placeholder: 'ifade / id ara…',
                  predicate: (row, query) => `${row.beliefId} ${row.statement ?? ''} ${row.status}`.toLocaleLowerCase('tr').includes(query),
                }}
                initialSort={{ columnId: 'verifiedAt', direction: 'desc' }}
              />
            </Card>
          </div>
        )}
      </AsyncState>
    </>
  );
}
