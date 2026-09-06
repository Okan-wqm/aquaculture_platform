import assert from 'node:assert/strict';
import { createHash, sign } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, readlink, stat, writeFile, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendSigned, loadOrCreateSigner } from '../src/ledger.ts';
import * as intake from '../src/legal-intake.ts';

const now = '2026-09-05T12:00:00.000Z';
async function fixture() {
  const casesDir = await mkdtemp(join(tmpdir(), 'intake-durable-'));
  const caseId = 'case-001';
  const signer = loadOrCreateSigner(join(casesDir, 'key.pem'));
  await intake.createCase(casesDir, { caseId, title: 'Case', custodian: 'Person', createdBy: 'person', jurisdiction: null, courtReference: null }, now);
  const root = join(casesDir, caseId);
  const upload = (content: string, maxBytes = 1024, fileName = 'same.txt'): Promise<intake.UploadOutcome> => {
    const req = new IncomingMessage(new Socket());
    req.push(Buffer.from(content));
    req.push(null);
    return intake.uploadDocument(req, { casesDir, caseId, signer, now, fileName, receivedBy: 'person', sourceNote: null, maxBytes });
  };
  return { casesDir, caseId, signer, root, upload };
}

test('concurrent same pathname and timestamp cannot overwrite or mix evidence', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.upload('first bytes'), f.upload('second bytes')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rows = await intake.readIntakeLedger(f.casesDir, f.caseId);
  assert.equal(rows.length, 1);
  const contents = await readFile(join(f.root, 'archive/same.txt'), 'utf8');
  assert.equal(rows[0]?.bytes, Buffer.byteLength(contents));
  assert.equal(rows[0]?.sha256, createHash('sha256').update(contents).digest('hex'));
  assert.equal(intake.verifyIntakeChain(rows, await intake.readIntakeHead(f.casesDir, f.caseId), f.signer).status, 'intact');
});

test('a duplicate cannot bless a receipt with a missing head', async () => {
  const f = await fixture();
  await f.upload('accepted');
  await unlink(join(f.root, 'intake.head.json'));
  await assert.rejects(f.upload('accepted'), { code: 'intake_chain_invalid' });
  await assert.rejects(readFile(join(f.root, 'intake.head.json')), { code: 'ENOENT' });
});

test('restart publishes received bytes only behind their validated signed receipt', async () => {
  const f = await fixture();
  await f.upload('accepted');
  await unlink(join(f.root, 'archive/same.txt'));
  await intake.reconcileIntake(f.casesDir, f.caseId, f.signer);
  assert.equal(await readFile(join(f.root, 'archive/same.txt'), 'utf8'), 'accepted');
  assert.equal((await intake.readIntakeLedger(f.casesDir, f.caseId)).length, 1);
});

test('restart refuses corrupted retained bytes and never replaces archive evidence', async () => {
  const f = await fixture();
  await f.upload('accepted');
  const [id] = await readdir(join(f.root, '.intake-tmp'));
  assert.ok(id);
  await writeFile(join(f.root, '.intake-tmp', id, 'document.part'), 'corrupt');
  await assert.rejects(intake.reconcileIntake(f.casesDir, f.caseId, f.signer), { code: 'intake_bytes_invalid' });
});

test('interrupted receiving state becomes failed while preserving its partial bytes', async () => {
  const f = await fixture();
  await assert.rejects(f.upload('too large', 2), { code: 'document_too_large' });
  const [id] = await readdir(join(f.root, '.intake-tmp'));
  assert.ok(id);
  const path = join(f.root, '.intake-tmp', id, 'transaction.json');
  const transaction = JSON.parse(await readFile(path, 'utf8'));
  transaction.transaction.state = 'receiving';
  transaction.transaction.failure = null;
  transaction.signature = sign(null, Buffer.from(JSON.stringify(transaction.transaction)), f.signer.privateKey).toString('base64');
  await writeFile(path, JSON.stringify(transaction));
  await intake.reconcileIntake(f.casesDir, f.caseId, f.signer);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).transaction.state, 'failed');
  assert.equal((await intake.readIntakeLedger(f.casesDir, f.caseId)).length, 0);
});

