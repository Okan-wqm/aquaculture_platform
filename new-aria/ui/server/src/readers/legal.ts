// Legal pack projection — read-only over the adapter's case artifacts.
//
// WHY: the legal muscle writes one directory per case under the tools dir; the
// console must show exactly those records and refuse malformed artifacts loudly
// (a silently half-rendered case would misrepresent evidence). MEASURED
// 2026-09-04: this reader cast each file to its interface, so a hand-edited
// `verified` statement reached a lawyer verbatim and an artifact from an unknown
// adapter build rendered as if current. Every artifact is now validated field
// by field against the pack's schemas before it is served, the case record is
// read first so an unsupported adapter build is refused before anything else
// is shown, and a machine artifact carrying `verified` is refused under its own
// name.
// WHAT: list case directories, validate each artifact file, project summaries.

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
import { LEGAL_ARTIFACT_FILES, LEGAL_ARTIFACT_ROOT, LEGAL_CASE_ID_RE } from '../../../shared/legal-contract.ts';
import {
  LegalArtifactError,
  validateCase,
  validateCoverage,
  validateDocuments,
  validateLinks,
  validateParties,
  validateStatements,
  validateTimeline,
  validateVersions,
} from '../../../shared/legal-artifact-validate.ts';
import { HttpError } from '../errors.ts';
import { existsInside, listDirectory, readJsonFile, resolveInside } from '../fsafe.ts';

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
  if (!LEGAL_CASE_ID_RE.test(caseId)) throw new HttpError(400, 'case_id_invalid');
  return resolveInside(toolsDir, LEGAL_ARTIFACT_ROOT, caseId);
}

/** A validator's refusal becomes a 502 that names the file, the path and the reason. */
function validated<T>(validate: (value: unknown) => T, value: unknown): T {
  try {
    return validate(value);
  } catch (error) {
    if (error instanceof LegalArtifactError) throw new HttpError(502, error.code, error.message);
    throw error;
  }
}

async function readArray<T>(dir: string, file: string, validate: (value: unknown) => T[]): Promise<ReadonlyArray<T>> {
  const parsed = await readJsonFile(resolveInside(dir, file), INVALID);
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new HttpError(502, INVALID, `${file} must be an array`);
  return validated(validate, parsed);
}

async function readObject<T extends object>(dir: string, file: string, validate: (value: unknown) => T): Promise<T> {
  const parsed = await readJsonFile(resolveInside(dir, file), INVALID);
  if (parsed === null) throw new HttpError(404, 'legal_artifact_missing', file);
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(502, INVALID, `${file} must be an object`);
  return validated(validate, parsed);
}

/**
 * The case record is read before any other artifact of the case: it names the
 * adapter build, and a build this console does not know is refused here, once,
 * rather than discovered tab by tab.
 */
async function readCaseRecord(dir: string): Promise<LegalCase> {
  return readObject<LegalCase>(dir, LEGAL_ARTIFACT_FILES.case, validateCase);
}

const readDocumentsFile = (dir: string): Promise<ReadonlyArray<LegalDocument>> => readArray<LegalDocument>(dir, LEGAL_ARTIFACT_FILES.documents, validateDocuments);
const readVersionsFile = (dir: string): Promise<ReadonlyArray<LegalDocumentVersion>> => readArray<LegalDocumentVersion>(dir, LEGAL_ARTIFACT_FILES.versions, validateVersions);
const readPartiesFile = (dir: string): Promise<ReadonlyArray<LegalParty>> => readArray<LegalParty>(dir, LEGAL_ARTIFACT_FILES.parties, validateParties);
const readTimelineFile = (dir: string): Promise<ReadonlyArray<LegalTimelineEvent>> => readArray<LegalTimelineEvent>(dir, LEGAL_ARTIFACT_FILES.timeline, validateTimeline);
const readStatementsFile = (dir: string): Promise<ReadonlyArray<LegalStatement>> => readArray<LegalStatement>(dir, LEGAL_ARTIFACT_FILES.statements, validateStatements);
const readLinksFile = (dir: string): Promise<ReadonlyArray<LegalLink>> => readArray<LegalLink>(dir, LEGAL_ARTIFACT_FILES.links, validateLinks);

