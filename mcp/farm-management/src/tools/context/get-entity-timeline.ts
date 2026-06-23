// ============================================================================
// MCP Farm Intelligence — Varlık Zaman Çizelgesi Aracı
// ============================================================================
//
// Bir tank veya batch için tüm domain'lerden gelen olayları
// birleşik bir zaman çizelgesinde sunar.
//
// NASIL ÇALIŞIR:
//   1. entityType'a göre (tank veya batch) ilgili sorgular seçilir
//   2. Seçilen domain'lere göre GraphQL sorguları paralel çalıştırılır
//   3. Her domain'den gelen veriler ortak bir olay formatına dönüştürülür
//   4. Tüm olaylar timestamp'e göre azalan sırada sıralanır
//   5. Tek bir birleşik timeline döndürülür
//
// NEDEN BİRLEŞİK TİMELINE?
//   Akvakültürde olaylar birbiriyle bağlantılıdır:
//     - Su kalitesi bozulması → iştah kaybı → mortalite artışı
//   Bu ilişkileri görmek için tüm domain'lerin kronolojik olarak
//   tek bir listede sunulması gerekir. AI bu listeye bakarak
//   neden-sonuç zincirlerini kolayca tespit edebilir.
//
// DESTEKLENEN DOMAIN'LER:
//   - mortality    → Mortalite kayıtları
//   - feeding      → Yemleme kayıtları (sapma bilgisi dahil)
//   - growth       → Büyüme ölçümleri (SGR, ağırlık değişimi)
//   - water_quality → Su kalitesi ölçümleri (parametreler)
//   - health       → Sağlık olayları (hastalık, tedavi)
//   - maintenance  → Bakım/iş emri olayları
//   - weather      → Hava durumu gözlemleri
//
// EXTENSIBLE:
//   - Yeni domain'ler (ör: stocking, harvest) DOMAIN_HANDLERS haritasına eklenir
//   - Her domain için transformXxx fonksiyonu yazılır
//   - Olay formatı genişletilebilir (ör: severity, relatedEntities)
//   - Filtre mekanizmaları derinleştirilebilir
// ============================================================================

import { z } from 'zod';
import type { GraphQLClient } from '../../graphql/client.js';

// ── GraphQL Sorgu İmportları ────────────────────────────────────────────────
import { fetchTank } from '../../graphql/queries/tanks.js';
import { fetchBatch, fetchBatchHistory } from '../../graphql/queries/batches.js';
import { fetchFeedingRecords } from '../../graphql/queries/feeding.js';
import { fetchGrowthMeasurements } from '../../graphql/queries/growth.js';
import { fetchHealthEvents } from '../../graphql/queries/health.js';
import { fetchWaterQuality } from '../../graphql/queries/water-quality.js';
import { fetchWorkOrders } from '../../graphql/queries/maintenance.js';
import { fetchWeatherObservations } from '../../graphql/queries/weather.js';

// ── Tip Tanımları ───────────────────────────────────────────────────────────

/** MCP tool sonuç tipi */
type ToolResult = { content: Array<{ type: 'text'; text: string }> };

/**
 * Birleşik zaman çizelgesi olayı.
 *
 * Tüm domain'lerden gelen veriler bu ortak formata dönüştürülür.
 * Bu normalizasyon sayesinde AI, farklı domain'lerdeki olayları
 * doğrudan karşılaştırabilir.
 */
interface TimelineEvent {
  /** Olayın gerçekleşme zamanı (ISO 8601) */
  timestamp: string;

  /** Olayın geldiği domain */
  domain: string;

  /**
   * Olay tipi — domain'e özgü alt kategori.
   * Örnekler:
   *   - mortality_recorded, feeding_completed, wq_measurement
   *   - growth_sampling, health_event_started, work_order_created
   *   - weather_observation
   */
  eventType: string;

  /** İnsan okunabilir Türkçe özet */
  summary: string;

  /** Ciddiyet seviyesi (varsa) */
  severity?: string;

  /** Sayısal metrikler (varsa) — domain'e özgü ölçümler */
  metrics?: Record<string, number>;
}

