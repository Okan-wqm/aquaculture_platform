import { useState, type ReactNode } from 'react';
import type { LedgerRow } from '../../../../shared/api-contract.ts';
import { EmptyBlock } from '../../design/AsyncState.tsx';
import { Card } from '../../design/Card.tsx';
import { CopyButton } from '../../design/CopyButton.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { compactJson, shortHash } from '../../design/format.ts';

/** Fields every append-only ledger row carries; shown as the chain block, not as payload. */
const CHAIN_FIELDS = new Set(['at', 'schema_version', 'previous_ledger_hash', 'ledger_hash']);

export function ledgerRowKey(row: LedgerRow, index: number): string {
  return typeof row.ledger_hash === 'string' && row.ledger_hash !== '' ? row.ledger_hash : `${row.at ?? 'no-at'}-${index}`;
}

/** Non-chain fields of a row, for the compact summary column and the detail panel. */
export function ledgerRowPayload(row: LedgerRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!CHAIN_FIELDS.has(key)) {
      payload[key] = value;
    }
  }
  return payload;
}

function summarise(row: LedgerRow): string {
  const payload = ledgerRowPayload(row);
  return Object.entries(payload)
    .map(([key, value]) => `${key}=${compactJson(value, 40)}`)
    .join('  ');
}

interface IndexedRow {
  readonly key: string;
  readonly row: LedgerRow;
}

export interface LedgerRowsTableProps {
  readonly rows: ReadonlyArray<LedgerRow>;
  readonly caption: string;
  /** One sentence: what would appear here, and why it is empty. */
  readonly emptyMessage: string;
  readonly emptyTitle?: string | undefined;
}

/**
 * Generic append-only ledger view: newest first, chain hash visible, full row beside it.
 *
 * WHY: these ledgers have no fixed schema, so the table cannot promise columns —
 * what it can promise is the chain (time + hash) and a faithful one-line dump of
 * every remaining field. WHAT: selecting a row opens it in the detail panel with
 * the chain block separated from the payload and the hash copyable for tracing.
 */
export function LedgerRowsTable({ rows, caption, emptyMessage, emptyTitle }: LedgerRowsTableProps): ReactNode {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const indexed: IndexedRow[] = rows.map((row, index) => ({ key: ledgerRowKey(row, index), row }));
  const selected = indexed.find((entry) => entry.key === selectedKey) ?? null;
  const selectedHash = selected !== null && typeof selected.row.ledger_hash === 'string' ? selected.row.ledger_hash : null;

  const columns: ReadonlyArray<ColumnDef<IndexedRow>> = [
    {
      id: 'at',
      header: 'Time',
      headerTitle: 'at — when the row was appended',
      render: (entry) => <Timestamp value={typeof entry.row.at === 'string' ? entry.row.at : null} />,
      sortValue: (entry) => (typeof entry.row.at === 'string' ? entry.row.at : null),
      nowrap: true,
      width: '16ch',
    },
    {
      id: 'summary',
      header: 'Fields',
      headerTitle: 'Every field of the row except the chain fields',
      render: (entry) => <span className="mono">{summarise(entry.row)}</span>,
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
    <div className="split">
      <Card flush>
        <DataTable
          columns={columns}
          rows={indexed}
          rowKey={(entry) => entry.key}
          caption={caption}
          emptyMessage={emptyMessage}
          emptyTitle={emptyTitle}
          filter={{ placeholder: 'Search fields…', predicate: (entry, query) => summarise(entry.row).toLowerCase().includes(query) }}
          initialSort={{ columnId: 'at', direction: 'desc' }}
          onRowActivate={(entry) => setSelectedKey(entry.key)}
          selectedKey={selectedKey ?? undefined}
          maxHeight="62vh"
          countNoun="rows"
          dense
        />
      </Card>
      <div className="detail-panel">
        <Card
          title="Row details"
          actions={selectedHash === null ? undefined : <CopyButton value={selectedHash} label="Copy ledger hash" />}
        >
          {selected === null ? (
            <EmptyBlock title="No row selected" message="Select a row in the table — with a click or with Enter — to read every field it carries and the hash that chains it to the row before." flush />
          ) : (
            <div className="stack">
              <KeyValueList
                data={{
                  at: selected.row.at,
                  schema_version: selected.row.schema_version,
                  ledger_hash: selected.row.ledger_hash,
                  previous_ledger_hash: selected.row.previous_ledger_hash,
                }}
              />
              <KeyValueList data={ledgerRowPayload(selected.row)} expandObjects />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
