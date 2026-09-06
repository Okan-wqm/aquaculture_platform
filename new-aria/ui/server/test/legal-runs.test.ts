import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, open, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { recordDecision } from '../src/decisions.ts';
import { HttpError } from '../src/errors.ts';
import { createCase, uploadDocument } from '../src/legal-intake.ts';
import { loadOrCreateSigner } from '../src/ledger.ts';
import { prepareLegalInventory, resolveLegalRun } from '../src/legal-runs.ts';
import type { LegalWorkerRequest } from '../src/legal-worker.ts';

const emptyHash = createHash('sha256').update('').digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'legal-run-'));
  const config = loadConfig({ ARIA_UI_TOKEN: 'test-token-long-enough', ARIA_TOOLS_DIR: join(root, 'tools'), ARIA_LEGAL_CASES_DIR: join(root, 'cases'), ARIA_WORKSPACE_BASE: join(root, 'jobs'), ARIA_WORKSPACE_ROOT: resolve('..') });
  const signer = loadOrCreateSigner(join(root, 'key.pem'));
  await createCase(config.legalCasesDir, { caseId: 'case-001', title: 'Case', custodian: 'Person', createdBy: 'person', jurisdiction: null, courtReference: null }, '2026-09-05T00:00:00Z');
  return { root, config, signer };
}

async function emptyWorker(request: LegalWorkerRequest): Promise<void> {
  const dir = join(request.toolsDir, 'packs/legal/cases', request.caseId);
  await mkdir(dir, { recursive: true });
  const files: Record<string, unknown> = {
    'case.json': { caseId: request.caseId, title: 'Case', jurisdiction: null, courtReference: null, archiveRoot: `data/legal-cases/${request.caseId}/archive`, createdAt: '2026-09-05T00:00:00Z', snapshotSha256: emptyHash, adapterId: 'legal-document-inventory', adapterVersion: '0.1.0', runId: null, cycleId: request.runKey },
    'coverage.json': { caseId: request.caseId, totalFiles: 0, distinctDocuments: 0, byExtraction: { text: 0, metadata_only: 0, unreadable: 0, excluded: 0 }, byKind: {}, excludedRoots: [], unreadable: [], reconciliation: { receipts: 0, matched: 0, documentsWithoutReceipt: [], receiptsWithoutDocument: [], hashMismatches: [] }, truncated: { findings: 0, statements: 0, timeline: 0 }, complete: true },
  };
  for (const file of ['documents', 'versions', 'parties', 'timeline', 'statements', 'links']) files[`${file}.json`] = [];
  for (const [file, value] of Object.entries(files)) await writeFile(join(dir, file), JSON.stringify(value));
  const runId = '12345678-1234-4234-8234-123456789abc';
  const health = { schema_version: 1, at: '2026-09-05T00:00:00Z', tool_id: 'legal-document-inventory', status: 'SHADOW', action: 'none', reason: 'no health transition required', metrics: {} };
  const output = { observations: [], findings: [], read_paths: [], evidence_sources: [], belief_candidates: [], cost_units: 0, metadata: { status: 'ok', case_id: request.caseId, archive_root: `data/legal-cases/${request.caseId}/archive`, adapter_version: '0.1.0' } };
  const stdout = JSON.stringify(output) + '\n';
  await writeFile(join(request.toolsDir, 'kernel-result.json'), JSON.stringify({ ...health, envelope: {
    schema_version: 1, status: 'ok', tool_id: 'legal-document-inventory', cycle_id: request.runKey, run_id: runId,
    input_hash: `sha256:${emptyHash}`, output_hash: `sha256:${createHash('sha256').update(stdout).digest('hex')}`, read_paths: [], operator_feedback_refs: [], memory_candidates: [], duration_ms: 1, cost_units: 0,
    evidence_validation: { valid: true, repository_mutation_attempt: false, evidence_sources: [], errors: [] },
    runner: { type: 'subprocess', exit_code: 0, timed_out: false, stderr_hash: `sha256:${emptyHash}`, stderr_sample: '', raw_observations_count: 0, raw_findings_count: 0, raw_findings_sample: [], scoped_mutations: [], scope_out_mutations: [], parse_error: null },
    repo_snapshot: { schema_version: 1 }, emitted_observations: [], emitted_findings: [], raw_findings: [],
    _runtime_artifact_payload: { stdout, stderr: '', parsed_output: output, raw_observations: [], raw_findings: [] },
  }, health_decision: health }));
}

