/**
 * GetTankBatchesHandler
 *
 * GetTankBatchesQuery'yi işler ve tank'taki batch'leri döner.
 *
 * @module Tank/Handlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetTankBatchesQuery, TankBatchesResult, TankBatchInfo } from '../queries/get-tank-batches.query';
import { Tank } from '../entities/tank.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Species } from '../../species/entities/species.entity';

@Injectable()
@QueryHandler(GetTankBatchesQuery)
export class GetTankBatchesHandler implements IQueryHandler<GetTankBatchesQuery, TankBatchesResult> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTankBatchesQuery): Promise<TankBatchesResult> {
    const { tenantId, tankId, includeInactive } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Tank'ı bul
      const tank = await queryRunner.manager.findOne(Tank, {
        where: { id: tankId, tenantId, isActive: true },
      });

      if (!tank) {
        throw new NotFoundException(`Tank ${tankId} bulunamadı`);
      }

      // TankBatch kaydını bul
      const tankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId },
      });

      const batches: TankBatchInfo[] = [];
      let totalQuantity = 0;
      let totalBiomassKg = 0;

      // Effective volume - waterVolume veya volume
      const effectiveVolume = Number(tank.waterVolume || tank.volume) || 1;

      if (tankBatch) {
        // Multi-batch desteği
        const batchDetails = tankBatch.batchDetails || [];

        // Primary batch'i de ekle
        if (tankBatch.primaryBatchId) {
          const hasPrimaryInDetails = batchDetails.some(b => b.batchId === tankBatch.primaryBatchId);
          if (!hasPrimaryInDetails && tankBatch.primaryBatchNumber) {
            const primaryQuantity = (tankBatch.currentQuantity ?? tankBatch.totalQuantity) - batchDetails.reduce((sum, b) => sum + b.quantity, 0);
            const primaryBiomass = (tankBatch.currentBiomassKg ?? tankBatch.totalBiomassKg) - batchDetails.reduce((sum, b) => sum + b.biomassKg, 0);
            batchDetails.unshift({
              batchId: tankBatch.primaryBatchId,
              batchNumber: tankBatch.primaryBatchNumber,
              quantity: primaryQuantity,
              avgWeightG: tankBatch.avgWeightG,
              biomassKg: primaryBiomass,
              percentageOfTank: 0,
            });
          }
        }

        // Batch fetch all batches to avoid N+1 queries
        const batchIds = batchDetails.map(d => d.batchId);
        const batchEntities = batchIds.length > 0
          ? await queryRunner.manager.find(Batch, {
              where: { id: In(batchIds), tenantId },
            })
          : [];
        const batchMap = new Map(batchEntities.map(b => [b.id, b]));

        // Batch fetch all species to avoid N+1 queries
        const speciesIds = [...new Set(batchEntities.map(b => b.speciesId))];
        const speciesEntities = speciesIds.length > 0
          ? await queryRunner.manager.find(Species, {
              where: { id: In(speciesIds), tenantId },
            })
          : [];
        const speciesMap = new Map(speciesEntities.map(s => [s.id, s]));

        for (const detail of batchDetails) {
          const batch = batchMap.get(detail.batchId);

          if (!batch) continue;

          // Filter inactive batches
          if (!includeInactive && !batch.isActive) continue;

          const species = speciesMap.get(batch.speciesId);
          const densityKgM3 = effectiveVolume > 0 ? detail.biomassKg / effectiveVolume : 0;

          batches.push({
            batchId: detail.batchId,
            batchNumber: batch.batchNumber,
            speciesName: species?.commonName || species?.scientificName || 'Unknown',
            quantity: detail.quantity,
            avgWeightG: detail.avgWeightG,
            biomassKg: detail.biomassKg,
            densityKgM3,
            allocationDate: tankBatch.createdAt,
            isPrimary: detail.batchId === tankBatch.primaryBatchId,
            batchStatus: batch.status,
          });

          totalQuantity += detail.quantity;
          totalBiomassKg += detail.biomassKg;
        }
      }

      const currentDensityKgM3 = effectiveVolume > 0 ? totalBiomassKg / effectiveVolume : 0;
      const maxCapacityKg = Number(tank.maxBiomass) || (effectiveVolume * (Number(tank.maxDensity) || 25));
      const capacityUsedPercent = maxCapacityKg > 0 ? (totalBiomassKg / maxCapacityKg) * 100 : 0;

      return {
        tankId: tank.id,
        tankCode: tank.code,
        tankName: tank.name,
        volumeM3: effectiveVolume,
        maxCapacityKg,
        currentBiomassKg: totalBiomassKg,
        currentDensityKgM3,
        capacityUsedPercent: Math.min(100, capacityUsedPercent),
        totalQuantity,
        batches,
        isMixed: batches.length > 1,
      };
    });
  }
}
