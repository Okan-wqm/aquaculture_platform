// Tests for the Legal pack document-inventory adapter.
//
// WHY: the adapter is the mechanical floor of the pack — if it is
// non-deterministic, skips a file, reads an excluded root, merges two parties,
// or drifts from `ui/shared/legal-contract.ts`, every record above it inherits
// the defect. These tests pin each of those promises to an observable.
//
// WHAT: node:test cases over (a) the committed synthetic archive, (b) small
// temp archives built per test for edge cases, (c) the CLI stdin/stdout
// contract, (d) schema ↔ contract ↔ artifact field parity, and (e) a golden
// comparison. Run from `new-aria/`:
//   npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/legal-document-inventory.test.ts
// Regenerate goldens (after an intentional behaviour change) with UPDATE_GOLDEN=1.
//
// Golden normalisation decision: file mtimes are not stored by git, so
// `documents[].modifiedAt` cannot be git-stable. The goldens are therefore
// written through `normalizeArtifacts` (modifiedAt → null) and compared through
// the same function; every other field is derived from bytes, names, or the
// fixed `created_at` in the manifest's default_input. Version ordinals in the
// fixture come from `v1`/`v2` name markers (basis `name_suffix`), so
// versions.json is byte-stable without normalisation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { runLegalDocumentInventory } from './legal-document-inventory';
import type { AriaOutput, LegalInventoryInput } from './legal-document-inventory';
import { ADAPTER_ID, ARTIFACT_ROOT } from './legal-records';
import type { LegalCaseArtifacts } from './legal-records';
import { extractAmounts, extractDates, guessKind, jaccard, normalizedStem, parseAddressList, parseEmail, parseRfc2822Date } from './legal-text';

interface ToolManifest {
  readonly tool_id: string;
  readonly status: string;
  readonly output_schema: { readonly required: readonly string[] };
  readonly default_input: LegalInventoryInput;
  readonly forbidden_read_globs: readonly string[];
  readonly claim_types: readonly string[];
  readonly runner: { readonly argv: readonly string[] };
}

interface JsonSchema {
  readonly required?: readonly string[];
  readonly properties?: Record<string, JsonSchema>;
  readonly enum?: readonly string[];
  readonly items?: JsonSchema;
  readonly const?: unknown;
}

interface PackManifest {
  readonly id: string;
  readonly record_kinds: readonly string[];
  readonly link_kinds: readonly string[];
  readonly statement_statuses: readonly string[];
  readonly assertion_sources: readonly string[];
  readonly extraction_statuses: readonly string[];
  readonly claim_types: readonly string[];
  readonly adapters: ReadonlyArray<{ readonly tool_id: string; readonly manifest: string; readonly entry: string; readonly claim_types: readonly string[] }>;
  readonly agents: ReadonlyArray<{ readonly name: string; readonly path: string; readonly role: string; readonly may_emit_claim_types: readonly string[] }>;
  readonly artifacts: { readonly root: string; readonly files: Record<string, string>; readonly schemas: Record<string, string> };
}

const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..');
const PACK_ROOT = resolve(WORKSPACE_ROOT, 'packs', 'legal');
const EXPECTED_DIR = resolve(PACK_ROOT, 'fixtures', 'expected');
const CONTRACT_PATH = resolve(WORKSPACE_ROOT, 'ui', 'shared', 'legal-contract.ts');
const MANIFEST = JSON.parse(readFileSync(resolve(__dirname, 'legal-document-inventory.tool.json'), 'utf8')) as ToolManifest;
const PACK = JSON.parse(readFileSync(resolve(PACK_ROOT, 'pack.json'), 'utf8')) as PackManifest;
const GOLDEN_INPUT: LegalInventoryInput = MANIFEST.default_input;
const ARTIFACT_NAMES = ['case', 'documents', 'versions', 'parties', 'timeline', 'statements', 'links', 'coverage'] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `aria-legal-${label}-`));
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeArtifacts(artifacts: LegalCaseArtifacts): LegalCaseArtifacts {
  return { ...artifacts, documents: artifacts.documents.map((document) => ({ ...document, modifiedAt: null })) };
}

function normalizeOutput(output: AriaOutput): AriaOutput {
  return { ...output, metadata: { ...output.metadata, out_dir: '<out_dir>', artifact_dir: '<artifact_dir>' } };
}

function runGolden(outDir: string): { readonly artifacts: LegalCaseArtifacts; readonly output: AriaOutput; readonly artifactDir: string } {
  const result = runLegalDocumentInventory({ ...GOLDEN_INPUT, out_dir: outDir }, WORKSPACE_ROOT);
  assert.ok(result.artifacts && result.artifactDir, 'golden run must produce artifacts');
  return { artifacts: result.artifacts, output: result.output, artifactDir: result.artifactDir };
}

function listTree(root: string, prefix = ''): string[] {
  const rows: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    const info = statSync(path);
    if (info.isDirectory()) rows.push(...listTree(path, rel));
    else rows.push(`${rel}\t${info.size}\t${info.mtimeMs}`);
  }
  return rows;
}

function readSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(resolve(PACK_ROOT, 'schemas', `${name}.schema.json`), 'utf8')) as JsonSchema;
}

