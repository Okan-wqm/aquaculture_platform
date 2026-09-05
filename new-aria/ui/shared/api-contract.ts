// new-aria operator console — HTTP API contract shared by ui/server and ui/web.
//
// WHY: the console is two independently built halves (a Node service that reads
// ARIA's ledgers and a React SPA). One typed contract keeps them from drifting:
// every endpoint, every response shape and every auth rule is declared here and
// imported by both sides. Nothing here re-implements kernel semantics — hash
// chains, profiles, lifecycle rules stay owned by aria-kernel; the console only
// PROJECTS what the ledgers already say and delegates every mutation to the
// kernel CLI.
//
// WHAT: path constants, request/response types, and the ledger sources each
// endpoint is allowed to read. Ledger relative paths are those declared in
// aria-kernel/aria_kernel/state_manifest.py (the SSoT); the server resolves
// them under ARIA_TOOLS_DIR and never invents a path of its own.

export const API_PREFIX = '/api/v1' as const;

/** Header carrying the operator token (env ARIA_UI_TOKEN on the server). */
export const AUTH_HEADER = 'authorization' as const;
export const AUTH_SCHEME = 'Bearer' as const;

/** Endpoints that answer without a token. Everything else requires it. */
export const PUBLIC_PATHS = [`${API_PREFIX}/health`] as const;

/** Row-tail caps: a ledger view never streams a whole multi-MB file to a browser. */
export const DEFAULT_LIMIT = 100 as const;
export const MAX_LIMIT = 1000 as const;

// ---------------------------------------------------------------------------
// Endpoint catalogue. Method + path template + response type name.
// Path params use `:name`. Query params are documented per entry.
// ---------------------------------------------------------------------------
export const ENDPOINTS = {
  principalAdmin: { method: 'POST', path: `${API_PREFIX}/admin/principals`, response: 'PrincipalAdminResponse' },
  health: { method: 'GET', path: `${API_PREFIX}/health`, response: 'HealthResponse' },
  overview: { method: 'GET', path: `${API_PREFIX}/overview`, response: 'OverviewResponse' },
  cycles: { method: 'GET', path: `${API_PREFIX}/cycles`, response: 'CyclesResponse', query: ['limit'] },
  cycle: { method: 'GET', path: `${API_PREFIX}/cycles/:cycleId`, response: 'CycleDetailResponse' },
  governance: {
    method: 'GET',
    path: `${API_PREFIX}/governance`,
    response: 'GovernanceResponse',
    query: ['limit', 'since', 'event'],
  },
  /** text/event-stream; one `data:` JSON GovernanceRow per appended ledger row. */
  governanceStream: { method: 'GET', path: `${API_PREFIX}/governance/stream`, response: 'GovernanceRow' },
  findings: {
    method: 'GET',
    path: `${API_PREFIX}/findings`,
    response: 'FindingsResponse',
    query: ['limit', 'severity', 'status', 'tool'],
  },
  beliefs: { method: 'GET', path: `${API_PREFIX}/beliefs`, response: 'BeliefsResponse', query: ['status', 'limit'] },
  pressures: { method: 'GET', path: `${API_PREFIX}/pressures`, response: 'PressuresResponse', query: ['limit'] },
  humanRequired: { method: 'GET', path: `${API_PREFIX}/human-required`, response: 'HumanRequiredResponse' },
  agentRequests: {
    method: 'GET',
    path: `${API_PREFIX}/agents/requests`,
    response: 'AgentRequestsResponse',
    query: ['state', 'limit'],
  },
  plans: { method: 'GET', path: `${API_PREFIX}/plans`, response: 'PlansResponse', query: ['limit'] },
  tools: { method: 'GET', path: `${API_PREFIX}/tools`, response: 'ToolsResponse' },
  reportsDaily: { method: 'GET', path: `${API_PREFIX}/reports/daily`, response: 'DailyReportsResponse' },
  reportDaily: { method: 'GET', path: `${API_PREFIX}/reports/daily/:date`, response: 'DailyReportResponse' },
  ledgers: { method: 'GET', path: `${API_PREFIX}/ledgers`, response: 'LedgersResponse' },
  /** Runs `aria-kernel integrity verify` (read-only verification). */
  actionIntegrityVerify: {
    method: 'POST',
    path: `${API_PREFIX}/actions/integrity-verify`,
    response: 'ActionResponse',
  },
  /** `aria-kernel control pause|resume` — requires ARIA_UI_ALLOW_ACTIONS=1. */
  actionControl: { method: 'POST', path: `${API_PREFIX}/actions/control`, response: 'ActionResponse' },
  /** `aria-kernel doctor` — read-only organ check. */
  actionDoctor: { method: 'POST', path: `${API_PREFIX}/actions/doctor`, response: 'ActionResponse' },
  /** `aria-kernel cycle run` as a background job — requires ARIA_UI_ALLOW_ACTIONS=1. */
  actionCycle: { method: 'POST', path: `${API_PREFIX}/actions/cycle`, response: 'JobResponse' },
  job: { method: 'GET', path: `${API_PREFIX}/jobs/:jobId`, response: 'JobResponse' },
  /** Who the token authenticated, and which action classes that principal may perform. */
  me: { method: 'GET', path: `${API_PREFIX}/me`, response: 'WhoAmIResponse' },
} as const;

