// SCENARIO: documents arrive case by case and the arrival itself becomes evidence.
// EXPECTS: bytes land unchanged, the receipt records time and hash and is
// signed, the receipt is written before the archive holds the bytes, the
// signed head catches an edit, a cut and a re-chain, concurrent uploads chain
// cleanly, and every unsafe or ambiguous upload is refused.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { HttpError } from '../src/errors.ts';
import { loadOrCreateSigner } from '../src/ledger.ts';
import type { IntakeRecord } from '../src/legal-intake.ts';
import {
  ARCHIVE_DIR,
  archiveRunRoot,
  assertCaseId,
  assertRelativePath,
  createCase,
  decodeFileNameHeader,
  INTAKE_LEDGER,
  listCaseIds,
  readCaseMeta,
  readIntakeHead,
  readIntakeLedger,
  uploadDocument,
  verifyIntakeChain,
} from '../src/legal-intake.ts';

function casesDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `aria-cases-${label}-`));
}

/** One signing key per test directory: the console's key, on the volume, never in the repo. */
function signerFor(dir: string): ReturnType<typeof loadOrCreateSigner> {
  return loadOrCreateSigner(join(dir, 'keys', 'ledger-ed25519.pem'));
}

/** uploadDocument only iterates the request, so a readable stream is a faithful stand-in. */
function body(bytes: Buffer | string): IncomingMessage {
  return Readable.from([Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8')]) as unknown as IncomingMessage;
}

const NOW = '2026-09-04T12:00:00.000Z';

async function openCase(dir: string, caseId = 'sak-24-001'): Promise<void> {
  await createCase(
    dir,
    { caseId, title: 'Bergen Eiendom mot Nordlys', jurisdiction: 'NO', courtReference: null, custodian: 'Advokat Kari Nordmann', createdBy: 'operator' },
    NOW,
  );
}

async function upload(dir: string, caseId: string, fileName: string, content: string, now = NOW, maxBytes = 1024 * 1024) {
  return uploadDocument(body(content), {
    casesDir: dir,
    caseId,
    fileName,
    receivedBy: 'operator',
    sourceNote: null,
    maxBytes,
    now,
    signer: signerFor(dir),
  });
}

async function verdictOf(dir: string, caseId = 'sak-24-001') {
  return verifyIntakeChain(await readIntakeLedger(dir, caseId), await readIntakeHead(dir, caseId), signerFor(dir));
}

function syncRefusal(run: () => unknown): HttpError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a refusal, but the call returned' });
}

async function refusal(run: () => Promise<unknown>): Promise<HttpError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a refusal, but the call resolved' });
}

test('case ids and relative paths are validated, and traversal can never reach the archive', () => {
  assert.equal(assertCaseId('sak-24-001'), 'sak-24-001');
  for (const bad of ['', 'AB', 'Sak-24', '../etc', 'sak/24', 'a'.repeat(65)]) {
    assert.throws(() => assertCaseId(bad), HttpError, bad);
  }
  assert.equal(assertRelativePath('korrespondanse/2024-03-04.eml'), 'korrespondanse/2024-03-04.eml');
  assert.equal(assertRelativePath('vedlegg\\faktura.pdf'), 'vedlegg/faktura.pdf', 'windows separators normalise');
  assert.equal(assertRelativePath('  faktura.pdf  '), 'faktura.pdf');
  for (const bad of ['', '   ', '../secrets', 'a/../../b', 'x/./../../y', 'has:colon', 'star*name', 'quote"name']) {
    assert.throws(() => assertRelativePath(bad), HttpError, bad);
  }
});

test('the file-name header must be percent-encoded UTF-8 and present', () => {
  assert.equal(decodeFileNameHeader('klage%20utkast%20v3.docx'), 'klage utkast v3.docx');
  assert.equal(decodeFileNameHeader('m%C3%B8te.txt'), 'møte.txt');
  assert.throws(() => decodeFileNameHeader(undefined), HttpError);
  assert.throws(() => decodeFileNameHeader('   '), HttpError);
  assert.throws(() => decodeFileNameHeader('%E0%A4%A'), HttpError);
});

test('a case is opened with a custodian, and opening it twice is refused', async () => {
  const dir = casesDir('create');
  await openCase(dir);
  const meta = await readCaseMeta(dir, 'sak-24-001');
  assert.ok(meta);
  assert.equal(meta.custodian, 'Advokat Kari Nordmann');
  assert.equal(meta.createdAt, NOW);
  assert.deepEqual(await listCaseIds(dir), ['sak-24-001']);

  const again = await refusal(() => openCase(dir));
  assert.equal(again.status, 409);

  // An archive nobody is answerable for cannot support a custody claim later.
  const noCustodian = await refusal(() =>
    createCase(dir, { caseId: 'sak-24-002', title: 'X', jurisdiction: null, courtReference: null, custodian: '  ', createdBy: 'operator' }, NOW),
  );
  assert.equal(noCustodian.status, 400);
  assert.equal(noCustodian.code, 'case_custodian_missing');
});

