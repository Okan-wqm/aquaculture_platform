import { PersistentNatsConnection } from '@aquaculture/backend-common/nats';
// NATS v3 (@nats-io/* 3.x): StringCodec was REMOVED — encode a string by
// passing it directly to request()/publish(), decode via msg.string(). The wire
// bytes are UTF-8 either way, so this is byte-for-byte compatible with the v2 producer.
import { headers as natsHeaders, type NatsConnection } from '@nats-io/nats-core';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { STLanguageGateway } from './st-language.gateway';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface STRequest {
  type: 'analyze' | 'hover' | 'complete' | 'format' | 'outline' | 'definition' | 'references';
  requestId: string;
  programId?: string;
  code: string;
  position?: { line: number; character: number };
  range?: { startLine: number; endLine: number };
}

interface AutomationEvent {
  tenantId: string;
  programId?: string;
  timestamp: string;
  [key: string]: unknown;
}

/** NATS subject → request timeout mapping */
const NATS_TIMEOUTS: Record<string, number> = {
  'st.language.analyze': 10_000,
  'st.language.complete': 3_000,
  'st.language.hover': 3_000,
  'st.language.format': 5_000,
  'st.language.outline': 5_000,
  'st.language.definition': 3_000,
  'st.language.references': 5_000,
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class STLanguageBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(STLanguageBridgeService.name);
  /**
   * PLAT-HIGH-939: keeps trying until the broker answers. Options come only
   * from the factory (INFRA-HIGH-238), and the client carries the
   * subscriptions across reconnects, so they are made once per connection
   * (PLAT-MEDIUM-940).
   */
  private readonly nats = new PersistentNatsConnection({
    name: 'gateway-api-st-language-bridge',
    onConnected: (connection) => this.subscribeToAutomationEvents(connection),
  });

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(STLanguageGateway) private readonly stGateway: STLanguageGateway,
  ) {}

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    const natsEnabled = this.configService.get<string>('NATS_ENABLED', 'true') === 'true';
    if (!natsEnabled) {
      this.logger.log('ST Language NATS Bridge is disabled');
      return;
    }

    this.nats.open();

    // Wire up the gateway delegate so st:request messages flow through NATS
    this.stGateway.setNatsDelegate(
      (tenantId: string, request: STRequest) => this.sendRequest(tenantId, request),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.nats.close();
  }

  // -----------------------------------------------------------------------
  // NATS request-reply (gateway → sensor-service)
  // -----------------------------------------------------------------------

  /**
   * Send a request to sensor-service via NATS request-reply pattern.
   * The tenant ID is passed via NATS headers for isolation.
   */
  async sendRequest(tenantId: string, request: STRequest): Promise<unknown> {
    const connection = this.nats.current;
    if (connection === null || connection.isClosed()) {
      throw new Error('NATS connection not available');
    }

    const subject = `st.language.${request.type}`;
    const timeout = NATS_TIMEOUTS[subject] ?? 5_000;

    // Build NATS headers with tenant context
    const h = natsHeaders();
    h.set('x-tenant-id', tenantId);

    const payload = JSON.stringify(request);

    const msg = await connection.request(subject, payload, {
      timeout,
      headers: h,
    });

    const decoded = msg.string();
    return JSON.parse(decoded);
  }

  // -----------------------------------------------------------------------
  // NATS event subscriptions (sensor-service → gateway → WS clients)
  // -----------------------------------------------------------------------

  private subscribeToAutomationEvents(connection: NatsConnection): void {
    // AutomationProgramSaved events
    this.subscribeToEvent(
      connection,
      'events.AutomationProgramSaved.>',
      'diagnostics_update',
    );

    // AutomationProgramDeployed events
    this.subscribeToEvent(
      connection,
      'events.AutomationProgramDeployed.>',
      'program_deployed',
    );

    // AutomationTagsUpdated events (IntelliSense cache invalidation)
    this.subscribeToEvent(
      connection,
      'events.AutomationTagsUpdated.>',
      'tags_changed',
    );

    // AutomationFBDefinitionsChanged events
    this.subscribeToEvent(
      connection,
      'events.AutomationFBDefinitionsChanged.>',
      'fb_definitions_changed',
    );
  }

  private subscribeToEvent(connection: NatsConnection, subject: string, pushType: string): void {
    const sub = connection.subscribe(subject);
    this.logger.log(`Subscribed to ${subject}`);

    (async () => {
      for await (const msg of sub) {
        try {
          const data = JSON.parse(msg.string()) as AutomationEvent;

          if (!data.tenantId) {
            this.logger.warn(`${subject} event missing tenantId, dropping`);
            continue;
          }

          // Push to all WS clients of this tenant
          this.stGateway.pushToTenant(data.tenantId, 'st:push', {
            type: pushType,
            data,
            timestamp: data.timestamp ?? new Date().toISOString(),
          });
        } catch (e) {
          this.logger.warn(`Failed to process ${subject}: ${(e as Error).message}`);
        }
      }
    })().catch((error) => {
      this.logger.error(`NATS ${subject} subscription loop error: ${(error as Error).message}`);
    });
  }

  // -----------------------------------------------------------------------
  // Connection management
  // -----------------------------------------------------------------------

  isConnected(): boolean {
    return this.nats.isConnected();
  }
}
