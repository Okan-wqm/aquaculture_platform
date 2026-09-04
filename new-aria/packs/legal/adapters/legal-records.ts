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
/** Largest PDF/Office file loaded whole for text extraction; larger files are inventoried metadata_only with reason binary_too_large. */
export const DEFAULT_MAX_BINARY_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_ROOT = 'packs/legal/cases' as const;

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
export type AssertionSource = 'party' | 'court' | 'counsel' | 'third_party' | 'ai_inference' | 'operator';
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
}

export type VersionOrdinalBasis = 'file_mtime' | 'name_suffix' | 'content_similarity' | 'unknown';

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
  readonly humanReviewRequired: true;
}

export interface LegalParty {
  readonly partyId: string;
  readonly displayName: string;
  readonly kind: 'person' | 'organization' | 'court' | 'authority' | 'unknown';
  readonly roles: readonly string[];
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

export interface LegalCoverage {
  readonly caseId: string;
  readonly totalFiles: number;
  readonly byExtraction: Record<ExtractionStatus, number>;
  readonly byKind: Record<string, number>;
  readonly excludedRoots: readonly string[];
  readonly unreadable: ReadonlyArray<{ readonly relativePath: string; readonly reason: string }>;
  readonly complete: boolean;
}

export interface LegalCaseArtifacts {
  readonly case: LegalCase;
  readonly documents: readonly LegalDocument[];
  readonly versions: readonly LegalDocumentVersion[];
  readonly parties: readonly LegalParty[];
  readonly timeline: readonly LegalTimelineEvent[];
  readonly statements: readonly never[];
  readonly links: readonly LegalLink[];
  readonly coverage: LegalCoverage;
}

