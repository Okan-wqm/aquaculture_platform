/**
 * no-high-cardinality-metric-label — enforces observability-expert's
 * bounded-label-cardinality invariant.
 *
 * Prometheus time-series cardinality explodes multiplicatively across
 * label values: for a metric with labels {a, b, c} of cardinalities
 * |A|, |B|, |C|, the series count is O(|A| × |B| × |C|). A label
 * whose value is unbounded per request (user_id, trace_id, IP,
 * full URL) can push a single metric to millions of series, blow up
 * Prometheus WAL, and OOM the remote-write pipeline. The observability-
 * expert invariant list classifies these as CRITICAL — catching them
 * at lint time is cheaper than at 3 AM during an incident.
 *
 * Rule mechanics:
 *   - Match `labelNames: [...string]` properties — the canonical
 *     prom-client constructor shape for Counter / Histogram / Gauge /
 *     Summary.
 *   - Each string element compared case-insensitively against an
 *     unbounded-cardinality denylist.
 *   - Snake_case and camelCase both covered (`user_id` AND `userId`).
 *
 * False-positive boundary:
 *   - `labelNames` is a narrow property name; outside of prom-client
 *     and the aquaculture labelled-metric wrappers no other code in
 *     the repo uses it. Skipping the "is this really a prom-client
 *     call?" AST-walk keeps the rule small and fast.
 *
 * Severity: "warn" for progressive rollout; promotes to "error" after
 * the observability-service adopts the rule's recommended label set.
 *
 * Refs:
 *  - docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2
 *  - .claude/agents-enterprise-v2/observability-expert.md
 *    (bounded-cardinality section; "label cardinality bounded —
 *     user_id / request_id / IP as Prom labels = CRITICAL")
 *  - Prometheus best practices:
 *    https://prometheus.io/docs/practices/instrumentation/#do-not-overuse-labels
 */
import { ESLintUtils } from '@typescript-eslint/utils';
declare const _default: ESLintUtils.RuleModule<"unboundedCardinalityLabel", [], ESLintUtils.RuleListener>;
export default _default;
//# sourceMappingURL=no-high-cardinality-metric-label.d.ts.map