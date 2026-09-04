// One cycle, joined from every ledger that recorded it.
//
// WHY: after a cycle the operator asks three questions in order — did discovery
// close, what did the kernel see (repo fingerprint, metrics), and what did it
// then do (runs, governance rows). The page follows that order top to bottom.
// WHAT: a read-only view over GET /api/v1/cycles/:cycleId. Kernel words render
// verbatim; only the labels around them are English.
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CycleDetailResponse } from '../../../../shared/api-contract.ts';
import { getCycle } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState, EmptyBlock } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { CopyButton } from '../../design/CopyButton.tsx';
import { Icon } from '../../design/Icon.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { SectionHeading } from '../../design/SectionHeading.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { formatDuration, formatNumber, shortHash, textOrEmpty } from '../../design/format.ts';
import { GovernanceRowsTable, governanceRowKey } from './GovernanceRowsTable.tsx';
import { LedgerRowsTable } from './LedgerRowsTable.tsx';
import { toneForStatus } from './tones.ts';

function CycleGovernance({ detail }: { readonly detail: CycleDetailResponse }): ReactNode {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const rows = detail.governance.map((row, index) => ({ key: governanceRowKey(row, index), row }));
  const selected = rows.find((entry) => entry.key === selectedKey) ?? null;
  return (
    <div className="split">
      <Card title="Governance rows in this cycle" subtitle={`${formatNumber(rows.length)} rows from governance.jsonl`} flush>
        <GovernanceRowsTable
          rows={rows}
          caption="Governance rows appended during this cycle"
          emptyTitle="No governance rows in this cycle"
          emptyMessage="Every gate the kernel passed or refused in this cycle appends a row here; it recorded none."
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
        />
      </Card>
      <div className="detail-panel">
        <Card title="Details">
          {selected === null ? (
            <EmptyBlock flush title="No row selected" message="Pick a governance row on the left to read its full record, including the ledger hash." />
          ) : (
            <KeyValueList data={selected.row} expandObjects />
          )}
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
    return (
      <>
        <PageHeader title="Cycle" breadcrumb={<Link to={ROUTES.cycles}>Cycles</Link>} />
        <Callout tone="danger" title="No cycle id in the address" role="alert">
          <p>
            This address carries no cycle id, so there is nothing to load. Open a cycle from the <Link to={ROUTES.cycles}>Cycles</Link> list.
          </p>
        </Callout>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={id}
        breadcrumb={<Link to={ROUTES.cycles}>Cycles</Link>}
        subtitle={
          state.status === 'success' ? (
            <Badge tone={toneForStatus(state.data.cycle.status)}>{state.data.cycle.status}</Badge>
          ) : (
            'Cycle details'
          )
        }
        actions={
          <>
            <CopyButton value={id} label="Copy cycle id" />
            <button type="button" className="button" onClick={reload}>
              <Icon name="refresh" />
              Refresh
            </button>
          </>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="detail" errorTitle="Could not load this cycle">
        {(detail) => (
          <div className="stack">
            <Card title="Cycle" subtitle="cycles.jsonl">
              <div className="stat-grid">
                <Stat label="Started" value={<Timestamp value={detail.cycle.startedAt} />} compact />
                <Stat label="Ended" value={<Timestamp value={detail.cycle.endedAt} />} compact />
                <Stat label="Duration" value={formatDuration(detail.cycle.durationSeconds)} />
                <Stat
                  label="git HEAD"
                  value={<span className="mono">{shortHash(detail.cycle.gitHeadSha, 10)}</span>}
                  hint={<span className="mono">{textOrEmpty(detail.cycle.gitHeadSha)}</span>}
                  compact
                />
                <Stat label="Tool decisions" value={formatNumber(detail.cycle.toolDecisionCount)} />
                <Stat label="Run rows" value={formatNumber(detail.runs.length)} hint="Rows this cycle appended to runs.jsonl" />
              </div>
            </Card>

            <div className="grid-2">
              <Card title="Discovery completion proof" subtitle="discovery/…/completion proof">
                {detail.discovery.completionProof === null ? (
                  <Callout tone="warning" title="No completion proof">
                    <p>Discovery did not close in this cycle, or the proof file was never written, so the cycle carries no evidence that it finished.</p>
                  </Callout>
                ) : (
                  <KeyValueList data={detail.discovery.completionProof} expandObjects />
                )}
              </Card>
              <Card title="Repo fingerprint" subtitle="discovery/…/repo fingerprint">
                <KeyValueList
                  data={detail.discovery.repoFingerprint}
                  emptyMessage="The tree the kernel measured at the start of this cycle appears here; no fingerprint was recorded."
                  expandObjects
                />
              </Card>
              <Card title="Cycle metrics" subtitle="cycle-metrics/">
                <KeyValueList
                  data={detail.metrics}
                  emptyMessage="Per-phase counters and timings appear here once the kernel writes a metrics file for this cycle."
                  expandObjects
                />
              </Card>
            </div>

            {/* WHY: LedgerRowsTable already renders its own card and detail panel, so
                the page gives it a heading rather than nesting it inside a Card. */}
            <section className="stack--tight">
              <SectionHeading title="Runs" description="runs.jsonl — one row per tool run in this cycle" />
              <LedgerRowsTable
                rows={detail.runs}
                caption="Tool runs recorded during this cycle"
                emptyTitle="No runs in this cycle"
                emptyMessage="Each tool the kernel ran in this cycle appends a row here; it ran none."
              />
            </section>

            <CycleGovernance detail={detail} />
          </div>
        )}
      </AsyncState>
    </>
  );
}
