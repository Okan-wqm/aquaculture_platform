// Tests for the mechanical fact index.
//
// WHY: this module decides when the console tells a lawyer that two documents
// disagree. A false positive sends counsel chasing a conflict that is not there;
// a missed one leaves a real conflict invisible. Both failure modes are asserted
// here, and so are the two rules that keep the index honest at archive scale:
// a contradiction needs a shared SUBJECT (a mechanical anchor), not merely a
// shared label; and a contradiction row always carries BOTH sides with their
// locators — a disagreement reported from one side only is an accusation.
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
  labelledFactsInLines,
  missingReferences,
  proseAmountFactsIn,
  selfSubjectKeysOf,
  subjectAnchorsOf,
  tabularFactsIn,
  type DocumentReference,
  type LabelledFact,
  type LocatedText,
  type ReferenceTarget,
  type SubjectAnchors,
} from './fact-index';

function line(relativePath: string, locator: string, text: string): LocatedText {
  return { documentId: `doc_${relativePath}`, relativePath, sha256: 'a'.repeat(64), locator, text };
}

function factsOf(relativePath: string, locator: string, text: string): LabelledFact[] {
  return labelledFactsIn(line(relativePath, locator, text));
}

/** Anchors for documents that all cite one reference: the shape of a dispute about one thing. */
function anchored(...relativePaths: string[]): SubjectAnchors {
  return new Map(relativePaths.map((relativePath) => [`doc_${relativePath}`, new Set(['faktura:2024-001'])]));
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
  assert.equal(fact.source, 'label');
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

test('a label may carry a digit ("Pkt 3 frist"), but a date followed by a colon is not a label', () => {
  const [fact] = factsOf('avtale.pdf', 'page:2', 'Pkt 3 frist: 30.04.2024');
  assert.equal(fact?.label, 'Pkt 3 frist');
  assert.equal(fact?.value, '2024-04-30');
  assert.deepEqual(factsOf('kronologi.txt', 'line:3', '12.03.2024: Part B bestrider faktura'), []);
});

test('e-mail headers and prose colons are not read as labelled facts', () => {
  assert.deepEqual(factsOf('mail.eml', 'line:1', 'From: part.a@example.org'), []);
  assert.deepEqual(factsOf('mail.eml', 'line:2', 'Subject: faktura 2024-001'), []);
  // A sentence that happens to contain a colon has no short label before it.
  assert.deepEqual(factsOf('notat.md', 'line:9', 'Vi mener følgende om leveransen og dens mange forsinkelser: 12.03.2024'), []);
});

test('a tab-separated table row names its item in the text cell and states dates and money in the others', () => {
  const rows = [
    line('kronologi.xlsx', 'sheet:Kronologi:1', 'Dato\tHendelse\tBeløp NOK'),
    line('kronologi.xlsx', 'sheet:Kronologi:2', '2024-01-15\tAvtale signert\t4950000'),
    line('kronologi.xlsx', 'sheet:Kronologi:3', '2024-03-04\tKlage sendt\t1200000'),
  ];
  const facts = tabularFactsIn(rows);
  assert.deepEqual(
    facts.map((fact) => [fact.label, fact.kind, fact.value, fact.source, fact.locator]),
    [
      ['Avtale signert', 'date', '2024-01-15', 'table', 'sheet:Kronologi:2'],
      ['Avtale signert', 'amount', 'nok 4950000', 'table', 'sheet:Kronologi:2'],
      ['Klage sendt', 'date', '2024-03-04', 'table', 'sheet:Kronologi:3'],
      ['Klage sendt', 'amount', 'nok 1200000', 'table', 'sheet:Kronologi:3'],
    ],
  );
  // A bare number under a column the header did not name as money is not an amount.
  const unnamed = tabularFactsIn([line('t.xlsx', 's:1', 'Post\tAntall'), line('t.xlsx', 's:2', 'Skruer\t4950000')]);
  assert.deepEqual(unnamed, []);
  // A DOCX table row carries its currency in the cell, so the header is not needed.
  const docx = tabularFactsIn([line('klage.docx', 'w:tbl', 'Prisavslag milepæl 2\tNOK 1 200 000')]);
  assert.deepEqual(docx.map((fact) => [fact.label, fact.value]), [['Prisavslag milepæl 2', 'nok 1200000']]);
});

test('a label alone on one line takes the short value on the next line (a PDF field table)', () => {
  const facts = labelledFactsInLines([
    line('skjema.pdf', 'page:1', 'Kontraktssum:'),
    line('skjema.pdf', 'page:1', 'NOK 4 950 000,00'),
    line('skjema.pdf', 'page:1', 'Oppstart:'),
    line('skjema.pdf', 'page:1', 'Dette avsnittet er et helt annet tema, uten noen verdi å lese, og skal ikke bli til et felt 15.01.2024 fordi det er prosa.'),
  ]);
  assert.deepEqual(
    facts.map((fact) => [fact.label, fact.kind, fact.value, fact.source]),
    [['Kontraktssum', 'amount', 'nok 4950000.00', 'split']],
  );
});

test('a sum stated in prose takes the noun before it as its label, and nothing when there is no noun', () => {
  const [fact] = proseAmountFactsIn(line('kontrakt.pdf', 'page:1', 'Kontraktssummen er avtalt til NOK 4 950 000 eks. mva.'));
  assert.equal(fact?.label, 'Kontraktssummen');
  assert.equal(fact?.value, 'nok 4950000');
  assert.equal(fact?.source, 'prose');
  const [claim] = proseAmountFactsIn(line('klage.docx', 'w', 'Fakturaen på NOK 25 000 datert 2024-03-10 bestrides.'));
  assert.equal(claim?.label, 'Fakturaen');
  assert.deepEqual(proseAmountFactsIn(line('x.txt', 'line:1', 'NOK 25 000')), [], 'an amount with nothing before it names nothing');
  assert.deepEqual(proseAmountFactsIn(line('x.txt', 'line:1', 'Beløp: NOK 25 000')), [], 'a labelled line is read by the label pass, not here');
});

test('two documents about the SAME subject stating different values under one label are a contradiction, and both sides travel', () => {
  const facts = [
    ...factsOf('faktura.pdf', 'page:1', 'Fakturadato: 12.03.2024'),
    ...factsOf('klage.docx', 'word/document.xml', 'Fakturadato: 14.03.2024'),
  ];
  const rows = contradictions(facts, new Map(), anchored('faktura.pdf', 'klage.docx'));
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.ok(row);
  assert.equal(row.kind, 'date');
  assert.equal(row.label, 'Fakturadato');
  assert.equal(row.anchor, 'faktura:2024-001');
  assert.equal(row.left.relativePath, 'faktura.pdf');
  assert.equal(row.left.locator, 'page:1');
  assert.equal(row.right.relativePath, 'klage.docx');
  assert.equal(row.right.locator, 'word/document.xml');
  assert.notEqual(row.left.value, row.right.value);
});

test('a shared label is not a shared subject: unrelated documents each stating their own value are not a dispute', () => {
  // MEASURED 2026-09-04: 400 unrelated letters produced 237,880 such rows.
  const facts = [
    ...factsOf('brev_001.txt', 'line:3', 'Beløp: NOK 103 978,00'),
    ...factsOf('brev_002.txt', 'line:3', 'Beløp: NOK 104 355,00'),
    ...factsOf('brev_003.txt', 'line:3', 'Beløp: NOK 99 100,00'),
  ];
  assert.deepEqual(contradictions(facts), [], 'no anchors, no contradictions');
  const disjoint: SubjectAnchors = new Map([
    ['doc_brev_001.txt', new Set(['faktura:2024-001'])],
    ['doc_brev_002.txt', new Set(['faktura:2024-002'])],
    ['doc_brev_003.txt', new Set(['faktura:2024-003'])],
  ]);
  assert.deepEqual(contradictions(facts, new Map(), disjoint), [], 'each cites its own invoice: three subjects, no dispute');
});

test('within one (label, subject) cluster the rows are one per distinct value against the first-stated value, not one per pair', () => {
  const facts = ['a', 'b', 'c', 'd', 'e'].flatMap((name, index) => factsOf(`${name}.txt`, 'line:1', `Kontraktssum: NOK ${4950000 + index * 1000}`));
  const rows = contradictions(facts, new Map(), anchored('a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'));
  assert.equal(rows.length, 4, 'five documents, four disagreements with the first — not ten pairs');
  assert.ok(rows.every((row) => row.left.relativePath === 'a.txt'));
  // Two documents agreeing with each other add no row.
  const agreeing = [...facts, ...factsOf('f.txt', 'line:1', 'Kontraktssum: NOK 4950000')];
  assert.equal(contradictions(agreeing, new Map(), anchored('a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt')).length, 4);
});

test('when the subject itself is in the archive, a disagreement is between what it states and what a citing document states of it', () => {
  // The invoice IS faktura:2024-001 by its own name; the complaint cites it.
  const selfKeys: SubjectAnchors = new Map([['doc_faktura_2024-001.txt', new Set(['faktura:2024-001'])]]);
  const anchors: SubjectAnchors = new Map([
    ['doc_faktura_2024-001.txt', new Set(['faktura:2024-001'])],
    ['doc_klage.txt', new Set(['faktura:2024-001'])],
    ['doc_brev.txt', new Set(['faktura:2024-001'])],
  ]);
  const stated = [
    ...factsOf('faktura_2024-001.txt', 'line:4', 'Fakturadato: 12.03.2024'),
    ...factsOf('klage.txt', 'line:5', 'Fakturadato: 14.03.2024'),
    ...factsOf('brev.txt', 'line:2', 'Fakturadato: 14.03.2024'),
  ];
  const rows = contradictions(stated, new Map(), anchors, selfKeys);
  assert.equal(rows.length, 1, 'one distinct differing value against the subject');
  assert.equal(rows[0]?.left.relativePath, 'faktura_2024-001.txt', 'the subject leads');
  assert.equal(rows[0]?.right.relativePath, 'brev.txt');

  // The subject states no `Beløp`: the citing documents' amounts are their own
  // facts, not claims about the invoice. Three hundred such letters are three
  // hundred amounts, not a dispute.
  const ownAmounts = [
    ...factsOf('klage.txt', 'line:6', 'Beløp: NOK 90 000,00'),
    ...factsOf('brev.txt', 'line:3', 'Beløp: NOK 91 000,00'),
  ];
  assert.deepEqual(contradictions(ownAmounts, new Map(), anchors, selfKeys), []);

  // With the subject absent from the archive, the citing documents may still
  // disagree with each other about it.
  assert.equal(contradictions(ownAmounts, new Map(), anchors, new Map()).length, 1);
});

test('self subject keys are read from a file name: kind word plus a date or a number', () => {
  assert.deepEqual(selfSubjectKeysOf('faktura_2024-001.pdf'), ['faktura:2024-001']);
  assert.deepEqual(selfSubjectKeysOf('avtale_2024-01-15.txt'), ['avtale:2024-01-15']);
  assert.deepEqual(selfSubjectKeysOf('avtale_v1.txt'), [], 'a version marker is not an identifier');
  assert.deepEqual(selfSubjectKeysOf('notat.md'), [], 'no kind word, no subject');
});

test('agreeing documents produce no contradiction, and neither does one document repeating itself', () => {
  const agreeing = [
    ...factsOf('faktura.pdf', 'page:1', 'Fakturadato: 12.03.2024'),
    ...factsOf('klage.docx', 'word/document.xml', 'Fakturadato: 2024-03-12'),
  ];
  assert.deepEqual(contradictions(agreeing, new Map(), anchored('faktura.pdf', 'klage.docx')), []);

  // A running header or a table restating a value inside ONE file is layout,
  // not a dispute between parties.
  const selfRepeating = [
    ...factsOf('rapport.pdf', 'page:1', 'Kontraktssum: NOK 4 950 000'),
    ...factsOf('rapport.pdf', 'page:4', 'Kontraktssum: NOK 5 100 000'),
  ];
  assert.deepEqual(contradictions(selfRepeating, new Map(), anchored('rapport.pdf')), []);
});

test('versions of one document are not in conflict with each other, even when anchored', () => {
  const facts = [
    ...factsOf('avtale_v1.txt', 'line:5', 'Pris: kr 125 000,00'),
    ...factsOf('avtale_v2_signert.txt', 'line:5', 'Pris: kr 120 000,00'),
  ];
  const groups = new Map([
    ['doc_avtale_v1.txt', 'vg_1'],
    ['doc_avtale_v2_signert.txt', 'vg_1'],
  ]);
  assert.deepEqual(contradictions(facts, groups, anchored('avtale_v1.txt', 'avtale_v2_signert.txt')), []);
});

test('a month and a day inside that month are not in conflict: one is simply less precise', () => {
  const facts = [
    ...factsOf('avtale.txt', 'line:3', 'Oppstart: 15.01.2024'),
    ...factsOf('notat.md', 'line:2', 'Oppstart: januar 2024'),
  ];
  assert.deepEqual(contradictions(facts, new Map(), anchored('avtale.txt', 'notat.md')), []);
});

test('subject anchors are the reference keys a document carries, whether it names itself or cites another', () => {
  const references: DocumentReference[] = [
    ...documentReferencesIn(line('vedlegg/faktura_2024-001.pdf', 'page:1', 'FAKTURA nr. 2024-001')),
    ...documentReferencesIn(line('vedlegg/faktura_2024-001.pdf', 'page:1', 'Leveranse iht. avtale datert 2024-01-15')),
    ...documentReferencesIn(line('klage.docx', 'w', 'Vi viser til avtale av 15.01.2024 og faktura 2024-001.')),
  ];
  const anchors = subjectAnchorsOf(references);
  assert.deepEqual([...(anchors.get('doc_vedlegg/faktura_2024-001.pdf') ?? [])].sort(), ['avtale:2024-01-15', 'faktura:2024-001']);
  assert.deepEqual([...(anchors.get('doc_klage.docx') ?? [])].sort(), ['avtale:2024-01-15', 'faktura:2024-001']);
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

test('a scanned or encrypted document still answers a reference by its NAME: present, not missing', () => {
  const references = documentReferencesIn(line('klage.docx', 'w', 'Vi viser til avtale av 15.01.2024.'));
  const unreadableByName: ReferenceTarget[] = [
    { documentId: 'doc_avtale_2024-01-15_skannet.pdf', relativePath: 'avtale_2024-01-15_skannet.pdf', fileName: 'avtale_2024-01-15_skannet.pdf', haystack: '', dates: new Set() },
  ];
  assert.deepEqual(missingReferences(references, unreadableByName), [], 'the file name carries the identifier');
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
  const anchors = anchored('a.txt', 'b.txt', 'c.txt', 'd.txt');
  assert.deepEqual(contradictions(facts, new Map(), anchors), contradictions([...facts].reverse(), new Map(), anchors));
  assert.deepEqual(
    contradictions(facts, new Map(), anchors).map((row) => `${row.labelKey}:${row.left.relativePath}>${row.right.relativePath}`),
    ['beløp:c.txt>d.txt', 'frist:a.txt>b.txt'],
  );
});
