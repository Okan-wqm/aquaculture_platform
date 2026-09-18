/**
 * ProtocolResolutionService — band / yem / oran / FCR çözümünün TEK yeri
 * (W3: FARM-HIGH-247, FARM-MEDIUM-251, FARM-MEDIUM-252, FARM-LOW-262,
 * FARM-LOW-263).
 *
 * ## Neden tek çözücü
 *
 * Çözüm zinciri (band → sıcaklık çarpanı → etkin oran → beklenen FCR) üç ayrı
 * yerde ayrı ayrı kuruluyordu: 06:00 üretimi (`meal-plan-generator`), gün-içi
 * recalc (`day-plan-recalc`) ve manuel geçiş (`day-plan-admin`). Sapmalar
 * doğrudan sahaya yansıyordu:
 *
 *  - manuel geçiş bandı **feedId'den** seçiyordu (`bands.findIndex(feedId)`);
 *    aynı pellet iki bandda kullanıldığında — yaygın ve protokol
 *    doğrulamasında yasak değil — yanlış band kilitleniyor, histerezis onu
 *    koruyor ve balık %33 fazla besleniyordu (FARM-MEDIUM-251);
 *  - üretim `autoTransition` ayarını hiç okumuyordu: operatörün bilinçli
 *    manuel seçimi ertesi sabah sessizce eziliyordu (FARM-LOW-262);
 *  - hiçbiri `snapshot`'ı güncellemediği için operatör eski yemi görürken
 *    ledger yeni yemi düşüyordu (FARM-HIGH-247) ve büyüme eski FCR'la
 *    hesaplanıyordu (FARM-MEDIUM-252).
 *
 * Tek çözücü + `FeedingDayPlan.resolution` kolonu bu sınıfı yapısal olarak
 * öldürür: her yol aynı fonksiyonu çağırır ve sonucu AYNI alana yazar.
 *
 * ## Band tabanı (kullanıcı kararı)
 *
 * Band TANK ORTALAMASINDAN seçilir (`tankBatch.avgWeightG`) — rasyon zaten
 * tüm tank biyokütlesine uygulandığı için tutarlı olan budur. Kod bunu zaten
 * yapıyordu; üç yerdeki "dominant-biomass batch" metni gerçeği yanlış beyan
 * ediyordu (FARM-LOW-263). Kural artık bu fonksiyonun adında ve
 * `resolution.bandBasisWeightG` alanında görünür.
 *
 * @module FeedingProtocol/Services
 */
import { Injectable } from '@nestjs/common';

import { FcrMatrix, FeedingProtocolV2, ProtocolBand } from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';
import { DayPlanResolution } from '../entities/feeding-day-plan.entity';
import type { EffectiveTemperature } from '../../water-quality/services/water-temperature.service';
import { ProtocolRateService, ResolvedBand } from './protocol-rate.service';
import { round3 } from '../../common/utils/rounding.util';

export interface ProtocolResolutionInput {
  protocol: Pick<FeedingProtocolV2, 'bands' | 'temperatureAdjustments' | 'fcrMatrix' | 'settings'>;
  assignment: Pick<
    ProtocolAssignment,
    'overrides' | 'currentBandIndex' | 'currentFeedId' | 'manualBandIndex'
  >;
  /** Band tabanı — TANK ORTALAMASI (bkz. dosya başlığı). */
  bandBasisWeightG: number;
  temperature: EffectiveTemperature;
  feedFcrMatrix?: FcrMatrix;
}

export interface ProtocolResolutionResult extends DayPlanResolution {
  /** Çözülen band nesnesi (çağıran öğün feedId'lerini buradan yazar). */
  band: ProtocolBand;
  /** Bu çözüm bandı DEĞİŞTİRDİ mi (geçiş event'i çağıranın işi). */
  bandChanged: boolean;
  previousBandIndex: number | null;
}

@Injectable()
export class ProtocolResolutionService {
  constructor(private readonly rateService: ProtocolRateService) {}

  /**
   * Band tabanı SSoT'si — tank ortalaması (karar gerekçesi dosya başlığında).
   * Ayrı fonksiyon: kural bir yerde isimlendirilmiş olur ve değişmesi
   * gerekirse tek noktadan değişir.
   */
  resolveBandBasisWeight(unit: { avgWeightG: number }): number {
    return Number(unit.avgWeightG);
  }

