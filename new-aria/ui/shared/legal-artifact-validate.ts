// Validation of the legal pack's artifacts at the boundary where they are READ.
//
// WHY: the adapter writes eight JSON files per case and the console used to
// cast each one to its interface and serve it. MEASURED 2026-09-04: a statement
// row hand-edited to `status: "verified"` with a made-up verifier reached the
// Statements tab verbatim; an artifact from an adapter build the reader has
// never seen would render as if current. The pack's own gate stops the adapter
// from writing such a row — it cannot stop a hand edit, a restored backup or a
// future writer that never calls the gate. Only the reader can, and only by
// checking every field against the pack's published schemas before it shows one.
//
// WHAT: one validator per artifact, mirroring packs/legal/schemas/*.schema.json
// field for field (required keys, patterns, enums, ranges and the conditional
// rules), plus the two refusals no schema expresses: a machine artifact that
// carries `verified` is refused as a provenance failure, and an adapter build
// outside SUPPORTED_LEGAL_ADAPTER_VERSIONS is refused by name. The console may
// not import the pack (extension point X-6 runs the other way), so parity is
// pinned by tests that run the pack's golden artifacts through these functions.

import type {
  AssertionSource,
  ExtractionStatus,
  LegalCase,
  LegalCoverage,
  LegalDocument,
  LegalDocumentVersion,
  LegalEvidenceRef,
  LegalLink,
  LegalLinkKind,
  LegalParty,
  LegalReconciliation,
  LegalRecordKind,
  LegalStatement,
  LegalTimelineEvent,
  LegalVersionStep,
  LegalVersionValueChange,
  StatementStatus,
} from './legal-contract.ts';
import {
  ASSERTION_SOURCES,
  EXTRACTION_STATUSES,
  LEGAL_CASE_ID_PATTERN,
  LEGAL_LINK_KINDS,
  LEGAL_RECORD_KINDS,
  STATEMENT_STATUSES,
  SUPPORTED_LEGAL_ADAPTER_VERSIONS,
} from './legal-contract.ts';

export type LegalArtifactErrorCode = 'legal_artifact_invalid' | 'statement_provenance_invalid' | 'legal_artifact_version_unknown';

export class LegalArtifactError extends Error {
  readonly code: LegalArtifactErrorCode;
  readonly file: string;
  readonly path: string;

  constructor(code: LegalArtifactErrorCode, file: string, path: string, message: string) {
    super(`${file} ${path}: ${message}`);
    this.name = 'LegalArtifactError';
    this.code = code;
    this.file = file;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Primitive checks. Each takes the artifact file and the JSON path so a refusal
// names exactly where the artifact went wrong.
// ---------------------------------------------------------------------------
const CASE_ID = new RegExp(LEGAL_CASE_ID_PATTERN);
const DOCUMENT_ID = /^doc_[0-9a-f]{16}$/;
const VERSION_GROUP_ID = /^vg_[0-9a-f]{12}$/;
const PARTY_ID = /^party_[0-9a-f]{12}$/;
const EVENT_ID = /^evt_[0-9a-f]{12}$/;
const LINK_ID = /^lnk_[0-9a-f]{12}$/;
const STATEMENT_ID = /^stmt_[A-Za-z0-9._-]{4,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXTENSION = /^(\.[a-z0-9]+)?$/;

type Fail = (path: string, message: string) => never;

function failer(file: string, code: LegalArtifactErrorCode = 'legal_artifact_invalid'): Fail {
  return (path, message) => {
    throw new LegalArtifactError(code, file, path, message);
  };
}

function record(value: unknown, path: string, fail: Fail): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string, fail: Fail): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value as unknown[];
}

function str(value: unknown, path: string, fail: Fail, options: { readonly pattern?: RegExp; readonly minLength?: number } = {}): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  const text = value as string;
  if (options.minLength !== undefined && text.length < options.minLength) fail(path, `must be at least ${options.minLength} character(s)`);
  if (options.pattern !== undefined && !options.pattern.test(text)) fail(path, `must match ${options.pattern.source}`);
  return text;
}

