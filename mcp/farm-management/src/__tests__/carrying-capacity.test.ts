import { describe, it, expect } from 'vitest';

import { handler } from '../tools/math/calculate-carrying-capacity.js';
import { calcDOSaturation } from '../utils/formulas.js';

// ============================================================================
// Tasima Kapasitesi Testleri
// ============================================================================
// Referans: Wedemeyer (1996), Ellis et al. (2002), Colt (2006)
//
// Iki kisit:
//   1. Yogunluk kisiti: maxBiomass = maxDensity * volume
//   2. Oksijen kisiti:  maxBiomass = DO_available / O2_per_kg
//
// Sinirlandirici faktor = min(yogunluk, oksijen)
// ============================================================================

describe('Carrying Capacity', () => {
  it('yogunluk limiti < oksijen limiti → yogunluk limitleyici', () => {
    // Cok dusuk maxDensity, buyuk tank, dusuk sicaklik → yogunluk baskili olur
    return handler({
      tankVolumeM3: 1000,
      temperature: 10,       // Dusuk sicaklik → yuksek DO → yuksek oksijen limiti
      avgFishWeightG: 250,
      maxDensityKgM3: 1,     // Cok dusuk yogunluk siniri → 1 * 1000 = 1000 kg
      dailyFeedingRatePercent: 0.5,
      salinity: 0,
      hasBiofilter: false,
      minDOMgL: 5,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.limitingFactor).toBe('density');
      expect(data.maxBiomassKg).toBeCloseTo(1000, 0);
      expect(data.limits.density.maxBiomassKg).toBe(1000);
    });
  });

  it('oksijen limiti < yogunluk limiti → oksijen limitleyici', () => {
    // Yuksek maxDensity ama yuksek sicaklik + biyofiltre → oksijen siniri
    return handler({
      tankVolumeM3: 10,
      temperature: 30,        // Yuksek sicaklik → dusuk DO
      avgFishWeightG: 250,
      maxDensityKgM3: 100,    // Yuksek yogunluk siniri → 100 * 10 = 1000 kg
      dailyFeedingRatePercent: 3,
      hasBiofilter: true,
      salinity: 0,
      minDOMgL: 5,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.limitingFactor).toBe('oxygen');
      expect(data.maxBiomassKg).toBeLessThan(1000);
    });
  });

  it('DO doygunluk degeri dogru kullanilir', () => {
    const temp = 20;
    const sal = 0;
    const expectedDOSat = calcDOSaturation(temp, sal);

    return handler({
      tankVolumeM3: 100,
      temperature: temp,
      salinity: sal,
      avgFishWeightG: 500,
      maxDensityKgM3: 20,
      hasBiofilter: false,
      dailyFeedingRatePercent: 2,
      minDOMgL: 5,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.limits.oxygen.doSaturationMgL).toBeCloseTo(expectedDOSat, 1);
    });
  });

  it('tuzlu suda DO dusuk → oksijen kisiti sikilasin', () => {
    // Ayni parametreler, tuzlu su vs tatli su
    const baseParams = {
      tankVolumeM3: 50,
      temperature: 25,
      avgFishWeightG: 300,
      maxDensityKgM3: 30,
      dailyFeedingRatePercent: 2,
      hasBiofilter: false,
      minDOMgL: 5,
    };

    return Promise.all([
      handler({ ...baseParams, salinity: 0 }),
      handler({ ...baseParams, salinity: 35 }),
    ]).then(([freshResult, saltResult]) => {
      const freshData = JSON.parse(freshResult.content[0]!.text);
      const saltData = JSON.parse(saltResult.content[0]!.text);

      // Tuzlu suda DO sat daha dusuk
      expect(saltData.limits.oxygen.doSaturationMgL)
        .toBeLessThan(freshData.limits.oxygen.doSaturationMgL);

      // Tuzlu suda oksijen limiti (varsa) daha siki
      if (saltData.limits.oxygen.maxBiomassKg !== null &&
          freshData.limits.oxygen.maxBiomassKg !== null) {
        expect(saltData.limits.oxygen.maxBiomassKg)
          .toBeLessThan(freshData.limits.oxygen.maxBiomassKg);
      }
    });
  });

  it('maxFishCount hesabi dogru', () => {
    return handler({
      tankVolumeM3: 100,
      temperature: 15,
      avgFishWeightG: 500,
      maxDensityKgM3: 20,
      salinity: 0,
      hasBiofilter: false,
      dailyFeedingRatePercent: 2,
      minDOMgL: 5,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      // maxBiomass = min(density limit, oxygen limit)
      // maxFishCount = floor(maxBiomassKg * 1000 / avgFishWeightG)
      const expectedCount = Math.floor(data.maxBiomassKg * 1000 / 500);
      expect(data.maxFishCount).toBe(expectedCount);
    });
  });

  it('biyofiltre ek O2 tuketimi ekler', () => {
    const baseParams = {
      tankVolumeM3: 50,
      temperature: 20,
      avgFishWeightG: 300,
      maxDensityKgM3: 50,
      dailyFeedingRatePercent: 2,
      salinity: 0,
      minDOMgL: 5,
    };

    return Promise.all([
      handler({ ...baseParams, hasBiofilter: false }),
      handler({ ...baseParams, hasBiofilter: true }),
    ]).then(([noBioResult, bioResult]) => {
      const noBioData = JSON.parse(noBioResult.content[0]!.text);
      const bioData = JSON.parse(bioResult.content[0]!.text);

      // Biyofiltre ile birim basina O2 tuketimi daha yuksek
      expect(bioData.limits.oxygen.o2PerKgPerDayKg)
        .toBeGreaterThan(noBioData.limits.oxygen.o2PerKgPerDayKg);
    });
  });
});
