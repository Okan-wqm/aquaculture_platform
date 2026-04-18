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
 *  - .claude/agents/data-expert.md#Event-contract-versioning
 *    (outbox-only publish path — DATA-HIGH-004)
 *  - platform/libs/outbox/src/outbox-worker.service.ts (canonical caller)
 */
import { ESLintUtils } from '@typescript-eslint/utils';
type MessageIds = 'directEventBusPublish' | 'directNatsClientPublish';
declare const _default: ESLintUtils.RuleModule<MessageIds, [], ESLintUtils.RuleListener>;
export default _default;
//# sourceMappingURL=no-direct-event-publish.d.ts.map