function strOrNull(value: unknown, path: string, fail: Fail, options: { readonly pattern?: RegExp } = {}): string | null {
  if (value === null) return null;
  return str(value, path, fail, options);
}

function dateTime(value: unknown, path: string, fail: Fail): string {
  const text = str(value, path, fail, { minLength: 1 });
  if (Number.isNaN(Date.parse(text))) fail(path, 'must be an ISO 8601 date-time');
  return text;
}

function int(value: unknown, path: string, fail: Fail, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) fail(path, `must be an integer >= ${minimum}`);
  return value as number;
}

function unit(value: unknown, path: string, fail: Fail, maximum = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) fail(path, `must be a number in [0, ${maximum}]`);
  return value as number;
}

function bool(value: unknown, path: string, fail: Fail): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value as boolean;
}

function literalTrue(value: unknown, path: string, fail: Fail): true {
  if (value !== true) fail(path, 'must be true');
  return true;
}

function oneOf<T extends string>(value: unknown, path: string, fail: Fail, values: ReadonlyArray<T>): T {
  if (typeof value !== 'string' || !(values as ReadonlyArray<string>).includes(value)) fail(path, `must be one of ${values.join(', ')}`);
  return value as T;
}

function stringList(value: unknown, path: string, fail: Fail, options: { readonly unique?: boolean; readonly pattern?: RegExp } = {}): string[] {
  const items = array(value, path, fail).map((item, index) => str(item, `${path}[${index}]`, fail, { minLength: 1, ...(options.pattern === undefined ? {} : { pattern: options.pattern }) }));
  if (options.unique && new Set(items).size !== items.length) fail(path, 'must not repeat an item');
  return items;
}

function evidenceRef(value: unknown, path: string, fail: Fail): LegalEvidenceRef {
  const source = record(value, path, fail);
  const documentId = str(source['documentId'], `${path}.documentId`, fail, { pattern: DOCUMENT_ID });
  const sha256 = str(source['sha256'], `${path}.sha256`, fail, { pattern: SHA256 });
  const ref: { documentId: string; sha256: string; versionId?: string; locator?: string } = { documentId, sha256 };
  if (source['versionId'] !== undefined) ref.versionId = str(source['versionId'], `${path}.versionId`, fail, { pattern: VERSION_GROUP_ID });
  if (source['locator'] !== undefined) ref.locator = str(source['locator'], `${path}.locator`, fail, { minLength: 1 });
  return ref;
}

function evidenceRefs(value: unknown, path: string, fail: Fail, minItems: number): LegalEvidenceRef[] {
  const items = array(value, path, fail);
  if (items.length < minItems) fail(path, `must carry at least ${minItems} evidence ref(s)`);
  return items.map((item, index) => evidenceRef(item, `${path}[${index}]`, fail));
}