async function corpusWorker(request: LegalWorkerRequest, extraction: 'text' | 'metadata_only' | 'unreadable' = 'text', grouped = false): Promise<void> {
  await emptyWorker(request);
  const input = JSON.parse(await readFile(request.inputFile, 'utf8')) as { intake: Array<{ relativePath: string; sha256: string }> };
  const dir = join(request.toolsDir, 'packs/legal/cases', request.caseId);
  const documents = [];
  for (const [index, row] of input.intake.entries()) {
    documents.push({ documentId: `doc_${String(index + 1).padStart(16, '0')}`, caseId: request.caseId, relativePath: row.relativePath, fileName: row.relativePath, extension: '.txt', mediaType: 'text/plain',
      bytes: (await readFile(join(request.snapshotDir, row.relativePath))).length, sha256: extraction === 'unreadable' ? '' : row.sha256, modifiedAt: null, kindGuess: 'DOCUMENT', kindConfidence: 0.1,
      extraction, excerpt: null, datesMentioned: [], amountsMentioned: [], versionGroupId: grouped && index < 2 ? 'vg_000000000001' : null, excludedReason: null, duplicateOf: null });
  }
  const caseRecord = JSON.parse(await readFile(join(dir, 'case.json'), 'utf8'));
  caseRecord.snapshotSha256 = createHash('sha256').update(documents.map(row => `${row.relativePath}\t${row.sha256 || row.extraction}\n`).join('')).digest('hex');
  await writeFile(join(dir, 'case.json'), JSON.stringify(caseRecord));
  await writeFile(join(dir, 'documents.json'), JSON.stringify(documents));
  if (grouped) await writeFile(join(dir, 'versions.json'), JSON.stringify([{ versionGroupId: 'vg_000000000001', members: documents.slice(0, 2).map((row, index) => ({ documentId: row.documentId, ordinal: index + 1, basis: 'name_suffix', similarityToPrevious: null })), signedMember: null, filedMember: null, steps: [], humanReviewRequired: true }]));
  const coverage = JSON.parse(await readFile(join(dir, 'coverage.json'), 'utf8'));
  coverage.totalFiles = documents.length; coverage.distinctDocuments = documents.length;
  coverage.byExtraction[extraction] = documents.length; coverage.byKind = { DOCUMENT: documents.length };
  coverage.unreadable = extraction === 'text' ? [] : documents.map(row => ({ relativePath: row.relativePath, reason: 'declared test extraction fate' }));
  coverage.reconciliation.receipts = documents.length; coverage.reconciliation.matched = documents.length;
  await writeFile(join(dir, 'coverage.json'), JSON.stringify(coverage));
  const kernelFile = join(request.toolsDir, 'kernel-result.json'); const kernel = JSON.parse(await readFile(kernelFile, 'utf8'));
  kernel.envelope.read_paths = documents.map(row => `data/legal-cases/${request.caseId}/archive/${row.relativePath}`);
  kernel.envelope.evidence_validation.evidence_sources = kernel.envelope.read_paths;
  const runtime = kernel.envelope._runtime_artifact_payload;
  runtime.parsed_output.read_paths = kernel.envelope.read_paths; runtime.parsed_output.evidence_sources = kernel.envelope.read_paths;
  runtime.stdout = JSON.stringify(runtime.parsed_output) + '\n';
  kernel.envelope.output_hash = `sha256:${createHash('sha256').update(runtime.stdout).digest('hex')}`;
  await writeFile(kernelFile, JSON.stringify(kernel));
}