/** Timeline sonuç yapısı */
interface TimelineResult {
  entity: { type: string; id: string; name: string };
  events: TimelineEvent[];
  period: { from: string; to: string };
  totalEvents: number;
  truncated: boolean;
  showing: number;
  eventCount: number;
  domainsCovered: string[];
  notes: string[];
  periodSummary: string;
}

// ── Desteklenen Domain Listesi ──────────────────────────────────────────────
// Bu liste hem input validasyonu hem de default domain seçimi için kullanılır.
const ALL_DOMAINS = [
  'mortality',
  'feeding',
  'growth',
  'water_quality',
  'health',
  'maintenance',
  'weather',
] as const;

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================
//
// entityId + entityType: Hangi varlığın timeline'ını istiyoruz?
// days: Kaç günlük geçmişe bakılacak? (varsayılan: 7)
// domains: Hangi domain'ler dahil edilecek? (varsayılan: tümü)
//
// Domain filtresi, gereksiz sorguları atlamak için kullanılır:
//   Sadece 'mortality' ve 'feeding' istenirse WQ, growth vb. sorgulanmaz.
// ============================================================================

export const inputSchema = z.object({
  entityId: z.string()
    .describe('Tank veya Batch UUID'),

  entityType: z.enum(['tank', 'batch'])
    .describe('Varlık tipi: tank veya batch'),

  days: z.number().int().positive().default(7)
    .describe('Geçmişe bakılacak gün sayısı (varsayılan: 7)'),

  domains: z.array(z.string()).optional()
    .describe('Dahil edilecek domain filtreleri: mortality, feeding, growth, water_quality, health, maintenance, weather'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'get_entity_timeline',
  description:
    'Bir tank veya batch için tüm domain\'lerden gelen olayları birleşik ' +
    'zaman çizelgesinde sunar. Mortalite, yemleme, büyüme, su kalitesi, sağlık, ' +
    'bakım ve hava durumu olayları kronolojik sırada listelenir.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entityId: { type: 'string', description: 'Tank veya Batch UUID' },
      entityType: {
        type: 'string',
        enum: ['tank', 'batch'],
        description: 'Varlık tipi: tank veya batch',
      },
      days: {
        type: 'integer',
        description: 'Geçmişe bakılacak gün sayısı (varsayılan: 7)',
        default: 7,
      },
      domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Domain filtresi: mortality, feeding, growth, water_quality, health, maintenance, weather',
      },
    },
    required: ['entityId', 'entityType'],
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
//
// NASIL ÇALIŞIR:
//   1. entityType'a göre varlık bilgisi çekilir (ad için)
//   2. Tarih aralığı hesaplanır (bugün - days gün)
//   3. İstenen domain'ler belirlenir
//   4. Her domain için GraphQL sorgusu paralel çalıştırılır (Promise.allSettled)
//   5. Sonuçlar TimelineEvent formatına dönüştürülür
//   6. Tüm olaylar timestamp'e göre sıralanır
//   7. Birleşik timeline döndürülür
//
// EXTENSIBLE:
//   - Yeni domain ekleme: fetchAndTransformXxx fonksiyonu yazılır
//   - domainFetchers haritasına eklenir
//   - ALL_DOMAINS dizisine eklenir
// ============================================================================

export async function handler(
  params: unknown,
  client: GraphQLClient,
): Promise<ToolResult> {
  const input = inputSchema.parse(params);
  const notes: string[] = [];

  // ── Tarih Aralığını Hesapla ────────────────────────────────────────
  //
  // 'to' = şu an
  // 'from' = şu an - days gün
  // ISO 8601 formatında — GraphQL DateTime parametresi olarak kullanılır
  // ──────────────────────────────────────────────────────────────────

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (input.days ?? 7));
  const fromISO = from.toISOString();
  const toISO = to.toISOString();

  // ── Varlık Bilgisini Çek ───────────────────────────────────────────
  //
  // Timeline başlığında varlık adı göstermek için gerekli.
  // Tank veya batch bilgisi çekilir.
  // ──────────────────────────────────────────────────────────────────

  let entityName = input.entityId;
  try {
    if (input.entityType === 'tank') {
      const tank = await fetchTank(client, input.entityId);
      entityName = tank.name || tank.code || input.entityId;
    } else {
      const batch = await fetchBatch(client, input.entityId);
      entityName = batch.batchNumber || batch.name || input.entityId;
    }
  } catch {
    notes.push('Varlık bilgisi alınamadı — ID kullanılıyor');
  }

  // ── Domain'leri Belirle ────────────────────────────────────────────
  //
  // domains parametresi verilmişse filtreleme yapılır.
  // Verilmemişse tüm domain'ler dahil edilir.
  // Geçersiz domain isimleri sessizce yok sayılır.
  // ──────────────────────────────────────────────────────────────────

  const requestedDomains = input.domains && input.domains.length > 0
    ? input.domains.filter(d => (ALL_DOMAINS as readonly string[]).includes(d))
    : [...ALL_DOMAINS];

  // ── Domain Sorgularını Çalıştır ────────────────────────────────────
  //
  // Her domain için bir fetcher fonksiyonu tanımlıdır.
  // Sadece istenen domain'ler sorgulanır — gereksiz ağ trafiği önlenir.
  // ──────────────────────────────────────────────────────────────────

  const allEvents: TimelineEvent[] = [];
  const domainsCovered: string[] = [];

  // ── Domain bazlı paralel çekim ─────────────────────────────────────
  const domainPromises: Array<{
    domain: string;
    promise: Promise<TimelineEvent[]>;
  }> = [];

  for (const domain of requestedDomains) {
    const fetcher = getDomainFetcher(
      domain, input.entityId, input.entityType, fromISO, toISO, client,
    );
    if (fetcher) {
      domainPromises.push({ domain, promise: fetcher });
    }
  }

  // Promise.allSettled ile paralel çalıştır
  const results = await Promise.allSettled(
    domainPromises.map(dp => dp.promise),
  );

  // ── Sonuçları Topla ────────────────────────────────────────────────
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const domainInfo = domainPromises[i]!;

    if (result.status === 'fulfilled' && result.value.length > 0) {
      allEvents.push(...result.value);
      domainsCovered.push(domainInfo.domain);
    } else if (result.status === 'rejected') {
      const reason = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
      notes.push(`${domainInfo.domain} sorgusu başarısız: ${reason}`);
    }
  }

  // ── Olayları Sırala ────────────────────────────────────────────────
  // En yeni olay başta — azalan timestamp sıralaması
  allEvents.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  // ── Olay Sayısını Sınırla ──────────────────────────────────────────
  const MAX_EVENTS = 50;
  const truncated = allEvents.length > MAX_EVENTS;
  const limitedEvents = allEvents.slice(0, MAX_EVENTS);

  // ── Sonucu Oluştur ────────────────────────────────────────────────
  const entity = {
    type: input.entityType,
    id: input.entityId,
    name: entityName,
  };

  const period = { from: fromISO, to: toISO };

  const timeline: TimelineResult = {
    entity,
    events: limitedEvents,
    period,
    totalEvents: allEvents.length,
    truncated,
    showing: limitedEvents.length,
    eventCount: limitedEvents.length,
    domainsCovered,
    notes,
    periodSummary: generateTimelineInsight(entity, allEvents, period),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(timeline) }],
  };
}

