import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordDecision } from '../src/decisions.ts';
import { loadOrCreateSigner } from '../src/ledger.ts';
import { readDocument, readDocuments, readStatements } from '../src/readers/legal.ts';
import { statementFingerprint } from '../src/decisions-overlay.ts';

const filter = { status: null, humanReview: null };

test('signed verification survives reader restart, changed wording is orphaned, withdrawal restores machine state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legal-decisions-'));
  const tools = join(root, 'tools');
  const casesDir = join(root, 'cases');
  await mkdir(join(casesDir, 'case_fixture'), { recursive: true });
  await cp(new URL('./fixtures/tools/packs', import.meta.url), join(tools, 'packs'), { recursive: true });
  const signer = loadOrCreateSigner(join(root, 'key.pem'));
  const context = { casesDir, verifier: signer };
  const original = (await readStatements(tools, 'case_fixture', filter)).statements[0];
  assert.ok(original);
  const input = {
    caseId: 'case_fixture', kind: 'statement_verification' as const, targetId: original.statementId,
    body: { kind: 'statement_verification' as const, action: 'verify' as const, statementFingerprint: statementFingerprint(original) },
    decidedBy: 'lawyer-kari', role: 'lawyer', reason: 'Reviewed original sources', now: '2026-09-05T10:00:00.000Z',
  };
  await recordDecision(casesDir, signer, input);
  const verified = await readStatements(tools, 'case_fixture', { status: 'verified', humanReview: null }, context);
  assert.equal(verified.statements.length, 1);
  assert.equal(verified.statements[0]?.verifiedBy, 'lawyer-kari');
  assert.equal(verified.needingReview, 1);
  const restarted = { casesDir, verifier: loadOrCreateSigner(join(root, 'key.pem')) };
  assert.equal((await readStatements(tools, 'case_fixture', filter, restarted)).byStatus['verified'], 1);
  const path = join(tools, 'packs/legal/cases/case_fixture/statements.json');
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('lawyer-kari'), false, 'decision must not rewrite the artifact');
  await writeFile(path, raw.replace(original.statement, 'Different proposition'));
  const changed = await readStatements(tools, 'case_fixture', filter, restarted);
  assert.equal(changed.byStatus['verified'], undefined);
  assert.equal(changed.orphanedVerifications[0]?.reason, 'target_changed');
  await writeFile(path, raw);
  await recordDecision(casesDir, signer, { ...input, body: { ...input.body, action: 'withdraw' }, now: '2026-09-05T11:00:00.000Z' });
  const withdrawn = await readStatements(tools, 'case_fixture', filter, restarted);
  assert.equal(withdrawn.byStatus['verified'], undefined);
  assert.deepEqual(withdrawn.statements[0], original);
});


test('a signed filed declaration is consistent on the document list and document detail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legal-filed-'));
  const tools = join(root, 'tools');
  const casesDir = join(root, 'cases');
  await mkdir(join(casesDir, 'case_fixture'), { recursive: true });
  await cp(new URL('./fixtures/tools/packs', import.meta.url), join(tools, 'packs'), { recursive: true });
  const signer = loadOrCreateSigner(join(root, 'key.pem'));
  const context = { casesDir, verifier: signer };
  const all = await readDocuments(tools, 'case_fixture', { kind: null, extraction: null, limit: 1000 }, context);
  const group = all.versionGroups[0];
  assert.ok(group);
  const document = all.documents.find((doc) => doc.documentId === group.members[0]?.documentId);
  assert.ok(document);
  await recordDecision(casesDir, signer, {
    caseId: 'case_fixture', kind: 'filed_version_declaration', targetId: group.versionGroupId,
    body: { kind: 'filed_version_declaration', action: 'declare', documentId: document.documentId, sha256: document.sha256 },
    decidedBy: 'lawyer-kari', role: 'lawyer', reason: 'Reviewed filing receipt', now: '2026-09-05T10:00:00.000Z',
  });
  const list = await readDocuments(tools, 'case_fixture', { kind: null, extraction: null, limit: 1000 }, context);
  const detail = await readDocument(tools, 'case_fixture', document.documentId, context);
  assert.equal(list.versionGroups[0]?.filedMember, document.documentId);
  assert.equal(detail.versionGroup?.filedMember, document.documentId);
});
