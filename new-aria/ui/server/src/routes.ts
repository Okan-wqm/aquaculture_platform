// Route table — every contract endpoint bound to its reader or action.
//
// WHY: the contract (ui/shared/api-contract.ts + legal-contract.ts) is the single
// description of the API; binding by the contract's own path strings means a
// path typo here is a type error, not a 404 discovered in the browser.
// WHAT: builds the compiled route list the server dispatches on.

import type { HealthResponse } from '../../shared/api-contract.ts';
import { DEFAULT_LIMIT, ENDPOINTS, LEDGER_SOURCES, MAX_LIMIT } from '../../shared/api-contract.ts';
import { LEGAL_ENDPOINTS } from '../../shared/legal-contract.ts';
import { control, doctor, integrityVerify, JobTable } from './actions.ts';
import type { ServerConfig } from './config.ts';
import { existsInside, resolveInside } from './fsafe.ts';
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

export function buildRoutes(config: ServerConfig, jobs: JobTable): ReadonlyArray<ReturnType<typeof compileRoute>> {
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
          generatedAt: new Date().toISOString(),
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
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        sendJson(res, 200, await control(config, String(body['verb'] ?? ''), String(body['reason'] ?? '')));
      },
    },
    {
      method: 'POST',
      pattern: ENDPOINTS.actionCycle.path,
      handler: async ({ req, res }) => {
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
  ];
  return routes.map(compileRoute);
}
