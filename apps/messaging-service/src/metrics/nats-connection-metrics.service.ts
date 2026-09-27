/**
 * @module NatsConnectionMetricsService
 * @description MSGFIX-FAZ0 (2026-09-16): the messaging-service NATS transport
 * (JetStream event bus used by the transactional outbox, request-reply
 * responders, and the notification bridge) had NO Prometheus signal — a 16h
 * broker outage was invisible to alerting.
 *
 * This service subscribes to the event bus's OWN connection-lifecycle
 * listener (NatsEventBus.onCoreConnectionLifecycle — a public, exported API of
 * @platform/event-bus) and converts its state snapshots into:
 *
 *   - `messaging_nats_connection_status` — enum gauge: 2=connected,
 *     1=reconnecting, 0=disconnected (alert on `< 2`)
 *   - `messaging_nats_reconnects_total` — counter incremented on every
 *     RECOVERY (a 'connected' snapshot observed after the bus had already
 *     reached 'connected' once before; the initial connect does not count)
 *
 * Both metrics are owned by MessagingMetricsService, so they land in the
 * messaging domain registry that the single @Public /metrics endpoint already
 * serves (see MetricsModule / ORPHAN-089). No platform library changes.
 *
 * Why snapshots and not raw nats client events: the bus swaps connection
 * GENERATIONS across outer reconnects; subscribing directly to
 * `connection.status()` per generation would duplicate or drop listeners.
 * The lifecycle listener is generation-safe — it fires immediately with the
 * current snapshot (so the gauge is seeded at boot) and on every transition.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import type { CoreNatsConnectionSnapshot } from '@platform/event-bus';
import type { IEventBus } from '@platform/event-bus';

import { MessagingMetricsService } from './messaging-metrics.service';

/** Enum values for the connection-status gauge (documented in the metric help). */
const STATUS_CONNECTED = 2;
const STATUS_RECONNECTING = 1;
const STATUS_DISCONNECTED = 0;

const STATE_TO_STATUS: Record<CoreNatsConnectionSnapshot['state'], number> = {
  connected: STATUS_CONNECTED,
  reconnecting: STATUS_RECONNECTING,
  disconnected: STATUS_DISCONNECTED,
};

/** Narrow duck-type: the bus exposes its lifecycle hook when it is a NatsEventBus. */
interface LifecycleCapableEventBus {
  onCoreConnectionLifecycle?: (
    listener: (snapshot: CoreNatsConnectionSnapshot) => void,
  ) => () => void;
}

@Injectable()
export class NatsConnectionMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NatsConnectionMetricsService.name);
  private unsubscribe?: () => void;
  /** True once the bus reached 'connected' at least once — the next 'connected' is a reconnect. */
  private hasConnectedOnce = false;

  constructor(
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
    private readonly metrics: MessagingMetricsService,
  ) {}

  onModuleInit(): void {
    // Weak-type cast (all-optional members) is single-step and safe: it cannot
    // lie about shape, we verify the hook is really a function before use.
    const lifecycleBus = this.eventBus as LifecycleCapableEventBus;
    if (typeof lifecycleBus.onCoreConnectionLifecycle !== 'function') {
      // A future/alternative IEventBus implementation without the hook must
      // not break boot — but say it loudly once, because the metrics will be
      // absent from the scrape and on-call should know why.
      this.logger.warn(
        'Event bus does not expose onCoreConnectionLifecycle — messaging_nats_* metrics disabled',
      );
      return;
    }
    this.unsubscribe = lifecycleBus.onCoreConnectionLifecycle((snapshot) =>
      this.handleSnapshot(snapshot),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private handleSnapshot(snapshot: CoreNatsConnectionSnapshot): void {
    const status = STATE_TO_STATUS[snapshot.state] ?? STATUS_DISCONNECTED;
    this.metrics.setNatsConnectionStatus(status);

    if (snapshot.state === 'connected') {
      if (this.hasConnectedOnce) {
        this.metrics.incrementNatsReconnect();
      }
      this.hasConnectedOnce = true;
    }
  }
}
