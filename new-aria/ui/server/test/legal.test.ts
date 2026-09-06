// SCENARIO: legal readers over artifacts the real inventory adapter produced
// from the synthetic fixture archive.
// EXPECTS: case listing/summary, document filters, version group lookup,
// timeline/parties/statements/coverage projections, malformed artifact → 502.
import assert from 'node:assert/strict';
import { createHash, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEGAL_ARTIFACT_FILES } from '../../shared/legal-contract.ts';

import { createCase } from '../src/legal-intake.ts';
import { loadOrCreateSigner } from '../src/ledger.ts';
import { HttpError } from '../src/errors.ts';
import { listCases, readCase, readCoverage, readDocument, readDocuments, readParties, readStatements, readTimeline } from '../src/readers/legal.ts';

const FIXTURE_TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tools');

test('cases are listed with summaries derived from the artifacts', async () => {
  const cases = await listCases(FIXTURE_TOOLS);
  assert.equal(cases.cases.length, 1);
  const summary = cases.cases[0];
  assert.ok(summary);
  assert.equal(summary.caseId, 'case_fixture');
  assert.equal(summary.documents, 11);
  assert.equal(summary.unreadable, 2);
  assert.equal(summary.statements, 2);
  assert.ok(summary.parties >= 2);
  const detail = await readCase(FIXTURE_TOOLS, 'case_fixture');
  assert.equal(detail.coverage.complete, true);
  assert.deepEqual(detail.coverage.excludedRoots, ['Ikke laste opp']);
});

test('documents filter by extraction and kind, and a document resolves its version group', async () => {
  const all = await readDocuments(FIXTURE_TOOLS, 'case_fixture', { kind: null, extraction: null, limit: 1000 });
  assert.equal(all.total, 11);
  assert.ok(all.versionGroups.length >= 1);
  const metadataOnly = await readDocuments(FIXTURE_TOOLS, 'case_fixture', { kind: null, extraction: 'metadata_only', limit: 1000 });
  assert.equal(metadataOnly.documents.length, 2);
  const grouped = all.documents.find((doc) => doc.versionGroupId !== null);
  assert.ok(grouped);
  const one = await readDocument(FIXTURE_TOOLS, 'case_fixture', grouped.documentId);
  assert.equal(one.versionGroup?.versionGroupId, grouped.versionGroupId);
  assert.ok(one.versionGroup?.humanReviewRequired);
  await assert.rejects(readDocument(FIXTURE_TOOLS, 'case_fixture', 'doc_missing'), (error: unknown) => error instanceof HttpError && error.status === 404);
});

test('timeline, parties, statements and coverage project their files', async () => {
  const timeline = await readTimeline(FIXTURE_TOOLS, 'case_fixture');
  assert.ok(timeline.events.length >= 2);
  assert.ok(timeline.events.every((event) => event.learnedAt === null && event.evidence.length >= 1));
  const parties = await readParties(FIXTURE_TOOLS, 'case_fixture');
  assert.ok(parties.parties.every((party) => party.humanReviewRequired && party.identityConfidence <= 0.5));
  const statements = await readStatements(FIXTURE_TOOLS, 'case_fixture', { status: null, humanReview: null });
  assert.equal(statements.statements.length, 2, 'the mechanical matrix rows the fixture archive supports');
  assert.equal(statements.needingReview, 2);
  assert.ok(statements.statements.every((row) => row.status !== 'verified' && row.verifiedBy === null));
  const coverage = await readCoverage(FIXTURE_TOOLS, 'case_fixture');
  assert.equal(coverage.coverage.totalFiles, 11);
});

test('a malformed artifact is refused as legal_artifact_invalid and bad ids as 400', async () => {
  const tools = await mkdtemp(join(tmpdir(), 'aria-ui-legal-'));
  const dir = join(tools, 'packs', 'legal', 'cases', 'case_bad');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'case.json'), '{"caseId":"case_bad","title":"x","createdAt":"2026-01-01T00:00:00Z"}', 'utf8');
  await writeFile(join(dir, 'documents.json'), '{"not":"an array"}', 'utf8');
  await assert.rejects(listCases(tools), (error: unknown) => error instanceof HttpError && error.status === 502 && error.code === 'legal_artifact_invalid');
  await assert.rejects(readCase(tools, '../etc'), (error: unknown) => error instanceof HttpError && error.status === 400);
});

