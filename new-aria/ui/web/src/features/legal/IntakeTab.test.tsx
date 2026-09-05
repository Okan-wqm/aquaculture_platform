// Guards what the intake receipt is for.
//
// WHY: this tab is the console's answer to "can you show this file reached you
// unchanged?". That answer rests on three things being visible and correct: the
// digest measured at arrival, the verdict of re-walking the receipt chain, and
// an explicit statement when no custody record exists at all. A regression that
// dropped any of them would leave a table that still looks like a receipt while
// proving nothing, so each is asserted here.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LegalIntakeRecord, LegalIntakeResponse } from '../../../../shared/legal-contract.ts';
import { IntakeReceipt } from './IntakeTab.tsx';

function record(overrides: Partial<LegalIntakeRecord> & Pick<LegalIntakeRecord, 'relativePath' | 'sha256' | 'rowHash'>): LegalIntakeRecord {
  return {
    schemaVersion: 2,
    caseId: 'sak-24-001',
    fileName: overrides.relativePath,
    bytes: 2048,
    receivedAt: '2026-09-04T12:00:00.000Z',
    receivedBy: 'operator',
    sourceNote: null,
    previousRowHash: null,
    keyId: 'abcdef0123456789',
    signature: 'c2lnbmF0dXJl',
    ...overrides,
  };
}

const INTACT = { status: 'intact' as const, valid: true, rows: 2, brokenAt: null, reason: null, anchored: true, keyId: 'abcdef0123456789' };

const FIRST = record({ relativePath: 'vedlegg/faktura_2024-001.pdf', sha256: 'a'.repeat(64), rowHash: 'c'.repeat(64) });
const SECOND = record({
  relativePath: 'korrespondanse/2024-03-04.eml',
  sha256: 'b'.repeat(64),
  rowHash: 'd'.repeat(64),
  previousRowHash: 'c'.repeat(64),
  receivedAt: '2026-09-04T12:05:00.000Z',
  sourceNote: 'Counsel bundle, disc 1',
  bytes: 4096,
});

function response(overrides: Partial<LegalIntakeResponse> = {}): LegalIntakeResponse {
  return {
    caseMeta: {
      caseId: 'sak-24-001',
      title: 'Bergen Eiendom v Nordlys',
      jurisdiction: 'NO',
      courtReference: null,
      custodian: 'Advokat Kari Nordmann',
      createdAt: '2026-09-04T11:00:00.000Z',
      createdBy: 'operator',
    },
    intake: [FIRST, SECOND],
    chain: INTACT,
    ...overrides,
  };
}

function rowFor(path: string): HTMLElement {
  const cell = screen.getByText(path);
  const row = cell.closest('tr');
  if (row === null) throw new Error(`no row for ${path}`);
  return row;
}

describe('IntakeReceipt', () => {
  it('records for every arrival the digest, the size, who took delivery and any stated source', () => {
    render(<IntakeReceipt data={response()} />);

    const invoice = within(rowFor('vedlegg/faktura_2024-001.pdf'));
    // The digest is shown abbreviated; the full value stays copyable.
    expect(invoice.getByText(/aaaaaaa/)).toBeDefined();
    expect(invoice.getByText('operator')).toBeDefined();

    const email = within(rowFor('korrespondanse/2024-03-04.eml'));
    expect(email.getByText('Counsel bundle, disc 1')).toBeDefined();

    expect(screen.getByText('Documents received').nextElementSibling?.textContent).toBe('2');
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('states the chain is intact when every row hashes to its recorded value', () => {
    render(<IntakeReceipt data={response()} />);
    expect(screen.getByText('Receipt chain').nextElementSibling?.textContent).toBe('intact');
    expect(screen.queryByText('The intake receipt does not verify')).toBeNull();
  });

  it('raises an alert naming the broken row and the reason when the receipt was edited', () => {
    render(
      <IntakeReceipt
        data={response({ chain: { status: 'broken', valid: false, rows: 2, brokenAt: 1, reason: 'row_hash_mismatch', anchored: false, keyId: 'abcdef0123456789' } })}
      />,
    );
    expect(screen.getByText('Receipt chain').nextElementSibling?.textContent).toBe('broken');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Row 2');
    expect(alert.textContent).toContain('row_hash_mismatch');
    // The console must not soften this into a warning about the data: the
    // custody claim itself is what stops being provable.
    expect(alert.textContent).toContain('unproven');
  });

  it('says plainly when documents exist with no custody record behind them', () => {
    render(<IntakeReceipt data={response({ caseMeta: null })} />);
    expect(screen.getByText('No custody record for this case')).toBeDefined();
    expect(screen.queryByText('Custody')).toBeNull();
  });

  it('explains an empty receipt rather than printing an empty table, and never calls it intact', () => {
    render(<IntakeReceipt data={response({ intake: [], chain: { status: 'empty', valid: true, rows: 0, brokenAt: null, reason: null, anchored: false, keyId: 'abcdef0123456789' } })} />);
    expect(screen.getByText('Nothing has been taken in yet')).toBeDefined();
    expect(screen.getByText('Documents received').nextElementSibling?.textContent).toBe('0');
    // MEASURED 2026-09-04: zero rows used to read "intact". An empty receipt
    // proves nothing, and the console must not lend it the word.
    expect(screen.getByText('Receipt chain').nextElementSibling?.textContent).toBe('empty');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the head commitment, not a row, when the ledger was cut short or re-written', () => {
    render(
      <IntakeReceipt
        data={response({ chain: { status: 'broken', valid: false, rows: 2, brokenAt: null, reason: 'head_mismatch:truncated', anchored: false, keyId: 'abcdef0123456789' } })}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The signed head commitment');
    expect(alert.textContent).toContain('head_mismatch:truncated');
    expect(alert.textContent).not.toContain('Row 1');
  });
});