test('restart preserves an unstarted transaction directory without blocking later intake', async () => {
  const f = await fixture();
  const directory = join(f.root, '.intake-tmp', 'unstarted');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'transaction-initial.tmp'), '{interrupted');
  await intake.reconcileIntake(f.casesDir, f.caseId, f.signer);
  await f.upload('accepted');
  const [orphan] = await readdir(join(f.root, '.intake-orphans'));
  assert.ok(orphan);
  assert.equal(await readFile(join(f.root, '.intake-orphans', orphan, 'transaction-initial.tmp'), 'utf8'), '{interrupted');
});

test('legacy incomplete upload bytes are preserved outside the archive and do not block later intake', async () => {
  const f = await fixture();
  const directory = join(f.root, '.intake-tmp');
  await mkdir(directory);
  await writeFile(join(directory, 'upload-0123456789abcdef.part'), 'partial legacy bytes');
  await intake.reconcileIntake(f.casesDir, f.caseId, f.signer);
  await f.upload('accepted');
  const [orphan] = await readdir(join(f.root, '.intake-orphans'));
  assert.ok(orphan);
  assert.equal(await readFile(join(f.root, '.intake-orphans', orphan), 'utf8'), 'partial legacy bytes');
  assert.equal((await intake.readIntakeLedger(f.casesDir, f.caseId)).length, 1);
});

test('bytes without their transaction journal fail closed and remain untouched', async () => {
  const f = await fixture();
  const directory = join(f.root, '.intake-tmp', 'missing-journal');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'document.part'), 'unaccounted bytes');
  await assert.rejects(intake.reconcileIntake(f.casesDir, f.caseId, f.signer), { code: 'intake_transaction_invalid' });
  assert.equal(await readFile(join(directory, 'document.part'), 'utf8'), 'unaccounted bytes');
});

async function retainedTransaction(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const [id] = await readdir(join(f.root, '.intake-tmp'));
  assert.ok(id);
  return join(f.root, '.intake-tmp', id, 'transaction.json');
}

async function changeTransaction(f: Awaited<ReturnType<typeof fixture>>, path: string, change: (row: Record<string, unknown>) => void): Promise<void> {
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  change(envelope.transaction);
  envelope.signature = sign(null, Buffer.from(JSON.stringify(envelope.transaction)), f.signer.privateKey).toString('base64');
  await writeFile(path, JSON.stringify(envelope));
}

test('a received conflict interrupted before failure commit becomes terminal on restart', async () => {
  const f = await fixture();
  await f.upload('accepted');
  await assert.rejects(f.upload('refused'), { code: 'document_name_conflict' });
  const ids = await readdir(join(f.root, '.intake-tmp'));
  for (const id of ids) {
    const path = join(f.root, '.intake-tmp', id, 'transaction.json');
    if (JSON.parse(await readFile(path, 'utf8')).transaction.state === 'failed') {
      await changeTransaction(f, path, row => { row['state'] = 'received'; row['failure'] = null; });
    }
  }
  await intake.reconcileIntake(f.casesDir, f.caseId, f.signer);
  assert.equal((await f.upload('accepted')).duplicate, true);
  assert.equal(await readFile(join(f.root, 'archive/same.txt'), 'utf8'), 'accepted');
  assert.equal((await intake.readIntakeLedger(f.casesDir, f.caseId)).length, 1);
});

test('reconciliation verifies every transaction before publishing any pending evidence', async () => {
  const f = await fixture();
  await f.upload('accepted');
  await unlink(join(f.root, 'archive/same.txt'));
  await mkdir(join(f.root, '.intake-tmp', 'zz-corrupt'));
  await writeFile(join(f.root, '.intake-tmp', 'zz-corrupt', 'transaction.json'), '{invalid');
  await assert.rejects(intake.reconcileIntake(f.casesDir, f.caseId, f.signer), { code: 'intake_transaction_invalid' });
  await assert.rejects(readFile(join(f.root, 'archive/same.txt')), { code: 'ENOENT' });
});

