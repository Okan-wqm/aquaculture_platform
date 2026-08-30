/**
 * ProtocolRateService — band → yem/oran/FCR çözümünün SSoT'si.
 *
 * v1'de dört kopyası olan `findFeedForWeight` mantığının (P-04) tek varisi.
 * Saf servis: plan üretimi (06:00 cron), öğün kaydı sonrası recalc ve forecast
 * AYNI çözümü buradan okur — motorla tahmin asla birbirinden sapamaz.
 *
 * Kurallar:
 *  - Bantlar yarı-açık [min,max): 100g, "100-500" bandına düşer; kenarlar clamp.
 *  - Sıcaklık okuması YOKSA çarpan 1.0 — default sıcaklık asla oran ölçeklemez
 *    (P-20; v1'in sessiz 15°C varsayımının yerine açık NONE semantiği).
 *  - Etkin oran = taban × sıcaklıkÇarpanı × (1 + rateAdj/100) [K-18 düzeltmesi],
 *    protokol min/max sınırlarına clamp'li.
 *  - Beklenen FCR çözüm sırası: ünite OVERRIDE → protokol kaynağı
 *    (band | matrix | feed) — provenans `FcrResolvedSource` ile raporlanır (K-15).
 *
 * @module FeedingProtocol/Services
 */
import { Injectable } from '@nestjs/common';

import {
  FcrMatrix,
  FcrResolvedSource,
  MAX_EXPECTED_FCR,
  MIN_EXPECTED_FCR,
  ProtocolBand,
  ProtocolFcrSource,
  TemperatureAdjustment,
} from '../entities/feeding-protocol-v2.entity';
import { FcrOverride } from '../entities/protocol-assignment.entity';

export interface ResolvedBand {
  band: ProtocolBand;
  index: number;
}

export interface EffectiveRateInput {
  baseRatePercent: number;
  temperatureMultiplier: number;
  /** Atama override'ı: ±yüzde (−50..50). */
  rateAdjustmentPercent?: number;
  minRatePercent?: number;
  maxRatePercent?: number;
}

export interface ExpectedFcrInput {
  band: ProtocolBand;
  fcrSource: ProtocolFcrSource;
  avgWeightG: number;
  /** null = okuma yok (matris interpolasyonu ağırlık-eksenine iner). */
  temperatureC: number | null;
  protocolFcrMatrix?: FcrMatrix;
  /** Feed ürününün FCR matrisi (fcrSource=feed için çağıran sağlar). */
  feedFcrMatrix?: FcrMatrix;
  fcrOverrides?: FcrOverride[];
}

export interface ExpectedFcrResult {
  value: number;
  source: FcrResolvedSource;
}

@Injectable()
export class ProtocolRateService {
  /** Yarı-açık [min,max) çözüm; kenarlarda clamp; boş liste → null. */
  bandFor(bands: ProtocolBand[], avgWeightG: number): ResolvedBand | null {
    if (!bands.length) return null;
    const sorted = [...bands]
      .map((band, index) => ({ band, index }))
      .sort((a, b) => a.band.minWeightG - b.band.minWeightG);

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last) return null;

