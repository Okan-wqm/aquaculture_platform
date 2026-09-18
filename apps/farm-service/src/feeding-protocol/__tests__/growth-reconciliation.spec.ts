/**
 * W1 büyüme muhasebesi SSoT pinleri (FARM-CRITICAL-244, FARM-MEDIUM-288).
 *
 * Denetimin C-1 bulgusu: DAILY rollup damgası "tek atımlık"tı ve mod kararı
 * protokolün O ANKİ ayarından okunuyordu. Üç canlı senaryo üretiyordu:
 *   (a) rollup sonrası düzeltme → büyüme kalıcı kayıp,
 *   (b) geç finalize → büyüme kalıcı kayıp,
 *   (c) mod dropdown'u → 24 aya kadar planın ÇİFT sayımı / tam gün kaybı.
 * Kümülatif mutabakat (`rollupAppliedKg`) üçünü de yapısal olarak kapatır.
 */
import { ConflictException } from '@nestjs/common';

import { computeRollupDelta } from '../services/feeding-cron-v2.service';
import { withUnitLockRetry, isUnitMembershipConflict } from '../services/unit-lock-retry.util';

describe('computeRollupDelta — kümülatif rollup mutabakatı (FARM-CRITICAL-244)', () => {
  it('ilk rollup: gün toplamının tamamı büyümeye çevrilir', () => {
    expect(computeRollupDelta({ totalActualKg: 50, appliedKg: 0, expectedFcr: 1.25 })).toEqual({
      deltaKg: 50,
      growthKg: 40,
      applicable: true,
    });
  });

  it('değişmemiş plan: delta 0 — aynı büyüme İKİNCİ kez uygulanmaz', () => {
    expect(computeRollupDelta({ totalActualKg: 50, appliedKg: 50, expectedFcr: 1.25 })).toEqual({
      deltaKg: 0,
      growthKg: 0,
      applicable: true,
    });
  });

  it('geç finalize: rollup sonrası eklenen kg bir sonraki koşuda YALNIZ fark kadar uygulanır', () => {
    // Eski davranış: plan bir daha seçilmiyordu → 10 kg'ın büyümesi kayıptı.
    expect(computeRollupDelta({ totalActualKg: 60, appliedKg: 50, expectedFcr: 1.25 })).toEqual({
      deltaKg: 10,
      growthKg: 8,
      applicable: true,
    });
  });

  it('aşağı düzeltme: negatif delta büyümeyi geri alır (tek yönlü damga bunu yapamazdı)', () => {
    expect(computeRollupDelta({ totalActualKg: 40, appliedKg: 50, expectedFcr: 1.25 })).toEqual({
      deltaKg: -10,
      growthKg: -8,
      applicable: true,
    });
  });

  it('FCR çözülemezse uygulanabilir DEĞİL — damga basılmaz, plan aday kalır', () => {
    const result = computeRollupDelta({ totalActualKg: 50, appliedKg: 0, expectedFcr: 0 });
    expect(result.applicable).toBe(false);
    expect(result.growthKg).toBe(0);
  });

  it('mod değişimi senaryosu: per_meal döneminde uygulanmış kg damgalıysa daily geçişi çift saymaz', () => {
    // per_meal modda büyüme öğün başına uygulanmış ve `rollupAppliedKg` ile
    // eşitlenmişse, protokol daily'ye çevrilse bile delta 0'dır.
    const alreadyApplied = 120;
    expect(
      computeRollupDelta({
        totalActualKg: alreadyApplied,
        appliedKg: alreadyApplied,
        expectedFcr: 1.1,
      }).growthKg,
    ).toBe(0);
  });
});

describe('withUnitLockRetry — ünite üyeliği yarışı (FARM-MEDIUM-288)', () => {
  const membershipError = new ConflictException(
    'Unit u-1 batch membership changed during lock acquisition (missing: b-2). Retry.',
  );

  it('üyelik çakışmasını tanır, başka 409ları tanımaz', () => {
    expect(isUnitMembershipConflict(membershipError)).toBe(true);
    expect(isUnitMembershipConflict(new ConflictException('Ünitede stok kaydı yok'))).toBe(false);
    expect(isUnitMembershipConflict(new Error('boom'))).toBe(false);
  });

  it('yarış geçiciyse sonraki denemede başarıya döner (operatöre 409 yansımaz)', async () => {
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(membershipError)
      .mockResolvedValueOnce('ok');
    await expect(withUnitLockRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('deneme hakkı biterse hata yükselir — kalıcı tutarsızlık gizlenmez', async () => {
    const fn = jest.fn<Promise<string>, []>().mockRejectedValue(membershipError);
    await expect(withUnitLockRetry(fn, 3)).rejects.toBe(membershipError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('ilgisiz hatayı ASLA yeniden denemez (yan etki riski)', async () => {
    const other = new Error('storage down');
    const fn = jest.fn<Promise<string>, []>().mockRejectedValue(other);
    await expect(withUnitLockRetry(fn)).rejects.toBe(other);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
