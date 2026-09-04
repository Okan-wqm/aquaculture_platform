import { useState, type ReactNode } from 'react';
import type { HumanRequiredItem } from '../../../../shared/api-contract.ts';
import { getHumanRequired } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { formatNumber } from '../../design/format.ts';
import { toneForSeverity } from './tones.ts';

const COLUMNS: ReadonlyArray<ColumnDef<HumanRequiredItem>> = [
  { id: 'id', header: 'request_id', render: (row) => <span className="mono">{row.requestId}</span>, sortValue: (row) => row.requestId, nowrap: true },
  { id: 'severity', header: 'severity', render: (row) => <Badge tone={toneForSeverity(row.severity)}>{row.severity}</Badge>, sortValue: (row) => row.severity, nowrap: true },
  { id: 'reason', header: 'Gerekçe', render: (row) => row.reason },
  { id: 'recordedAt', header: 'Kaydedildi', render: (row) => <Timestamp value={row.recordedAt} />, sortValue: (row) => row.recordedAt, nowrap: true },
  {
    id: 'sla',
    header: 'SLA',
    render: (row) => (
      <span className="row">
        <Timestamp value={row.slaDeadline} />
        {row.slaBreached ? <Badge tone="danger">SLA aşıldı</Badge> : null}
      </span>
    ),
    sortValue: (row) => row.slaDeadline,
    nowrap: true,
  },
  {
    id: 'state',
    header: 'Durum',
    render: (row) => <Badge tone={row.resolved ? 'success' : 'warning'}>{row.resolved ? 'resolved' : 'open'}</Badge>,
    sortValue: (row) => (row.resolved ? 1 : 0),
    nowrap: true,
  },
];

export function HumanRequiredPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getHumanRequired(signal), []);
  const [showResolved, setShowResolved] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="İnsan Gerekli"
        subtitle="human-required/ · adjudications.jsonl"
        actions={
          <>
            <label className="field field--inline" htmlFor="hr-show-resolved">
              <input id="hr-show-resolved" type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} />
              <span>Çözülmüşleri de göster</span>
            </label>
            <button type="button" className="button" onClick={reload}>
              Yenile
            </button>
          </>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(data) => {
          const rows = showResolved ? data.items : data.items.filter((item) => !item.resolved);
          const breached = data.items.filter((item) => !item.resolved && item.slaBreached).length;
          const selected = data.items.find((item) => item.requestId === selectedId) ?? null;
          return (
            <div className="stack">
              <div className="stat-grid">
                <Stat label="Açık" value={formatNumber(data.open)} tone={data.open > 0 ? 'warning' : 'default'} />
                <Stat label="SLA aşılmış (açık)" value={formatNumber(breached)} tone={breached > 0 ? 'danger' : 'default'} />
                <Stat label="Toplam kayıt" value={formatNumber(data.items.length)} />
              </div>
              {breached > 0 ? (
                <Callout tone="danger" title="SLA aşılmış açık kayıt var" role="alert">
                  Operatör kararı bekleyen {formatNumber(breached)} kayıt SLA süresini geçti. Karar, kernel CLI ile adjudications ledger'ına yazılır; bu konsol yalnızca gösterir.
                </Callout>
              ) : null}
              <div className="split">
                <Card flush>
                  <DataTable
                    columns={COLUMNS}
                    rows={rows}
                    rowKey={(row) => row.requestId}
                    caption="İnsan kararı bekleyen kayıtlar"
                    emptyMessage={showResolved ? 'Kayıt yok.' : 'Açık kayıt yok.'}
                    filter={{
                      placeholder: 'gerekçe / id ara…',
                      predicate: (row, query) => `${row.requestId} ${row.reason} ${row.severity}`.toLocaleLowerCase('tr').includes(query),
                    }}
                    initialSort={{ columnId: 'recordedAt', direction: 'desc' }}
                    onRowActivate={(row) => setSelectedId(row.requestId)}
                    rowClassName={(row) => (row.requestId === selectedId ? 'row-selected' : row.slaBreached && !row.resolved ? 'row-danger' : row.resolved ? 'row-muted' : undefined)}
                  />
                </Card>
                <div className="detail-panel">
                  <Card title="Bağlam" subtitle={selected === null ? 'Bir kayıt seçin.' : selected.requestId}>
                    {selected === null ? <p className="muted">Seçim yok.</p> : <KeyValueList data={selected.context} emptyMessage="Bağlam alanı yok." expandObjects />}
                  </Card>
                </div>
              </div>
            </div>
          );
        }}
      </AsyncState>
    </>
  );
}