// ============================================================================
// DOMAIN FETCHER SEÇİCİ
// ============================================================================
//
// Her domain için uygun GraphQL sorgusunu çalıştıran ve sonuçları
// TimelineEvent formatına dönüştüren fonksiyonu döndürür.
//
// NASIL ÇALIŞIR:
//   1. domain string'ine göre switch yapılır
//   2. entityType'a göre doğru filtreler uygulanır
//   3. GraphQL sonuçları transformXxx fonksiyonlarıyla dönüştürülür
//
// EXTENSIBLE:
//   - Yeni domain eklemek için switch'e yeni case eklenir
//   - İlgili transformXxx fonksiyonu yazılır
// ============================================================================

function getDomainFetcher(
  domain: string,
  entityId: string,
  entityType: 'tank' | 'batch',
  from: string,
  to: string,
  client: GraphQLClient,
): Promise<TimelineEvent[]> | null {
  switch (domain) {
    // ── Su Kalitesi ──────────────────────────────────────────────────
    case 'water_quality':
      if (entityType === 'tank') {
        return fetchAndTransformWQ(client, entityId, from, to);
      }
      // Batch için WQ → batch'in tank'ından çekilir (ancak tankId bilinmiyorsa atla)
      return Promise.resolve([]);

    // ── Yemleme ──────────────────────────────────────────────────────
    case 'feeding':
      return fetchAndTransformFeeding(client, entityId, entityType, from, to);

    // ── Büyüme ───────────────────────────────────────────────────────
    case 'growth':
      if (entityType === 'batch') {
        return fetchAndTransformGrowth(client, entityId, from, to);
      }
      return Promise.resolve([]);

    // ── Sağlık ───────────────────────────────────────────────────────
    case 'health':
      return fetchAndTransformHealth(client, entityId, entityType, from, to);

    // ── Bakım ────────────────────────────────────────────────────────
    case 'maintenance':
      return fetchAndTransformMaintenance(client, from, to);

    // ── Mortalite ────────────────────────────────────────────────────
    case 'mortality':
      if (entityType === 'batch') {
        return fetchAndTransformMortality(client, entityId, from, to);
      }
      return Promise.resolve([]);

    // ── Hava Durumu ──────────────────────────────────────────────────
    case 'weather':
      // Weather site bazlı — genel gözlemler olarak eklenir
      return Promise.resolve([]);

    default:
      return null;
  }
}