function schemaEnum(schema: JsonSchema, ...path: string[]): readonly string[] {
  let cursor: JsonSchema = schema;
  for (const segment of path) {
    const next = cursor.properties?.[segment] ?? (segment === 'items' ? cursor.items : undefined);
    assert.ok(next, `schema path segment missing: ${path.join('.')} at ${segment}`);
    cursor = next;
  }
  assert.ok(cursor.enum, `schema path has no enum: ${path.join('.')}`);
  return cursor.enum;
}

const contractSource = readFileSync(CONTRACT_PATH, 'utf8');

function contractInterfaceFields(name: string): { readonly all: string[]; readonly required: string[] } {
  const block = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(contractSource);
  assert.ok(block, `interface ${name} not found in legal-contract.ts`);
  const all: string[] = [];
  const required: string[] = [];
  // Only depth-0 members count: `members: ReadonlyArray<{ readonly documentId … }>`
  // opens a nested object literal whose fields belong to the item, not the record.
  let depth = 0;
  for (const line of (block[1] ?? '').split('\n')) {
    const match = /^\s+readonly (\w+)(\?)?:/.exec(line);
    if (depth === 0 && match) {
      const field = match[1] ?? '';
      all.push(field);
      if (match[2] === undefined) required.push(field);
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return { all, required };
}

function contractConst(name: string): string[] {
  const block = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(contractSource);
  assert.ok(block, `const ${name} not found in legal-contract.ts`);
  return [...(block[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function writeArchiveFile(root: string, relativePath: string, content: string | Buffer): void {
  const path = join(root, relativePath);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

// ---------------------------------------------------------------------------
// Fixture-archive behaviour
// ---------------------------------------------------------------------------
test('determinism: two runs over the same archive produce byte-identical artifacts and outputs', () => {
  const first = runGolden(tempDir('det-a'));
  const second = runGolden(tempDir('det-b'));
  for (const name of ARTIFACT_NAMES) {
    const a = readFileSync(join(first.artifactDir, `${name}.json`), 'utf8');
    const b = readFileSync(join(second.artifactDir, `${name}.json`), 'utf8');
    assert.equal(a, b, `${name}.json differs between two runs`);
  }
  assert.deepEqual(normalizeOutput(first.output), normalizeOutput(second.output));
});

test('coverage: every file has a fate, counts add up, complete is true', () => {
  const { artifacts } = runGolden(tempDir('cov'));
  const { coverage } = artifacts;
  assert.equal(coverage.caseId, 'case_synthetic-001');
  assert.equal(coverage.totalFiles, 11);
  // 8 text = 6 plain-text files + the invoice PDF + the complaint DOCX, whose
  // text layers are read; 2 metadata_only = the scanned PDF (no text layer) and
  // the encrypted PDF (declared /Encrypt), each with its reason in `unreadable`.
  assert.deepEqual(coverage.byExtraction, { text: 8, metadata_only: 2, unreadable: 0, excluded: 1 });
  const summed = Object.values(coverage.byExtraction).reduce((total, count) => total + count, 0);
  assert.equal(summed, coverage.totalFiles);
  assert.equal(artifacts.documents.length, coverage.totalFiles);
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.byKind, {COMMUNICATION: 2, DOCUMENT: 7, FINANCIAL_LOSS: 1, PROCEDURAL_STEP: 1});
});

test('excluded root is recorded, listed as excluded, and never read', () => {
  const { artifacts, output } = runGolden(tempDir('excl'));
  assert.deepEqual(artifacts.coverage.excludedRoots, ['Ikke laste opp']);
  const excluded = artifacts.documents.filter((document) => document.extraction === 'excluded');
  assert.equal(excluded.length, 1);
  const [privat] = excluded;
  assert.ok(privat);
  assert.equal(privat.relativePath, 'Ikke laste opp/privat_notat.txt');
  assert.equal(privat.sha256, '');
  assert.equal(privat.excerpt, null);
  assert.equal(privat.excludedReason, 'excluded_root:Ikke laste opp');
  assert.ok(privat.bytes > 0, 'excluded files are stat-ed (size known) but not opened');
  assert.ok(!output.read_paths.some((path) => path.includes('Ikke laste opp')), 'excluded path must not appear in read_paths');
  assert.ok(output.observations.some((observation) => observation.path.endsWith('Ikke laste opp/privat_notat.txt')), 'excluded file still observed');
  assert.deepEqual(output.metadata['exclude_roots_not_found'], []);
});

test('binary formats: PDF/DOCX text layers are read; scanned and encrypted PDFs stay metadata_only with a stated reason, a coverage gap and a medium finding', () => {
  const { artifacts, output } = runGolden(tempDir('binary'));
  const byPath = new Map(artifacts.documents.map((document) => [document.relativePath, document]));
  const pdf = byPath.get('vedlegg/faktura_2024-001.pdf');
  const docx = byPath.get('vedlegg/klage_utkast.docx');
  const scanned = byPath.get('vedlegg/skannet_kvittering.pdf');
  const encrypted = byPath.get('vedlegg/forlikstilbud_kryptert.pdf');
  assert.ok(pdf && docx && scanned && encrypted);

  // Readable binaries behave exactly like text files: hash, excerpt, dates, amounts.
  for (const document of [pdf, docx]) {
    assert.equal(document.extraction, 'text');
    assert.match(document.sha256, /^[0-9a-f]{64}$/);
    assert.ok(document.excerpt !== null && document.excerpt.length > 0);
    assert.doesNotMatch(document.excerpt ?? '', /\[page \d+\]/, 'page markers are locators, not prose');
  }
  assert.equal(pdf.mediaType, 'application/pdf');
  assert.equal(pdf.kindGuess, 'FINANCIAL_LOSS');
  assert.ok(pdf.datesMentioned.includes('2024-03-12') && pdf.datesMentioned.includes('2024-03-26'), 'invoice date and due date come from the PDF text layer');
  assert.ok(pdf.amountsMentioned.includes('NOK 6 187 500,00'));
  assert.equal(docx.kindGuess, 'PROCEDURAL_STEP');
  assert.ok(docx.datesMentioned.includes('2024-03-06'), 'the complaint date comes from word/document.xml');
  assert.ok(docx.amountsMentioned.includes('NOK 230 175'), 'a table cell amount is read');

  // Honest refusals: hashed and inventoried, no text, and the reason travels.
  for (const document of [scanned, encrypted]) {
    assert.equal(document.extraction, 'metadata_only');
    assert.match(document.sha256, /^[0-9a-f]{64}$/);
    assert.equal(document.excerpt, null);
    assert.deepEqual(document.datesMentioned, []);
  }
  assert.deepEqual(artifacts.coverage.unreadable, [
    { relativePath: 'vedlegg/forlikstilbud_kryptert.pdf', reason: 'pdf_encrypted' },
    { relativePath: 'vedlegg/skannet_kvittering.pdf', reason: 'pdf_no_text_layer:1_pages' },
  ]);
  const unreadableFindings = output.findings.filter((finding) => finding.rule === 'unreadable_document');
  assert.equal(unreadableFindings.length, 2);
  for (const finding of unreadableFindings) {
    assert.equal(finding.severity, 'medium');
    assert.equal(finding.evidence.length, 1);
    assert.ok(output.read_paths.includes(finding.evidence[0]?.path ?? ''), 'evidence path must be in read_paths');
  }
  assert.ok(unreadableFindings.some((finding) => finding.message.includes('pdf_encrypted')));
  assert.ok(unreadableFindings.some((finding) => finding.message.includes('pdf_no_text_layer')));

  // A binary above max_binary_bytes is hashed but not loaded, with the bound in the reason.
  const archive = tempDir('too-large-archive');
  writeArchiveFile(archive, 'stor.pdf', readFileSync(resolve(WORKSPACE_ROOT, GOLDEN_INPUT.archive_root, 'vedlegg', 'faktura_2024-001.pdf')));
  const result = runLegalDocumentInventory({ archive_root: archive, case_id: 'too-large', out_dir: tempDir('too-large-out'), max_binary_bytes: 100 });
  assert.ok(result.artifacts);
  const stor = result.artifacts.documents.find((document) => document.relativePath === 'stor.pdf');
  assert.ok(stor);
  assert.equal(stor.extraction, 'metadata_only');
  assert.match(stor.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.artifacts.coverage.unreadable[0]?.reason ?? '', /^binary_too_large:\d+>100$/);
});

test('symlinks are never followed: they are inventoried as unreadable with an explicit reason', () => {
  const archive = tempDir('symlink-archive');
  writeArchiveFile(archive, 'a.txt', 'Innhold 2024-01-05 med tre ord her.\n');
  symlinkSync(join(archive, 'a.txt'), join(archive, 'lenke.txt'));
  symlinkSync(join(archive, 'finnes-ikke.txt'), join(archive, 'brutt.txt'));
  const result = runLegalDocumentInventory({ archive_root: archive, case_id: 'symlink', out_dir: tempDir('symlink-out') });
  assert.ok(result.artifacts);
  const byPath = new Map(result.artifacts.documents.map((document) => [document.relativePath, document]));
  assert.equal(byPath.get('lenke.txt')?.extraction, 'unreadable');
  assert.equal(byPath.get('brutt.txt')?.extraction, 'unreadable');
  assert.equal(byPath.get('lenke.txt')?.sha256, '');
  assert.deepEqual(
    result.artifacts.coverage.unreadable,
    [
      { relativePath: 'brutt.txt', reason: 'symlink_not_followed' },
      { relativePath: 'lenke.txt', reason: 'symlink_not_followed' },
    ],
  );
  assert.equal(result.artifacts.coverage.complete, true);
  assert.equal(result.output.findings.filter((finding) => finding.rule === 'unreadable_document').length, 2);
});

test('version grouping: the two avtale files form one group, v1 before v2, signed member detected', () => {
  const { artifacts, output } = runGolden(tempDir('ver'));
  assert.equal(artifacts.versions.length, 1);
  const [group] = artifacts.versions;
  assert.ok(group);
  const v1 = artifacts.documents.find((document) => document.relativePath === 'avtale_v1.txt');
  const v2 = artifacts.documents.find((document) => document.relativePath === 'avtale_v2_signert.txt');
  assert.ok(v1 && v2);
  assert.equal(v1.versionGroupId, group.versionGroupId);
  assert.equal(v2.versionGroupId, group.versionGroupId);
  assert.deepEqual(
    group.members.map((member) => [member.documentId, member.ordinal, member.basis]),
    [
      [v1.documentId, 1, 'name_suffix'],
      [v2.documentId, 2, 'name_suffix'],
    ],
  );
  assert.equal(group.members[0]?.similarityToPrevious, null);
  assert.equal(group.members[1]?.similarityToPrevious, 0.25);
  assert.equal(group.signedMember, v2.documentId);
  assert.equal(group.filedMember, null);
  assert.equal(group.humanReviewRequired, true);
  const versionLinks = artifacts.links.filter((link) => link.kind === 'VERSION_OF');
  assert.equal(versionLinks.length, 1);
  assert.deepEqual(versionLinks[0]?.from, { kind: 'DOCUMENT', id: v2.documentId });
  assert.deepEqual(versionLinks[0]?.to, { kind: 'DOCUMENT', id: v1.documentId });
  const conflict = output.findings.find((finding) => finding.rule === 'document_version_conflict');
  assert.ok(conflict);
  assert.equal(conflict.severity, 'low');
  assert.deepEqual(
    conflict.evidence.map((ref) => ref.path),
    ['packs/legal/fixtures/case-synthetic/avtale_v1.txt', 'packs/legal/fixtures/case-synthetic/avtale_v2_signert.txt'],
  );
  assert.ok(artifacts.documents.filter((document) => document.versionGroupId !== null).length === 2, 'singletons carry versionGroupId null');
});

test('version grouping: identical bytes group across different names; copy markers are stripped; invoice numbers are not', () => {
  const archive = tempDir('vg-archive');
  writeArchiveFile(archive, 'notat.txt', 'Samme innhold.\n');
  writeArchiveFile(archive, 'notat kopi (1).txt', 'Samme innhold.\n');
  writeArchiveFile(archive, 'brev.txt', 'Helt annet brev.\n');
  writeArchiveFile(archive, 'vedlegg/kopi_av_brev.txt', 'Helt annet brev.\n');
  writeArchiveFile(archive, 'faktura_2024-001.txt', 'Faktura en.\n');
  writeArchiveFile(archive, 'faktura_2024-002.txt', 'Faktura to.\n');
  const result = runLegalDocumentInventory({ archive_root: archive, case_id: 'vg', out_dir: tempDir('vg-out') });
  assert.ok(result.artifacts);
  assert.equal(normalizedStem('notat kopi (1).txt'), 'notat');
  assert.equal(normalizedStem('avtale_v2_signert.txt'), 'avtale');
  assert.equal(normalizedStem('rapport-final-draft.docx'), 'rapport');
  assert.notEqual(normalizedStem('faktura_2024-001.txt'), normalizedStem('faktura_2024-002.txt'));
  assert.equal(result.artifacts.versions.length, 2, 'notat pair + byte-identical brev pair; invoices stay apart');
  for (const group of result.artifacts.versions) {
    assert.equal(group.members.length, 2);
    assert.ok(group.members.every((member) => member.basis === 'content_similarity'), 'identical bytes → content_similarity basis');
  }
  const byteTwins = result.artifacts.links.filter((link) => link.kind === 'VERSION_OF');
  assert.equal(byteTwins.length, 2);
  assert.ok(byteTwins.every((link) => link.confidence === 0.9));
});

test('parties come only from .eml headers, one party per address, never merged by display name', () => {
  const { artifacts } = runGolden(tempDir('parties'));
  assert.deepEqual(
    artifacts.parties.map((party) => [party.displayName, party.aliases, party.mentions, party.kind, party.humanReviewRequired]),
    [
      ['Part B', ['Part B', 'part.b@example.org'], 2, 'unknown', true],
      ['Part A AS', ['Part A AS', 'post@part-a.example'], 2, 'unknown', true],
      ['Advokat Eksempel', ['Advokat Eksempel', 'advokat@example.net'], 1, 'unknown', true],
    ],
  );
  assert.ok(artifacts.parties.every((party) => party.identityConfidence <= 0.5));
  assert.ok(artifacts.parties.every((party) => party.evidence.every((ref) => ref.locator?.startsWith('header:'))));

  const archive = tempDir('same-name-archive');
  writeArchiveFile(archive, 'a.eml', 'From: "Ola Nordmann" <ola@example.org>\nTo: "Kari" <kari@example.org>\nDate: Mon, 1 Jan 2024 10:00:00 +0000\nSubject: A\n\nHei\n');
  writeArchiveFile(archive, 'b.eml', 'From: "Ola Nordmann" <ola.nordmann@example.net>\nTo: "Kari" <kari@example.org>\nDate: Tue, 2 Jan 2024 10:00:00 +0000\nSubject: B\n\nHei igjen\n');
  const result = runLegalDocumentInventory({ archive_root: archive, case_id: 'same-name', out_dir: tempDir('same-name-out') });
  assert.ok(result.artifacts);
  const olas = result.artifacts.parties.filter((party) => party.displayName === 'Ola Nordmann');
  assert.equal(olas.length, 2, 'same display name, different addresses → two parties');
  assert.notEqual(olas[0]?.partyId, olas[1]?.partyId);
});

test('WAS_SENT_BY / WAS_RECEIVED_BY links anchor each .eml document to its parties with header evidence', () => {
  const { artifacts } = runGolden(tempDir('links'));
  const mailA = artifacts.documents.find((document) => document.relativePath.endsWith('2024-03-04_part-a_til_part-b.eml'));
  const partA = artifacts.parties.find((party) => party.displayName === 'Part A AS');
  const partB = artifacts.parties.find((party) => party.displayName === 'Part B');
  const advokat = artifacts.parties.find((party) => party.displayName === 'Advokat Eksempel');
  assert.ok(mailA && partA && partB && advokat);
  const fromMailA = artifacts.links.filter((link) => link.from.id === mailA.documentId);
  assert.deepEqual(
    sorted(fromMailA.map((link) => `${link.kind}:${link.to.id}:${link.evidence[0]?.locator ?? ''}`)),
    sorted([
      `WAS_SENT_BY:${partA.partyId}:header:From`,
      `WAS_RECEIVED_BY:${partB.partyId}:header:To`,
      `WAS_RECEIVED_BY:${advokat.partyId}:header:Cc`,
    ]),
  );
  assert.ok(fromMailA.every((link) => link.evidence[0]?.sha256 === mailA.sha256));
  assert.ok(fromMailA.every((link) => link.from.kind === 'DOCUMENT' && link.to.kind === 'PARTY'));
});

test('dates and amounts are extracted, normalised, deduplicated and sorted', () => {
  const { artifacts } = runGolden(tempDir('dates'));
  const byPath = new Map(artifacts.documents.map((document) => [document.relativePath, document]));
  assert.deepEqual(byPath.get('kronologi.txt')?.datesMentioned, ['2024-02-20', '2024-03-01', '2024-03-12']);
  assert.deepEqual(byPath.get('kronologi.txt')?.amountsMentioned, ['25 000 kr', 'kr 25 000,-']);
  assert.deepEqual(byPath.get('notat.md')?.datesMentioned, ['2024-03-05', '2024-03-20']);
  assert.deepEqual(byPath.get('avtale_v1.txt')?.amountsMentioned, ['kr 125 000,00']);
  assert.deepEqual(byPath.get('korrespondanse/2024-03-12_part-b_til_part-a.eml')?.amountsMentioned, ['NOK 25 000']);
  assert.deepEqual(byPath.get('korrespondanse/2024-03-12_part-b_til_part-a.eml')?.datesMentioned, ['2024-03-10', '2024-03-12', '2024-03-20']);

  assert.deepEqual(extractDates('Frist 31/12/2024, møte 5. januar 2025 og January 7, 2025; 2025-01-07T10:00:00Z; 31.02.2024 er ugyldig; tel 2024-13-01'), [
    '2024-12-31',
    '2025-01-05',
    '2025-01-07',
  ]);
  assert.deepEqual(extractAmounts('Beløp kr 1.250.000,50 eller 300 EUR eller € 45 eller $12.50 eller 2 500,- og USD 7'), [
    '$12.50',
    '2 500,-',
    '300 EUR',
    'USD 7',
    'kr 1.250.000,50',
    '€ 45',
  ]);
});

test('timeline: .eml Date headers become COMMUNICATION events, dated text lines become ai_inference EVENTs, learnedAt stays null', () => {
  const { artifacts } = runGolden(tempDir('timeline'));
  assert.equal(artifacts.timeline.length, 12);
  const communications = artifacts.timeline.filter((event) => event.kind === 'COMMUNICATION');
  assert.deepEqual(
    communications.map((event) => [event.occurredAt, event.assertedBy, event.datePrecision, event.evidence[0]?.locator]),
    [
      ['2024-03-04T08:15:00Z', 'party', 'day', 'header:Date'],
      ['2024-03-12T13:02:00Z', 'party', 'day', 'header:Date'],
    ],
  );
  const events = artifacts.timeline.filter((event) => event.kind === 'EVENT');
  assert.equal(events.length, 10);
  assert.ok(
    events.some((event) => event.evidence[0]?.documentId === artifacts.documents.find((document) => document.relativePath === 'vedlegg/faktura_2024-001.pdf')?.documentId),
    'a dated line inside the PDF text layer becomes an inferred EVENT',
  );
  assert.ok(events.every((event) => event.assertedBy === 'ai_inference' && event.confidence <= 0.4 && event.humanReviewRequired));
  assert.ok(artifacts.timeline.every((event) => event.learnedAt === null));
  const documentsById = new Map(artifacts.documents.map((document) => [document.documentId, document]));
  for (const event of artifacts.timeline) {
    assert.equal(event.evidence.length, 1);
    const ref = event.evidence[0];
    assert.ok(ref);
    assert.equal(documentsById.get(ref.documentId)?.sha256, ref.sha256, 'event evidence hash must match its document');
  }
  const bestrider = events.find((event) => event.summary.startsWith('12.03.2024'));
  assert.ok(bestrider);
  assert.equal(bestrider.occurredAt, '2024-03-12');
  assert.equal(bestrider.evidence[0]?.locator, 'line:5');
  assert.deepEqual(artifacts.statements, []);
});

test('no writes outside out_dir; the archive is never mutated', () => {
  const archiveAbs = resolve(WORKSPACE_ROOT, GOLDEN_INPUT.archive_root);
  const before = listTree(archiveAbs);
  const outDir = tempDir('outdir');
  const { artifactDir } = runGolden(outDir);
  assert.deepEqual(listTree(archiveAbs), before, 'archive tree changed during the run');
  const expectedPrefix = `${ARTIFACT_ROOT}/case_synthetic-001/`;
  const written = listTree(outDir).map((row) => row.split('\t')[0] ?? '');
  assert.deepEqual(written, sorted(ARTIFACT_NAMES.map((name) => `${expectedPrefix}${name}.json`)));
  assert.ok(written.every((path) => !path.includes('.tmp-')), 'atomic writes must leave no temp files');
  assert.equal(artifactDir, resolve(outDir, ARTIFACT_ROOT, 'case_synthetic-001'));
});

test('L1: every evidence path is inside read_paths; evidence_sources equals read_paths; excluded files are outside both', () => {
  const { output } = runGolden(tempDir('l1'));
  const readPaths = new Set(output.read_paths);
  assert.equal(output.read_paths.length, 10);
  assert.deepEqual(output.evidence_sources, output.read_paths);
  for (const finding of output.findings) {
    assert.ok(finding.evidence.length >= 1, `${finding.id} has no evidence`);
    for (const ref of finding.evidence) assert.ok(readPaths.has(ref.path), `${finding.id} cites ${ref.path} outside read_paths`);
  }
  assert.equal(output.observations.length, 11);
  assert.ok(output.observations.every((observation) => observation.type === 'legal_document_inventoried'));
  assert.deepEqual(output.belief_candidates, []);
  assert.equal(output.cost_units, 11);
});

test('input guards: absent archive root exits clean as scope_absent; unsafe case_id and exclude_roots are rejected', () => {
  const outDir = tempDir('guards');
  const absent = runLegalDocumentInventory({ archive_root: join(outDir, 'nope'), case_id: 'x', out_dir: outDir });
  assert.equal(absent.output.metadata['status'], 'scope_absent');
  assert.equal(absent.artifacts, null);
  assert.deepEqual(readdirSync(outDir), []);
  assert.throws(() => runLegalDocumentInventory({ archive_root: '.', case_id: '../escape', out_dir: outDir }, WORKSPACE_ROOT), /case_id/);
  assert.throws(() => runLegalDocumentInventory({ archive_root: '.', case_id: 'ok', exclude_roots: ['../x'], out_dir: outDir }, WORKSPACE_ROOT), /exclude_roots/);
  const missingRoot = runLegalDocumentInventory({ ...GOLDEN_INPUT, exclude_roots: ['Finnes ikke'], out_dir: tempDir('guards-2') }, WORKSPACE_ROOT);
  assert.deepEqual(missingRoot.artifacts?.coverage.excludedRoots, []);
  assert.deepEqual(missingRoot.output.metadata['exclude_roots_not_found'], ['Finnes ikke']);
});

// ---------------------------------------------------------------------------
// Unit-level parsers
// ---------------------------------------------------------------------------
test('parsers: rfc2822 dates, address lists, folded headers, kind guesses, jaccard', () => {
  assert.deepEqual(parseRfc2822Date('Mon, 4 Mar 2024 09:15:00 +0100'), { iso: '2024-03-04T08:15:00Z', precision: 'day' });
  assert.deepEqual(parseRfc2822Date('4 Mar 2024 09:15 -0500'), { iso: '2024-03-04T14:15:00Z', precision: 'day' });
  assert.deepEqual(parseRfc2822Date('Tue, 12 Mar 2024 14:02:00 GMT'), { iso: '2024-03-12T14:02:00Z', precision: 'day' });
  assert.deepEqual(parseRfc2822Date('Tue, 12 Mar 2024 14:02:00 CEST'), { iso: '2024-03-12', precision: 'day' });
  assert.equal(parseRfc2822Date('yesterday'), null);
  assert.deepEqual(parseAddressList('"Part A AS" <post@part-a.example>, Part B <part.b@example.org>, bare@example.net'), [
    { displayName: 'Part A AS', address: 'post@part-a.example' },
    { displayName: 'Part B', address: 'part.b@example.org' },
    { displayName: null, address: 'bare@example.net' },
  ]);
  assert.deepEqual(parseAddressList('"Last, First" <lf@example.org>'), [{ displayName: 'Last, First', address: 'lf@example.org' }]);
  const mail = parseEmail('Subject: Long\n subject folded\nFrom: a@example.org\n\nBody line\n');
  assert.deepEqual(mail.headers.get('subject'), ['Long subject folded']);
  assert.equal(mail.body, 'Body line\n');
  assert.deepEqual(guessKind('dom_2024.pdf'), { kind: 'DECISION', confidence: 0.5 });
  assert.deepEqual(guessKind('random.pdf'), { kind: 'DOCUMENT', confidence: 0.3 });
  assert.deepEqual(guessKind('kingdom.txt'), { kind: 'DOCUMENT', confidence: 0.3 });
  assert.deepEqual(guessKind('archive.bin'), { kind: 'UNKNOWN', confidence: 0 });
  assert.equal(jaccard(['avtale', 'v1'], ['avtale', 'v2', 'signert']), 0.25);
});

// ---------------------------------------------------------------------------
// Contract parity: legal-contract.ts ↔ schemas ↔ pack.json ↔ emitted records
// ---------------------------------------------------------------------------
test('schemas mirror legal-contract.ts interfaces field-for-field', () => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['LegalEvidenceRef', 'evidence-ref'],
    ['LegalCase', 'case'],
    ['LegalDocument', 'document'],
    ['LegalDocumentVersion', 'document-version'],
    ['LegalParty', 'party'],
    ['LegalTimelineEvent', 'timeline-event'],
    ['LegalStatement', 'statement'],
    ['LegalLink', 'link'],
    ['LegalCoverage', 'coverage'],
  ];
  for (const [interfaceName, schemaName] of pairs) {
    const fields = contractInterfaceFields(interfaceName);
    const schema = readSchema(schemaName);
    assert.deepEqual(sorted(Object.keys(schema.properties ?? {})), sorted(fields.all), `${schemaName}.schema.json properties ≠ ${interfaceName} fields`);
    assert.deepEqual(sorted(schema.required ?? []), sorted(fields.required), `${schemaName}.schema.json required ≠ ${interfaceName} non-optional fields`);
  }
});

test('enums are identical across legal-contract.ts, schemas and pack.json', () => {
  const recordKinds = contractConst('LEGAL_RECORD_KINDS');
  const linkKinds = contractConst('LEGAL_LINK_KINDS');
  const statementStatuses = contractConst('STATEMENT_STATUSES');
  const assertionSources = contractConst('ASSERTION_SOURCES');
  const extractionStatuses = contractConst('EXTRACTION_STATUSES');
  assert.deepEqual(PACK.record_kinds, recordKinds);
  assert.deepEqual(PACK.link_kinds, linkKinds);
  assert.deepEqual(PACK.statement_statuses, statementStatuses);
  assert.deepEqual(PACK.assertion_sources, assertionSources);
  assert.deepEqual(PACK.extraction_statuses, extractionStatuses);
  const link = readSchema('link');
  const statement = readSchema('statement');
  const document = readSchema('document');
  const timeline = readSchema('timeline-event');
  const coverage = readSchema('coverage');
  const pack = readSchema('pack');
  assert.deepEqual(schemaEnum(link, 'kind'), linkKinds);
  assert.deepEqual(schemaEnum(link, 'from', 'kind'), recordKinds);
  assert.deepEqual(schemaEnum(statement, 'status'), statementStatuses);
  assert.deepEqual(schemaEnum(statement, 'assertedBy'), assertionSources);
  assert.deepEqual(schemaEnum(timeline, 'assertedBy'), assertionSources);
  assert.deepEqual(schemaEnum(document, 'extraction'), extractionStatuses);
  assert.deepEqual(schemaEnum(document, 'kindGuess'), [...recordKinds, 'UNKNOWN']);
  assert.deepEqual(sorted(coverage.properties?.['byExtraction']?.required ?? []), sorted(extractionStatuses));
  assert.deepEqual(schemaEnum(pack, 'record_kinds', 'items'), recordKinds);
  assert.deepEqual(schemaEnum(pack, 'claim_types', 'items'), PACK.claim_types);
  const artifactFiles = /export const LEGAL_ARTIFACT_FILES = \{([\s\S]*?)\} as const/.exec(contractSource);
  assert.ok(artifactFiles);
  const contractFiles = Object.fromEntries([...(artifactFiles[1] ?? '').matchAll(/(\w+): '([^']+)'/g)].map((match) => [match[1] ?? '', match[2] ?? '']));
  assert.deepEqual(PACK.artifacts.files, contractFiles);
  assert.match(contractSource, new RegExp(`LEGAL_ARTIFACT_ROOT = '${PACK.artifacts.root}'`));
  assert.equal(ARTIFACT_ROOT, PACK.artifacts.root);
});

test('emitted records carry exactly the schema fields and only pack-declared claim types', () => {
  const { artifacts, output } = runGolden(tempDir('shape'));
  const schemaFor: Record<ArtifactName, string | null> = {
    case: 'case',
    documents: 'document',
    versions: 'document-version',
    parties: 'party',
    timeline: 'timeline-event',
    statements: 'statement',
    links: 'link',
    coverage: 'coverage',
  };
  const evidenceRef = readSchema('evidence-ref');
  const evidenceProps = new Set(Object.keys(evidenceRef.properties ?? {}));
  for (const name of ARTIFACT_NAMES) {
    const schema = readSchema(schemaFor[name] ?? name);
    const props = sorted(Object.keys(schema.properties ?? {}));
    const value: unknown = artifacts[name];
    const records = Array.isArray(value) ? value : [value];
    for (const record of records) {
      assert.ok(record && typeof record === 'object');
      const keys = Object.keys(record as Record<string, unknown>);
      assert.deepEqual(sorted(keys), props, `${name}: record keys ≠ schema properties`);
      assert.deepEqual(keys, Object.keys(schema.properties ?? {}), `${name}: record key ORDER must follow the contract`);
      const evidence = (record as { evidence?: unknown }).evidence;
      if (Array.isArray(evidence)) {
        for (const ref of evidence) {
          const refKeys = Object.keys(ref as Record<string, unknown>);
          assert.ok(refKeys.every((key) => evidenceProps.has(key)), `unknown evidence-ref key in ${name}: ${refKeys.join(',')}`);
          assert.ok(refKeys.includes('documentId') && refKeys.includes('sha256'));
        }
      }
    }
  }
  const declared = new Set(PACK.adapters.find((adapter) => adapter.tool_id === ADAPTER_ID)?.claim_types ?? []);
  assert.ok(output.findings.every((finding) => declared.has(finding.rule)), 'adapter emitted a claim type it did not declare');
  assert.deepEqual(sorted([...declared]), sorted(MANIFEST.claim_types));
});

test('manifest + pack.json declare the runner, forbidden globs, SHADOW status, agents and fixture case consistently', () => {
  assert.equal(MANIFEST.tool_id, ADAPTER_ID);
  assert.equal(MANIFEST.status, 'SHADOW');
  for (const glob of ['.git/**', 'node_modules/**', 'aria-tools/**']) assert.ok(MANIFEST.forbidden_read_globs.includes(glob), `missing forbidden glob ${glob}`);
  assert.ok(MANIFEST.output_schema.required.includes('read_paths'));
  assert.equal(MANIFEST.runner.argv.at(-1), 'packs/legal/adapters/legal-document-inventory.ts');
  assert.equal(PACK.id, 'legal');
  const [adapter] = PACK.adapters;
  assert.ok(adapter);
  assert.equal(adapter.tool_id, ADAPTER_ID);
  assert.ok(existsSync(resolve(WORKSPACE_ROOT, adapter.manifest)));
  assert.ok(existsSync(resolve(WORKSPACE_ROOT, adapter.entry)));
  assert.equal(PACK.agents.length, 4);
  const packClaims = new Set(PACK.claim_types);
  for (const agent of PACK.agents) {
    const path = resolve(WORKSPACE_ROOT, agent.path);
    assert.ok(existsSync(path), `agent prompt missing: ${agent.path}`);
    const body = readFileSync(path, 'utf8');
    assert.match(body, new RegExp(`^name: ${agent.name}$`, 'm'));
    assert.match(body, /^model: opus$/m);
    assert.match(body, /^tools: Read, Grep, Glob$/m);
    assert.match(body, /^dispatch: ad-hoc$/m);
    assert.match(body, new RegExp(`^role: ${agent.role}$`, 'm'));
    assert.ok(agent.may_emit_claim_types.every((claim) => packClaims.has(claim)));
  }
  const fixtureCase = JSON.parse(readFileSync(resolve(PACK_ROOT, 'fixtures', 'cases', 'synthetic-archive.json'), 'utf8')) as { readonly input: unknown };
  assert.deepEqual(fixtureCase.input, MANIFEST.default_input, 'kernel fixture case must run the same input as the manifest default');
  for (const schemaPath of Object.values(PACK.artifacts.schemas)) assert.ok(existsSync(resolve(WORKSPACE_ROOT, schemaPath)));
});

// ---------------------------------------------------------------------------
// CLI contract (stdin JSON → stdout JSON, exit 0)
// ---------------------------------------------------------------------------
test('CLI: the subprocess contract matches the in-process result', () => {
  const outDir = tempDir('cli');
  const tsNodeBin = require.resolve('ts-node/dist/bin.js');
  const stdout = execFileSync(
    process.execPath,
    [tsNodeBin, '--project', 'tools/gates/tsconfig.json', 'packs/legal/adapters/legal-document-inventory.ts'],
    { cwd: WORKSPACE_ROOT, input: JSON.stringify({ ...GOLDEN_INPUT, out_dir: outDir }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const cliOutput = JSON.parse(stdout) as AriaOutput;
  for (const field of MANIFEST.output_schema.required) assert.ok(field in cliOutput, `CLI output lacks ${field}`);
  const inProcess = runGolden(tempDir('cli-ref'));
  assert.deepEqual(normalizeOutput(cliOutput), normalizeOutput(inProcess.output));
  for (const name of ARTIFACT_NAMES) {
    assert.equal(
      readFileSync(join(outDir, ARTIFACT_ROOT, 'case_synthetic-001', `${name}.json`), 'utf8'),
      readFileSync(join(inProcess.artifactDir, `${name}.json`), 'utf8'),
    );
  }
});

// ---------------------------------------------------------------------------
// Golden comparison (see the normalisation note at the top of this file)
// ---------------------------------------------------------------------------
test('golden: artifacts and stdout match packs/legal/fixtures/expected byte-for-byte after mtime normalisation', () => {
  const { artifacts, output } = runGolden(tempDir('golden'));
  const normalized = normalizeArtifacts(artifacts);
  const rendered: Record<string, string> = { 'stdout.json': renderJson(normalizeOutput(output)) };
  for (const name of ARTIFACT_NAMES) rendered[`${name}.json`] = renderJson(normalized[name]);
  if (process.env['UPDATE_GOLDEN'] === '1') {
    mkdirSync(EXPECTED_DIR, { recursive: true });
    for (const [file, text] of Object.entries(rendered)) writeFileSync(join(EXPECTED_DIR, file), text, 'utf8');
  }
  for (const [file, text] of Object.entries(rendered)) {
    const expectedPath = join(EXPECTED_DIR, file);
    assert.ok(existsSync(expectedPath), `golden missing: ${expectedPath} (run with UPDATE_GOLDEN=1)`);
    assert.equal(text, readFileSync(expectedPath, 'utf8'), `golden drift in ${file}`);
  }
  assert.deepEqual(sorted(readdirSync(EXPECTED_DIR)), sorted(Object.keys(rendered)), 'expected/ must hold exactly the golden set');
});
