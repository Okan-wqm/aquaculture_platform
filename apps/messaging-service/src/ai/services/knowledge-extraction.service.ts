/**
 * @module KnowledgeExtractionService
 * @description Hourly batch pipeline for extracting domain entity references
 * and operational knowledge from messages. Uses regex-first pass for tank codes,
 * then calls farm-service for tenant tank registry validation.
 *
 * Creates entity references in message_entity_references and knowledge entries
 * for actionable content (feeding schedules, water quality notes, incident reports).
 *
 * @see ADR-012 section 12.3 (Knowledge Extraction)
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';

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
   * Process a batch of messages from the last hour.
   * Performs regex-based entity extraction and knowledge entry creation.
   */
  private async runBatch(): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const messages: ProcessableMessage[] = await this.dataSource.query(
      `SELECT m."id", m."channelId", m."senderId", m."content", m."createdAt"
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
      return;
    }

    this.logger.debug(`Processing ${messages.length} messages for knowledge extraction`);

    // Fetch tank registry from farm-service
    const tankRegistry = await this.fetchTankRegistry();

    for (const msg of messages) {
      try {
        await this.processMessage(msg, tankRegistry);
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Knowledge extraction failed for message ${msg.id}: ${errMessage}`,
        );
      }
    }
  }

  /**
   * Process a single message for entity references and knowledge extraction.
   */
  private async processMessage(
    msg: ProcessableMessage,
    tankRegistry: TankRegistryEntry[],
  ): Promise<void> {
    const content = msg.content;
    const contentLower = content.toLowerCase();

    // Extract tank references via regex
    const tankRefs = this.extractTankReferences(content, tankRegistry);

    // Store entity references
    for (const tankRef of tankRefs) {
      const existing = await this.entityRefRepo.findOne({
        where: {
          messageId: msg.id,
          entityType: DomainEntityType.TANK,
          entityId: tankRef.id,
        },
      });

      if (!existing) {
        const ref = this.entityRefRepo.create({
          messageId: msg.id,
          messageCreatedAt: msg.createdAt,
          entityType: DomainEntityType.TANK,
          entityId: tankRef.id,
          confidence: 1.0,
        });
        await this.entityRefRepo.save(ref);
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

      const entry = this.knowledgeRepo.create({
        sourceMessageId: msg.id,
        sourceMessageCreatedAt: msg.createdAt,
        category,
        content: msg.content,
        entities,
        confidence: 0.8,
      });
      await this.knowledgeRepo.save(entry);

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
   */
  private async fetchTankRegistry(): Promise<TankRegistryEntry[]> {
    const response = await firstValueFrom(
      this.natsClient
        .send<TankRegistryEntry[]>('request.farm.getTankRegistry', {})
        .pipe(
          timeout(NATS_TIMEOUT_MS),
          catchError((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Failed to fetch tank registry: ${errMsg}`);
            return of([]);
          }),
        ),
    );

    return response ?? [];
  }
}
