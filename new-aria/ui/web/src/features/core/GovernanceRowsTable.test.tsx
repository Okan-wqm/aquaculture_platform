import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GovernanceRow } from '../../../../shared/api-contract.ts';
import { GovernanceRowsTable, governanceRowKey, type KeyedGovernanceRow } from './GovernanceRowsTable.tsx';
import { LedgerRowsTable } from './LedgerRowsTable.tsx';

function keyed(row: GovernanceRow, index: number): KeyedGovernanceRow {
  return { key: governanceRowKey(row, index), row };
}

const ROWS: ReadonlyArray<KeyedGovernanceRow> = [
  keyed({ at: '2026-09-01T09:00:00Z', schema_version: 1, ledger_hash: 'a'.repeat(64), previous_ledger_hash: null, event: 'cycle_started', details: { cycle_id: 'c-1' } }, 0),
  keyed({ at: '2026-09-01T09:05:00Z', schema_version: 1, ledger_hash: 'b'.repeat(64), previous_ledger_hash: 'a'.repeat(64), event: 'gate_failed', details: { gate: 'seal' } }, 1),
];

describe('GovernanceRowsTable', () => {
  it('names its columns in English and prints the event name exactly as the kernel emitted it', () => {
    render(<GovernanceRowsTable rows={ROWS} caption="Governance ledger rows" emptyMessage="unused" selectedKey={null} onSelect={vi.fn()} />);

    for (const header of ['Time', 'Event', 'Details', 'Ledger hash']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) })).toBeDefined();
    }
    expect(screen.getByText('cycle_started')).toBeDefined();
    expect(screen.getByText('gate_failed')).toBeDefined();
  });

  it('states what would appear when the tail is empty', () => {
    render(
      <GovernanceRowsTable
        rows={[]}
        caption="Governance ledger rows"
        emptyTitle="No governance rows yet"
        emptyMessage="Every decision the kernel records is appended here; nothing has been appended to this ledger yet."
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('No governance rows yet')).toBeDefined();
    expect(screen.getByText(/nothing has been appended to this ledger yet/)).toBeDefined();
  });
});

describe('LedgerRowsTable', () => {
  it('asks for a selection in English before a row is opened', () => {
    render(<LedgerRowsTable rows={[{ at: '2026-09-01T09:00:00Z', schema_version: 1, ledger_hash: 'c'.repeat(64), previous_ledger_hash: null, run_id: 'r-1' }]} caption="Cycle runs" emptyMessage="unused" />);

    expect(screen.getByRole('heading', { name: 'Row details' })).toBeDefined();
    expect(screen.getByText('No row selected')).toBeDefined();
    expect(screen.getByText(/Select a row in the table/)).toBeDefined();
    expect(screen.getByRole('columnheader', { name: /Fields/ })).toBeDefined();
  });
});
