// Route table — every contract endpoint bound to its reader or action.
//
// WHY: the contract (ui/shared/api-contract.ts + legal-contract.ts) is the single
// description of the API; binding by the contract's own path strings means a
// path typo here is a type error, not a 404 discovered in the browser.
//
// Authorization is per ACTION CLASS. Kernel control (cycle run, pause, resume)
// answers to the environment-and-manifest switch; every case action answers to
// the instance's approval policy through `requireGate`, which names the class
// and the role it needs when it refuses. The principal a route writes into a
// receipt is the one the server authenticated — a route never reads an
// identity out of the request.
//
// WHAT: builds the compiled route list the server dispatches on.

import type { IncomingMessage } from 'node:http';

import type { HealthResponse, WhoAmIResponse } from '../../shared/api-contract.ts';
import { DEFAULT_LIMIT, ENDPOINTS, KERNEL_CONTROL_ACTION_CLASS, LEDGER_SOURCES, MAX_LIMIT } from '../../shared/api-contract.ts';
import type { LegalCaseCreatedResponse, LegalIntakeResponse, LegalUploadResponse } from '../../shared/legal-contract.ts';
import { LEGAL_ENDPOINTS, LEGAL_UPLOAD_FILE_NAME_HEADER, LEGAL_UPLOAD_SOURCE_HEADER } from '../../shared/legal-contract.ts';
import { control, doctor, integrityVerify, JobTable } from './actions.ts';
import type { ServerConfig } from './config.ts';
import { HttpError } from './errors.ts';
import { existsInside, resolveInside } from './fsafe.ts';
import { permissionsFor, requireGate } from './gates.ts';
import {
  archiveRunRoot,
  createCase,
  decodeFileNameHeader,
  readCaseMeta,
  readIntakeHead,
  readIntakeLedger,
  uploadDocument,
  verifyIntakeChain,
} from './legal-intake.ts';
import type { LegalReadinessHolder } from './legal-readiness.ts';
import { readLegalReadiness, requireLegalAdapter } from './legal-readiness.ts';
import { readAgentRequests } from './readers/agents.ts';
import { readCycleDetail, readCycles } from './readers/cycles.ts';
import { readFindings } from './readers/findings.ts';
import { readGovernance } from './readers/governance.ts';
import { readHumanRequired } from './readers/human-required.ts';
import { listCases, readCase, readCoverage, readDocument, readDocuments, readParties, readStatements, readTimeline } from './readers/legal.ts';
import { readLedgers } from './readers/ledgers.ts';
import { readBeliefs } from './readers/memory.ts';
import { readOverview } from './readers/overview.ts';
import { readPlans } from './readers/plans.ts';
import { readPressures } from './readers/pressures.ts';
import { listDailyReports, readDailyReport } from './readers/reports.ts';
import { readTools } from './readers/tools.ts';
import type { Route } from './router.ts';
import { clampLimit, compileRoute, readJsonBody, sendJson } from './router.ts';
import { streamGovernance } from './sse.ts';

function param(query: URLSearchParams, name: string): string | null {
  const value = query.get(name);
  return value === null || value.trim() === '' ? null : value.trim();
}

function requireParam(params: Readonly<Record<string, string>>, name: string): string {
  return params[name] ?? '';
}

/** A single header value; a repeated header is ambiguous and refused. */
function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new HttpError(400, 'header_repeated', name);
  return value;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${field}_required`);
  return value.trim();
}

function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field}_invalid`);
  return value.trim() === '' ? null : value.trim();
}

