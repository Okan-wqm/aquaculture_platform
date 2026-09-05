// Legal Case Intelligence pack — record shapes (contract mirror) and adapter identity.
//
// WHY: the pack cannot import the console (`ui/shared/legal-contract.ts` is
// imported BY the console, extension point X-6), so the record shapes are
// restated here. Field names are normative byte-for-byte; the test
// `legal-document-inventory.test.ts` proves parity against the JSON schemas and
// the contract source text, so drift fails at test time rather than at render.
//
// WHAT: the TypeScript interfaces for every artifact the inventory adapter
// writes, plus the adapter's stable identity constants.
export const ADAPTER_ID = 'legal-document-inventory' as const;
export const ADAPTER_VERSION = '0.1.0' as const;
export const DEFAULT_MAX_TEXT_BYTES = 262144;
/**
 * Per-run caps on what a single inventory may emit. MEASURED 2026-09-04: with
 * no bound, 400 documents produced 237,880 statement rows and 171 MB of
 * stdout, and the kernel discards any run whose stdout exceeds 12 MiB — so an
 * unbounded run lost the whole inventory. The caps are declared in
 * coverage.truncated; nothing is dropped silently.
 */
export const MAX_FINDINGS_PER_RUN = 5000;
export const MAX_STATEMENTS_PER_RUN = 5000;
export const MAX_TIMELINE_EVENTS_PER_RUN = 20000;
/** Largest PDF/Office file loaded whole for text extraction; larger files are inventoried metadata_only with reason binary_too_large. */
export const DEFAULT_MAX_BINARY_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_ROOT = 'packs/legal/cases' as const;
/**
 * The case id names this adapter's artifact directory AND the console's intake
 * directory for the same case: one id, one pattern, both sides. The string is
 * restated from ui/shared/legal-contract.ts LEGAL_CASE_ID_PATTERN because the
 * pack may not import the console (extension point X-6); the adapter test pins
 * the two texts equal. MEASURED 2026-09-04: a `case_` prefix added here alone
 * gave one case two identities.
 */
export const CASE_ID_PATTERN = '^[a-z0-9][a-z0-9._-]{2,63}$' as const;
export const CASE_ID_RE = new RegExp(CASE_ID_PATTERN);

export type LegalRecordKind =
  | 'CASE'
  | 'PARTY'
  | 'ROLE'
  | 'DOCUMENT'
  | 'DOCUMENT_VERSION'
  | 'COMMUNICATION'
  | 'EVENT'
  | 'CLAIM'
  | 'COUNTERCLAIM'
  | 'EVIDENCE'
  | 'PROCEDURAL_STEP'
  | 'DEADLINE'
  | 'DECISION'
  | 'FINANCIAL_LOSS'
  | 'ACCESS_PERMISSION';
export type LegalLinkKind =
  | 'SUPPORTS'
  | 'CONTRADICTS'
  | 'SUPERSEDES'
  | 'WAS_RECEIVED_BY'
  | 'WAS_SENT_BY'
  | 'CAUSED'
  | 'REFERS_TO'
  | 'REQUIRES'
  | 'PARTY_IN'
  | 'VERSION_OF';
/**
 * Who put a record into the world. Mirrors ASSERTION_SOURCES in
 * ui/shared/legal-contract.ts byte-for-byte.
 *
 * `mechanical_extraction` means a parser read these exact bytes at a stated
 * locator and would read them the same way tomorrow. `ai_inference` means a
 * model proposed something. The adapter emits only the former; it runs no model.
 */
export type AssertionSource =
  | 'party'
  | 'court'
  | 'counsel'
  | 'third_party'
  | 'mechanical_extraction'
  | 'ai_inference'
  | 'operator';

/** Status of a claim–evidence matrix row. `verified` is earned only by a human. */
export type StatementStatus = 'asserted' | 'disputed' | 'supported' | 'contradicted' | 'unverifiable' | 'verified';
export type ExtractionStatus = 'text' | 'metadata_only' | 'unreadable' | 'excluded';
export const EXTRACTION_STATUSES: readonly ExtractionStatus[] = ['text', 'metadata_only', 'unreadable', 'excluded'];

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
  readonly datesMentioned: readonly string[];
  readonly amountsMentioned: readonly string[];
  readonly versionGroupId: string | null;
  readonly excludedReason: string | null;
  /**
   * The document whose bytes this file repeats exactly, or null. Identical
   * bytes under two names are one document delivered twice, not two versions
   * of anything: the copy is listed, counted, and derives no record of its own.
   */
  readonly duplicateOf: string | null;
}

