import { useState, type ReactNode } from 'react';
import type { LedgerRow } from '../../../../shared/api-contract.ts';
import { Card } from '../../design/Card.tsx';
import { DataTable, type ColumnDef } from '../../design/DataTable.tsx';
import { KeyValueList } from '../../design/KeyValueList.tsx';
import { Timestamp } from '../../design/Timestamp.tsx';
import { compactJson, shortHash } from '../../design/format.ts';

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
  readonly emptyMessage: string;
}

/** Generic append-only ledger view: newest first, chain hash visible, full row in a side panel. */
export function LedgerRowsTable({ rows, caption, emptyMessage }: LedgerRowsTableProps): ReactNode {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const indexed: IndexedRow[] = rows.map((row, index) => ({ key: ledgerRowKey(row, index), row }));
  const selected = indexed.find((entry) => entry.key === selectedKey) ?? null;

  const columns: ReadonlyArray<ColumnDef<IndexedRow>> = [
    {
      id: 'at',
      header: 'Zaman',
      render: (entry) => <Timestamp value={typeof entry.row.at === 'string' ? entry.row.at : null} />,
      sortValue: (entry) => (typeof entry.row.at === 'string' ? entry.row.at : null),
      nowrap: true,
    },
    {
      id: 'summary',
      header: 'Alanlar',
      render: (entry) => <span className="mono">{summarise(entry.row)}</span>,
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
    <div className="split">
      <Card flush>
        <DataTable
          columns={columns}
          rows={indexed}
          rowKey={(entry) => entry.key}
          caption={caption}
          emptyMessage={emptyMessage}
          filter={{ placeholder: 'Alanlarda ara…', predicate: (entry, query) => summarise(entry.row).toLocaleLowerCase('tr').includes(query) }}
          initialSort={{ columnId: 'at', direction: 'desc' }}
          onRowActivate={(entry) => setSelectedKey(entry.key)}
          rowClassName={(entry) => (entry.key === selectedKey ? 'row-selected' : undefined)}
          dense
        />
      </Card>
      <div className="detail-panel">
        <Card title="Satır ayrıntısı" subtitle={selected === null ? 'Bir satır seçin (Enter / tık).' : undefined}>
          {selected === null ? (
            <p className="muted">Seçim yok.</p>
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
