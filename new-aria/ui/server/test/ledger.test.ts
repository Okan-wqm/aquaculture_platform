// SCENARIO: the signed, head-committed ledger under every custody record.
// EXPECTS: a key is created once and loaded thereafter; concurrent appends
// serialise and chain cleanly; re-chaining without the key, cutting the tail,
// appending a forgery and editing a row are each named; zero rows is `empty`,
// never `intact`; and without the key the verdict says so rather than passing.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { LedgerHead, SignedRowFields } from '../src/ledger.ts';
import { appendSigned, hashCanonical, headFileName, LEDGER_SCHEMA_VERSION, loadOrCreateSigner, readHead, readLedgerSnapshot, signerFromPrivatePem, verifierFromPublicPem, verifyLedger } from '../src/ledger.ts';

interface Note {
  readonly text: string;
  readonly at: string;
}
type NoteRow = Note & SignedRowFields;

const canonical = (row: Note, previous: string | null): ReadonlyArray<unknown> => [LEDGER_SCHEMA_VERSION, row.text, row.at, previous];

function dir(label: string): string {
  return mkdtempSync(join(tmpdir(), `aria-ledger-${label}-`));
}

function readRows(path: string): NoteRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as NoteRow);
}

async function append(where: string, signer: ReturnType<typeof loadOrCreateSigner>, text: string, at: string): Promise<NoteRow> {
  return appendSigned<Note>({ dir: where, ledger: 'notes.jsonl', payload: { text, at }, canonical, signer, now: at });
}

