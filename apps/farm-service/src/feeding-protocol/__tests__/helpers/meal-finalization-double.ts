/**
 * Öğün kapatma bağımlılığının test kurulumu (FARM-MEDIUM-276).
 *
 * ## Burada MOCK YOK — ve olmamalı
 *
 * `MealFinalizationService` "öğünü kapat" davranışının TEK gövdesidir: varyans
 * formülü, per_meal büyüme, kalan-öğün recalc'ı, az-atım eşiği ve plan durumu.
 * 05:30 süpürme spec'leri tam olarak BUNLARI doğruluyor (`applyGrowth` argümanı,
 * `save` sırası, `MealUnderfed` yayımı). Buraya `stub<MealFinalizationService>({})`
 * konsaydı o assertion'lar sessizce hiçbir şey doğrulamayan hâle gelirdi: süpürme
 * çağrısı boş bir stub'a giderdi, testler yeşil kalırdı ve bulgunun kendisi —
 * "iki yol aynı davranmıyor" — testlerden GİZLENMİŞ olurdu.
 *
 * Bu yüzden gerçek servis, spec'in zaten elinde tuttuğu sahte iş birlikçileriyle
 * kurulur: davranış gerçek, bağımlılıklar sahte. Aynı gövdeden geçtiğini kanıtlar.
 *
 * Metrik yüzeyi sahte: sayaç Prometheus registry'sine yazar, spec'in doğruladığı
 * şey değildir; `recordMealGrowthUnattributed` çağrısını gözlemlemek isteyen spec
 * kendi jest.fn'ini geçirebilir.
 */
import { OutboxPublisher } from '@platform/outbox';

import { MealFinalizationService } from '../../services/meal-finalization.service';
import { BiomassGrowthApplierService } from '../../services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../services/day-plan-recalc.service';
import { FarmDomainMetricsService } from '../../../common/metrics/farm-domain-metrics.service';

export interface FinalizationDeps {
  growthApplier: BiomassGrowthApplierService;
  recalcService: DayPlanRecalcService;
  outboxPublisher: OutboxPublisher;
  /** Yalnız metrik çağrısını gözlemleyen spec'ler geçirir. */
  metrics?: Pick<FarmDomainMetricsService, 'recordMealGrowthUnattributed'>;
}

/** GERÇEK finalize servisi — sahte iş birlikçilerle. Stub ile değiştirmeyin. */
export function realFinalizationService(deps: FinalizationDeps): MealFinalizationService {
  const metrics = (deps.metrics ?? {
    recordMealGrowthUnattributed: () => undefined,
  }) as FarmDomainMetricsService;
  return new MealFinalizationService(
    deps.growthApplier,
    deps.recalcService,
    deps.outboxPublisher,
    metrics,
  );
}
