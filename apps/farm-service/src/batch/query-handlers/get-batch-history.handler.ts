/**
 * GetBatchHistoryHandler
 *
 * GetBatchHistoryQuery'yi işler ve batch operasyon geçmişini döner.
 *
 * @module Batch/QueryHandlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual, FindOperator } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import {
  GetBatchHistoryQuery,
  BatchHistoryEntry,
  BatchHistoryEventType,
} from '../queries/get-batch-history.query';
import { Batch } from '../entities/batch.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { TankAllocation } from '../entities/tank-allocation.entity';
import { MortalityRecord } from '../entities/mortality-record.entity';

/**
 * Query filter interface for TankOperation
 */
interface TankOperationQueryFilter {
  tenantId: string;
  batchId: string;
  isDeleted: boolean;
  operationDate?: Date | FindOperator<Date>;
}

/**
 * Query filter interface for TankAllocation
 */
interface TankAllocationQueryFilter {
  tenantId: string;
  batchId: string;
  isDeleted: boolean;
  allocationDate?: Date | FindOperator<Date>;
}

@Injectable()
@QueryHandler(GetBatchHistoryQuery)
export class GetBatchHistoryHandler implements IQueryHandler<GetBatchHistoryQuery, BatchHistoryEntry[]> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(TankAllocation)
    private readonly allocationRepository: Repository<TankAllocation>,
    @InjectRepository(MortalityRecord)
    private readonly mortalityRepository: Repository<MortalityRecord>,
  ) {}

  async execute(query: GetBatchHistoryQuery): Promise<BatchHistoryEntry[]> {
    const { tenantId, batchId, eventTypes, fromDate, toDate, limit } = query;

    // Batch'i kontrol et
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    const history: BatchHistoryEntry[] = [];

    // 1. Batch creation event
    if (!eventTypes || eventTypes.includes(BatchHistoryEventType.CREATED)) {
      const createdInRange = this.isDateInRange(batch.createdAt, fromDate, toDate);
      if (createdInRange) {
        history.push({
          id: `created-${batch.id}`,
          eventType: BatchHistoryEventType.CREATED,
          timestamp: batch.createdAt,
          description: `Batch ${batch.batchNumber} oluşturuldu`,
          details: {
            batchNumber: batch.batchNumber,
            speciesId: batch.speciesId,
            initialQuantity: batch.initialQuantity,
            initialAvgWeightG: batch.weight.initial.avgWeight,
            inputType: batch.inputType,
          },
          performedBy: batch.createdBy,
        });
      }
    }

    // 2. Tank operations
    const operationQuery: TankOperationQueryFilter = {
      tenantId,
      batchId,
      isDeleted: false,
    };

    if (fromDate && toDate) {
      operationQuery.operationDate = Between(fromDate, toDate);
    } else if (fromDate) {
      operationQuery.operationDate = MoreThanOrEqual(fromDate);
    } else if (toDate) {
      operationQuery.operationDate = LessThanOrEqual(toDate);
    }

    const operations = await this.operationRepository.find({
      where: operationQuery,
      order: { operationDate: 'DESC' },
      take: limit,
    });

    for (const op of operations) {
      const eventType = this.mapOperationTypeToEventType(op.operationType);
      if (eventTypes && !eventTypes.includes(eventType)) continue;

      history.push({
        id: op.id,
        eventType,
        timestamp: op.operationDate,
        description: this.getOperationDescription(op),
        details: {
          operationType: op.operationType,
          quantity: op.quantity,
          avgWeightG: op.avgWeightG,
          biomassKg: op.biomassKg,
          mortalityReason: op.mortalityReason,
          cullReason: op.cullReason,
          destinationTankId: op.destinationTankId,
          sourceTankId: op.sourceTankId,
          preOperationState: op.preOperationState,
          postOperationState: op.postOperationState,
        },
        performedBy: op.performedBy,
        tankId: op.tankId,
        tankCode: op.tankCode,
        quantityChange: this.getQuantityChange(op),
        biomassChangeKg: this.getBiomassChange(op),
      });
    }

    // 3. Allocations (non-operation related)
    if (!eventTypes || eventTypes.includes(BatchHistoryEventType.ALLOCATED)) {
      const allocationQuery: TankAllocationQueryFilter = {
        tenantId,
        batchId,
        isDeleted: false,
      };

      if (fromDate && toDate) {
        allocationQuery.allocationDate = Between(fromDate, toDate);
      } else if (fromDate) {
        allocationQuery.allocationDate = MoreThanOrEqual(fromDate);
      } else if (toDate) {
        allocationQuery.allocationDate = LessThanOrEqual(toDate);
      }

      const allocations = await this.allocationRepository.find({
        where: allocationQuery,
        order: { allocationDate: 'DESC' },
        take: limit,
      });

      for (const alloc of allocations) {
        // Transfer allocation'ları zaten operation olarak eklendi, skip et
        if (alloc.allocationType === 'transfer_in' || alloc.allocationType === 'transfer_out') {
          continue;
        }

        history.push({
          id: alloc.id,
          eventType: BatchHistoryEventType.ALLOCATED,
          timestamp: alloc.allocationDate,
          description: `${alloc.quantity} adet Tank ${alloc.tankCode}'e dağıtıldı`,
          details: {
            allocationType: alloc.allocationType,
            quantity: alloc.quantity,
            avgWeightG: alloc.avgWeightG,
            biomassKg: alloc.biomassKg,
            densityKgM3: alloc.densityKgM3,
          },
          performedBy: alloc.allocatedBy,
          tankId: alloc.tankId,
          tankCode: alloc.tankCode,
          quantityChange: alloc.quantity,
          biomassChangeKg: Number(alloc.biomassKg),
        });
      }
    }

    // Sort by timestamp descending
    history.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Apply limit
    return history.slice(0, limit);
  }

  private isDateInRange(date: Date, fromDate?: Date, toDate?: Date): boolean {
    const d = new Date(date);
    if (fromDate && d < new Date(fromDate)) return false;
    if (toDate && d > new Date(toDate)) return false;
    return true;
  }

  private mapOperationTypeToEventType(opType: OperationType): BatchHistoryEventType {
    const mapping: Record<OperationType, BatchHistoryEventType> = {
      [OperationType.MORTALITY]: BatchHistoryEventType.MORTALITY,
      [OperationType.CULL]: BatchHistoryEventType.CULL,
      [OperationType.TRANSFER_IN]: BatchHistoryEventType.TRANSFERRED,
      [OperationType.TRANSFER_OUT]: BatchHistoryEventType.TRANSFERRED,
      [OperationType.HARVEST]: BatchHistoryEventType.HARVEST,
      [OperationType.SAMPLING]: BatchHistoryEventType.GROWTH_SAMPLE,
      [OperationType.ADJUSTMENT]: BatchHistoryEventType.UPDATED,
      // Cleaner fish operations
      [OperationType.CLEANER_DEPLOYMENT]: BatchHistoryEventType.UPDATED,
      [OperationType.CLEANER_MORTALITY]: BatchHistoryEventType.MORTALITY,
      [OperationType.CLEANER_REMOVAL]: BatchHistoryEventType.UPDATED,
      [OperationType.CLEANER_TRANSFER_OUT]: BatchHistoryEventType.TRANSFERRED,
      [OperationType.CLEANER_TRANSFER_IN]: BatchHistoryEventType.TRANSFERRED,
    };
    return mapping[opType] || BatchHistoryEventType.UPDATED;
  }

  private getOperationDescription(op: TankOperation): string {
    switch (op.operationType) {
      case OperationType.MORTALITY:
        return `${op.quantity} adet mortality (${op.mortalityReason || 'bilinmiyor'})`;
      case OperationType.CULL:
        return `${op.quantity} adet cull (${op.cullReason || 'bilinmiyor'})`;
      case OperationType.TRANSFER_OUT:
        return `${op.quantity} adet Tank ${op.tankCode}'den transfer çıkışı`;
      case OperationType.TRANSFER_IN:
        return `${op.quantity} adet Tank ${op.tankCode}'e transfer girişi`;
      case OperationType.HARVEST:
        return `${op.quantity} adet hasat edildi`;
      case OperationType.SAMPLING:
        return `Örnekleme yapıldı (${op.quantity} adet)`;
      default:
        return `Operasyon: ${op.operationType}`;
    }
  }

  private getQuantityChange(op: TankOperation): number {
    switch (op.operationType) {
      case OperationType.MORTALITY:
      case OperationType.CULL:
      case OperationType.TRANSFER_OUT:
      case OperationType.HARVEST:
        return -op.quantity;
      case OperationType.TRANSFER_IN:
        return op.quantity;
      default:
        return 0;
    }
  }

  private getBiomassChange(op: TankOperation): number {
    const biomass = Number(op.biomassKg || 0);
    switch (op.operationType) {
      case OperationType.MORTALITY:
      case OperationType.CULL:
      case OperationType.TRANSFER_OUT:
      case OperationType.HARVEST:
        return -biomass;
      case OperationType.TRANSFER_IN:
        return biomass;
      default:
        return 0;
    }
  }
}
