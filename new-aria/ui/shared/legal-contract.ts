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

/** Who put a statement into the world. AI inference is always labelled as such. */
export const ASSERTION_SOURCES = ['party', 'court', 'counsel', 'third_party', 'ai_inference', 'operator'] as const;
export type AssertionSource = (typeof ASSERTION_SOURCES)[number];

/** How a document's bytes were made readable. `unreadable` files become pressure, not silence. */
export const EXTRACTION_STATUSES = ['text', 'metadata_only', 'unreadable', 'excluded'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Artifact layout written by the legal adapter (packs/legal) under
// ARIA_TOOLS_DIR. The console reads it read-only. One directory per case.
// ---------------------------------------------------------------------------
export const LEGAL_ARTIFACT_ROOT = 'packs/legal/cases' as const;
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
  case: { method: 'GET', path: `${LEGAL_API_PREFIX}/cases/:caseId`, response: 'LegalCaseResponse' },
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
} as const;

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
  readonly humanReviewRequired: true;
}

export interface LegalParty {
  readonly partyId: string;
  readonly displayName: string;
  readonly kind: 'person' | 'organization' | 'court' | 'authority' | 'unknown';
  readonly roles: ReadonlyArray<string>;
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

/** Coverage invariant, legal edition: every file in the archive has a fate. */
export interface LegalCoverage {
  readonly caseId: string;
  readonly totalFiles: number;
  readonly byExtraction: Record<ExtractionStatus, number>;
  readonly byKind: Record<string, number>;
  readonly excludedRoots: ReadonlyArray<string>;
  readonly unreadable: ReadonlyArray<{ readonly relativePath: string; readonly reason: string }>;
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
}

export interface LegalDocumentsResponse {
  readonly documents: ReadonlyArray<LegalDocument>;
  readonly total: number;
  readonly versionGroups: ReadonlyArray<LegalDocumentVersion>;
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
}

export interface LegalStatementsResponse {
  readonly statements: ReadonlyArray<LegalStatement>;
  readonly byStatus: Record<string, number>;
  readonly needingReview: number;
}

export interface LegalCoverageResponse {
  readonly coverage: LegalCoverage;
}
