/**
 * RemovalQuantityPolicyService (Faz 5 — D-3 kullanıcı gereksinimi).
 *
 * Pinler: tane modu ortalamayı DEĞİŞTİRMEZ ve kg'yi türetir; tane+kg modu
 * ikisini aynen uygular ve KALAN ortalamayı kaydırır (büyük balık hasadı →
 * kalan ortalama düşer); yalnız-kg modu taneyi türetir ve `countDerived`
 * bayrağını taşır (sessiz varsayım yok); mevcut sayı/biyokütle aşımı ve
 * ortalamasız yalnız-kg girişi fail-closed reddedilir.
 */
import { BadRequestException } from '@nestjs/common';

import { RemovalQuantityPolicyService } from '../../services/removal-quantity-policy.service';

const service = new RemovalQuantityPolicyService();

const CURRENT = { currentQuantity: 1000, currentBiomassKg: 100, currentAvgWeightG: 100 };

describe('RemovalQuantityPolicyService.resolve', () => {
  it('mode (a) count-only: derives kg from the CURRENT average and leaves the average unchanged', () => {
    const resolved = service.resolve({ count: 50, ...CURRENT });
    expect(resolved).toEqual({
      count: 50,
      biomassKg: 5, // 50 × 100g
      countDerived: false,
      remainingAvgWeightG: null, // ortalama değişmez
    });
  });

  it('mode (b) count+kg: applies both verbatim and shifts the REMAINING average', () => {
    // 100 büyük balık 15kg (ortalama 150g) hasat edildi → kalan ortalaması düşer.
    const resolved = service.resolve({ count: 100, biomassKg: 15, ...CURRENT });
    expect(resolved.count).toBe(100);
    expect(resolved.biomassKg).toBe(15);
    expect(resolved.countDerived).toBe(false);
    // kalan: 900 adet / 85kg → 94.444g
    expect(resolved.remainingAvgWeightG).toBeCloseTo(94.444, 3);
  });

  it('mode (c) kg-only: derives the count from the current average and FLAGS the derivation', () => {
    const resolved = service.resolve({ biomassKg: 5, ...CURRENT });
    expect(resolved).toEqual({
      count: 50, // 5kg / 100g
      biomassKg: 5,
      countDerived: true,
      remainingAvgWeightG: null,
    });
  });

  it('rejects kg-only removal when the unit average weight is unknown', () => {
    expect(() => service.resolve({ biomassKg: 5, ...CURRENT, currentAvgWeightG: 0 })).toThrow(
      BadRequestException,
    );
  });

  it('rejects over-removal in every mode (fail-closed upper bounds)', () => {
    expect(() => service.resolve({ count: 1001, ...CURRENT })).toThrow(BadRequestException);
    expect(() => service.resolve({ biomassKg: 101, ...CURRENT })).toThrow(BadRequestException);
    expect(() => service.resolve({ count: 10, biomassKg: 101, ...CURRENT })).toThrow(
      BadRequestException,
    );
  });

  it('rejects empty and non-positive inputs', () => {
    expect(() => service.resolve({ ...CURRENT })).toThrow(BadRequestException);
    expect(() => service.resolve({ count: 0, ...CURRENT })).toThrow(BadRequestException);
    expect(() => service.resolve({ biomassKg: -1, ...CURRENT })).toThrow(BadRequestException);
  });

  it('caps a kg-only derived count at the current quantity (rounding cannot overshoot)', () => {
    const resolved = service.resolve({
      biomassKg: 99.99,
      currentQuantity: 999,
      currentBiomassKg: 100,
      currentAvgWeightG: 100,
    });
    expect(resolved.count).toBe(999);
    expect(resolved.countDerived).toBe(true);
  });
});
