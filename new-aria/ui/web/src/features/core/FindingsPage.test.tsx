import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { FindingView, FindingsResponse } from '../../../../shared/api-contract.ts';
import { FindingsTable } from './FindingsPage.tsx';

function finding(overrides: Partial<FindingView> & Pick<FindingView, 'id' | 'severity'>): FindingView {
  return {
    toolId: 'ruff',
    runId: 'run-1',
    cycleId: 'cycle-7',
    rule: 'S101',
    path: 'aria_kernel/ledger.py',
    line: 42,
    message: 'Assertion used outside a test',
    evidenceRefs: ['ledger/governance.jsonl#L12'],
    at: '2026-09-01T10:00:00Z',
    feedback: null,
    ...overrides,
  };
}

const RESPONSE: FindingsResponse = {
  findings: [
    finding({ id: 'f-1', severity: 'CRITICAL' }),
    finding({ id: 'f-2', severity: 'LOW', rule: 'E501', path: null, line: null, evidenceRefs: [], feedback: 'false_positive' }),
  ],
  total: 2,
  bySeverity: { CRITICAL: 1, LOW: 1 },
};

const EMPTY_RESPONSE: FindingsResponse = { findings: [], total: 0, bySeverity: {} };

describe('FindingsTable', () => {
  it('labels every column in English while rendering kernel values verbatim', () => {
    render(
      <MemoryRouter>
        <FindingsTable data={RESPONSE} filtered={false} />
      </MemoryRouter>,
    );

    for (const header of ['Severity', 'Rule', 'Location', 'Message', 'Tool', 'Cycle', 'Evidence', 'Feedback', 'Time']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) })).toBeDefined();
    }
    // Scoped to the table because the severity tiles above it carry the same
    // kernel words, which is exactly the repetition the distribution is for.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('CRITICAL')).toBeDefined();
    expect(table.getByText('false_positive')).toBeDefined();
    expect(table.getByText('aria_kernel/ledger.py:42')).toBeDefined();
  });

  it('tints only the CRITICAL row, so colour marks a state rather than a rule', () => {
    render(
      <MemoryRouter>
        <FindingsTable data={RESPONSE} filtered={false} />
      </MemoryRouter>,
    );

    const rows = screen.getAllByRole('row').filter((row) => within(row).queryByText(/CRITICAL|LOW/) !== null);
    const critical = rows.find((row) => within(row).queryByText('CRITICAL') !== null);
    const low = rows.find((row) => within(row).queryByText('LOW') !== null);
    expect(critical?.className).toContain('row-danger');
    expect(low?.className ?? '').not.toContain('row-danger');
  });

  it('explains an empty result differently when a server filter is narrowing it', () => {
    const { unmount } = render(
      <MemoryRouter>
        <FindingsTable data={EMPTY_RESPONSE} filtered={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No findings yet')).toBeDefined();
    expect(screen.getByText(/Every defect a tool reported during a cycle is listed here/)).toBeDefined();
    unmount();

    render(
      <MemoryRouter>
        <FindingsTable data={EMPTY_RESPONSE} filtered />
      </MemoryRouter>,
    );
    expect(screen.getByText('No findings match this filter')).toBeDefined();
    expect(screen.getByText(/Widen the filter/)).toBeDefined();
  });
});
