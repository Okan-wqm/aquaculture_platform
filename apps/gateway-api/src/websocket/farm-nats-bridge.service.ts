/**
 * FarmNatsBridgeService
 *
 * NATS → Socket.IO bridge for farm domain events. Subscribes to the
 * tenant-scoped JetStream subject pattern that NatsEventBus.deriveSubject()
 * publishes to (`events.{tenantId}.{eventType}`) and forwards each event
 * to FarmGateway, which broadcasts it to the matching tenant's room.
 *
 * # Subject pattern
 *
 * NatsEventBus publishes to three-token subjects of the form
 * `events.{tenantId}.{eventType}`. To match every tenant for a given event
 * type, this bridge uses NATS core wildcards (`*`) — the `*` matches
 * exactly one token. JetStream messages published via `jetStream.publish()`
 * are also delivered to active core subscribers, so a `connection.subscribe`
 * with the wildcard pattern receives them in real time.
 *
 * # Tenant routing — NATS subject is the SINGLE SOURCE OF TRUTH
 *
 * SECURITY: The bridge MUST derive the destination tenant room from
 * `msg.subject.split('.')[1]`, NOT from `event.tenantId` in the decoded
 * payload. The subject is stamped by `NatsEventBus.deriveSubject()` at
 * publish time and propagated by the NATS server as the authoritative
 * routing key. The payload, by contrast, is controlled end-to-end by the
 * publisher — trusting it for routing means any service with NATS publish
 * credentials could publish to its OWN subject but set
 * `payload.tenantId = <victim>` and fan the event out into the victim's
 * Socket.IO room, triggering false compliance signals (CR-1, CVSS 9.1).
 *
 * The fix is NOT a cross-check ("accept only when subject matches payload")
 * — that still carries two sources of truth and requires correct reconciliation
 * forever after. The fix is to make the subject the ONLY source. The payload
 * `tenantId` is informational for downstream consumers; the bridge never reads
 * it for routing. The attack vector is eliminated by construction, not detected
 * and rejected.
 *
 * Defense in depth: the subject tenant token is additionally validated as a
 * canonical UUID before use (`TENANT_ID_REGEX` from backend-common). A
 * malformed or wildcard-like token is dropped — it cannot become a Socket.IO
 * room key or a log line.
 *
 * # Queue group
 *
 * All subscriptions use queue group `gateway-farm` so that when multiple
 * gateway-api replicas run, each NATS message is delivered to exactly one
 * replica (load-balanced). The replica that receives the message broadcasts
 * to its locally connected Socket.IO clients via the gateway's `tenant:` room.
 * Multi-pod broadcast across replicas requires the Redis Socket.IO adapter
 * (configured in MessagingGateway / handled by Phase D for parity).
 *
 * # Reconnect handling
 *
 * On NATS reconnect, the previous batch of subscriptions is explicitly
 * unsubscribed and the array cleared BEFORE re-subscribing. The leak in
 * MessagingNatsBridgeService — where each reconnect doubled the array
 * without cleanup — is avoided here from day one.
 *
 * @see Phase B of farm domain real-time visibility plan.
 */

import { TENANT_ID_REGEX } from '@aquaculture/backend-common/constants';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
// NATS v3 (@nats-io/* 3.x). The v2 monolithic `nats` package split into
// nats-core (connection + Msg/Subscription primitives) and transport-node
// (Node `connect`). StringCodec was REMOVED — decode an inbound message via
// msg.string() instead of sc.decode(msg.data). The wire bytes are UTF-8
// either way, so this is byte-for-byte compatible with v2 producers.
import type { NatsConnection, Subscription, ConnectionOptions } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateFarmEvent } from '@platform/event-contracts';

import { FarmGateway } from './farm.gateway';

// ============================================================================
// Types
// ============================================================================

/**
 * Inbound farm domain event shape on the wire. Mirrors `BaseEvent` from
 * `@platform/event-contracts` with the relevant farm-specific extensions
 * the bridge needs to route. Domain-specific payload fields are passed
 * through verbatim — the bridge does not interpret them.
 */
