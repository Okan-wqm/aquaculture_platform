// The ledger surface inventory: what the state manifest declares against what
// exists on disk and what the integrity index covers.
//
// WHY: an append-only ledger is only evidence while it is present AND indexed —
// a declared surface with no file has lost its history, and a present surface
// outside integrity_index.json is a chain nobody verifies. Those two failures
// are the reason this page exists, so they are counted and named above the
// table rather than left for the operator to find row by row. WHAT: a read-only
// table over GET /api/v1/ledgers; surface names and paths are kernel values and
// render verbatim.
import type { ReactNode } from 'react';
import type { LedgerSurfaceView } from '../../../../shared/api-contract.ts';
import { getLedgers } from '../../api/client.ts';
import { useRequest } from '../../api/use-request.ts';
import { AsyncState } from '../../design/AsyncState.tsx';
import { Badge } from '../../design/Badge.tsx';
import { Callout } from '../../design/Callout.tsx';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Icon } from '../../design/Icon.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { Stat } from '../../design/Stat.tsx';
import { EMPTY, formatBytes, formatNumber, shortHash } from '../../design/format.ts';

const COLUMNS: ReadonlyArray<ColumnDef<LedgerSurfaceView>> = [
  {
    id: 'name',
    header: 'Surface',
    headerTitle: 'The surface name the state manifest declares',
    render: (row) => row.name,
    sortValue: (row) => row.name,
    filterValue: (row) => row.name,
    mono: true,
    nowrap: true,
  },
  {
    id: 'path',
    header: 'Path',
    headerTitle: 'Path of the ledger file, relative to the ARIA state directory',
    render: (row) => row.relativePath,
    sortValue: (row) => row.relativePath,
    filterValue: (row) => row.relativePath,
    mono: true,
  },
  {
    id: 'present',
    header: 'Status',
    headerTitle: 'Whether the declared file exists on disk',
    render: (row) => <Badge tone={row.present ? 'success' : 'danger'} title={row.present ? 'The declared file exists on disk' : 'The manifest declares this surface but no file was found'}>{row.present ? 'present' : 'absent'}</Badge>,
    sortValue: (row) => (row.present ? 1 : 0),
    filterValue: (row) => (row.present ? 'present' : 'absent'),
    nowrap: true,
    width: '12ch',
  },
  {
    id: 'rows',
    header: 'Rows',
    headerTitle: 'Number of appended rows counted in the file',
    render: (row) => (row.rows === null ? <span className="muted">{EMPTY}</span> : formatNumber(row.rows)),
    sortValue: (row) => row.rows,
    align: 'end',
    nowrap: true,
    width: '10ch',
  },
  {
    id: 'bytes',
    header: 'Size',
    headerTitle: 'Size of the ledger file on disk',
    render: (row) => (row.bytes === null ? <span className="muted">{EMPTY}</span> : formatBytes(row.bytes)),
    sortValue: (row) => row.bytes,
    align: 'end',
    nowrap: true,
    width: '12ch',
  },
  {
    id: 'hash',
    header: 'Last hash',
    headerTitle: 'ledger_hash of the newest row — the head of the chain',
    render: (row) => <span title={row.lastHash ?? undefined}>{shortHash(row.lastHash, 16)}</span>,
    sortValue: (row) => row.lastHash,
    filterValue: (row) => row.lastHash ?? '',
    mono: true,
    nowrap: true,
    width: '20ch',
  },
  {
    id: 'indexed',
    header: 'Coverage',
    headerTitle: 'integrity_index.json — whether this surface is covered by the integrity index',
    render: (row) => (
      <Badge
        tone={row.indexed ? 'success' : 'warning'}
        title={row.indexed ? 'integrity verify checks this surface' : 'The surface is outside integrity_index.json, so its chain is never verified'}
      >
        {row.indexed ? 'indexed' : 'not indexed'}
      </Badge>
    ),
    sortValue: (row) => (row.indexed ? 1 : 0),
    filterValue: (row) => (row.indexed ? 'indexed' : 'not indexed'),
    nowrap: true,
    width: '14ch',
  },
];

/** Missing surfaces first, then present-but-unverified ones: colour marks the failure, not the row. */
function rowTint(row: LedgerSurfaceView): string | undefined {
  if (!row.present) {
    return 'row-danger';
  }
  return row.indexed ? undefined : 'row-warning';
}

export function LedgersPage(): ReactNode {
  const { state, reload } = useRequest((signal) => getLedgers(signal), []);
  return (
    <>
      <PageHeader
        title="Ledgers"
        subtitle="state_manifest surfaces · integrity_index.json"
        actions={
          <button type="button" className="button" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />
      <AsyncState state={state} onRetry={reload} skeleton="stats" errorTitle="Could not load the ledger surfaces">
        {(data) => {
          const present = data.surfaces.filter((surface) => surface.present);
          const missing = data.surfaces.filter((surface) => !surface.present);
          const unindexed = present.filter((surface) => !surface.indexed);
          const totalBytes = data.surfaces.reduce((sum, surface) => sum + (surface.bytes ?? 0), 0);
          const totalRows = data.surfaces.reduce((sum, surface) => sum + (surface.rows ?? 0), 0);
          return (
            <div className="stack">
              <div className="stat-grid">
                <Stat
                  label="Surfaces present"
                  value={`${formatNumber(present.length)} / ${formatNumber(data.surfaces.length)}`}
                  hint="Found on disk / declared by the manifest"
                  tone={missing.length > 0 ? 'danger' : 'default'}
                />
                <Stat label="Total rows" value={formatNumber(totalRows)} hint="Appended across every surface" />
                <Stat label="Total size" value={formatBytes(totalBytes)} hint="Ledger bytes on disk" />
                <Stat
                  label="Not indexed"
                  value={formatNumber(unindexed.length)}
                  hint="Present but outside integrity_index.json"
                  tone={unindexed.length > 0 ? 'warning' : 'default'}
                />
              </div>
              {missing.length > 0 ? (
                <Callout tone="danger" role="alert" title="Declared surfaces are missing on disk">
                  The state manifest declares {formatNumber(missing.length)} {missing.length === 1 ? 'surface' : 'surfaces'} that no file backs:{' '}
                  {missing.map((surface) => surface.name).join(', ')}. Either the surface has never been written, or its history has been lost.
                </Callout>
              ) : null}
              {unindexed.length > 0 ? (
                <Callout tone="warning" title="Surfaces outside the integrity index">
                  {formatNumber(unindexed.length)} present {unindexed.length === 1 ? 'surface is' : 'surfaces are'} absent from integrity_index.json:{' '}
                  {unindexed.map((surface) => surface.name).join(', ')}. Integrity verify does not check {unindexed.length === 1 ? 'that chain' : 'those chains'}.
                </Callout>
              ) : null}
              <Card flush>
                <DataTable
                  columns={COLUMNS}
                  rows={data.surfaces}
                  rowKey={(row) => row.name}
                  caption="Ledger surfaces declared by the state manifest"
                  emptyTitle="No surfaces declared"
                  emptyMessage="Every append-only ledger the kernel writes is declared in the state manifest; the manifest declares none."
                  filter={{
                    placeholder: 'Search surface or path…',
                    predicate: (row, query) => `${row.name} ${row.relativePath}`.toLowerCase().includes(query),
                  }}
                  filterRow
                  initialSort={{ columnId: 'name', direction: 'asc' }}
                  rowClassName={rowTint}
                  maxHeight="60vh"
                  countNoun="surfaces"
                  dense
                />
              </Card>
            </div>
          );
        }}
      </AsyncState>
    </>
  );
}