  /** `null` = protokolde band yok (plan üretilemez; çağıran D-5 raporlar). */
  resolve(input: ProtocolResolutionInput): ProtocolResolutionResult | null {
    const { protocol, assignment, bandBasisWeightG, temperature } = input;

    const weightResolved = this.rateService.bandFor(protocol.bands, bandBasisWeightG);
    if (!weightResolved) return null;

    const previousBandIndex = assignment.currentBandIndex ?? null;
    const effective = this.selectBand(input, weightResolved, previousBandIndex);

    const tempMultiplier = this.rateService.temperatureMultiplier(
      protocol.temperatureAdjustments,
      temperature.celsius,
    );
    const effectiveRatePercent = this.rateService.effectiveRatePercent({
      baseRatePercent: effective.band.feedingRatePercent,
      temperatureMultiplier: tempMultiplier,
      rateAdjustmentPercent: assignment.overrides?.rateAdjustmentPercent,
      minRatePercent: protocol.settings.minFeedingRatePercent,
      maxRatePercent: protocol.settings.maxFeedingRatePercent,
    });
    // FCR çözümü BANDLA BİRLİKTE yenilenir — gün içi band geçişinde eski
    // bandın FCR'ıyla büyüme hesaplamak biyokütleyi ~%55 şişiriyordu.
    const expectedFcr = this.rateService.resolveExpectedFcr({
      band: effective.band,
      fcrSource: protocol.settings.fcrSource,
      avgWeightG: bandBasisWeightG,
      temperatureC: temperature.celsius,
      protocolFcrMatrix: protocol.fcrMatrix,
      feedFcrMatrix: input.feedFcrMatrix,
      fcrOverrides: assignment.overrides?.fcrOverrides,
    });

    return {
      resolvedAt: new Date().toISOString(),
      bandIndex: effective.index,
      feed: {
        id: effective.band.feedId,
        code: effective.band.feedCode,
        name: effective.band.feedName,
      },
      baseRatePercent: effective.band.feedingRatePercent,
      tempMultiplier,
      effectiveRatePercent: round3(effectiveRatePercent),
      expectedFcr: expectedFcr.value,
      fcrResolvedSource: expectedFcr.source,
      bandBasisWeightG: round3(bandBasisWeightG),
      waterTempC: temperature.celsius,
      temperatureSource: temperature.source,
      band: effective.band,
      bandChanged: previousBandIndex !== null && effective.index !== previousBandIndex,
      previousBandIndex,
    };
  }

  /**
   * Band seçimi, öncelik sırasıyla:
   *
   *  1. operatörün ELLE sabitlediği band (`manualBandIndex`), balık onun
   *     üstüne çıkana kadar — FARM-MEDIUM-251;
   *  2. `autoTransition=false` ise ünitenin MEVCUT bandı;
   *  3. histerezis penceresiyle ağırlıktan çözülen band.
   */
  private selectBand(
    input: ProtocolResolutionInput,
    weightResolved: ResolvedBand,
    previousBandIndex: number | null,
  ): ResolvedBand {
    const { protocol, bandBasisWeightG } = input;
    const currentBand = previousBandIndex !== null ? protocol.bands[previousBandIndex] : undefined;

    // (1) Manuel pin — histerezisten ÖNCE. `currentBandIndex`'e bakmak yetmez:
    // manuel geçiş komşu banda yapılabilir, o durumda ağırlık bandı pin'den
    // FARKLIDIR ve histerezis "balık zaten bu bandın içinde" diyerek pin'i
    // aynı transaction içinde geri alıyordu. Pin, balık ÜSTÜNE çıkana kadar
    // yaşar; çıktığında otomatik geçiş devralır (çağıran pin'i temizler).
    const pinnedIndex = input.assignment.manualBandIndex ?? null;
    if (pinnedIndex !== null && weightResolved.index <= pinnedIndex) {
      const pinnedBand = protocol.bands[pinnedIndex];
      if (pinnedBand) return { band: pinnedBand, index: pinnedIndex };
    }

    if (protocol.settings.autoTransition === false) {
      // Manuel mod: mevcut band varsa aynen korunur. Eskiden 06:00 üretimi
      // bu ayarı hiç okumuyor, bandı ağırlıktan çözüp operatörün seçimini
      // sessizce eziyordu (FARM-LOW-262).
      return currentBand ? { band: currentBand, index: previousBandIndex! } : weightResolved;
    }

    if (previousBandIndex === null || !currentBand) return weightResolved;
    if (weightResolved.index === previousBandIndex) return weightResolved;

    // Histerezis: yukarı geçiş yeni bandın altına buffer kadar girmeyi,
    // aşağı geçiş yeni bandın üstünden buffer kadar çıkmayı şart koşar.
    const buffer = protocol.settings.transitionBufferG ?? 0;
    if (weightResolved.index > previousBandIndex) {
      if (bandBasisWeightG >= weightResolved.band.minWeightG + buffer) return weightResolved;
    } else if (bandBasisWeightG <= weightResolved.band.maxWeightG - buffer) {
      return weightResolved;
    }
    return { band: currentBand, index: previousBandIndex };
  }

  /**
   * Manuel geçiş doğrulaması (FARM-MEDIUM-251): hedef yem, ağırlıktan çözülen
   * bandın VEYA ona komşu bandın yemi olmalıdır. Band'ı feedId'den seçmek —
   * eski davranış — aynı pelletin iki bandda kullanıldığı protokollerde
   * yanlış oranı kilitliyordu.
   *
   * Dönen indeks, geçişin hedef bandıdır.
   */
  resolveManualTransitionBand(
    bands: ProtocolBand[],
    bandBasisWeightG: number,
    toFeedId: string,
  ): number | null {
    const weightResolved = this.rateService.bandFor(bands, bandBasisWeightG);
    if (!weightResolved) return null;

    const candidates = [
      weightResolved.index,
      weightResolved.index - 1,
      weightResolved.index + 1,
    ].filter((index) => index >= 0 && index < bands.length);

    for (const index of candidates) {
      if (bands[index]!.feedId === toFeedId) return index;
    }
    return null;
  }
}
