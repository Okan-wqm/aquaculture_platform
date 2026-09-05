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
// Every case-scoped route sits behind the MATTER WALL: a principal sees only
// the cases assigned to it, and a case outside that assignment reads as 404,
// never as "exists but forbidden". Every case-scoped request is written to the
// case's signed access ledger BEFORE it is answered.
//
// WHAT: builds the compiled route list the server dispatches on.

import type { IncomingMessage } from 'node:http';

import type { HealthResponse, WhoAmIResponse } from '../../shared/api-contract.ts';
import { DEFAULT_LIMIT, ENDPOINTS, KERNEL_CONTROL_ACTION_CLASS, LEDGER_SOURCES, MAX_LIMIT } from '../../shared/api-contract.ts';
import type { LegalCaseCreatedResponse, LegalIntakeResponse, LegalUploadResponse } from '../../shared/legal-contract.ts';
import { LEGAL_ENDPOINTS, LEGAL_UPLOAD_FILE_NAME_HEADER, LEGAL_UPLOAD_SOURCE_HEADER } from '../../shared/legal-contract.ts';
import { recordAccess } from './access-log.ts';
import { control, doctor, integrityVerify, JobTable } from './actions.ts';
import type { ServerConfig } from './config.ts';
import { HttpError } from './errors.ts';
import { existsInside, resolveInside } from './fsafe.ts';
import { permissionsFor, requireGate } from './gates.ts';
import type { ConsoleActionClass } from './gates.ts';
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
import type { Principal } from './principal.ts';
import { canSeeCase } from './principals.ts';
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
import type { RequestContext, Route } from './router.ts';
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

/**
 * The matter wall. A case the principal is not assigned to does not exist for
 * that principal: 404, the same answer as for a case nobody created, so the
 * wall never confirms that another matter is there.
 */
function requireCaseAccess(principal: Principal, caseId: string): void {
  if (!canSeeCase(principal, caseId)) throw new HttpError(404, 'case_not_found', caseId);
}