    if (avgWeightG < first.band.minWeightG) return first;
    for (const entry of sorted) {
      if (avgWeightG >= entry.band.minWeightG && avgWeightG < entry.band.maxWeightG) {
        return entry;
      }
    }
    return last;
  }

  /** Okuma yok veya eşleşen band yok → 1.0 (asla ölçekleme yapma). */
  temperatureMultiplier(
    adjustments: TemperatureAdjustment[] | undefined,
    temperatureC: number | null,
  ): number {
    if (temperatureC === null || !adjustments?.length) return 1.0;
    for (const adj of adjustments) {
      if (temperatureC >= adj.minC && temperatureC < adj.maxC) {
        return adj.rateMultiplier;
      }
    }
    return 1.0;
  }

  effectiveRatePercent(input: EffectiveRateInput): number {
    const adjusted =
      input.baseRatePercent *
      input.temperatureMultiplier *
      (1 + (input.rateAdjustmentPercent ?? 0) / 100);
    const lower = input.minRatePercent ?? 0;
    const upper = input.maxRatePercent ?? Number.POSITIVE_INFINITY;
    return Math.min(Math.max(adjusted, lower), upper);
  }

  /** OVERRIDE → (band | matrix | feed); her sonuç biyolojik 0.5–5 aralığına clamp'lenir. */
  resolveExpectedFcr(input: ExpectedFcrInput): ExpectedFcrResult {
    const override = input.fcrOverrides?.find((o) => o.feedId === input.band.feedId);
    if (override) {
      return { value: this.clampFcr(override.expectedFcr), source: FcrResolvedSource.OVERRIDE };
    }

    if (input.fcrSource === ProtocolFcrSource.MATRIX && input.protocolFcrMatrix) {
      return {
        value: this.clampFcr(
          this.interpolateMatrix(input.protocolFcrMatrix, input.temperatureC, input.avgWeightG),
        ),
        source: FcrResolvedSource.MATRIX,
      };
    }
    if (input.fcrSource === ProtocolFcrSource.FEED && input.feedFcrMatrix) {
      return {
        value: this.clampFcr(
          this.interpolateMatrix(input.feedFcrMatrix, input.temperatureC, input.avgWeightG),
        ),
        source: FcrResolvedSource.FEED,
      };
    }
    // Band skaleri hem varsayılan kaynak hem de eksik-matris fallback'idir —
    // sessiz sapma yok: provenans BAND olarak raporlanır.
    return { value: this.clampFcr(input.band.expectedFcr), source: FcrResolvedSource.BAND };
  }

  private clampFcr(value: number): number {
    return Math.min(Math.max(value, MIN_EXPECTED_FCR), MAX_EXPECTED_FCR);
  }

  /**
   * FCR matrisi üzerinde bilinear interpolasyon. Sıcaklık okuması yokken
   * matrisin İLK sıcaklık satırı kullanılır (tek eksenli ağırlık
   * interpolasyonu) — uydurma bir default sıcaklık asla üretilmez.
   */
  private interpolateMatrix(
    matrix: FcrMatrix,
    temperatureC: number | null,
    avgWeightG: number,
  ): number {
    const temps = matrix.temperatures;
    const weights = matrix.weights;
    const firstRow = matrix.fcrValues[0];
    if (!temps.length || !weights.length || !firstRow) {
      return MAX_EXPECTED_FCR;
    }

    const t = temperatureC ?? temps[0] ?? 0;
    const { lower: tLo, upper: tHi } = this.bounding(temps, t);
    const { lower: wLo, upper: wHi } = this.bounding(weights, avgWeightG);

    const t1 = temps[tLo] ?? t;
    const t2 = temps[tHi] ?? t;
    const w1 = weights[wLo] ?? avgWeightG;
    const w2 = weights[wHi] ?? avgWeightG;

    const v11 = matrix.fcrValues[tLo]?.[wLo] ?? firstRow[0] ?? MAX_EXPECTED_FCR;
    const v21 = matrix.fcrValues[tHi]?.[wLo] ?? v11;
    const v12 = matrix.fcrValues[tLo]?.[wHi] ?? v11;
    const v22 = matrix.fcrValues[tHi]?.[wHi] ?? v11;

    const tFrac = t2 === t1 ? 0 : (t - t1) / (t2 - t1);
    const wFrac = w2 === w1 ? 0 : (avgWeightG - w1) / (w2 - w1);

    const top = v11 + (v21 - v11) * tFrac;
    const bottom = v12 + (v22 - v12) * tFrac;
    return top + (bottom - top) * wFrac;
  }

  private bounding(axis: number[], value: number): { lower: number; upper: number } {
    if (value <= (axis[0] ?? value)) return { lower: 0, upper: 0 };
    const lastIndex = axis.length - 1;
    const lastValue = axis[lastIndex] ?? value;
    if (value >= lastValue) return { lower: lastIndex, upper: lastIndex };
    for (let i = 0; i < lastIndex; i++) {
      const current = axis[i] ?? value;
      const next = axis[i + 1] ?? value;
      if (value >= current && value <= next) return { lower: i, upper: i + 1 };
    }
    return { lower: lastIndex, upper: lastIndex };
  }
}