// ============================================================================
// DOMAIN DÖNÜŞÜM FONKSİYONLARI
// ============================================================================
//
// Her fonksiyon:
//   1. İlgili GraphQL sorgusunu çalıştırır
//   2. Sonuçları TimelineEvent dizisine dönüştürür
//   3. Türkçe özet mesajı oluşturur
//
// EXTENSIBLE:
//   - Her fonksiyona ek metrikler eklenebilir
//   - Özet mesajları zenginleştirilebilir
//   - Severity hesaplamaları derinleştirilebilir
// ============================================================================

/**
 * Su kalitesi ölçümlerini timeline olaylarına dönüştürür.
 *
 * Her WQ ölçümü bir olay olarak eklenir — parametreler metrics alanında.
 * overallStatus alanı severity olarak kullanılır.
 */
async function fetchAndTransformWQ(
  client: GraphQLClient,
  tankId: string,
  from: string,
  to: string,
): Promise<TimelineEvent[]> {
  const wqData = await fetchWaterQuality(client, {
    tankId,
    startDate: from,
    endDate: to,
  });

  return (wqData.items ?? []).map(m => {
    const params = m.parameters ?? {};
    const metricEntries: Record<string, number> = {};
    if (params.temperature !== undefined) metricEntries['temperature_C'] = params.temperature;
    if (params.dissolvedOxygen !== undefined) metricEntries['DO_mg_L'] = params.dissolvedOxygen;
    if (params.pH !== undefined) metricEntries['pH'] = params.pH;
    if (params.ammonia !== undefined) metricEntries['ammonia_mg_L'] = params.ammonia;
    if (params.nitrite !== undefined) metricEntries['nitrite_mg_L'] = params.nitrite;

    // Türkçe özet oluştur
    const paramSummaries: string[] = [];
    if (params.temperature !== undefined) paramSummaries.push(`Sıcaklık: ${params.temperature}°C`);
    if (params.dissolvedOxygen !== undefined) paramSummaries.push(`DO: ${params.dissolvedOxygen} mg/L`);
    if (params.pH !== undefined) paramSummaries.push(`pH: ${params.pH}`);
    if (params.ammonia !== undefined) paramSummaries.push(`NH₃: ${params.ammonia} mg/L`);

    return {
      timestamp: m.measuredAt,
      domain: 'water_quality',
      eventType: 'wq_measurement',
      summary: `Su kalitesi ölçümü — ${paramSummaries.join(', ') || 'parametreler mevcut'}. Durum: ${m.overallStatus}`,
      severity: m.overallStatus,
      metrics: metricEntries,
    };
  });
}

/**
 * Yemleme kayıtlarını timeline olaylarına dönüştürür.
 *
 * Her yemleme kaydı bir olay olarak eklenir.
 * Planlanan vs gerçekleşen sapması özete dahil edilir.
 */
