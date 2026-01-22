/**
 * Bilinear Interpolation Service
 *
 * 2D besleme matrisinden (sıcaklık x ağırlık) yemleme oranını
 * bilinear interpolasyon ile hesaplar.
 *
 * Örnek: Su 13°C ve balık 7g ise, 12-14°C ve 5-10g köşe
 * değerlerinden ara değer hesaplanır.
 */
import { Injectable, Logger } from '@nestjs/common';
import { FeedingMatrix2D } from '../../feed/entities/feed.entity';

export interface InterpolationResult {
  feedingRatePercent: number;
  fcr?: number;
  // Hangi noktalardan interpolasyon yapıldığını debug için
  boundingBox?: {
    t1: number;
    t2: number;
    w1: number;
    w2: number;
  };
}

@Injectable()
export class BilinearInterpolationService {
  private readonly logger = new Logger(BilinearInterpolationService.name);

  /**
   * 2D matris üzerinde bilinear interpolasyon yapar
   *
   * @param matrix FeedingMatrix2D - sıcaklık ve ağırlık eksenleri ile rate matrisi
   * @param temperature Su sıcaklığı (°C)
   * @param weightG Balık ağırlığı (gram)
   * @returns { feedingRatePercent, fcr? }
   */
  interpolate(
    matrix: FeedingMatrix2D,
    temperature: number,
    weightG: number,
  ): InterpolationResult {
    const { temperatures, weights, rates, fcrMatrix } = matrix;

    // Matris geçerlilik kontrolü
    if (!temperatures?.length || !weights?.length || !rates?.length) {
      this.logger.warn('Invalid matrix: empty temperatures, weights, or rates');
      return { feedingRatePercent: 3.0 }; // Default %3
    }

    // Sıcaklık için sınır indekslerini bul
    const tIndices = this.findBoundingIndices(temperatures, temperature);
    // Ağırlık için sınır indekslerini bul
    const wIndices = this.findBoundingIndices(weights, weightG);

    // Köşe değerlerini al (array bounds already validated above)
    const t1 = temperatures[tIndices.lower] ?? temperatures[0] ?? 15;
    const t2 = temperatures[tIndices.upper] ?? temperatures[0] ?? 15;
    const w1 = weights[wIndices.lower] ?? weights[0] ?? 10;
    const w2 = weights[wIndices.upper] ?? weights[0] ?? 10;

    // Rate matrisinden köşe değerlerini al
    const r11 = this.safeGet(rates, tIndices.lower, wIndices.lower, 3.0); // f(t1,w1)
    const r21 = this.safeGet(rates, tIndices.upper, wIndices.lower, 3.0); // f(t2,w1)
    const r12 = this.safeGet(rates, tIndices.lower, wIndices.upper, 3.0); // f(t1,w2)
    const r22 = this.safeGet(rates, tIndices.upper, wIndices.upper, 3.0); // f(t2,w2)

    // Bilinear interpolasyon
    const feedingRatePercent = this.bilinear(
      temperature, weightG,
      t1, t2, w1, w2,
      r11, r21, r12, r22,
    );

    // FCR için de aynı işlemi yap (varsa)
    let fcr: number | undefined;
    if (fcrMatrix?.length) {
      const f11 = this.safeGet(fcrMatrix, tIndices.lower, wIndices.lower, 1.0);
      const f21 = this.safeGet(fcrMatrix, tIndices.upper, wIndices.lower, 1.0);
      const f12 = this.safeGet(fcrMatrix, tIndices.lower, wIndices.upper, 1.0);
      const f22 = this.safeGet(fcrMatrix, tIndices.upper, wIndices.upper, 1.0);

      fcr = this.bilinear(
        temperature, weightG,
        t1, t2, w1, w2,
        f11, f21, f12, f22,
      );
    }

    return {
      feedingRatePercent: Math.round(feedingRatePercent * 100) / 100, // 2 ondalık
      fcr: fcr ? Math.round(fcr * 100) / 100 : undefined,
      boundingBox: { t1, t2, w1, w2 },
    };
  }