export type VersionOrdinalBasis = 'file_mtime' | 'name_suffix' | 'content_similarity' | 'unknown';

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
    readonly basis: VersionOrdinalBasis;
    readonly similarityToPrevious: number | null;
  }>;
  readonly signedMember: string | null;
  readonly filedMember: string | null;
  /** What moved between each consecutive pair of members, in member order. */
  readonly steps: ReadonlyArray<LegalVersionStep>;
  readonly humanReviewRequired: true;
}

/** The shape a party was read from. Mirrors LegalPartyBasis in the console contract. */
export type LegalPartyBasis = 'header_address' | 'organisation_form' | 'organisation_number' | 'counsel_construction' | 'party_label' | 'court_name';

/** A role a document assigned to a party, with the line it did so on. */
export interface LegalRoleEvidence {
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
  /** Distinct roles documents assigned to this party; each backed by a roleEvidence row. */
  readonly roles: readonly string[];
  readonly roleEvidence: readonly LegalRoleEvidence[];
  /** Other spellings and addresses read for this identity. Nothing is merged. */
  readonly aliases: readonly string[];
  readonly mentions: number;
  readonly evidence: readonly LegalEvidenceRef[];
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
  readonly evidence: readonly LegalEvidenceRef[];
  readonly assertedBy: AssertionSource;
  readonly confidence: number;
  readonly humanReviewRequired: boolean;
}

export interface LegalLink {
  readonly linkId: string;
  readonly kind: LegalLinkKind;
  readonly from: { readonly kind: LegalRecordKind; readonly id: string };
  readonly to: { readonly kind: LegalRecordKind; readonly id: string };
  readonly evidence: readonly LegalEvidenceRef[];
  readonly confidence: number;
}

/** A claim–evidence matrix row. Mirrors LegalStatement in the console contract. */
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

/**
 * The intake receipt joined against the archive this run walked. Mirrors
 * LegalReconciliation in the console contract byte-for-byte.
 */
export interface LegalReconciliation {
  readonly receipts: number;
  readonly matched: number;
  readonly documentsWithoutReceipt: readonly string[];
  readonly receiptsWithoutDocument: readonly string[];
  readonly hashMismatches: ReadonlyArray<{ readonly relativePath: string; readonly receiptSha256: string; readonly archiveSha256: string }>;
}

export interface LegalCoverage {
  readonly caseId: string;
  readonly totalFiles: number;
  /** Files minus exact duplicates: what the case actually holds. */
  readonly distinctDocuments: number;
  readonly byExtraction: Record<ExtractionStatus, number>;
  readonly byKind: Record<string, number>;
  readonly excludedRoots: readonly string[];
  readonly unreadable: ReadonlyArray<{ readonly relativePath: string; readonly reason: string }>;
  /** null when the run was given no receipt to reconcile against — stated, not assumed clean. */
  readonly reconciliation: LegalReconciliation | null;
  /** What the run left out because a per-run cap was reached; all zero means nothing was dropped. */
  readonly truncated: { readonly findings: number; readonly statements: number; readonly timeline: number };
  readonly complete: boolean;
}

export interface LegalCaseArtifacts {
  readonly case: LegalCase;
  readonly documents: readonly LegalDocument[];
  readonly versions: readonly LegalDocumentVersion[];
  readonly parties: readonly LegalParty[];
  readonly timeline: readonly LegalTimelineEvent[];
  /**
   * The claim–evidence matrix. The adapter fills only the rows it can derive
   * without judgement (a disagreement, an unsatisfied reference); it can never
   * write a `verified` row — the statement gate refuses one at the type level
   * and again at runtime.
   */
  readonly statements: readonly LegalStatement[];
  readonly links: readonly LegalLink[];
  readonly coverage: LegalCoverage;
}

