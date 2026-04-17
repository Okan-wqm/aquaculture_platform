/**
 * no-direct-event-publish — enforces ADR-006 + data-expert's outbox-only
 * publish contract.
 *
 * Every event emission MUST go through `@platform/outbox`. A direct call
 * to `eventBus.publish(...)`, `natsClient.publish(...)`, or
 * `natsConnection.publish(...)` outside the outbox implementation is a
 * CRITICAL violation: it bypasses the transactional-outbox guarantee,
 * producing an at-most-once delivery path that desynchronises the
 * write-model from the event stream on network blips, service crashes,
 * or slow NATS reconnection. The DATA-HIGH-004 / BLOCKER-20 class
 * tracks this.
 *
 * Rule mechanics:
 *   - Target: CallExpression where
 *       callee.property.name === 'publish' AND
 *       callee.object is an Identifier / MemberExpression naming an
 *       event-bus / NATS handle.
 *   - Name match is case-sensitive against the established TypeScript
 *     convention (camelCase instance + PascalCase class).
 *   - Redis pub/sub (`redisClient.publish`), SSE / WebSocket
 *     (`sse.publish`), and NestJS `EventEmitter.emit` do NOT match —
 *     the rule is scoped to the event-bus + NATS surface.
 *
 * Exemptions:
 *   - `platform/libs/outbox/**` — the outbox worker + publisher are
 *     the CORRECT place for direct `natsClient.publish` (the whole
 *     contract this rule protects). File-path check is defence-in-
 *     depth alongside the ESLint config glob.
 *   - Test files (`*.spec.ts`, `*.test.ts`, `__tests__/**`, `*.e2e.ts`)
 *     — mocks routinely stub publish() to verify call shape.
 *
 * Progressive rollout: severity starts at `warn` per `.eslintrc.json`
 * convention; promotes to `error` after the 9-service outbox migration
 * sweep (farm/hr/messaging currently covered — 3/12 per DATA-HIGH-004).
 *
 * Refs:
 *  - docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2
 *  - docs/adr/006-event-contracts-flat-pattern.md
 *  - .claude/agents-enterprise-v2/data-expert.md#Event-contract-versioning
 *    (outbox-only publish path — DATA-HIGH-004)
 *  - platform/libs/outbox/src/outbox-worker.service.ts (canonical caller)
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

type MessageIds = 'directEventBusPublish' | 'directNatsClientPublish';
type Options = [];

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/Okan-wqm/aquaculture_platform/blob/main/tools/eslint-rules/rules/${name}.ts`,
);

/**
 * Identifier names that carry the event-bus surface. Case-sensitive —
 * the codebase consistently uses these exact spellings. A broader /.*bus$/i
 * match would false-positive on things like `messageBus` (messaging
 * service's internal queue abstraction) which is not the NATS event bus.
 */
const EVENT_BUS_HINTS = new Set(['eventBus', 'EventBus']);

/**
 * NATS-direct handle names. `nats` alone is deliberately NOT included —
 * too generic (matches `this.nats.config`, `nats.Codec`, import alias, etc).
 */
const NATS_HANDLE_HINTS = new Set([
  'natsClient',
  'NatsClient',
  'natsConnection',
  'NatsConnection',
  'natsConn',
  'NatsConn',
]);

/**
 * File-path prefix where direct publish IS the correct behaviour. The
 * outbox worker reads outbox rows and emits to NATS — that is the one
 * call site this rule is designed to permit.
 */
const OUTBOX_EXEMPT_PREFIX = /(^|\/)platform\/libs\/outbox\//;

const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.e2e\.ts$/,
  /\/__tests__\//,
  /\/__mocks__\//,
  /\/test\//,
];

function identifierName(node: TSESTree.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    return node.property.name;
  }
  return null;
}

export default createRule<Options, MessageIds>({
  name: 'no-direct-event-publish',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Direct calls to eventBus.publish() / natsClient.publish() outside @platform/outbox bypass the transactional-outbox guarantee (ADR-006, DATA-HIGH-004).',
    },
    schema: [],
    messages: {
      directEventBusPublish:
        'Direct eventBus.publish() call outside @platform/outbox bypasses the transactional-outbox guarantee (ADR-006, DATA-HIGH-004). Write to the outbox entity within the same transaction; the outbox worker publishes to NATS in a separate step with at-least-once semantics. Reference: platform/libs/outbox/src/outbox-worker.service.ts.',
      directNatsClientPublish:
        'Direct natsClient / natsConnection .publish() call outside @platform/outbox is a CRITICAL bypass of the outbox pipeline. The at-most-once delivery path this creates desynchronises the write-model from the event stream on any network blip. Route through @platform/outbox (OutboxEntityBase subclass + outbox worker).',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.getFilename();

    if (OUTBOX_EXEMPT_PREFIX.test(filename)) return {};
    if (TEST_FILE_PATTERNS.some((re) => re.test(filename))) return {};

    return {
      CallExpression(node: TSESTree.CallExpression) {
        // Match `<obj>.publish(...)` where <obj> carries a bus / NATS hint.
        if (node.callee.type !== 'MemberExpression') return;
        const { property, object } = node.callee;
        if (property.type !== 'Identifier' || property.name !== 'publish') return;

        // Walk through `this.<ident>` or bare `<ident>` to extract the
        // identifier that owns `.publish`.
        const objectName = identifierName(object);
        if (objectName === null) return;

        if (EVENT_BUS_HINTS.has(objectName)) {
          context.report({ node, messageId: 'directEventBusPublish' });
          return;
        }

        if (NATS_HANDLE_HINTS.has(objectName)) {
          context.report({ node, messageId: 'directNatsClientPublish' });
          return;
        }
      },
    };
  },
});
