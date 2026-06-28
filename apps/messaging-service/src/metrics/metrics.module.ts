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
 * @see ADR-012 section 10 (Observability)
 */
import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ServiceMetricsModule, ServiceMetricsService } from '@aquaculture/backend-common/metrics';
import { MessagingMetricsService } from './messaging-metrics.service';

@Global()
@Module({
  imports: [ServiceMetricsModule],
  providers: [MessagingMetricsService],
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
