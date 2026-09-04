// Typed client for the Legal Case Intelligence endpoints (LEGAL_ENDPOINTS).
//
// WHY: same discipline as client.ts — URLs come from the shared contract, and the
// SPA only projects what the legal adapter already wrote; it never authors facts.
import {
  LEGAL_ENDPOINTS,
  LEGAL_UPLOAD_FILE_NAME_HEADER,
  LEGAL_UPLOAD_SOURCE_HEADER,
  type LegalCaseCreatedResponse,
  type LegalCaseResponse,
  type LegalCasesResponse,
  type LegalCoverageResponse,
  type LegalDocumentResponse,
  type LegalDocumentsResponse,
  type LegalPartiesResponse,
  type LegalIntakeResponse,
  type LegalStatementsResponse,
  type LegalTimelineResponse,
  type LegalUploadResponse,
} from '../../../shared/legal-contract.ts';
import type { JobResponse } from '../../../shared/api-contract.ts';
import { requestBytes, requestJson } from './http.ts';
import { fillPath, withQuery } from './query.ts';

export interface LegalDocumentsQuery {
  readonly kind?: string | undefined;
  readonly extraction?: string | undefined;
  readonly limit?: number | undefined;
}

export interface LegalStatementsQuery {
  readonly status?: string | undefined;
  readonly humanReview?: boolean | undefined;
}

export function getLegalCases(signal?: AbortSignal): Promise<LegalCasesResponse> {
  return requestJson<LegalCasesResponse>(LEGAL_ENDPOINTS.cases.path, { signal });
}

export function getLegalCase(caseId: string, signal?: AbortSignal): Promise<LegalCaseResponse> {
  return requestJson<LegalCaseResponse>(fillPath(LEGAL_ENDPOINTS.case.path, { caseId }), { signal });
}

export function getLegalDocuments(
  caseId: string,
  query: LegalDocumentsQuery = {},
  signal?: AbortSignal,
): Promise<LegalDocumentsResponse> {
  return requestJson<LegalDocumentsResponse>(
    withQuery(fillPath(LEGAL_ENDPOINTS.documents.path, { caseId }), {
      kind: query.kind,
      extraction: query.extraction,
      limit: query.limit,
    }),
    { signal },
  );
}

export function getLegalDocument(caseId: string, documentId: string, signal?: AbortSignal): Promise<LegalDocumentResponse> {
  return requestJson<LegalDocumentResponse>(fillPath(LEGAL_ENDPOINTS.document.path, { caseId, documentId }), { signal });
}

export function getLegalTimeline(caseId: string, signal?: AbortSignal): Promise<LegalTimelineResponse> {
  return requestJson<LegalTimelineResponse>(fillPath(LEGAL_ENDPOINTS.timeline.path, { caseId }), { signal });
}

export function getLegalParties(caseId: string, signal?: AbortSignal): Promise<LegalPartiesResponse> {
  return requestJson<LegalPartiesResponse>(fillPath(LEGAL_ENDPOINTS.parties.path, { caseId }), { signal });
}

export function getLegalStatements(
  caseId: string,
  query: LegalStatementsQuery = {},
  signal?: AbortSignal,
): Promise<LegalStatementsResponse> {
  return requestJson<LegalStatementsResponse>(
    withQuery(fillPath(LEGAL_ENDPOINTS.statements.path, { caseId }), {
      status: query.status,
      humanReview: query.humanReview,
    }),
    { signal },
  );
}

export function getLegalCoverage(caseId: string, signal?: AbortSignal): Promise<LegalCoverageResponse> {
  return requestJson<LegalCoverageResponse>(fillPath(LEGAL_ENDPOINTS.coverage.path, { caseId }), { signal });
}

// ---------------------------------------------------------------------------
// Intake — the only writing surface the console has, and every write goes
// through the server, which owns the receipt and its hash chain.
// ---------------------------------------------------------------------------

export function getLegalIntake(caseId: string, signal?: AbortSignal): Promise<LegalIntakeResponse> {
  return requestJson<LegalIntakeResponse>(fillPath(LEGAL_ENDPOINTS.intake.path, { caseId }), { signal });
}

export interface CreateLegalCaseInput {
  readonly caseId: string;
  readonly title: string;
  readonly jurisdiction: string | null;
  readonly courtReference: string | null;
  readonly custodian: string;
}

export function createLegalCase(input: CreateLegalCaseInput, signal?: AbortSignal): Promise<LegalCaseCreatedResponse> {
  return requestJson<LegalCaseCreatedResponse>(LEGAL_ENDPOINTS.createCase.path, { method: 'POST', body: input, signal });
}

/**
 * Uploads one document as raw bytes.
 *
 * The file name travels in a percent-encoded header rather than a multipart
 * body: the console adds no dependency and no hand-rolled parser, and the bytes
 * the server hashes are exactly the bytes the browser sent.
 */
export function uploadLegalDocument(
  caseId: string,
  file: File,
  options: { readonly relativePath?: string | undefined; readonly sourceNote?: string | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<LegalUploadResponse> {
  const headers = new Headers();
  headers.set(LEGAL_UPLOAD_FILE_NAME_HEADER, encodeURIComponent(options.relativePath ?? file.name));
  if (options.sourceNote !== undefined && options.sourceNote.trim() !== '') {
    headers.set(LEGAL_UPLOAD_SOURCE_HEADER, options.sourceNote.trim());
  }
  return requestBytes<LegalUploadResponse>(fillPath(LEGAL_ENDPOINTS.uploadDocument.path, { caseId }), file, {
    headers,
    signal: options.signal,
  });
}

export function runLegalInventory(caseId: string, title: string | null, signal?: AbortSignal): Promise<JobResponse> {
  return requestJson<JobResponse>(fillPath(LEGAL_ENDPOINTS.runInventory.path, { caseId }), {
    method: 'POST',
    body: { title },
    signal,
  });
}