async function summarise(toolsDir: string, caseId: string): Promise<LegalCaseSummary> {
  const dir = caseDir(toolsDir, caseId);
  const record = await readCaseRecord(dir);
  const documents = await readDocumentsFile(dir);
  const statements = await readStatementsFile(dir);
  const timeline = await readTimelineFile(dir);
  const parties = await readPartiesFile(dir);
  const coverage = (await existsInside(resolveInside(dir, LEGAL_ARTIFACT_FILES.coverage)))
    ? await readObject<LegalCoverage>(dir, LEGAL_ARTIFACT_FILES.coverage, validateCoverage)
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
    if (!LEGAL_CASE_ID_RE.test(name)) continue;
    if (!(await existsInside(resolveInside(root, name, LEGAL_ARTIFACT_FILES.case)))) continue;
    cases.push(await summarise(toolsDir, name));
  }
  cases.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { cases };
}

export async function readCase(toolsDir: string, caseId: string): Promise<LegalCaseResponse> {
  const dir = caseDir(toolsDir, caseId);
  return {
    case: await readCaseRecord(dir),
    summary: await summarise(toolsDir, caseId),
    coverage: await readObject<LegalCoverage>(dir, LEGAL_ARTIFACT_FILES.coverage, validateCoverage),
  };
}

export async function readDocuments(toolsDir: string, caseId: string, filter: DocumentsFilter): Promise<LegalDocumentsResponse> {
  const dir = caseDir(toolsDir, caseId);
  await readCaseRecord(dir);
  let documents = await readDocumentsFile(dir);
  const total = documents.length;
  if (filter.kind !== null) documents = documents.filter((doc) => doc.kindGuess === filter.kind);
  if (filter.extraction !== null) documents = documents.filter((doc) => doc.extraction === filter.extraction);
  return { documents: documents.slice(0, filter.limit), total, versionGroups: await readVersionsFile(dir) };
}

export async function readDocument(toolsDir: string, caseId: string, documentId: string): Promise<LegalDocumentResponse> {
  const dir = caseDir(toolsDir, caseId);
  await readCaseRecord(dir);
  const document = (await readDocumentsFile(dir)).find((doc) => doc.documentId === documentId);
  if (document === undefined) throw new HttpError(404, 'legal_document_not_found');
  const versionGroup = (await readVersionsFile(dir)).find((group) => group.versionGroupId === document.versionGroupId) ?? null;
  const links = (await readLinksFile(dir)).filter(
    (link) => (link.from.kind === 'DOCUMENT' && link.from.id === documentId) || (link.to.kind === 'DOCUMENT' && link.to.id === documentId),
  );
  return { document, versionGroup, links };
}

export async function readTimeline(toolsDir: string, caseId: string): Promise<LegalTimelineResponse> {
  const dir = caseDir(toolsDir, caseId);
  await readCaseRecord(dir);
  return { events: await readTimelineFile(dir) };
}

export async function readParties(toolsDir: string, caseId: string): Promise<LegalPartiesResponse> {
  const dir = caseDir(toolsDir, caseId);
  await readCaseRecord(dir);
  return { parties: await readPartiesFile(dir) };
}

export async function readStatements(toolsDir: string, caseId: string, filter: StatementsFilter): Promise<LegalStatementsResponse> {
  const dir = caseDir(toolsDir, caseId);
  await readCaseRecord(dir);
  const all = await readStatementsFile(dir);
  const byStatus: Record<string, number> = {};
  for (const statement of all) byStatus[statement.status] = (byStatus[statement.status] ?? 0) + 1;
  let statements = all;
  if (filter.status !== null) statements = statements.filter((statement) => statement.status === filter.status);
  if (filter.humanReview !== null) statements = statements.filter((statement) => statement.humanReviewRequired === filter.humanReview);
  return { statements, byStatus, needingReview: all.filter((statement) => statement.humanReviewRequired).length };
}

export async function readCoverage(toolsDir: string, caseId: string): Promise<LegalCoverageResponse> {
  const dir = caseDir(toolsDir, caseId);
  await readCaseRecord(dir);
  return { coverage: await readObject<LegalCoverage>(dir, LEGAL_ARTIFACT_FILES.coverage, validateCoverage) };
}
