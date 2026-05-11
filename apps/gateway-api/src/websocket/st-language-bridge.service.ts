import * as fs from 'fs';

import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  connect,
  NatsConnection,
  Subscription,
  StringCodec,
  ConnectionOptions,
  headers as natsHeaders,
} from 'nats';

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
  private connection: NatsConnection | null = null;
  private subscriptions: Subscription[] = [];
  private readonly sc = StringCodec();

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

    await this.connectToNats();

    // Wire up the gateway delegate so st:request messages flow through NATS
    this.stGateway.setNatsDelegate(
      (tenantId: string, request: STRequest) => this.sendRequest(tenantId, request),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  // -----------------------------------------------------------------------
  // NATS connection (same pattern as NatsBridgeService)
  // -----------------------------------------------------------------------

  private async connectToNats(): Promise<void> {
    /** SEC-H01: Use shared NATS connection factory for consistent auth across all services. */
    const connectionOptions: ConnectionOptions = {
      ...buildNatsConnectionOptions('gateway-api-st-language-bridge'),
    };

    // TLS
    const tlsEnabled = this.configService.get<string>('NATS_TLS_ENABLED', 'false') === 'true';
    if (tlsEnabled) {
      const tlsCaPath = this.configService.get<string>('NATS_TLS_CA');
      const tlsCertPath = this.configService.get<string>('NATS_TLS_CERT');
      const tlsKeyPath = this.configService.get<string>('NATS_TLS_KEY');

      connectionOptions.tls = {
        ...(tlsCaPath ? { ca: fs.readFileSync(tlsCaPath, 'utf8') } : {}),
        ...(tlsCertPath ? { cert: fs.readFileSync(tlsCertPath, 'utf8') } : {}),
        ...(tlsKeyPath ? { key: fs.readFileSync(tlsKeyPath, 'utf8') } : {}),
      };
    }

    // Auth
    const authToken = this.configService.get<string>('NATS_AUTH_TOKEN');
    const authUser = this.configService.get<string>('NATS_AUTH_USER');
    const authPass = this.configService.get<string>('NATS_AUTH_PASS');

    if (authToken) {
      connectionOptions.token = authToken;
    } else if (authUser && authPass) {
      connectionOptions.user = authUser;
      connectionOptions.pass = authPass;
    }

    try {
      this.connection = await connect(connectionOptions);
      this.logger.log(`Connected to NATS at ${Array.isArray(connectionOptions.servers) ? connectionOptions.servers.join(',') : (connectionOptions.servers ?? 'unknown')} for ST Language Bridge`);

      // Subscribe to server-push events
      this.subscribeToAutomationEvents();
      this.handleConnectionEvents();
    } catch (error) {
      this.logger.error(`Failed to connect to NATS: ${(error as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // NATS request-reply (gateway → sensor-service)
  // -----------------------------------------------------------------------

  /**
   * Send a request to sensor-service via NATS request-reply pattern.
   * The tenant ID is passed via NATS headers for isolation.
   */
  async sendRequest(tenantId: string, request: STRequest): Promise<unknown> {
    if (!this.connection || this.connection.isClosed()) {
      throw new Error('NATS connection not available');
    }

    const subject = `st.language.${request.type}`;
    const timeout = NATS_TIMEOUTS[subject] ?? 5_000;

    // Build NATS headers with tenant context
    const h = natsHeaders();
    h.set('x-tenant-id', tenantId);

    const payload = this.sc.encode(JSON.stringify(request));

    const msg = await this.connection.request(subject, payload, {
      timeout,
      headers: h,
    });

    const decoded = this.sc.decode(msg.data);
    return JSON.parse(decoded);
  }

  // -----------------------------------------------------------------------
  // NATS event subscriptions (sensor-service → gateway → WS clients)
  // -----------------------------------------------------------------------

  private subscribeToAutomationEvents(): void {
    if (!this.connection) return;

    // AutomationProgramSaved events
    this.subscribeToEvent(
      'events.AutomationProgramSaved.>',
      'diagnostics_update',
    );

    // AutomationProgramDeployed events
    this.subscribeToEvent(
      'events.AutomationProgramDeployed.>',
      'program_deployed',
    );

    // AutomationTagsUpdated events (IntelliSense cache invalidation)
    this.subscribeToEvent(
      'events.AutomationTagsUpdated.>',
      'tags_changed',
    );

    // AutomationFBDefinitionsChanged events
    this.subscribeToEvent(
      'events.AutomationFBDefinitionsChanged.>',
      'fb_definitions_changed',
    );
  }

  private subscribeToEvent(subject: string, pushType: string): void {
    if (!this.connection) return;

    const sub = this.connection.subscribe(subject);
    this.subscriptions.push(sub);
    this.logger.log(`Subscribed to ${subject}`);

    (async () => {
      for await (const msg of sub) {
        try {
          const data = JSON.parse(this.sc.decode(msg.data)) as AutomationEvent;

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

  private handleConnectionEvents(): void {
    if (!this.connection) return;

    const connection = this.connection;
    (async () => {
      for await (const status of connection.status()) {
        const statusType = status.type as string;
        switch (statusType) {
          case 'disconnect':
            this.logger.warn('NATS disconnected (ST Language Bridge)');
            break;
          case 'reconnect':
            this.logger.log('NATS reconnected — re-subscribing to automation events');
            this.subscriptions = [];
            this.subscribeToAutomationEvents();
            break;
          case 'error':
            this.logger.error(`NATS error: ${typeof status.data === 'string' ? status.data : JSON.stringify(status.data)}`);
            break;
        }
      }
    })().catch((error) => {
      this.logger.error(`NATS status loop error: ${(error as Error).message}`);
    });
  }

  private async disconnect(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }

    if (this.connection) {
      await this.connection.drain();
      this.logger.log('NATS connection closed (ST Language Bridge)');
    }
  }

  isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }
}
