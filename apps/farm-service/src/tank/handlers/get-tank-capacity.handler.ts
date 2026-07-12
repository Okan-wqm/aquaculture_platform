/**
 * GetTankCapacityHandler
 *
 * GetTankCapacityQuery'yi işler ve tank kapasite bilgilerini döner.
 *
 * @module Tank/Handlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetTankCapacityQuery, TankCapacityResult } from '../queries/get-tank-capacity.query';
import { Tank } from '../entities/tank.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';

@Injectable()
@QueryHandler(GetTankCapacityQuery)
export class GetTankCapacityHandler implements IQueryHandler<GetTankCapacityQuery, TankCapacityResult> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTankCapacityQuery): Promise<TankCapacityResult> {
    const { tenantId, tankId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Tank ve TankBatch'ı paralel olarak al
      const [tank, tankBatch] = await Promise.all([
        queryRunner.manager.findOne(Tank, {
          where: { id: tankId, tenantId, isActive: true },
        }),
        queryRunner.manager.findOne(TankBatch, {
          where: { tenantId, tankId },
        }),
      ]);

      if (!tank) {
        throw new NotFoundException(`Tank ${tankId} bulunamadı`);
      }

      // Mevcut değerler — COUNT SSoT read (DB-FARMPROD-HIGH-001): totalQuantity is
      // the batchDetails-derived truth; the redundant currentQuantity mirror is
      // being retired. Biomass keeps the currentBiomassKg-first read (growth-
      // tracked live value, not a stale mirror).
      const currentQuantity = tankBatch?.totalQuantity ?? 0;
      const currentBiomassKg = tankBatch?.currentBiomassKg ?? tankBatch?.totalBiomassKg ?? 0;
      const avgWeightG = tankBatch?.avgWeightG || 0;

      // Kapasite hesaplamaları - Tank entity'den doğru property'ler
      const effectiveVolume = Number(tank.waterVolume || tank.volume) || 1;
      const maxDensityKgM3 = Number(tank.maxDensity) || 25;
      // Tank entity'de optimal density yok, default değerler kullan
      const optimalDensityMinKgM3 = maxDensityKgM3 * 0.4; // %40
      const optimalDensityMaxKgM3 = maxDensityKgM3 * 0.8; // %80
      const maxCapacityKg = Number(tank.maxBiomass) || (effectiveVolume * maxDensityKgM3);

      const currentDensityKgM3 = effectiveVolume > 0 ? currentBiomassKg / effectiveVolume : 0;
      const capacityUsedKg = currentBiomassKg;
      const capacityAvailableKg = Math.max(0, maxCapacityKg - currentBiomassKg);
      const capacityUsedPercent = maxCapacityKg > 0 ? (currentBiomassKg / maxCapacityKg) * 100 : 0;

      // Durum değerlendirmeleri
      const densityStatus = this.getDensityStatus(
        currentDensityKgM3,
        optimalDensityMinKgM3,
        optimalDensityMaxKgM3,
        maxDensityKgM3,
      );

      const capacityStatus = this.getCapacityStatus(capacityUsedPercent);

      // Batch bilgisi
      const batchDetails = tankBatch?.batchDetails || [];
      const batchCount = batchDetails.length || (tankBatch?.primaryBatchId ? 1 : 0);

      // Uyarılar
      const warnings = this.generateWarnings(
        currentDensityKgM3,
        optimalDensityMinKgM3,
        optimalDensityMaxKgM3,
        maxDensityKgM3,
        capacityUsedPercent,
        batchCount,
      );

      return {
        tankId: tank.id,
        tankCode: tank.code,
        tankName: tank.name,

        volumeM3: effectiveVolume,
        maxCapacityKg,
        maxDensityKgM3,
        optimalDensityMinKgM3,
        optimalDensityMaxKgM3,

        currentQuantity,
        currentBiomassKg,
        currentDensityKgM3,
        currentAvgWeightG: avgWeightG,

        capacityUsedKg,
        capacityAvailableKg,
        capacityUsedPercent: Math.min(100, capacityUsedPercent),

        densityStatus,
        capacityStatus,

        batchCount,
        primaryBatchId: tankBatch?.primaryBatchId,
        primaryBatchNumber: tankBatch?.primaryBatchNumber,

        warnings,
      };
    });
  }

  private getDensityStatus(
    current: number,
    optMin: number,
    optMax: number,
    max: number,
  ): 'optimal' | 'low' | 'high' | 'critical' {
    if (current <= 0) return 'low';
    if (current >= max) return 'critical';
    if (current > optMax) return 'high';
    if (current < optMin) return 'low';
    return 'optimal';
  }

  private getCapacityStatus(
    usedPercent: number,
  ): 'available' | 'near_capacity' | 'full' | 'over_capacity' {
    if (usedPercent > 100) return 'over_capacity';
    if (usedPercent >= 95) return 'full';
    if (usedPercent >= 80) return 'near_capacity';
    return 'available';
  }

  private generateWarnings(
    currentDensity: number,
    optMin: number,
    optMax: number,
    maxDensity: number,
    capacityUsedPercent: number,
    batchCount: number,
  ): string[] {
    const warnings: string[] = [];

    if (currentDensity > maxDensity) {
      warnings.push(`Kritik: Yoğunluk maksimum sınırı aşıyor (${currentDensity.toFixed(1)} > ${maxDensity} kg/m³)`);
    } else if (currentDensity > optMax) {
      warnings.push(`Uyarı: Yoğunluk optimal aralığın üzerinde (${currentDensity.toFixed(1)} > ${optMax} kg/m³)`);
    } else if (currentDensity > 0 && currentDensity < optMin) {
      warnings.push(`Bilgi: Yoğunluk optimal aralığın altında (${currentDensity.toFixed(1)} < ${optMin} kg/m³)`);
    }

    if (capacityUsedPercent > 100) {
      warnings.push(`Kritik: Tank kapasitesi aşıldı (%${capacityUsedPercent.toFixed(1)})`);
    } else if (capacityUsedPercent >= 95) {
      warnings.push(`Uyarı: Tank neredeyse dolu (%${capacityUsedPercent.toFixed(1)})`);
    } else if (capacityUsedPercent >= 80) {
      warnings.push(`Bilgi: Tank kapasiteye yaklaşıyor (%${capacityUsedPercent.toFixed(1)})`);
    }

    if (batchCount > 1) {
      warnings.push(`Bilgi: Tank'ta birden fazla batch bulunuyor (${batchCount} batch)`);
    }

    return warnings;
  }
}
