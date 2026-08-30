import {
  Injectable,
  Logger,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, IsNull, DataSource } from 'typeorm';
import { firstValueFrom, timeout } from 'rxjs';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';

import { ChannelDetectionLog, UserAction } from '../database/entities/channel-detection-log.entity';
import {
  SensorDataChannel,
  ChannelDataType,
  DiscoverySource,
} from '../database/entities/sensor-data-channel.entity';

/** DI token for the outbound NATS client used to reach ai-service. */
export const AI_NATS_CLIENT = 'AI_NATS_CLIENT';

/** NATS request timeout for the deterministic channel-detection round-trip. */
const AI_DETECT_TIMEOUT_MS = 15_000;

/** A channel proposal as returned by ai-service's detectChannels responder. */
interface AiChannelProposal {
  channelKey: string;
  displayLabel: string;
  dataType?: 'number' | 'boolean' | 'string';
  unit?: string;
  operationalMin?: number;
  operationalMax?: number;
}

/** Wire response from `request.ai.sensor.detectChannels`. */
interface DetectChannelsAiResponse {
  proposals: AiChannelProposal[];
  detectedFields: unknown[];
  confidence: 'high' | 'medium' | 'low';
  error?: { code: string; message: string };
}

/**
 * Channel definition proposed by AI or local fallback analysis
 */
export interface ProposedChannel {
  [key: string]: unknown;
  channelKey: string;
  displayLabel: string;
  dataType?: string;
  unit?: string;
  unitSymbol?: string;
  description?: string;
  physicalMin?: number;
  physicalMax?: number;
  operationalMin?: number;
  operationalMax?: number;
  displayOrder?: number;
}

/**
 * ChannelDetectionService
 * Manages AI-driven channel detection for sensors.
 * Accepts raw sensor data, calls AI service for analysis,
 * stores proposals, and handles approve/reject flow.
 */
