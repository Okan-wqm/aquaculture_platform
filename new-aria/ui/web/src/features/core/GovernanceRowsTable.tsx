import type { ReactNode } from 'react';
import type { GovernanceRow } from '../../../../shared/api-contract.ts';
import { Badge } from '../../design/Badge.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { compactJson, shortHash, EMPTY } from '../../design/format.ts';
import { toneForStatus } from './tones.ts';

export interface KeyedGovernanceRow {
  readonly key: string;
  readonly row: GovernanceRow;
}

/**
 * Stable identity for a governance row.
 *
 * WHY: the tail merges a REST page with an SSE stream, so a row must be
 * recognisable across both sources or it would appear twice. WHAT: the chain
 * hash is the identity when present; otherwise timestamp + event + arrival index.
 */
export function governanceRowKey(row: GovernanceRow, index: number): string {
  return typeof row.ledger_hash === 'string' && row.ledger_hash !== '' ? row.ledger_hash : `${row.at ?? 'no-at'}-${row.event}-${index}`;
}

export interface GovernanceRowsTableProps {
  readonly rows: ReadonlyArray<KeyedGovernanceRow>;
  readonly caption: string;
  /** One sentence: what would appear here, and why it is empty. */
  readonly emptyMessage: string;
  readonly emptyTitle?: string | undefined;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
  readonly toolbar?: ReactNode;
  /** Caps the scroll area so the sticky header stays inside the card. */
  readonly maxHeight?: string | undefined;
}

/**
 * Governance ledger rows.
 *
 * WHY: governance events are the record of what the kernel was permitted to do,
 * so the event name and the chain hash must both be visible without opening a
 * row. WHAT: the event name renders verbatim in a monospace badge tinted by its
 * outcome, the details object is compacted to one line, and the hash is
 * shortened with the full value in `title`.
 */
export function GovernanceRowsTable({ rows, caption, emptyMessage, emptyTitle, selectedKey, onSelect, toolbar, maxHeight = '62vh' }: GovernanceRowsTableProps): ReactNode {
  const columns: ReadonlyArray<ColumnDef<KeyedGovernanceRow>> = [
    {
      id: 'at',
      header: 'Time',
      headerTitle: 'at — when the kernel appended the row',
      render: (entry) => <Timestamp value={typeof entry.row.at === 'string' ? entry.row.at : null} />,
      sortValue: (entry) => (typeof entry.row.at === 'string' ? entry.row.at : null),
      nowrap: true,
      width: '16ch',
    },
    {
      id: 'event',
      header: 'Event',
      headerTitle: 'event — the governance event name, as the kernel emitted it',
      render: (entry) => (
        <Badge tone={toneForStatus(entry.row.event)} mono>
          {entry.row.event}
        </Badge>
      ),
      sortValue: (entry) => entry.row.event,
      nowrap: true,
    },
    {
      id: 'details',
      header: 'Details',
      headerTitle: 'details — the event payload, compacted to one line',
      render: (entry) => <span className="mono">{entry.row.details === undefined ? EMPTY : compactJson(entry.row.details, 200)}</span>,
    },
    {
      id: 'hash',
      header: 'Ledger hash',
      headerTitle: 'ledger_hash — the chain hash of this row',
      render: (entry) => (
        <span className="mono" title={typeof entry.row.ledger_hash === 'string' ? entry.row.ledger_hash : undefined}>
          {shortHash(typeof entry.row.ledger_hash === 'string' ? entry.row.ledger_hash : null)}
        </span>
      ),
      nowrap: true,
      width: '14ch',
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(entry) => entry.key}
      caption={caption}
      emptyMessage={emptyMessage}
      emptyTitle={emptyTitle}
      toolbar={toolbar}
      onRowActivate={(entry) => onSelect(entry.key)}
      selectedKey={selectedKey ?? undefined}
      maxHeight={maxHeight}
      countNoun="rows"
      dense
    />
  );
}
