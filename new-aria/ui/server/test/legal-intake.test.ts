// SCENARIO: documents arrive case by case and the arrival itself becomes evidence.
// EXPECTS: bytes land unchanged, the receipt records time and hash, the receipt
// chain detects an edit, and every unsafe or ambiguous upload is refused.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { HttpError } from '../src/errors.ts';
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
  readIntakeLedger,
  uploadDocument,
  verifyIntakeChain,
} from '../src/legal-intake.ts';

function casesDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `aria-cases-${label}-`));
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
  });
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

test('an uploaded document lands unchanged and its receipt records time, size and hash', async () => {
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
  assert.equal(outcome.duplicate, false);
});

test('receipts chain, and the chain verdict detects an edited or removed row', async () => {
  const dir = casesDir('chain');
  await openCase(dir);
  await upload(dir, 'sak-24-001', 'a.txt', 'first');
  await upload(dir, 'sak-24-001', 'b.txt', 'second', '2026-09-04T12:01:00.000Z');
  await upload(dir, 'sak-24-001', 'c.txt', 'third', '2026-09-04T12:02:00.000Z');

  const rows = await readIntakeLedger(dir, 'sak-24-001');
  assert.equal(rows.length, 3);
  assert.equal(verifyIntakeChain(rows).valid, true);
  assert.equal(rows[1]?.previousRowHash, rows[0]?.rowHash);
  assert.equal(rows[2]?.previousRowHash, rows[1]?.rowHash);

  // Edit a field in the middle row: its own hash no longer matches.
  const edited = rows.map((row, index) => (index === 1 ? { ...row, sha256: 'b'.repeat(64) } : row));
  const editedVerdict = verifyIntakeChain(edited as IntakeRecord[]);
  assert.equal(editedVerdict.valid, false);
  assert.equal(editedVerdict.brokenAt, 1);
  assert.equal(editedVerdict.reason, 'row_hash_mismatch');

  // Remove the middle row: the next row's predecessor no longer matches.
  const removed = [rows[0], rows[2]].filter((row): row is IntakeRecord => row !== undefined);
  const removedVerdict = verifyIntakeChain(removed);
  assert.equal(removedVerdict.valid, false);
  assert.equal(removedVerdict.brokenAt, 1);
  assert.equal(removedVerdict.reason, 'previous_row_hash_mismatch');
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
  const dir = casesDir('empty');
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

test('a corrupt receipt ledger is reported, never silently treated as empty', async () => {
  const dir = casesDir('corrupt');
  await openCase(dir);
  await upload(dir, 'sak-24-001', 'a.txt', 'x');
  writeFileSync(join(dir, 'sak-24-001', INTAKE_LEDGER), '{ not json\n');
  const error = await refusal(() => readIntakeLedger(dir, 'sak-24-001'));
  assert.equal(error.status, 502);
  assert.equal(error.code, 'intake_ledger_corrupt');
});

test('an absent cases directory reads as no cases rather than an error', async () => {
  assert.deepEqual(await listCaseIds(join(casesDir('absent'), 'never-created')), []);
  assert.deepEqual(await readIntakeLedger(casesDir('absent-ledger'), 'sak-24-001'), []);
  assert.equal(await readCaseMeta(casesDir('absent-meta'), 'sak-24-001'), null);
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
