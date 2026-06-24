// ============================================================================
// MCP Farm Intelligence — Anomali Tespit Aracı
// ============================================================================
//
// Çekirdek anomali tespit aracı — GraphQL ile veri çeker, analytics motoru
// ile analiz yapar, sonuçları formatlar.
//
// NASIL ÇALIŞIR:
//   1. Scope'a göre ilgili entity'leri belirle (farm → tüm site'lar,
//      site → o site'ın tankları, tank → tek tank, batch → tek batch)
//   2. GraphQL ile tüm ilgili verileri paralel çek:
//      mortalite, WQ, büyüme, yemleme, tanklar, bakım
//   3. Species thresholds'ı al (batch'in species bilgisi veya default)
//   4. detectAnomalies() analytics motorunu çağır
//   5. includeViciousCycles ise detectViciousCycles() çağır
//   6. buildReliabilityReport() ile güvenilirlik raporu oluştur
//   7. severityThreshold'a göre filtrele
//   8. Sonuçları formatla ve döndür
//
// MİMARİ AYRIM:
//   Bu araç "veri çekme + orkestrasyon" katmanıdır.
//   Anomali tespiti mantığı analytics/anomaly-detector.ts'dedir.
//   Kötü döngü tespiti analytics/cycle-detector.ts'dedir.
//   Güvenilirlik analytics/reliability.ts'dedir.
//
//   Bu ayrım sayesinde:
//     - Analytics modülleri bağımsız test edilebilir
//     - Farklı veri kaynakları (ör: WebSocket, dosya) kullanılabilir
//     - Tool katmanı sadece MCP protokolü ile ilgilenir
//
// EXTENSIBLE:
//   - Yeni scope'lar (ör: department, region) eklenebilir
//   - Ek analytics modülleri (ör: trend predictor) çağrılabilir
//   - Veri çekme katmanı cache'lenebilir
//   - Threshold'lar kullanıcı tarafından override edilebilir
// ============================================================================

import { z } from 'zod';
import type { GraphQLClient } from '../../graphql/client.js';

// ── GraphQL Sorgu İmportları ────────────────────────────────────────────────
import { fetchActiveSites } from '../../graphql/queries/sites.js';
import { fetchTanks, fetchTank } from '../../graphql/queries/tanks.js';
import { fetchActiveBatches, fetchBatch } from '../../graphql/queries/batches.js';
import { fetchFeedingRecords } from '../../graphql/queries/feeding.js';
import { fetchGrowthMeasurements } from '../../graphql/queries/growth.js';
import { fetchHealthEvents } from '../../graphql/queries/health.js';
import { fetchWaterQuality } from '../../graphql/queries/water-quality.js';
import { fetchOverdueWorkOrders } from '../../graphql/queries/maintenance.js';

// ── Analytics Modül İmportları ──────────────────────────────────────────────
import { detectAnomalies } from '../../analytics/anomaly-detector.js';
import type { AnomalyInput, Anomaly } from '../../analytics/anomaly-detector.js';
import { detectViciousCycles } from '../../analytics/cycle-detector.js';
import type { DetectedCycle } from '../../analytics/cycle-detector.js';
import { buildReliabilityReport } from '../../analytics/reliability.js';
import type { DataSource, ReliabilityReport } from '../../analytics/reliability.js';

// ── Tip Tanımları ───────────────────────────────────────────────────────────

/** MCP tool sonuç tipi */
type ToolResult = { content: Array<{ type: 'text'; text: string }> };

/** Severity seviyeleri — filtreleme için sıralama */
const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================
//
// scope: Analiz kapsamı (farm, site, tank, batch)
//   - farm: Tüm çiftlik genelinde anomali taraması
//   - site: Belirli bir tesisin tankları ve batch'leri
//   - tank: Tek bir tankın WQ, yoğunluk, bakım anomalileri
//   - batch: Tek bir batch'in mortalite, büyüme, FCR anomalileri
//
// entityId: scope = farm hariç zorunlu
// timeWindowDays: Veri penceresi (varsayılan: 7 gün)
// severityThreshold: Minimum raporlama seviyesi (varsayılan: low)
// includeViciousCycles: Kötü döngü analizi dahil edilsin mi? (varsayılan: true)
// ============================================================================

