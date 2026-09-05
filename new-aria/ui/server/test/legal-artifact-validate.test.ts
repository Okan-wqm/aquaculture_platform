// SCENARIO: the console validates every legal artifact before it serves it.
// EXPECTS: the pack's golden artifacts pass field for field (parity with what
// the adapter really writes); a machine artifact carrying `verified` is refused
// under its own code; a malformed field is refused naming the file and path;
// an adapter build the console does not know is refused by name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LegalArtifactError,
  validateCase,
  validateCoverage,
  validateDocuments,
  validateLinks,
  validateParties,
  validateStatements,
  validateTimeline,
  validateVersions,
} from '../../shared/legal-artifact-validate.ts';

const EXPECTED = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packs', 'legal', 'fixtures', 'expected');

function golden(name: string): unknown {
  return JSON.parse(readFileSync(resolve(EXPECTED, `${name}.json`), 'utf8')) as unknown;
}

function refusal(run: () => unknown): LegalArtifactError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof LegalArtifactError, `expected a LegalArtifactError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a refusal, but the call returned' });
}

test("the pack's golden artifacts pass every validator: the reader accepts exactly what the adapter writes", () => {
  const record = validateCase(golden('case'));
  assert.equal(record.adapterVersion, '0.1.0');
  assert.equal(validateDocuments(golden('documents')).length, 11);
  assert.ok(validateVersions(golden('versions')).length >= 1);
  assert.ok(validateParties(golden('parties')).length >= 6);
  assert.ok(validateTimeline(golden('timeline')).length >= 10);
  const statements = validateStatements(golden('statements'));
  assert.equal(statements.length, 2);
  assert.ok(statements.every((row) => row.verifiedBy === null && row.verifiedAt === null && row.humanReviewRequired));
  assert.ok(validateLinks(golden('links')).length >= 1);
  assert.equal(validateCoverage(golden('coverage')).complete, true);
});

test('a machine artifact carrying a verification is refused under its own code, before any shape check', () => {
  const rows = golden('statements') as Array<Record<string, unknown>>;
  const verified = refusal(() => validateStatements([{ ...rows[0], status: 'verified', verifiedBy: 'Advokat Kari Nordmann', verifiedAt: '2026-09-04T10:00:00Z' }]));
  assert.equal(verified.code, 'statement_provenance_invalid');
  assert.equal(verified.file, 'statements.json');
  assert.equal(verified.path, '$[0]');
  // A verifier's name without the status is the same claim in a quieter voice.
  const named = refusal(() => validateStatements([{ ...rows[0], verifiedBy: 'someone' }]));
  assert.equal(named.code, 'statement_provenance_invalid');
});

test('a malformed field is refused naming the file and the path, not cast and served', () => {
  const documents = golden('documents') as Array<Record<string, unknown>>;
  const badHash = refusal(() => validateDocuments([{ ...documents[0], sha256: 'not-a-digest' }]));
  assert.equal(badHash.code, 'legal_artifact_invalid');
  assert.equal(badHash.file, 'documents.json');
  assert.equal(badHash.path, '$[0].sha256');

  const events = golden('timeline') as Array<Record<string, unknown>>;
  const overconfident = refusal(() => validateTimeline([{ ...events[0], confidence: 0.9 }]));
  assert.equal(overconfident.path, '$[0].confidence', 'a machine reading may not look more certain than 0.4');
  const unreviewed = refusal(() => validateTimeline([{ ...events[0], humanReviewRequired: false }]));
  assert.equal(unreviewed.path, '$[0].humanReviewRequired');

  const coverage = golden('coverage') as Record<string, unknown>;
  const badCaseId = refusal(() => validateCoverage({ ...coverage, caseId: 'case_Synthetic' }));
  assert.equal(badCaseId.path, '$.caseId', 'the case id must match the one pattern both sides share');
});

test('an adapter build the console does not know is refused by name', () => {
  const record = golden('case') as Record<string, unknown>;
  const unknown = refusal(() => validateCase({ ...record, adapterVersion: '9.9.9' }));
  assert.equal(unknown.code, 'legal_artifact_version_unknown');
  assert.match(unknown.message, /9\.9\.9/);
});