test('the signing key is created on first boot with owner-only permissions, loaded unchanged afterwards, and its public half verifies', () => {
  const path = join(dir('key'), 'keys', 'ledger-ed25519.pem');
  const created = loadOrCreateSigner(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const loaded = loadOrCreateSigner(path);
  assert.equal(loaded.keyId, created.keyId, 'the same key comes back');
  const verifier = verifierFromPublicPem(created.publicKeyPem);
  assert.equal(verifier.keyId, created.keyId, 'the published public key names the same key id');
  assert.throws(() => signerFromPrivatePem('-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n'));
});

test('N concurrent appends serialise: N rows, each naming its predecessor, head committed, verdict intact', async () => {
  const where = dir('concurrent');
  const signer = loadOrCreateSigner(join(where, 'key.pem'));
  const count = 12;
  const rows = await Promise.all(Array.from({ length: count }, (_, index) => append(where, signer, `note ${index}`, `2026-09-05T00:00:${String(index).padStart(2, '0')}.000Z`)));
  assert.equal(rows.length, count);
  const onDisk = readRows(join(where, 'notes.jsonl'));
  assert.equal(onDisk.length, count);
  for (let index = 1; index < onDisk.length; index += 1) {
    assert.equal(onDisk[index]?.previousRowHash, onDisk[index - 1]?.rowHash, `row ${index} names its predecessor`);
  }
  const head = await readHead(where, 'notes.jsonl');
  assert.ok(head);
  assert.equal(head.rows, count);
  assert.equal(head.headRowHash, onDisk[count - 1]?.rowHash);
  const verdict = verifyLedger({ rows: onDisk, head, canonical, verifier: signer });
  assert.deepEqual(verdict, { status: 'intact', valid: true, rows: count, brokenAt: null, reason: null, anchored: true, keyId: signer.keyId });
});

test('zero rows is empty, never intact — with or without a head', async () => {
  const where = dir('empty');
  const signer = loadOrCreateSigner(join(where, 'key.pem'));
  const none = verifyLedger<NoteRow>({ rows: [], head: null, canonical, verifier: signer });
  assert.equal(none.status, 'empty');
  assert.equal(none.valid, true);
  assert.equal(none.anchored, false);
  await append(where, signer, 'one', '2026-09-05T00:00:00.000Z');
  const head = await readHead(where, 'notes.jsonl');
  assert.ok(head);
  // Rows gone, head still says one: that is a truncation, not an empty ledger.
  const cut = verifyLedger<NoteRow>({ rows: [], head, canonical, verifier: signer });
  assert.equal(cut.status, 'broken');
  assert.equal(cut.reason, 'head_mismatch:truncated');
});

test('every forgery the old chain missed is named: re-chained rows, a cut tail, an appended row, an edited field, a foreign key', async () => {
  const where = dir('forgery');
  const signer = loadOrCreateSigner(join(where, 'key.pem'));
  for (let index = 0; index < 4; index += 1) await append(where, signer, `note ${index}`, `2026-09-05T00:00:0${index}.000Z`);
  const rows = readRows(join(where, 'notes.jsonl'));
  const head = await readHead(where, 'notes.jsonl');
  assert.ok(head);

  // Re-chain from scratch without the key: hashes are perfect, signatures are not.
  const rechained: NoteRow[] = [];
  let previous: string | null = null;
  for (const row of rows) {
    const edited: Note = { text: row.text.replace('note', 'forged'), at: row.at };
    const rowHash = hashCanonical(canonical(edited, previous));
    rechained.push({ ...edited, schemaVersion: LEDGER_SCHEMA_VERSION, previousRowHash: previous, rowHash, keyId: row.keyId, signature: row.signature });
    previous = rowHash;
  }
  const forged = verifyLedger({ rows: rechained, head, canonical, verifier: signer });
  assert.equal(forged.status, 'broken');
  assert.equal(forged.brokenAt, 0);
  assert.equal(forged.reason, 'signature_invalid');

  // Cut the tail: the rows still chain and sign, the head says four.
  const truncated = verifyLedger({ rows: rows.slice(0, 3), head, canonical, verifier: signer });
  assert.equal(truncated.reason, 'head_mismatch:truncated');
  assert.equal(truncated.brokenAt, 3);

  // Append a signed row from a different key: the row is refused by key, the head by count.
  const other = loadOrCreateSigner(join(dir('other-key'), 'key.pem'));
  const extra = await appendSigned<Note>({ dir: dir('other-ledger'), ledger: 'notes.jsonl', payload: { text: 'late', at: '2026-09-05T00:00:09.000Z' }, canonical, signer: other, now: '2026-09-05T00:00:09.000Z' });
  const extended = verifyLedger({ rows: [...rows, { ...extra, previousRowHash: rows[3]?.rowHash ?? null }], head, canonical, verifier: signer });
  assert.equal(extended.status, 'broken');
  assert.ok(extended.reason === 'row_hash_mismatch' || extended.reason === 'key_unknown', extended.reason ?? '');

  // Edit one field in the middle: its own hash no longer matches.
  const edited = rows.map((row, index) => (index === 1 ? { ...row, text: 'tampered' } : row));
  const tampered = verifyLedger({ rows: edited, head, canonical, verifier: signer });
  assert.equal(tampered.brokenAt, 1);
  assert.equal(tampered.reason, 'row_hash_mismatch');

  // A head that does not verify is named as such, even over perfect rows.
  const badHead: LedgerHead = { ...head, committedAt: '1999-01-01T00:00:00.000Z' };
  assert.equal(verifyLedger({ rows, head: badHead, canonical, verifier: signer }).reason, 'head_signature_invalid');
  // A ledger with rows and no head was never committed: unanchored, not intact.
  assert.equal(verifyLedger({ rows, head: null, canonical, verifier: signer }).reason, 'unanchored');
});

test('without the key the verdict says the ledger cannot be verified; it never passes unsigned rows', async () => {
  const where = dir('no-key');
  const signer = loadOrCreateSigner(join(where, 'key.pem'));
  await append(where, signer, 'one', '2026-09-05T00:00:00.000Z');
  const rows = readRows(join(where, 'notes.jsonl'));
  const head = await readHead(where, 'notes.jsonl');
  const verdict = verifyLedger({ rows, head, canonical, verifier: null });
  assert.equal(verdict.status, 'broken');
  assert.equal(verdict.reason, 'ledger_key_missing');
  assert.equal(verdict.keyId, null);
});

test('the head file is written beside the ledger, atomically, and a corrupt head is refused by name', async () => {
  const where = dir('head');
  const signer = loadOrCreateSigner(join(where, 'key.pem'));
  await append(where, signer, 'one', '2026-09-05T00:00:00.000Z');
  assert.equal(headFileName('notes.jsonl'), 'notes.head.json');
  const path = join(where, 'notes.head.json');
  assert.ok(statSync(path).isFile());
  writeFileSync(path, '{ not json');
  await assert.rejects(readHead(where, 'notes.jsonl'), (error: unknown) => (error as { code?: string }).code === 'ledger_head_corrupt');
});

test('a crash-truncated ledger refuses new writes and preserves its last committed head', async () => {
  const where = dir('truncated-write');
  const signer = loadOrCreateSigner(join(where, 'key.pem'));
  await append(where, signer, 'one', '2026-09-05T00:00:00.000Z');
  const ledger = join(where, 'notes.jsonl');
  const headPath = join(where, 'notes.head.json');
  const committed = readFileSync(headPath, 'utf8');
  writeFileSync(ledger, '');
  await assert.rejects(append(where, signer, 'two', '2026-09-05T00:00:01.000Z'), { code: 'ledger_chain_invalid' });
  assert.equal(readFileSync(headPath, 'utf8'), committed);
  assert.equal(readFileSync(ledger, 'utf8'), '');
});


test('snapshot reads queued between appends always pair rows with the matching head', async () => {
  const where = dir('snapshots');
  const signer = loadOrCreateSigner(join(where, 'key.pem'));
  const operations: Array<Promise<unknown>> = [];
  for (let index = 0; index < 12; index += 1) {
    operations.push(append(where, signer, String(index), '2026-09-05T00:00:00.000Z'));
    operations.push(readLedgerSnapshot(where, 'notes.jsonl', (value) => value as NoteRow).then(({ rows, head }) => {
      assert.equal(verifyLedger({ rows, head, canonical, verifier: signer }).status, 'intact');
      assert.equal(rows.length, index + 1);
    }));
  }
  await Promise.all(operations);
});
