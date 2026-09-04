// Tests for party candidates read out of document text.
//
// WHY: the rule this module must never break is that it does not merge. Deciding
// two spellings are one party is `party_identity_merge`, which the legal
// instance's approval policy reserves for a lawyer, and a tool that merged them
// quietly would destroy the very distinction a conflict-of-interest check
// depends on. Every test below either proves a reading or proves a refusal to
// conclude.
//
// WHAT: node:test cases. Run from `new-aria/`:
//   npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/records/party-candidates.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LocatedText } from './fact-index';
import { identityAmbiguities, partyCandidatesIn, partyNameKey } from './party-candidates';

function line(relativePath: string, locator: string, text: string): LocatedText {
  return { documentId: `doc_${relativePath}`, relativePath, sha256: 'a'.repeat(64), locator, text };
}

function namesIn(text: string): string[] {
  return partyCandidatesIn(line('a.txt', 'line:1', text)).map((candidate) => candidate.displayName);
}

test('an organisation is read from its legal form and located where it was found', () => {
  const [candidate] = partyCandidatesIn(line('faktura.pdf', 'page:1', 'Utstedt av: Nordlys Entreprenør AS'));
  assert.ok(candidate);
  assert.equal(candidate.displayName, 'Nordlys Entreprenør AS');
  assert.equal(candidate.kind, 'organization');
  assert.equal(candidate.basis, 'organisation_form');
  assert.equal(candidate.locator, 'page:1');
  assert.ok(candidate.confidence <= 0.5, 'a name in running text never outranks a header address');
});

test('an organisation number stated beside the name travels with it and lifts the basis', () => {
  const [candidate] = partyCandidatesIn(line('faktura.pdf', 'page:1', 'Nordlys Entreprenør AS (org.nr. 987 654 321)'));
  assert.ok(candidate);
  assert.equal(candidate.organisationNumber, '987654321');
  assert.equal(candidate.basis, 'organisation_number');
  assert.equal(candidate.confidence, 0.5);
});

test("counsel named with the v/ construction is read as a person, not as the party's own name", () => {
  const candidates = partyCandidatesIn(line('klage.docx', 'w', 'Bergen Eiendom ASA v/ advokat Kari Nordmann'));
  const counsel = candidates.find((candidate) => candidate.basis === 'counsel_construction');
  assert.ok(counsel);
  assert.equal(counsel.displayName, 'Kari Nordmann');
  assert.equal(counsel.kind, 'person');
  // The client is still read separately: both are in the line and both matter.
  assert.ok(candidates.some((candidate) => candidate.displayName === 'Bergen Eiendom ASA'));
});

test('a court names itself and is read as a court', () => {
  const [candidate] = partyCandidatesIn(line('dom.pdf', 'page:1', 'Bergen tingrett avsa dom i saken.'));
  assert.ok(candidate);
  assert.equal(candidate.kind, 'court');
});

test('a labelled party line is read once, not twice', () => {
  // The line matches both the label shape and the organisation shape; counting
  // it twice would double the party's weight in every downstream view.
  const candidates = partyCandidatesIn(line('avtale.txt', 'line:2', 'Byggherre: Bergen Eiendom ASA'));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.displayName, 'Bergen Eiendom ASA');
});

test('running prose without a party shape yields nothing rather than a guess', () => {
  assert.deepEqual(namesIn('Vi viser til tidligere korrespondanse i saken.'), []);
  assert.deepEqual(namesIn('Milepæl 2 er mangelfull.'), []);
  assert.deepEqual(namesIn('Beløp eks. mva: NOK 4 950 000,00'), []);
});

test('two spellings of one name are TWO candidates, and their similarity is only a question', () => {
  const candidates = [
    ...partyCandidatesIn(line('avtale.txt', 'line:1', 'Nordlys Entreprenør AS leverer.')),
    ...partyCandidatesIn(line('klage.docx', 'w', 'Nordlys Entreprenør ASA er ansvarlig.')),
  ];
  assert.equal(candidates.length, 2, 'nothing is merged');
  assert.notEqual(candidates[0]?.displayName, candidates[1]?.displayName);

  const ambiguities = identityAmbiguities(candidates);
  assert.equal(ambiguities.length, 1, 'the resemblance is raised as a question');
  assert.equal(ambiguities[0]?.left.displayName, 'Nordlys Entreprenør AS');
  assert.equal(ambiguities[0]?.right.displayName, 'Nordlys Entreprenør ASA');
});

test('the same spelling in two documents is one name, not an ambiguity', () => {
  const candidates = [
    ...partyCandidatesIn(line('a.txt', 'line:1', 'Bergen Eiendom ASA')),
    ...partyCandidatesIn(line('b.txt', 'line:1', 'Bergen Eiendom ASA')),
  ];
  assert.deepEqual(identityAmbiguities(candidates), []);
});

test('genuinely different parties are never paired as ambiguous', () => {
  const candidates = [
    ...partyCandidatesIn(line('a.txt', 'line:1', 'Bergen Eiendom ASA')),
    ...partyCandidatesIn(line('b.txt', 'line:1', 'Nordlys Entreprenør AS')),
  ];
  assert.deepEqual(identityAmbiguities(candidates), []);
});

test('the name key ignores the organisation form and punctuation, and nothing else', () => {
  assert.equal(partyNameKey('Nordlys Entreprenør AS'), partyNameKey('Nordlys Entreprenør ASA'));
  assert.equal(partyNameKey('Bergen Eiendom ASA'), partyNameKey('bergen eiendom'));
  assert.notEqual(partyNameKey('Bergen Eiendom ASA'), partyNameKey('Bergen Eiendomsdrift ASA'));
});

test('candidate extraction is deterministic', () => {
  const text = 'Partene: Bergen Eiendom ASA v/ advokat Kari Nordmann og Nordlys Entreprenør AS (org.nr. 987 654 321)';
  assert.deepEqual(partyCandidatesIn(line('a.txt', 'line:1', text)), partyCandidatesIn(line('a.txt', 'line:1', text)));
});
