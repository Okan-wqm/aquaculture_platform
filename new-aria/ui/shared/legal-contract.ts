// new-aria Legal pack — console contract shared by ui/server, ui/web and packs/legal.
//
// WHY: the Legal Case Intelligence muscle produces its records as ARIA adapter
// artifacts (mechanical, evidence-anchored, no legal conclusions). The console
// must PROJECT those artifacts, never author legal facts itself, and the SPA and
// the server must agree byte-for-byte on shapes. This file is that agreement.
//
// WHAT: the record vocabulary (CASE, PARTY, DOCUMENT, DOCUMENT_VERSION,
// COMMUNICATION, EVENT, CLAIM, COUNTERCLAIM, EVIDENCE, PROCEDURAL_STEP, DEADLINE,
// DECISION, FINANCIAL_LOSS, ACCESS_PERMISSION), the link vocabulary, the
// statement (claim–evidence matrix) record with its human-review discipline, the
// artifact layout the legal adapter writes under ARIA_TOOLS_DIR, and the HTTP
// endpoints the console serves over it.

import { API_PREFIX } from './api-contract.ts';

export const LEGAL_API_PREFIX = `${API_PREFIX}/legal` as const;

/**
 * One case id, one pattern, both sides.
 *
 * The id names the case's intake directory (written by the console) AND the
 * artifact directory (written by the adapter). MEASURED 2026-09-04: the adapter
 * prefixed its directory with `case_` while the console used the bare id, so one
 * case had two identities and the Intake tab of the case the console listed was
 * empty. The pack may not import the console (extension point X-6), so it
 * restates this string in packs/legal/adapters/legal-records.ts and its test
 * pins the two texts equal.
 */
export const LEGAL_CASE_ID_PATTERN = '^[a-z0-9][a-z0-9._-]{2,63}$' as const;
export const LEGAL_CASE_ID_RE = new RegExp(LEGAL_CASE_ID_PATTERN);

/**
 * Adapter builds whose artifacts this console knows how to read. An artifact
 * from any other build is refused by name rather than rendered as if current:
 * a shape the reader does not know is not evidence it can show.
 */
export const SUPPORTED_LEGAL_ADAPTER_VERSIONS = ['0.1.0'] as const;

/**
 * The action classes the console can perform on a case. Every one of them is
 * governed by the instance's approval policy (arias/<id>/config/approval-policy.json):
 * an automatic class is open to any authenticated principal, a role-owned class
 * only to that role, and a class the policy does not name is refused. The
 * console's own `allow_actions` switch governs KERNEL control only — it was the
 * wrong instrument for case work, and under it the shipped legal instance could
 * not open a case at all.
 */
export const LEGAL_ACTION_CLASSES = [
  'case_intake',
  'corpus_inventory',
  'statement_verification',
  'party_identity_merge',
  'filed_version_declaration',
  /** Taking a document out of the archive: its bytes go, its receipt and the decision stay. */
  'document_removal',
  /** Closing a case, or scheduling its destruction with a retention date. */
  'case_lifecycle',
  'redaction_and_production',
  'external_effect',
] as const;
export type LegalActionClass = (typeof LEGAL_ACTION_CLASSES)[number];

/** Closed record vocabulary. Adding a kind is a pack-schema decision, not a UI one. */
export const LEGAL_RECORD_KINDS = [
  'CASE',
  'PARTY',
  'ROLE',
  'DOCUMENT',
  'DOCUMENT_VERSION',
  'COMMUNICATION',
  'EVENT',
  'CLAIM',
  'COUNTERCLAIM',
  'EVIDENCE',
  'PROCEDURAL_STEP',
  'DEADLINE',
  'DECISION',
  'FINANCIAL_LOSS',
  'ACCESS_PERMISSION',
] as const;
export type LegalRecordKind = (typeof LEGAL_RECORD_KINDS)[number];

/** Closed link vocabulary between records. */
export const LEGAL_LINK_KINDS = [
  'SUPPORTS',
  'CONTRADICTS',
  'SUPERSEDES',
  'WAS_RECEIVED_BY',
  'WAS_SENT_BY',
  'CAUSED',
  'REFERS_TO',
  'REQUIRES',
  'PARTY_IN',
  'VERSION_OF',
] as const;
export type LegalLinkKind = (typeof LEGAL_LINK_KINDS)[number];

