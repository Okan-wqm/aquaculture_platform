import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CycleDetailResponse } from '../../../../shared/api-contract.ts';
import { getCycle } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { formatDuration, formatNumber, shortHash } from '../../design/format.ts';
import { GovernanceRowsTable, governanceRowKey } from './GovernanceRowsTable.tsx';
import { LedgerRowsTable } from './LedgerRowsTable.tsx';
import { toneForStatus } from './tones.ts';

function CycleGovernance({ detail }: { readonly detail: CycleDetailResponse }): ReactNode {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const rows = detail.governance.map((row, index) => ({ key: governanceRowKey(row, index), row }));
  const selected = rows.find((entry) => entry.key === selectedKey) ?? null;
  return (
    <div className="split">
      <Card title="Bu döngünün yönetişim satırları" subtitle={`${formatNumber(rows.length)} satır`} flush>
        <GovernanceRowsTable rows={rows} caption="Döngü yönetişim satırları" emptyMessage="Bu döngü için yönetişim satırı yok." selectedKey={selectedKey} onSelect={setSelectedKey} />
      </Card>
      <div className="detail-panel">
        <Card title="Seçili satır">
          {selected === null ? <p className="muted">Bir satır seçin.</p> : <KeyValueList data={selected.row} expandObjects />}
        </Card>
      </div>
    </div>
  );
}

export function CycleDetailPage(): ReactNode {
  const { cycleId } = useParams<{ cycleId: string }>();
  const id = cycleId ?? '';
  const { state, reload } = useRequest((signal) => getCycle(id, signal), [id]);

  if (id === '') {
    return <Callout tone="danger">Döngü kimliği eksik.</Callout>;
  }

  return (
    <>
      <PageHeader
        title={id}
        breadcrumb={<Link to={ROUTES.cycles}>Döngüler</Link>}
        subtitle={state.status === 'success' ? <Badge tone={toneForStatus(state.data.cycle.status)}>{state.data.cycle.status}</Badge> : 'Döngü ayrıntısı'}
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(detail) => (
          <div className="stack">
            <div className="stat-grid">
              <Stat label="Başladı" value={<Timestamp value={detail.cycle.startedAt} />} hint={detail.cycle.startedAt ?? '—'} />
              <Stat label="Bitti" value={<Timestamp value={detail.cycle.endedAt} />} hint={detail.cycle.endedAt ?? '—'} />
              <Stat label="Süre" value={formatDuration(detail.cycle.durationSeconds)} />
              <Stat label="git HEAD" value={<span className="mono">{shortHash(detail.cycle.gitHeadSha, 10)}</span>} hint={detail.cycle.gitHeadSha ?? '—'} />
              <Stat label="Araç kararı" value={formatNumber(detail.cycle.toolDecisionCount)} />
              <Stat label="Koşu (run)" value={formatNumber(detail.runs.length)} />
            </div>

            <div className="grid-2">
              <Card title="Keşif tamamlanma kanıtı" subtitle="discovery/…/completion proof">
                {detail.discovery.completionProof === null ? (
                  <Callout tone="warning">Bu döngü için tamamlanma kanıtı yok — keşif kapanmamış veya dosya yazılmamış.</Callout>
                ) : (
                  <KeyValueList data={detail.discovery.completionProof} expandObjects />
                )}
              </Card>
              <Card title="Depo parmak izi" subtitle="discovery/…/repo fingerprint">
                <KeyValueList data={detail.discovery.repoFingerprint} emptyMessage="Parmak izi kaydı yok." expandObjects />
              </Card>
              <Card title="Döngü metrikleri" subtitle="cycle-metrics/">
                <KeyValueList data={detail.metrics} emptyMessage="Metrik kaydı yok." expandObjects />
              </Card>
            </div>

            <Card title="Koşular (runs.jsonl)" flush>
              <LedgerRowsTable rows={detail.runs} caption="Döngü koşuları" emptyMessage="Bu döngü için koşu satırı yok." />
            </Card>

            <CycleGovernance detail={detail} />
          </div>
        )}
      </AsyncState>
    </>
  );
}