test('a received payload with missing receipt metadata cannot be signed or published', async () => {
  const f = await fixture();
  await f.upload('accepted');
  const path = await retainedTransaction(f);
  await changeTransaction(f, path, row => {
    assert.ok(typeof row['payload'] === 'object' && row['payload'] !== null);
    Reflect.deleteProperty(row['payload'], 'receivedBy');
  });
  await unlink(join(f.root, 'archive/same.txt'));
  await unlink(join(f.root, 'intake.jsonl'));
  await unlink(join(f.root, 'intake.head.json'));
  await assert.rejects(intake.reconcileIntake(f.casesDir, f.caseId, f.signer), { code: 'intake_transaction_invalid' });
  assert.deepEqual(await intake.readIntakeLedger(f.casesDir, f.caseId), []);
  await assert.rejects(readFile(join(f.root, 'archive/same.txt')), { code: 'ENOENT' });
});

test('a committed received journal resumes before the first receipt append', async () => {
  const f = await fixture();
  await f.upload('accepted');
  await unlink(join(f.root, 'archive/same.txt'));
  await unlink(join(f.root, 'intake.jsonl'));
  await unlink(join(f.root, 'intake.head.json'));
  await intake.reconcileIntake(f.casesDir, f.caseId, f.signer);
  assert.equal(await readFile(join(f.root, 'archive/same.txt'), 'utf8'), 'accepted');
  const rows = await intake.readIntakeLedger(f.casesDir, f.caseId);
  assert.equal(rows.length, 1);
  assert.equal(intake.verifyIntakeChain(rows, await intake.readIntakeHead(f.casesDir, f.caseId), f.signer).status, 'intact');
});

test('an appended receipt without its committed head stays blocked with all evidence preserved', async () => {
  const f = await fixture();
  await f.upload('accepted');
  await unlink(join(f.root, 'archive/same.txt'));
  await unlink(join(f.root, 'intake.head.json'));
  const ledger = await readFile(join(f.root, 'intake.jsonl'), 'utf8');
  await assert.rejects(intake.reconcileIntake(f.casesDir, f.caseId, f.signer), { code: 'intake_chain_invalid' });
  assert.equal(await readFile(join(f.root, 'intake.jsonl'), 'utf8'), ledger);
  await assert.rejects(readFile(join(f.root, 'archive/same.txt')), { code: 'ENOENT' });
});

test('snapshot capture holds the case intake queue until its copy is complete', async () => {
  const f = await fixture();
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const snapshot = intake.withReconciledIntake(f.casesDir, f.caseId, f.signer, async () => {
    enter();
    await released;
    return (await intake.readIntakeLedger(f.casesDir, f.caseId)).length;
  });
  await entered;
  const upload = f.upload('accepted');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(await intake.readIntakeLedger(f.casesDir, f.caseId), []);
  release();
  assert.equal(await snapshot, 0);
  await upload;
  assert.equal((await intake.readIntakeLedger(f.casesDir, f.caseId)).length, 1);
});

test('duplicate receipt paths are rejected even when each row and the head are signed', async () => {
  const f = await fixture();
  const first = await f.upload('accepted');
  await appendSigned({ dir: f.root, ledger: intake.INTAKE_LEDGER, payload: first.record, canonical: intake.intakeCanonical, signer: f.signer, now });
  await assert.rejects(intake.reconcileIntake(f.casesDir, f.caseId, f.signer), { code: 'intake_chain_invalid' });
  assert.equal((await intake.readIntakeLedger(f.casesDir, f.caseId)).length, 2);
});

test('invalid caller receipt metadata is refused before it can poison intake state', async () => {
  const f = await fixture();
  const req = new IncomingMessage(new Socket());
  req.push(Buffer.from('accepted'));
  req.push(null);
  await assert.rejects(intake.uploadDocument(req, { casesDir: f.casesDir, caseId: f.caseId, signer: f.signer, now,
    fileName: 'same.txt', receivedBy: '', sourceNote: null, maxBytes: 1024 }), { code: 'intake_metadata_invalid' });
  assert.deepEqual(await intake.readIntakeLedger(f.casesDir, f.caseId), []);
  await f.upload('accepted');
});

