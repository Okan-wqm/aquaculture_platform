// Legal pack projection — read-only over the adapter's case artifacts.
//
// WHY: the legal muscle writes one directory per case under the tools dir; the
// console must show exactly those records and refuse malformed artifacts loudly
// (a silently half-rendered case would misrepresent evidence).
// WHAT: list case directories, read each artifact file, check its top-level
// shape (array/object as the contract dictates) and project summaries.

import type {
  LegalCase,
  LegalCaseResponse,
  LegalCaseSummary,
  LegalCasesResponse,
  LegalCoverage,
  LegalCoverageResponse,
  LegalDocument,
  LegalDocumentResponse,
  LegalDocumentsResponse,
  LegalDocumentVersion,
  LegalLink,
  LegalPartiesResponse,
  LegalParty,
  LegalStatement,
  LegalStatementsResponse,
  LegalTimelineEvent,
  LegalTimelineResponse,
} from '../../../shared/legal-contract.ts';
import { LEGAL_ARTIFACT_FILES, LEGAL_ARTIFACT_ROOT } from '../../../shared/legal-contract.ts';
import { HttpError } from '../errors.ts';
import { existsInside, listDirectory, readJsonFile, resolveInside } from '../fsafe.ts';

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const INVALID = 'legal_artifact_invalid';

export interface DocumentsFilter {
  readonly kind: string | null;
  readonly extraction: string | null;
  readonly limit: number;
}

export interface StatementsFilter {
  readonly status: string | null;
  readonly humanReview: boolean | null;
}

function caseDir(toolsDir: string, caseId: string): string {
  if (!CASE_ID.test(caseId)) throw new HttpError(400, 'case_id_invalid');
  return resolveInside(toolsDir, LEGAL_ARTIFACT_ROOT, caseId);
}

async function readArray<T>(dir: string, file: string): Promise<ReadonlyArray<T>> {
  const parsed = await readJsonFile(resolveInside(dir, file), INVALID);
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new HttpError(502, INVALID, `${file} must be an array`);
  return parsed as ReadonlyArray<T>;
}

async function readObject<T extends object>(dir: string, file: string): Promise<T> {
  const parsed = await readJsonFile(resolveInside(dir, file), INVALID);
  if (parsed === null) throw new HttpError(404, 'legal_artifact_missing', file);
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(502, INVALID, `${file} must be an object`);
  return parsed as T;
}

async function summarise(toolsDir: string, caseId: string): Promise<LegalCaseSummary> {
  const dir = caseDir(toolsDir, caseId);
  const record = await readObject<LegalCase>(dir, LEGAL_ARTIFACT_FILES.case);
  const documents = await readArray<LegalDocument>(dir, LEGAL_ARTIFACT_FILES.documents);
  const statements = await readArray<LegalStatement>(dir, LEGAL_ARTIFACT_FILES.statements);
  const timeline = await readArray<LegalTimelineEvent>(dir, LEGAL_ARTIFACT_FILES.timeline);
  const parties = await readArray<LegalParty>(dir, LEGAL_ARTIFACT_FILES.parties);
  const coverage = (await existsInside(resolveInside(dir, LEGAL_ARTIFACT_FILES.coverage)))
    ? await readObject<LegalCoverage>(dir, LEGAL_ARTIFACT_FILES.coverage)
    : null;
  return {
    caseId,
    title: record.title,
    documents: documents.length,
    unreadable: coverage === null ? documents.filter((doc) => doc.extraction === 'unreadable' || doc.extraction === 'metadata_only').length : coverage.unreadable.length,
    statements: statements.length,
    statementsNeedingReview: statements.filter((statement) => statement.humanReviewRequired).length,
    timelineEvents: timeline.length,
    parties: parties.length,
    createdAt: record.createdAt,
  };
}

