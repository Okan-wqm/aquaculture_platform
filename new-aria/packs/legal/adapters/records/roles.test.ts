// Tests for role readings and body correspondence lines.
//
// WHY: a role is a claim about responsibility, and the one way this module may
// make it is by quoting the document: a role word beside a name. An
// organisation form, a capital letter or a plausible guess never becomes a
// role. Correspondence lines in a letter body must anchor a document to its
// sender and recipients the way an e-mail header does.
//
// WHAT: node:test cases. Run from `new-aria/`:
//   npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/records/roles.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LocatedText } from './fact-index';
import { correspondenceLineIn, roleMentionsIn } from './roles';

function line(text: string, locator = 'line:1'): LocatedText {
  return { documentId: 'doc_0123456789abcdef', relativePath: 'brev.txt', sha256: 'a'.repeat(64), locator, text };
}

test('a parenthesised role attaches to the name right before it, and only to that name', () => {
  const roles = roleMentionsIn(line('Bergen Eiendom ASA (byggherre) og Nordlys Entreprenør AS (entreprenør) møttes.', 'slide:1'));
  assert.deepEqual(
    roles.map((role) => [role.displayName, role.role, role.basis, role.locator]),
    [
      ['Bergen Eiendom ASA', 'byggherre', 'parenthesised', 'slide:1'],
      ['Nordlys Entreprenør AS', 'entreprenør', 'parenthesised', 'slide:1'],
    ],
  );
});

test('a labelled role line assigns the role to every party named on the value side', () => {
  const roles = roleMentionsIn(line('Entreprenør: Nordlys Entreprenør AS'));
  assert.equal(roles.length, 1);
  assert.equal(roles[0]?.role, 'entreprenør');
  assert.equal(roles[0]?.basis, 'labelled');
  assert.equal(roles[0]?.displayName, 'Nordlys Entreprenør AS');
});

test('counsel named with v/ advokat gets the role advokat; the client before it gets none from that construction', () => {
  const roles = roleMentionsIn(line('Fra: Bergen Eiendom ASA v/ advokat Kari Nordmann'));
  assert.deepEqual(roles.map((role) => [role.displayName, role.role, role.basis]), [['Kari Nordmann', 'advokat', 'counsel_construction']]);
});

test('an organisation form is not a role, and a role word with no party beside it names nobody', () => {
  assert.deepEqual(roleMentionsIn(line('Nordlys Entreprenør AS leverte milepæl 1.')), []);
  assert.deepEqual(roleMentionsIn(line('Byggherren er misfornøyd (byggherre).')), []);
  assert.deepEqual(roleMentionsIn(line('Entreprenør: ukjent')), []);
});

test('a body Fra:/Til: line anchors the document to the parties it names, by direction', () => {
  const from = correspondenceLineIn(line('Fra: Bergen Eiendom ASA v/ advokat Kari Nordmann', 'page:1'));
  assert.ok(from);
  assert.equal(from.direction, 'from');
  assert.deepEqual(from.parties.map((party) => party.displayName), ['Bergen Eiendom ASA']);
  const to = correspondenceLineIn(line('Til: Nordlys Entreprenør AS'));
  assert.equal(to?.direction, 'to');
  assert.equal(to?.parties[0]?.displayName, 'Nordlys Entreprenør AS');
  assert.equal(correspondenceLineIn(line('Til: alle')), null, 'a line naming no party shape anchors nothing');
  assert.equal(correspondenceLineIn(line('Vi viser til avtale av 15.01.2024.')), null);
});

test('readings are deterministic and never duplicate a (party, role) pair on one line', () => {
  const text = 'Byggherre: Bergen Eiendom ASA (byggherre)';
  const roles = roleMentionsIn(line(text));
  assert.equal(roles.length, 1);
  assert.deepEqual(roles, roleMentionsIn(line(text)));
});
