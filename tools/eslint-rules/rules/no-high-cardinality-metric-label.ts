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
 *  - .claude/agents/observability-expert.md
 *    (bounded-cardinality section; "label cardinality bounded —
 *     user_id / request_id / IP as Prom labels = CRITICAL")
 *  - Prometheus best practices:
 *    https://prometheus.io/docs/practices/instrumentation/#do-not-overuse-labels
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

type MessageIds = 'unboundedCardinalityLabel';
type Options = [];

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/Okan-wqm/aquaculture_platform.git/blob/main/tools/eslint-rules/rules/${name}.ts`,
);

/**
 * Denylist of label names known to carry unbounded cardinality. Matched
 * case-insensitively against the literal string value of each array
 * element in a `labelNames: [...]` property. Both snake_case and
 * camelCase variants covered; an exact match is required (not a
 * substring) to avoid flagging safe labels that happen to CONTAIN a
 * denylisted word (e.g. `userid_bucket` would match a substring check
 * but is intentionally bucketed and bounded).
 */
const UNBOUNDED_LABELS = new Set([
  // Tenant / domain-entity identity (OBS-HIGH-001) — one series per distinct
  // tenant/farm/device, AND a tenant-enumeration leak on the unauthenticated
  // /metrics surface. A truncated prefix does NOT bound it (UUID prefixes do
  // not collide at platform scale). Per-tenant attribution belongs in
  // traces / a bounded plan_tier family, never a raw-id scrape label.
  'tenant',
  'tenantid',
  'tenant_id',
  'farmid',
  'farm_id',
  'deviceid',
  'device_id',
  'sensorid',
  'sensor_id',
  // User identity — bounded only by total user count, which is unbounded.
  'userid',
  'user_id',
  'user',
  'username',
  'email',
  // Per-request identifiers — cardinality grows 1:1 with request volume.
  'requestid',
  'request_id',
  'correlationid',
  'correlation_id',
  'traceid',
  'trace_id',
  'spanid',
  'span_id',
  // Session identifiers — one per login, grows with user activity.
  'sessionid',
  'session_id',
  // Network identifiers — unbounded over IPv4/IPv6 space.
  'ip',
  'clientip',
  'client_ip',
  'ipaddress',
  'ip_address',
  'remoteaddr',
  'remote_addr',
  // Raw URLs / queries — each distinct URL is a new series.
  'url',
  'fullurl',
  'full_url',
  'query',
  'queryparams',
  'query_params',
  // Generic UUIDs used as labels — ALWAYS unbounded by construction.
  'uuid',
  'guid',
  // Timestamps — effectively unique per event.
  'timestamp',
  'created_at',
  'createdat',
  // Error messages — free-form strings, unbounded.
  'error',
  'error_message',
  'errormessage',
  'message',
]);

export default createRule<Options, MessageIds>({
  name: 'no-high-cardinality-metric-label',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Prometheus `labelNames` must not contain unbounded-cardinality identifiers (user_id, request_id, IP, URL, etc.) — each distinct value creates a new time-series and blows up Prometheus storage.',
    },
    schema: [],
    messages: {
      unboundedCardinalityLabel:
        'Prometheus label "{{ label }}" has unbounded cardinality — each distinct value creates a new time-series. The observability-expert invariant classifies this as CRITICAL. For request-scoped attribution use structured logs (Loki) or traces (Tempo); for dimensioned metrics use bounded labels like status_code, method, route-template. Reference: docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Property(node: TSESTree.Property) {
        if (node.key.type !== 'Identifier' || node.key.name !== 'labelNames') return;
        if (node.value.type !== 'ArrayExpression') return;

        for (const element of node.value.elements) {
          if (!element) continue;
          if (element.type !== 'Literal' || typeof element.value !== 'string') continue;
          const normalised = element.value.toLowerCase();
          if (UNBOUNDED_LABELS.has(normalised)) {
            context.report({
              node: element,
              messageId: 'unboundedCardinalityLabel',
              data: { label: element.value },
            });
          }
        }
      },
    };
  },
});