test('an uploaded document lands unchanged and its receipt records time, size, hash and a signature', async () => {
  const dir = casesDir('upload');
  await openCase(dir);
  const content = 'FAKTURA nr. 2024-001\nTotalt: NOK 6 187 500,00\n';
  const outcome = await upload(dir, 'sak-24-001', 'vedlegg/faktura_2024-001.txt', content);

  const stored = readFileSync(join(dir, 'sak-24-001', ARCHIVE_DIR, 'vedlegg', 'faktura_2024-001.txt'));
  assert.equal(stored.toString('utf8'), content, 'the bytes stored are the bytes sent');
  const expected = createHash('sha256').update(content, 'utf8').digest('hex');
  assert.equal(outcome.record.sha256, expected, 'the receipt hash is the hash of those bytes');
  assert.equal(outcome.record.bytes, Buffer.byteLength(content));
  assert.equal(outcome.record.receivedAt, NOW);
  assert.equal(outcome.record.receivedBy, 'operator');
  assert.equal(outcome.record.relativePath, 'vedlegg/faktura_2024-001.txt');
  assert.equal(outcome.record.previousRowHash, null, 'the first receipt opens the chain');
  assert.equal(outcome.record.schemaVersion, 2);
  assert.equal(outcome.record.keyId, signerFor(dir).keyId, 'the row names the key that signed it');
  assert.ok(outcome.record.signature.length > 40, 'the row carries a signature');
  assert.equal(outcome.duplicate, false);
  const verdict = await verdictOf(dir);
  assert.equal(verdict.status, 'intact');
  assert.equal(verdict.anchored, true, 'the signed head commits the one row');
});

test('receipts chain and sign; the verdict names an edited row, a removed row, a cut tail and a re-chained ledger', async () => {
  const dir = casesDir('chain');
  await openCase(dir);
  await upload(dir, 'sak-24-001', 'a.txt', 'first');
  await upload(dir, 'sak-24-001', 'b.txt', 'second', '2026-09-04T12:01:00.000Z');
  await upload(dir, 'sak-24-001', 'c.txt', 'third', '2026-09-04T12:02:00.000Z');

  const rows = await readIntakeLedger(dir, 'sak-24-001');
  const head = await readIntakeHead(dir, 'sak-24-001');
  const signer = signerFor(dir);
  assert.equal(rows.length, 3);
  assert.equal(verifyIntakeChain(rows, head, signer).status, 'intact');
  assert.equal(rows[1]?.previousRowHash, rows[0]?.rowHash);
  assert.equal(rows[2]?.previousRowHash, rows[1]?.rowHash);

  // Edit a field in the middle row: its own hash no longer matches.
  const edited = rows.map((row, index) => (index === 1 ? { ...row, sha256: 'b'.repeat(64) } : row));
  const editedVerdict = verifyIntakeChain(edited as IntakeRecord[], head, signer);
  assert.equal(editedVerdict.valid, false);
  assert.equal(editedVerdict.brokenAt, 1);
  assert.equal(editedVerdict.reason, 'row_hash_mismatch');

  // Remove the middle row: the next row's predecessor no longer matches.
  const removed = [rows[0], rows[2]].filter((row): row is IntakeRecord => row !== undefined);
  const removedVerdict = verifyIntakeChain(removed, head, signer);
  assert.equal(removedVerdict.brokenAt, 1);
  assert.equal(removedVerdict.reason, 'previous_row_hash_mismatch');

  // Cut the tail: rows still chain and sign, the head says three.
  // MEASURED 2026-09-04: this used to read "intact".
  const truncated = verifyIntakeChain(rows.slice(0, 2), head, signer);
  assert.equal(truncated.status, 'broken');
  assert.equal(truncated.reason, 'head_mismatch:truncated');

  // Re-chain the whole ledger with edited contents and perfect hashes, as
  // anyone who can write the file could: the signatures do not follow.
  const forged: IntakeRecord[] = [];
  let previous: string | null = null;
  for (const row of rows) {
    const { rowHash: _rowHash, previousRowHash: _previous, signature, keyId, schemaVersion, ...payload } = row;
    const draft = { ...payload, sourceNote: 'planted' };
    const rowHash = createHash('sha256')
      .update(JSON.stringify([schemaVersion, draft.caseId, draft.relativePath, draft.fileName, draft.bytes, draft.sha256, draft.receivedAt, draft.receivedBy, draft.sourceNote, previous]), 'utf8')
      .digest('hex');
    forged.push({ ...draft, schemaVersion, previousRowHash: previous, rowHash, keyId, signature });
    previous = rowHash;
  }
  const forgedVerdict = verifyIntakeChain(forged, head, signer);
  assert.equal(forgedVerdict.status, 'broken');
  assert.equal(forgedVerdict.reason, 'signature_invalid');
  assert.equal(forgedVerdict.brokenAt, 0);
});