interface FarmDomainEvent {
  eventId: string;
  eventType: string;
  timestamp: string | Date;
  tenantId: string;
  version?: number;
  userId?: string;
  aggregateId?: string;
  aggregateType?: string;
  // Domain-specific fields are passed through unchanged
  [key: string]: unknown;
}

// ============================================================================
// NATS subject configuration
// ============================================================================

/**
 * Farm domain NATS subjects to bridge. Wildcards (`*`) match the tenant
 * segment of `events.{tenantId}.{eventType}` so the bridge receives every
 * tenant's events for cross-tenant fan-out at the gateway layer. Tenant
 * isolation is enforced downstream via Socket.IO rooms keyed by `tenantId`.
 */
const FARM_SUBJECTS = [
  'events.*.BatchCreated',
  'events.*.BatchHarvested',
  'events.*.BatchTransferred',
  'events.*.BatchStatusChanged',
  'events.*.BatchClosed',
  'events.*.BatchAllocatedToTank',
  'events.*.MortalityRecorded',
  'events.*.CullRecorded',
  'events.*.FeedingRecorded',
  'events.*.FeedInventoryLow',
  'events.*.LowStockDetected',
  'events.*.SiteCreated',
  'events.*.SiteUpdated',
  'events.*.SiteDeleted',
  'events.*.DepartmentCreated',
  'events.*.DepartmentUpdated',
  'events.*.DepartmentDeleted',
  'events.*.SystemCreated',
  'events.*.SystemUpdated',
  'events.*.SystemDeleted',
  'events.*.SiteContactsChanged',
  'events.*.TankCreated',
  'events.*.TankUpdated',
  'events.*.TankStatusChanged',
  'events.*.TankDeleted',
  'events.*.EquipmentCreated',
  'events.*.EquipmentUpdated',
  'events.*.EquipmentDeleted',
  'events.*.SubEquipmentCreated',
  'events.*.SubEquipmentUpdated',
  'events.*.SubEquipmentDeleted',
  'events.*.SupplierApprovedSitesChanged',
  'events.*.FeederCalibrationsSaved',
  // Harvest follow-up lifecycle signals (dead-listeners produce-side cure):
  // a final harvest frees a tank and completes the batch production cycle —
  // both are dashboard read-model events the frontend renders in real time.
  'events.*.TankCleared',
  'events.*.BatchProductionCompleted',
] as const;

/** Stable NATS queue group name — load-balances across gateway-api replicas. */
const FARM_QUEUE_GROUP = 'gateway-farm';

// ============================================================================
// FarmNatsBridgeService
// ============================================================================

