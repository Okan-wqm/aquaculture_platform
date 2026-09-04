// Guards the epistemic discipline of the claim-evidence matrix.
//
// WHY: this module exists so a machine-produced claim can never read as a fact.
// That guarantee lives in the ROW: the kernel status word rendered verbatim, the
// asserting source, the supporting and contradicting counts, the missing
// evidence, the human-review marker, and the explicit "Not reviewed" where no
// human has signed off. A regression that dropped any of those would leave a
// table that still looks correct, so each one is asserted here per row.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { LegalStatement, LegalStatementsResponse } from '../../../../shared/legal-contract.ts';
import { StatementsMatrix } from './StatementsTab.tsx';

function statement(
  overrides: Partial<LegalStatement> & Pick<LegalStatement, 'statementId' | 'status' | 'assertedBy' | 'humanReviewRequired'>,
): LegalStatement {
  return {
    statement: `Statement ${overrides.statementId}`,
    assertedByPartyId: null,
    supportingSources: [],
    contradictingSources: [],
    missingEvidence: [],
    confidence: 0.5,
    verifiedBy: null,
    verifiedAt: null,
    relatedClaimIds: [],
    ...overrides,
  };
}

const RESPONSE: LegalStatementsResponse = {
  statements: [
    statement({
      statementId: 's-1',
      status: 'asserted',
      assertedBy: 'party',
      assertedByPartyId: 'p-claimant',
      humanReviewRequired: true,
      missingEvidence: ['signed contract'],
      confidence: 0.35,
    }),
    statement({
      statementId: 's-2',
      status: 'verified',
      assertedBy: 'court',
      humanReviewRequired: false,
      verifiedBy: 'reviewer@example',
      verifiedAt: '2026-09-01T00:00:00Z',
      supportingSources: [{ documentId: 'doc-9', locator: 'p.3', sha256: 'ff'.repeat(32) }],
      confidence: 0.95,
    }),
    statement({
      statementId: 's-3',
      status: 'contradicted',
      assertedBy: 'ai_inference',
      humanReviewRequired: true,
      contradictingSources: [{ documentId: 'doc-2', sha256: 'aa'.repeat(32) }],
      confidence: 0.2,
    }),
  ],
  byStatus: { asserted: 1, verified: 1, contradicted: 1 },
  needingReview: 2,
};

function renderMatrix(): void {
  render(
    <MemoryRouter>
      <StatementsMatrix response={RESPONSE} />
    </MemoryRouter>,
  );
}

function rowFor(statementId: string): HTMLElement {
  const table = screen.getByRole('table', { name: 'Claim-evidence matrix' });
  const row = within(table)
    .getAllByRole('row')
    .slice(1)
    .find((candidate) => candidate.textContent?.includes(`Statement ${statementId}`));
  if (row === undefined) {
    throw new Error(`row ${statementId} not rendered`);
  }
  return row;
}

describe('StatementsMatrix', () => {
  it('renders every kernel status verbatim and marks only the rows a human still has to review', () => {
    renderMatrix();
    const table = screen.getByRole('table', { name: 'Claim-evidence matrix' });
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(3);

    // An unverified party assertion: status, source, party, the named gap in the
    // evidence, and the two markers that keep it from reading as settled.
    const asserted = within(rowFor('s-1'));
    expect(asserted.getByText('asserted')).toBeDefined();
    expect(asserted.getByText('Human review required')).toBeDefined();
    expect(asserted.getByText('party')).toBeDefined();
    expect(asserted.getByText('p-claimant')).toBeDefined();
    expect(asserted.getByText('signed contract')).toBeDefined();
    expect(asserted.getByText('Not reviewed')).toBeDefined();
    // Nothing supports it and nothing contradicts it: both counts are stated
    // rather than left blank, so an empty cell can never pass for zero evidence.
    expect(asserted.getAllByText('0 sources')).toHaveLength(2);

    // The only status a human earns: the reviewer is named and the review marker
    // is absent, so `verified` is never claimed by the adapter alone.
    const verified = within(rowFor('s-2'));
    expect(verified.getByText('verified')).toBeDefined();
    expect(verified.queryByText('Human review required')).toBeNull();
    expect(verified.queryByText('Not reviewed')).toBeNull();
    expect(verified.getByText('reviewer@example')).toBeDefined();
    expect(verified.getByText('doc-9@p.3')).toBeDefined();
    expect(verified.getByText('1 source')).toBeDefined();

    // A machine inference that the evidence cuts against: the source stays
    // labelled ai_inference and the row carries the contradiction state.
    const contradicted = within(rowFor('s-3'));
    expect(contradicted.getByText('contradicted')).toBeDefined();
    expect(contradicted.getByText('ai_inference')).toBeDefined();
    expect(contradicted.getByText('Human review required')).toBeDefined();
    expect(contradicted.getByText('1 source')).toBeDefined();
    expect(rowFor('s-3').className).toContain('row-danger');
  });

  it('leads with the review backlog and the status distribution', () => {
    renderMatrix();
    expect(screen.getByText('Awaiting human review').nextElementSibling?.textContent).toBe('2');
    expect(screen.getByText('Statements').nextElementSibling?.textContent).toBe('3');
    expect(document.body.textContent).not.toContain('undefined');
  });
});