export async function listCases(toolsDir: string): Promise<LegalCasesResponse> {
  const root = resolveInside(toolsDir, LEGAL_ARTIFACT_ROOT);
  const cases: LegalCaseSummary[] = [];
  for (const name of await listDirectory(root)) {
    if (!CASE_ID.test(name)) continue;
    if (!(await existsInside(resolveInside(root, name, LEGAL_ARTIFACT_FILES.case)))) continue;
    cases.push(await summarise(toolsDir, name));
  }
  cases.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { cases };
}

export async function readCase(toolsDir: string, caseId: string): Promise<LegalCaseResponse> {
  const dir = caseDir(toolsDir, caseId);
  return {
    case: await readObject<LegalCase>(dir, LEGAL_ARTIFACT_FILES.case),
    summary: await summarise(toolsDir, caseId),
    coverage: await readObject<LegalCoverage>(dir, LEGAL_ARTIFACT_FILES.coverage),
  };
}

export async function readDocuments(toolsDir: string, caseId: string, filter: DocumentsFilter): Promise<LegalDocumentsResponse> {
  const dir = caseDir(toolsDir, caseId);
  let documents = await readArray<LegalDocument>(dir, LEGAL_ARTIFACT_FILES.documents);
  const total = documents.length;
  if (filter.kind !== null) documents = documents.filter((doc) => doc.kindGuess === filter.kind);
  if (filter.extraction !== null) documents = documents.filter((doc) => doc.extraction === filter.extraction);
  return { documents: documents.slice(0, filter.limit), total, versionGroups: await readArray<LegalDocumentVersion>(dir, LEGAL_ARTIFACT_FILES.versions) };
}

export async function readDocument(toolsDir: string, caseId: string, documentId: string): Promise<LegalDocumentResponse> {
  const dir = caseDir(toolsDir, caseId);
  const document = (await readArray<LegalDocument>(dir, LEGAL_ARTIFACT_FILES.documents)).find((doc) => doc.documentId === documentId);
  if (document === undefined) throw new HttpError(404, 'legal_document_not_found');
  const versionGroup = (await readArray<LegalDocumentVersion>(dir, LEGAL_ARTIFACT_FILES.versions)).find((group) => group.versionGroupId === document.versionGroupId) ?? null;
  const links = (await readArray<LegalLink>(dir, LEGAL_ARTIFACT_FILES.links)).filter(
    (link) => (link.from.kind === 'DOCUMENT' && link.from.id === documentId) || (link.to.kind === 'DOCUMENT' && link.to.id === documentId),
  );
  return { document, versionGroup, links };
}

export async function readTimeline(toolsDir: string, caseId: string): Promise<LegalTimelineResponse> {
  return { events: await readArray<LegalTimelineEvent>(caseDir(toolsDir, caseId), LEGAL_ARTIFACT_FILES.timeline) };
}

export async function readParties(toolsDir: string, caseId: string): Promise<LegalPartiesResponse> {
  return { parties: await readArray<LegalParty>(caseDir(toolsDir, caseId), LEGAL_ARTIFACT_FILES.parties) };
}

export async function readStatements(toolsDir: string, caseId: string, filter: StatementsFilter): Promise<LegalStatementsResponse> {
  const all = await readArray<LegalStatement>(caseDir(toolsDir, caseId), LEGAL_ARTIFACT_FILES.statements);
  const byStatus: Record<string, number> = {};
  for (const statement of all) byStatus[statement.status] = (byStatus[statement.status] ?? 0) + 1;
  let statements = all;
  if (filter.status !== null) statements = statements.filter((statement) => statement.status === filter.status);
  if (filter.humanReview !== null) statements = statements.filter((statement) => statement.humanReviewRequired === filter.humanReview);
  return { statements, byStatus, needingReview: all.filter((statement) => statement.humanReviewRequired).length };
}

export async function readCoverage(toolsDir: string, caseId: string): Promise<LegalCoverageResponse> {
  return { coverage: await readObject<LegalCoverage>(caseDir(toolsDir, caseId), LEGAL_ARTIFACT_FILES.coverage) };
}
