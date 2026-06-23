import { describe, it, expect } from 'vitest';

import { calcDOSaturation, calcO2Consumption } from '../utils/formulas.js';

// ============================================================================
// Weiss (1970) DO Doygunluk Testleri
// ============================================================================
// Referans: USGS Water-Resources Investigations Report 2006-5084
//           Weiss (1970) — Deep-Sea Research 17:721-735
// ============================================================================

describe('Weiss (1970) DO Doygunluk', () => {
  // -- Tatlı su (S=0) referans değerleri --
  it('5°C, tatlı su → ~12.77 mg/L', () => {
    expect(calcDOSaturation(5, 0)).toBeCloseTo(12.77, 1);
  });

  it('10°C, tatlı su → ~11.29 mg/L', () => {
    expect(calcDOSaturation(10, 0)).toBeCloseTo(11.29, 1);
  });

  it('15°C, tatlı su → ~10.08 mg/L', () => {
    expect(calcDOSaturation(15, 0)).toBeCloseTo(10.08, 1);
  });

  it('20°C, tatlı su → ~9.09 mg/L', () => {
    expect(calcDOSaturation(20, 0)).toBeCloseTo(9.09, 1);
  });

  it('25°C, tatlı su → ~8.26 mg/L', () => {
    expect(calcDOSaturation(25, 0)).toBeCloseTo(8.26, 1);
  });

  it('30°C, tatlı su → ~7.56 mg/L', () => {
    expect(calcDOSaturation(30, 0)).toBeCloseTo(7.56, 1);
  });

  // -- Tuzlu su --
  it('20°C, 35 ppt tuzlu su → ~7.38 mg/L', () => {
    expect(calcDOSaturation(20, 35)).toBeCloseTo(7.38, 1);
  });

  it('10°C, 35 ppt tuzlu su → ~9.02 mg/L', () => {
    expect(calcDOSaturation(10, 35)).toBeCloseTo(9.02, 1);
  });

  // -- Fiziksel egilim kontrolleri --
  it('sicaklik arttikca DO duser', () => {
    expect(calcDOSaturation(10, 0)).toBeGreaterThan(calcDOSaturation(20, 0));
    expect(calcDOSaturation(20, 0)).toBeGreaterThan(calcDOSaturation(30, 0));
  });

  it('tuzluluk arttikca DO duser', () => {
    expect(calcDOSaturation(20, 0)).toBeGreaterThan(calcDOSaturation(20, 35));
  });

  // -- Uç değerler --
  it('0°C, tatlı su → ~14.6 mg/L', () => {
    expect(calcDOSaturation(0, 0)).toBeCloseTo(14.6, 0);
  });

  it('35°C, tatlı su → ~6.93 mg/L', () => {
    expect(calcDOSaturation(35, 0)).toBeCloseTo(6.93, 1);
  });

  it('varsayilan tuzluluk parametresi 0', () => {
    expect(calcDOSaturation(20)).toBe(calcDOSaturation(20, 0));
  });
});

// ============================================================================
// O2 Tuketim Hesabi Testleri
// ============================================================================
// Referans: Colt (2006), Timmons & Ebeling (2013)
// ============================================================================

describe('O2 Tuketim Hesabi (calcO2Consumption)', () => {
  it('100 kg yem, biyofiltre yok', () => {
    const result = calcO2Consumption({ dailyFeedKg: 100 });
    expect(result.fishO2).toBeCloseTo(35, 2);      // 100 * 0.35
    expect(result.organicO2).toBeCloseTo(10, 2);    // 100 * 0.10
    expect(result.biofilterO2).toBe(0);             // biyofiltre yok
    expect(result.totalO2).toBeCloseTo(45, 2);      // 35 + 0 + 10
  });

  it('100 kg yem, biyofiltre var (varsayilan TAN)', () => {
    const result = calcO2Consumption({ dailyFeedKg: 100, hasBiofilter: true });
    // TAN varsayilan = 100 * 0.01 = 1 kg
    // biofilterO2 = 1 * 4.57 = 4.57
    expect(result.fishO2).toBeCloseTo(35, 2);
    expect(result.organicO2).toBeCloseTo(10, 2);
    expect(result.biofilterO2).toBeCloseTo(4.57, 2);
    expect(result.totalO2).toBeCloseTo(49.57, 2);
  });

  it('100 kg yem, biyofiltre var, ek TAN 3 kg', () => {
    const result = calcO2Consumption({ dailyFeedKg: 100, tanKg: 3, hasBiofilter: true });
    // biofilterO2 = 3 * 4.57 = 13.71
    expect(result.biofilterO2).toBeCloseTo(13.71, 2);
    expect(result.totalO2).toBeCloseTo(35 + 13.71 + 10, 2);
  });

  it('biyofiltre false ise TAN parametresi verilse bile biofilterO2 = 0', () => {
    const result = calcO2Consumption({ dailyFeedKg: 100, tanKg: 5, hasBiofilter: false });
    expect(result.biofilterO2).toBe(0);
  });

  it('kucuk yem miktari (1 kg)', () => {
    const result = calcO2Consumption({ dailyFeedKg: 1 });
    expect(result.fishO2).toBeCloseTo(0.35, 4);
    expect(result.organicO2).toBeCloseTo(0.10, 4);
    expect(result.totalO2).toBeCloseTo(0.45, 4);
  });
});