@Injectable()
export class ChannelDetectionService {
  private readonly logger = new Logger(ChannelDetectionService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(ChannelDetectionLog)
    private readonly logRepo: Repository<ChannelDetectionLog>,
    @InjectRepository(SensorDataChannel)
    private readonly channelRepo: Repository<SensorDataChannel>,
    /**
     * SENSOR-MEDIUM-070: outbound NATS client to ai-service's
     * request.ai.sensor.detectChannels responder. Identity on the wire is this
     * service's mTLS NATS cert (ADR-015) — no forged x-user-payload user.
     */
    @Inject(AI_NATS_CLIENT)
    private readonly aiNatsClient: ClientProxy,
    /**
     * CIRCUIT-LOW-002 cure (channel-detection callsite): the cross-service AI
     * call runs through the canonical breaker (fail-closed); detectChannels'
     * try/catch degrades a tripped breaker or AI outage to local heuristics
     * instead of cascading into the sensor-ingestion pipeline.
     */
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /**
   * Detect channels from raw sensor data samples.
   * Calls AI service for analysis, falls back to local heuristics if unavailable.
   * Stores the proposal in channel_detection_log and returns the log entry.
   */
  async detectChannels(
    sensorId: string,
    tenantId: string,
    samples: unknown[],
  ): Promise<ChannelDetectionLog> {
    let aiAnalysis: Record<string, unknown>;
    let proposedChannels: ProposedChannel[];

    try {
      const result = await this.callAiService(samples, tenantId, sensorId);
      aiAnalysis = result.aiAnalysis;
      proposedChannels = result.proposedChannels;
    } catch (error) {
      this.logger.warn(
        `AI service unavailable, falling back to local analysis: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const result = this.localFallbackAnalysis(samples);
      aiAnalysis = result.aiAnalysis;
      proposedChannels = result.proposedChannels;
    }

    const log = this.logRepo.create({
      sensorId,
      tenantId,
      rawSample: samples,
      aiAnalysis,
      proposedChannels: proposedChannels as Record<string, unknown>[],
    });

    return this.logRepo.save(log);
  }

  /**
   * Approve a channel detection proposal.
   * Creates sensor_data_channels from proposedChannels (or modifications if provided).
   * Updates the log entry with userAction='approved' and finalChannels.
   */
  async approveProposal(
    proposalId: string,
    tenantId: string,
    modifications?: ProposedChannel[],
  ): Promise<SensorDataChannel[]> {
    const proposal = await this.logRepo.findOne({
      where: { id: proposalId, tenantId },
    });

    if (!proposal) {
      throw new NotFoundException(
        `Channel detection proposal with ID "${proposalId}" not found`,
      );
    }

    if (proposal.userAction) {
      throw new BadRequestException(`Proposal already ${proposal.userAction}`);
    }

    const channelsToCreate: ProposedChannel[] = modifications
      ?? (proposal.proposedChannels as ProposedChannel[]);

    // Check for existing channels to avoid duplicates
    const existingChannels = await this.channelRepo.find({
      where: { sensorId: proposal.sensorId, tenantId },
    });
    const existingKeys = new Set(existingChannels.map((c) => c.channelKey));

    // Log skipped channels
    for (const chDef of channelsToCreate) {
      if (existingKeys.has(chDef.channelKey)) {
        this.logger.debug(
          `Skipping channel "${chDef.channelKey}" — already exists for sensor ${proposal.sensorId}`,
        );
      }
    }

    return this.dataSource.transaction(async (manager) => {
      const channelRepo = tenantManagerRepo(manager, SensorDataChannel, tenantId);
      const logRepo = tenantManagerRepo(manager, ChannelDetectionLog, tenantId);

      // Batch create channels. Plain literals on purpose: saveMany runs the
      // repository's create() (and forces tenantId) itself — wrapping each
      // element in channelRepo.create() here constructed every entity twice.
      const channelEntities = channelsToCreate
        .filter(chDef => !existingKeys.has(chDef.channelKey))
        .map(chDef => ({
          sensorId: proposal.sensorId,
          channelKey: chDef.channelKey,
          displayLabel: chDef.displayLabel,
          description: chDef.description,
          dataType: this.mapDataType(chDef.dataType),
          unit: chDef.unit,
          unitSymbol: chDef.unitSymbol,
          physicalMin: chDef.physicalMin,
          physicalMax: chDef.physicalMax,
          operationalMin: chDef.operationalMin,
          operationalMax: chDef.operationalMax,
          displayOrder: chDef.displayOrder ?? 0,
          discoverySource: DiscoverySource.AUTO,
          discoveredAt: new Date(),
          isEnabled: true,
          calibrationEnabled: false,
          calibrationMultiplier: 1.0,
          calibrationOffset: 0.0,
        }));

      const created = await channelRepo.saveMany(channelEntities);

      // Update proposal with approval
      proposal.userAction = UserAction.APPROVED;
      proposal.finalChannels = (modifications ?? channelsToCreate) as Record<string, unknown>[];
      await logRepo.save(proposal);

      this.logger.log(
        `Approved proposal ${proposalId}: created ${created.length} channels for sensor ${proposal.sensorId}`,
      );

      return created;
    });
  }

  /**
   * Reject a channel detection proposal.
   * Sets userAction='rejected' on the log entry.
   */
  async rejectProposal(
    proposalId: string,
    tenantId: string,
  ): Promise<boolean> {
    const proposal = await this.logRepo.findOne({
      where: { id: proposalId, tenantId },
    });

    if (!proposal) {
      throw new NotFoundException(
        `Channel detection proposal with ID "${proposalId}" not found`,
      );
    }

    proposal.userAction = UserAction.REJECTED;
    await this.logRepo.save(proposal);

    this.logger.log(`Rejected proposal ${proposalId}`);

    return true;
  }

  /**
   * Get pending (unapproved/unrejected) proposals for a sensor.
   * Returns proposals where userAction IS NULL, ordered by createdAt DESC.
   */
  async getPendingProposals(
    sensorId: string,
    tenantId: string,
  ): Promise<ChannelDetectionLog[]> {
    return this.logRepo.find({
      where: {
        sensorId,
        tenantId,
        userAction: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Derive channel proposals from raw sensor samples via ai-service's
   * deterministic detectChannels responder (`request.ai.sensor.detectChannels`)
   * over NATS request-reply.
   *
   * SENSOR-MEDIUM-070: replaces the dead `/api/v2/ai/chat` HTTP POST that forged
   * an `x-user-payload` supervisor user and silently 404'd (ai-service AI chat is
   * NATS-only). Identity on the wire is now this service's mTLS NATS cert
   * (ADR-015), authorized by a first-class service principal on the ai-service
   * side — no fabricated user, no user RBAC.
   */
  private async callAiService(
    samples: unknown[],
    tenantId: string,
    sensorId?: string,
  ): Promise<{ aiAnalysis: Record<string, unknown>; proposedChannels: ProposedChannel[] }> {
    // CIRCUIT-LOW-002 cure: canonical breaker wrap, per-tenant key. fail-closed
    // because detectChannels' try/catch degrades a closed breaker or AI outage
    // to local heuristics — the same behaviour an error response triggers.
    const response = await this.circuitBreaker.execute<DetectChannelsAiResponse>({
      serviceName: 'sensor-channel-detection-ai',
      tenantId,
      options: {
        ...DEFAULT_BREAKER_OPTIONS,
        failureMode: 'fail-closed',
      },
      fn: async () =>
        firstValueFrom(
          this.aiNatsClient
            .send<DetectChannelsAiResponse>('request.ai.sensor.detectChannels', {
              tenantId,
              sensorId: sensorId ?? 'unknown',
              samples,
            })
            .pipe(timeout(AI_DETECT_TIMEOUT_MS)),
        ),
    });

    if (response.error) {
      // Surface as a throw so detectChannels' catch degrades to local heuristics.
      throw new Error(
        `AI channel detection failed: ${response.error.code} ${response.error.message}`,
      );
    }

    const proposedChannels: ProposedChannel[] = response.proposals.map((p) => ({
      channelKey: p.channelKey,
      displayLabel: p.displayLabel,
      dataType: p.dataType,
      unit: p.unit,
      operationalMin: p.operationalMin,
      operationalMax: p.operationalMax,
    }));

    if (proposedChannels.length === 0) {
      this.logger.warn(
        'AI channel detection returned no proposals, falling back to local analysis',
      );
      return this.localFallbackAnalysis(samples);
    }

    return {
      aiAnalysis: {
        detectedFields: response.detectedFields,
        confidence: response.confidence,
      },
      proposedChannels,
    };
  }

  /**
   * Local fallback analysis when AI service is unavailable.
   * Simple heuristic: iterate sample keys, infer types from values.
   */
  private localFallbackAnalysis(
    samples: unknown[],
  ): { aiAnalysis: Record<string, unknown>; proposedChannels: ProposedChannel[] } {
    const METADATA_KEYS = new Set(['id', 'sensor_id', 'sensorId', 'tenant_id', 'tenantId', 'timestamp', 'created_at', 'updated_at', 'createdAt', 'updatedAt']);

    const proposedChannels: ProposedChannel[] = [];
    const fieldStats: Record<string, { type: string; values: unknown[] }> = {};

    // Collect field info from all samples
    for (const sample of samples) {
      if (typeof sample !== 'object' || sample === null) continue;

      // Unwrap nested { timestamp, values: {...} } format
      const data = (typeof sample === 'object' && sample !== null && 'values' in (sample as Record<string, unknown>))
        ? (sample as Record<string, unknown>)['values'] as Record<string, unknown>
        : sample as Record<string, unknown>;

      for (const [key, value] of Object.entries(data)) {
        if (METADATA_KEYS.has(key)) continue;
        if (!fieldStats[key]) {
          fieldStats[key] = { type: typeof value, values: [] };
        }
        fieldStats[key].values.push(value);
      }
    }

    // Generate channel proposals from field stats
    let order = 0;
    for (const [key, stats] of Object.entries(fieldStats)) {
      const dataType = this.inferDataType(stats.type, stats.values);
      const displayLabel = this.formatDisplayLabel(key);

      proposedChannels.push({
        channelKey: key,
        displayLabel,
        dataType,
        displayOrder: order++,
      });
    }

    const aiAnalysis: Record<string, unknown> = {
      source: 'local_fallback',
      fieldsDetected: Object.keys(fieldStats).length,
      sampleCount: samples.length,
      fields: Object.entries(fieldStats).map(([key, stats]) => ({
        key,
        type: stats.type,
        sampleValues: stats.values.slice(0, 5),
      })),
    };

    return { aiAnalysis, proposedChannels };
  }

  /**
   * Infer ChannelDataType string from JavaScript typeof and sample values
   */
  private inferDataType(jsType: string, values: unknown[]): string {
    if (jsType === 'boolean') return ChannelDataType.BOOLEAN;
    if (jsType === 'number') return ChannelDataType.NUMBER;
    if (jsType === 'string') {
      // Check if values form a small set of distinct values (enum-like)
      const unique = new Set(values);
      if (unique.size <= 10 && values.length >= 2) {
        return ChannelDataType.ENUM;
      }
      return ChannelDataType.STRING;
    }
    return ChannelDataType.STRING;
  }

  /** Common abbreviations that should preserve their casing */
  private static readonly ABBREVIATION_MAP: Record<string, string> = {
    'ph': 'pH', 'do': 'DO', 'co2': 'CO2', 'orp': 'ORP',
    'ec': 'EC', 'tds': 'TDS', 'bod': 'BOD', 'cod': 'COD',
  };

  /**
   * Convert a snake_case or camelCase key into a human-readable display label.
   * Handles common scientific abbreviations (pH, DO, CO2, etc.).
   */
  private formatDisplayLabel(key: string): string {
    // Check full key against abbreviation map first
    const fullMatch = ChannelDetectionService.ABBREVIATION_MAP[key.toLowerCase()];
    if (fullMatch) return fullMatch;

    const label = key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    // Replace individual words that match abbreviations
    return label.replace(/\b\w+\b/g, (word) => {
      return ChannelDetectionService.ABBREVIATION_MAP[word.toLowerCase()] ?? word;
    });
  }

  /**
   * Map a string data type to the ChannelDataType enum
   */
  private mapDataType(dataType?: string): ChannelDataType {
    if (!dataType) return ChannelDataType.NUMBER;

    switch (dataType.toLowerCase()) {
      case 'number':
      case 'float':
      case 'integer':
      case 'int':
        return ChannelDataType.NUMBER;
      case 'boolean':
      case 'bool':
        return ChannelDataType.BOOLEAN;
      case 'enum':
        return ChannelDataType.ENUM;
      case 'string':
      case 'text':
        return ChannelDataType.STRING;
      default:
        return ChannelDataType.NUMBER;
    }
  }
}