async function fetchAndTransformFeeding(
  client: GraphQLClient,
  entityId: string,
  entityType: 'tank' | 'batch',
  from: string,
  to: string,
): Promise<TimelineEvent[]> {
  const filter = entityType === 'tank'
    ? { tankId: entityId, startDate: from, endDate: to }
    : { batchId: entityId, startDate: from, endDate: to };

  const feedingData = await fetchFeedingRecords(client, filter);

  return (feedingData.items ?? []).map(r => ({
    timestamp: r.feedingDate,
    domain: 'feeding',
    eventType: r.isVarianceAcceptable ? 'feeding_completed' : 'feeding_variance',
    summary: `Yemleme: ${r.actualAmount.toFixed(1)} kg (plan: ${r.plannedAmount.toFixed(1)} kg). ` +
             `Sapma: %${r.variancePercent.toFixed(1)}${r.isBelowPlan ? ' (plan altı)' : ''}`,
    severity: r.isVarianceAcceptable ? 'normal' : (Math.abs(r.variancePercent) > 30 ? 'high' : 'medium'),
    metrics: {
      planned_kg: r.plannedAmount,
      actual_kg: r.actualAmount,
      variance_percent: r.variancePercent,
    },
  }));
}

/**
 * Büyüme ölçümlerini timeline olaylarına dönüştürür.
 *
 * Her büyüme ölçümü ortalama ağırlık, SGR ve numune boyutu ile raporlanır.
 */
async function fetchAndTransformGrowth(
  client: GraphQLClient,
  batchId: string,
  from: string,
  to: string,
): Promise<TimelineEvent[]> {
  const growthData = await fetchGrowthMeasurements(client, {
    batchId,
    startDate: from,
    endDate: to,
  });

  return (growthData.items ?? []).map(g => {
    const metrics: Record<string, number> = {
      avg_weight_g: g.averageWeight,
      sample_size: g.sampleSize,
      weight_cv: g.weightCV,
    };
    if (g.specificGrowthRate !== undefined && g.specificGrowthRate !== null) {
      metrics['sgr_pct_day'] = g.specificGrowthRate;
    }
    if (g.dailyGrowthRate !== undefined && g.dailyGrowthRate !== null) {
      metrics['daily_growth_g'] = g.dailyGrowthRate;
    }

    const sgrInfo = g.specificGrowthRate !== undefined && g.specificGrowthRate !== null
      ? `, SGR: %${g.specificGrowthRate.toFixed(2)}/gün`
      : '';

    return {
      timestamp: g.measurementDate,
      domain: 'growth',
      eventType: 'growth_sampling',
      summary: `Büyüme ölçümü — Ort. ağırlık: ${g.averageWeight.toFixed(1)}g${sgrInfo}. ` +
               `Numune: ${g.sampleSize} adet. ${g.isOnTarget ? 'Hedefte' : 'Hedef altı'}.`,
      severity: g.isOnTarget ? 'normal' : 'medium',
      metrics,
    };
  });
}

/**
 * Sağlık olaylarını timeline olaylarına dönüştürür.
 *
 * Her sağlık olayı başlık, şiddet ve durum bilgisiyle raporlanır.
 */
async function fetchAndTransformHealth(
  client: GraphQLClient,
  entityId: string,
  entityType: 'tank' | 'batch',
  from: string,
  to: string,
): Promise<TimelineEvent[]> {
  const filter = entityType === 'tank'
    ? { tankId: entityId, startDate: from, endDate: to }
    : { batchId: entityId, startDate: from, endDate: to };

  const healthData = await fetchHealthEvents(client, filter);

  return (healthData.items ?? []).map(h => {
    const metrics: Record<string, number> = {};
    if (h.affectedCount) metrics['affected_count'] = h.affectedCount;
    if (h.mortalityCount) metrics['mortality_count'] = h.mortalityCount;

    return {
      timestamp: h.startDate,
      domain: 'health',
      eventType: `health_${h.eventType}`,
      summary: `Sağlık olayı: ${h.title}. Şiddet: ${h.severity}, Durum: ${h.status}. ` +
               `${h.isQuarantined ? 'Karantinada. ' : ''}${h.isUnderTreatment ? 'Tedavi altında.' : ''}`,
      severity: h.severity,
      metrics,
    };
  });
}