export type EndpointName = keyof typeof ENDPOINTS;

/** Every endpoint must declare its access boundary; additions fail typecheck until classified. */
export const ENDPOINT_ACCESS = {
  principalAdmin: 'instance_operator',
  health: 'public',
  me: 'principal',
  job: 'job_scope',
  overview: 'instance_operator',
  cycles: 'instance_operator',
  cycle: 'instance_operator',
  governance: 'instance_operator',
  governanceStream: 'instance_operator',
  findings: 'instance_operator',
  beliefs: 'instance_operator',
  pressures: 'instance_operator',
  humanRequired: 'instance_operator',
  agentRequests: 'instance_operator',
  plans: 'instance_operator',
  tools: 'instance_operator',
  reportsDaily: 'instance_operator',
  reportDaily: 'instance_operator',
  ledgers: 'instance_operator',
  actionIntegrityVerify: 'instance_operator',
  actionControl: 'instance_operator',
  actionDoctor: 'instance_operator',
  actionCycle: 'instance_operator',
} as const satisfies Record<EndpointName, 'public' | 'principal' | 'job_scope' | 'instance_operator'>;

export const KERNEL_READ_PERMISSION = 'kernel_read' as const;


// ---------------------------------------------------------------------------
// Ledger sources (relative to ARIA_TOOLS_DIR). Names are state_manifest
// surface names; the server must read the path from state_manifest.py or
// keep this table byte-equal to it (a test in ui/server asserts equality).
// ---------------------------------------------------------------------------
export const LEDGER_SOURCES = {
  cycles: 'cycles.jsonl',
  governance: 'governance.jsonl',
  runs: 'runs.jsonl',
  health: 'health.jsonl',
  raw_findings: 'raw-findings.jsonl',
  findings_feedback: 'findings.jsonl',
  memory_beliefs: 'memory/beliefs.jsonl',
  memory_contradictions: 'memory/contradictions.jsonl',
  memory_uncertainties: 'memory/uncertainties.jsonl',
  pressure_log: 'pressure/pressure-log.jsonl',
  triage_decisions: 'triage/decisions.jsonl',
  human_required_dir: 'human-required',
  human_required_adjudications: 'human-required/adjudications.jsonl',
  agent_requests: 'agent-invocations/requests.jsonl',
  agent_claims: 'agent-invocations/claims.jsonl',
  agent_results: 'agent-invocations/results.jsonl',
  tool_registry: 'registry.json',
  integrity_index: 'integrity_index.json',
  runtime_profile_state: 'runtime-profile.json',
  breakers_dir: 'breakers',
  budget_breaker_state: 'budget/breaker_state.json',
  control_commands: 'control/commands.jsonl',
  gateway_heartbeat: 'gateway/heartbeat.json',
  gateway_inbox: 'gateway/inbox.jsonl',
  gateway_schedules: 'gateway/schedules.jsonl',
  reports_daily_dir: 'reports/daily',
  discovery_dir: 'discovery',
  cycle_metrics_dir: 'cycle-metrics',
  plans_dir: 'plans',
  kill_switch: 'ARIA_STOP',
} as const;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** Every ledger row the kernel writes carries these chain fields. */
export interface LedgerRow {
  readonly at?: string;
  readonly schema_version?: number;
  readonly previous_ledger_hash?: string | null;
  readonly ledger_hash?: string;
  readonly [key: string]: unknown;
}

/**
 * The action class behind the console's kernel controls (cycle run, pause and
 * resume). It is the ONLY class `ARIA_UI_ALLOW_ACTIONS` and the instance
 * manifest's `runtime.allow_actions` govern; case work is governed by the
 * instance's approval policy per class.
 */
