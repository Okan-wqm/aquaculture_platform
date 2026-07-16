/**
 * CreateFeedingRecordHandler
 *
 * CreateFeedingRecordCommand'ı işler ve yeni yemleme kaydı oluşturur.
 * Faz 5 (P-05): kayıt + batch aggregate + storage düşümü + outbox event'i
 * TEK yem yazma yolu olan `FeedingLedgerService.recordFeed`'e delege edilir —
 * v2 öğün motoru ve (drain penceresinde) legacy execution kaydı AYNI yoldan
 * geçer; bu handler yalnız doğrulama (backdate, kilitli batch feedable, feed
 * varlığı) + transaction sınırını sahiplenir.
 *
 * Phase A refactor:
 *  - Replaced fire-and-forget eventBus.publish() (post-commit, @Optional
 *    injection that silently dropped events) with OutboxPublisher.enqueue()
 *    inside the same transaction as the domain write.
 *  - Moved Batch + Feed validation reads INSIDE the transaction with
 *    pessimistic_write lock on Batch to eliminate the TOCTOU race where the
 *    batch could be deactivated between the pre-check and the feeding write.
 *
 * Feed dual-SSoT write-path correctness (Phase A):
 *  - Asserts the locked batch is feedable (BatchDomainService.assertFeedable)
 *    INSIDE the tx — feeding an empty / non-feedable batch is rejected before
 *    any stock is touched.
 *  - Deducts feed from the storage ledger (StorageInventory + Feed.quantity
 *    roll-up) via StockMovementService.recordMovement on the SAME
 *    queryRunner.manager — but ONLY when the feed is storage-tracked
 *    (feedHasStoragePresence). For a storage-tracked feed, insufficient stock
 *    / no-lot throws and ROLLS BACK the whole feeding — replacing the old
 *    async storage event handler that swallowed its failure and let the two
 *    ledgers diverge silently. For a feed the tenant does NOT track in storage
 *    (zero storage rows — e.g. a tenant that never adopted the warehouse
 *    module), the storage OUT is SKIPPED with an observable structured warn
 *    and the feed_inventory-only path applies, so a pre-Phase-B tenant is not
 *    pushed off a fail-closed cliff.
 *  - Phase 2 (stock SSoT): the legacy feed_inventory decrement is GONE — the
 *    path still reads feed_inventory.quantityKg, so both ledgers update
 *    atomically (or roll back together). Collapsing onto one ledger is
 *    Phase B (table merge + read re-points + destructive migration).
 *
 * @module Feeding/Handlers
 */
import { randomUUID } from 'crypto';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { CreateFeedingRecordCommand } from '../commands/create-feeding-record.command';
import { FeedingRecord, FeedingMethod } from '../entities/feeding-record.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { BackdatePolicyService } from '../../common/services/backdate-policy.service';
import { FeedingLedgerService } from '../services/feeding-ledger.service';

@Injectable()
@CommandHandler(CreateFeedingRecordCommand)
export class CreateFeedingRecordHandler implements ICommandHandler<CreateFeedingRecordCommand, FeedingRecord> {
  private readonly logger = new Logger(CreateFeedingRecordHandler.name);

  constructor(
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    private readonly dataSource: DataSource,
    private readonly backdatePolicy: BackdatePolicyService,
    private readonly batchDomainService: BatchDomainService,
    private readonly feedingLedger: FeedingLedgerService,
  ) {}

  async execute(command: CreateFeedingRecordCommand): Promise<FeedingRecord> {
    const { tenantId, payload, userId } = command;

    // ── Backdate policy: reject future feedingDates unconditionally and
    // reject historical dates that fall beyond the configured feeding
    // limit (FEEDING_BACKDATE_LIMIT_DAYS env var, default 7). See
    // docs/illustrator/ Girdi 8 — unbounded backdating corrupts
    // downstream FCR / SGR derivations that assume time-ordered events.
    const proposedDate: Date =
      payload.feedingDate instanceof Date
        ? payload.feedingDate
        : new Date(payload.feedingDate);
    this.backdatePolicy.validate({
      context: 'feeding',
      proposedDate,
      subjectLabel: `batch ${payload.batchId}`,
    });

    // All reads + writes inside a single transaction. TOCTOU fix: batch/feed
    // lookups now run with pessimistic locks so a concurrent CloseBatch or
    // feed-delete cannot mutate state between the validation and the write.
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Batch'i doğrula (inside TX with pessimistic_write lock)
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: payload.batchId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${payload.batchId} bulunamadı`);
      }

      if (!batch.isActive) {
        throw new BadRequestException('Aktif olmayan batch için yemleme kaydı oluşturulamaz');
      }

      // Reject feeding an empty (currentQuantity ≤ 0) or non-feedable
      // (HARVESTED / CLOSED / FAILED / …) batch. Recording feed against such
      // a batch inflates totalFeedConsumed with no biomass and corrupts FCR.
      // Runs on the pessimistically-locked batch so the decision cannot race
      // a concurrent CloseBatch / final harvest. Throws BadRequestException.
      this.batchDomainService.assertFeedable(batch);

      // Feed'i doğrula (inside TX)
      const feed = await queryRunner.manager.findOne(Feed, {
        where: { id: payload.feedId, tenantId },
      });

      if (!feed) {
        throw new NotFoundException(`Feed ${payload.feedId} bulunamadı`);
      }

      // TEK yem yazma yolu (P-05): kayıt + batch aggregate + storage düşümü
      // (site kapsamlı, D-9) + FeedingRecordedEvent outbox — hepsi ledger'da.
      const saved = await this.feedingLedger.recordFeed(
        queryRunner.manager,
        tenantId,
        userId,
        batch,
        feed,
        {
          batchId: payload.batchId,
          tankId: payload.tankId,
          pondId: payload.pondId,
          batchLocationId: payload.batchLocationId,
          feedId: payload.feedId,
          plannedAmountKg: payload.plannedAmount,
          actualAmountKg: payload.actualAmount,
          wasteAmountKg: payload.wasteAmount,
          feedingDate: proposedDate,
          feedingTime: payload.feedingTime,
          feedingMethod: payload.feedingMethod || FeedingMethod.MANUAL,
          equipmentId: payload.equipmentId,
          feedBatchNumber: payload.feedBatchNumber,
          fedBy: payload.fedBy || userId,
          notes: payload.notes,
          feedCost: payload.feedCost,
          currency: payload.currency,
          extras: {
            environment: payload.environment,
            fishBehavior: payload.fishBehavior,
            feedingDurationMinutes: payload.feedingDurationMinutes,
            feedingSequence: payload.feedingSequence || 1,
            totalMealsToday: payload.totalMealsToday || 1,
            skipReason: payload.skipReason,
          },
        },
      );

      return saved;
    });
  }
}