async function uploadCorpus(f: Awaited<ReturnType<typeof fixture>>, identical = false): Promise<void> {
  for (const fileName of ['a.txt', 'b.txt', 'c.txt']) {
    const req = new IncomingMessage(new Socket()); req.push(Buffer.from(identical ? 'identical' : fileName)); req.push(null);
    await uploadDocument(req, { casesDir: f.config.legalCasesDir, caseId: 'case-001', signer: f.signer, now: '2026-09-05T00:00:00Z', fileName, receivedBy: 'person', sourceNote: null, maxBytes: 1024 });
  }
}

test('publishes independent signed artifacts and refuses subsequent artifact tampering', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  let workerDir = '';
  let retained: FileHandle | null = null;
  const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, async request => {
    workerDir = request.toolsDir; await emptyWorker(request);
    retained = await open(join(workerDir, 'packs/legal/cases/case-001/documents.json'), 'r+');
  });
  await prepared.execute();
  const run = await resolveLegalRun(f.config.toolsDir, 'case-001', f.signer);
  assert.equal(run.runKey, prepared.runKey);
  assert.ok(retained !== null);
  await (retained as FileHandle).writeFile('["changed"]');
  await (retained as FileHandle).close();
  assert.equal(await readFile(join(run.dir, 'documents.json'), 'utf8'), '[]');
  await writeFile(join(run.dir, 'documents.json'), '["changed"]');
  await assert.rejects(resolveLegalRun(f.config.toolsDir, 'case-001', f.signer), { code: 'legal_run_invalid' });
});

test('authority revoked while worker executes prevents any current publication', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  let active = true;
  const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => { if (!active) throw new Error('revoked'); }, async request => { await emptyWorker(request); active = false; });
  await assert.rejects(prepared.execute(), /revoked/);
  assert.equal((await resolveLegalRun(f.config.toolsDir, 'case-001', f.signer)).runKey, null);
});

test('a removal committed between decision verification and intake capture cannot publish', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const intakePath = join(f.config.legalCasesDir, 'case-001/intake.jsonl');
  const originalRead = fsPromises.readFile;
  let reads = 0;
  let removalCommitted = false;
  const intercepted = t.mock.method(fsPromises, 'readFile', async (...args: Parameters<typeof fsPromises.readFile>) => {
    if (args[0] === intakePath && ++reads === 2) {
      await recordDecision(f.config.legalCasesDir, f.signer, { caseId: 'case-001', kind: 'document_removal', targetId: 'doc-removed',
        body: { kind: 'document_removal', relativePath: 'removed.txt', sha256: emptyHash }, decidedBy: 'lawyer-1', role: 'lawyer', reason: 'Remove the selected source document', now: '2026-09-05T00:00:00Z' });
      removalCommitted = true;
    }
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { intercepted.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(async () => {
    const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, emptyWorker);
    await prepared.execute();
  }, (error: unknown) => error instanceof HttpError && ['case_content_removal_pending', 'legal_source_changed'].includes(error.code));
  assert.equal(removalCommitted, true);
  assert.equal((await resolveLegalRun(f.config.toolsDir, 'case-001', f.signer)).runKey, null);
});

test('publication explicitly rejects a removal committed while the worker executes', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, async request => {
    await emptyWorker(request);
    await recordDecision(f.config.legalCasesDir, f.signer, { caseId: 'case-001', kind: 'document_removal', targetId: 'doc-removed',
      body: { kind: 'document_removal', relativePath: 'removed.txt', sha256: emptyHash }, decidedBy: 'lawyer-1', role: 'lawyer', reason: 'Remove the selected source document', now: '2026-09-05T00:00:00Z' });
  });
  await assert.rejects(prepared.execute(), { code: 'case_content_removal_pending' });
  assert.equal((await resolveLegalRun(f.config.toolsDir, 'case-001', f.signer)).runKey, null);
});

