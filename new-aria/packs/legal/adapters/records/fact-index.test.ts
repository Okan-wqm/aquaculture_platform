// Tests for the mechanical fact index.
//
// WHY: this module decides when the console tells a lawyer that two documents
// disagree. A false positive sends counsel chasing a conflict that is not there;
// a missed one leaves a real conflict invisible. Both failure modes are asserted
// here, and so is the rule that a contradiction row must always carry BOTH sides
// with their locators — a disagreement reported from one side only is an
// accusation, not evidence.
//
// WHAT: node:test cases. Run from `new-aria/`:
//   npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/records/fact-index.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  contradictions,
  documentReferencesIn,
  labelKeyOf,
  labelledFactsIn,
  missingReferences,
  type LabelledFact,
  type LocatedText,
  type ReferenceTarget,
} from './fact-index';

function line(relativePath: string, locator: string, text: string): LocatedText {
  return { documentId: `doc_${relativePath}`, relativePath, sha256: 'a'.repeat(64), locator, text };
}

function factsOf(relativePath: string, locator: string, text: string): LabelledFact[] {
  return labelledFactsIn(line(relativePath, locator, text));
}

test('a labelled date is read with its label, its locator and its precision', () => {
  const [fact] = factsOf('faktura.pdf', 'page:1', 'Fakturadato: 12.03.2024');
  assert.ok(fact);
  assert.equal(fact.label, 'Fakturadato');
  assert.equal(fact.labelKey, 'fakturadato');
  assert.equal(fact.kind, 'date');
  assert.equal(fact.value, '2024-03-12');
  assert.equal(fact.precision, 'day');
  assert.equal(fact.locator, 'page:1');
});

test('a labelled amount is normalised so three spellings of one sum compare equal', () => {
  const written = ['Beløp: kr 1.250.000,50', 'Beløp: NOK 1 250 000,50', 'Beløp: 1250000,50 kr'];
  const values = written.map((text) => factsOf('a.txt', 'line:1', text).find((fact) => fact.kind === 'amount')?.value);
  assert.deepEqual(values, ['nok 1250000.50', 'nok 1250000.50', 'nok 1250000.50']);
  // Currency is part of the value: the same number in another currency is not
  // the same amount, and collapsing them would invent an agreement.
  const euros = factsOf('a.txt', 'line:1', 'Beløp: EUR 1 250 000,50').find((fact) => fact.kind === 'amount');
  assert.equal(euros?.value, 'eur 1250000.50');
});

test('one line may state both a date and an amount, and both are recorded under the label', () => {
  const facts = factsOf('faktura.pdf', 'page:1', 'Forfall: 26. mars 2024, NOK 6 187 500,00');
  assert.deepEqual(
    facts.map((fact) => [fact.kind, fact.value]),
    [
      ['date', '2024-03-26'],
      ['amount', 'nok 6187500.00'],
    ],
  );
});

test('e-mail headers and prose colons are not read as labelled facts', () => {
  assert.deepEqual(factsOf('mail.eml', 'line:1', 'From: part.a@example.org'), []);
  assert.deepEqual(factsOf('mail.eml', 'line:2', 'Subject: faktura 2024-001'), []);
  // A sentence that happens to contain a colon has no short label before it.
  assert.deepEqual(factsOf('notat.md', 'line:9', 'Vi mener følgende om leveransen og dens mange forsinkelser: 12.03.2024'), []);
});

test('two documents stating different values under one label are a contradiction, and both sides travel', () => {
  const facts = [
    ...factsOf('faktura.pdf', 'page:1', 'Fakturadato: 12.03.2024'),
    ...factsOf('klage.docx', 'word/document.xml', 'Fakturadato: 14.03.2024'),
  ];
  const rows = contradictions(facts);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.ok(row);
  assert.equal(row.kind, 'date');
  assert.equal(row.label, 'Fakturadato');
  assert.equal(row.left.relativePath, 'faktura.pdf');
  assert.equal(row.left.locator, 'page:1');
  assert.equal(row.right.relativePath, 'klage.docx');
  assert.equal(row.right.locator, 'word/document.xml');
  assert.notEqual(row.left.value, row.right.value);
});

test('agreeing documents produce no contradiction, and neither does one document repeating itself', () => {
  const agreeing = [
    ...factsOf('faktura.pdf', 'page:1', 'Fakturadato: 12.03.2024'),
    ...factsOf('klage.docx', 'word/document.xml', 'Fakturadato: 2024-03-12'),
  ];
  assert.deepEqual(contradictions(agreeing), []);

  // A running header or a table restating a value inside ONE file is layout,
  // not a dispute between parties.
  const selfRepeating = [
    ...factsOf('rapport.pdf', 'page:1', 'Kontraktssum: NOK 4 950 000'),
    ...factsOf('rapport.pdf', 'page:4', 'Kontraktssum: NOK 5 100 000'),
  ];
  assert.deepEqual(contradictions(selfRepeating), []);
});

test('a month and a day inside that month are not in conflict: one is simply less precise', () => {
  const facts = [
    ...factsOf('avtale.txt', 'line:3', 'Oppstart: 15.01.2024'),
    ...factsOf('notat.md', 'line:2', 'Oppstart: januar 2024'),
  ];
  assert.deepEqual(contradictions(facts), []);
});

