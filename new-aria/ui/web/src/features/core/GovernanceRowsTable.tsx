import type { ReactNode } from 'react';
import type { GovernanceRow } from '../../../../shared/api-contract.ts';
import { Badge } from '../../design/Badge.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { compactJson, shortHash } from '../../design/format.ts';
import { toneForStatus } from './tones.ts';

export interface KeyedGovernanceRow {
  readonly key: string;
  readonly row: GovernanceRow;
}

export function governanceRowKey(row: GovernanceRow, index: number): string {
  return typeof row.ledger_hash === 'string' && row.ledger_hash !== '' ? row.ledger_hash : `${row.at ?? 'no-at'}-${row.event}-${index}`;
}

export interface GovernanceRowsTableProps {
  readonly rows: ReadonlyArray<KeyedGovernanceRow>;
  readonly caption: string;
  readonly emptyMessage: string;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
  readonly toolbar?: ReactNode;
}

/** Governance ledger rows: event name verbatim, details compacted, hash for chain tracing. */
export function GovernanceRowsTable({ rows, caption, emptyMessage, selectedKey, onSelect, toolbar }: GovernanceRowsTableProps): ReactNode {
  const columns: ReadonlyArray<ColumnDef<KeyedGovernanceRow>> = [
    {
      id: 'at',
      header: 'Zaman',
      render: (entry) => <Timestamp value={typeof entry.row.at === 'string' ? entry.row.at : null} />,
      sortValue: (entry) => (typeof entry.row.at === 'string' ? entry.row.at : null),
      nowrap: true,
    },
    {
      id: 'event',
      header: 'event',
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
      header: 'details',
      render: (entry) => <span className="mono">{entry.row.details === undefined ? '—' : compactJson(entry.row.details, 200)}</span>,
    },
    {
      id: 'hash',
      header: 'ledger_hash',
      render: (entry) => (
        <span className="mono" title={typeof entry.row.ledger_hash === 'string' ? entry.row.ledger_hash : undefined}>
          {shortHash(typeof entry.row.ledger_hash === 'string' ? entry.row.ledger_hash : null)}
        </span>
      ),
      nowrap: true,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(entry) => entry.key}
      caption={caption}
      emptyMessage={emptyMessage}
      toolbar={toolbar}
      onRowActivate={(entry) => onSelect(entry.key)}
      rowClassName={(entry) => (entry.key === selectedKey ? 'row-selected' : undefined)}
      dense
    />
  );
}
