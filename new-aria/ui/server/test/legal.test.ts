// SCENARIO: legal readers over artifacts the real inventory adapter produced
// from the synthetic fixture archive.
// EXPECTS: case listing/summary, document filters, version group lookup,
// timeline/parties/statements/coverage projections, malformed artifact → 502.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