/** What a case-scoped handler answers; the wrapper records the access, then sends it. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export function buildRoutes(config: ServerConfig, jobs: JobTable, readiness: LegalReadinessHolder): ReadonlyArray<ReturnType<typeof compileRoute>> {
  /**
   * A case-scoped route: behind the matter wall, optionally behind an action
   * class gate, and written to the case's signed access ledger BEFORE it is
   * answered — the way a receipt reaches the disk before an upload is
   * acknowledged. A refused request (a 404 on another matter, a 403 on a gate)
   * is recorded too: an attempt to read a client's file is worth knowing.
   * Without the ledger key the read is refused: an unrecorded read of a
   * client's file is the state the ledger exists to end.
   */
  const caseRoute = (
    method: Route['method'],
    pattern: string,
    actionClass: ConsoleActionClass | null,
    handler: (ctx: RequestContext & { readonly caseId: string }) => Promise<Answer>,
  ): Route => ({
    method,
    pattern,
    handler: async (ctx) => {
      const caseId = requireParam(ctx.params, 'caseId');
      if (readiness.signer === null) throw new HttpError(503, 'ledger_key_missing', readiness.signerDetail ?? 'the console holds no ledger key, so no access can be recorded');
      const signer = readiness.signer;
      let answer: Answer | null = null;
      let status = 500;
      try {
        requireCaseAccess(ctx.principal, caseId);
        if (actionClass !== null) requireGate(config, ctx.principal, actionClass);
        answer = await handler({ ...ctx, caseId });
        status = answer.status;
      } catch (error) {
        status = error instanceof HttpError ? error.status : 500;
        throw error;
      } finally {
        // A case that does not exist at all has no ledger to write.
        if ((await readCaseMeta(config.legalCasesDir, caseId)) !== null) {
          await recordAccess(config.legalCasesDir, signer, {
            caseId,
            principalId: ctx.principal.id,
            role: ctx.principal.role,
            method,
            route: pattern,
            documentId: ctx.params['documentId'] ?? null,
            status,
            at: new Date().toISOString(),
          });
        }
      }
      if (answer !== null) sendJson(ctx.res, answer.status, answer.body);
    },
  });

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
          identity: readiness.principals === null ? 'shared_token' : 'principals_file',
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
          principal: { id: principal.id, displayName: principal.displayName, role: principal.role, cases: principal.cases },
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
    {
      method: 'GET',
      pattern: LEGAL_ENDPOINTS.cases.path,
      handler: async ({ res, principal }) => {
        // The list is the matter wall's first surface: a case the principal is
        // not assigned to is not listed.
        const all = await listCases(config.toolsDir);
        sendJson(res, 200, { cases: all.cases.filter((row) => canSeeCase(principal, row.caseId)) });
      },
    },
    caseRoute('GET', LEGAL_ENDPOINTS.case.path, null, async ({ caseId }) => ({ status: 200, body: await readCase(config.toolsDir, caseId) })),
    caseRoute('GET', LEGAL_ENDPOINTS.documents.path, null, async ({ caseId, query }) => ({
      status: 200,
      body: await readDocuments(config.toolsDir, caseId, { kind: param(query, 'kind'), extraction: param(query, 'extraction'), limit: clampLimit(query, MAX_LIMIT, MAX_LIMIT) }),
    })),
    caseRoute('GET', LEGAL_ENDPOINTS.document.path, null, async ({ caseId, params }) => ({ status: 200, body: await readDocument(config.toolsDir, caseId, requireParam(params, 'documentId')) })),
    caseRoute('GET', LEGAL_ENDPOINTS.timeline.path, null, async ({ caseId }) => ({ status: 200, body: await readTimeline(config.toolsDir, caseId) })),
    caseRoute('GET', LEGAL_ENDPOINTS.parties.path, null, async ({ caseId }) => ({ status: 200, body: await readParties(config.toolsDir, caseId) })),
    caseRoute('GET', LEGAL_ENDPOINTS.statements.path, null, async ({ caseId, query }) => {
      const review = param(query, 'humanReview');
      return { status: 200, body: await readStatements(config.toolsDir, caseId, { status: param(query, 'status'), humanReview: review === null ? null : review === 'true' }) };
    }),
    caseRoute('GET', LEGAL_ENDPOINTS.coverage.path, null, async ({ caseId }) => ({ status: 200, body: await readCoverage(config.toolsDir, caseId) })),
    caseRoute('GET', LEGAL_ENDPOINTS.intake.path, null, async ({ caseId }) => {
      const intake = await readIntakeLedger(config.legalCasesDir, caseId);
      const body: LegalIntakeResponse = {
        caseMeta: await readCaseMeta(config.legalCasesDir, caseId),
        intake,
        // Verified on every read, not on a schedule: the answer to "was this
        // receipt edited?" must be current at the moment it is asked. Chain,
        // every row's signature, then the signed head commitment.
        chain: verifyIntakeChain(intake, await readIntakeHead(config.legalCasesDir, caseId), readiness.signer),
      };
      return { status: 200, body };
    }),
    {
      method: 'POST',
      pattern: LEGAL_ENDPOINTS.createCase.path,
      handler: async ({ req, res, principal }) => {
        requireGate(config, principal, 'case_intake');
        const body = await readJsonBody(req);
        const caseId = requireString(body, 'caseId');
        // A principal assigned to named cases may only open one of those; an
        // assignment is made by the operator, not claimed by opening a case.
        if (!canSeeCase(principal, caseId)) throw new HttpError(403, 'case_not_assigned', `${principal.id} is not assigned to ${caseId}`);
        const created = await createCase(
          config.legalCasesDir,
          {
            caseId,
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
    caseRoute('POST', LEGAL_ENDPOINTS.uploadDocument.path, 'case_intake', async ({ req, caseId, principal }) => {
      const sourceNote = singleHeader(req, LEGAL_UPLOAD_SOURCE_HEADER);
      const outcome = await uploadDocument(req, {
        casesDir: config.legalCasesDir,
        caseId,
        fileName: decodeFileNameHeader(singleHeader(req, LEGAL_UPLOAD_FILE_NAME_HEADER)),
        receivedBy: principal.id,
        sourceNote: sourceNote === undefined || sourceNote.trim() === '' ? null : sourceNote.trim().slice(0, 500),
        maxBytes: config.maxUploadBytes,
        now: new Date().toISOString(),
        signer: readiness.signer,
      });
      const response: LegalUploadResponse = outcome;
      return { status: outcome.duplicate ? 200 : 201, body: response };
    }),
    caseRoute('POST', LEGAL_ENDPOINTS.runInventory.path, 'corpus_inventory', async ({ req, caseId }) => {
      if ((await readCaseMeta(config.legalCasesDir, caseId)) === null) throw new HttpError(404, 'case_not_found', caseId);
      // Refused here, with the kernel's reason, rather than spawning a run
      // that would die inside the kernel with `tool not found`.
      requireLegalAdapter(await readLegalReadiness(config, readiness.boot));
      const body = await readJsonBody(req);
      // The receipt goes to the run with its digests, so the adapter can
      // reconcile the archive against it, not merely date its records.
      const intake = (await readIntakeLedger(config.legalCasesDir, caseId)).map((row) => ({ relativePath: row.relativePath, receivedAt: row.receivedAt, sha256: row.sha256 }));
      return {
        status: 202,
        body: jobs.startLegalInventory(config, {
          caseId,
          archiveRoot: archiveRunRoot(config.workspaceRoot, config.legalCasesDir, caseId),
          title: optionalString(body, 'title'),
          intake,
          excludeRoots: config.instancePolicy === null ? [] : config.instancePolicy.corpusExcludeRoots,
        }),
      };
    }),
  ];
  return routes.map(compileRoute);
}
