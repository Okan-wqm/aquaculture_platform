/** Read-only REST projection facade. Batch mutations are owned by CQRS intents. */
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

  async getTankBatchStatus(tankId: string, tenantId: string): Promise<TankBatch | null> {
    return this.tankBatchRepository.findOne({
      where: { tenantId, tankId },
      relations: ['primaryBatch', 'tank'],
    });
  }

  async getBatchAllocations(batchId: string, tenantId: string): Promise<TankAllocation[]> {
    return this.allocationRepository.find({
      where: { tenantId, batchId, isDeleted: false },
      relations: ['tank'],
      order: { allocationDate: 'DESC' },
    });
  }

  async getBatchOperations(batchId: string, tenantId: string): Promise<TankOperation[]> {
    return this.operationRepository.find({
      where: { tenantId, batchId, isDeleted: false },
      relations: ['tank'],
      order: { operationDate: 'DESC' },
    });
  }
}
