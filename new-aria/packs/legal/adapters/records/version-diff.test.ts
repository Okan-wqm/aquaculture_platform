// Tests for the version comparison.
//
// WHY: a version group tells a lawyer two files belong together; this module is
// what makes that useful by saying what moved. The guarantees asserted here are
// that a changed value quotes BOTH versions with their locators, that a value
// present in one version and absent from the other is reported as such rather
// than as a change from nothing, and that the comparison never nominates a
// version as authoritative — that is a lawyer's declaration, not a derived fact.
//
// WHAT: node:test cases. Run from `new-aria/`:
//   npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/records/version-diff.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { labelledFactsIn, type LabelledFact, type LocatedText } from './fact-index';
import { diffVersions, type VersionSide } from './version-diff';

function side(relativePath: string, text: string): VersionSide {
  const facts: LabelledFact[] = [];
  text.split('\n').forEach((line, index) => {
    const located: LocatedText = {
      documentId: `doc_${relativePath}`,
      relativePath,
      sha256: 'a'.repeat(64),
      locator: `line:${index + 1}`,
      text: line,
    };
    facts.push(...labelledFactsIn(located));
  });
  return { text, facts };
}

const V1 = side(
  'avtale_v1.txt',
  ['AVTALE om totalentreprise', 'Kontraktssum: NOK 4 950 000', 'Ferdigstillelse: 30.06.2024', 'Dagmulkt: 0,15 % per kalenderdag', 'Partene er enige om leveransen.'].join('\n'),
);

const V2 = side(
  'avtale_v2_signert.txt',
  ['AVTALE om totalentreprise', 'Kontraktssum: NOK 5 100 000', 'Ferdigstillelse: 31.07.2024', 'Dagmulkt: 0,15 % per kalenderdag', 'Partene er enige om leveransen.', 'Forfallsdato: 15.08.2024'].join('\n'),
);

test('a value both versions state differently is reported with both readings and both locators', () => {
  const diff = diffVersions(V1, V2);
  const sum = diff.changedValues.find((change) => change.labelKey === 'kontraktssum');
  assert.ok(sum, 'the contract sum changed and must be reported');
  assert.equal(sum.kind, 'amount');
  assert.equal(sum.from, 'nok 4950000');
  assert.equal(sum.to, 'nok 5100000');
  assert.equal(sum.fromLocator, 'line:2');
  assert.equal(sum.toLocator, 'line:2');

  const completion = diff.changedValues.find((change) => change.labelKey === 'ferdigstillelse');
  assert.ok(completion);
  assert.equal(completion.kind, 'date');
  assert.equal(completion.from, '2024-06-30');
  assert.equal(completion.to, '2024-07-31');
});

test('a value only the later version states is an addition, not a change from nothing', () => {
  const diff = diffVersions(V1, V2);
  assert.deepEqual(
    diff.addedValues.map((value) => [value.labelKey, value.value]),
    [['forfallsdato', '2024-08-15']],
  );
  assert.deepEqual(diff.removedValues, []);
  assert.ok(!diff.changedValues.some((change) => change.labelKey === 'forfallsdato'), 'an addition is never dressed up as a change');
});

test('a value only the earlier version states is a removal', () => {
  const diff = diffVersions(V2, V1);
  assert.deepEqual(
    diff.removedValues.map((value) => [value.labelKey, value.value]),
    [['forfallsdato', '2024-08-15']],
  );
  assert.deepEqual(diff.addedValues, []);
});

test('unchanged values are silent: only what moved is reported', () => {
  const diff = diffVersions(V1, V2);
  assert.ok(!diff.changedValues.some((change) => change.labelKey === 'dagmulkt'));
  assert.equal(diff.changedValues.length, 2);
});

test('the line diff names the sentences that arrived and left, and counts what stayed', () => {
  const diff = diffVersions(V1, V2);
  assert.ok(diff.addedLines.includes('Forfallsdato: 15.08.2024'));
  assert.ok(diff.addedLines.includes('Kontraktssum: NOK 5 100 000'));
  assert.ok(diff.removedLines.includes('Kontraktssum: NOK 4 950 000'));
  assert.ok(!diff.addedLines.includes('Partene er enige om leveransen.'), 'an untouched sentence is not reported as new');
  assert.equal(diff.unchangedLines, 3, 'title, dagmulkt and the agreement sentence carried over');
});

test('identical versions produce an empty diff rather than a list of everything', () => {
  const diff = diffVersions(V1, V1);
  assert.deepEqual(diff.changedValues, []);
  assert.deepEqual(diff.addedValues, []);
  assert.deepEqual(diff.removedValues, []);
  assert.deepEqual(diff.addedLines, []);
  assert.deepEqual(diff.removedLines, []);
  assert.equal(diff.unchangedLines, 5);
});

test('page markers are not diffed as content: they are locators, not text', () => {
  const withPages = side('a.pdf', ['\f[page 1]', 'Kontraktssum: NOK 100', '\f[page 2]', 'Slutt.'].join('\n'));
  const withoutPages = side('b.txt', ['Kontraktssum: NOK 100', 'Slutt.'].join('\n'));
  const diff = diffVersions(withPages, withoutPages);
  assert.deepEqual(diff.addedLines, []);
  assert.deepEqual(diff.removedLines, []);
  assert.equal(diff.unchangedLines, 2);
});

test('a version pair too large to diff still compares its values and says the line diff was skipped', () => {
  const long = Array.from({ length: 4100 }, (_value, index) => `Setning ${index}`).join('\n');
  const first = side('long_v1.txt', `Kontraktssum: NOK 100\n${long}`);
  const second = side('long_v2.txt', `Kontraktssum: NOK 200\n${long}`);
  const diff = diffVersions(first, second);
  assert.equal(diff.changedValues.length, 1, 'the value comparison is linear and still runs');
  assert.equal(diff.unchangedLines, -1, 'the skipped line diff says so rather than reporting a made-up count');
  assert.deepEqual(diff.addedLines, []);
});

test('the comparison never nominates a version as authoritative', () => {
  const diff = diffVersions(V1, V2);
  const serialised = JSON.stringify(diff).toLowerCase();
  for (const word of ['authoritative', 'filed', 'final', 'current', 'signed']) {
    assert.ok(!serialised.includes(`"${word}"`), `the diff must not carry a ${word} verdict`);
  }
});