function recordRef(value: unknown, path: string, fail: Fail): { readonly kind: LegalRecordKind; readonly id: string } {
  const source = record(value, path, fail);
  return { kind: oneOf(source['kind'], `${path}.kind`, fail, LEGAL_RECORD_KINDS), id: str(source['id'], `${path}.id`, fail, { minLength: 1 }) };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------
export const LEGAL_ARTIFACT_FILE_NAMES = {
  case: 'case.json',
  documents: 'documents.json',
  versions: 'versions.json',
  parties: 'parties.json',
  timeline: 'timeline.json',
  statements: 'statements.json',
  links: 'links.json',
  coverage: 'coverage.json',
} as const;

export function validateCase(value: unknown): LegalCase {
  const fail = failer(LEGAL_ARTIFACT_FILE_NAMES.case);
  const source = record(value, '$', fail);
  const adapterVersion = str(source['adapterVersion'], '$.adapterVersion', fail, { pattern: SEMVER });
  if (!(SUPPORTED_LEGAL_ADAPTER_VERSIONS as ReadonlyArray<string>).includes(adapterVersion)) {
    throw new LegalArtifactError(
      'legal_artifact_version_unknown',
      LEGAL_ARTIFACT_FILE_NAMES.case,
      '$.adapterVersion',
      `adapter build ${adapterVersion} is not one this console can read (${SUPPORTED_LEGAL_ADAPTER_VERSIONS.join(', ')})`,
    );
  }
  return {
    caseId: str(source['caseId'], '$.caseId', fail, { pattern: CASE_ID }),
    title: str(source['title'], '$.title', fail, { minLength: 1 }),
    jurisdiction: strOrNull(source['jurisdiction'], '$.jurisdiction', fail),
    courtReference: strOrNull(source['courtReference'], '$.courtReference', fail),
    archiveRoot: str(source['archiveRoot'], '$.archiveRoot', fail, { minLength: 1 }),
    createdAt: dateTime(source['createdAt'], '$.createdAt', fail),
    snapshotSha256: str(source['snapshotSha256'], '$.snapshotSha256', fail, { pattern: SHA256 }),
    adapterId: str(source['adapterId'], '$.adapterId', fail, { minLength: 1 }),
    adapterVersion,
    runId: strOrNull(source['runId'], '$.runId', fail),
    cycleId: strOrNull(source['cycleId'], '$.cycleId', fail),
  };
}

function validateDocument(value: unknown, path: string, fail: Fail): LegalDocument {
  const source = record(value, path, fail);
  const extraction = oneOf<ExtractionStatus>(source['extraction'], `${path}.extraction`, fail, EXTRACTION_STATUSES);
  const readable = extraction === 'text' || extraction === 'metadata_only';
  const relativePath = str(source['relativePath'], `${path}.relativePath`, fail, { minLength: 1 });
  if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) fail(`${path}.relativePath`, 'must be a relative path with no .. segment');
  const sha256 = str(source['sha256'], `${path}.sha256`, fail, { pattern: readable ? SHA256 : /^$/ });
  const excerpt = strOrNull(source['excerpt'], `${path}.excerpt`, fail);
  if (!readable && excerpt !== null) fail(`${path}.excerpt`, 'must be null when the document was not read');
  const excludedReason = strOrNull(source['excludedReason'], `${path}.excludedReason`, fail);
  if (extraction === 'excluded' && (excludedReason === null || excludedReason === '')) fail(`${path}.excludedReason`, 'must say why the document was excluded');
  if (extraction !== 'excluded' && excludedReason !== null) fail(`${path}.excludedReason`, 'must be null unless the document was excluded');
  return {
    documentId: str(source['documentId'], `${path}.documentId`, fail, { pattern: DOCUMENT_ID }),
    caseId: str(source['caseId'], `${path}.caseId`, fail, { pattern: CASE_ID }),
    relativePath,
    fileName: str(source['fileName'], `${path}.fileName`, fail, { minLength: 1 }),
    extension: str(source['extension'], `${path}.extension`, fail, { pattern: EXTENSION }),
    mediaType: strOrNull(source['mediaType'], `${path}.mediaType`, fail),
    bytes: int(source['bytes'], `${path}.bytes`, fail, 0),
    sha256,
    modifiedAt: source['modifiedAt'] === null ? null : dateTime(source['modifiedAt'], `${path}.modifiedAt`, fail),
    kindGuess: oneOf<LegalRecordKind | 'UNKNOWN'>(source['kindGuess'], `${path}.kindGuess`, fail, [...LEGAL_RECORD_KINDS, 'UNKNOWN']),
    kindConfidence: unit(source['kindConfidence'], `${path}.kindConfidence`, fail),
    extraction,
    excerpt,
    datesMentioned: stringList(source['datesMentioned'], `${path}.datesMentioned`, fail, { unique: true, pattern: ISO_DATE }),
    amountsMentioned: stringList(source['amountsMentioned'], `${path}.amountsMentioned`, fail, { unique: true }),
    versionGroupId: strOrNull(source['versionGroupId'], `${path}.versionGroupId`, fail, { pattern: VERSION_GROUP_ID }),
    excludedReason,
    duplicateOf: strOrNull(source['duplicateOf'], `${path}.duplicateOf`, fail, { pattern: DOCUMENT_ID }),
  };
}

