/**
 * CreateFeedingRecordHandler
 *
 * CreateFeedingRecordCommand'ı işler ve yeni yemleme kaydı oluşturur.
 *
 * @module Feeding/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
// TODO: EventBus integration - import { EventBus } from '@platform/event-bus';
import { CreateFeedingRecordCommand } from '../commands/create-feeding-record.command';
import { FeedingRecord, FeedingMethod } from '../entities/feeding-record.entity';
import { FeedInventory } from '../entities/feed-inventory.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';

@Injectable()
@CommandHandler(CreateFeedingRecordCommand)
export class CreateFeedingRecordHandler implements ICommandHandler<CreateFeedingRecordCommand, FeedingRecord> {
  constructor(
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(FeedInventory)
    private readonly inventoryRepository: Repository<FeedInventory>,
    // TODO: EventBus integration
    // private readonly eventBus: EventBus,
  ) {}

  async execute(command: CreateFeedingRecordCommand): Promise<FeedingRecord> {
    const { tenantId, payload, userId } = command;

    // Batch'i doğrula
    const batch = await this.batchRepository.findOne({
      where: { id: payload.batchId, tenantId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${payload.batchId} bulunamadı`);
    }

    if (!batch.isActive) {
      throw new BadRequestException('Aktif olmayan batch için yemleme kaydı oluşturulamaz');
    }

    // Feed'i doğrula
    const feed = await this.feedRepository.findOne({
      where: { id: payload.feedId, tenantId },
    });

    if (!feed) {
      throw new NotFoundException(`Feed ${payload.feedId} bulunamadı`);
    }

    // Yemleme kaydını oluştur
    const feedingRecord = this.feedingRecordRepository.create({
      tenantId,
      batchId: payload.batchId,
      tankId: payload.tankId,
      pondId: payload.pondId,
      batchLocationId: payload.batchLocationId,

      feedingDate: payload.feedingDate,
      feedingTime: payload.feedingTime,
      feedingSequence: payload.feedingSequence || 1,
      totalMealsToday: payload.totalMealsToday || 1,

      feedId: payload.feedId,
      feedBatchNumber: payload.feedBatchNumber,

      plannedAmount: payload.plannedAmount,
      actualAmount: payload.actualAmount,
      wasteAmount: payload.wasteAmount,

      environment: payload.environment,
      fishBehavior: payload.fishBehavior,

      feedingMethod: payload.feedingMethod || FeedingMethod.MANUAL,
      equipmentId: payload.equipmentId,
      feedingDurationMinutes: payload.feedingDurationMinutes,

      feedCost: payload.feedCost || this.calculateFeedCost(feed, payload.actualAmount),
      currency: payload.currency || 'TRY',

      fedBy: payload.fedBy || userId,
      notes: payload.notes,
      skipReason: payload.skipReason,
    });

    // Varyans hesapla
    feedingRecord.calculateVariance();

    // Kaydet
    const saved = await this.feedingRecordRepository.save(feedingRecord);

    // Batch'in toplam yem tüketimini güncelle
    await this.updateBatchFeedConsumption(batch, payload.actualAmount, feedingRecord.feedCost ?? 0);

    return saved;
  }

  private calculateFeedCost(feed: Feed, amountKg: number): number {
    if (!feed.pricePerKg) return 0;
    return Number(feed.pricePerKg) * amountKg;
  }

  private async updateBatchFeedConsumption(
    batch: Batch,
    amountKg: number,
    cost: number,
  ): Promise<void> {
    batch.totalFeedConsumed = Number(batch.totalFeedConsumed || 0) + amountKg;
    batch.totalFeedCost = Number(batch.totalFeedCost || 0) + cost;

    await this.batchRepository.save(batch);
  }
}
