/**
 * FeedingProtocolV2 CRUD handler'ları.
 *
 * Her yazma yolu TEK doğrulama SSoT'sinden geçer (ProtocolValidationService) —
 * geometri/toplam kuralları resolver'da veya entity'de İKİNCİ kez yaşamaz.
 * Band feedId'leri gerçek, silinmemiş Feed ürünlerine işaret etmek zorundadır
 * (protokol hiçbir zaman havada yem referansı taşıyamaz — tier-3 kontrol).
 *
 * ARCHIVED geçişi aktif atamaları otomatik PAUSED yapar (D-10) ve her birine
 * durable `FeedingProtocolAssignmentPaused` event'i outbox'a yazılır — canlı
 * protokolün sessizce arşivlenip ünitelerin plansız kalması imkânsızdır (D-5
 * tespiti + Faz 5'teki UnfedUnitDetected bunun emniyet ağıdır).
 *
 * @module FeedingProtocol/Handlers
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import type { FeedingProtocolAssignmentPausedEvent } from '@platform/event-contracts';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import {
  ArchiveFeedingProtocolV2Command,
  CreateFeedingProtocolV2Command,
  UpdateFeedingProtocolV2Command,
} from '../commands/feeding-protocol-v2.commands';
import {
  FeedingProtocolStatus,
  FeedingProtocolV2,
  ProtocolBand,
} from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import { ProtocolValidationService } from '../services/protocol-validation.service';
import { Feed } from '../../feed/entities/feed.entity';
import { Species } from '../../species/entities/species.entity';
import {
  CreateFeedingProtocolV2Input,
  UpdateFeedingProtocolV2Input,
} from '../dto/feeding-protocol-v2.inputs';

interface ResolvedBandFeeds {
  bands: ProtocolBand[];
  speciesName?: string;
}

/** create/update ortak hazırlığı: SSoT doğrulaması + feed/species çözümü. */
async function prepareProtocolPayload(
  validation: ProtocolValidationService,
  feedRepository: Repository<Feed>,
  speciesRepository: Repository<Species>,
  input: CreateFeedingProtocolV2Input | UpdateFeedingProtocolV2Input,
  tenantId: string,
): Promise<ResolvedBandFeeds> {
  const feedIds = [...new Set(input.bands.map((band) => band.feedId))];
  const feeds = await feedRepository.find({ where: { id: In(feedIds), tenantId } });
  const feedById = new Map(feeds.filter((f) => !f.isDeleted).map((f) => [f.id, f]));
  for (const feedId of feedIds) {
    if (!feedById.has(feedId)) {
      throw new NotFoundException(`Band yem ürünü bulunamadı veya silinmiş: ${feedId}`);
    }
  }

  const bands: ProtocolBand[] = input.bands.map((band) => {
    const feed = feedById.get(band.feedId);
    return {
      minWeightG: band.minWeightG,
      maxWeightG: band.maxWeightG,
      feedId: band.feedId,
      feedCode: feed?.code ?? '',
      feedName: feed?.name ?? '',
      feedingRatePercent: band.feedingRatePercent,
      expectedFcr: band.expectedFcr,
      mealSchedule: band.mealSchedule,
      notes: band.notes,
    };
  });

  const errors = validation.validateProtocol({
    bands,
    defaultMealSchedule: input.defaultMealSchedule,
    settings: input.settings,
    temperatureAdjustments: input.temperatureAdjustments,
    fcrMatrix: input.fcrMatrix,
  });
  if (errors.length > 0) {
    throw new BadRequestException(`Protokol doğrulaması başarısız: ${errors.join('; ')}`);
  }

  let speciesName: string | undefined;
  if (input.speciesId) {
    const species = await speciesRepository.findOne({ where: { id: input.speciesId, tenantId } });
    if (!species) {
      throw new NotFoundException(`Tür bulunamadı: ${input.speciesId}`);
    }
    speciesName = species.commonName;
  }

  return { bands, speciesName };
}

