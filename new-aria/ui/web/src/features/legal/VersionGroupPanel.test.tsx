// Guards how a version lineage is presented.
//
// WHY: a version group that only says "these files belong together" leaves the
// lawyer to open both and compare by hand. What makes it useful is the change
// list — and what keeps it honest is that the panel never nominates a member as
// the one that governs. Both are asserted here, along with the two states a
// reader must be able to tell apart: a value that CHANGED and a value that only
// one version states at all.
//
// The fixture builder is deliberately NOT called `document`: a helper by that
// name shadows the DOM global inside this file, which is how the first run of
// these tests failed on `document.body`.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LegalDocument, LegalDocumentVersion } from '../../../../shared/legal-contract.ts';
import { VersionGroupPanel } from './DocumentsTab.tsx';

function legalDocument(documentId: string, fileName: string): LegalDocument {
  return {
    documentId,
    caseId: 'sak-24-001',
    relativePath: fileName,
    fileName,
    extension: '.txt',
    mediaType: 'text/plain',
    bytes: 100,
    sha256: 'a'.repeat(64),
    modifiedAt: null,
    kindGuess: 'DOCUMENT',
    kindConfidence: 0.3,
    extraction: 'text',
    excerpt: null,
    datesMentioned: [],
    amountsMentioned: [],
    versionGroupId: 'vg_0123456789ab',
    excludedReason: null,
  };
}

const DOCUMENTS = [legalDocument('doc_1111111111111111', 'avtale_v1.txt'), legalDocument('doc_2222222222222222', 'avtale_v2_signert.txt')];

const GROUP: LegalDocumentVersion = {
  versionGroupId: 'vg_0123456789ab',
  members: [
    { documentId: 'doc_1111111111111111', ordinal: 1, basis: 'name_suffix', similarityToPrevious: null },
    { documentId: 'doc_2222222222222222', ordinal: 2, basis: 'name_suffix', similarityToPrevious: 0.9 },
  ],
  signedMember: 'doc_2222222222222222',
  filedMember: null,
  steps: [
    {
      fromDocumentId: 'doc_1111111111111111',
      toDocumentId: 'doc_2222222222222222',
      values: [
        { label: 'Kontraktssum', kind: 'amount', from: 'nok 4950000', to: 'nok 5100000', fromLocator: 'line:2', toLocator: 'line:2' },
        { label: 'Forfallsdato', kind: 'date', from: null, to: '2024-08-15', fromLocator: null, toLocator: 'line:6' },
      ],
      addedLines: 4,
      removedLines: 3,
      unchangedLines: 12,
      humanReviewRequired: true,
    },
  ],
  humanReviewRequired: true,
};

describe('VersionGroupPanel', () => {
  it('names both files of a step and reports what moved between them', () => {
    render(<VersionGroupPanel group={GROUP} documents={DOCUMENTS} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('avtale_v1.txt → avtale_v2_signert.txt');
    expect(text).toContain('4 lines added');
    expect(text).toContain('3 removed');
    expect(text).toContain('12 unchanged');
    expect(text).toContain('Kontraktssum');
    expect(text).toContain('nok 4950000');
    expect(text).toContain('nok 5100000');
  });

  it('shows a value only one version states as "not stated", never as a change from nothing', () => {
    render(<VersionGroupPanel group={GROUP} documents={DOCUMENTS} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Forfallsdato');
    expect(text).toContain('not stated');
    expect(text).toContain('2024-08-15');
  });

  it('says a skipped line comparison was skipped rather than printing a made-up count', () => {
    const skipped: LegalDocumentVersion = {
      ...GROUP,
      steps: [{ ...(GROUP.steps[0] as (typeof GROUP.steps)[number]), unchangedLines: -1, addedLines: 0, removedLines: 0 }],
    };
    render(<VersionGroupPanel group={skipped} documents={DOCUMENTS} />);
    expect(document.body.textContent).toContain('line comparison skipped');
    expect(document.body.textContent).not.toContain('-1 unchanged');
  });

  it('never presents a member as authoritative, and says the comparison is mechanical', () => {
    render(<VersionGroupPanel group={GROUP} documents={DOCUMENTS} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('mechanical');
    expect(text).toContain('confirmed by a human reviewer');
    // "signed candidate" is what the file NAME suggests; it is never a verdict.
    expect(text).toContain('signed candidate');
    expect(text).not.toContain('authoritative');
  });

  it('explains an empty step list instead of rendering nothing', () => {
    const noSteps: LegalDocumentVersion = { ...GROUP, steps: [] };
    render(<VersionGroupPanel group={noSteps} documents={DOCUMENTS} />);
    expect(document.body.textContent).toContain('signedMember');
    expect(document.body.textContent).not.toContain('lines added');
  });
});
