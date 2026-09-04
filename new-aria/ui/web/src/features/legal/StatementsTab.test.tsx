import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { LegalStatement, LegalStatementsResponse } from '../../../../shared/legal-contract.ts';
import { StatementsMatrix } from './StatementsTab.tsx';

function statement(overrides: Partial<LegalStatement> & Pick<LegalStatement, 'statementId' | 'status' | 'assertedBy' | 'humanReviewRequired'>): LegalStatement {
  return {
    statement: `İfade ${overrides.statementId}`,
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
      missingEvidence: ['imzalı sözleşme'],
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

describe('StatementsMatrix', () => {
  it('shows every status verbatim as a badge and the human-review marker only where required', () => {
    render(
      <MemoryRouter>
        <StatementsMatrix response={RESPONSE} />
      </MemoryRouter>,
    );
    const table = screen.getByRole('table', { name: 'İddia–kanıt matrisi' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);

    const byId = (id: string): HTMLElement => {
      const row = rows.find((candidate) => candidate.textContent?.includes(`İfade ${id}`));
      if (row === undefined) {
        throw new Error(`row ${id} not rendered`);
      }
      return row;
    };

    expect(within(byId('s-1')).getByText('asserted')).toBeDefined();
    expect(within(byId('s-1')).getByText('insan doğrulaması gerekli')).toBeDefined();
    expect(within(byId('s-1')).getByText('party')).toBeDefined();
    expect(within(byId('s-1')).getByText('p-claimant')).toBeDefined();
    expect(within(byId('s-1')).getByText('imzalı sözleşme')).toBeDefined();
    expect(within(byId('s-1')).getByText('doğrulanmadı')).toBeDefined();

    expect(within(byId('s-2')).getByText('verified')).toBeDefined();
    expect(within(byId('s-2')).queryByText('insan doğrulaması gerekli')).toBeNull();
    expect(within(byId('s-2')).getByText('reviewer@example')).toBeDefined();
    expect(within(byId('s-2')).getByText('doc-9@p.3')).toBeDefined();

    expect(within(byId('s-3')).getByText('contradicted')).toBeDefined();
    expect(within(byId('s-3')).getByText('ai_inference')).toBeDefined();
    expect(within(byId('s-3')).getByText('insan doğrulaması gerekli')).toBeDefined();
    expect(byId('s-3').className).toContain('row-danger');
  });

  it('surfaces the review backlog count and status totals', () => {
    render(
      <MemoryRouter>
        <StatementsMatrix response={RESPONSE} />
      </MemoryRouter>,
    );
    expect(screen.getByText('İnsan doğrulaması bekleyen').nextElementSibling?.textContent).toBe('2');
    expect(document.body.textContent).not.toContain('undefined');
  });
});
