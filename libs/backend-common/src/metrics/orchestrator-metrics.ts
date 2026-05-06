/**
 * OrchestratorMetrics — Phase 12.3 of
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md.
 *
 * Prometheus metric definitions for the agent-review orchestrator.
 * This file is the authoritative SSoT for metric names + labels +
 * bucket boundaries. Any consumer that emits these metrics imports
 * from here — never declares its own `new Counter({name: "agent_..."})`
 * ad-hoc.
 *
 * # Why an authoritative file
 *
 * Prometheus labels have cardinality discipline: high-cardinality
 * labels (user_id, tenant_id, request_id) explode the metric series
 * count and OOM the scrape target + break Grafana panel queries.
 * The `no-high-cardinality-metric-label` ESLint rule (Phase 2.4)
 * catches direct `new Counter` declarations that violate this rule;
 * routing all agent-system metrics through this module makes the
 * cardinality contract obvious at the definition site.
 *
 * Labels here were chosen with explicit cardinality budgets:
 *
 *   - agent           : bounded by the runtime roster (~35 agents).
 *   - mode            : { review | teach | implement } — cardinality 3.
 *   - severity        : { CRITICAL | HIGH | MEDIUM | LOW } — cardinality 4.
 *   - model           : { claude-opus-4-7 | claude-sonnet-4-6 |
 *                         claude-haiku-4-5 | ... } — ≤10.
 *   - cycle_id        : NOT on counters (unbounded!). Only on ephemeral
 *                       gauges that get set then zeroed; the in-flight
 *                       gauge is the sole cycle_id consumer.
 *   - leader_pod_id   : bounded by replica count (~3-5 pods); only
 *                       on the single orchestrator_leader_pod_id
 *                       gauge, never on counters.
 *
 * `tenant_id` is explicitly BANNED as a label on any metric in this
 * module — agent-system telemetry is reviewer-perspective, not
 * tenant-perspective. Per-tenant cost attribution lives in the
 * separate `observability.tenant_cost_rollup` TimescaleDB table,
 * where the unbounded tenant_id cardinality is accepted
 * (hypertables handle it; Prometheus does not).
 *
 * # Status of the cost-rollup wiring (TENANTCOST-LOW-001)
 *
 * The `tenant_cost_rollup` schema migration has landed
 * (`1805000000000-AddTenantCostRollup.ts`) but the per-tenant
 * cost-rollup PIPELINE that populates it is wiring-deferred —
 * see TENANTCOST-CRITICAL-001 for the multi-skill DAG that
 * lands the producer side. Until that finding closes, the
 * `tenant_id`-banned-from-orchestrator-metrics rule is the
 * complete story; the rollup table exists but is unwired, so
 * pointing readers at it as the alternative for per-tenant
 * cost views is misleading. The cite stays here as a
 * forward-reference — when TENANTCOST-CRITICAL-001 lands the
 * comment's status section gets removed and the rollup
 * becomes the canonical alternative as designed.
 *
 * # Registration pattern
 *
 * Each metric is created with `registers: []` — empty array — so
 * the caller decides which Registry to attach to. Typical use:
 *
 *   const registry = new client.Registry();
 *   registry.registerMetric(agentDispatchTotal);
 *   registry.registerMetric(reviewCycleDurationSeconds);
 *   ...
 *
 *   @Get('/metrics')
 *   async metrics() {
 *     return registry.metrics();
 *   }
 *
 * This avoids the global-default-registry pitfall where test suites
 * fail on duplicate-metric-name registration.
 *
 * # Phase 12.3 wiring scope
 *
 * This file declares the metrics. Wiring consumers into them
 * (orchestrator-runner calling agentDispatchTotal.inc(), Claude-SDK
 * wrapper calling claudeApiCallTotal.inc(), etc.) is follow-up work
 * in Phase 12.3. The contract lands first so downstream consumers
 * have a stable API.
 */

import { Counter, Gauge, Histogram } from 'prom-client';

// ---------- Counters ------------------------------------------------------

/**
 * Total number of sub-agent dispatches the orchestrator issued.
 * Incremented once per Agent(...) call in the dispatch loop.
 */
export const agentDispatchTotal = new Counter({
  name: 'agent_dispatch_total',
  help: 'Total sub-agent dispatches issued by the orchestrator.',
  labelNames: ['agent', 'mode'] as const,
  registers: [],
});

/**
 * Total findings issued by sub-agents, faceted by severity + owner.
 * Incremented at finding-registry add-time (the append that transitions
 * state to OPEN). Does NOT count state transitions — those are tracked
 * separately so the OPEN/RESOLVED ratio stays observable.
 */
export const agentFindingIssuedTotal = new Counter({
  name: 'agent_finding_issued_total',
  help: 'Findings appended to the finding registry.',
  labelNames: ['severity', 'agent'] as const,
  registers: [],
});

/**
 * Finding state transitions (OPEN → IN-PROGRESS → RESOLVED | STALE |
 * BLOCKED). Used for Phase 6 state-sweep observability.
 */