export const KERNEL_CONTROL_ACTION_CLASS = 'kernel_control' as const;

/** Whether a pack's adapter is registered with the kernel this console fronts. */
export type AdapterReadinessState = 'registered' | 'unregistered' | 'quarantined' | 'not_applicable';

export interface PackReadiness {
  readonly toolId: string;
  readonly adapter: AdapterReadinessState;
  /** Why the adapter is not registered, in the kernel's own words; null when it is. */
  readonly detail: string | null;
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'new-aria-ui';
  readonly version: string;
  readonly toolsDirPresent: boolean;
  /** Kernel control (cycle run, pause/resume) is enabled. Case actions are governed per class; see /me. */
  readonly actionsEnabled: boolean;
  /** The legal pack's adapter, as the kernel registry reports it right now. */
  readonly legal: PackReadiness;
  /**
   * The key this console signs its custody ledgers with. The public half is
   * published here so a client can verify a receipt without trusting the
   * console; null means no key is loaded and no receipt can be written.
   */
  readonly ledgerSigning: { readonly keyId: string; readonly publicKeyPem: string } | null;
  /** How this console names people: a principals file (per-person tokens, roles, case assignments) or one shared operator token. */
  readonly identity: 'principals_file' | 'shared_token';
  readonly generatedAt: string;
}

/** The authenticated principal and what it may do. Answered only with a valid token. */
export interface WhoAmIResponse {
  readonly principal: {
    readonly id: string;
    readonly displayName: string;
    readonly role: string;
    /** The cases this principal may see, or '*' for every case in the instance. */
    readonly cases: '*' | ReadonlyArray<string>;
  };
  /** Action class → whether THIS principal may perform it under the instance's policy. */
  readonly permissions: Readonly<Record<string, boolean>>;
}

export type RuntimeProfile = 'observe' | 'standard' | 'strict' | 'frozen' | 'autonomous';

export interface OverviewResponse {
  readonly generatedAt: string;
  readonly toolsDir: string;
  readonly workspaceRoot: string | null;
  readonly profile: {
    readonly current: RuntimeProfile | null;
    readonly schedulerCeiling: RuntimeProfile | null;
    readonly setBy: string | null;
    readonly setAt: string | null;
  };
  readonly killSwitch: { readonly engaged: boolean };
  readonly breakers: ReadonlyArray<{ readonly name: string; readonly state: string; readonly rows: number }>;
  readonly budget: { readonly tripped: boolean; readonly detail: Record<string, unknown> | null };
  readonly lastCycle: CycleSummary | null;
  readonly counts: {
    readonly cycles: number;
    readonly rawFindings: number;
    readonly beliefs: number;
    readonly pressures: number;
    readonly humanRequiredOpen: number;
    readonly agentRequests: number;
    readonly governanceRows: number;
  };
  readonly gateway: { readonly heartbeatAt: string | null; readonly inboxPending: number } | null;
}

export type CycleStatus = 'started' | 'completed' | 'failed' | 'stopped' | 'aborted';

export interface CycleSummary {
  readonly cycleId: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly status: CycleStatus | 'unknown';
  readonly durationSeconds: number | null;
  readonly gitHeadSha: string | null;
  readonly toolDecisionCount: number | null;
}

export interface CyclesResponse {
  readonly cycles: ReadonlyArray<CycleSummary>;
  readonly total: number;
}

export interface CycleDetailResponse {
  readonly cycle: CycleSummary;
  readonly discovery: {
    readonly completionProof: Record<string, unknown> | null;
    readonly repoFingerprint: Record<string, unknown> | null;
  };
  readonly metrics: Record<string, unknown> | null;
  readonly runs: ReadonlyArray<LedgerRow>;
  readonly governance: ReadonlyArray<GovernanceRow>;
}

export interface GovernanceRow extends LedgerRow {
  readonly event: string;
  readonly details?: Record<string, unknown>;
}

export interface GovernanceResponse {
  readonly rows: ReadonlyArray<GovernanceRow>;
  readonly total: number;
}

export type FindingSeverity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL' | 'CRITICAL';

export interface FindingView {
  readonly id: string;
  readonly toolId: string | null;
  readonly runId: string | null;
  readonly cycleId: string | null;
  readonly rule: string | null;
  readonly severity: string | null;
  readonly path: string | null;
  readonly line: number | null;
  readonly message: string | null;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly at: string | null;
  readonly feedback: 'true_positive' | 'false_positive' | null;
}

