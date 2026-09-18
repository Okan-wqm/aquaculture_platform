/**
 * Batch read service.
 *
 * READ-ONLY. This class used to carry a second, parallel write path for batch
 * creation, tank allocation, transfer and stock operations — a shadow of the
 * command handlers that write the same rows. It had no production caller: the
 * GraphQL mutations and `BatchController`'s write endpoints route through the
 * command bus, and `TankBatchService.applyBatchDelta` is the single writer for
 * tank composition. FARM-HIGH-109 / FARM-LOW-211 deleted it.
 *
 * What remains is the three reads `BatchController` still serves from here.
 * Adding a write back to this class re-creates the bypass; the central-only
 * invariant fails the build if anything does.
 *
 * @module Batch
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TankAllocation } from '../entities/tank-allocation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankOperation } from '../entities/tank-operation.entity';

@Injectable()
export class BatchService {
  constructor(
    @InjectRepository(TankAllocation)
    private readonly allocationRepository: Repository<TankAllocation>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
  ) {}

  /**
   * Tank'taki mevcut batch durumunu döner
   */
  async getTankBatchStatus(tankId: string, tenantId: string): Promise<TankBatch | null> {
    return this.tankBatchRepository.findOne({
      where: { tenantId, tankId },
      relations: ['primaryBatch', 'tank'],
    });
  }

  /**
   * Batch'in tank dağılımını döner
   */
  async getBatchAllocations(batchId: string, tenantId: string): Promise<TankAllocation[]> {
    return this.allocationRepository.find({
      where: { tenantId, batchId, isDeleted: false },
      relations: ['tank'],
      order: { allocationDate: 'DESC' },
    });
  }

  /**
   * Batch'in operasyon geçmişini döner
   */
  async getBatchOperations(batchId: string, tenantId: string): Promise<TankOperation[]> {
    return this.operationRepository.find({
      where: { tenantId, batchId, isDeleted: false },
      relations: ['tank'],
      order: { operationDate: 'DESC' },
    });
  }
}