@Injectable()
export class FarmNatsBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FarmNatsBridgeService.name);
  private connection: NatsConnection | null = null;
  private subscriptions: Subscription[] = [];

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(FarmGateway) private readonly farmGateway: FarmGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    const natsEnabled = this.configService.get<string>('NATS_ENABLED', 'true') === 'true';
    if (!natsEnabled) {
      this.logger.log('Farm NATS bridge is disabled via NATS_ENABLED=false');
      return;
    }

    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    /** Use the shared NATS connection factory for consistent auth across all services. */
    const connectionOptions: ConnectionOptions = {
      ...buildNatsConnectionOptions('gateway-api-farm-bridge'),
    };

    try {
      this.connection = await connect(connectionOptions);
      this.logger.log(`Farm bridge connected to NATS at ${connectionOptions.servers}`);

      this.subscribeToFarmEvents();
      this.handleConnectionEvents();
    } catch (error) {
      this.logger.error(`Failed to connect Farm bridge to NATS: ${(error as Error).message}`);
      // Don't re-throw — the bridge will reconnect via the status loop, and
      // failing fast here would crash the entire gateway-api which is wrong:
      // sensor + messaging bridges should keep working.
    }
  }

  private subscribeToFarmEvents(): void {
    if (!this.connection) return;

    for (const subject of FARM_SUBJECTS) {
      // ── Subscription-time known event type ──────────────────────────
      // The subscription pattern is `events.*.{EventType}` — every message
      // delivered on this subscription has that exact event type as its
      // third subject token. We capture it here and use it as the dispatch
      // key, rather than reading `event.eventType` from the payload. This
      // keeps the routing decision anchored to the NATS subject, so a
      // publisher cannot misrepresent its event type to reach a different
      // broadcast method.
      const [, , expectedEventType] = subject.split('.');
      if (!expectedEventType) {
        // FARM_SUBJECTS is hard-coded above as `events.*.X` — this branch
        // can only fire if someone edits the constant to a malformed
        // entry, which the check catches at startup time.
        this.logger.error(`Malformed FARM_SUBJECTS entry: ${subject} — expected three tokens`);
        continue;
      }

      const sub = this.connection.subscribe(subject, {
        queue: FARM_QUEUE_GROUP,
      });
      this.subscriptions.push(sub);
      this.logger.log(`Subscribed to ${subject} (queue: ${FARM_QUEUE_GROUP})`);

      (async () => {
        for await (const msg of sub) {
          try {
            // ── Parse subject — the routing source of truth ─────────
            // The subject is stamped by the NATS server, not the client.
            // Extract tenantId from token 1 and use it as the destination
            // tenant room key. `event.tenantId` is NEVER used for routing
            // in this bridge (see class-level doc block for the rationale
            // and the CR-1 attack scenario that motivates this design).
            const subjectTokens = msg.subject.split('.');
            const [eventsPrefix, routingTenantId, subjectEventType] = subjectTokens;
            if (
              subjectTokens.length !== 3 ||
              eventsPrefix !== 'events' ||
              !routingTenantId ||
              !subjectEventType
            ) {
              this.logger.warn(`Dropping event with malformed NATS subject: ${msg.subject}`);
              continue;
            }

            // Subject tenantId must be a canonical UUID. A malformed token
            // cannot become a Socket.IO room key or a log line — dropping
            // is the only safe option because there is no tenant to notify
            // without a valid tenantId.
            if (!TENANT_ID_REGEX.test(routingTenantId)) {
              this.logger.warn(
                `Dropping event with invalid tenantId token in subject ${msg.subject}: ${JSON.stringify(routingTenantId)}`,
              );
              continue;
            }

            // Defensive: NATS subscription guarantees the third token
            // equals the subscription suffix, so this is an invariant
            // check rather than an expected branch. Catches broker bugs
            // or test-harness mis-routes.
            if (subjectEventType !== expectedEventType) {
              this.logger.warn(`Subject eventType mismatch on ${subject}: got ${subjectEventType}`);
              continue;
            }

            // v3: msg.string() replaces StringCodec.decode(msg.data) — same UTF-8 bytes.
            const data = msg.string();
            const parsed: unknown = JSON.parse(data);

            // ── H-3: Strict JSON Schema validation ─────────────────
            // Validate the decoded payload against the per-event-type
            // schema compiled once at module load. Schemas declare
            // `additionalProperties: false`, cap free-text fields at
            // MAX_FREE_TEXT_LENGTH, and constrain enum-valued fields
            // (reason codes, status codes) to their canonical lists.
            //
            // This closes the footgun described in the comprehensive
            // review: event payloads reflected into the React Query
            // cache on the frontend, where a future hook that renders
            // free-text fields as HTML would become a trusted-source
            // XSS sink. Failing-closed at the bridge keeps the unsafe
            // shape away from every downstream consumer.
            //
            // The dispatch key is `expectedEventType` from the
            // subscription pattern — NOT `parsed.eventType` — so a
            // publisher cannot pick a different schema than the
            // subject it published to. Any mismatch between
            // `parsed.eventType` and `expectedEventType` is caught
            // by the schema's `eventType: { const: '...' }` clause.
            const validation = validateFarmEvent(expectedEventType, parsed);
            if (!validation.valid) {
              const preview =
                typeof parsed === 'object' && parsed !== null && 'eventId' in parsed
                  ? `eventId=${String((parsed as Record<string, unknown>).eventId)}`
                  : 'eventId=missing';
              this.logger.warn(
                `Dropping ${expectedEventType} on ${subject} — schema validation failed (${validation.errors}, ${preview})`,
              );
              continue;
            }

            // Schema passed: the payload is structurally a BaseEvent
            // with the farm-event extensions the gateway expects.
            // Narrow via assertion — the runtime guarantee is now
            // stronger than the compile-time type.
            const event = parsed as FarmDomainEvent;

            // Dispatch with the subject-derived tenantId and eventType.
            // The event payload is forwarded verbatim to the gateway,
            // but the routing key comes exclusively from the subject.
            this.handleEvent(routingTenantId, expectedEventType, event);
          } catch (error) {
            this.logger.warn(`Failed to process ${subject}: ${(error as Error).message}`);
          }
        }
      })().catch((error) => {
        this.logger.error(`NATS ${subject} subscription loop error: ${(error as Error).message}`);
      });
    }
  }

  /**
   * Route a validated farm event to the matching FarmGateway broadcast
   * method. Both routing inputs come from the NATS subject, NOT the event
   * payload — see class-level doc block for the architectural rationale.
   *
   * @param routingTenantId Tenant UUID extracted from `msg.subject` token 1,
   *   already UUID-validated. This is the destination tenant room key.
   * @param routingEventType Event type from `msg.subject` token 2, equal
   *   to the subscription suffix. This is the dispatch key.
   * @param event The decoded event payload, forwarded verbatim to the
   *   broadcast method. The bridge does NOT read `event.tenantId` or
   *   `event.eventType` for routing — those fields are informational only
   *   and flow through to consumers unchanged.
   *
   * Unknown event types are logged and dropped — the bridge does not
   * silently forward arbitrary events because that would let an attacker
   * who can publish to NATS spoof arbitrary Socket.IO event names.
   */
  private handleEvent(
    routingTenantId: string,
    routingEventType: string,
    event: FarmDomainEvent,
  ): void {
    switch (routingEventType) {
      case 'BatchCreated':
        this.farmGateway.broadcastBatchCreated(routingTenantId, event);
        break;
      case 'BatchHarvested':
        this.farmGateway.broadcastBatchHarvested(routingTenantId, event);
        break;
      case 'BatchTransferred':
        this.farmGateway.broadcastBatchTransferred(routingTenantId, event);
        break;
      case 'BatchStatusChanged':
        this.farmGateway.broadcastBatchStatusChanged(routingTenantId, event);
        break;
      case 'BatchClosed':
        this.farmGateway.broadcastBatchClosed(routingTenantId, event);
        break;
      case 'BatchAllocatedToTank':
        this.farmGateway.broadcastBatchAllocatedToTank(routingTenantId, event);
        break;
      case 'MortalityRecorded':
        this.farmGateway.broadcastMortalityRecorded(routingTenantId, event);
        break;
      case 'CullRecorded':
        this.farmGateway.broadcastCullRecorded(routingTenantId, event);
        break;
      case 'FeedingRecorded':
        this.farmGateway.broadcastFeedingRecorded(routingTenantId, event);
        break;
      case 'FeedInventoryLow':
        this.farmGateway.broadcastFeedInventoryLow(routingTenantId, event);
        break;
      case 'LowStockDetected':
        this.farmGateway.broadcastLowStockDetected(routingTenantId, event);
        break;
      case 'SiteCreated':
        this.farmGateway.broadcastSiteCreated(routingTenantId, event);
        break;
      case 'SiteUpdated':
        this.farmGateway.broadcastSiteUpdated(routingTenantId, event);
        break;
      case 'SiteDeleted':
        this.farmGateway.broadcastSiteDeleted(routingTenantId, event);
        break;
      case 'DepartmentCreated':
        this.farmGateway.broadcastDepartmentCreated(routingTenantId, event);
        break;
      case 'DepartmentUpdated':
        this.farmGateway.broadcastDepartmentUpdated(routingTenantId, event);
        break;
      case 'DepartmentDeleted':
        this.farmGateway.broadcastDepartmentDeleted(routingTenantId, event);
        break;
      case 'SystemCreated':
        this.farmGateway.broadcastSystemCreated(routingTenantId, event);
        break;
      case 'SystemUpdated':
        this.farmGateway.broadcastSystemUpdated(routingTenantId, event);
        break;
      case 'SystemDeleted':
        this.farmGateway.broadcastSystemDeleted(routingTenantId, event);
        break;
      case 'SiteContactsChanged':
        this.farmGateway.broadcastSiteContactsChanged(routingTenantId, event);
        break;
      case 'TankCreated':
        this.farmGateway.broadcastTankCreated(routingTenantId, event);
        break;
      case 'TankUpdated':
        this.farmGateway.broadcastTankUpdated(routingTenantId, event);
        break;
      case 'TankStatusChanged':
        this.farmGateway.broadcastTankStatusChanged(routingTenantId, event);
        break;
      case 'TankDeleted':
        this.farmGateway.broadcastTankDeleted(routingTenantId, event);
        break;
      case 'EquipmentCreated':
        this.farmGateway.broadcastEquipmentCreated(routingTenantId, event);
        break;
      case 'EquipmentUpdated':
        this.farmGateway.broadcastEquipmentUpdated(routingTenantId, event);
        break;
      case 'EquipmentDeleted':
        this.farmGateway.broadcastEquipmentDeleted(routingTenantId, event);
        break;
      case 'SubEquipmentCreated':
        this.farmGateway.broadcastSubEquipmentCreated(routingTenantId, event);
        break;
      case 'SubEquipmentUpdated':
        this.farmGateway.broadcastSubEquipmentUpdated(routingTenantId, event);
        break;
      case 'SubEquipmentDeleted':
        this.farmGateway.broadcastSubEquipmentDeleted(routingTenantId, event);
        break;
      case 'SupplierApprovedSitesChanged':
        this.farmGateway.broadcastSupplierApprovedSitesChanged(routingTenantId, event);
        break;
      case 'FeederCalibrationsSaved':
        this.farmGateway.broadcastFeederCalibrationsSaved(routingTenantId, event);
        break;
      case 'TankCleared':
        this.farmGateway.broadcastTankCleared(routingTenantId, event);
        break;
      case 'BatchProductionCompleted':
        this.farmGateway.broadcastBatchProductionCompleted(routingTenantId, event);
        break;
      default:
        this.logger.debug(
          `Unhandled farm event type: ${routingEventType} (eventId=${event.eventId})`,
        );
    }
  }

  /**
   * NATS connection lifecycle handler.
   *
   * On reconnect we explicitly drain and clear the previous subscription
   * array BEFORE re-subscribing. The MessagingNatsBridgeService has a known
   * bug where reconnect cycles double the subscription count (HIGH-5 in the
   * domain audit) — this bridge avoids that from day one. Phase D will
   * apply the same fix to the messaging and sensor bridges.
   */
  private handleConnectionEvents(): void {
    if (!this.connection) return;

    const connection = this.connection;
    (async () => {
      for await (const status of connection.status()) {
        // v3: Status is a discriminated union on `type`; the error variant
        // carries `error: Error` (v2's `status.data` field was removed).
        switch (status.type) {
          case 'disconnect':
            this.logger.warn('Farm NATS bridge disconnected');
            break;
          case 'reconnect':
            this.logger.log(
              'Farm NATS bridge reconnected — draining stale subscriptions then re-subscribing',
            );
            // Drain and clear previous subscriptions BEFORE creating new ones.
            // This prevents the "subscription leak on reconnect" defect that
            // affects the messaging and sensor bridges.
            for (const sub of this.subscriptions) {
              try {
                sub.unsubscribe();
              } catch (error) {
                this.logger.debug(`Stale subscription cleanup error: ${(error as Error).message}`);
              }
            }
            this.subscriptions = [];
            this.subscribeToFarmEvents();
            break;
          case 'error':
            this.logger.error(`Farm NATS error: ${String(status.error)}`);
            break;
        }
      }
    })().catch((error) => {
      this.logger.error(`Farm NATS status loop error: ${(error as Error).message}`);
    });
  }

  private async disconnect(): Promise<void> {
    for (const sub of this.subscriptions) {
      try {
        sub.unsubscribe();
      } catch (error) {
        this.logger.debug(
          `Subscription unsubscribe error during shutdown: ${(error as Error).message}`,
        );
      }
    }
    this.subscriptions = [];

    if (this.connection) {
      try {
        await this.connection.drain();
        this.logger.log('Farm NATS bridge connection drained and closed');
      } catch (error) {
        this.logger.warn(`Farm NATS bridge drain error: ${(error as Error).message}`);
      } finally {
        this.connection = null;
      }
    }
  }

  /** Health probe — true when the bridge holds an open NATS connection. */
  isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }
}