export function validateDocuments(value: unknown): LegalDocument[] {
  const fail = failer(LEGAL_ARTIFACT_FILE_NAMES.documents);
  return array(value, '$', fail).map((item, index) => validateDocument(item, `$[${index}]`, fail));
}

function validateValueChange(value: unknown, path: string, fail: Fail): LegalVersionValueChange {
  const source = record(value, path, fail);
  return {
    label: str(source['label'], `${path}.label`, fail, { minLength: 1 }),
    kind: oneOf(source['kind'], `${path}.kind`, fail, ['date', 'amount'] as const),
    from: strOrNull(source['from'], `${path}.from`, fail),
    to: strOrNull(source['to'], `${path}.to`, fail),
    fromLocator: strOrNull(source['fromLocator'], `${path}.fromLocator`, fail),
    toLocator: strOrNull(source['toLocator'], `${path}.toLocator`, fail),
  };
}

function validateStep(value: unknown, path: string, fail: Fail): LegalVersionStep {
  const source = record(value, path, fail);
  return {
    fromDocumentId: str(source['fromDocumentId'], `${path}.fromDocumentId`, fail, { pattern: DOCUMENT_ID }),
    toDocumentId: str(source['toDocumentId'], `${path}.toDocumentId`, fail, { pattern: DOCUMENT_ID }),
    values: array(source['values'], `${path}.values`, fail).map((item, index) => validateValueChange(item, `${path}.values[${index}]`, fail)),
    addedLines: int(source['addedLines'], `${path}.addedLines`, fail, 0),
    removedLines: int(source['removedLines'], `${path}.removedLines`, fail, 0),
    unchangedLines: int(source['unchangedLines'], `${path}.unchangedLines`, fail, -1),
    humanReviewRequired: literalTrue(source['humanReviewRequired'], `${path}.humanReviewRequired`, fail),
  };
}

function validateVersion(value: unknown, path: string, fail: Fail): LegalDocumentVersion {
  const source = record(value, path, fail);
  const members = array(source['members'], `${path}.members`, fail);
  if (members.length < 2) fail(`${path}.members`, 'a version group has at least two members');
  return {
    versionGroupId: str(source['versionGroupId'], `${path}.versionGroupId`, fail, { pattern: VERSION_GROUP_ID }),
    members: members.map((item, index) => {
      const member = record(item, `${path}.members[${index}]`, fail);
      const similarity = member['similarityToPrevious'];
      return {
        documentId: str(member['documentId'], `${path}.members[${index}].documentId`, fail, { pattern: DOCUMENT_ID }),
        ordinal: int(member['ordinal'], `${path}.members[${index}].ordinal`, fail, 1),
        basis: oneOf(member['basis'], `${path}.members[${index}].basis`, fail, ['file_mtime', 'name_suffix', 'content_similarity', 'unknown'] as const),
        similarityToPrevious: similarity === null ? null : unit(similarity, `${path}.members[${index}].similarityToPrevious`, fail),
      };
    }),
    signedMember: strOrNull(source['signedMember'], `${path}.signedMember`, fail, { pattern: DOCUMENT_ID }),
    filedMember: strOrNull(source['filedMember'], `${path}.filedMember`, fail, { pattern: DOCUMENT_ID }),
    steps: array(source['steps'], `${path}.steps`, fail).map((item, index) => validateStep(item, `${path}.steps[${index}]`, fail)),
    humanReviewRequired: literalTrue(source['humanReviewRequired'], `${path}.humanReviewRequired`, fail),
  };
}

