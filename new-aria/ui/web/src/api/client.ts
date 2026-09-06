// Typed client: one function per ARIA core endpoint, returning the contract type.
//
// WHY: pages must never assemble URLs or guess response shapes; the contract's
// ENDPOINTS table is the single source for both. Query params are limited to the
// ones each endpoint declares.
// WHAT: thin wrappers over requestJson bound to ENDPOINTS[*].path.
import {
  ENDPOINTS,
  type ActionRequestControl,
  type ActionRequestCycle,
  type ActionResponse,
  type AgentRequestsResponse,
  type BeliefsResponse,
  type CycleDetailResponse,
  type CyclesResponse,
  type DailyReportResponse,
  type DailyReportsResponse,
  type FindingsResponse,
  type GovernanceResponse,
  type HealthResponse,
  type WhoAmIResponse,
  type HumanRequiredResponse,
  type JobResponse,
  type LedgersResponse,
  type OverviewResponse,
  type PlansResponse,
  type PressuresResponse,
  type ToolsResponse,
} from '../../../shared/api-contract.ts';
import { requestJson, type Transport, defaultTransport } from './http.ts';
import { fillPath, withQuery } from './query.ts';

export interface LimitQuery {
  readonly limit?: number | undefined;
}
export interface GovernanceQuery extends LimitQuery {
  readonly since?: string | undefined;
  readonly event?: string | undefined;
}
export interface FindingsQuery extends LimitQuery {
  readonly severity?: string | undefined;
  readonly status?: string | undefined;
  readonly tool?: string | undefined;
}
export interface BeliefsQuery extends LimitQuery {
  readonly status?: string | undefined;
}
export interface AgentRequestsQuery extends LimitQuery {
  readonly state?: string | undefined;
}

export function getHealth(transport: Transport = defaultTransport): Promise<HealthResponse> {
  return requestJson<HealthResponse>(ENDPOINTS.health.path, {}, transport);
}

/** The authenticated principal and its per-class permissions; the SPA shows a control only when this says it may be used. */
export function getMe(signal?: AbortSignal): Promise<WhoAmIResponse> {
  return requestJson<WhoAmIResponse>(ENDPOINTS.me.path, { signal });
}

export function getOverview(signal?: AbortSignal): Promise<OverviewResponse> {
  return requestJson<OverviewResponse>(ENDPOINTS.overview.path, { signal });
}

export function getCycles(query: LimitQuery = {}, signal?: AbortSignal): Promise<CyclesResponse> {
  return requestJson<CyclesResponse>(withQuery(ENDPOINTS.cycles.path, { limit: query.limit }), { signal });
}

export function getCycle(cycleId: string, signal?: AbortSignal): Promise<CycleDetailResponse> {
  return requestJson<CycleDetailResponse>(fillPath(ENDPOINTS.cycle.path, { cycleId }), { signal });
}

export function getGovernance(query: GovernanceQuery = {}, signal?: AbortSignal): Promise<GovernanceResponse> {
  return requestJson<GovernanceResponse>(
    withQuery(ENDPOINTS.governance.path, { limit: query.limit, since: query.since, event: query.event }),
    { signal },
  );
}

export function getFindings(query: FindingsQuery = {}, signal?: AbortSignal): Promise<FindingsResponse> {
  return requestJson<FindingsResponse>(
    withQuery(ENDPOINTS.findings.path, {
      limit: query.limit,
      severity: query.severity,
      status: query.status,
      tool: query.tool,
    }),
    { signal },
  );
}

export function getBeliefs(query: BeliefsQuery = {}, signal?: AbortSignal): Promise<BeliefsResponse> {
  return requestJson<BeliefsResponse>(withQuery(ENDPOINTS.beliefs.path, { status: query.status, limit: query.limit }), {
    signal,
  });
}

export function getPressures(query: LimitQuery = {}, signal?: AbortSignal): Promise<PressuresResponse> {
  return requestJson<PressuresResponse>(withQuery(ENDPOINTS.pressures.path, { limit: query.limit }), { signal });
}

export function getHumanRequired(signal?: AbortSignal): Promise<HumanRequiredResponse> {
  return requestJson<HumanRequiredResponse>(ENDPOINTS.humanRequired.path, { signal });
}

export function getAgentRequests(query: AgentRequestsQuery = {}, signal?: AbortSignal): Promise<AgentRequestsResponse> {
  return requestJson<AgentRequestsResponse>(
    withQuery(ENDPOINTS.agentRequests.path, { state: query.state, limit: query.limit }),
    { signal },
  );
}

export function getPlans(query: LimitQuery = {}, signal?: AbortSignal): Promise<PlansResponse> {
  return requestJson<PlansResponse>(withQuery(ENDPOINTS.plans.path, { limit: query.limit }), { signal });
}

export function getTools(signal?: AbortSignal): Promise<ToolsResponse> {
  return requestJson<ToolsResponse>(ENDPOINTS.tools.path, { signal });
}

export function getDailyReports(signal?: AbortSignal): Promise<DailyReportsResponse> {
  return requestJson<DailyReportsResponse>(ENDPOINTS.reportsDaily.path, { signal });
}

export function getDailyReport(date: string, signal?: AbortSignal): Promise<DailyReportResponse> {
  return requestJson<DailyReportResponse>(fillPath(ENDPOINTS.reportDaily.path, { date }), { signal });
}

export function getLedgers(signal?: AbortSignal): Promise<LedgersResponse> {
  return requestJson<LedgersResponse>(ENDPOINTS.ledgers.path, { signal });
}

export function postIntegrityVerify(): Promise<ActionResponse> {
  return requestJson<ActionResponse>(ENDPOINTS.actionIntegrityVerify.path, { method: 'POST', body: {} });
}

export function postDoctor(): Promise<ActionResponse> {
  return requestJson<ActionResponse>(ENDPOINTS.actionDoctor.path, { method: 'POST', body: {} });
}

export function postControl(body: ActionRequestControl): Promise<ActionResponse> {
  return requestJson<ActionResponse>(ENDPOINTS.actionControl.path, { method: 'POST', body });
}

export function postCycle(body: ActionRequestCycle): Promise<JobResponse> {
  return requestJson<JobResponse>(ENDPOINTS.actionCycle.path, { method: 'POST', body });
}

export function getJob(jobId: string, signal?: AbortSignal): Promise<JobResponse> {
  return requestJson<JobResponse>(fillPath(ENDPOINTS.job.path, { jobId }), { signal });
}

/**
 * Proves a candidate token against the current identity endpoint WITHOUT storing it, so
 * the login screen only persists tokens the server actually accepted.
 */
export function validateToken(candidate: string): Promise<WhoAmIResponse> {
  return requestJson<WhoAmIResponse>(
    ENDPOINTS.me.path,
    {},
    { fetchImpl: defaultTransport.fetchImpl, tokenProvider: () => candidate },
  );
}
