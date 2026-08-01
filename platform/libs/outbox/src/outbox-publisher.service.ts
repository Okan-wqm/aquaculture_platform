import { Injectable, Inject, Logger, Type } from '@nestjs/common';
import type { BaseEvent } from '@platform/event-contracts';
import { EntityManager } from 'typeorm';

import {
  OUTBOX_ENTITY_CLASS,
  OUTBOX_OPTIONS,
  OUTBOX_UUID_REGEX,
  OUTBOX_EVENT_TYPE_REGEX,
} from './constants';
import { OutboxEntityBase } from './outbox-entity.base';
import {
  OUTBOX_DELIVERY_POLICY_FIELD,
  OUTBOX_ROUTING_SCOPE_FIELD,
  OUTBOX_SECURITY_RECOVERY_POLICY,
  OUTBOX_SYSTEM_TENANT_ID,
  type OutboxDeliveryPolicy,
  type OutboxFeatureOptions,
  type OutboxRoutingScope,
  type OutboxStoredPayload,
} from './outbox-routing';

export interface OutboxEnqueueOptions {
  idempotencyKey?: string;
  aggregateId?: string;
  routingScope?: OutboxRoutingScope;
  deliveryPolicy?: OutboxDeliveryPolicy;
}

/**
 * OutboxPublisher
 *
 * The transactional outbox publisher API. Command handlers call
 * `enqueue(event, manager)` from inside an active transaction so the
 * outbox INSERT participates in the same DB transaction as the domain
 * write. Either both commit or neither — at-least-once delivery.
 *
 * IMPORTANT: This service NEVER touches NATS. Worker (OutboxWorkerService)
 * polls the table and handles the actual publish. Decoupling the write
 * path from the network ensures the user-facing request never blocks on
 * NATS availability.
 *
 * # Hard-fail boundary
 *
 * The constructor injection has NO `@Optional()`. If the consuming service
 * has not registered an outbox entity via `OutboxModule.forFeature(...)`,
 * NestJS throws at startup — not at the moment a user records mortality.
 *
 * # Input validation — tenant isolation enforcement
 *
 * `enqueue()` rejects malformed `tenantId` and `eventType` at the publisher
 * boundary because both values become routing keys downstream:
 *
 *   - `tenantId` → NATS subject segment `events.{tenantId}.{eventType}`
 *     → Socket.IO room key `tenant:{tenantId}`. A tenantId containing `.`
 *     `*` or `>` would inject NATS wildcards; `\n` would pollute logs;
 *     an arbitrary string would collide with another tenant's room.
 *   - `eventType` → same subject segment. A lowercase or punctuated value
 *     breaks the PascalCase discriminator the bridge switches on.
 *
 * Failing closed here keeps all downstream layers honest — by the time a
 * row lands in the outbox table, its tenant and event type have been
 * proven valid. Defense in depth still applies at the worker, bridge,
 * and gateway, but the publisher is the first line.
 *
 * # Transactional guarantee
 *
 * The `manager` parameter MUST come from an active `queryRunner` so the
 * outbox INSERT joins the caller's transaction. A manager from the root
 * data source (`dataSource.manager`) would commit the outbox row in
 * autocommit mode, silently violating the atomicity contract. The runtime
 * assertion catches that mistake at the moment it happens, not in
 * production when an event is mysteriously missing.
 *
 * @see Phase 2 of farm domain real-time visibility plan
 * @see Phase 2 checkpoint — Security CR-2 + Code Quality M-13 hardening
 */
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @Inject(OUTBOX_ENTITY_CLASS)
    private readonly entityClass: Type<OutboxEntityBase>,
    @Inject(OUTBOX_OPTIONS)
    private readonly featureOptions: Required<OutboxFeatureOptions> = {
      allowSystemRouting: false,
      allowSecurityRecovery: false,
    },
  ) {}

  /**
   * Enqueue a domain event for at-least-once delivery via NATS.
   *
   * MUST be called inside an active transaction. Pass the same
   * `EntityManager` (`queryRunner.manager`) the handler is using for
   * domain writes — the outbox INSERT joins that transaction.
   *
   * Validates:
   *  - `event.eventType` is non-empty and PascalCase
   *  - `event.tenantId` is non-empty and a UUID
   *  - `manager` is bound to a queryRunner with an active transaction
   *
   * @throws Error if any validation fails. Callers should NOT catch and
   *   swallow — a failed validation indicates a contract violation that
   *   would otherwise produce a cross-tenant leak or a lost event.
   */
  async enqueue<TEvent extends BaseEvent>(
    event: TEvent,
    manager: EntityManager,
    options: OutboxEnqueueOptions = {},
  ): Promise<void> {
    // ── Event type validation ───────────────────────────────────────
    if (!event.eventType) {
      throw new Error('OutboxPublisher.enqueue: event.eventType is required (got empty string)');
    }
    if (!OUTBOX_EVENT_TYPE_REGEX.test(event.eventType)) {
      throw new Error(
        `OutboxPublisher.enqueue: event.eventType must be PascalCase ` +
          `(got: ${JSON.stringify(event.eventType)}). The eventType becomes ` +
          `a NATS subject segment and a discriminator across the bridge + ` +
          `gateway + frontend — it must match ^[A-Z][A-Za-z0-9]+$.`,
      );
    }

    // ── Tenant ID validation — the single most important check ──────
    if (!event.tenantId) {
      throw new Error(
        `OutboxPublisher.enqueue: event.tenantId is required ` + `(event: ${event.eventType})`,
      );
    }
    const systemRouted = options.routingScope === 'system';
    if (systemRouted) {
      if (!this.featureOptions.allowSystemRouting) {
        throw new Error(
          'OutboxPublisher.enqueue: system routing requires an explicit service capability',
        );
      }
      if (event.tenantId !== OUTBOX_SYSTEM_TENANT_ID) {
        throw new Error(
          'OutboxPublisher.enqueue: system routing requires event.tenantId to be the reserved system identity',
        );
      }
      if (!options.idempotencyKey) {
        throw new Error('OutboxPublisher.enqueue: system-routed events require an idempotencyKey');
      }
    } else if (!OUTBOX_UUID_REGEX.test(event.tenantId)) {
      throw new Error(
        `OutboxPublisher.enqueue: event.tenantId must be a UUID ` +
          `(got: ${JSON.stringify(event.tenantId)}, event: ${event.eventType}). ` +
          `The tenantId becomes a NATS subject segment AND a Socket.IO ` +
          `room key downstream — a malformed value could inject NATS ` +
          `wildcards or cross-tenant leak the event.`,
      );
    }

    if (
      options.deliveryPolicy !== undefined &&
      options.deliveryPolicy !== 'default' &&
      options.deliveryPolicy !== OUTBOX_SECURITY_RECOVERY_POLICY
    ) {
      throw new Error('OutboxPublisher.enqueue: unsupported delivery policy');
    }
    if (
      options.deliveryPolicy === OUTBOX_SECURITY_RECOVERY_POLICY &&
      !this.featureOptions.allowSecurityRecovery
    ) {
      throw new Error(
        'OutboxPublisher.enqueue: security recovery requires an explicit service capability',
      );
    }

    const eventRecord = event as object;
    if (OUTBOX_ROUTING_SCOPE_FIELD in eventRecord || OUTBOX_DELIVERY_POLICY_FIELD in eventRecord) {
      throw new Error(
        'OutboxPublisher.enqueue: event payload contains reserved outbox storage metadata',
      );
    }

    // ── Transaction assertion ───────────────────────────────────────
    // The outbox INSERT must join the caller's domain-write transaction
    // so both commit or neither. A manager without an active queryRunner
    // transaction would INSERT in autocommit mode, silently violating
    // the at-least-once guarantee (domain write rolls back → orphan
    // outbox row lives forever). This check catches the mistake at the
    // moment it happens rather than in production when an event goes
    // missing.
    if (!manager.queryRunner || !manager.queryRunner.isTransactionActive) {
      throw new Error(
        `OutboxPublisher.enqueue: manager must be from an active ` +
          `transaction (event: ${event.eventType}). Pass ` +
          `queryRunner.manager from inside startTransaction()/` +
          `commitTransaction(). The outbox row must commit atomically ` +
          `with the domain write.`,
      );
    }

    // Serialize → deserialize to produce a plain object that TypeORM can
    // persist as JSONB without carrying TypeScript class metadata or
    // prototype chains. JSON round-trip is the only way to go from a typed
    // interface (BaseEvent, no index signature) to a plain JSONB-safe object
    // without resorting to `as any` or `as unknown as X` casts.
    //
    // Performance: negligible — outbox rows are single-digit KB, enqueued
    // at most a few hundred per second. The round-trip takes <0.1ms per event.
    const payload = JSON.parse(JSON.stringify(event)) as OutboxStoredPayload;
    if (systemRouted) {
      payload[OUTBOX_ROUTING_SCOPE_FIELD] = OUTBOX_SYSTEM_TENANT_ID;
    }
    if (options.deliveryPolicy === OUTBOX_SECURITY_RECOVERY_POLICY) {
      payload[OUTBOX_DELIVERY_POLICY_FIELD] = OUTBOX_SECURITY_RECOVERY_POLICY;
    }

    const row: Partial<OutboxEntityBase> = {
      eventType: event.eventType,
      tenantId: systemRouted ? null : event.tenantId,
      aggregateId: options.aggregateId ?? null,
      idempotencyKey: options.idempotencyKey ?? null,
      payload,
      retryCount: 0,
      publishedAt: null,
      lastError: null,
      nextAttemptAt: null,
      isDeadLettered: false,
    };

    if (options.idempotencyKey) {
      await manager
        .createQueryBuilder()
        .insert()
        .into(this.entityClass)
        .values(row)
        .orIgnore()
        .execute();
    } else {
      await manager.save(this.entityClass, row);
    }

    this.logger.debug(`Enqueued ${event.eventType} outbox event`);
  }
}