test('conflicting received journals without a prior receipt remain blocked without choosing a winner', async () => {
  const f = await fixture();
  await f.upload('accepted');
  await assert.rejects(f.upload('refused'), { code: 'document_name_conflict' });
  for (const id of await readdir(join(f.root, '.intake-tmp'))) {
    await changeTransaction(f, join(f.root, '.intake-tmp', id, 'transaction.json'), row => { row['state'] = 'received'; row['failure'] = null; });
  }
  await unlink(join(f.root, 'archive/same.txt'));
  await unlink(join(f.root, 'intake.jsonl'));
  await unlink(join(f.root, 'intake.head.json'));
  await assert.rejects(intake.reconcileIntake(f.casesDir, f.caseId, f.signer), { code: 'intake_transaction_conflict' });
  assert.deepEqual(await intake.readIntakeLedger(f.casesDir, f.caseId), []);
  await assert.rejects(readFile(join(f.root, 'archive/same.txt')), { code: 'ENOENT' });
});

test('an interrupted stream fsyncs its preserved partial bytes before committing failed state', async context => {
  const f = await fixture();
  const sample = await open(join(f.casesDir, 'key.pem'), 'r');
  const prototype = Object.getPrototypeOf(sample);
  const original: FileHandle['sync'] = prototype.sync;
  await sample.close();
  const synced: string[] = [];
  context.mock.method(prototype, 'sync', async function(this: FileHandle): Promise<void> {
    synced.push(await readlink(`/proc/self/fd/${this.fd}`));
    await original.call(this);
  });
  const req = new IncomingMessage(new Socket());
  req.push(Buffer.from('partial bytes'));
  const upload = assert.rejects(intake.uploadDocument(req, { casesDir: f.casesDir, caseId: f.caseId, signer: f.signer, now,
    fileName: 'same.txt', receivedBy: 'person', sourceNote: null, maxBytes: 1024 }), /interrupted stream/);
  let part: string | null = null;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const ids = await readdir(join(f.root, '.intake-tmp')).catch(() => [] as string[]);
      if (ids[0] !== undefined) {
        const candidate = join(f.root, '.intake-tmp', ids[0], 'document.part');
        if (await readFile(candidate, 'utf8').catch(() => '') === 'partial bytes') { part = candidate; break; }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  } finally { req.destroy(new Error('interrupted stream')); }
  await upload;
  assert.ok(part, 'the stream wrote partial bytes before interruption');
  assert.equal(await readFile(part, 'utf8'), 'partial bytes');
  const partialSync = synced.indexOf(part);
  const lastJournalSync = synced.findLastIndex(path => /transaction-.*\.tmp$/.test(path));
  assert.ok(partialSync >= 0 && partialSync < lastJournalSync, 'partial bytes reach disk before the failed journal commit');
  await intake.reconcileIntake(f.casesDir, f.caseId, f.signer);
  assert.equal(await readFile(part, 'utf8'), 'partial bytes');
  assert.deepEqual(await intake.readIntakeLedger(f.casesDir, f.caseId), []);
});

for (const [acceptedPath, refusedPath] of [['folder/document.txt', 'folder'], ['folder', 'folder/document.txt']]) {
  test(`file and folder conflicts remain terminal after restart: ${acceptedPath} then ${refusedPath}`, async () => {
    const f = await fixture();
    await f.upload('accepted bytes', 1024, acceptedPath);
    await assert.rejects(f.upload('refused bytes', 1024, refusedPath), { code: 'document_name_conflict' });
    assert.equal((await intake.readIntakeLedger(f.casesDir, f.caseId)).length, 1, 'a topology conflict never receives a receipt');
    let failedJournal: string | null = null;
    for (const id of await readdir(join(f.root, '.intake-tmp'))) {
      const path = join(f.root, '.intake-tmp', id, 'transaction.json');
      const row = JSON.parse(await readFile(path, 'utf8')).transaction;
      if (row.relativePath === refusedPath) {
        assert.equal(row.state, 'failed');
        assert.equal(row.failure, 'document_name_conflict');
        failedJournal = path;
        await changeTransaction(f, path, transaction => { transaction['state'] = 'received'; transaction['failure'] = null; });
      }
    }
    assert.ok(failedJournal, 'the refused bytes retain their signed transaction');
    await unlink(join(f.root, 'archive', acceptedPath));
    await intake.reconcileIntake(f.casesDir, f.caseId, f.signer);
    assert.equal(JSON.parse(await readFile(failedJournal, 'utf8')).transaction.state, 'failed');
    assert.equal(await readFile(join(f.root, 'archive', acceptedPath), 'utf8'), 'accepted bytes');
    await f.upload('unrelated bytes', 1024, 'unrelated.txt');
    assert.equal((await intake.readIntakeLedger(f.casesDir, f.caseId)).length, 2);
    await intake.reconcileIntake(f.casesDir, f.caseId, f.signer);
  });
}

