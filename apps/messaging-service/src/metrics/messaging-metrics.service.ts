/**
 * @module MessagingMetricsService
 * @description Prometheus metrics for the messaging-service. Exposes counters,
 * histograms, and gauges for messages, channels, WebSocket connections,
 * outbox depth, media uploads, storage usage, and rate-limit hits.
 * Follows the same prom-client pattern as the observability-service.
 * @see ADR-012 section 10 (Observability)
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MessagingMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagingMetricsService.name);
  private readonly registry: client.Registry;

  // Counters
  private messagesTotal!: client.Counter;
  private channelsCreatedTotal!: client.Counter;
  private mediaUploadsTotal!: client.Counter;
  private rateLimitHitsTotal!: client.Counter;

  // Histograms
  private messageLatency!: client.Histogram;

  // Gauges
  private websocketConnections!: client.Gauge;
  private outboxPending!: client.Gauge;
  private storageUsedBytes!: client.Gauge;

  // Dead-letter and GDPR metrics
  // @see MSG-HIGH-006 (dead-letter metric counter)
  // @see MSG-HIGH-027 (GDPR erasure metric counter)
  private deadLetterTotal!: client.Counter;
  private gdprErasureTotal!: client.Counter;

  constructor() {
    this.registry = new client.Registry();
  }

  onModuleInit(): void {
    this.initializeMetrics();
    this.logger.log('Messaging Prometheus metrics initialized');
  }

  onModuleDestroy(): void {
    this.registry.clear();
    this.logger.log('Messaging Prometheus metrics cleaned up');
  }

  private initializeMetrics(): void {
    this.messagesTotal = new client.Counter({
      name: 'messaging_messages_total',
      help: 'Total number of messages sent',
      labelNames: ['tenant', 'content_type', 'channel_type'],
      registers: [this.registry],
    });

    this.channelsCreatedTotal = new client.Counter({
      name: 'messaging_channels_created_total',
      help: 'Total number of channels created',
      labelNames: ['tenant', 'channel_type'],
      registers: [this.registry],
    });

    this.messageLatency = new client.Histogram({
      name: 'messaging_message_latency_seconds',
      help: 'Latency from message send to delivery in seconds',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.websocketConnections = new client.Gauge({
      name: 'messaging_websocket_connections',
      help: 'Current number of active WebSocket connections',
      registers: [this.registry],
    });

    this.outboxPending = new client.Gauge({
      name: 'messaging_outbox_pending',
      help: 'Number of unpublished outbox events',
      registers: [this.registry],
    });

    this.mediaUploadsTotal = new client.Counter({
      name: 'messaging_media_uploads_total',
      help: 'Total number of media file uploads',
      labelNames: ['tenant', 'mime_type'],
      registers: [this.registry],
    });

    this.storageUsedBytes = new client.Gauge({
      name: 'messaging_storage_used_bytes',
      help: 'Storage used by tenant in bytes',
      labelNames: ['tenant'],
      registers: [this.registry],
    });

    this.rateLimitHitsTotal = new client.Counter({
      name: 'messaging_rate_limit_hits_total',
      help: 'Total number of rate limit hits',
      labelNames: ['action'],
      registers: [this.registry],
    });

    // @see MSG-HIGH-006 (dead-letter metric counter)
    this.deadLetterTotal = new client.Counter({
      name: 'messaging_outbox_dead_letter_total',
      help: 'Total number of dead-lettered outbox events',
      registers: [this.registry],
    });

    // @see MSG-HIGH-027 (GDPR erasure metric counter)
    this.gdprErasureTotal = new client.Counter({
      name: 'messaging_gdpr_erasure_total',
      help: 'Total number of GDPR erasure requests processed',
      labelNames: ['tenant'],
      registers: [this.registry],
    });
  }

  // ── Public metric recording methods ─────────────────────────────

  /** Increment messages_total counter. */
  incrementMessages(tenant: string, contentType: string, channelType: string): void {
    this.messagesTotal.inc({ tenant, content_type: contentType, channel_type: channelType });
  }

  /** Increment channels_created_total counter. */
  incrementChannelsCreated(tenant: string, channelType: string): void {
    this.channelsCreatedTotal.inc({ tenant, channel_type: channelType });
  }

  /** Observe message send-to-deliver latency in seconds. */
  observeMessageLatency(durationSeconds: number): void {
    this.messageLatency.observe(durationSeconds);
  }

  /** Set the current number of WebSocket connections. */
  setWebsocketConnections(count: number): void {
    this.websocketConnections.set(count);
  }

  /** Set the number of pending outbox events. */
  setOutboxPending(count: number): void {
    this.outboxPending.set(count);
  }

  /** Increment media_uploads_total counter. */
  incrementMediaUploads(tenant: string, mimeType: string): void {
    this.mediaUploadsTotal.inc({ tenant, mime_type: mimeType });
  }

  /** Set storage usage gauge for a tenant. */
  setStorageUsed(tenant: string, bytes: number): void {
    this.storageUsedBytes.set({ tenant }, bytes);
  }

  /** Increment rate_limit_hits_total counter. */
  incrementRateLimitHits(action: string): void {
    this.rateLimitHitsTotal.inc({ action });
  }

  /**
   * Increment dead-letter counter when an outbox event is dead-lettered.
   * @see MSG-HIGH-006 (dead-letter metric counter)
   */
  incrementDeadLetter(): void {
    this.deadLetterTotal.inc();
  }

  /**
   * Increment GDPR erasure counter.
   * @see MSG-HIGH-027 (GDPR erasure metric counter)
   */
  incrementGdprErasure(tenant: string): void {
    this.gdprErasureTotal.inc({ tenant });
  }

  // ── Prometheus scrape endpoint support ──────────────────────────

  /** Get all metrics in Prometheus exposition format. */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /** Get the Content-Type header for Prometheus responses. */
  getContentType(): string {
    return this.registry.contentType;
  }
}