/** A copy of the fixture case under a temp tools dir, so a test can corrupt one file. */
async function copiedCase(label: string): Promise<{ tools: string; dir: string }> {
  const tools = await mkdtemp(join(tmpdir(), `aria-ui-legal-${label}-`));
  const dir = join(tools, 'packs', 'legal', 'cases', 'case_fixture');
  await mkdir(dir, { recursive: true });
  const source = join(FIXTURE_TOOLS, 'packs', 'legal', 'cases', 'case_fixture');
  for (const name of ['case', 'documents', 'versions', 'parties', 'timeline', 'statements', 'links', 'coverage']) {
    await writeFile(join(dir, `${name}.json`), await readFile(join(source, `${name}.json`)));
  }
  return { tools, dir };
}

test('a hand-written verified statement is refused as a provenance failure, never served', async () => {
  const { tools, dir } = await copiedCase('verified');
  const rows = JSON.parse(await readFile(join(dir, 'statements.json'), 'utf8')) as Array<Record<string, unknown>>;
  rows[0] = { ...rows[0], status: 'verified', humanReviewRequired: false, verifiedBy: 'Advokat Kari Nordmann', verifiedAt: '2026-09-04T10:00:00Z' };
  await writeFile(join(dir, 'statements.json'), JSON.stringify(rows), 'utf8');
  await assert.rejects(
    readStatements(tools, 'case_fixture', { status: null, humanReview: null }),
    (error: unknown) => error instanceof HttpError && error.status === 502 && error.code === 'statement_provenance_invalid' && /statements\.json \$\[0\]/.test(error.detail ?? ''),
  );
  // The case listing reads the same file for its summary, so the case is refused there too.
  await assert.rejects(listCases(tools), (error: unknown) => error instanceof HttpError && error.code === 'statement_provenance_invalid');
});