test('source intake accepted during execution rejects the old snapshot', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, async request => {
    await emptyWorker(request);
    const req = new IncomingMessage(new Socket()); req.push(Buffer.from('new evidence')); req.push(null);
    await uploadDocument(req, { casesDir: f.config.legalCasesDir, caseId: 'case-001', signer: f.signer, now: '2026-09-05T00:00:00Z', fileName: 'new.txt', receivedBy: 'person', sourceNote: null, maxBytes: 1024 });
  });
  await assert.rejects(prepared.execute(), { code: 'legal_source_changed' });
  assert.equal((await resolveLegalRun(f.config.toolsDir, 'case-001', f.signer)).runKey, null);
});

for (const defect of ['missing', 'cross-case', 'symlink', 'dangling-reference', 'quarantined'] as const) {
  test(`refuses ${defect} artifacts without publishing`, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, async request => {
      await emptyWorker(request);
      const dir = join(request.toolsDir, 'packs/legal/cases/case-001');
      if (defect === 'missing') await rm(join(dir, 'links.json'));
      if (defect === 'symlink') { await rm(join(dir, 'links.json')); await symlink(join(dir, 'documents.json'), join(dir, 'links.json')); }
      if (defect === 'cross-case') {
        const value = JSON.parse(await readFile(join(dir, 'case.json'), 'utf8'));
        value.caseId = 'other-case'; await writeFile(join(dir, 'case.json'), JSON.stringify(value));
      }
      if (defect === 'dangling-reference') await writeFile(join(dir, 'timeline.json'), JSON.stringify([{ eventId: 'evt_000000000001', kind: 'EVENT', occurredAt: null, learnedAt: null, datePrecision: 'unknown', summary: 'Absent evidence', evidence: [{ documentId: 'doc_0000000000000001', sha256: emptyHash }], assertedBy: 'mechanical_extraction', confidence: 0.2, humanReviewRequired: true }]));
      if (defect === 'quarantined') {
        const file = join(request.toolsDir, 'kernel-result.json'); const value = JSON.parse(await readFile(file, 'utf8'));
        value.health_decision.status = 'QUARANTINED'; await writeFile(file, JSON.stringify(value));
      }
    });
    await assert.rejects(prepared.execute());
    assert.equal((await resolveLegalRun(f.config.toolsDir, 'case-001', f.signer)).runKey, null);
  });
}

test('a present invalid pointer never falls back to legacy artifacts', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const dir = join(f.config.toolsDir, 'packs/legal/cases/case-001'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'current.json'), '{broken');
  await assert.rejects(resolveLegalRun(f.config.toolsDir, 'case-001', f.signer), { code: 'legal_run_invalid' });
});

for (const defect of ['extraction-count', 'kind-count', 'distinct-count', 'missing-unreadable', 'duplicate-unreadable', 'wrong-unreadable', 'incomplete-fate'] as const) {
  test(`coverage cannot publish ${defect}`, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await uploadCorpus(f);
    const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, async request => {
      await corpusWorker(request, 'metadata_only');
      const file = join(request.toolsDir, 'packs/legal/cases/case-001/coverage.json'); const value = JSON.parse(await readFile(file, 'utf8'));
      if (defect === 'extraction-count') value.byExtraction.metadata_only = 0;
      if (defect === 'kind-count') value.byKind = { UNKNOWN: 3 };
      if (defect === 'distinct-count') value.distinctDocuments = 0;
      if (defect === 'missing-unreadable') value.unreadable.pop();
      if (defect === 'duplicate-unreadable') value.unreadable.push(value.unreadable[0]);
      if (defect === 'wrong-unreadable') value.unreadable[0].relativePath = 'b.txt';
      if (defect === 'incomplete-fate') value.complete = false;
      await writeFile(file, JSON.stringify(value));
    });
    await assert.rejects(prepared.execute(), { code: 'legal_run_invalid' });
  });
}

