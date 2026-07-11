/**
 * @module KnowledgeExtractionService
 * @description Hourly batch pipeline for extracting domain entity references
 * and operational knowledge from messages. Uses regex-first pass for tank codes,
 * then calls farm-service for tenant tank registry validation.
 *
 * Creates entity references in message_entity_references and knowledge entries
 * for actionable content (feeding schedules, water quality notes, incident reports).
 *
 * SECURITY (C-07): This service runs as a cron job outside of HTTP request context,
 * so the per-request TenantSchemaMiddleware / TenantConnectionBootstrap search_path
 * patching does NOT apply. The default connection uses `search_path=messaging,public`,
 * which is the template schema — not any tenant's data.
 *
 * To enforce tenant isolation, the batch iterates over all provisioned tenant
 * schemas (via `listTenantSchemas()`) and pins transaction-local `search_path`
 * to the tenant's schema for every batch query. The tank registry fetch also
 * sends the tenantId so farm-service can return the correct tenant's registry.
 *
 * @see ADR-012 section 12.3 (Knowledge Extraction)
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';
import { pinTenantSchemaTransactionSearchPath } from '@aquaculture/backend-common/database';

import {
  MessageEntityReference,
  DomainEntityType,
} from '../entities/message-entity-reference.entity';
import {
  KnowledgeEntry,
  KnowledgeCategory,
} from '../entities/knowledge-entry.entity';
import { AiPrivacyService } from './ai-privacy.service';

/** NATS request timeout in milliseconds (30 seconds). */
const NATS_TIMEOUT_MS = 30_000;

/**
 * Regex to validate tenant schema names (tenant_<16 hex chars>).
 * Used to prevent SQL injection when routing tenant schema work.
 */
const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;

/** Regex patterns for extracting tank code references from messages. */
const TANK_CODE_PATTERNS: RegExp[] = [
  /\bTank[-\s]?([A-Z]\d{1,3})\b/gi,
  /\b([A-Z]\d{1,2})\b/g,
];

/** Keywords indicating feeding-related knowledge. */
const FEEDING_KEYWORDS = ['fed', 'feeding', 'feed rate', 'kg/m2', 'fcr', 'pellet'];

/** Keywords indicating water quality-related knowledge. */
const WQ_KEYWORDS = ['ph', 'dissolved oxygen', 'do level', 'ammonia', 'nitrite', 'temperature', 'salinity'];

/** Keywords indicating incident reports. */
const INCIDENT_KEYWORDS = ['mortality', 'died', 'disease', 'infection', 'leak', 'alarm', 'emergency'];

/**
 * Tank registry entry from farm-service.
 */
interface TankRegistryEntry {
  id: string;
  code: string;
  name: string;
}

/**
 * Raw message for knowledge processing.
 */
interface ProcessableMessage {
  id: string;
  channelId: string;
  senderId: string;
  content: string;
  createdAt: Date;
  /**
   * ORPHAN-MEDIUM-336: the authoritative tenant UUID, carried on every
   * message row (Message entity `tenantId`, MSG-HIGH-010). All rows in a
   * given tenant_<uuid> schema share it — it is the canonical tenant key the
   * farm getTankRegistry responder requires, recovered here WITHOUT the lossy
   * schema-name (tenant_<16hex> truncates the UUID and cannot be reversed).
   */
  tenantId: string;
}

@Injectable()
export class KnowledgeExtractionService {
  private readonly logger = new Logger(KnowledgeExtractionService.name);
  private isProcessing = false;

  constructor(
    @InjectRepository(MessageEntityReference)
    private readonly entityRefRepo: Repository<MessageEntityReference>,
    @InjectRepository(KnowledgeEntry)
    private readonly knowledgeRepo: Repository<KnowledgeEntry>,
    private readonly dataSource: DataSource,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    private readonly privacyService: AiPrivacyService,
  ) {}

  /**
   * Cron job: every hour, process messages from the last hour for knowledge extraction.
   *
   * SECURITY (C-07): Iterates over all tenant schemas individually to ensure
   * knowledge extraction is tenant-scoped. Never queries the template schema
   * for message data.
   */
  @Cron('0 * * * *')
  async processHourlyBatch(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug('Knowledge extraction already in progress, skipping');
      return;
    }