export function validateVersions(value: unknown): LegalDocumentVersion[] {
  const fail = failer(LEGAL_ARTIFACT_FILE_NAMES.versions);
  return array(value, '$', fail).map((item, index) => validateVersion(item, `$[${index}]`, fail));
}

function validateParty(value: unknown, path: string, fail: Fail): LegalParty {
  const source = record(value, path, fail);
  const roleEvidence = array(source['roleEvidence'], `${path}.roleEvidence`, fail).map((item, index) => {
    const row = record(item, `${path}.roleEvidence[${index}]`, fail);
    return { role: str(row['role'], `${path}.roleEvidence[${index}].role`, fail, { minLength: 1 }), evidence: evidenceRef(row['evidence'], `${path}.roleEvidence[${index}].evidence`, fail) };
  });
  const roles = stringList(source['roles'], `${path}.roles`, fail);
  // A role without a line it was read on is a claim, not a reading.
  for (const role of roles) {
    if (!roleEvidence.some((row) => row.role === role)) fail(`${path}.roles`, `role ${role} has no roleEvidence row behind it`);
  }
  return {
    partyId: str(source['partyId'], `${path}.partyId`, fail, { pattern: PARTY_ID }),
    displayName: str(source['displayName'], `${path}.displayName`, fail, { minLength: 1 }),
    kind: oneOf(source['kind'], `${path}.kind`, fail, ['person', 'organization', 'court', 'authority', 'unknown'] as const),
    basis: oneOf(source['basis'], `${path}.basis`, fail, ['header_address', 'organisation_form', 'organisation_number', 'counsel_construction', 'party_label', 'court_name'] as const),
    organisationNumber: strOrNull(source['organisationNumber'], `${path}.organisationNumber`, fail, { pattern: /^[0-9]{9}$/ }),
    roles,
    roleEvidence,
    aliases: stringList(source['aliases'], `${path}.aliases`, fail, { unique: true }),
    mentions: int(source['mentions'], `${path}.mentions`, fail, 0),
    evidence: evidenceRefs(source['evidence'], `${path}.evidence`, fail, 1),
    identityConfidence: unit(source['identityConfidence'], `${path}.identityConfidence`, fail),
    humanReviewRequired: bool(source['humanReviewRequired'], `${path}.humanReviewRequired`, fail),
  };
}

export function validateParties(value: unknown): LegalParty[] {
  const fail = failer(LEGAL_ARTIFACT_FILE_NAMES.parties);
  return array(value, '$', fail).map((item, index) => validateParty(item, `$[${index}]`, fail));
}

const MACHINE_SOURCES: ReadonlyArray<AssertionSource> = ['mechanical_extraction', 'ai_inference'];

function validateTimelineEvent(value: unknown, path: string, fail: Fail): LegalTimelineEvent {
  const source = record(value, path, fail);
  const assertedBy = oneOf<AssertionSource>(source['assertedBy'], `${path}.assertedBy`, fail, ASSERTION_SOURCES);
  const machine = MACHINE_SOURCES.includes(assertedBy);
  const humanReviewRequired = bool(source['humanReviewRequired'], `${path}.humanReviewRequired`, fail);
  if (machine && !humanReviewRequired) fail(`${path}.humanReviewRequired`, 'a machine-read event always requires human review');
  return {
    eventId: str(source['eventId'], `${path}.eventId`, fail, { pattern: EVENT_ID }),
    kind: oneOf(source['kind'], `${path}.kind`, fail, ['EVENT', 'COMMUNICATION', 'PROCEDURAL_STEP', 'DEADLINE', 'DECISION'] as const),
    occurredAt: strOrNull(source['occurredAt'], `${path}.occurredAt`, fail),
    learnedAt: strOrNull(source['learnedAt'], `${path}.learnedAt`, fail),
    datePrecision: oneOf(source['datePrecision'], `${path}.datePrecision`, fail, ['day', 'month', 'year', 'unknown'] as const),
    summary: str(source['summary'], `${path}.summary`, fail, { minLength: 1 }),
    evidence: evidenceRefs(source['evidence'], `${path}.evidence`, fail, 1),
    assertedBy,
    // The schema caps a machine reading's confidence at 0.4: nothing a parser
    // reads may look more certain than a party's own word.
    confidence: unit(source['confidence'], `${path}.confidence`, fail, machine ? 0.4 : 1),
    humanReviewRequired,
  };
}