test('an empty receipt is empty, never intact', async () => {
  const dir = casesDir('empty');
  await openCase(dir);
  const verdict = await verdictOf(dir);
  assert.equal(verdict.status, 'empty');
  assert.equal(verdict.rows, 0);
  assert.equal(verdict.anchored, false);
});

test('twelve uploads that finish in the same turn all chain cleanly: appends are serialised per case', async () => {
  const dir = casesDir('concurrent');
  await openCase(dir);
  const count = 12;
  const outcomes = await Promise.all(Array.from({ length: count }, (_, index) => upload(dir, 'sak-24-001', `brev_${String(index).padStart(2, '0')}.txt`, `Brev ${index}\n`, `2026-09-04T12:${String(index).padStart(2, '0')}:00.000Z`)));
  assert.equal(outcomes.length, count);
  const rows = await readIntakeLedger(dir, 'sak-24-001');
  assert.equal(rows.length, count, 'every upload wrote its own row');
  const verdict = await verdictOf(dir);
  // MEASURED 2026-09-04: two such uploads used to take the same predecessor
  // and break the chain permanently.
  assert.equal(verdict.status, 'intact');
  assert.equal(verdict.rows, count);
});

test('the receipt is written before the archive holds the bytes, so no document can exist without a receipt', async () => {
  const dir = casesDir('order');
  await openCase(dir);
  const events: string[] = [];
  const root = join(dir, 'sak-24-001');
  // Watch the two writes in order: the ledger line lands, then the rename.
  const { watch } = await import('node:fs');
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (typeof name === 'string' && (name.endsWith(INTAKE_LEDGER) || name.startsWith(`${ARCHIVE_DIR}/`) || name.startsWith(`${ARCHIVE_DIR}\\`))) events.push(name);
  });
  try {
    await upload(dir, 'sak-24-001', 'avtale.txt', 'Avtale\n');
  } finally {
    watcher.close();
  }
  const ledgerAt = events.findIndex((name) => name.endsWith(INTAKE_LEDGER));
  const archiveAt = events.findIndex((name) => name.includes('avtale.txt'));
  assert.ok(ledgerAt >= 0, `the ledger was written (${events.join(', ')})`);
  assert.ok(archiveAt < 0 || ledgerAt < archiveAt, `the receipt precedes the archive write (${events.join(', ')})`);
  assert.equal(readFileSync(join(root, ARCHIVE_DIR, 'avtale.txt'), 'utf8'), 'Avtale\n');
});

test('without a ledger key no document is taken in: the refusal names the key, and nothing is stored', async () => {
  const dir = casesDir('no-key');
  await openCase(dir);
  const error = await refusal(() =>
    uploadDocument(body('x'), { casesDir: dir, caseId: 'sak-24-001', fileName: 'a.txt', receivedBy: 'operator', sourceNote: null, maxBytes: 1024, now: NOW, signer: null }),
  );
  assert.equal(error.status, 503);
  assert.equal(error.code, 'ledger_key_missing');
  assert.throws(() => readFileSync(join(dir, 'sak-24-001', ARCHIVE_DIR, 'a.txt')), /ENOENT/);
  assert.deepEqual(await readIntakeLedger(dir, 'sak-24-001'), []);
});

test('the same bytes at the same path are idempotent; different bytes at that path are refused', async () => {
  const dir = casesDir('conflict');
  await openCase(dir);
  const first = await upload(dir, 'sak-24-001', 'avtale.txt', 'version one');
  const again = await upload(dir, 'sak-24-001', 'avtale.txt', 'version one', '2026-09-04T13:00:00.000Z');
  assert.equal(again.duplicate, true);
  assert.equal(again.record.rowHash, first.record.rowHash, 'a re-upload of identical bytes adds no new receipt');
  assert.equal((await readIntakeLedger(dir, 'sak-24-001')).length, 1);

  const conflict = await refusal(() => upload(dir, 'sak-24-001', 'avtale.txt', 'version two'));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, 'document_name_conflict');
  // The refusal must not have disturbed what was already stored.
  assert.equal(readFileSync(join(dir, 'sak-24-001', ARCHIVE_DIR, 'avtale.txt'), 'utf8'), 'version one');
  assert.equal((await readIntakeLedger(dir, 'sak-24-001')).length, 1);
  assert.equal((await verdictOf(dir)).status, 'intact');
});