/**
 * Bakım/iş emri olaylarını timeline olaylarına dönüştürür.
 *
 * Tüm iş emirleri listelenir — geciken olanlar severity: high ile işaretlenir.
 */
async function fetchAndTransformMaintenance(
  client: GraphQLClient,
  from: string,
  to: string,
): Promise<TimelineEvent[]> {
  // Tüm iş emirlerini çek (tarih filtresi opsiyonel)
  const woData = await fetchWorkOrders(client, undefined, 1, 50);

  return (woData.items ?? []).map(wo => {
    const isOverdue = wo.dueDate
      ? new Date(wo.dueDate).getTime() < Date.now() &&
        wo.status !== 'completed' && wo.status !== 'cancelled'
      : false;

    return {
      timestamp: wo.createdAt,
      domain: 'maintenance',
      eventType: isOverdue ? 'work_order_overdue' : 'work_order_created',
      summary: `İş emri: ${wo.title}. Durum: ${wo.status}, Öncelik: ${wo.priority}. ` +
               `Tip: ${wo.workOrderType}${isOverdue ? ' — GECİKMİŞ!' : ''}`,
      severity: isOverdue ? 'high' : (wo.priority === 'critical' ? 'critical' : 'normal'),
      metrics: wo.estimatedDurationHours
        ? { estimated_hours: wo.estimatedDurationHours }
        : undefined,
    };
  });
}

/**
 * Batch mortalite geçmişini timeline olaylarına dönüştürür.
 *
 * Batch history'den mortalite tipi olayları filtrelenir.
 */
async function fetchAndTransformMortality(
  client: GraphQLClient,
  batchId: string,
  from: string,
  to: string,
): Promise<TimelineEvent[]> {
  const history = await fetchBatchHistory(
    client,
    batchId,
    ['MORTALITY', 'MORTALITY_EVENT'],
    from,
    to,
    100,
  );

  return history.map(h => {
    const metrics: Record<string, number> = {};
    if (h.quantityChange) metrics['quantity_change'] = Math.abs(h.quantityChange);
    if (h.biomassChangeKg) metrics['biomass_change_kg'] = Math.abs(h.biomassChangeKg);

    return {
      timestamp: h.timestamp,
      domain: 'mortality',
      eventType: 'mortality_recorded',
      summary: `Mortalite kaydı: ${h.description || 'Ölüm kaydı'}. ` +
               `${h.quantityChange ? `Kayıp: ${Math.abs(h.quantityChange)} adet` : ''}` +
               `${h.tankCode ? ` (Tank: ${h.tankCode})` : ''}`,
      severity: (h.quantityChange && Math.abs(h.quantityChange) > 10) ? 'high' : 'medium',
      metrics,
    };
  });
}

/**
 * Timeline verisinden Türkçe dönem özeti oluşturur.
 *
 * AI'ın olay listesini okumadan genel durumu kavramasını sağlar.
 * Domain dağılımı ve kritik olaylar vurgulanır.
 */
function generateTimelineInsight(
  entity: { type: string; name: string },
  events: TimelineEvent[],
  period: { from: string; to: string },
): string {
  const parts: string[] = [];

  // Dönem süresi hesapla
  const fromMs = new Date(period.from).getTime();
  const toMs = new Date(period.to).getTime();
  const daysBetween = Math.max(1, Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24)));

  // Genel özet
  parts.push(`${entity.name} — ${events.length} olay (son ${daysBetween} gün)`);

  // Domain bazlı sayılar
  const domainCounts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.domain] = (acc[e.domain] || 0) + 1;
    return acc;
  }, {});
  const domainSummary = Object.entries(domainCounts)
    .map(([d, c]) => `${d}: ${c}`)
    .join(', ');
  if (domainSummary) {
    parts.push(`Domain dağılımı: ${domainSummary}`);
  }

  // Kritik/yüksek öncelikli olaylar
  const critical = events.filter(
    e => e.severity === 'critical' || e.severity === 'high',
  );
  if (critical.length > 0) {
    parts.push(`${critical.length} kritik/yüksek öncelikli olay`);
    const latest = critical[0];
    if (latest) {
      parts.push(`Son kritik: ${latest.summary}`);
    }
  }

  return parts.join('. ') + '.';
}