    this.isProcessing = true;
    try {
      await this.runBatch();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Knowledge extraction batch failed: ${message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process messages from the last hour for knowledge extraction.
   *
   * SECURITY (C-07): This method iterates over each provisioned tenant schema
   * and processes messages within that schema's scope. Each tenant's queries
   * use an explicit transaction-local search_path pin to the tenant schema, ensuring:
   *   - No cross-tenant data leakage between batches
   *   - Knowledge entries and entity references are written to the correct
   *     tenant schema
   *   - The tank registry is fetched per-tenant from farm-service
   *   - Failures in one tenant's batch do not affect other tenants
   */
  private async runBatch(): Promise<void> {
    const tenantSchemas = await this.listTenantSchemas();

    if (tenantSchemas.length === 0) {
      this.logger.debug('No tenant schemas found, skipping knowledge extraction');
      return;
    }

    this.logger.debug(
      `Knowledge extraction: processing ${tenantSchemas.length} tenant schemas`,
    );

    for (const schema of tenantSchemas) {
      try {
        await this.runBatchForTenantSchema(schema);
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Knowledge extraction failed for schema ${schema}: ${errMessage}`,
        );
      }
    }
  }

  /**
   * Process a single tenant schema's messages for knowledge extraction.
   *
   * SECURITY (C-07): All database operations within this method use a dedicated
   * QueryRunner with search_path pinned to the tenant's schema. This
   * guarantees tenant isolation even though we're running outside HTTP context.
   *
   * @param tenantSchema - Validated tenant schema name (e.g. "tenant_4b529829ea7948da")
   */
  private async runBatchForTenantSchema(tenantSchema: string): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Pin search_path to the specific tenant schema for all subsequent queries
      await pinTenantSchemaTransactionSearchPath(queryRunner, 'messaging', tenantSchema);

      const messages: ProcessableMessage[] = await queryRunner.query(
        `SELECT m."id", m."channelId", m."senderId", m."content", m."createdAt", m."tenantId"
         FROM "messages" m
         LEFT JOIN "message_entity_references" mer ON mer."messageId" = m."id"
         WHERE m."createdAt" > $1
           AND m."isDeleted" = false
           AND m."content" IS NOT NULL
           AND m."content" != ''
           AND mer."id" IS NULL
         ORDER BY m."createdAt" ASC
         LIMIT 500`,
        [oneHourAgo],
      );

      if (messages.length === 0) {
        await queryRunner.commitTransaction();
        return;
      }

      this.logger.debug(
        `Processing ${messages.length} messages for schema ${tenantSchema}`,
      );

      // Fetch tank registry for this tenant from farm-service. All rows in this
      // pinned tenant schema share one tenantId (ORPHAN-MEDIUM-336) — pass that
      // canonical UUID so the responder's fail-closed, GUC-asserted
      // runInTenantRead path returns the real registry (a tenant_<16hex> schema
      // name cannot be mapped back to the UUID the responder requires).
      const tenantId = messages[0]?.tenantId;
      if (!tenantId) {
        // messages.length > 0 is guaranteed above; a missing tenantId would mean
        // a data-integrity break (Message.tenantId is NOT NULL). Fail safe:
        // extraction without a tank registry rather than a bad NATS request.
        this.logger.warn(
          `Schema ${tenantSchema}: ${messages.length} message(s) but no tenantId — skipping tank-registry fetch`,
        );
        await queryRunner.commitTransaction();
        return;
      }
      const tankRegistry = await this.fetchTankRegistry(tenantId);

      for (const msg of messages) {
        try {
          await this.processMessage(msg, tankRegistry, queryRunner);
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Knowledge extraction failed for message ${msg.id} in ${tenantSchema}: ${errMessage}`,
          );
        }
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Process a single message for entity references and knowledge extraction.
   *
   * Uses the provided QueryRunner (which has search_path pinned to the tenant schema)
   * to ensure all writes go to the correct tenant.
   *
   * @param msg - The message to process
   * @param tankRegistry - The tenant's tank registry for validation
   * @param queryRunner - QueryRunner with tenant-scoped search_path
   */
  private async processMessage(
    msg: ProcessableMessage,
    tankRegistry: TankRegistryEntry[],
    queryRunner: QueryRunner,
  ): Promise<void> {
    const content = msg.content;
    const contentLower = content.toLowerCase();

    // Extract tank references via regex
    const tankRefs = this.extractTankReferences(content, tankRegistry);

    // Store entity references (via tenant-scoped QueryRunner)
    for (const tankRef of tankRefs) {
      const existing = await queryRunner.manager.findOne(MessageEntityReference, {
        where: {
          messageId: msg.id,
          entityType: DomainEntityType.TANK,
          entityId: tankRef.id,
        },
      });

      if (!existing) {
        const ref = queryRunner.manager.create(MessageEntityReference, {
          messageId: msg.id,
          messageCreatedAt: msg.createdAt,
          entityType: DomainEntityType.TANK,
          entityId: tankRef.id,
          confidence: 1.0,
        });
        await queryRunner.manager.save(MessageEntityReference, ref);
      }
    }

    // Check for actionable knowledge content
    const category = this.classifyContent(contentLower);
    if (category && tankRefs.length > 0) {
      const entities = tankRefs.map((t) => ({
        type: 'tank',
        id: t.id,
        name: t.code,
      }));

      const entry = queryRunner.manager.create(KnowledgeEntry, {
        sourceMessageId: msg.id,
        sourceMessageCreatedAt: msg.createdAt,
        category,
        content: msg.content,
        entities,
        confidence: 0.8,
      });
      await queryRunner.manager.save(KnowledgeEntry, entry);

      this.logger.debug(
        `Knowledge entry created: ${category} for message ${msg.id}`,
      );
    }
  }

  /**
   * Extract tank references from message content using regex patterns,
   * validated against the tenant's tank registry.
   */
  private extractTankReferences(
    content: string,
    tankRegistry: TankRegistryEntry[],
  ): TankRegistryEntry[] {
    const foundCodes = new Set<string>();

    for (const pattern of TANK_CODE_PATTERNS) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const code = match[1] || match[0];
        foundCodes.add(code.toUpperCase());
      }
    }

    // Match against tank registry for validation
    return tankRegistry.filter((tank) =>
      foundCodes.has(tank.code.toUpperCase()),
    );
  }

  /**
   * Classify message content into a knowledge category based on keyword matching.
   * Returns null if no actionable category is detected.
   */
  private classifyContent(contentLower: string): KnowledgeCategory | null {
    const hasFeeding = FEEDING_KEYWORDS.some((kw) => contentLower.includes(kw));
    if (hasFeeding) return KnowledgeCategory.FEEDING_SCHEDULE;

    const hasIncident = INCIDENT_KEYWORDS.some((kw) => contentLower.includes(kw));
    if (hasIncident) return KnowledgeCategory.INCIDENT_REPORT;

    const hasWq = WQ_KEYWORDS.some((kw) => contentLower.includes(kw));
    if (hasWq) return KnowledgeCategory.WATER_QUALITY_NOTE;

    return null;
  }

  /**
   * Fetch the tenant's tank registry from farm-service via NATS request-reply.
   * Returns an empty array if farm-service is unavailable (graceful degradation).
   *
   * ORPHAN-MEDIUM-336: sends the canonical tenant UUID — the key the
   * `request.farm.getTankRegistry` responder validates and feeds to its
   * fail-closed, RLS-GUC-asserted `runInTenantRead`. (It previously sent the
   * tenant SCHEMA name, which the responder rejects as a non-UUID and answers
   * empty — the extraction was silently non-functional.)
   *
   * @param tenantId - Authoritative tenant UUID (from the tenant's own message rows)
   */
  private async fetchTankRegistry(tenantId: string): Promise<TankRegistryEntry[]> {
    const response = await firstValueFrom(
      this.natsClient
        .send<TankRegistryEntry[]>('request.farm.getTankRegistry', {
          tenantId,
        })
        .pipe(
          timeout(NATS_TIMEOUT_MS),
          catchError((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Failed to fetch tank registry for tenant ${tenantId}: ${errMsg}`,
            );
            return of([]);
          }),
        ),
    );

    return response ?? [];
  }

  /**
   * List all provisioned tenant schemas from the database.
   *
   * SECURITY: Only returns schemas matching the strict tenant_<16 hex> pattern.
   * This prevents processing non-tenant schemas even if they match a looser pattern.
   */
  private async listTenantSchemas(): Promise<string[]> {
    const rows: { schema_name: string }[] = await this.dataSource.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
       ORDER BY schema_name`,
    );
    return rows
      .map((r) => r.schema_name)
      .filter((name) => TENANT_SCHEMA_REGEX.test(name));
  }
}