export const inputSchema = z.object({
  scope: z.enum(['tank', 'batch', 'site', 'farm'])
    .describe('Analiz kapsamı: tank, batch, site veya farm'),

  entityId: z.string().optional()
    .describe('Varlık UUID — scope=farm hariç zorunlu'),

  timeWindowDays: z.number().int().positive().default(7)
    .describe('Veri penceresi gün sayısı (varsayılan: 7)'),

  severityThreshold: z.enum(['low', 'medium', 'high']).default('low')
    .describe('Minimum raporlama seviyesi (varsayılan: low)'),

  includeViciousCycles: z.boolean().default(true)
    .describe('Kötü döngü analizi dahil edilsin mi? (varsayılan: true)'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'detect_anomalies',
  description:
    'Çiftlik verilerinde anomali taraması yapar. 9 anomali türünü tespit eder: ' +
    'mortalite sivrilemesi, su kalitesi sapması, büyüme yavaşlaması, FCR bozulması, ' +
    'yemleme varyansı, yoğunluk aşımı, iştah kaybı, biofiltre stresi, geciken bakım. ' +
    'Opsiyonel olarak kötü döngü (vicious cycle) analizi de yapar.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: {
        type: 'string',
        enum: ['tank', 'batch', 'site', 'farm'],
        description: 'Analiz kapsamı',
      },
      entityId: {
        type: 'string',
        description: 'Varlık UUID — scope=farm hariç zorunlu',
      },
      timeWindowDays: {
        type: 'integer',
        description: 'Veri penceresi gün sayısı (varsayılan: 7)',
        default: 7,
      },
      severityThreshold: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Minimum raporlama seviyesi',
        default: 'low',
      },
      includeViciousCycles: {
        type: 'boolean',
        description: 'Kötü döngü analizi',
        default: true,
      },
    },
    required: ['scope'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ============================================================================
// ARAÇ İŞLEYİCİSİ (Handler)
// ============================================================================

export async function handler(
  params: unknown,
  client: GraphQLClient,
): Promise<ToolResult> {
  const input = inputSchema.parse(params);

  // ── Parametre Doğrulama ────────────────────────────────────────────
  if (input.scope !== 'farm' && !input.entityId) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'entityId parametresi scope=farm dışında zorunludur.',
        }),
      }],
    };
  }

  // ── Tarih Aralığı ─────────────────────────────────────────────────
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (input.timeWindowDays ?? 7));
  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  // ── Adım 1: Scope'a Göre Verileri Çek ─────────────────────────────
  //
  // Farm scope → tüm veriler çekilir (geniş tarama)
  // Site scope → site'a ait tanklar ve batch'ler
  // Tank scope → tek tankın verileri
  // Batch scope → tek batch'in verileri
  //
  // NASIL ÇALIŞIR:
  //   buildAnomalyInput fonksiyonu scope'a göre uygun GraphQL
  //   sorgularını çalıştırır ve AnomalyInput yapısını doldurur.
  // ──────────────────────────────────────────────────────────────────

  const { anomalyInput, dataSources, usedDomains } = await buildAnomalyInput(
    client, input.scope, input.entityId, fromISO, toISO,
  );

  // ── Adım 2: Anomali Tespiti ────────────────────────────────────────
  //
  // detectAnomalies() çekirdek motoru çalıştırılır.
  // Motor, 9 farklı anomali türünü kontrol eder ve
  // severity'ye göre sıralanmış Anomaly[] döndürür.
  // ──────────────────────────────────────────────────────────────────

  const allAnomalies = detectAnomalies(anomalyInput);

  // ── Adım 3: Severity Filtreleme ────────────────────────────────────
  //
  // Kullanıcının istediği minimum severity seviyesine göre filtreleme.
  // severityThreshold = 'medium' ise 'low' anomaliler gösterilmez.
  // ──────────────────────────────────────────────────────────────────

  const thresholdLevel = SEVERITY_ORDER[input.severityThreshold ?? 'low'] ?? 3;
  const filteredAnomalies = allAnomalies.filter(a =>
    (SEVERITY_ORDER[a.severity] ?? 4) <= thresholdLevel,
  );

  // ── Adım 4: Kötü Döngü Tespiti (Opsiyonel) ───────────────────────
  //
  // includeViciousCycles = true ise mevcut anomaliler bilinen
  // kötü döngü kalıplarıyla eşleştirilir.
  //
  // NASIL ÇALIŞIR:
  //   detectViciousCycles(), anomali listesini alır ve her anomaliyi
  //   bilinen döngü koşullarına dönüştürür. Yeterli koşul eşleşmesi
  //   olduğunda döngü tespit edilmiş sayılır.
  // ──────────────────────────────────────────────────────────────────

  let viciousCycles: DetectedCycle[] = [];
  if (input.includeViciousCycles) {
    viciousCycles = detectViciousCycles(allAnomalies);
  }

  // ── Adım 5: Güvenilirlik Raporu ────────────────────────────────────
  //
  // Sonuçların ne kadar güvenilir olduğunu raporlar.
  // Veri tamamlılığı, tazeliği, örneklem büyüklüğü ve
  // kaynak çeşitliliği değerlendirilir.
  // ──────────────────────────────────────────────────────────────────

  const allDomains = [
    'water_quality', 'feeding', 'growth', 'mortality',
    'density', 'health', 'maintenance',
  ];
  const reliability = buildReliabilityReport(dataSources, usedDomains, allDomains);

  // ── Adım 5b: Anomali Sayısını Sınırla ──────────────────────────────
  //
  // En kritik anomaliler önce, sonra maksimum limitle sınırla.
  // ──────────────────────────────────────────────────────────────────

  const MAX_ANOMALIES = 20;
  const limitedAnomalies = filteredAnomalies
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4))
    .slice(0, MAX_ANOMALIES);

  // ── Adım 6: Özet İstatistikler ────────────────────────────────────
  //
  // Hızlı bakış için anomali ve döngü sayıları.
  // ──────────────────────────────────────────────────────────────────

  const summary = {
    totalAnomalies: filteredAnomalies.length,
    bySeverity: {
      critical: filteredAnomalies.filter(a => a.severity === 'critical').length,
      high: filteredAnomalies.filter(a => a.severity === 'high').length,
      medium: filteredAnomalies.filter(a => a.severity === 'medium').length,
      low: filteredAnomalies.filter(a => a.severity === 'low').length,
    },
    viciousCycleCount: viciousCycles.length,
    timeWindowDays: input.timeWindowDays ?? 7,
    scope: input.scope,
    entityId: input.entityId ?? 'farm-wide',
  };

  // ── Adım 7: Insight Cümlesi Üret ─────────────────────────────────

  const insight = generateAnomalyInsight(filteredAnomalies, viciousCycles);

  // ── Adım 8: Sonucu Formatla ───────────────────────────────────────

  const result = {
    anomalies: limitedAnomalies,
    viciousCycles,
    summary,
    insight,
    reliability,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

// ============================================================================
// VERİ ÇEKME VE HAZIRLAMA
// ============================================================================
//
// buildAnomalyInput fonksiyonu, scope'a göre uygun GraphQL sorgularını
// çalıştırır ve AnomalyInput + DataSource dizilerini hazırlar.
//
// NASIL ÇALIŞIR:
//   1. Scope'a göre hangi verilerin çekileceği belirlenir
//   2. Sorgular Promise.allSettled ile paralel çalıştırılır
//   3. Başarılı sonuçlar AnomalyInput yapısına aktarılır
//   4. Her veri kaynağı için DataSource nesnesi oluşturulur
//   5. Kullanılan domain'ler listelenir
//
// EXTENSIBLE:
//   - Yeni scope'lar için case eklenir
//   - Yeni veri kaynakları paralel sorgulara eklenir
// ============================================================================

async function buildAnomalyInput(
  client: GraphQLClient,
  scope: string,
  entityId: string | undefined,
  from: string,
  to: string,
): Promise<{
  anomalyInput: AnomalyInput;
  dataSources: DataSource[];
  usedDomains: string[];
}> {
  const dataSources: DataSource[] = [];
  const usedDomains: string[] = [];
  const anomalyInput: AnomalyInput = {};
  const now = new Date().toISOString();

  // ── Tüm verileri paralel çek ──────────────────────────────────────
  //
  // 7 sorgu eşzamanlı çalışır. Scope'a göre filtreler uygulanır.
  // Promise.allSettled ile kısmi hatalar tolere edilir.
  // ──────────────────────────────────────────────────────────────────

  // Tank filtresi — scope'a göre
  const tankFilter = scope === 'tank' && entityId
    ? { isActive: true }  // tek tank ayrı çekilecek
    : { isActive: true };

  // Feeding filtresi
  const feedingFilter: { batchId?: string; tankId?: string; startDate?: string; endDate?: string } = {
    startDate: from,
    endDate: to,
  };
  if (scope === 'batch' && entityId) feedingFilter.batchId = entityId;
  if (scope === 'tank' && entityId) feedingFilter.tankId = entityId;

  // WQ filtresi
  const wqFilter: { tankId?: string; startDate?: string; endDate?: string } = {
    startDate: from,
    endDate: to,
  };
  if (scope === 'tank' && entityId) wqFilter.tankId = entityId;

  // Growth filtresi
  const growthFilter: { batchId?: string; startDate?: string; endDate?: string } = {
    startDate: from,
    endDate: to,
  };
  if (scope === 'batch' && entityId) growthFilter.batchId = entityId;

  // Health filtresi
  const healthFilter: { batchId?: string; tankId?: string; startDate?: string; endDate?: string } = {
    startDate: from,
    endDate: to,
  };
  if (scope === 'batch' && entityId) healthFilter.batchId = entityId;
  if (scope === 'tank' && entityId) healthFilter.tankId = entityId;

  const [
    tanksResult,
    feedingResult,
    wqResult,
    growthResult,
    healthResult,
    overdueResult,
  ] = await Promise.allSettled([
    // 1. Tanklar
    scope === 'tank' && entityId
      ? fetchTank(client, entityId).then(t => ({ items: [t], total: 1 }))
      : fetchTanks(client, tankFilter),

    // 2. Yemleme kayıtları
    fetchFeedingRecords(client, feedingFilter),

    // 3. Su kalitesi
    fetchWaterQuality(client, wqFilter),

    // 4. Büyüme
    fetchGrowthMeasurements(client, growthFilter),

    // 5. Sağlık olayları
    fetchHealthEvents(client, healthFilter),

    // 6. Gecikmiş bakımlar
    fetchOverdueWorkOrders(client),
  ]);

  // ── Tankları İşle ──────────────────────────────────────────────────
  if (tanksResult.status === 'fulfilled') {
    const tanks = tanksResult.value.items ?? [];
    anomalyInput.tanks = tanks.map(t => ({
      id: t.id,
      name: t.name,
      currentBiomass: t.currentBiomass,
      maxBiomass: t.maxBiomass,
      volume: t.effectiveVolume || t.volume,
      maxDensity: t.maxDensity,
    }));
    usedDomains.push('density');
    dataSources.push({
      domain: 'density',
      dataPointCount: tanks.length,
      expectedPointCount: Math.max(1, tanks.length),
      lastDataTimestamp: now,
      maxStaleHours: 24,
      minReliableN: 1,
    });
  }

  // ── Yemleme Kayıtlarını İşle ──────────────────────────────────────
  if (feedingResult.status === 'fulfilled') {
    const items = feedingResult.value.items ?? [];
    anomalyInput.feedingRecords = items.map(f => ({
      date: f.feedingDate,
      batchId: f.batchId,
      tankId: f.tankId,
      planned: f.plannedAmount,
      actual: f.actualAmount,
    }));
    usedDomains.push('feeding');
    dataSources.push({
      domain: 'feeding',
      dataPointCount: items.length,
      expectedPointCount: Math.max(7, (input_timeWindowDays(from, to)) * 3),
      lastDataTimestamp: items.length > 0 ? items[0]!.feedingDate : null,
      maxStaleHours: 24,
      minReliableN: 10,
    });
  }

  // ── Su Kalitesini İşle ─────────────────────────────────────────────
  if (wqResult.status === 'fulfilled') {
    const items = wqResult.value.items ?? [];
    anomalyInput.waterQualityMeasurements = items.map(m => ({
      measuredAt: m.measuredAt,
      tankId: m.tankId ?? '',
      temperature: m.parameters?.temperature,
      ph: m.parameters?.pH,
      dissolvedOxygen: m.parameters?.dissolvedOxygen,
      ammonia: m.parameters?.ammonia,
      nitrite: m.parameters?.nitrite,
      nitrate: m.parameters?.nitrate,
    }));
    usedDomains.push('water_quality');
    dataSources.push({
      domain: 'water_quality',
      dataPointCount: items.length,
      expectedPointCount: Math.max(7, (input_timeWindowDays(from, to)) * 4),
      lastDataTimestamp: items.length > 0 ? items[0]!.measuredAt : null,
      maxStaleHours: 6,
      minReliableN: 10,
    });
  }

  // ── Büyüme Verilerini İşle ────────────────────────────────────────
  if (growthResult.status === 'fulfilled') {
    const items = growthResult.value.items ?? [];
    anomalyInput.growthMeasurements = items.map(g => ({
      date: g.measurementDate,
      batchId: g.batchId,
      avgWeight: g.averageWeight,
      sgr: g.specificGrowthRate ?? undefined,
    }));
    usedDomains.push('growth');
    dataSources.push({
      domain: 'growth',
      dataPointCount: items.length,
      expectedPointCount: Math.max(2, Math.ceil(input_timeWindowDays(from, to) / 7)),
      lastDataTimestamp: items.length > 0 ? items[0]!.measurementDate : null,
      maxStaleHours: 168, // Büyüme ölçümü haftalık yapılabilir
      minReliableN: 3,
    });
  }

  // ── Sağlık Olaylarını İşle ────────────────────────────────────────
  if (healthResult.status === 'fulfilled') {
    // Sağlık olayları AnomalyInput'ta doğrudan kullanılmaz
    // ama mortalite kayıtlarının tetikleyicileri olarak ilişkilendirilir
    usedDomains.push('health');
    const items = healthResult.value.items ?? [];
    dataSources.push({
      domain: 'health',
      dataPointCount: items.length,
      expectedPointCount: 1, // Sağlık olayı olmayabilir — 0 da normaldir
      lastDataTimestamp: items.length > 0 ? items[0]!.createdAt : null,
      maxStaleHours: 24,
      minReliableN: 1,
    });
  }

  // ── Gecikmiş Bakımları İşle ────────────────────────────────────────
  if (overdueResult.status === 'fulfilled') {
    const items = overdueResult.value ?? [];
    anomalyInput.maintenanceSchedules = items.map(wo => ({
      id: wo.id,
      dueDate: wo.dueDate ?? wo.createdAt,
      status: wo.status,
      title: wo.title,
    }));
    usedDomains.push('maintenance');
    dataSources.push({
      domain: 'maintenance',
      dataPointCount: items.length,
      expectedPointCount: 1,
      lastDataTimestamp: items.length > 0 ? items[0]!.createdAt : null,
      maxStaleHours: 48,
      minReliableN: 1,
    });
  }

  return { anomalyInput, dataSources, usedDomains };
}

// ============================================================================
// YARDIMCI FONKSİYONLAR
// ============================================================================

/**
 * İki tarih arasındaki gün sayısını hesaplar.
 *
 * DataSource.expectedPointCount hesaplamasında kullanılır.
 * Her domain farklı frekansta veri üretir:
 *   - WQ: günde ~4 ölçüm
 *   - Feeding: günde ~3 kayıt
 *   - Growth: haftada ~1 ölçüm
 *
 * @param from - Başlangıç tarihi (ISO string)
 * @param to - Bitiş tarihi (ISO string)
 * @returns Gün sayısı (minimum 1)
 */
function input_timeWindowDays(from: string, to: string): number {
  const diffMs = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Anomali sonuçlarından Türkçe insight cümlesi üretir.
 *
 * LLM bu cümleyi doğrudan kullanıcıya aktarabilir; detay gerekirse
 * anomalies dizisi hâlâ mevcuttur.
 */
function generateAnomalyInsight(anomalies: Anomaly[], cycles: DetectedCycle[]): string {
  const criticalCount = anomalies.filter(a => a.severity === 'critical').length;
  const highCount = anomalies.filter(a => a.severity === 'high').length;

  const parts: string[] = [];
  parts.push(`${anomalies.length} anomali tespit edildi: ${criticalCount} kritik, ${highCount} yüksek`);

  // En kritik anomalinin özeti
  const critical = anomalies.find(a => a.severity === 'critical');
  if (critical) {
    parts.push(`En kritik: ${critical.entity.name} — ${critical.type} (${critical.metric}: ${critical.currentValue}, beklenen: ${critical.expectedValue})`);
  }

  if (cycles.length > 0) {
    parts.push(`${cycles.length} kötü döngü aktif — acil müdahale gerekebilir`);
  }

  return parts.join('. ') + '.';
}
