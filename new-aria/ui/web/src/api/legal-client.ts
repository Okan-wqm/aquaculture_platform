// Typed client for the Legal Case Intelligence endpoints (LEGAL_ENDPOINTS).
//
// WHY: same discipline as client.ts — URLs come from the shared contract, and the
// SPA only projects what the legal adapter already wrote; it never authors facts.
import {
  LEGAL_ENDPOINTS,
  type LegalCaseResponse,
  type LegalCasesResponse,
  type LegalCoverageResponse,
  type LegalDocumentResponse,
  type LegalDocumentsResponse,
  type LegalPartiesResponse,
  type LegalStatementsResponse,
  type LegalTimelineResponse,
} from '../../../shared/legal-contract.ts';
import { requestJson } from './http.ts';
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
