/**
 * UpdateHarvestRecordHandler
 *
 * Handles the UpdateHarvestRecordCommand to update an existing harvest record.
 *
 * Enterprise fixes (S2 HIGH-003):
 * - QueryRunner transaction prevents partial commit on save failure
 * - Pessimistic write lock prevents concurrent last-write-wins corruption
 * - updatedBy written to entity for regulatory audit trail
 *
 * Outbox (this PR):
 * - `HarvestRecordUpdatedEvent` enqueued INSIDE the transaction so
 *   downstream Slakterapport projection / customer-traceability
 *   timelines can patch without re-reading the harvest record.
 * - `changedFields[]` list narrows consumer re-projection scope:
 *   a notes-only edit should not trigger a regulatory re-submission.
 *
 * @module Harvest/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import {
  toEventIso,
  createBaseEvent,
  type HarvestRecordUpdatedEvent,
} from '@platform/event-contracts';
import { UpdateHarvestRecordCommand } from '../commands/update-harvest-record.command';
import { HarvestRecord, qualityGradeToClass } from '../entities/harvest-record.entity';

const UPDATABLE_FIELDS = [
  'status',
  'quantityHarvested',
  'totalBiomass',
  'averageWeight',
  'method',
  'productForm',
  'totalRevenue',
  'harvestCost',
  'currency',
  'mortalityDuringHarvest',
  'rejectedQuantity',
  'rejectionReason',
  'notes',
] as const;

@Injectable()
@CommandHandler(UpdateHarvestRecordCommand)
export class UpdateHarvestRecordHandler
  implements ICommandHandler<UpdateHarvestRecordCommand, HarvestRecord>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateHarvestRecordCommand): Promise<HarvestRecord> {
    const { tenantId, harvestRecordId, data, updatedBy } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Pessimistic write lock: concurrent updates produce last-write-wins without
      // conflict detection — lock serialises concurrent callers at the DB level.
      const harvestRecord = await queryRunner.manager.findOne(HarvestRecord, {
        where: { id: harvestRecordId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!harvestRecord) {
        throw new NotFoundException(`Harvest record ${harvestRecordId} not found`);
      }

      // Audit trail: record who made this update (regulatory requirement)
      if (updatedBy) {
        harvestRecord.updatedBy = updatedBy;
      }

      const changedFields: string[] = [];
      for (const field of UPDATABLE_FIELDS) {
        const incoming = (data as Record<string, unknown>)[field];
        if (incoming !== undefined) {
          changedFields.push(field);
          (harvestRecord as unknown as Record<string, unknown>)[field] = incoming;
        }
      }

      // quality_class is the sole stored quality taxonomy (RPT-007). Prefer the
      // SSoT-native qualityClass input; a deprecated qualityGrade maps onto it.
      // qualityGrade itself is a read-only derived alias — never persisted.
      if (data.qualityClass !== undefined) {
        harvestRecord.qualityClass = data.qualityClass;
        changedFields.push('qualityClass');
      } else if (data.qualityGrade !== undefined) {
        harvestRecord.qualityClass = qualityGradeToClass(data.qualityGrade);
        changedFields.push('qualityClass');
      }

      const saved = await queryRunner.manager.save(HarvestRecord, harvestRecord);

      const event: HarvestRecordUpdatedEvent = {
        ...createBaseEvent<HarvestRecordUpdatedEvent>('HarvestRecordUpdated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'HarvestRecord',
        }),
        harvestRecordId: saved.id,
        batchId: saved.batchId,
        changedFields,
        newQuantityHarvested: saved.quantityHarvested,
        newTotalBiomass: Number(saved.totalBiomass),
        newStatus: saved.status,
        updatedAt: toEventIso(new Date()),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      return saved;
    });
  }
}