test('an upload over the size cap is refused and leaves nothing behind', async () => {
  const dir = casesDir('too-large');
  await openCase(dir);
  const error = await refusal(() => upload(dir, 'sak-24-001', 'big.bin', 'x'.repeat(5000), NOW, 1024));
  assert.equal(error.status, 413);
  assert.deepEqual(await readIntakeLedger(dir, 'sak-24-001'), [], 'no receipt for a refused upload');
  assert.throws(() => readFileSync(join(dir, 'sak-24-001', ARCHIVE_DIR, 'big.bin')), /ENOENT/);
});

test('a zero-byte upload is refused: there are no bytes to hash', async () => {
  const dir = casesDir('empty-upload');
  await openCase(dir);
  const error = await refusal(() =>
    uploadDocument(Readable.from([]) as unknown as IncomingMessage, {
      casesDir: dir,
      caseId: 'sak-24-001',
      fileName: 'empty.txt',
      receivedBy: 'operator',
      sourceNote: null,
      maxBytes: 1024,
      now: NOW,
      signer: signerFor(dir),
    }),
  );
  assert.equal(error.code, 'document_empty');
});

test('uploading into a case that was never opened is refused', async () => {
  const dir = casesDir('no-case');
  const error = await refusal(() => upload(dir, 'sak-24-999', 'a.txt', 'x'));
  assert.equal(error.status, 404);
  assert.equal(error.code, 'case_not_found');
});

test('a corrupt or foreign-shaped receipt ledger is reported, never silently treated as empty', async () => {
  const dir = casesDir('corrupt');
  await openCase(dir);
  await upload(dir, 'sak-24-001', 'a.txt', 'x');
  const path = join(dir, 'sak-24-001', INTAKE_LEDGER);
  const good = readFileSync(path, 'utf8');
  writeFileSync(path, '{ not json\n');
  const corrupt = await refusal(() => readIntakeLedger(dir, 'sak-24-001'));
  assert.equal(corrupt.status, 502);
  assert.equal(corrupt.code, 'intake_ledger_corrupt');
  // A row of the old, unsigned shape is not one this console reads.
  const old = { ...(JSON.parse(good.trim()) as Record<string, unknown>), schemaVersion: 1 };
  delete old['signature'];
  delete old['keyId'];
  writeFileSync(path, `${JSON.stringify(old)}\n`);
  const foreign = await refusal(() => readIntakeLedger(dir, 'sak-24-001'));
  assert.equal(foreign.code, 'intake_ledger_invalid');
  assert.match(foreign.detail ?? '', /schemaVersion 1 is not one this console reads/);
});

test('an absent cases directory reads as no cases rather than an error', async () => {
  assert.deepEqual(await listCaseIds(join(casesDir('absent'), 'never-created')), []);
  assert.deepEqual(await readIntakeLedger(casesDir('absent-ledger'), 'sak-24-001'), []);
  assert.equal(await readCaseMeta(casesDir('absent-meta'), 'sak-24-001'), null);
  assert.equal(await readIntakeHead(casesDir('absent-head'), 'sak-24-001'), null);
});

test('the inventory run is pointed at the case archive, relative to the workspace root', () => {
  const workspace = '/opt/new-aria';
  const cases = '/opt/new-aria/data/legal-cases';
  assert.equal(archiveRunRoot(workspace, cases, 'sak-24-001'), 'data/legal-cases/sak-24-001/archive');
  assert.throws(() => archiveRunRoot(workspace, cases, '../escape'), HttpError);
});

test('a cases directory outside the workspace root is refused with the reason, not left to fail deep in the kernel', () => {
  // The kernel's tool runner resolves the adapter's own code and node runtime
  // under the workspace root, so a cases volume mounted elsewhere cannot work.
  // Saying so here beats an unrelated failure inside the runner.
  const outside = syncRefusal(() => archiveRunRoot('/opt/new-aria', '/var/legal-cases', 'sak-24-001'));
  assert.equal(outside.status, 409);
  assert.equal(outside.code, 'cases_dir_outside_workspace');

  const unconfigured = syncRefusal(() => archiveRunRoot(null, '/opt/new-aria/data/legal-cases', 'sak-24-001'));
  assert.equal(unconfigured.code, 'workspace_root_not_configured');
});