export function validateTimeline(value: unknown): LegalTimelineEvent[] {
  const fail = failer(LEGAL_ARTIFACT_FILE_NAMES.timeline);
  return array(value, '$', fail).map((item, index) => validateTimelineEvent(item, `$[${index}]`, fail));
}

/**
 * A statement as a machine artifact may carry it. A `verified` row is refused
 * before any shape check, under its own code: verification is a human decision
 * recorded in the case's decision ledger and overlaid at read time, never a
 * field an adapter's output file may hold.
 */
function validateArtifactStatement(value: unknown, path: string, fail: Fail): LegalStatement {
  const source = record(value, path, fail);
  if (source['status'] === 'verified' || (source['verifiedBy'] !== null && source['verifiedBy'] !== undefined) || (source['verifiedAt'] !== null && source['verifiedAt'] !== undefined)) {
    throw new LegalArtifactError(
      'statement_provenance_invalid',
      LEGAL_ARTIFACT_FILE_NAMES.statements,
      path,
      'a machine-written artifact carries a verification; only a human decision recorded in the decision ledger can verify a statement',
    );
  }
  const status = oneOf<StatementStatus>(source['status'], `${path}.status`, fail, STATEMENT_STATUSES);
  const assertedBy = oneOf<AssertionSource>(source['assertedBy'], `${path}.assertedBy`, fail, ASSERTION_SOURCES);
  const humanReviewRequired = bool(source['humanReviewRequired'], `${path}.humanReviewRequired`, fail);
  if (MACHINE_SOURCES.includes(assertedBy) && !humanReviewRequired) fail(`${path}.humanReviewRequired`, 'a machine-asserted statement always requires human review');
  const supportingSources = evidenceRefs(source['supportingSources'], `${path}.supportingSources`, fail, status === 'supported' ? 1 : 0);
  const contradictingSources = evidenceRefs(source['contradictingSources'], `${path}.contradictingSources`, fail, status === 'contradicted' ? 1 : 0);
  return {
    statementId: str(source['statementId'], `${path}.statementId`, fail, { pattern: STATEMENT_ID }),
    statement: str(source['statement'], `${path}.statement`, fail, { minLength: 1 }),
    status,
    assertedBy,
    assertedByPartyId: strOrNull(source['assertedByPartyId'], `${path}.assertedByPartyId`, fail, { pattern: PARTY_ID }),
    supportingSources,
    contradictingSources,
    missingEvidence: stringList(source['missingEvidence'], `${path}.missingEvidence`, fail),
    confidence: unit(source['confidence'], `${path}.confidence`, fail),
    humanReviewRequired,
    verifiedBy: null,
    verifiedAt: null,
    relatedClaimIds: stringList(source['relatedClaimIds'], `${path}.relatedClaimIds`, fail, { unique: true }),
  };
}

export function validateStatements(value: unknown): LegalStatement[] {
  const fail = failer(LEGAL_ARTIFACT_FILE_NAMES.statements);
  return array(value, '$', fail).map((item, index) => validateArtifactStatement(item, `$[${index}]`, fail));
}

function validateLink(value: unknown, path: string, fail: Fail): LegalLink {
  const source = record(value, path, fail);
  return {
    linkId: str(source['linkId'], `${path}.linkId`, fail, { pattern: LINK_ID }),
    kind: oneOf<LegalLinkKind>(source['kind'], `${path}.kind`, fail, LEGAL_LINK_KINDS),
    from: recordRef(source['from'], `${path}.from`, fail),
    to: recordRef(source['to'], `${path}.to`, fail),
    evidence: evidenceRefs(source['evidence'], `${path}.evidence`, fail, 1),
    confidence: unit(source['confidence'], `${path}.confidence`, fail),
  };
}