for (const extraction of ['metadata_only', 'unreadable'] as const) {
  test(`complete coverage preserves declared ${extraction} fates and truncation counts`, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await uploadCorpus(f);
    const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, async request => {
      await corpusWorker(request, extraction);
      const file = join(request.toolsDir, 'packs/legal/cases/case-001/coverage.json'); const value = JSON.parse(await readFile(file, 'utf8'));
      value.truncated = { findings: 2, statements: 3, timeline: 1 }; await writeFile(file, JSON.stringify(value));
    });
    await prepared.execute();
    const run = await resolveLegalRun(f.config.toolsDir, 'case-001', f.signer);
    const coverage = JSON.parse(await readFile(join(run.dir, 'coverage.json'), 'utf8'));
    assert.equal(coverage.complete, true); assert.equal(coverage.unreadable.length, 3); assert.equal(coverage.truncated.statements, 3);
  });
}

for (const defect of ['signed-nonmember', 'filed-nonmember', 'missing-reciprocal-member', 'duplicate-self', 'duplicate-cycle', 'duplicate-two-owners'] as const) {
  test(`document relationships cannot publish ${defect}`, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await uploadCorpus(f, defect.startsWith('duplicate'));
    const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, async request => {
      await corpusWorker(request, 'text', !defect.startsWith('duplicate'));
      const dir = join(request.toolsDir, 'packs/legal/cases/case-001');
      const versions = JSON.parse(await readFile(join(dir, 'versions.json'), 'utf8')); const docs = JSON.parse(await readFile(join(dir, 'documents.json'), 'utf8'));
      if (defect === 'signed-nonmember') versions[0].signedMember = docs[2].documentId;
      if (defect === 'filed-nonmember') versions[0].filedMember = docs[2].documentId;
      if (defect === 'missing-reciprocal-member') docs[2].versionGroupId = versions[0].versionGroupId;
      if (defect === 'duplicate-self') docs[0].duplicateOf = docs[0].documentId;
      if (defect === 'duplicate-cycle') { docs[0].duplicateOf = docs[1].documentId; docs[1].duplicateOf = docs[0].documentId; }
      await writeFile(join(dir, 'versions.json'), JSON.stringify(versions)); await writeFile(join(dir, 'documents.json'), JSON.stringify(docs));
      const coverageFile = join(dir, 'coverage.json'); const coverage = JSON.parse(await readFile(coverageFile, 'utf8'));
      coverage.distinctDocuments = docs.filter((doc: { duplicateOf: string | null }) => doc.duplicateOf === null).length;
      await writeFile(coverageFile, JSON.stringify(coverage));
    });
    await assert.rejects(prepared.execute(), { code: 'legal_run_invalid' });
  });
}

for (const [field, value] of [
  ['envelope.schema_version', 99], ['envelope.run_id', null], ['envelope.input_hash', 'invalid'], ['envelope.output_hash', 'invalid'],
  ['envelope.output_hash', `sha256:${'0'.repeat(64)}`], ['envelope.runner.stderr_hash', `sha256:${'0'.repeat(64)}`],
  ['envelope._runtime_artifact_payload.stdout', '{}'],
  ['envelope.runner', null], ['envelope.runner.exit_code', 1], ['envelope.runner.timed_out', true], ['envelope.runner.parse_error', 'schema_error'],
  ['envelope.runner.scope_out_mutations', ['other-case']], ['envelope.evidence_validation.errors', ['invalid evidence']],
  ['health_decision.status', null], ['health_decision.status', 'UNKNOWN'], ['health_decision.status', ['SHADOW']], ['health_decision.tool_id', 'another-tool'], ['health_decision.action', 'unknown'],
] as const) {
  test(`kernel result rejects invalid ${field}=${JSON.stringify(value)}`, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, async request => {
      await emptyWorker(request);
      const file = join(request.toolsDir, 'kernel-result.json'); const payload = JSON.parse(await readFile(file, 'utf8'));
      const segments = field.split('.'); const leaf = segments.pop(); assert.ok(leaf !== undefined);
      let target = payload; for (const segment of segments) target = target[segment]; target[leaf] = value;
      await writeFile(file, JSON.stringify(payload));
    });
    await assert.rejects(prepared.execute(), { code: 'legal_run_invalid' });
  });
}

