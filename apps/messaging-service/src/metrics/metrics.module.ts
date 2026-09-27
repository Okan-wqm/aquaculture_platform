/**
 * @module MetricsModule
 * @description Registers the messaging Prometheus domain metrics service and
 * contributes its registry to the platform ServiceMetricsModule, which owns the
 * single GET /metrics scrape endpoint + the default http_ and nodejs_ collectors.
 * Marked @Global() because MessagingMetricsService is a cross-cutting concern
 * injected across ChannelModule, MessageModule, OutboxModule, and rate-limit
 * interceptors.
 *
 * ORPHAN-089: pre-fix this module served ONLY the messaging registry from a
 * bespoke MetricsController, so the platform HTTP + Node-runtime metrics were
 * absent from the scrape. It now mirrors farm-service (OBS-HIGH-001): import
 * ServiceMetricsModule and plug the domain registry into it in onModuleInit.
 *
 * MSGFIX-FAZ0 (2026-09-16): two collectors were added that WRITE gauges the
 * domain registry already owns — OutboxPendingCollectorService (periodic
 * count of pending messaging.messaging_outbox rows → messaging_outbox_pending)
 * and NatsConnectionMetricsService (event-bus lifecycle snapshots →
 * messaging_nats_connection_status / messaging_nats_reconnects_total). Both
 * feed MessagingMetricsService; no new endpoint, the single @Public /metrics
 * scrape picks them up through the existing 'messaging-domain' contributor.
 * @see ADR-012 section 10 (Observability)
 */
import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ServiceMetricsModule, ServiceMetricsService } from '@aquaculture/backend-common/metrics';
import { MessagingMetricsService } from './messaging-metrics.service';
import { OutboxPendingCollectorService } from './outbox-pending-collector.service';
import { NatsConnectionMetricsService } from './nats-connection-metrics.service';

@Global()
@Module({
  imports: [ServiceMetricsModule],
  providers: [MessagingMetricsService, OutboxPendingCollectorService, NatsConnectionMetricsService],
  exports: [MessagingMetricsService],
})
export class MetricsModule implements OnModuleInit {
  constructor(
    private readonly messagingMetrics: MessagingMetricsService,
    private readonly serviceMetrics: ServiceMetricsService,
  ) {}

  onModuleInit(): void {
    // WHAT: plug the messaging domain registry into the platform /metrics
    // endpoint. WHY a module hook (not the service constructor): keeps
    // MessagingMetricsService constructible without DI in unit tests while
    // making the production wiring automatic and un-forgettable.
    this.messagingMetrics.contributeTo(this.serviceMetrics);
  }
}
