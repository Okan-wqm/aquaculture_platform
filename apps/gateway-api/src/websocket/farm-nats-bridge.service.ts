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

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  connect,
  NatsConnection,
  Subscription,
  StringCodec,
  ConnectionOptions,
} from 'nats';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common';

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
  private readonly sc = StringCodec();

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(FarmGateway) private readonly farmGateway: FarmGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    const natsEnabled =
      this.configService.get<string>('NATS_ENABLED', 'true') === 'true';
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
      this.logger.log(
        `Farm bridge connected to NATS at ${connectionOptions.servers}`,
      );

      this.subscribeToFarmEvents();
      this.handleConnectionEvents();
    } catch (error) {
      this.logger.error(
        `Failed to connect Farm bridge to NATS: ${(error as Error).message}`,
      );
      // Don't re-throw — the bridge will reconnect via the status loop, and
      // failing fast here would crash the entire gateway-api which is wrong:
      // sensor + messaging bridges should keep working.
    }
  }

  private subscribeToFarmEvents(): void {
    if (!this.connection) return;

    for (const subject of FARM_SUBJECTS) {
      const sub = this.connection.subscribe(subject, {
        queue: FARM_QUEUE_GROUP,
      });
      this.subscriptions.push(sub);
      this.logger.log(
        `Subscribed to ${subject} (queue: ${FARM_QUEUE_GROUP})`,
      );

      (async () => {
        for await (const msg of sub) {
          try {
            const data = this.sc.decode(msg.data);
            const event = JSON.parse(data) as FarmDomainEvent;

            if (!this.isValidEvent(event)) {
              this.logger.warn(
                `Invalid farm NATS event on ${subject}, dropping (eventId=${event?.eventId ?? 'missing'})`,
              );
              continue;
            }

            this.handleEvent(event);
          } catch (error) {
            this.logger.warn(
              `Failed to process ${subject}: ${(error as Error).message}`,
            );
          }
        }
      })().catch((error) => {
        this.logger.error(
          `NATS ${subject} subscription loop error: ${(error as Error).message}`,
        );
      });
    }
  }

  /**
   * Route a validated farm event to the matching FarmGateway broadcast
   * method. Unknown event types are logged and dropped — the bridge does
   * not silently forward arbitrary events because that would let an
   * attacker who can publish to NATS spoof arbitrary Socket.IO events.
   */
  private handleEvent(event: FarmDomainEvent): void {
    switch (event.eventType) {
      case 'BatchCreated':
        this.farmGateway.broadcastBatchCreated(event.tenantId, event);
        break;
      case 'BatchHarvested':
        this.farmGateway.broadcastBatchHarvested(event.tenantId, event);
        break;
      case 'BatchTransferred':
        this.farmGateway.broadcastBatchTransferred(event.tenantId, event);
        break;
      case 'BatchStatusChanged':
        this.farmGateway.broadcastBatchStatusChanged(event.tenantId, event);
        break;
      case 'BatchClosed':
        this.farmGateway.broadcastBatchClosed(event.tenantId, event);
        break;
      case 'BatchAllocatedToTank':
        this.farmGateway.broadcastBatchAllocatedToTank(event.tenantId, event);
        break;
      case 'MortalityRecorded':
        this.farmGateway.broadcastMortalityRecorded(event.tenantId, event);
        break;
      case 'CullRecorded':
        this.farmGateway.broadcastCullRecorded(event.tenantId, event);
        break;
      case 'FeedingRecorded':
        this.farmGateway.broadcastFeedingRecorded(event.tenantId, event);
        break;
      case 'FeedInventoryLow':
        this.farmGateway.broadcastFeedInventoryLow(event.tenantId, event);
        break;
      default:
        this.logger.debug(
          `Unhandled farm event type: ${event.eventType} (eventId=${event.eventId})`,
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
        const statusType = status.type as string;
        switch (statusType) {
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
                this.logger.debug(
                  `Stale subscription cleanup error: ${(error as Error).message}`,
                );
              }
            }
            this.subscriptions = [];
            this.subscribeToFarmEvents();
            break;
          case 'error':
            this.logger.error(`Farm NATS error: ${String(status.data)}`);
            break;
        }
      }
    })().catch((error) => {
      this.logger.error(
        `Farm NATS status loop error: ${(error as Error).message}`,
      );
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
        this.logger.warn(
          `Farm NATS bridge drain error: ${(error as Error).message}`,
        );
      } finally {
        this.connection = null;
      }
    }
  }

  /**
   * Validate that an inbound event has the minimum required structure.
   * Drops events missing tenantId — they cannot be routed to a tenant room
   * and would represent a contract violation by the publisher.
   */
  private isValidEvent(event: FarmDomainEvent | null | undefined): boolean {
    if (typeof event !== 'object' || event === null) return false;
    if (typeof event.eventType !== 'string' || event.eventType.length === 0) {
      return false;
    }
    if (typeof event.tenantId !== 'string' || event.tenantId.length === 0) {
      return false;
    }
    if (
      typeof event.timestamp !== 'string' &&
      !(event.timestamp instanceof Date)
    ) {
      return false;
    }
    return true;
  }

  /** Health probe — true when the bridge holds an open NATS connection. */
  isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }
}