for (const excludedRoot of ['./Ikke laste opp/', 'Ikke laste opp\\']) {
test(`policy-excluded bytes never enter the snapshot with manifest root ${JSON.stringify(excludedRoot)}`, async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(resolve('../arias/legal/aria.manifest.json'), 'utf8'));
  manifest.corpus.exclude_roots = [excludedRoot];
  manifest.policies.approval = resolve('../arias/legal/config/approval-policy.json');
  const manifestPath = join(f.root, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  const policy = loadConfig({ ARIA_UI_TOKEN: 'test-token-long-enough', ARIA_TOOLS_DIR: f.config.toolsDir, ARIA_UI_PRINCIPALS_FILE: join(f.root, 'principals.json'), ARIA_INSTANCE_MANIFEST: manifestPath }).instancePolicy;
  assert.ok(policy !== null);
  const config = { ...f.config, instancePolicy: policy };
  const req = new IncomingMessage(new Socket()); req.push(Buffer.from('excluded private content')); req.push(null);
  const fileName = 'Ikke laste opp/private.txt';
  await uploadDocument(req, { casesDir: config.legalCasesDir, caseId: 'case-001', signer: f.signer, now: '2026-09-05T00:00:00Z', fileName, receivedBy: 'person', sourceNote: null, maxBytes: 1024 });
  const prepared = await prepareLegalInventory(config, 'case-001', null, f.signer, () => {}, async request => {
    assert.deepEqual(await readdir(request.snapshotDir), []);
    assert.deepEqual(JSON.parse(await readFile(request.inputFile, 'utf8')).exclude_roots, ['Ikke laste opp']);
    await emptyWorker(request);
    const path = join(request.toolsDir, 'packs/legal/cases/case-001/coverage.json');
    const coverage = JSON.parse(await readFile(path, 'utf8'));
    coverage.reconciliation = { receipts: 1, matched: 0, documentsWithoutReceipt: [], receiptsWithoutDocument: [fileName], hashMismatches: [] };
    coverage.complete = false;
    await writeFile(path, JSON.stringify(coverage));
  });
  await prepared.execute();
  assert.equal((await resolveLegalRun(config.toolsDir, 'case-001', f.signer)).runKey, prepared.runKey);
});
}

for (const duplicate of [false, true]) {
  test(`publishes valid ${duplicate ? 'canonical duplicate ownership' : 'reciprocal version membership'}`, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true })); await uploadCorpus(f, duplicate);
    const prepared = await prepareLegalInventory(f.config, 'case-001', null, f.signer, () => {}, async request => {
      await corpusWorker(request, 'text', !duplicate);
      const dir = join(request.toolsDir, 'packs/legal/cases/case-001');
      if (duplicate) {
        const docs = JSON.parse(await readFile(join(dir, 'documents.json'), 'utf8'));
        docs[1].duplicateOf = docs[0].documentId; docs[2].duplicateOf = docs[0].documentId;
        await writeFile(join(dir, 'documents.json'), JSON.stringify(docs));
        const coverage = JSON.parse(await readFile(join(dir, 'coverage.json'), 'utf8')); coverage.distinctDocuments = 1;
        await writeFile(join(dir, 'coverage.json'), JSON.stringify(coverage));
      } else {
        const versions = JSON.parse(await readFile(join(dir, 'versions.json'), 'utf8'));
        versions[0].signedMember = versions[0].members[0].documentId; versions[0].filedMember = versions[0].members[1].documentId;
        await writeFile(join(dir, 'versions.json'), JSON.stringify(versions));
      }
    });
    await prepared.execute();
    assert.equal((await resolveLegalRun(f.config.toolsDir, 'case-001', f.signer)).runKey, prepared.runKey);
  });
}