test('an artifact from an adapter build the console does not know is refused by name, on every tab', async () => {
  const { tools, dir } = await copiedCase('version');
  const record = JSON.parse(await readFile(join(dir, 'case.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(join(dir, 'case.json'), JSON.stringify({ ...record, adapterVersion: '9.9.9' }), 'utf8');
  const unknownBuild = (error: unknown): boolean => error instanceof HttpError && error.status === 502 && error.code === 'legal_artifact_version_unknown' && /9\.9\.9/.test(error.detail ?? '');
  await assert.rejects(readCase(tools, 'case_fixture'), unknownBuild);
  await assert.rejects(readTimeline(tools, 'case_fixture'), unknownBuild);
  await assert.rejects(readStatements(tools, 'case_fixture', { status: null, humanReview: null }), unknownBuild);
  await assert.rejects(readDocuments(tools, 'case_fixture', { kind: null, extraction: null, limit: 10 }), unknownBuild);
});

test('every projection exposes explicit empty human decisions and no invented run identity', async () => {
  const detail = await readCase(FIXTURE_TOOLS, 'case_fixture');
  assert.equal(detail.runKey, null);
  assert.deepEqual(detail.lifecycle, { state: 'open', retainUntil: null, decision: null });
  const docs = await readDocuments(FIXTURE_TOOLS, 'case_fixture', { kind: null, extraction: null, limit: 1000 });
  assert.deepEqual(docs.filedDeclarations, []);
  assert.deepEqual(docs.removed, []);
  assert.deepEqual((await readParties(FIXTURE_TOOLS, 'case_fixture')).identityDecisions, []);
  assert.deepEqual((await readStatements(FIXTURE_TOOLS, 'case_fixture', { status: null, humanReview: null })).orphanedVerifications, []);
});

test('a current run pointer is authoritative for every projection and never falls back to flat artifacts', async () => {
  const { tools, dir } = await copiedCase('invalid-current');
  await writeFile(join(dir, 'current.json'), '{');
  const context = { casesDir: join(tools, 'custody'), verifier: loadOrCreateSigner(join(tools, 'key.pem')) };
  const readers = [
    () => listCases(tools, () => true, context),
    () => readCase(tools, 'case_fixture', context),
    () => readDocuments(tools, 'case_fixture', { kind: null, extraction: null, limit: 1000 }, context),
    () => readDocument(tools, 'case_fixture', 'any-document', context),
    () => readTimeline(tools, 'case_fixture', context),
    () => readParties(tools, 'case_fixture', context),
    () => readStatements(tools, 'case_fixture', { status: null, humanReview: null }, context),
    () => readCoverage(tools, 'case_fixture', context),
  ];
  for (const read of readers) {
    await assert.rejects(read(), (error: unknown) => error instanceof HttpError && error.status === 502);
  }
});

test('case detail and its summary use one generation when current changes during decision loading', async () => {
  const { tools, dir } = await copiedCase('generation');
  const verifier = loadOrCreateSigner(join(tools, 'key.pem'));
  const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const signed = (value: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify({ ...value, keyId: verifier.keyId, signature: sign(null, Buffer.from(JSON.stringify(value)), verifier.privateKey).toString('base64') }));
  const pointers: Buffer[] = [];
  for (const generation of ['first', 'second']) {
    const runKey = `run-${generation}`;
    const target = join(dir, 'runs', runKey);
    await mkdir(target, { recursive: true });
    const files: Array<{ name: string; bytes: number; sha256: string }> = [];
    for (const name of [...Object.values(LEGAL_ARTIFACT_FILES), 'kernel-result.json']) {
      let bytes = name === 'kernel-result.json' ? Buffer.from('{}') : await readFile(join(dir, name));
      if (name === 'case.json') bytes = Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), title: generation }));
      await writeFile(join(target, name), bytes);
      files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
    }
    const common = { schemaVersion: 1, caseId: 'case_fixture', runKey, adapterVersion: '0.1.0', snapshotSha256: 'a'.repeat(64), cycleId: null };
    const manifest = signed({ ...common, sourceVersion: 'b'.repeat(64), files });
    await writeFile(join(target, 'manifest.json'), manifest);
    pointers.push(signed({ ...common, files: Object.values(LEGAL_ARTIFACT_FILES), manifestSha256: hash(manifest) }));
  }
  const first = pointers[0];
  const second = pointers[1];
  assert.ok(first && second);
  await writeFile(join(dir, 'current.json'), first);
  const detail = await readCase(tools, 'case_fixture', {
    verifier,
    get casesDir(): string {
      writeFileSync(join(dir, 'current.json'), second);
      return join(tools, 'custody');
    },
  });
  assert.equal(detail.runKey, 'run-first');
  assert.equal(detail.case.title, 'first');
  assert.equal(detail.summary?.title, 'first');
  assert.equal((await readCase(tools, 'case_fixture', { verifier, casesDir: join(tools, 'custody') })).case.title, 'second');
});

test('case authorization filters directory names before any artifact is read', async () => {
  const { tools } = await copiedCase('authorized-list');
  const denied = join(tools, 'packs/legal/cases/case_denied');
  await mkdir(denied);
  await writeFile(join(denied, 'case.json'), 'not readable artifact JSON');
  const visible = await listCases(tools, (caseId) => caseId === 'case_fixture');
  assert.deepEqual(visible.cases.map((row) => row.caseId), ['case_fixture']);
});


test('a newly created case is listed and opens from custody metadata before the first inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legal-empty-case-'));
  const tools = join(root, 'tools');
  const casesDir = join(root, 'cases');
  const verifier = loadOrCreateSigner(join(root, 'key.pem'));
  const context = { casesDir, verifier };
  const meta = await createCase(casesDir, { caseId: 'new-case', title: 'New case', custodian: 'Counsel', jurisdiction: 'NO', courtReference: null, createdBy: 'operator' }, '2026-09-05T00:00:00.000Z');
  const listed = await listCases(tools, (id) => id === meta.caseId, context);
  assert.equal(listed.cases.length, 1);
  assert.equal(listed.cases[0]?.title, meta.title);
  const detail = await readCase(tools, meta.caseId, context);
  assert.deepEqual(detail.case, meta);
  assert.equal(detail.summary, null);
  assert.equal(detail.coverage, null, 'no inventory means no claim about extraction coverage');
  assert.equal(detail.runKey, null);
  await assert.rejects(readCase(tools, 'nonexistent', context), { code: 'case_not_found' });
});