test('a reference to another document is read by date and by number', () => {
  const byDate = documentReferencesIn(line('faktura.pdf', 'page:1', 'Leveranse iht. avtale datert 2024-01-15, versjon 2.'));
  assert.deepEqual(
    byDate.map((reference) => [reference.kind, reference.identifier]),
    [['avtale', '2024-01-15']],
  );
  const byNumber = documentReferencesIn(line('klage.docx', 'word/document.xml', 'Vi viser til faktura nr. 2024-001.'));
  assert.deepEqual(
    byNumber.map((reference) => [reference.kind, reference.identifier]),
    [['faktura', '2024-001']],
  );
});

test('a reference the archive cannot satisfy is reported with the scope that was searched', () => {
  const references = documentReferencesIn(line('klage.docx', 'word/document.xml', 'Vi viser til avtale av 15.01.2024 og faktura nr. 2024-001.'));
  const targets: ReferenceTarget[] = [
    { documentId: 'doc_faktura.pdf', relativePath: 'faktura.pdf', fileName: 'faktura_2024-001.pdf', haystack: 'faktura nr. 2024-001', dates: new Set(['2024-03-12']) },
  ];
  const rows = missingReferences(references, targets);
  assert.equal(rows.length, 1, 'the invoice is present; the agreement is not');
  const [row] = rows;
  assert.ok(row);
  assert.equal(row.reference.kind, 'avtale');
  assert.equal(row.reference.identifier, '2024-01-15');
  assert.equal(row.searchedDocuments, 1);
  assert.equal(row.reference.relativePath, 'klage.docx', 'the row names the document that made the claim');
});

test('a reference is satisfied by a document that merely states the referenced date', () => {
  const references = documentReferencesIn(line('klage.docx', 'w', 'Vi viser til avtale av 15.01.2024.'));
  const targets: ReferenceTarget[] = [
    { documentId: 'doc_avtale.txt', relativePath: 'avtale.txt', fileName: 'avtale_v1.txt', haystack: '', dates: new Set(['2024-01-15']) },
  ];
  assert.deepEqual(missingReferences(references, targets), []);
});

test("a document naming itself in its own title line is not referring to a missing document", () => {
  // The head of faktura_2024-001.pdf reads "FAKTURA nr. 2024-001". Without this
  // rule every invoice in an archive would report its own absence.
  const references = documentReferencesIn(line('vedlegg/faktura_2024-001.pdf', 'page:1', 'FAKTURA nr. 2024-001'));
  assert.equal(references.length, 1);
  const targets: ReferenceTarget[] = [
    { documentId: 'doc_vedlegg/faktura_2024-001.pdf', relativePath: 'vedlegg/faktura_2024-001.pdf', fileName: 'faktura_2024-001.pdf', haystack: '', dates: new Set() },
  ];
  assert.deepEqual(missingReferences(references, targets), []);
});

test('a candidate must look like the kind referred to before its content may satisfy the reference', () => {
  const references = documentReferencesIn(line('faktura.pdf', 'page:1', 'Leveranse iht. avtale datert 2024-01-15.'));
  // A complaint that merely mentions the same date is not the agreement.
  const wrongKind: ReferenceTarget[] = [
    { documentId: 'doc_klage.docx', relativePath: 'klage.docx', fileName: 'klage_utkast.docx', haystack: 'avtale av 15.01.2024', dates: new Set(['2024-01-15']) },
  ];
  assert.equal(missingReferences(references, wrongKind).length, 1);
  // An agreement stating that date is.
  const rightKind: ReferenceTarget[] = [
    { documentId: 'doc_avtale.txt', relativePath: 'avtale.txt', fileName: 'avtale_v1.txt', haystack: '', dates: new Set(['2024-01-15']) },
  ];
  assert.deepEqual(missingReferences(references, rightKind), []);
});

test('a document does not satisfy its own reference', () => {
  const references = documentReferencesIn(line('avtale.txt', 'line:1', 'Denne avtale av 15.01.2024 gjelder…'));
  const targets: ReferenceTarget[] = [
    { documentId: 'doc_avtale.txt', relativePath: 'avtale.txt', fileName: 'avtale.txt', haystack: '', dates: new Set(['2024-01-15']) },
  ];
  assert.equal(missingReferences(references, targets).length, 1);
});

test('label keys ignore case, spacing and punctuation so one field is one field', () => {
  assert.equal(labelKeyOf('Forfallsdato'), labelKeyOf('forfalls dato'));
  assert.equal(labelKeyOf('Beløp eks. mva'), labelKeyOf('beløp eks mva'));
  assert.notEqual(labelKeyOf('Fakturadato'), labelKeyOf('Forfallsdato'));
});

test('the index is deterministic: the same input yields the same rows in the same order', () => {
  const facts = [
    ...factsOf('b.txt', 'line:1', 'Frist: 18.03.2024'),
    ...factsOf('a.txt', 'line:1', 'Frist: 20.03.2024'),
    ...factsOf('c.txt', 'line:1', 'Beløp: NOK 100'),
    ...factsOf('d.txt', 'line:1', 'Beløp: NOK 200'),
  ];
  assert.deepEqual(contradictions(facts), contradictions([...facts].reverse()));
  assert.deepEqual(
    contradictions(facts).map((row) => `${row.labelKey}:${row.left.relativePath}>${row.right.relativePath}`),
    ['beløp:c.txt>d.txt', 'frist:a.txt>b.txt'],
  );
});
