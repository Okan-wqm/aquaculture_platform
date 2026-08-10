/**
 * FeederDoseSplitService — "bu ünitenin günlük dozu hangi yemleyiciye ne kadar"
 * sorusunun TEK cevabı.
 *
 * WHAT: reads a unit's active feeder assignments and splits a dose across them
 * by share. The split is exact: the allocated kilograms always sum back to the
 * dose that went in.
 *
 * WHY the arithmetic is not left to each caller: rounding a percentage split
 * naively loses or invents feed. 33.333% of 10 kg three times is 9.999 kg, and a
 * silent 1 g/day shortfall is the same class of defect as a 90% share total —
 * invisible, permanent, and paid by the fish. `splitDoseByShare` uses the
 * largest-remainder method so the parts reconstitute the whole exactly, at the
 * 3-decimal (gram) resolution the feeding tables already use
 * (`feeding_meals.plannedKg` is numeric(12,3)).
 *
 * @module FeedingProtocol/Services
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';

import { FeederAssignment, FeederAssignmentStatus } from '../entities/feeder-assignment.entity';

/** Kilogram çözünürlüğü: gram (feeding_meals.plannedKg numeric(12,3) ile aynı). */
const KG_DECIMALS = 3;
const KG_SCALE = 10 ** KG_DECIMALS;

export interface FeederDoseShare {
  feederEquipmentId: string;
  feederName: string;
  feederCode: string;
  doseSharePercent: number;
}

export interface FeederDoseAllocation extends FeederDoseShare {
  /** Bu yemleyiciye düşen kg — payların toplamı girdinin tam olarak kendisidir. */
  kg: number;
}

/**
 * Dozu paylara göre böler (largest-remainder).
 *
 * Girdi paylarının 100'e toplandığı VARSAYILMAZ: fonksiyon payları kendi
 * toplamlarına göre normalize eder, çünkü toplamın 100 olduğunu garanti eden yer
 * veritabanıdır (feeder_assignment_unit_totals CHECK), bu fonksiyon değil.
 * Böylece aynı gövde hem üretim yolunda hem de kısmi/deneysel çağrılarda
 * aritmetik olarak tutarlı kalır.
 */
export function splitDoseByShare(
  shares: readonly FeederDoseShare[],
  totalKg: number,
): FeederDoseAllocation[] {
  if (shares.length === 0) {
    return [];
  }

  const shareSum = shares.reduce((sum, share) => sum + share.doseSharePercent, 0);
  if (shareSum <= 0) {
    return shares.map((share) => ({ ...share, kg: 0 }));
  }

  // Gram cinsinden tam sayı çalış: kayan noktalı toplama hatası birikmesin.
  const totalGrams = Math.round(totalKg * KG_SCALE);
  const exact = shares.map((share) => (totalGrams * share.doseSharePercent) / shareSum);
  const floors = exact.map((grams) => Math.floor(grams));
  let remainder = totalGrams - floors.reduce((sum, grams) => sum + grams, 0);

  // Artık gramları en büyük kesirli kalıntıdan başlayarak dağıt; eşitlikte önce
  // büyük pay, sonra feeder id — sıralama deterministik olsun (aynı girdi aynı
  // çıktıyı versin, aksi hâlde plan üretimi tekrar koştuğunda gram oynar).
  const order = shares
    .map((share, index) => ({
      index,
      fraction: exact[index]! - floors[index]!,
      sharePercent: share.doseSharePercent,
      feederEquipmentId: share.feederEquipmentId,
    }))
    .sort(
      (a, b) =>
        b.fraction - a.fraction ||
        b.sharePercent - a.sharePercent ||
        a.feederEquipmentId.localeCompare(b.feederEquipmentId),
    );

  const grams = [...floors];
  for (const candidate of order) {
    if (remainder <= 0) break;
    grams[candidate.index] = grams[candidate.index]! + 1;
    remainder -= 1;
  }

  return shares.map((share, index) => ({
    ...share,
    kg: grams[index]! / KG_SCALE,
  }));
}

@Injectable()
export class FeederDoseSplitService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Bir ünitenin AKTİF yemleyicileri ve payları — sonraki fazın okuma yolu.
   * Pay büyükten küçüğe, eşitlikte koda göre sıralı (deterministik gösterim).
   */
  async getActiveFeeders(tenantId: string, unitId: string): Promise<FeederDoseShare[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repository = tenantManagerRepo(queryRunner.manager, FeederAssignment, tenantId);
      const rows = await repository.find({
        where: { tenantId, unitId, status: FeederAssignmentStatus.ACTIVE },
        order: { doseSharePercent: 'DESC', feederCode: 'ASC' },
      });
      return rows.map((row) => ({
        feederEquipmentId: row.feederEquipmentId,
        feederName: row.feederName,
        feederCode: row.feederCode,
        doseSharePercent: row.doseSharePercent,
      }));
    });
  }

  /**
   * Ünitenin günlük dozunu aktif yemleyicilere böler. Ünitede aktif yemleyici
   * yoksa boş liste döner — bu "elle yemleniyor" demektir, hata değil.
   */
  async splitDailyDose(
    tenantId: string,
    unitId: string,
    totalKg: number,
  ): Promise<FeederDoseAllocation[]> {
    const shares = await this.getActiveFeeders(tenantId, unitId);
    return splitDoseByShare(shares, totalKg);
  }
}
