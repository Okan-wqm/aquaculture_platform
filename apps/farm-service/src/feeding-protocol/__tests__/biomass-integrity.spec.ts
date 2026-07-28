/**
 * W4 biyokütle bütünlüğü pinleri (FARM-HIGH-246, FARM-MEDIUM-275).
 *
 * Denetimin H-2 senaryosu: parti B, T1 (1.000 balık / 200 kg) ve T2 (9.000 /
 * 1.800 kg) tanklarına yayılmış. Operatör T1'de cull girerken kg alanına
 * kasanın toplam ağırlığını yazıyor (`quantity=500, biomassKg=900`). Tavan
 * PARTİ geneli üzerinden doğrulandığı için 900 ≤ 2.000 geçiyor; T1'in gerçek
 * 200 kg'ı hiç kontrol edilmiyor. `applyBatchDelta` `max(0, 200−900)` ile 0'a
 * clamp'liyor, ardından recalc "biomass 0 → boş ünite" diyerek planı iptal
 * ediyor ve atamayı PAUSED yapıyor. İçinde 500 CANLI balık olan tank yemleme
 * sisteminden düşüyor ve D-5 süpürmesi yalnız aktif atamalara baktığı için
 * alarm da üretmiyordu.
 *
 * Üç kapı birlikte kapatır: (1) tavan tank kapsamında doğrulanır,
 * (2) biyokütle taşması sessizce yuvarlanmaz, (3) "balık var + biyokütle 0"
 * tutarsızlık olarak işlenir, plan iptal EDİLMEZ.
 */
import { RemovalQuantityPolicyService } from '../../batch/services/removal-quantity-policy.service';

describe('RemovalQuantityPolicyService — tavan TANK kapsamında (FARM-HIGH-246)', () => {
  const policy = new RemovalQuantityPolicyService();

  it('tankın biyokütlesini aşan kg REDDEDİLİR (parti tavanı geçse bile)', () => {
    expect(() =>
      policy.resolve({
        count: 500,
        biomassKg: 900,
        // T1'in kendi toplamları — eskiden buraya PARTİ geneli veriliyordu.
        currentQuantity: 1000,
        currentBiomassKg: 200,
        currentAvgWeightG: 200,
      }),
    ).toThrow();
  });

  it('tank kapsamında geçerli kg kabul edilir', () => {
    const resolved = policy.resolve({
      count: 500,
      biomassKg: 100,
      currentQuantity: 1000,
      currentBiomassKg: 200,
      currentAvgWeightG: 200,
    });
    expect(resolved.biomassKg).toBeCloseTo(100);
    expect(resolved.count).toBe(500);
  });

  it('yalnız-tane girişinde biyokütle güncel ortalamadan türetilir (ortalama değişmez)', () => {
    const resolved = policy.resolve({
      count: 100,
      currentQuantity: 1000,
      currentBiomassKg: 200,
      currentAvgWeightG: 200,
    });
    // 100 × 200 g = 20 kg
    expect(resolved.biomassKg).toBeCloseTo(20);
  });
});
