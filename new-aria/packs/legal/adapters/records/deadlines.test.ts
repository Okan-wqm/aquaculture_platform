// Tests for deadline and procedural-step readings.
//
// WHY: a deadline invented by computation is the one record this module must
// never produce, and a deadline stated in a document is the one it must never
// miss. Both are asserted: a labelled or phrased date is read with its cue, a
// relative period is recorded WITHOUT a date, and a date that precedes the cue
// is not mistaken for the deadline.
//
// WHAT: node:test cases. Run from `new-aria/`:
//   npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/records/deadlines.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deadlineMentionsIn, proceduralStepsIn } from './deadlines';
import type { LocatedText } from './fact-index';

function line(text: string, locator = 'line:1'): LocatedText {
  return { documentId: 'doc_0123456789abcdef', relativePath: 'brev.txt', sha256: 'a'.repeat(64), locator, text };
}

test('a labelled deadline is read with its date, precision, cue and locator', () => {
  const [deadline] = deadlineMentionsIn(line('Svarfrist: 18.03.2024. Uten svar vurderes rettslige skritt.', 'page:1'));
  assert.ok(deadline);
  assert.equal(deadline.value, '2024-03-18');
  assert.equal(deadline.precision, 'day');
  assert.equal(deadline.basis, 'Svarfrist');
  assert.equal(deadline.locator, 'page:1');
  const [forfall] = deadlineMentionsIn(line('Forfallsdato: 26. mars 2024'));
  assert.equal(forfall?.value, '2024-03-26');
});

test('a phrased deadline ("innen", "senest", "no later than") binds the date after the phrase, not one before it', () => {
  const [innen] = deadlineMentionsIn(line('Vedlagt utkast til avtale datert 01.03.2024. Vi ber om tilbakemelding innen 15.03.2024.'));
  assert.ok(innen);
  assert.equal(innen.value, '2024-03-15', 'the agreement date before the cue is not the deadline');
  assert.equal(innen.basis, 'innen');
  assert.equal(deadlineMentionsIn(line('Payment is due no later than 30 April 2024.'))[0]?.value, '2024-04-30');
  assert.equal(deadlineMentionsIn(line('Tilsvar må inngis senest 5. mai 2024.'))[0]?.value, '2024-05-05');
});

test('a relative period is recorded WITHOUT a date: the pack never computes a deadline', () => {
  const [relative] = deadlineMentionsIn(line('Tilsvar må inngis innen 14 dager etter forkynnelse.'));
  assert.ok(relative);
  assert.equal(relative.value, null);
  assert.equal(relative.precision, 'unknown');
  assert.equal(relative.basis, 'innen 14 dager');
  assert.equal(deadlineMentionsIn(line('The defence must be filed within 21 days of service.'))[0]?.value, null);
});

test('a line without a deadline cue, or without a date after it, yields nothing rather than a guess', () => {
  assert.deepEqual(deadlineMentionsIn(line('Milepæl 1 levert 05.02.2024, godkjent 08.02.2024.')), []);
  assert.deepEqual(deadlineMentionsIn(line('Fristen er viktig.')), []);
  assert.deepEqual(deadlineMentionsIn(line('Møte 12.03.2024; frist avtales senere.')), [], 'a date before the cue and none after it is not a deadline');
});

test('a procedural step is a named document with a named event and a date', () => {
  const [step] = proceduralStepsIn(line('18.03.2024 Klage inngitt av Bergen Eiendom ASA v/ advokat Kari Nordmann.'));
  assert.ok(step);
  assert.equal(step.value, '2024-03-18');
  assert.equal(step.step, 'klage inngitt');
  const [writ] = proceduralStepsIn(line('Stevning ble tatt ut 2. april 2024 ved Bergen tingrett.'));
  assert.equal(writ?.step, 'stevning tatt ut');
  assert.equal(writ?.value, '2024-04-02');
  const [filed] = proceduralStepsIn(line('The appeal was filed on 10 May 2024.'));
  assert.equal(filed?.step, 'appeal filed');
});

test('a procedural word without an event verb or without a date is not a step', () => {
  assert.deepEqual(proceduralStepsIn(line('Klagen gjelder leveransen.')), []);
  assert.deepEqual(proceduralStepsIn(line('Klage inngitt.')), [], 'no date, no step');
});

test('readings are deterministic', () => {
  const text = 'Svarfrist: 18.03.2024. Klage inngitt 18.03.2024.';
  assert.deepEqual(deadlineMentionsIn(line(text)), deadlineMentionsIn(line(text)));
  assert.deepEqual(proceduralStepsIn(line(text)), proceduralStepsIn(line(text)));
});
