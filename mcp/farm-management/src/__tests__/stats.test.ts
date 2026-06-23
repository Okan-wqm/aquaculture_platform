import { describe, it, expect } from 'vitest';

import {
  mean,
  stdDev,
  zScore,
  movingAverage,
  pearsonCorrelation,
  correlationPValue,
  correlationConfidenceInterval,
  linearRegressionSlope,
  percentChange,
  median,
  normalize,
} from '../utils/stats.js';

// ============================================================================
// Temel Istatistikler
// ============================================================================

describe('mean', () => {
  it('bos dizi → 0', () => {
    expect(mean([])).toBe(0);
  });

  it('tek eleman → o eleman', () => {
    expect(mean([42])).toBe(42);
  });

  it('[1,2,3,4,5] → 3', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it('negatif degerler', () => {
    expect(mean([-2, -1, 0, 1, 2])).toBe(0);
  });
});

describe('stdDev', () => {
  it('bos dizi → 0', () => {
    expect(stdDev([])).toBe(0);
  });

  it('tek eleman → 0', () => {
    expect(stdDev([5])).toBe(0);
  });

  it('tum degerler ayni → 0', () => {
    expect(stdDev([3, 3, 3, 3])).toBe(0);
  });

  it('[2, 4, 4, 4, 5, 5, 7, 9] → orneklem stddev ~2.138', () => {
    // Mean = 5, orneklem varyans = 36/7 ≈ 5.1429, stddev ≈ 2.138
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });
});

// ============================================================================
// Z-Score Testleri
// ============================================================================

describe('Z-Score', () => {
  it('ortalamada → z = 0', () => {
    expect(zScore(10, 10, 2)).toBe(0);
  });

  it('2sigma uzakta → z = 2', () => {
    expect(zScore(14, 10, 2)).toBe(2);
  });

  it('negatif sapma → z = -2', () => {
    expect(zScore(6, 10, 2)).toBe(-2);
  });

  it('stddev = 0 → z = 0 (koruma)', () => {
    expect(zScore(15, 10, 0)).toBe(0);
  });

  it('3sigma anomali', () => {
    expect(zScore(16, 10, 2)).toBe(3);
    expect(Math.abs(zScore(16, 10, 2))).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// Hareketli Ortalama Testleri
// ============================================================================

describe('movingAverage', () => {
  it('bos dizi → bos dizi', () => {
    expect(movingAverage([], 3)).toEqual([]);
  });

  it('pencere = 1 → orijinal dizi', () => {
    expect(movingAverage([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });

  it('pencere = 3 → yumusatilmis dizi', () => {
    const result = movingAverage([1, 3, 5, 7, 9], 3);
    // Indeks 0: [1] → 1
    // Indeks 1: [1,3] → 2
    // Indeks 2: [1,3,5] → 3
    // Indeks 3: [3,5,7] → 5
    // Indeks 4: [5,7,9] → 7
    expect(result[0]).toBeCloseTo(1, 5);
    expect(result[1]).toBeCloseTo(2, 5);
    expect(result[2]).toBeCloseTo(3, 5);
    expect(result[3]).toBeCloseTo(5, 5);
    expect(result[4]).toBeCloseTo(7, 5);
  });

  it('sonuc dizisi giris dizisi ile ayni uzunlukta', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = movingAverage(input, 5);
    expect(result).toHaveLength(input.length);
  });
});

// ============================================================================
// Pearson Korelasyon Testleri
// ============================================================================

describe('Pearson Korelasyon', () => {
  it('tam pozitif korelasyon → r = 1', () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 6);
  });

  it('tam negatif korelasyon → r = -1', () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBeCloseTo(-1, 6);
  });

  it('iliskisiz → r ≈ 0', () => {
    // Matematiksel olarak r = 0 olan veri seti
    const x = [1, 2, 3, 4, 5];
    const y = [2, -1, 3, -2, 3]; // Bu tam 0 olmayabilir ama düşük olmalı
    const r = pearsonCorrelation(x, y);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  it('bos veya tek elemanli dizi → 0', () => {
    expect(pearsonCorrelation([], [])).toBe(0);
    expect(pearsonCorrelation([1], [2])).toBe(0);
  });

  it('sabit dizi → 0 (stddev = 0)', () => {
    expect(pearsonCorrelation([3, 3, 3], [1, 2, 3])).toBe(0);
  });

  it('farkli uzunluktaki diziler → kisa olanin uzunlugu kullanilir', () => {
    const r1 = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    const r2 = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10, 99, 99]);
    expect(r1).toBeCloseTo(r2, 6);
  });
});

// ============================================================================
// Korelasyon P-Value Testleri
// ============================================================================

describe('correlationPValue', () => {
  it('n <= 2 → p = 1 (yetersiz veri)', () => {
    expect(correlationPValue(0.9, 2)).toBe(1);
    expect(correlationPValue(0.9, 1)).toBe(1);
  });

  it('|r| = 1 → p = 0 (tam korelasyon)', () => {
    expect(correlationPValue(1, 10)).toBe(0);
    expect(correlationPValue(-1, 10)).toBe(0);
  });

  it('guclu korelasyon, buyuk orneklem → dusuk p', () => {
    const p = correlationPValue(0.9, 100);
    expect(p).toBeLessThan(0.001);
  });

  it('zayif korelasyon, kucuk orneklem → yuksek p', () => {
    const p = correlationPValue(0.1, 5);
    expect(p).toBeGreaterThan(0.05);
  });

  it('p degeri 0-1 arasinda', () => {
    const p = correlationPValue(0.5, 20);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});

// ============================================================================
// Guven Araligi Testleri
// ============================================================================

describe('correlationConfidenceInterval', () => {
  it('n <= 3 → [-1, 1] (hesaplanamaz)', () => {
    const ci = correlationConfidenceInterval(0.5, 3);
    expect(ci.lower).toBe(-1);
    expect(ci.upper).toBe(1);
  });

  it('buyuk orneklem, yuksek r → dar aralik', () => {
    const ci = correlationConfidenceInterval(0.9, 100);
    expect(ci.lower).toBeGreaterThan(0.8);
    expect(ci.upper).toBeLessThanOrEqual(1);
  });

  it('lower < upper her zaman', () => {
    const ci = correlationConfidenceInterval(0.5, 30);
    expect(ci.lower).toBeLessThan(ci.upper);
  });

  it('r = 0, buyuk orneklem → aralik 0 civarinda', () => {
    const ci = correlationConfidenceInterval(0, 200);
    expect(ci.lower).toBeLessThan(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(Math.abs(ci.lower)).toBeLessThan(0.2);
    expect(Math.abs(ci.upper)).toBeLessThan(0.2);
  });
});

// ============================================================================
// Lineer Regresyon Testleri
// ============================================================================

describe('linearRegressionSlope', () => {
  it('tam lineer iliski → dogru egim', () => {
    // y = 2x + 1 → slope = 2
    const x = [1, 2, 3, 4, 5];
    const y = [3, 5, 7, 9, 11];
    expect(linearRegressionSlope(x, y)).toBeCloseTo(2, 6);
  });

  it('negatif egim', () => {
    // y = -3x + 10 → slope = -3
    const x = [1, 2, 3, 4, 5];
    const y = [7, 4, 1, -2, -5];
    expect(linearRegressionSlope(x, y)).toBeCloseTo(-3, 6);
  });

  it('yatay cizgi → slope = 0', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [5, 5, 5, 5, 5];
    expect(linearRegressionSlope(x, y)).toBe(0);
  });

  it('yetersiz veri → 0', () => {
    expect(linearRegressionSlope([], [])).toBe(0);
    expect(linearRegressionSlope([1], [2])).toBe(0);
  });
});

// ============================================================================
// Yuzde Degisim Testleri
// ============================================================================

describe('percentChange', () => {
  it('100 → 150 = %50 artis', () => {
    expect(percentChange(100, 150)).toBe(50);
  });

  it('100 → 75 = %25 azalis', () => {
    expect(percentChange(100, 75)).toBe(-25);
  });

  it('degisim yok → 0', () => {
    expect(percentChange(100, 100)).toBe(0);
  });

  it('her ikisi de sifir → 0', () => {
    expect(percentChange(0, 0)).toBe(0);
  });

  it('eski = 0, yeni > 0 → 100', () => {
    expect(percentChange(0, 5)).toBe(100);
  });

  it('eski = 0, yeni < 0 → -100', () => {
    expect(percentChange(0, -5)).toBe(-100);
  });

  it('2 katina cikma → %100', () => {
    expect(percentChange(50, 100)).toBe(100);
  });
});

// ============================================================================
// Median Testleri
// ============================================================================

describe('median', () => {
  it('bos dizi → 0', () => {
    expect(median([])).toBe(0);
  });

  it('tek eleman', () => {
    expect(median([42])).toBe(42);
  });

  it('tek sayida eleman → ortadaki', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('cift sayida eleman → ortadaki ikisinin ortalamasi', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('sirasiz dizi dogru siralanir', () => {
    expect(median([5, 1, 3, 2, 4])).toBe(3);
  });

  it('outlier dayanikliligi', () => {
    // Ortalama 22, median 3 → median outlier'a dayanikli
    expect(median([1, 2, 3, 4, 100])).toBe(3);
    expect(mean([1, 2, 3, 4, 100])).toBe(22);
  });
});

// ============================================================================
// Normalizasyon Testleri
// ============================================================================

describe('normalize', () => {
  it('minimum → 0', () => {
    expect(normalize(0, 0, 10)).toBe(0);
  });

  it('maksimum → 1', () => {
    expect(normalize(10, 0, 10)).toBe(1);
  });

  it('ortada → 0.5', () => {
    expect(normalize(5, 0, 10)).toBe(0.5);
  });

  it('min = max → 0 (aralik sifir)', () => {
    expect(normalize(5, 5, 5)).toBe(0);
  });

  it('aralik disinda (clamp yok)', () => {
    expect(normalize(15, 0, 10)).toBe(1.5);
    expect(normalize(-5, 0, 10)).toBe(-0.5);
  });
});
