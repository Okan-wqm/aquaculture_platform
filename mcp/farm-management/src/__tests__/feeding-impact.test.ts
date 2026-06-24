import { describe, it, expect } from 'vitest';

import { handler } from '../tools/math/predict-feeding-impact.js';

// ============================================================================
// TAN Uretimi Testleri
// ============================================================================
// Referans: Timmons & Ebeling (2013) — ~30g TAN per kg feed
// FORMUL: TAN_kg = feedKg * TAN_coefficient
// ============================================================================

describe('TAN Uretimi', () => {
  it('100 kg yem, default katsayi 0.030 → 3 kg TAN', () => {
    return handler({
      feedKg: 100,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 20,
      currentPH: 7.5,
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.tanProduction.tanCoefficientUsed).toBe(0.030);
      expect(data.tanProduction.tanProducedKg).toBeCloseTo(3.0, 2);
    });
  });

  it('salmon katsayisi 0.028 → 2.8 kg TAN', () => {
    return handler({
      feedKg: 100,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 15,
      currentPH: 7.0,
      speciesCode: 'salmon',
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.tanProduction.tanCoefficientUsed).toBe(0.028);
      expect(data.tanProduction.tanProducedKg).toBeCloseTo(2.8, 2);
    });
  });

  it('tilapia katsayisi 0.032 → 3.2 kg TAN', () => {
    return handler({
      feedKg: 100,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 28,
      currentPH: 7.5,
      speciesCode: 'tilapia',
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.tanProduction.tanCoefficientUsed).toBe(0.032);
      expect(data.tanProduction.tanProducedKg).toBeCloseTo(3.2, 2);
    });
  });

  it('TAN konsantrasyon artisi hesabi', () => {
    // 100 kg yem, default katsayi → 3 kg TAN
    // Tank 200 m3 = 200000 L
    // TAN artisi = 3 * 1_000_000 / 200_000 = 15 mg/L
    return handler({
      feedKg: 100,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 20,
      currentPH: 7.5,
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.tanProduction.tanIncreaseMgL).toBeCloseTo(15, 1);
    });
  });

  it('mevcut TAN uzerine eklenir', () => {
    return handler({
      feedKg: 100,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 20,
      currentPH: 7.5,
      currentTANmgL: 2.0,
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      // peakTAN = 2.0 + 15.0 = 17.0
      expect(data.tanProduction.peakTANmgL).toBeCloseTo(17.0, 1);
    });
  });
});

// ============================================================================
// Yemleme Orani Testleri
// ============================================================================
// FORMUL: oran = (feedKg / biomassKg) * 100
// ============================================================================

describe('Yemleme Orani', () => {
  it('%2 BW → normal', () => {
    return handler({
      feedKg: 100,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 20,
      currentPH: 7.5,
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.feedingRate.ratePercent).toBeCloseTo(2.0, 2);
      expect(data.feedingRate.status).toBe('normal');
    });
  });

  it('%5 BW → overfeeding', () => {
    return handler({
      feedKg: 250,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 20,
      currentPH: 7.5,
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.feedingRate.ratePercent).toBeCloseTo(5.0, 2);
      expect(data.feedingRate.status).toBe('high');
    });
  });

  it('%6 BW → overfeeding (asiri)', () => {
    return handler({
      feedKg: 300,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 20,
      currentPH: 7.5,
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.feedingRate.ratePercent).toBeCloseTo(6.0, 2);
      expect(data.feedingRate.status).toBe('overfeeding');
    });
  });

  it('%0.2 BW → low', () => {
    return handler({
      feedKg: 10,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 20,
      currentPH: 7.5,
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.feedingRate.ratePercent).toBeCloseTo(0.2, 2);
      expect(data.feedingRate.status).toBe('low');
    });
  });
});

// ============================================================================
// Oksijen Talebi Testleri
// ============================================================================
// Referans: Colt (2006), Timmons & Ebeling (2013)
// ============================================================================

describe('Oksijen Talebi', () => {
  it('biyofiltre olmadan 3 kaynak hesaplari', () => {
    return handler({
      feedKg: 100,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 20,
      currentPH: 7.5,
      salinity: 0,
      hasBiofilter: false,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      expect(data.oxygenDemand.fishRespirationKgO2).toBeCloseTo(35, 1);  // 100*0.35
      expect(data.oxygenDemand.organicDecompositionKgO2).toBeCloseTo(10, 1); // 100*0.10
      expect(data.oxygenDemand.biofilterNitrificationKgO2).toBeCloseTo(0, 1);
      expect(data.oxygenDemand.totalO2DemandKg).toBeCloseTo(45, 1);
    });
  });

  it('biyofiltre ile nitrifikasyon O2 eklenir', () => {
    return handler({
      feedKg: 100,
      biomassKg: 5000,
      tankVolumeM3: 200,
      temperature: 20,
      currentPH: 7.5,
      hasBiofilter: true,
      salinity: 0,
    }).then(result => {
      const data = JSON.parse(result.content[0]!.text);
      // TAN = 100 * 0.030 = 3 kg, biofilter O2 = 3 * 4.57 = 13.71
      expect(data.oxygenDemand.biofilterNitrificationKgO2).toBeCloseTo(13.71, 1);
      expect(data.oxygenDemand.totalO2DemandKg).toBeCloseTo(35 + 13.71 + 10, 1);
    });
  });
});