@CommandHandler(CreateFeedingProtocolV2Command)
export class CreateFeedingProtocolV2Handler
  implements ICommandHandler<CreateFeedingProtocolV2Command, FeedingProtocolV2>
{
  private readonly logger = new Logger(CreateFeedingProtocolV2Handler.name);

  constructor(
    @InjectRepository(FeedingProtocolV2)
    private readonly protocolRepository: Repository<FeedingProtocolV2>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    private readonly validation: ProtocolValidationService,
  ) {}

  async execute(command: CreateFeedingProtocolV2Command): Promise<FeedingProtocolV2> {
    const { input, tenantId, userId } = command;

    const existing = await this.protocolRepository.findOne({
      where: { tenantId, name: input.name, isDeleted: false },
    });
    if (existing) {
      throw new ConflictException(`"${input.name}" adında bir protokol zaten var`);
    }

    const { bands, speciesName } = await prepareProtocolPayload(
      this.validation,
      this.feedRepository,
      this.speciesRepository,
      input,
      tenantId,
    );

    if (input.isDefault && input.speciesId) {
      await this.protocolRepository.update(
        { tenantId, speciesId: input.speciesId, isDefault: true },
        { isDefault: false },
      );
    }

    const protocol = this.protocolRepository.create({
      tenantId,
      name: input.name,
      description: input.description,
      speciesId: input.speciesId,
      speciesName,
      status: input.status ?? FeedingProtocolStatus.ACTIVE,
      bands,
      temperatureAdjustments: input.temperatureAdjustments,
      defaultMealSchedule: input.defaultMealSchedule,
      fcrMatrix: input.fcrMatrix,
      settings: input.settings,
      isDefault: input.isDefault,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.protocolRepository.save(protocol);
    this.logger.log(`FeedingProtocolV2 created: ${saved.id} ("${saved.name}")`);
    return saved;
  }
}

@CommandHandler(UpdateFeedingProtocolV2Command)
export class UpdateFeedingProtocolV2Handler
  implements ICommandHandler<UpdateFeedingProtocolV2Command, FeedingProtocolV2>
{
  private readonly logger = new Logger(UpdateFeedingProtocolV2Handler.name);

  constructor(
    @InjectRepository(FeedingProtocolV2)
    private readonly protocolRepository: Repository<FeedingProtocolV2>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    private readonly validation: ProtocolValidationService,
  ) {}

  async execute(command: UpdateFeedingProtocolV2Command): Promise<FeedingProtocolV2> {
    const { input, tenantId, userId } = command;

    const protocol = await this.protocolRepository.findOne({
      where: { id: input.id, tenantId, isDeleted: false },
    });
    if (!protocol) {
      throw new NotFoundException(`Protokol bulunamadı: ${input.id}`);
    }

    const nameClash = await this.protocolRepository.findOne({
      where: { tenantId, name: input.name, isDeleted: false },
    });
    if (nameClash && nameClash.id !== protocol.id) {
      throw new ConflictException(`"${input.name}" adında başka bir protokol var`);
    }

    const { bands, speciesName } = await prepareProtocolPayload(
      this.validation,
      this.feedRepository,
      this.speciesRepository,
      input,
      tenantId,
    );

    Object.assign(protocol, {
      name: input.name,
      description: input.description,
      speciesId: input.speciesId,
      speciesName,
      bands,
      temperatureAdjustments: input.temperatureAdjustments,
      defaultMealSchedule: input.defaultMealSchedule,
      fcrMatrix: input.fcrMatrix,
      settings: input.settings,
      isDefault: input.isDefault,
      status: input.status ?? protocol.status,
      updatedBy: userId,
    });
    const saved = await this.protocolRepository.save(protocol);
    this.logger.log(`FeedingProtocolV2 updated: ${saved.id}`);
    return saved;
  }
}

@CommandHandler(ArchiveFeedingProtocolV2Command)
export class ArchiveFeedingProtocolV2Handler
  implements ICommandHandler<ArchiveFeedingProtocolV2Command, FeedingProtocolV2>
{
  private readonly logger = new Logger(ArchiveFeedingProtocolV2Handler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: ArchiveFeedingProtocolV2Command): Promise<FeedingProtocolV2> {
    const { protocolId, tenantId, userId } = command;

    return this.dataSource.transaction(async (manager) => {
      const protocolRepo = tenantManagerRepo(manager, FeedingProtocolV2, tenantId);
      const assignmentRepo = tenantManagerRepo(manager, ProtocolAssignment, tenantId);

      const protocol = await protocolRepo.findOne({
        where: { id: protocolId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!protocol) {
        throw new NotFoundException(`Protokol bulunamadı: ${protocolId}`);
      }

      protocol.status = FeedingProtocolStatus.ARCHIVED;
      protocol.updatedBy = userId;
      const saved = await protocolRepo.save(protocol);

      // D-10: arşiv, aktif atamaları sessizce plansız bırakamaz — otomatik
      // PAUSED + her ünite için durable event (operatör görür, alert-engine
      // Faz 7 tüketicisiyle eskale edebilir).
      const activeAssignments = await assignmentRepo.find({
        where: { tenantId, protocolId, status: ProtocolAssignmentStatus.ACTIVE },
      });
      for (const assignment of activeAssignments) {
        assignment.status = ProtocolAssignmentStatus.PAUSED;
        assignment.updatedBy = userId;
        await assignmentRepo.save(assignment);

        const paused: FeedingProtocolAssignmentPausedEvent = {
          ...createBaseEvent<FeedingProtocolAssignmentPausedEvent>(
            'FeedingProtocolAssignmentPaused',
            tenantId,
            { aggregateId: assignment.id, aggregateType: 'ProtocolAssignment' },
          ),
          userId,
          assignmentId: assignment.id,
          unitId: assignment.unitId,
          unitCode: assignment.unitCode,
          protocolId,
          reason: 'protocol_archived',
        };
        await this.outboxPublisher.enqueue(paused, manager);
      }

      this.logger.log(
        `FeedingProtocolV2 archived: ${protocolId} (${activeAssignments.length} assignment(s) paused)`,
      );
      return saved;
    });
  }
}
