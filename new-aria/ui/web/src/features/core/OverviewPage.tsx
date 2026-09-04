import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { OverviewResponse } from '../../../../shared/api-contract.ts';
import { getOverview } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatDuration, formatNumber, shortHash, textOrEmpty } from '../../design/format.ts';
import { glossForProfile, toneForProfile, toneForStatus } from './tones.ts';

type Breaker = OverviewResponse['breakers'][number];

const BREAKER_COLUMNS: ReadonlyArray<ColumnDef<Breaker>> = [
  { id: 'name', header: 'Kesici', render: (row) => <span className="mono">{row.name}</span>, sortValue: (row) => row.name },
  {
    id: 'state',
    header: 'state',
    render: (row) => <Badge tone={toneForStatus(row.state)}>{row.state}</Badge>,
    sortValue: (row) => row.state,
  },
  { id: 'rows', header: 'Satır', render: (row) => formatNumber(row.rows), sortValue: (row) => row.rows, align: 'end' },
];

export function OverviewContent({ data }: { readonly data: OverviewResponse }): ReactNode {
  const profileTone = toneForProfile(data.profile.current);
  return (
    <div className="stack">
      {data.killSwitch.engaged ? (
        <Callout tone="danger" title="Kill switch devrede" role="alert">
          <p>
            <code>ARIA_STOP</code> dosyası mevcut: çekirdek yeni döngü başlatmaz. Kaldırma yalnızca operatör tarafından, kernel CLI ile yapılır.
          </p>
        </Callout>
      ) : null}
      {data.budget.tripped ? (
        <Callout tone="warning" title="Bütçe kesicisi tetiklendi" role="alert">
          <KeyValueList data={data.budget.detail} emptyMessage="Ayrıntı yok." />
        </Callout>
      ) : null}

      <div className="stat-grid">
        <Stat
          label="Profil"
          value={
            <Badge tone={profileTone} title={glossForProfile(data.profile.current)}>
              {data.profile.current ?? EMPTY}
            </Badge>
          }
          hint={
            <>
              scheduler ceiling: <strong>{data.profile.schedulerCeiling ?? EMPTY}</strong>
            </>
          }
        />
        <Stat
          label="Kill switch"
          value={<Badge tone={data.killSwitch.engaged ? 'danger' : 'success'}>{data.killSwitch.engaged ? 'engaged' : 'clear'}</Badge>}
          tone={data.killSwitch.engaged ? 'danger' : 'default'}
        />
        <Stat
          label="Bütçe kesicisi"
          value={<Badge tone={data.budget.tripped ? 'danger' : 'success'}>{data.budget.tripped ? 'tripped' : 'ok'}</Badge>}
          tone={data.budget.tripped ? 'warning' : 'default'}
        />
        <Stat label="Döngü" value={formatNumber(data.counts.cycles)} />
        <Stat label="Ham bulgu" value={formatNumber(data.counts.rawFindings)} />
        <Stat label="İnanç" value={formatNumber(data.counts.beliefs)} />
        <Stat label="Basınç" value={formatNumber(data.counts.pressures)} />
        <Stat
          label="İnsan gerekli (açık)"
          value={formatNumber(data.counts.humanRequiredOpen)}
          tone={data.counts.humanRequiredOpen > 0 ? 'warning' : 'default'}
          hint={<Link to={ROUTES.humanRequired}>Listeye git</Link>}
        />
        <Stat label="Ajan isteği" value={formatNumber(data.counts.agentRequests)} />
        <Stat label="Yönetişim satırı" value={formatNumber(data.counts.governanceRows)} />
      </div>

      <div className="grid-2">
        <Card title="Çalışma profili" subtitle="runtime-profile.json">
          <KeyValueList
            data={{
              current: data.profile.current,
              schedulerCeiling: data.profile.schedulerCeiling,
              setBy: data.profile.setBy,
              setAt: data.profile.setAt,
            }}
          />
        </Card>

        <Card title="Son döngü" subtitle="cycles.jsonl">
          {data.lastCycle === null ? (
            <p className="muted">Henüz döngü kaydı yok.</p>
          ) : (
            <div className="stack">
              <div className="row">
                <Link to={ROUTES.cycle(data.lastCycle.cycleId)} className="mono">
                  {data.lastCycle.cycleId}
                </Link>
                <Badge tone={toneForStatus(data.lastCycle.status)}>{data.lastCycle.status}</Badge>
              </div>
              <KeyValueList
                data={{
                  startedAt: data.lastCycle.startedAt,
                  endedAt: data.lastCycle.endedAt,
                  duration: formatDuration(data.lastCycle.durationSeconds),
                  gitHeadSha: shortHash(data.lastCycle.gitHeadSha),
                  toolDecisionCount: data.lastCycle.toolDecisionCount,
                }}
              />
              <span className="muted">
                Bitiş: <Timestamp value={data.lastCycle.endedAt ?? data.lastCycle.startedAt} />
              </span>
            </div>
          )}
        </Card>

        <Card title="Kesiciler (breakers)" flush>
          <DataTable columns={BREAKER_COLUMNS} rows={data.breakers} rowKey={(row) => row.name} caption="Devre kesicileri" emptyMessage="Kayıtlı kesici yok." dense />
        </Card>

        <Card title="Gateway" subtitle="gateway/heartbeat.json · gateway/inbox.jsonl">
          {data.gateway === null ? (
            <p className="muted">Gateway verisi yok (heartbeat dosyası bulunamadı).</p>
          ) : (
            <div className="stat-grid">
              <Stat label="Heartbeat" value={<Timestamp value={data.gateway.heartbeatAt} />} hint={textOrEmpty(data.gateway.heartbeatAt)} />
              <Stat label="Inbox bekleyen" value={formatNumber(data.gateway.inboxPending)} tone={data.gateway.inboxPending > 0 ? 'warning' : 'default'} />
            </div>
          )}
        </Card>

        <Card title="Bütçe" subtitle="budget/breaker_state.json">
          <div className="stack">
            <Badge tone={data.budget.tripped ? 'danger' : 'success'}>{data.budget.tripped ? 'tripped' : 'not tripped'}</Badge>
            <KeyValueList data={data.budget.detail} emptyMessage="Bütçe ayrıntısı yok." />
          </div>
        </Card>

        <Card title="Kaynaklar">
          <KeyValueList data={{ toolsDir: data.toolsDir, workspaceRoot: data.workspaceRoot, generatedAt: data.generatedAt }} />
        </Card>
      </div>
    </div>
  );
}

export function OverviewPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getOverview(signal), []);
  return (
    <>
      <PageHeader
        title="Genel Bakış"
        subtitle={state.status === 'success' ? <span>Üretildi: <Timestamp value={state.data.generatedAt} /></span> : 'ARIA çekirdeğinin anlık durumu'}
        actions={
          <button type="button" className="button" onClick={reload}>
            Yenile
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload}>
        {(data) => <OverviewContent data={data} />}
      </AsyncState>
    </>
  );
}
