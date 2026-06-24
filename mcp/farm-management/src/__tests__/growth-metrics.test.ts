import { describe, it, expect } from 'vitest';

import { handler, inputSchema } from '../tools/math/calculate-growth-metrics.js';

// ============================================================================
// SGR (Specific Growth Rate) Testleri
// ============================================================================
// Referans: Jobling (1994) — "Fish Bioenergetics"
// FORMUL: SGR = ((ln(Wf) - ln(Wi)) / t) * 100
// ============================================================================

describe('SGR Hesabi', () => {
  it('100g → 150g, 30 gun → SGR ~1.35%/gun', () => {
    // SGR = (ln(150) - ln(100)) / 30 * 100 = 1.3516...
    const expected = ((Math.log(150) - Math.log(100)) / 30) * 100;
    return handler({
      mode: 'sgr',
      initialWeightG: 100,
      finalWeightG: 150,
      days: 30,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.sgrPercentPerDay).toBeCloseTo(expected, 3);
      expect(data.sgrPercentPerDay).toBeCloseTo(1.3516, 3);
      expect(data.rating).toBe('average');
    });
  });

  it('SGR ~0 olur (agirlik degismezse)', () => {
    return handler({
      mode: 'sgr',
      initialWeightG: 100,
      finalWeightG: 100,
      days: 30,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.sgrPercentPerDay).toBeCloseTo(0, 4);
      expect(data.rating).toBe('poor');
    });
  });

  it('50g → 200g, 14 gun → SGR excellent', () => {
    // SGR = (ln(200) - ln(50)) / 14 * 100 = 9.902...
    return handler({
      mode: 'sgr',
      initialWeightG: 50,
      finalWeightG: 200,
      days: 14,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.sgrPercentPerDay).toBeGreaterThan(3);
      expect(data.rating).toBe('excellent');
    });
  });

  it('doubling time hesabi dogru', () => {
    // SGR = 2%/gun → doubling time = ln(2) / 0.02 ≈ 34.66 gun
    return handler({
      mode: 'sgr',
      initialWeightG: 100,
      finalWeightG: 100 * Math.exp(0.02 * 30), // 30 gun, SGR=2%
      days: 30,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.sgrPercentPerDay).toBeCloseTo(2, 1);
      expect(data.doublingTimeDays).toBeCloseTo(34.7, 0);
    });
  });

  it('agirlik kazanimi hesabi', () => {
    return handler({
      mode: 'sgr',
      initialWeightG: 100,
      finalWeightG: 150,
      days: 30,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.weightGainG).toBeCloseTo(50, 2);
      expect(data.weightGainPercent).toBeCloseTo(50, 2);
    });
  });

  it('eksik parametre hata verir', () => {
    return handler({
      mode: 'sgr',
      initialWeightG: 100,
      // finalWeightG eksik
      days: 30,
    } as any).then(result => {
      expect((result as any).isError).toBe(true);
    });
  });
});

// ============================================================================
// FCR (Feed Conversion Ratio) Testleri
// ============================================================================
// Referans: Tacon (1990) — "Standard Methods for the Nutrition of Farmed Fish"
// FORMUL: FCR = tüketilen_yem_kg / kazanilan_biokutle_kg
// ============================================================================

describe('FCR Hesabi', () => {
  it('100kg yem / 80kg kazanc = FCR 1.25', () => {
    return handler({
      mode: 'fcr',
      feedConsumedKg: 100,
      biomassGainKg: 80,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.fcr).toBeCloseTo(1.25, 3);
    });
  });

  it('endüstri ortalamasi karsilastirmasi - salmon', () => {
    return handler({
      mode: 'fcr',
      feedConsumedKg: 120,
      biomassGainKg: 100,
      speciesCode: 'salmon',
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.fcr).toBeCloseTo(1.2, 3);
      expect(data.industryAverageFCR).toBe(1.2);
      // FCR = industri ortalamasi → good
      expect(data.efficiency).toBe('good');
    });
  });

  it('dusuk FCR = excellent verimlilik', () => {
    return handler({
      mode: 'fcr',
      feedConsumedKg: 90,
      biomassGainKg: 100,
      speciesCode: 'salmon',
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      // FCR = 0.9, industry avg = 1.2, 0.9 <= 1.2*0.85 = 1.02 → excellent
      expect(data.fcr).toBeCloseTo(0.9, 3);
      expect(data.efficiency).toBe('excellent');
    });
  });

  it('yuksek FCR = poor verimlilik', () => {
    return handler({
      mode: 'fcr',
      feedConsumedKg: 250,
      biomassGainKg: 100,
      speciesCode: 'tilapia',
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      // FCR = 2.5, industry avg for tilapia = 1.6
      // 2.5 > 1.6 * 1.2 = 1.92 → poor
      expect(data.fcr).toBeCloseTo(2.5, 3);
      expect(data.efficiency).toBe('poor');
    });
  });

  it('tur belirtilmezse varsayilan industri ortalamasi kullanilir', () => {
    return handler({
      mode: 'fcr',
      feedConsumedKg: 150,
      biomassGainKg: 100,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.industryAverageFCR).toBe(1.5);
    });
  });
});

// ============================================================================
// Biomass Hesabi Testleri
// ============================================================================

describe('Biomass Hesabi', () => {
  it('10000 adet x 250g = 2500 kg', () => {
    return handler({
      mode: 'biomass',
      quantity: 10000,
      avgWeightG: 250,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.biomassKg).toBe(2500);
    });
  });

  it('yogunluk hesabi dogru', () => {
    return handler({
      mode: 'biomass',
      quantity: 10000,
      avgWeightG: 250,
      tankVolumeM3: 100,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      // 2500 kg / 100 m3 = 25 kg/m3 → high
      expect(data.densityKgM3).toBe(25);
      expect(data.densityStatus).toBe('high');
    });
  });

  it('dusuk yogunluk', () => {
    return handler({
      mode: 'biomass',
      quantity: 100,
      avgWeightG: 100,
      tankVolumeM3: 100,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      // 10 kg / 100 m3 = 0.1 kg/m3 → low
      expect(data.densityKgM3).toBe(0.1);
      expect(data.densityStatus).toBe('low');
    });
  });
});