/**
 * Status of a statement in the claim–evidence matrix. `verified` is EARNED only
 * by a human reviewer recording a verification; the adapter never emits it.
 */
export const STATEMENT_STATUSES = ['asserted', 'disputed', 'supported', 'contradicted', 'unverifiable', 'verified'] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

/**
 * Who put a record into the world.
 *
 * The distinction between `mechanical_extraction` and `ai_inference` is the one
 * this product is built on: the first means a parser read these exact bytes at a
 * stated locator and would read them the same way tomorrow; the second means a
 * model proposed something. Labelling a regex match as AI inference (as this
 * vocabulary forced until 2026-09-04) blurs exactly the line a lawyer needs.
 * Neither of them ever earns `verified` — a human does that.
 */
export const ASSERTION_SOURCES = [
  'party',
  'court',
  'counsel',
  'third_party',
  'mechanical_extraction',
  'ai_inference',
  'operator',
] as const;
export type AssertionSource = (typeof ASSERTION_SOURCES)[number];

/** How a document's bytes were made readable. `unreadable` files become pressure, not silence. */
export const EXTRACTION_STATUSES = ['text', 'metadata_only', 'unreadable', 'excluded'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Artifact layout written by the legal adapter (packs/legal) under
// ARIA_TOOLS_DIR. The console reads it read-only. One directory per case.
// ---------------------------------------------------------------------------
export const LEGAL_ARTIFACT_ROOT = 'packs/legal/cases' as const;

/**
 * Layout of a case's own working directory under the cases root, written by the
 * console at intake and read by the adapter. It is deliberately separate from
 * the artifact root above: the adapter READS `archive/` and never writes there
 * (pack law L2), while `intake.jsonl` is written only by the console and never
 * read by the adapter, so neither can quietly become the other's input.
 */
export const LEGAL_CASE_LAYOUT = {
  /** The documents themselves. The adapter's archive_root points here. */
  archive: 'archive',
  /** Append-only, hash-chained, row-signed arrival receipt. */
  intake: 'intake.jsonl',
  /** Signed head commitment over the receipt: row count and last row hash. */
  intakeHead: 'intake.head.json',
  /** The case's identity and custodian. */
  meta: 'case.meta.json',
  /**
   * The human decisions on this case — verifications, filed-version
   * declarations, identity merges, removals, lifecycle — as a signed, chained
   * ledger of their own. The adapter never reads it; the console overlays it
   * on the artifacts at read time, so an inventory re-run cannot erase a
   * decision and a decision cannot rewrite an artifact.
   */
  decisions: 'decisions.jsonl',
  decisionsHead: 'decisions.head.json',
  /** Every case-scoped request, signed and chained. */
  access: 'access.jsonl',
} as const;

/** Planned immutable-run layout. The current flat adapter has no run key;
 * readers report null until the Phase 2 publisher writes validated runs. */
export const LEGAL_ARTIFACT_LAYOUT = {
  runs: 'runs',
  current: 'current.json',
} as const;
/** A run key is a directory name: the kernel cycle id when there was one, else a content hash of what the run wrote. */
export const LEGAL_RUN_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{3,95}$' as const;
export const LEGAL_RUN_KEY_RE = new RegExp(LEGAL_RUN_KEY_PATTERN);

/** Phase 2 publisher contract: publish this pointer only after validating every run file. */
export interface LegalCurrentRun {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly runKey: string;
  readonly adapterVersion: string;
  readonly snapshotSha256: string;
  readonly cycleId: string | null;
  readonly files: ReadonlyArray<string>;
}
export const LEGAL_ARTIFACT_FILES = {
  case: 'case.json',
  documents: 'documents.json',
  versions: 'versions.json',
  parties: 'parties.json',
  timeline: 'timeline.json',
  statements: 'statements.json',
  links: 'links.json',
  coverage: 'coverage.json',
} as const;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
export const LEGAL_ENDPOINTS = {
  cases: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases`, response: 'LegalCasesResponse' },
  case: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases/:caseId`, response: 'LegalCaseDetailResponse' },
  documents: {
    method: 'GET',
    path: `${LEGAL_API_PREFIX}/cases/:caseId/documents`,
    response: 'LegalDocumentsResponse',
    query: ['kind', 'extraction', 'limit'],
  },
  document: {
    method: 'GET',
    path: `${LEGAL_API_PREFIX}/cases/:caseId/documents/:documentId`,
    response: 'LegalDocumentResponse',
  },
  timeline: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases/:caseId/timeline`, response: 'LegalTimelineResponse' },
  parties: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases/:caseId/parties`, response: 'LegalPartiesResponse' },
  statements: {
    method: 'GET',
    path: `${LEGAL_API_PREFIX}/cases/:caseId/statements`,
    response: 'LegalStatementsResponse',
    query: ['status', 'humanReview'],
  },
  coverage: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases/:caseId/coverage`, response: 'LegalCoverageResponse' },
  intake: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases/:caseId/intake`, response: 'LegalIntakeResponse' },
  createCase: { method: 'POST', path: `${LEGAL_API_PREFIX}/cases`, response: 'LegalCaseCreatedResponse' },
  uploadDocument: { method: 'POST', path: `${LEGAL_API_PREFIX}/cases/:caseId/documents`, response: 'LegalUploadResponse' },
  runInventory: { method: 'POST', path: `${LEGAL_API_PREFIX}/cases/:caseId/inventory`, response: 'JobResponse' },
  // --- decisions: the human half of the matrix. Every one is gated by its action class.
  decisions: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases/:caseId/decisions`, response: 'LegalDecisionsResponse' },
  verifyStatement: { method: 'POST', path: `${LEGAL_API_PREFIX}/cases/:caseId/statements/:statementId/verify`, response: 'LegalDecisionResponse' },
  declareFiledVersion: { method: 'POST', path: `${LEGAL_API_PREFIX}/cases/:caseId/versions/:versionGroupId/filed`, response: 'LegalDecisionResponse' },
  mergeParties: { method: 'POST', path: `${LEGAL_API_PREFIX}/cases/:caseId/parties/merge`, response: 'LegalDecisionResponse' },
  removeDocument: { method: 'DELETE', path: `${LEGAL_API_PREFIX}/cases/:caseId/documents/:documentId`, response: 'LegalDecisionResponse' },
  lifecycle: { method: 'POST', path: `${LEGAL_API_PREFIX}/cases/:caseId/lifecycle`, response: 'LegalDecisionResponse' },
  // --- runs: every inventory the adapter wrote for the case, the current one named.
  runs: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases/:caseId/runs`, response: 'LegalRunsResponse' },
  run: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases/:caseId/runs/:runKey`, response: 'LegalRunResponse' },
} as const;

/**
 * Header carrying the uploaded document's name and folder path, percent-encoded
 * UTF-8. The body is the raw bytes: the console takes no multipart parser and no
 * dependency, and the bytes it stores are the bytes it hashed.
 */
export const LEGAL_UPLOAD_FILE_NAME_HEADER = 'x-aria-file-name' as const;
/** Optional header noting where a document came from (a party, a bundle, a disc). */
export const LEGAL_UPLOAD_SOURCE_HEADER = 'x-aria-source-note' as const;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Evidence anchor: a document (and optionally a location inside it). Never an AI output. */
export interface LegalEvidenceRef {
  readonly documentId: string;
  readonly versionId?: string;
  readonly locator?: string;
  readonly sha256: string;
}

export interface LegalCase {
  readonly caseId: string;
  readonly title: string;
  readonly jurisdiction: string | null;
  readonly courtReference: string | null;
  readonly archiveRoot: string;
  readonly createdAt: string;
  readonly snapshotSha256: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly runId: string | null;
  readonly cycleId: string | null;
}

export interface LegalDocument {
  readonly documentId: string;
  readonly caseId: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly extension: string;
  readonly mediaType: string | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly modifiedAt: string | null;
  readonly kindGuess: LegalRecordKind | 'UNKNOWN';
  readonly kindConfidence: number;
  readonly extraction: ExtractionStatus;
  readonly excerpt: string | null;
  readonly datesMentioned: ReadonlyArray<string>;
  readonly amountsMentioned: ReadonlyArray<string>;
  readonly versionGroupId: string | null;
  readonly excludedReason: string | null;
  /**
   * The document whose bytes this file repeats exactly, or null. Identical
   * bytes under two names are one document delivered twice, not two versions
   * of anything: the copy is listed, counted, and derives no record of its own.
   */
  readonly duplicateOf: string | null;
}

/**
 * One step between two consecutive members of a version group: what a reader
 * would find if they opened both files side by side.
 *
 * `from`/`to` are null on an addition or a removal, because a value that only
 * one version states did not change — it arrived or it left, and dressing that
 * up as a change from nothing would misdescribe the document's history.
 */
export interface LegalVersionValueChange {
  readonly label: string;
  readonly kind: 'date' | 'amount';
  readonly from: string | null;
  readonly to: string | null;
  readonly fromLocator: string | null;
  readonly toLocator: string | null;
}

export interface LegalVersionStep {
  readonly fromDocumentId: string;
  readonly toDocumentId: string;
  /** Values both versions state, differently; values one states and the other does not. */
  readonly values: ReadonlyArray<LegalVersionValueChange>;
  readonly addedLines: number;
  readonly removedLines: number;
  /** Lines carried over unchanged; -1 when the pair was too large to diff line by line. */
  readonly unchangedLines: number;
  /** A mechanical comparison is never a finding about which version governs. */
  readonly humanReviewRequired: true;
}

export interface LegalDocumentVersion {
  readonly versionGroupId: string;
  readonly members: ReadonlyArray<{
    readonly documentId: string;
    readonly ordinal: number;
    readonly basis: 'file_mtime' | 'name_suffix' | 'content_similarity' | 'unknown';
    readonly similarityToPrevious: number | null;
  }>;
  readonly signedMember: string | null;
  readonly filedMember: string | null;
  /** What moved between each consecutive pair of members, in member order. */
  readonly steps: ReadonlyArray<LegalVersionStep>;
  readonly humanReviewRequired: true;
}

/** The shape a party was read from — so a reader can judge the reading, not only see the name. */
export type LegalPartyBasis = 'header_address' | 'organisation_form' | 'organisation_number' | 'counsel_construction' | 'party_label' | 'court_name';

/** A role a document assigned to a party, with the line it did so on. */
export interface LegalRoleEvidence {
  /** The role in the document's own word, lower-cased: byggherre, entreprenør, advokat… */
  readonly role: string;
  readonly evidence: LegalEvidenceRef;
}

export interface LegalParty {
  readonly partyId: string;
  readonly displayName: string;
  readonly kind: 'person' | 'organization' | 'court' | 'authority' | 'unknown';
  readonly basis: LegalPartyBasis;
  /** The organisation number a document stated beside the name, or null. Never an alias. */
  readonly organisationNumber: string | null;
  /** Distinct roles documents assigned to this party; each one is backed by a row in roleEvidence. */
  readonly roles: ReadonlyArray<string>;
  /** Every role reading with the line it was read on. Empty when no document labelled a role. */
  readonly roleEvidence: ReadonlyArray<LegalRoleEvidence>;
  /** Other spellings and addresses read for this identity. Nothing is merged: two spellings stay two parties. */
  readonly aliases: ReadonlyArray<string>;
  readonly mentions: number;
  readonly evidence: ReadonlyArray<LegalEvidenceRef>;
  readonly identityConfidence: number;
  readonly humanReviewRequired: boolean;
}

export interface LegalTimelineEvent {
  readonly eventId: string;
  readonly kind: 'EVENT' | 'COMMUNICATION' | 'PROCEDURAL_STEP' | 'DEADLINE' | 'DECISION';
  readonly occurredAt: string | null;
  readonly learnedAt: string | null;
  readonly datePrecision: 'day' | 'month' | 'year' | 'unknown';
  readonly summary: string;
  readonly evidence: ReadonlyArray<LegalEvidenceRef>;
  readonly assertedBy: AssertionSource;
  readonly confidence: number;
  readonly humanReviewRequired: boolean;
}

/** The claim–evidence matrix row (the operator's core working object). */
export interface LegalStatement {
  readonly statementId: string;
  readonly statement: string;
  readonly status: StatementStatus;
  readonly assertedBy: AssertionSource;
  readonly assertedByPartyId: string | null;
  readonly supportingSources: ReadonlyArray<LegalEvidenceRef>;
  readonly contradictingSources: ReadonlyArray<LegalEvidenceRef>;
  readonly missingEvidence: ReadonlyArray<string>;
  readonly confidence: number;
  readonly humanReviewRequired: boolean;
  readonly verifiedBy: string | null;
  readonly verifiedAt: string | null;
  readonly relatedClaimIds: ReadonlyArray<string>;
}

export interface LegalLink {
  readonly linkId: string;
  readonly kind: LegalLinkKind;
  readonly from: { readonly kind: LegalRecordKind; readonly id: string };
  readonly to: { readonly kind: LegalRecordKind; readonly id: string };
  readonly evidence: ReadonlyArray<LegalEvidenceRef>;
  readonly confidence: number;
}

/**
 * The intake receipt joined against the archive the adapter walked.
 *
 * A document in the archive that never went through intake, a receipt whose
 * document is gone, and a receipt whose hash disagrees with the bytes on disk
 * are each named by path. Any of them makes coverage incomplete: a working set
 * with an unreceipted document in it cannot claim custody of its evidence.
 */
export interface LegalReconciliation {
  readonly receipts: number;
  readonly matched: number;
  readonly documentsWithoutReceipt: ReadonlyArray<string>;
  readonly receiptsWithoutDocument: ReadonlyArray<string>;
  readonly hashMismatches: ReadonlyArray<{ readonly relativePath: string; readonly receiptSha256: string; readonly archiveSha256: string }>;
}

/** Coverage invariant, legal edition: every file in the archive has a fate. */
export interface LegalCoverage {
  readonly caseId: string;
  readonly totalFiles: number;
  /** Files minus exact duplicates: what the case actually holds. */
  readonly distinctDocuments: number;
  readonly byExtraction: Record<ExtractionStatus, number>;
  readonly byKind: Record<string, number>;
  readonly excludedRoots: ReadonlyArray<string>;
  readonly unreadable: ReadonlyArray<{ readonly relativePath: string; readonly reason: string }>;
  /** null when the run was given no receipt to reconcile against — stated, not assumed clean. */
  readonly reconciliation: LegalReconciliation | null;
  /**
   * What the run left out because a per-run cap was reached. The kernel
   * discards a run whose output exceeds its budget, so the pack bounds its own
   * output and says so here rather than losing the whole inventory. All zero
   * means nothing was dropped.
   */
  readonly truncated: { readonly findings: number; readonly statements: number; readonly timeline: number };
  readonly complete: boolean;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------
export interface LegalCaseSummary {
  readonly caseId: string;
  readonly title: string;
  readonly documents: number;
  readonly unreadable: number;
  readonly statements: number;
  readonly statementsNeedingReview: number;
  readonly timelineEvents: number;
  readonly parties: number;
  readonly createdAt: string;
}

export interface LegalCasesResponse {
  readonly cases: ReadonlyArray<LegalCaseSummary>;
}

export interface LegalCaseResponse {
  readonly case: LegalCase;
  readonly summary: LegalCaseSummary;
  readonly coverage: LegalCoverage;
  /** The run these artifacts come from; other runs are listed by the runs endpoint. */
  readonly runKey: string | null;
  readonly lifecycle: LegalLifecycle;
}

/** A created case can be opened before any inventory exists. No synthetic evidence is produced. */
export interface LegalPendingCaseResponse {
  readonly case: LegalCaseMeta;
  readonly summary: null;
  readonly coverage: null;
  readonly runKey: null;
  readonly lifecycle: LegalLifecycle;
}
export type LegalCaseDetailResponse = LegalCaseResponse | LegalPendingCaseResponse;

export interface LegalDocumentsResponse {
  readonly documents: ReadonlyArray<LegalDocument>;
  readonly total: number;
  /** `filedMember` here is the overlay of a lawyer's declaration; the artifact on disk never carries one. */
  readonly versionGroups: ReadonlyArray<LegalDocumentVersion>;
  readonly filedDeclarations: ReadonlyArray<LegalFiledDeclaration>;
  /** Documents a lawyer removed from the archive since the current run; their receipts and decisions remain. */
  readonly removed: ReadonlyArray<LegalRemovedDocument>;
}

export interface LegalDocumentResponse {
  readonly document: LegalDocument;
  readonly versionGroup: LegalDocumentVersion | null;
  readonly links: ReadonlyArray<LegalLink>;
}

export interface LegalTimelineResponse {
  readonly events: ReadonlyArray<LegalTimelineEvent>;
}

export interface LegalPartiesResponse {
  readonly parties: ReadonlyArray<LegalParty>;
  /** Identity merges a lawyer decided. The adapter still lists the parties apart; the decision is shown beside them. */
  readonly identityDecisions: ReadonlyArray<LegalIdentityDecision>;
}

export interface LegalStatementsResponse {
  /** `verified` rows here are the overlay of a lawyer's decision on a statement whose wording has not changed since. */
  readonly statements: ReadonlyArray<LegalStatement>;
  readonly byStatus: Record<string, number>;
  readonly needingReview: number;
  /** Verifications whose statement is gone, or reads differently, in the current run. Shown, never dropped. */
  readonly orphanedVerifications: ReadonlyArray<LegalOrphanedDecision>;
}

export interface LegalCoverageResponse {
  readonly coverage: LegalCoverage;
}

// ---------------------------------------------------------------------------
// Intake — the case's chain of custody, written at upload time
// ---------------------------------------------------------------------------

/** The case's identity, recorded when an operator opens it. */
export interface LegalCaseMeta {
  readonly caseId: string;
  readonly title: string;
  readonly jurisdiction: string | null;
  readonly courtReference: string | null;
  /** Who is answerable for this archive's chain of custody. */
  readonly custodian: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

/**
 * One arrival. `sha256` is measured while the bytes stream in; the inventory
 * adapter later hashes the same file independently, and the two must agree.
 * `rowHash`/`previousRowHash` chain the receipts, so a removed or edited arrival
 * is detectable rather than invisible; `signature` is the console's Ed25519
 * signature over the row hash, made with a key that never leaves the volume,
 * so a re-chained ledger stops verifying and a client holding the public key
 * can check the receipt without trusting this console.
 */
export interface LegalIntakeRecord {
  readonly schemaVersion: 2;
  readonly caseId: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly receivedAt: string;
  readonly receivedBy: string;
  readonly sourceNote: string | null;
  readonly previousRowHash: string | null;
  readonly rowHash: string;
  readonly keyId: string;
  readonly signature: string;
}

/**
 * The verdict of re-walking the receipt: chain, signatures, then the signed
 * head commitment (row count + last row hash). `empty` is a ledger with no
 * rows — it is never called intact. `anchored` is true only when a head was
 * present and agreed with the rows, so a truncated tail or an appended forgery
 * cannot read as intact.
 */
export interface LegalIntakeChainVerdict {
  readonly status: 'empty' | 'intact' | 'broken';
  readonly valid: boolean;
  readonly rows: number;
  readonly brokenAt: number | null;
  readonly reason: string | null;
  readonly anchored: boolean;
  readonly keyId: string | null;
}

export interface LegalIntakeResponse {
  readonly caseMeta: LegalCaseMeta | null;
  readonly intake: ReadonlyArray<LegalIntakeRecord>;
  readonly chain: LegalIntakeChainVerdict;
  readonly lifecycle: LegalLifecycle;
  /** Receipts whose document a lawyer has since removed, by row hash. */
  readonly removedRowHashes: ReadonlyArray<string>;
}

export interface LegalCaseCreatedResponse {
  readonly caseMeta: LegalCaseMeta;
}

export interface LegalUploadResponse {
  readonly record: LegalIntakeRecord;
  /** True when these exact bytes were already stored at this path; nothing was written. */
  readonly duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Decisions — the human half. A machine never writes one of these.
// ---------------------------------------------------------------------------

/**
 * What a person may decide about a case. Each kind is owned by one action
 * class of the approval policy, and each is recorded as a signed row in the
 * case's decision ledger, never inside an artifact.
 */
export const LEGAL_DECISION_KINDS = ['statement_verification', 'filed_version_declaration', 'party_identity_merge', 'document_removal', 'case_lifecycle'] as const;
export type LegalDecisionKind = (typeof LEGAL_DECISION_KINDS)[number];

export const LEGAL_LIFECYCLE_STATES = ['open', 'closed', 'destruction_scheduled'] as const;
export type LegalLifecycleState = (typeof LEGAL_LIFECYCLE_STATES)[number];

/**
 * The kind-specific body of a decision. Every body pins what the decision was
 * about by content, not only by id: a verification names the fingerprint of
 * the statement's wording and evidence, a filed declaration the document's
 * sha256, a removal the bytes it removed. When the current run no longer holds
 * that content the decision is shown as orphaned rather than applied to
 * something the person never looked at.
 */
export type LegalDecisionBody =
  | { readonly kind: 'statement_verification'; readonly action: 'verify' | 'withdraw'; readonly statementFingerprint: string }
  | { readonly kind: 'filed_version_declaration'; readonly action: 'declare' | 'withdraw'; readonly documentId: string; readonly sha256: string }
  | { readonly kind: 'party_identity_merge'; readonly partyIds: ReadonlyArray<string>; readonly displayName: string }
  | { readonly kind: 'document_removal'; readonly relativePath: string; readonly sha256: string }
  | { readonly kind: 'case_lifecycle'; readonly state: LegalLifecycleState; readonly retainUntil: string | null };

export interface LegalDecisionRecord {
  readonly schemaVersion: 2;
  readonly caseId: string;
  readonly decisionId: string;
  readonly kind: LegalDecisionKind;
  /** The statement, version group, party set, document or case the decision is about. */
  readonly targetId: string;
  readonly body: LegalDecisionBody;
  /** The authenticated principal; never a name typed into a request. */
  readonly decidedBy: string;
  readonly role: string;
  readonly decidedAt: string;
  readonly reason: string;
  readonly previousRowHash: string | null;
  readonly rowHash: string;
  readonly keyId: string;
  readonly signature: string;
}

export interface LegalDecisionsResponse {
  readonly decisions: ReadonlyArray<LegalDecisionRecord>;
  readonly chain: LegalIntakeChainVerdict;
}

export interface LegalDecisionResponse {
  readonly decision: LegalDecisionRecord;
}

/** A decision whose target the current run no longer holds as it was decided. */
export interface LegalOrphanedDecision {
  readonly decision: LegalDecisionRecord;
  readonly reason: 'target_missing' | 'target_changed';
}

export interface LegalFiledDeclaration {
  readonly decision: LegalDecisionRecord;
  readonly versionGroupId: string;
  readonly documentId: string;
  readonly orphaned: LegalOrphanedDecision['reason'] | null;
}

export interface LegalIdentityDecision {
  readonly decision: LegalDecisionRecord;
  readonly partyIds: ReadonlyArray<string>;
  readonly displayName: string;
  /** Party ids the current run does not list any more. */
  readonly missingPartyIds: ReadonlyArray<string>;
}

export interface LegalRemovedDocument {
  readonly decision: LegalDecisionRecord;
  readonly relativePath: string;
  readonly sha256: string;
}

/** Derived at read time from the latest lifecycle decision; `open` with nulls when none was made. */
export interface LegalLifecycle {
  readonly state: LegalLifecycleState;
  readonly retainUntil: string | null;
  readonly decision: LegalDecisionRecord | null;
}

// --- request bodies
export interface LegalVerifyStatementRequest {
  readonly action: 'verify' | 'withdraw';
  readonly reason: string;
}
export interface LegalDeclareFiledRequest {
  readonly action: 'declare' | 'withdraw';
  readonly documentId: string;
  readonly reason: string;
}
export interface LegalMergePartiesRequest {
  readonly partyIds: ReadonlyArray<string>;
  readonly displayName: string;
  readonly reason: string;
}
export interface LegalRemoveDocumentRequest {
  readonly reason: string;
}
export interface LegalLifecycleRequest {
  readonly state: LegalLifecycleState;
  readonly retainUntil: string | null;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Planned run-history contracts — publication is tracked in Phase 2
// ---------------------------------------------------------------------------
export interface LegalRunSummary {
  readonly runKey: string;
  readonly current: boolean;
  readonly createdAt: string;
  readonly snapshotSha256: string;
  readonly adapterVersion: string;
  readonly cycleId: string | null;
  readonly documents: number;
  readonly statements: number;
  readonly timelineEvents: number;
  readonly parties: number;
  readonly complete: boolean;
}

export interface LegalRunsResponse {
  readonly runs: ReadonlyArray<LegalRunSummary>;
}

/** One run's own record and coverage, read as written — no decision overlay, no current pointer. */
export interface LegalRunResponse {
  readonly run: LegalRunSummary;
  readonly case: LegalCase;
  readonly coverage: LegalCoverage;
}
