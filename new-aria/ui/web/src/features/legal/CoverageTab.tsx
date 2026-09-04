// Coverage tab: the "every file has a fate" invariant, legal edition.
//
// WHY: an archive sweep that quietly skips a file is worse than one that fails,
// because the gap is invisible in every other tab. Coverage is therefore its own
// section: it states whether the fates account for the file count, and it lists
// each unreadable file by path and reason so the omission is nameable rather
// than merely absent.
// WHAT: the complete/incomplete verdict, the distribution over extraction
// statuses and record kinds, the roots the sweep excluded, and the unreadable
// files.
import type { ReactNode } from 'react';
import { EXTRACTION_STATUSES } from '../../../../shared/legal-contract.ts';
import { getLegalCoverage } from '../../api/legal-client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { EmptyState } from '../../design/EmptyState.tsx';
import { Stat } from '../../design/Stat.tsx';
import { formatNumber } from '../../design/format.ts';
import { useCaseContext } from './CaseDetailPage.tsx';
import { ExtractionBadge } from './legal-badges.tsx';

interface KindCount {
  readonly kind: string;
  readonly count: number;
}

interface UnreadableRow {
  readonly relativePath: string;
  readonly reason: string;
}

const KIND_COLUMNS: ReadonlyArray<ColumnDef<KindCount>> = [
  {
    id: 'kind',
    header: 'Kind',
    headerTitle: 'byKind — the record vocabulary term the adapter guessed for the file',
    render: (row) => row.kind,
    sortValue: (row) => row.kind,
    mono: true,
  },
  {
    id: 'count',
    header: 'Documents',
    headerTitle: 'How many documents carry this kind guess',
    render: (row) => formatNumber(row.count),
    sortValue: (row) => row.count,
    align: 'end',
    width: '13ch',
  },
];

const UNREADABLE_COLUMNS: ReadonlyArray<ColumnDef<UnreadableRow>> = [
  {
    id: 'path',
    header: 'Path',
    headerTitle: 'relativePath — where the file sits inside the archive root',
    render: (row) => row.relativePath,
    sortValue: (row) => row.relativePath,
    mono: true,
  },
  {
    id: 'reason',
    header: 'Reason',
    headerTitle: 'reason — why the bytes could not be read as text',
    render: (row) => row.reason,
    sortValue: (row) => row.reason,
  },
];

export function CoverageTab(): ReactNode {
  const { caseId } = useCaseContext();
  const { state, reload } = useRequest((signal) => getLegalCoverage(caseId, signal), [caseId]);
  return (
    <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load the coverage of this case">
      {({ coverage }) => {
        const kinds: KindCount[] = Object.entries(coverage.byKind).map(([kind, count]) => ({ kind, count }));
        // WHY: the invariant is arithmetic, so it is shown as arithmetic — the sum
        // of the recorded fates against the file count the sweep saw.
        const accounted = EXTRACTION_STATUSES.reduce((sum, status) => sum + (coverage.byExtraction[status] ?? 0), 0);
        return (
          <div className="stack">
            {coverage.complete ? (
              <Callout tone="success" title="Coverage is complete (complete = true)">
                Each of the {formatNumber(coverage.totalFiles)} files in this archive has a recorded fate: text extracted, metadata only, unreadable, or
                excluded from the sweep.
              </Callout>
            ) : (
              <Callout tone="danger" title="Coverage is incomplete (complete = false)" role="alert">
                Some files have no recorded fate: the sweep saw {formatNumber(coverage.totalFiles)} files and accounted for {formatNumber(accounted)}. A silent
                skip is not an acceptable outcome, so this adapter run has to be re-examined before the other tabs can be read as complete.
              </Callout>
            )}
            <div className="stat-grid">
              <Stat label="Total files" value={formatNumber(coverage.totalFiles)} hint="Seen by the sweep under the archive root" />
              {EXTRACTION_STATUSES.map((status) => (
                <Stat
                  key={status}
                  label={status}
                  value={formatNumber(coverage.byExtraction[status] ?? 0)}
                  hint={<ExtractionBadge status={status} />}
                  tone={status === 'unreadable' && (coverage.byExtraction[status] ?? 0) > 0 ? 'danger' : 'default'}
                />
              ))}
            </div>
            <div className="grid-2">
              <Card title="By kind guess" subtitle="Documents counted by the record kind the adapter guessed" flush>
                <DataTable
                  columns={KIND_COLUMNS}
                  rows={kinds}
                  rowKey={(row) => row.kind}
                  caption="Documents by kind guess"
                  countNoun="kinds"
                  emptyTitle="No kind guesses yet"
                  emptyMessage="Each record kind the adapter guessed would be counted here; this case has no documents to count."
                  initialSort={{ columnId: 'count', direction: 'desc' }}
                  dense
                />
              </Card>
              <Card title="Excluded roots" subtitle="Directories the sweep was told to leave out">
                {coverage.excludedRoots.length === 0 ? (
                  <EmptyState
                    title="No excluded roots"
                    message="A directory the sweep was configured to skip would be listed here; this run excluded none, so the whole archive was in scope."
                    flush
                  />
                ) : (
                  <ul className="chip-list">
                    {coverage.excludedRoots.map((root) => (
                      <li key={root} className="chip" title={root}>
                        {root}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card title="Unreadable files" subtitle="Each one raises a pressure record rather than being swallowed in silence" flush>
              <DataTable
                columns={UNREADABLE_COLUMNS}
                rows={coverage.unreadable}
                rowKey={(row) => row.relativePath}
                caption="Files whose bytes could not be read"
                countNoun="files"
                emptyTitle="No unreadable files"
                emptyMessage="A file whose bytes the adapter could not read would be listed here with its reason; every file in this archive was readable."
                filter={{
                  placeholder: 'Search path or reason…',
                  predicate: (row, query) => `${row.relativePath} ${row.reason}`.toLowerCase().includes(query),
                }}
                initialSort={{ columnId: 'path', direction: 'asc' }}
                rowClassName={() => 'row-danger'}
                dense
              />
            </Card>
          </div>
        );
      }}
    </AsyncState>
  );
}