  /**
   * Verilen değer için sınırlayıcı indeksleri bulur
   * Değer eksen sınırları dışındaysa en yakın uçlara clamp eder
   */
  private findBoundingIndices(
    axis: number[],
    value: number,
  ): { lower: number; upper: number } {
    // Eksen boşsa
    if (!axis.length) {
      return { lower: 0, upper: 0 };
    }

    const firstVal = axis[0];
    const lastVal = axis[axis.length - 1];

    // Değer minimum'dan küçükse
    if (firstVal !== undefined && value <= firstVal) {
      return { lower: 0, upper: 0 };
    }

    // Değer maksimumdan büyükse
    if (lastVal !== undefined && value >= lastVal) {
      const last = axis.length - 1;
      return { lower: last, upper: last };
    }

    // Aradaki indeksleri bul
    for (let i = 0; i < axis.length - 1; i++) {
      const current = axis[i];
      const next = axis[i + 1];
      if (current !== undefined && next !== undefined && value >= current && value < next) {
        return { lower: i, upper: i + 1 };
      }
    }

    // Fallback (olmamalı)
    return { lower: 0, upper: 0 };
  }

  /**
   * 2D diziden güvenli değer okuma
   */
  private safeGet(
    matrix: number[][],
    row: number,
    col: number,
    defaultValue: number,
  ): number {
    const rowData = matrix?.[row];
    if (!rowData) {
      return defaultValue;
    }
    const value = rowData[col];
    if (value === undefined || value === null || typeof value !== 'number' || isNaN(value)) {
      return defaultValue;
    }
    return value;
  }

  /**
   * Bilinear interpolasyon formülü
   *
   * f(x,y) = [f(x1,y1)(x2-x)(y2-y) + f(x2,y1)(x-x1)(y2-y)
   *         + f(x1,y2)(x2-x)(y-y1) + f(x2,y2)(x-x1)(y-y1)]
   *         / [(x2-x1)(y2-y1)]
   *
   * Burada:
   * - x = temperature, x1/x2 = t1/t2
   * - y = weight, y1/y2 = w1/w2
   * - f değerleri = rate değerleri
   */
  private bilinear(
    x: number, y: number,
    x1: number, x2: number,
    y1: number, y2: number,
    f11: number, f21: number,
    f12: number, f22: number,
  ): number {
    // Edge case: Aynı nokta (interpolasyon gerekmiyor)
    if (x1 === x2 && y1 === y2) {
      return f11;
    }

    // Sadece x'te interpolasyon (y1 === y2)
    if (y1 === y2) {
      if (x1 === x2) return f11;
      return f11 + (f21 - f11) * (x - x1) / (x2 - x1);
    }

    // Sadece y'de interpolasyon (x1 === x2)
    if (x1 === x2) {
      return f11 + (f12 - f11) * (y - y1) / (y2 - y1);
    }

    // Tam bilinear interpolasyon
    const denom = (x2 - x1) * (y2 - y1);

    return (
      f11 * (x2 - x) * (y2 - y) +
      f21 * (x - x1) * (y2 - y) +
      f12 * (x2 - x) * (y - y1) +
      f22 * (x - x1) * (y - y1)
    ) / denom;
  }

  /**
   * Matrisin geçerli olup olmadığını kontrol eder
   */
  validateMatrix(matrix: FeedingMatrix2D): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!matrix) {
      errors.push('Matrix is null or undefined');
      return { valid: false, errors };
    }

    if (!matrix.temperatures?.length) {
      errors.push('Temperature axis is empty');
    }

    if (!matrix.weights?.length) {
      errors.push('Weight axis is empty');
    }

    if (!matrix.rates?.length) {
      errors.push('Rates matrix is empty');
    }

    // Boyut kontrolü
    if (matrix.temperatures?.length && matrix.rates?.length) {
      if (matrix.rates.length !== matrix.temperatures.length) {
        errors.push(`Rates matrix rows (${matrix.rates.length}) must match temperature count (${matrix.temperatures.length})`);
      }
    }

    if (matrix.weights?.length && matrix.rates?.length) {
      for (let i = 0; i < matrix.rates.length; i++) {
        if (matrix.rates[i]?.length !== matrix.weights.length) {
          errors.push(`Rates matrix row ${i} columns (${matrix.rates[i]?.length}) must match weight count (${matrix.weights.length})`);
        }
      }
    }

    // Sıralama kontrolü (artan sırada olmalı)
    if (matrix.temperatures?.length > 1) {
      const temps = matrix.temperatures;
      for (let i = 1; i < temps.length; i++) {
        const current = temps[i];
        const prev = temps[i - 1];
        if (current !== undefined && prev !== undefined && current <= prev) {
          errors.push('Temperature values must be in ascending order');
          break;
        }
      }
    }

    if (matrix.weights?.length > 1) {
      const weights = matrix.weights;
      for (let i = 1; i < weights.length; i++) {
        const current = weights[i];
        const prev = weights[i - 1];
        if (current !== undefined && prev !== undefined && current <= prev) {
          errors.push('Weight values must be in ascending order');
          break;
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