export function validateLinks(value: unknown): LegalLink[] {
  const fail = failer(LEGAL_ARTIFACT_FILE_NAMES.links);
  return array(value, '$', fail).map((item, index) => validateLink(item, `$[${index}]`, fail));
}

export function validateCoverage(value: unknown): LegalCoverage {
  const fail = failer(LEGAL_ARTIFACT_FILE_NAMES.coverage);
  const source = record(value, '$', fail);
  const byExtractionSource = record(source['byExtraction'], '$.byExtraction', fail);
  const byExtraction = {} as Record<ExtractionStatus, number>;
  for (const status of EXTRACTION_STATUSES) byExtraction[status] = int(byExtractionSource[status], `$.byExtraction.${status}`, fail, 0);
  const byKindSource = record(source['byKind'], '$.byKind', fail);
  const byKind: Record<string, number> = {};
  for (const [kind, count] of Object.entries(byKindSource)) byKind[kind] = int(count, `$.byKind.${kind}`, fail, 0);
  const reconciliationSource = source['reconciliation'];
  const reconciliation: LegalReconciliation | null =
    reconciliationSource === null
      ? null
      : (() => {
          const rec = record(reconciliationSource, '$.reconciliation', fail);
          return {
            receipts: int(rec['receipts'], '$.reconciliation.receipts', fail, 0),
            matched: int(rec['matched'], '$.reconciliation.matched', fail, 0),
            documentsWithoutReceipt: stringList(rec['documentsWithoutReceipt'], '$.reconciliation.documentsWithoutReceipt', fail, { unique: true }),
            receiptsWithoutDocument: stringList(rec['receiptsWithoutDocument'], '$.reconciliation.receiptsWithoutDocument', fail, { unique: true }),
            hashMismatches: array(rec['hashMismatches'], '$.reconciliation.hashMismatches', fail).map((item, index) => {
              const row = record(item, `$.reconciliation.hashMismatches[${index}]`, fail);
              return {
                relativePath: str(row['relativePath'], `$.reconciliation.hashMismatches[${index}].relativePath`, fail, { minLength: 1 }),
                receiptSha256: str(row['receiptSha256'], `$.reconciliation.hashMismatches[${index}].receiptSha256`, fail, { pattern: SHA256 }),
                archiveSha256: str(row['archiveSha256'], `$.reconciliation.hashMismatches[${index}].archiveSha256`, fail, { pattern: SHA256 }),
              };
            }),
          };
        })();
  return {
    caseId: str(source['caseId'], '$.caseId', fail, { pattern: CASE_ID }),
    totalFiles: int(source['totalFiles'], '$.totalFiles', fail, 0),
    distinctDocuments: int(source['distinctDocuments'], '$.distinctDocuments', fail, 0),
    byExtraction,
    byKind,
    excludedRoots: stringList(source['excludedRoots'], '$.excludedRoots', fail, { unique: true }),
    unreadable: array(source['unreadable'], '$.unreadable', fail).map((item, index) => {
      const row = record(item, `$.unreadable[${index}]`, fail);
      return {
        relativePath: str(row['relativePath'], `$.unreadable[${index}].relativePath`, fail, { minLength: 1 }),
        reason: str(row['reason'], `$.unreadable[${index}].reason`, fail, { minLength: 1 }),
      };
    }),
    reconciliation,
    truncated: (() => {
      const row = record(source['truncated'], '$.truncated', fail);
      return {
        findings: int(row['findings'], '$.truncated.findings', fail, 0),
        statements: int(row['statements'], '$.truncated.statements', fail, 0),
        timeline: int(row['timeline'], '$.truncated.timeline', fail, 0),
      };
    })(),
    complete: bool(source['complete'], '$.complete', fail),
  };
}