export interface FindingsResponse {
  readonly findings: ReadonlyArray<FindingView>;
  readonly total: number;
  readonly bySeverity: Record<string, number>;
}

export type BeliefStatus = 'supported' | 'contradicted' | 'needs_revalidation' | 'stale' | 'withdrawn';

export interface BeliefView {
  readonly beliefId: string;
  readonly statement: string | null;
  readonly status: BeliefStatus | string;
  readonly confidence: number | null;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly verifiedAt: string | null;
  readonly cycleId: string | null;
}

export interface BeliefsResponse {
  readonly beliefs: ReadonlyArray<BeliefView>;
  readonly byStatus: Record<string, number>;
  readonly contradictions: number;
  readonly uncertainties: number;
}

export interface PressureView {
  readonly pressureId: string;
  readonly source: string | null;
  readonly score: number | null;
  readonly state: string | null;
  readonly occurrenceCount: number | null;
  readonly summary: string | null;
  readonly cycleId: string | null;
  readonly at: string | null;
}

export interface PressuresResponse {
  readonly pressures: ReadonlyArray<PressureView>;
  readonly total: number;
}

export interface HumanRequiredItem {
  readonly requestId: string;
  readonly severity: string;
  readonly reason: string;
  readonly recordedAt: string | null;
  readonly slaDeadline: string | null;
  readonly slaBreached: boolean;
  readonly resolved: boolean;
  readonly context: Record<string, unknown>;
}

export interface HumanRequiredResponse {
  readonly items: ReadonlyArray<HumanRequiredItem>;
  readonly open: number;
}

export type AgentRequestState = 'pending' | 'claimed' | 'submitted' | 'accepted' | 'rejected' | 'expired' | 'unknown';

export interface AgentRequestView {
  readonly requestId: string;
  readonly cycleId: string | null;
  readonly role: string | null;
  readonly targetAgent: string | null;
  readonly state: AgentRequestState;
  readonly createdAt: string | null;
  readonly claimedAt: string | null;
  readonly submittedAt: string | null;
  readonly resultStatus: string | null;
}

export interface AgentRequestsResponse {
  readonly requests: ReadonlyArray<AgentRequestView>;
  readonly byState: Record<string, number>;
}

export interface PlanView {
  readonly planId: string;
  readonly state: string;
  readonly round: number | null;
  readonly pressureEventId: string | null;
  readonly updatedAt: string | null;
  readonly terminalState: string | null;
}

export interface PlansResponse {
  readonly plans: ReadonlyArray<PlanView>;
  readonly byState: Record<string, number>;
}

export interface ToolView {
  readonly toolId: string;
  readonly kind: string | null;
  readonly status: string;
  readonly version: string | null;
  readonly declaredScope: ReadonlyArray<string>;
  readonly lastRunAt: string | null;
  readonly lastRunStatus: string | null;
  readonly runCount: number;
}

export interface ToolsResponse {
  readonly tools: ReadonlyArray<ToolView>;
}

export interface DailyReportMeta {
  readonly date: string;
  readonly bytes: number;
}

export interface DailyReportsResponse {
  readonly reports: ReadonlyArray<DailyReportMeta>;
}

export interface DailyReportResponse {
  readonly date: string;
  readonly markdown: string;
}

export interface LedgerSurfaceView {
  readonly name: string;
  readonly relativePath: string;
  readonly present: boolean;
  readonly rows: number | null;
  readonly bytes: number | null;
  readonly lastHash: string | null;
  readonly indexed: boolean;
}

export interface LedgersResponse {
  readonly surfaces: ReadonlyArray<LedgerSurfaceView>;
}

export interface ActionRequestControl {
  readonly verb: 'pause' | 'resume';
  readonly reason: string;
}

export interface ActionRequestCycle {
  readonly cycleId?: string;
  readonly discoveryOnly?: boolean;
}

export interface ActionResponse {
  readonly ok: boolean;
  readonly command: ReadonlyArray<string>;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly parsed: unknown;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

/**
 * What a tracked job was started to do. Every kind is a kernel CLI call the
 * console spawned; the console runs nothing of its own.
 */
export const JOB_KINDS = ['cycle', 'legal-inventory'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobResponse {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly state: JobState;
  readonly command: ReadonlyArray<string>;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface ApiError {
  readonly error: string;
  readonly detail?: string;
}
