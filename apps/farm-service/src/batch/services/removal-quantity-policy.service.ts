/**
 * RemovalQuantityPolicyService — düşüm miktarı modlarının SSoT'si (Faz 5, D-3).
 *
 * Kullanıcı gereksinimi: ölüm/hasat/cull/transfer girişleri ÜÇ modu destekler
 * ve TankBatch + TankOperation ledger'ına TUTARLI yansır:
 *  (a) TANE girişi → `count` düşer; biyokütle düşümü count × güncel
 *      avgWeightG/1000 (ortalama ağırlık DEĞİŞMEZ).
 *  (b) TANE + KG girişi → ikisi AYNEN uygulanır; kalanın ortalaması türetilir
 *      (örn. büyük balık hasadı → kalan ortalaması düşer) — harvest'in bugünkü
 *      semantiği tüm removal'lara standardize edilir.
 *  (c) YALNIZ KG girişi → `count = round(kg / avgWeight)` türetilir ve
 *      `countDerived=true` bayrağı TankOperation + event'e işlenir (sessiz
 *      varsayım yok).
 *
 * FCR'ın gerçekleşen-büyüme hesabı her iki modda da AYNI ledger satırlarını
 * okur — mod farkı FCR'ı bozamaz. Her mod `DayPlanRecalcService`'i tetikler
 * (handler bağlantısı); bu servis SAF hesap + doğrulamadır.
 *
 * Mevcut `MortalityCullPolicyService` guard'ları (sayı üst sınırı, terminal
 * batch reddi) değişmeden yaşar — bu servis miktar ÇÖZÜMÜNÜ sahiplenir.
 *
 * @module Batch/Services
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { round3 } from '../../common/utils/rounding.util';

export interface RemovalQuantityInput {
  /** Tane girişi (mod a/b). */
  count?: number;
  /** Doğrudan biyokütle girişi kg (mod b/c). */
  biomassKg?: number;
  /** Düşüm anındaki mevcut sayı (üst sınır doğrulaması). */
  currentQuantity: number;
  /** Düşüm anındaki mevcut biyokütle kg (üst sınır doğrulaması). */
  currentBiomassKg: number;
  /** Düşüm anındaki ortalama ağırlık g (türetimlerin tabanı). */
  currentAvgWeightG: number;
}

export interface ResolvedRemoval {
  count: number;
  biomassKg: number;
  /** Yalnız-kg modunda true — TankOperation ve event bu bayrağı taşır (D-3). */
  countDerived: boolean;
  /**
   * Mod b'de kalan ortalama ağırlık (g) — verilen kg, tane×ortalama'dan
   * saptığında kalan sürünün ortalaması kayar. Mod a/c'de değişmez (null).
   */
  remainingAvgWeightG: number | null;
}

@Injectable()
export class RemovalQuantityPolicyService {
  /**
   * Üç giriş modunu tek çözüme indirir; giriş yoksa/negatifse/mevcudu aşarsa
   * fail-closed reddeder. SAF: hiçbir yan etki yok.
   */
  resolve(input: RemovalQuantityInput): ResolvedRemoval {
    const hasCount = input.count !== undefined && input.count !== null;
    const hasBiomass = input.biomassKg !== undefined && input.biomassKg !== null;
    if (!hasCount && !hasBiomass) {
      throw new BadRequestException('Düşüm için tane (count) veya kg (biomassKg) girilmelidir');
    }
    if (hasCount && (!Number.isFinite(input.count) || input.count! <= 0)) {
      throw new BadRequestException('Düşüm tanesi pozitif olmalıdır');
    }
    if (hasBiomass && (!Number.isFinite(input.biomassKg) || input.biomassKg! <= 0)) {
      throw new BadRequestException('Düşüm biyokütlesi (kg) pozitif olmalıdır');
    }

    // Mod (a): yalnız tane — ortalama değişmez, kg türetilir.
    if (hasCount && !hasBiomass) {
      const count = Math.trunc(input.count!);
      this.assertCountWithinCurrent(count, input.currentQuantity);
      const biomassKg = round3((count * input.currentAvgWeightG) / 1000);
      return { count, biomassKg, countDerived: false, remainingAvgWeightG: null };
    }

    // Mod (c): yalnız kg — tane türetilir + bayraklanır.
    if (!hasCount && hasBiomass) {
      if (input.currentAvgWeightG <= 0) {
        throw new BadRequestException(
          'Yalnız-kg düşümü için ünitenin ortalama ağırlığı bilinmelidir (avgWeightG > 0)',
        );
      }
      const biomassKg = input.biomassKg!;
      this.assertBiomassWithinCurrent(biomassKg, input.currentBiomassKg);
      const derived = Math.round((biomassKg * 1000) / input.currentAvgWeightG);
      const count = Math.min(Math.max(derived, 1), input.currentQuantity);
      return { count, biomassKg: round3(biomassKg), countDerived: true, remainingAvgWeightG: null };
    }

    // Mod (b): tane + kg — ikisi aynen; kalan ortalama türetilir.
    const count = Math.trunc(input.count!);
    const biomassKg = input.biomassKg!;
    this.assertCountWithinCurrent(count, input.currentQuantity);
    this.assertBiomassWithinCurrent(biomassKg, input.currentBiomassKg);
    const remainingCount = input.currentQuantity - count;
    const remainingBiomassKg = input.currentBiomassKg - biomassKg;
    const remainingAvgWeightG =
      remainingCount > 0 ? round3((remainingBiomassKg * 1000) / remainingCount) : null;
    if (remainingAvgWeightG !== null && remainingAvgWeightG < 0) {
      throw new BadRequestException(
        'Verilen kg, kalan sürünün biyokütlesini negatife düşürür — giriş tutarsız',
      );
    }
    return { count, biomassKg: round3(biomassKg), countDerived: false, remainingAvgWeightG };
  }

  private assertCountWithinCurrent(count: number, currentQuantity: number): void {
    if (count > currentQuantity) {
      throw new BadRequestException(
        `Düşüm tanesi (${count}) mevcut sayıdan (${currentQuantity}) fazla olamaz`,
      );
    }
  }

  private assertBiomassWithinCurrent(biomassKg: number, currentBiomassKg: number): void {
    // Küçük yuvarlama payı: aggregate'ler 3 hane yuvarlanıyor.
    if (biomassKg > currentBiomassKg + 0.001) {
      throw new BadRequestException(
        `Düşüm biyokütlesi (${biomassKg}kg) mevcut biyokütleden (${currentBiomassKg}kg) fazla olamaz`,
      );
    }
  }
}
