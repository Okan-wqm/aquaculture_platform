import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { PressureView } from '../../../../shared/api-contract.ts';
import { getPressures } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { ROUTES } from '../../app/routes.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { EMPTY, formatNumber, textOrEmpty } from '../../design/format.ts';
import { toneForStatus } from './tones.ts';

const COLUMNS: ReadonlyArray<ColumnDef<PressureView>> = [
  {
    id: 'id',
    header: 'Pressure',
    headerTitle: 'pressure_id — the kernel identifier of the pressure',
    render: (row) => row.pressureId,
    sortValue: (row) => row.pressureId,
    mono: true,
    nowrap: true,
  },
  {
    id: 'source',
    header: 'Source',
    headerTitle: 'source — what generated the pressure',
    render: (row) => textOrEmpty(row.source),
    sortValue: (row) => row.source,
    filterValue: (row) => row.source ?? '',
    mono: true,
    nowrap: true,
  },
  {
    id: 'score',
    header: 'Score',
    headerTitle: 'score — the weight the kernel assigned to the pressure',
    render: (row) => formatNumber(row.score),
    sortValue: (row) => row.score,
    align: 'end',
    width: '10ch',
  },
  {
    id: 'state',
    header: 'State',
    headerTitle: 'state — where the pressure stands, as the kernel recorded it',
    render: (row) => (row.state === null ? <span className="muted">{EMPTY}</span> : <Badge tone={toneForStatus(row.state)}>{row.state}</Badge>),
    sortValue: (row) => row.state,
    filterValue: (row) => row.state ?? '',
    nowrap: true,
    width: '18ch',
  },
  {
    id: 'occurrences',
    header: 'Occurrences',
    headerTitle: 'occurrence_count — how often the pressure has recurred',
    render: (row) => formatNumber(row.occurrenceCount),
    sortValue: (row) => row.occurrenceCount,
    align: 'end',
    width: '13ch',
  },
  { id: 'summary', header: 'Summary', render: (row) => textOrEmpty(row.summary), filterValue: (row) => row.summary ?? '' },
  {
    id: 'cycle',
    header: 'Cycle',
    headerTitle: 'cycle_id — the cycle that recorded the pressure',
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
  {
    id: 'at',
    header: 'Time',
    headerTitle: 'at — when the pressure was last recorded',
    render: (row) => <Timestamp value={row.at} />,
    sortValue: (row) => row.at,
    nowrap: true,
    width: '16ch',
  },
];

/** Highest score in the page, so the tile answers "how hard is the worst one pushing?". */
function topScore(pressures: ReadonlyArray<PressureView>): number | null {
  let top: number | null = null;
  for (const pressure of pressures) {
    if (pressure.score !== null && (top === null || pressure.score > top)) {
      top = pressure.score;
    }
  }
  return top;
}

function distinctSources(pressures: ReadonlyArray<PressureView>): number {
  return new Set(pressures.map((pressure) => pressure.source ?? '')).size;
}

export function PressuresPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getPressures({ limit: 500 }, signal), []);
  return (
    <>
      <PageHeader
        title="Pressures"
        subtitle={<span className="mono">pressure/pressure-log.jsonl</span>}
        actions={
          <button type="button" className="button" onClick={reload}>
            Refresh
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load pressures">
        {(data) => (
          <div className="stack">
            <div className="stat-grid">
              <Stat label="Total" value={formatNumber(data.total)} hint="Pressures recorded in the log" />
              <Stat label="Shown" value={formatNumber(data.pressures.length)} hint="Rows returned by this request" />
              <Stat label="Highest score" value={formatNumber(topScore(data.pressures))} hint="Strongest pressure among the rows shown" />
              <Stat label="Sources" value={formatNumber(distinctSources(data.pressures))} hint="Distinct sources pushing on the kernel" />
            </div>
            <Card flush>
              <DataTable
                columns={COLUMNS}
                rows={data.pressures}
                rowKey={(row) => row.pressureId}
                caption="Pressures"
                emptyTitle="No pressures yet"
                emptyMessage="Every force the kernel felt — a recurring failure, an unmet promise, an operator demand — is logged here with its score; nothing has been logged yet."
                filter={{
                  placeholder: 'Search source, summary or state…',
                  predicate: (row, query) => `${row.pressureId} ${row.source ?? ''} ${row.summary ?? ''} ${row.state ?? ''}`.toLowerCase().includes(query),
                }}
                filterRow
                initialSort={{ columnId: 'score', direction: 'desc' }}
                maxHeight="62vh"
                countNoun="pressures"
              />
            </Card>
          </div>
        )}
      </AsyncState>
    </>
  );
}