export function buildRoutes(config: ServerConfig, jobs: JobTable, readiness: LegalReadinessHolder): ReadonlyArray<ReturnType<typeof compileRoute>> {
  const routes: Route[] = [
    {
      method: 'GET',
      pattern: ENDPOINTS.health.path,
      handler: async ({ res }) => {
        const body: HealthResponse = {
          status: 'ok',
          service: 'new-aria-ui',
          version: config.version,
          toolsDirPresent: await existsInside(config.toolsDir),
          actionsEnabled: config.allowActions,
          legal: await readLegalReadiness(config, readiness.boot),
          ledgerSigning: readiness.signer === null ? null : { keyId: readiness.signer.keyId, publicKeyPem: readiness.signer.publicKeyPem },
          generatedAt: new Date().toISOString(),
        };
        sendJson(res, 200, body);
      },
    },
    {
      method: 'GET',
      pattern: ENDPOINTS.me.path,
      handler: async ({ res, principal }) => {
        const body: WhoAmIResponse = {
          principal: { id: principal.id, displayName: principal.displayName, role: principal.role },
          permissions: permissionsFor(config, principal),
        };
        sendJson(res, 200, body);
      },
    },
    { method: 'GET', pattern: ENDPOINTS.overview.path, handler: async ({ res }) => sendJson(res, 200, await readOverview(config)) },
    { method: 'GET', pattern: ENDPOINTS.cycles.path, handler: async ({ res, query }) => sendJson(res, 200, await readCycles(config.toolsDir, clampLimit(query, 50, MAX_LIMIT))) },
    { method: 'GET', pattern: ENDPOINTS.cycle.path, handler: async ({ res, params }) => sendJson(res, 200, await readCycleDetail(config.toolsDir, requireParam(params, 'cycleId'))) },
    {
      method: 'GET',
      pattern: ENDPOINTS.governance.path,
      handler: async ({ res, query }) =>
        sendJson(res, 200, await readGovernance(config.toolsDir, { limit: clampLimit(query, DEFAULT_LIMIT, MAX_LIMIT), since: param(query, 'since'), event: param(query, 'event') })),
    },
    { method: 'GET', pattern: ENDPOINTS.governanceStream.path, handler: ({ req, res }) => streamGovernance(resolveInside(config.toolsDir, LEDGER_SOURCES.governance), req, res) },
    {
      method: 'GET',
      pattern: ENDPOINTS.findings.path,
      handler: async ({ res, query }) =>
        sendJson(res, 200, await readFindings(config.toolsDir, { limit: clampLimit(query, DEFAULT_LIMIT, MAX_LIMIT), severity: param(query, 'severity'), status: param(query, 'status'), tool: param(query, 'tool') })),
    },
    { method: 'GET', pattern: ENDPOINTS.beliefs.path, handler: async ({ res, query }) => sendJson(res, 200, await readBeliefs(config.toolsDir, { status: param(query, 'status'), limit: clampLimit(query, DEFAULT_LIMIT, MAX_LIMIT) })) },
    { method: 'GET', pattern: ENDPOINTS.pressures.path, handler: async ({ res, query }) => sendJson(res, 200, await readPressures(config.toolsDir, clampLimit(query, DEFAULT_LIMIT, MAX_LIMIT))) },
    { method: 'GET', pattern: ENDPOINTS.humanRequired.path, handler: async ({ res }) => sendJson(res, 200, await readHumanRequired(config.toolsDir)) },
    { method: 'GET', pattern: ENDPOINTS.agentRequests.path, handler: async ({ res, query }) => sendJson(res, 200, await readAgentRequests(config.toolsDir, { state: param(query, 'state'), limit: clampLimit(query, DEFAULT_LIMIT, MAX_LIMIT) })) },
    { method: 'GET', pattern: ENDPOINTS.plans.path, handler: async ({ res, query }) => sendJson(res, 200, await readPlans(config.toolsDir, clampLimit(query, DEFAULT_LIMIT, MAX_LIMIT))) },
    { method: 'GET', pattern: ENDPOINTS.tools.path, handler: async ({ res }) => sendJson(res, 200, await readTools(config.toolsDir)) },
    { method: 'GET', pattern: ENDPOINTS.reportsDaily.path, handler: async ({ res }) => sendJson(res, 200, await listDailyReports(config.toolsDir)) },
    { method: 'GET', pattern: ENDPOINTS.reportDaily.path, handler: async ({ res, params }) => sendJson(res, 200, await readDailyReport(config.toolsDir, requireParam(params, 'date'))) },
    { method: 'GET', pattern: ENDPOINTS.ledgers.path, handler: async ({ res }) => sendJson(res, 200, await readLedgers(config.toolsDir)) },
    { method: 'POST', pattern: ENDPOINTS.actionIntegrityVerify.path, handler: async ({ res }) => sendJson(res, 200, await integrityVerify(config)) },
    { method: 'POST', pattern: ENDPOINTS.actionDoctor.path, handler: async ({ res }) => sendJson(res, 200, await doctor(config)) },
    {
      method: 'POST',
      pattern: ENDPOINTS.actionControl.path,
      handler: async ({ req, res, principal }) => {
        requireGate(config, principal, KERNEL_CONTROL_ACTION_CLASS);
        const body = await readJsonBody(req);
        sendJson(res, 200, await control(config, String(body['verb'] ?? ''), String(body['reason'] ?? '')));
      },
    },
    {
      method: 'POST',
      pattern: ENDPOINTS.actionCycle.path,
      handler: async ({ req, res, principal }) => {
        requireGate(config, principal, KERNEL_CONTROL_ACTION_CLASS);
        const body = await readJsonBody(req);
        const cycleId = typeof body['cycleId'] === 'string' ? body['cycleId'] : undefined;
        sendJson(res, 202, jobs.startCycle(config, cycleId, body['discoveryOnly'] === true));
      },
    },
    { method: 'GET', pattern: ENDPOINTS.job.path, handler: async ({ res, params }) => sendJson(res, 200, jobs.get(requireParam(params, 'jobId'))) },
    { method: 'GET', pattern: LEGAL_ENDPOINTS.cases.path, handler: async ({ res }) => sendJson(res, 200, await listCases(config.toolsDir)) },
    { method: 'GET', pattern: LEGAL_ENDPOINTS.case.path, handler: async ({ res, params }) => sendJson(res, 200, await readCase(config.toolsDir, requireParam(params, 'caseId'))) },
    {
      method: 'GET',
      pattern: LEGAL_ENDPOINTS.documents.path,
      handler: async ({ res, params, query }) =>
        sendJson(res, 200, await readDocuments(config.toolsDir, requireParam(params, 'caseId'), { kind: param(query, 'kind'), extraction: param(query, 'extraction'), limit: clampLimit(query, MAX_LIMIT, MAX_LIMIT) })),
    },
    { method: 'GET', pattern: LEGAL_ENDPOINTS.document.path, handler: async ({ res, params }) => sendJson(res, 200, await readDocument(config.toolsDir, requireParam(params, 'caseId'), requireParam(params, 'documentId'))) },
    { method: 'GET', pattern: LEGAL_ENDPOINTS.timeline.path, handler: async ({ res, params }) => sendJson(res, 200, await readTimeline(config.toolsDir, requireParam(params, 'caseId'))) },
    { method: 'GET', pattern: LEGAL_ENDPOINTS.parties.path, handler: async ({ res, params }) => sendJson(res, 200, await readParties(config.toolsDir, requireParam(params, 'caseId'))) },
    {
      method: 'GET',
      pattern: LEGAL_ENDPOINTS.statements.path,
      handler: async ({ res, params, query }) => {
        const review = param(query, 'humanReview');
        sendJson(res, 200, await readStatements(config.toolsDir, requireParam(params, 'caseId'), { status: param(query, 'status'), humanReview: review === null ? null : review === 'true' }));
      },
    },
    { method: 'GET', pattern: LEGAL_ENDPOINTS.coverage.path, handler: async ({ res, params }) => sendJson(res, 200, await readCoverage(config.toolsDir, requireParam(params, 'caseId'))) },
    {
      method: 'GET',
      pattern: LEGAL_ENDPOINTS.intake.path,
      handler: async ({ res, params }) => {
        const caseId = requireParam(params, 'caseId');
        const intake = await readIntakeLedger(config.legalCasesDir, caseId);
        const body: LegalIntakeResponse = {
          caseMeta: await readCaseMeta(config.legalCasesDir, caseId),
          intake,
          // Verified on every read, not on a schedule: the answer to "was this
          // receipt edited?" must be current at the moment it is asked. Chain,
          // every row's signature, then the signed head commitment.
          chain: verifyIntakeChain(intake, await readIntakeHead(config.legalCasesDir, caseId), readiness.signer),
        };
        sendJson(res, 200, body);
      },
    },
    {
      method: 'POST',
      pattern: LEGAL_ENDPOINTS.createCase.path,
      handler: async ({ req, res, principal }) => {
        requireGate(config, principal, 'case_intake');
        const body = await readJsonBody(req);
        const created = await createCase(
          config.legalCasesDir,
          {
            caseId: requireString(body, 'caseId'),
            title: requireString(body, 'title'),
            jurisdiction: optionalString(body, 'jurisdiction'),
            courtReference: optionalString(body, 'courtReference'),
            custodian: requireString(body, 'custodian'),
            createdBy: principal.id,
          },
          new Date().toISOString(),
        );
        const response: LegalCaseCreatedResponse = { caseMeta: created };
        sendJson(res, 201, response);
      },
    },
    {
      method: 'POST',
      pattern: LEGAL_ENDPOINTS.uploadDocument.path,
      handler: async ({ req, res, params, principal }) => {
        requireGate(config, principal, 'case_intake');
        const sourceNote = singleHeader(req, LEGAL_UPLOAD_SOURCE_HEADER);
        const outcome = await uploadDocument(req, {
          casesDir: config.legalCasesDir,
          caseId: requireParam(params, 'caseId'),
          fileName: decodeFileNameHeader(singleHeader(req, LEGAL_UPLOAD_FILE_NAME_HEADER)),
          receivedBy: principal.id,
          sourceNote: sourceNote === undefined || sourceNote.trim() === '' ? null : sourceNote.trim().slice(0, 500),
          maxBytes: config.maxUploadBytes,
          now: new Date().toISOString(),
          signer: readiness.signer,
        });
        const response: LegalUploadResponse = outcome;
        sendJson(res, outcome.duplicate ? 200 : 201, response);
      },
    },
    {
      method: 'POST',
      pattern: LEGAL_ENDPOINTS.runInventory.path,
      handler: async ({ req, res, params, principal }) => {
        requireGate(config, principal, 'corpus_inventory');
        const caseId = requireParam(params, 'caseId');
        if ((await readCaseMeta(config.legalCasesDir, caseId)) === null) throw new HttpError(404, 'case_not_found', caseId);
        // Refused here, with the kernel's reason, rather than spawning a run
        // that would die inside the kernel with `tool not found`.
        requireLegalAdapter(await readLegalReadiness(config, readiness.boot));
        const body = await readJsonBody(req);
        // The receipt goes to the run with its digests, so the adapter can
        // reconcile the archive against it, not merely date its records.
        const intake = (await readIntakeLedger(config.legalCasesDir, caseId)).map((row) => ({ relativePath: row.relativePath, receivedAt: row.receivedAt, sha256: row.sha256 }));
        sendJson(
          res,
          202,
          jobs.startLegalInventory(config, {
            caseId,
            archiveRoot: archiveRunRoot(config.workspaceRoot, config.legalCasesDir, caseId),
            title: optionalString(body, 'title'),
            intake,
            excludeRoots: config.instancePolicy === null ? [] : config.instancePolicy.corpusExcludeRoots,
          }),
        );
      },
    },
  ];
  return routes.map(compileRoute);
}