test('creating a case flushes metadata and every newly created namespace ancestor before returning', async context => {
  const parent = await mkdtemp(join(tmpdir(), 'case-namespace-'));
  const casesDir = join(parent, 'new-volume', 'cases');
  const root = join(casesDir, 'case-001');
  const sample = await open(parent, 'r');
  const prototype = Object.getPrototypeOf(sample);
  const original: FileHandle['sync'] = prototype.sync;
  await sample.close();
  const synced: Array<{ path: string; inode: number }> = [];
  context.mock.method(prototype, 'sync', async function(this: FileHandle): Promise<void> {
    await original.call(this);
    synced.push({ path: await readlink(`/proc/self/fd/${this.fd}`), inode: (await this.stat()).ino });
  });
  await intake.createCase(casesDir, { caseId: 'case-001', title: 'Case', custodian: 'Person', createdBy: 'person', jurisdiction: null, courtReference: null }, now);
  const metadata = await stat(join(root, intake.CASE_META));
  const metadataSync = synced.findIndex(entry => entry.inode === metadata.ino);
  assert.ok(metadataSync >= 0, 'metadata bytes are durable before case creation returns');
  let previous = -1;
  for (const directory of [join(root, 'archive'), root, casesDir, join(parent, 'new-volume'), parent]) {
    const current = synced.findIndex(entry => entry.path === directory);
    assert.ok(current > previous, `the namespace containing ${directory} is committed after its children`);
    previous = current;
  }
  assert.ok(synced.findLastIndex(entry => entry.path === root) > metadataSync, 'the metadata directory entry is committed after its bytes');
  assert.equal((await intake.readCaseMeta(casesDir, 'case-001'))?.title, 'Case');
});

test('namespace sync failure keeps a fresh case unavailable to intake', async context => {
  const parent = await mkdtemp(join(tmpdir(), 'case-namespace-failure-'));
  const casesDir = join(parent, 'new-volume', 'cases');
  const caseId = 'case-001';
  const signer = loadOrCreateSigner(join(parent, 'key.pem'));
  const sample = await open(parent, 'r');
  const prototype = Object.getPrototypeOf(sample);
  const original: FileHandle['sync'] = prototype.sync;
  await sample.close();
  context.mock.method(prototype, 'sync', async function(this: FileHandle): Promise<void> {
    if (await readlink(`/proc/self/fd/${this.fd}`) === parent) throw new Error('namespace sync failed');
    await original.call(this);
  });
  await assert.rejects(intake.createCase(casesDir, { caseId, title: 'Case', custodian: 'Person', createdBy: 'person', jurisdiction: null, courtReference: null }, now), /namespace sync failed/);
  assert.equal(await intake.readCaseMeta(casesDir, caseId), null);
  const req = new IncomingMessage(new Socket());
  req.push(Buffer.from('bytes'));
  req.push(null);
  await assert.rejects(intake.uploadDocument(req, { casesDir, caseId, signer, now, fileName: 'document.txt', receivedBy: 'person', sourceNote: null, maxBytes: 1024 }), { code: 'case_not_found' });
  assert.deepEqual(await intake.readIntakeLedger(casesDir, caseId), []);
});

test('overlapping pending file and folder journals without receipts cannot choose a winner', async () => {
  const f = await fixture();
  await f.upload('accepted', 1024, 'folder');
  await assert.rejects(f.upload('refused', 1024, 'folder/document.txt'), { code: 'document_name_conflict' });
  for (const id of await readdir(join(f.root, '.intake-tmp'))) {
    await changeTransaction(f, join(f.root, '.intake-tmp', id, 'transaction.json'), row => { row['state'] = 'received'; row['failure'] = null; });
  }
  await unlink(join(f.root, 'archive/folder'));
  await unlink(join(f.root, 'intake.jsonl'));
  await unlink(join(f.root, 'intake.head.json'));
  await assert.rejects(intake.reconcileIntake(f.casesDir, f.caseId, f.signer), { code: 'intake_transaction_conflict' });
  assert.deepEqual(await intake.readIntakeLedger(f.casesDir, f.caseId), []);
});
