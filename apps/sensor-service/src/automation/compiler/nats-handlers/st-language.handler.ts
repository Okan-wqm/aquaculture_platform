import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  connect,
  NatsConnection,
  Subscription,
  StringCodec,
} from 'nats';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common';

import { NATS_SUBJECTS } from '../compiler.constants';
import { NatsLanguageRequest, NatsLanguageReply } from '../compiler.types';
import { STLanguageService } from '../services/st-language.service';

/**
 * ST Language NATS Handler
 *
 * Listens on st.language.* subjects for request-reply pattern.
 * Gateway-api sends WS requests via NATS, this handler processes them
 * and returns results.
 *
 * Uses raw NATS connection (not JetStream) for request-reply,
 * since JetStream is designed for persistent pub/sub, not RPC.
 */
@Injectable()
export class STLanguageHandler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(STLanguageHandler.name);
  private connection: NatsConnection | null = null;
  private readonly subscriptions: Subscription[] = [];
  private readonly codec = StringCodec();
  private readonly natsUrl: string;

  constructor(
    private readonly languageService: STLanguageService,
    private readonly configService: ConfigService,
  ) {
    this.natsUrl = this.configService.get<string>(
      'NATS_URL',
      'nats://localhost:4222',
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.connectAndSubscribe();
    } catch (error) {
      this.logger.warn(
        `Failed to connect NATS for ST language handler: ${(error as Error).message}. ` +
          'Will retry on next request.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions.length = 0;

    if (this.connection) {
      await this.connection.drain();
      this.connection = null;
    }
  }

  private async connectAndSubscribe(): Promise<void> {
    /** SEC-H01: Use shared NATS connection factory for consistent auth. */
    this.connection = await connect({
      ...buildNatsConnectionOptions(`sensor-service-st-language-${process.pid}`),
      maxReconnectAttempts: -1,
    });

    this.logger.log('Connected to NATS for ST language request-reply');

    // Subscribe to each language service subject
    this.subscribeToSubject(NATS_SUBJECTS.ANALYZE, (req) =>
      this.handleAnalyze(req),
    );
    this.subscribeToSubject(NATS_SUBJECTS.COMPLETE, (req) =>
      this.handleComplete(req),
    );
    this.subscribeToSubject(NATS_SUBJECTS.HOVER, (req) =>
      this.handleHover(req),
    );
    this.subscribeToSubject(NATS_SUBJECTS.FORMAT, (req) =>
      this.handleFormat(req),
    );
    this.subscribeToSubject(NATS_SUBJECTS.OUTLINE, (req) =>
      this.handleOutline(req),
    );
    this.subscribeToSubject(NATS_SUBJECTS.DEFINITION, (req) =>
      this.handleDefinition(req),
    );
    this.subscribeToSubject(NATS_SUBJECTS.REFERENCES, (req) =>
      this.handleReferences(req),
    );

    this.logger.log(
      `Subscribed to ${Object.values(NATS_SUBJECTS).length} ST language subjects`,
    );
  }

  private subscribeToSubject(
    subject: string,
    handler: (
      req: NatsLanguageRequest & { tenantId: string },
    ) => Promise<NatsLanguageReply>,
  ): void {
    if (!this.connection) return;

    // Use queue group for load balancing across multiple sensor-service instances
    const sub = this.connection.subscribe(subject, {
      queue: 'st-language-workers',
    });

    this.subscriptions.push(sub);

    // Process messages asynchronously
    (async () => {
      for await (const msg of sub) {
        try {
          const request: NatsLanguageRequest = JSON.parse(
            this.codec.decode(msg.data),
          );

          // Tenant ID from NATS headers (set by gateway-api)
          const tenantId = msg.headers?.get('x-tenant-id') || '';

          const reply = await handler({
            ...request,
            tenantId,
          });

          if (msg.reply) {
            msg.respond(this.codec.encode(JSON.stringify(reply)));
          }
        } catch (error) {
          this.logger.error(
            `Error handling ${subject}: ${(error as Error).message}`,
          );

          if (msg.reply) {
            const errorReply: NatsLanguageReply = {
              success: false,
              requestId: '',
              type: 'error',
              data: null,
              error: {
                code: 'HANDLER_ERROR',
                message: (error as Error).message,
              },
            };
            msg.respond(this.codec.encode(JSON.stringify(errorReply)));
          }
        }
      }
    })().catch((err) => {
      if (!err.message?.includes('closed')) {
        this.logger.error(
          `Subscription loop error for ${subject}: ${err.message}`,
        );
      }
    });
  }

  // ---- Handler methods ----

  private async handleAnalyze(
    req: NatsLanguageRequest & { tenantId: string },
  ): Promise<NatsLanguageReply> {
    this.logger.debug(
      `Analyze request ${req.requestId}, tenant=${req.tenantId}, code size=${req.code.length}`,
    );

    return this.languageService.analyze(
      req.code,
      req.tenantId,
      req.requestId,
      req.programId,
    );
  }

  private async handleComplete(
    req: NatsLanguageRequest & { tenantId: string },
  ): Promise<NatsLanguageReply> {
    if (!req.position) {
      return {
        success: false,
        requestId: req.requestId,
        type: 'error',
        data: null,
        error: {
          code: 'MISSING_POSITION',
          message: 'Position is required for completion requests',
        },
      };
    }

    return this.languageService.complete(
      req.code,
      req.position,
      req.tenantId,
      req.requestId,
      req.programId,
    );
  }

  private async handleHover(
    req: NatsLanguageRequest & { tenantId: string },
  ): Promise<NatsLanguageReply> {
    if (!req.position) {
      return {
        success: false,
        requestId: req.requestId,
        type: 'error',
        data: null,
        error: {
          code: 'MISSING_POSITION',
          message: 'Position is required for hover requests',
        },
      };
    }

    return this.languageService.hover(
      req.code,
      req.position,
      req.requestId,
    );
  }

  private async handleFormat(
    req: NatsLanguageRequest & { tenantId: string },
  ): Promise<NatsLanguageReply> {
    return this.languageService.format(req.code, req.requestId);
  }

  private async handleOutline(
    req: NatsLanguageRequest & { tenantId: string },
  ): Promise<NatsLanguageReply> {
    this.logger.debug(
      `Outline request ${req.requestId}, tenant=${req.tenantId}, code size=${req.code.length}`,
    );

    return this.languageService.outline(
      req.code,
      req.tenantId,
      req.requestId,
      req.programId,
    );
  }

  private async handleDefinition(
    req: NatsLanguageRequest & { tenantId: string },
  ): Promise<NatsLanguageReply> {
    if (!req.position) {
      return {
        success: false,
        requestId: req.requestId,
        type: 'error',
        data: null,
        error: {
          code: 'MISSING_POSITION',
          message: 'Position is required for definition requests',
        },
      };
    }

    return this.languageService.definition(
      req.code,
      req.position,
      req.tenantId,
      req.requestId,
      req.programId,
    );
  }

  private async handleReferences(
    req: NatsLanguageRequest & { tenantId: string },
  ): Promise<NatsLanguageReply> {
    if (!req.position) {
      return {
        success: false,
        requestId: req.requestId,
        type: 'error',
        data: null,
        error: {
          code: 'MISSING_POSITION',
          message: 'Position is required for references requests',
        },
      };
    }

    return this.languageService.references(
      req.code,
      req.position,
      req.tenantId,
      req.requestId,
      req.programId,
    );
  }
}