export const agentFindingStateTransitionTotal = new Counter({
  name: 'agent_finding_state_transition_total',
  help: 'Finding state transitions recorded in the registry.',
  labelNames: ['from_state', 'to_state', 'severity'] as const,
  registers: [],
});

/**
 * Total Claude API calls, faceted by model. Emitted by the Claude SDK
 * wrapper (apps/ai-service/src/agent/agent-runner.service.ts + the
 * orchestrator-side wrapper when it lands in Phase 12.4). Combined
 * with claudeApiLatencySeconds this gives us a per-model p99 panel.
 */
export const claudeApiCallTotal = new Counter({
  name: 'claude_api_call_total',
  help: 'Total Claude API calls issued by the orchestrator + agents.',
  labelNames: ['model'] as const,
  registers: [],
});

/**
 * Total 429 rate-limit hits. Triggers the emergency-stop policy in
 * Phase 12.4 when the rolling-window rate exceeds threshold.
 */
export const claudeApiRateLimitHitTotal = new Counter({
  name: 'claude_api_rate_limit_hit_total',
  help: 'Claude API 429 rate-limit responses received.',
  labelNames: ['model'] as const,
  registers: [],
});

// ---------- Histograms ----------------------------------------------------

/**
 * Review cycle duration — wall-clock seconds from dispatch to
 * unified-report write. Bucket boundaries tuned for typical cycles
 * (30s short cycles to 1 hour full-platform audits).
 */
export const reviewCycleDurationSeconds = new Histogram({
  name: 'review_cycle_duration_seconds',
  help: 'Wall-clock duration of a complete orchestrator review cycle.',
  labelNames: ['mode'] as const,
  buckets: [10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
  registers: [],
});

/**
 * Per-agent dispatch latency — wall-clock seconds from Agent(...)
 * call to agent's report return. Flags slow agents before they
 * dominate cycle duration.
 */
export const agentDispatchLatencySeconds = new Histogram({
  name: 'agent_dispatch_latency_seconds',
  help: 'Wall-clock duration of a single sub-agent dispatch.',
  labelNames: ['agent'] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  registers: [],
});

/**
 * Claude API call latency — per-request wall clock. Bucket
 * boundaries span fast classifier calls (100ms) to long streaming
 * Opus responses (120s).
 */
export const claudeApiLatencySeconds = new Histogram({
  name: 'claude_api_latency_seconds',
  help: 'Claude API request latency.',
  labelNames: ['model'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [],
});

// ---------- Gauges --------------------------------------------------------

/**
 * Number of orchestrator cycles currently in flight. Emitted ONLY
 * by the leader pod (gated on LeaderElectionService.isLeader()) to
 * avoid triple-counting across K8s replicas.
 */
export const orchestratorCycleInFlight = new Gauge({
  name: 'orchestrator_cycle_in_flight',
  help: 'Number of orchestrator review cycles currently in flight.',
  labelNames: [] as const,
  registers: [],
});

/**
 * Current leader pod identity. Sidecar gauge with `pod_id` label
 * set to the leader's identifier. Exactly ONE time-series at any
 * moment (the current leader) plus zero-valued series for former
 * leaders (bounded by replica count). Dashboard queries `max(
 * orchestrator_leader_pod_id) by (pod_id)` to surface the live
 * leader.
 */
export const orchestratorLeaderPodId = new Gauge({
  name: 'orchestrator_leader_pod_id',
  help: 'Identity of the current orchestrator leader pod (value = 1 for leader, 0 for non-leader).',
  labelNames: ['pod_id'] as const,
  registers: [],
});

/**
 * Claude API dispatch budget remaining for the current cycle —
 * Phase 12.4 Claude API 429 backpressure primitive. Set at cycle
 * start to the allotted token count; decremented by each dispatch's
 * estimated_cost_before_call.
 */
export const orchestratorCycleBudgetRemainingTokens = new Gauge({
  name: 'orchestrator_cycle_budget_remaining_tokens',
  help: 'Remaining Claude API token budget for the current review cycle.',
  labelNames: ['model'] as const,
  registers: [],
});

// ---------- Bulk registration helper --------------------------------------

/**
 * Array of all metrics in this module. Convenience for registries:
 *
 *   for (const m of ORCHESTRATOR_METRICS) registry.registerMetric(m);
 *
 * Keeping this list authoritative means adding a new metric requires
 * extending the array — missing an export from this tuple is a
 * lint-eligible class (a metric declared but never registered goes
 * to /dev/null).
 */
export const ORCHESTRATOR_METRICS = [
  agentDispatchTotal,
  agentFindingIssuedTotal,
  agentFindingStateTransitionTotal,
  claudeApiCallTotal,
  claudeApiRateLimitHitTotal,
  reviewCycleDurationSeconds,
  agentDispatchLatencySeconds,
  claudeApiLatencySeconds,
  orchestratorCycleInFlight,
  orchestratorLeaderPodId,
  orchestratorCycleBudgetRemainingTokens,
] as const;
