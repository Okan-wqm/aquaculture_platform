// ============================================================================
// MCP Farm Intelligence — Çiftlik Anlık Görüntüsü Aracı
// ============================================================================
//
// Tüm çiftliğin anlık fotoğrafını tek sorguda birleştirir.
// AI'ın bütünsel olarak düşünmesini sağlar — parçalar yerine bütünü görür.
//
// NASIL ÇALIŞIR:
//   1. Tüm aktif site'lar çekilir (veya belirli bir site filtresi uygulanır)
//   2. Tanklar, batch'ler, feeding durumu paralel sorgulanır (Promise.allSettled)
//   3. Health events, maintenance, weather eklenir
//   4. Tek bir özet objesi döndürülür — AI tek bir bakışta tüm durumu kavrar
//
// NEDEN TEK BİR SNAPSHOT?
//   AI modeli her tool çağrısında context penceresi harcar.
//   7 ayrı tool çağrısı yerine 1 snapshot çağrısı:
//     - Daha az token tüketimi
//     - Daha hızlı yanıt
//     - Bütünsel analiz imkanı (cross-domain ilişkiler görünür)
//
// HATA YÖNETİMİ:
//   Promise.allSettled kullanılır — bir sorgu başarısız olsa bile
//   diğer sorgular devam eder. Başarısız sorgular için varsayılan
//   değerler döner ve 'notes' dizisine uyarı eklenir.
//   Bu yaklaşım "graceful degradation" sağlar.
//
// EXTENSIBLE:
//   - Yeni domain'ler (ör: stocking, harvest) paralel sorgu dizisine eklenebilir
//   - Özet metrikleri genişletilebilir
//   - Site bazlı filtreler derinleştirilebilir (departman, tank tipi vb.)
//   - Önbellek katmanı eklenebilir (sık çağrılan snapshot'lar için)
// ============================================================================

import { z } from 'zod';
import type { GraphQLClient } from '../../graphql/client.js';

// ── GraphQL Sorgu İmportları ────────────────────────────────────────────────
import { fetchActiveSites, fetchSite } from '../../graphql/queries/sites.js';
import { fetchTanks } from '../../graphql/queries/tanks.js';
import { fetchActiveBatches } from '../../graphql/queries/batches.js';
import { fetchDailyFeedingPlan } from '../../graphql/queries/feeding.js';
import { fetchCriticalHealthEvents, fetchHealthEventStats } from '../../graphql/queries/health.js';
import { fetchOverdueWorkOrders } from '../../graphql/queries/maintenance.js';
import { fetchCurrentWeather } from '../../graphql/queries/weather.js';
import { fetchTodaysTasks } from '../../graphql/queries/tasks.js';

// ── Tip Tanımları ───────────────────────────────────────────────────────────

/** MCP tool sonuç tipi — tüm tool'larda ortak yapı */
type ToolResult = { content: Array<{ type: 'text'; text: string }> };

/** Site özet bilgisi — snapshot'ta gösterilecek minimum alan seti */
interface SiteSnapshot {
  id: string;
  name: string;
  type: string;
  status: string;
  tankCount: number;
  activeBatchCount: number;
}

/** Tank durumu özeti — toplam, aktif, bakımda, boş, kapasite aşımı */
interface TankSummary {
  total: number;
  active: number;
  maintenance: number;
  empty: number;
  overCapacity: number;
}

/** Batch özet bilgisi — aktif batch'lerin temel metrikleri */
interface BatchSnapshot {
  id: string;
  batchNumber: string;
  species: string;
  status: string;
  currentQuantity: number;
  currentBiomassKg: number;
  tankName: string;
  daysInProduction: number;
  mortalityRate: number;
}

/** Yemleme durumu özeti */
interface FeedingStatus {
  plannedToday: number;
  completedToday: number;
  completionPercent: number;
}

/** Hava durumu özeti */
interface WeatherSnapshot {
  temperature: number | null;
  windSpeed: number | null;
  condition: string;
}

/** Tam çiftlik anlık görüntüsü */
interface FarmSnapshot {
  snapshotTimestamp: string;
  sites: SiteSnapshot[];
  activeBatches: BatchSnapshot[];
  tankSummary: TankSummary;
  todaysTasks: { total: number; completed: number; overdue: number };
  activeHealthEvents: { total: number; critical: number; underTreatment: number; quarantined: number };
  feedingStatus: FeedingStatus;
  overdueMaintenanceCount: number;
  latestWeather: WeatherSnapshot;
  notes: string[];
  briefingSummary: string;
}

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================
//
// siteId opsiyoneldir:
//   - Verilmezse → tüm aktif site'lar taranır (çiftlik geneli snapshot)
//   - Verilirse → sadece belirtilen site'ın snapshot'ı alınır
//
// Bu yaklaşım hem genel bakış hem de detaylı site incelemesi sağlar.
// ============================================================================

export const inputSchema = z.object({
  siteId: z.string().optional()
    .describe('Site UUID — verilmezse tüm aktif site\'lar taranır'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'get_farm_snapshot',
  description:
    'Çiftliğin anlık fotoğrafını tek sorguda döndürür: site\'lar, tanklar, batch\'ler, ' +
    'yemleme durumu, sağlık olayları, bakım, hava durumu ve görevler. ' +
    'AI bütünsel analiz yapabilir.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      siteId: {
        type: 'string',
        description: 'Site UUID — verilmezse tüm aktif site\'lar taranır',
      },
    },
    required: [],
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
//   1. siteId varsa tek site, yoksa tüm aktif site'lar çekilir
//   2. Paralel sorgular Promise.allSettled ile çalıştırılır
//   3. Her sorgu sonucu kontrol edilir — fulfilled ise veri, rejected ise varsayılan
//   4. Tüm veriler tek bir FarmSnapshot objesinde birleştirilir
//   5. JSON olarak döndürülür
//
// NEDEN Promise.allSettled?
//   Promise.all kullanıldığında bir sorgu başarısız olursa TÜM sorgular iptal olur.
//   Promise.allSettled ile her sorgu bağımsız çalışır — başarısız olan sadece
//   kendi alanını etkiler. Bu, kısmi veri ile bile snapshot oluşturulabilmesini sağlar.
//
// EXTENSIBLE:
//   - Yeni paralel sorgular parallelQueries dizisine eklenebilir
//   - Her yeni sorgu için extractXxx yardımcı fonksiyonu yazılır
//   - notes dizisi otomatik olarak başarısız sorguları raporlar
// ============================================================================

export async function handler(
  params: unknown,
  client: GraphQLClient,
): Promise<ToolResult> {
  const input = inputSchema.parse(params);
  const notes: string[] = [];

  // ── Adım 1: Site'ları Belirle ──────────────────────────────────────
  //
  // siteId verilmişse sadece o site, yoksa tüm aktif site'lar.
  // Bu bilgi hava durumu ve yemleme planı sorguları için de kullanılır.
  // ────────────────────────────────────────────────────────────────────

  let siteInfos: Array<{ id: string; name: string; type: string; status: string }> = [];

  try {
    if (input.siteId) {
      // Tek site modu — detaylı bilgi
      const site = await fetchSite(client, input.siteId);
      siteInfos = [{ id: site.id, name: site.name, type: site.type, status: site.status }];
    } else {
      // Tüm aktif site'lar modu — genel bakış
      const sites = await fetchActiveSites(client);
      siteInfos = sites.map(s => ({ id: s.id, name: s.name, type: s.type, status: s.status }));
    }
  } catch (err) {
    notes.push(`Site sorgusu başarısız: ${err instanceof Error ? err.message : String(err)}`);
  }

  // İlk site'ın ID'si — hava durumu ve yemleme planı için kullanılır
  // Birden fazla site varsa ilkini kullanır (hava durumu site bazlıdır)
  const primarySiteId = siteInfos.length > 0 ? siteInfos[0]!.id : null;

  // ── Adım 2: Paralel Sorgular ──────────────────────────────────────
  //
  // 7 sorgu eşzamanlı çalıştırılır — toplam bekleme süresi
  // en yavaş sorgunun süresi kadar olur (paralel kazanç).
  //
  // Her sorgu bir label ile etiketlenir — hata durumunda hangi
  // sorgunun başarısız olduğu notes dizisine yazılır.
  // ────────────────────────────────────────────────────────────────────

  const [
    tanksResult,
    batchesResult,
    feedingResult,
    criticalHealthResult,
    healthStatsResult,
    overdueMaintenanceResult,
    weatherResult,
    tasksResult,
  ] = await Promise.allSettled([
    // Sorgu 1: Tüm tanklar
    fetchTanks(client),

    // Sorgu 2: Aktif batch'ler
    fetchActiveBatches(client),

    // Sorgu 3: Günlük yemleme planı (ilk site için)
    primarySiteId
      ? fetchDailyFeedingPlan(client, primarySiteId)
      : Promise.resolve(null),

    // Sorgu 4: Kritik sağlık olayları
    fetchCriticalHealthEvents(client),

    // Sorgu 5: Sağlık olayı istatistikleri
    fetchHealthEventStats(client),

    // Sorgu 6: Gecikmiş iş emirleri
    fetchOverdueWorkOrders(client),

    // Sorgu 7: Anlık hava durumu (ilk site için)
    primarySiteId
      ? fetchCurrentWeather(client, primarySiteId)
      : Promise.resolve(null),

    // Sorgu 8: Bugünkü görevler
    fetchTodaysTasks(client),
  ]);

  // ── Adım 3: Sonuçları Çıkar ve Varsayılanlar Ata ──────────────────
  //
  // Her sorgu sonucu kontrol edilir:
  //   fulfilled → gerçek veri kullanılır
  //   rejected  → varsayılan değer atanır ve notes'a uyarı eklenir
  //
  // extractSettled yardımcı fonksiyonu bu mantığı merkeziler.
  // ────────────────────────────────────────────────────────────────────

  // ── Tanklar ────────────────────────────────────────────────────────
  const tanksData = extractSettled(tanksResult, 'Tanklar', notes);
  const tanks = tanksData?.items ?? [];

  // ── Batch'ler ──────────────────────────────────────────────────────
  const batchesData = extractSettled(batchesResult, 'Batch\'ler', notes);
  const batches = batchesData?.items ?? [];

  // ── Yemleme Planı ──────────────────────────────────────────────────
  const feedingPlan = extractSettled(feedingResult, 'Yemleme planı', notes);

  // ── Kritik Sağlık Olayları ─────────────────────────────────────────
  const criticalHealth = extractSettled(criticalHealthResult, 'Kritik sağlık olayları', notes);

  // ── Sağlık İstatistikleri ──────────────────────────────────────────
  const healthStats = extractSettled(healthStatsResult, 'Sağlık istatistikleri', notes);

  // ── Gecikmiş Bakımlar ──────────────────────────────────────────────
  const overdueOrders = extractSettled(overdueMaintenanceResult, 'Gecikmiş bakımlar', notes);

  // ── Hava Durumu ────────────────────────────────────────────────────
  const weather = extractSettled(weatherResult, 'Hava durumu', notes);

  // ── Görevler ───────────────────────────────────────────────────────
  const tasksData = extractSettled(tasksResult, 'Görevler', notes);

  // ── Adım 4: Snapshot Objesini Oluştur ──────────────────────────────
  //
  // Çekilen veriler anlamlı özetlere dönüştürülür.
  // Her dönüşüm ayrı bir yardımcı fonksiyonla yapılır.
  // ────────────────────────────────────────────────────────────────────

  // ── Site Özetleri ──────────────────────────────────────────────────
  // Her site için o site'a ait tank ve batch sayıları hesaplanır
  const siteSnapshots: SiteSnapshot[] = siteInfos.map(site => {
    // Bu site'a ait tankları say
    // Tankların department.siteId alanı ile eşleştirilir
    const siteTankCount = tanks.filter(t =>
      t.department?.site?.id === site.id || t.department?.siteId === site.id,
    ).length;

    // Bu site'a ait batch sayısını tahmin et
    // Batch → tankAllocation → tank → department → site zinciri ile
    const siteBatchCount = batches.filter(b =>
      b.tankAllocations?.some(ta =>
        tanks.some(t =>
          t.id === ta.tank.id &&
          (t.department?.site?.id === site.id || t.department?.siteId === site.id),
        ),
      ),
    ).length;

    return {
      id: site.id,
      name: site.name,
      type: site.type,
      status: site.status,
      tankCount: siteTankCount,
      activeBatchCount: siteBatchCount,
    };
  });

  // ── Tank Özeti ─────────────────────────────────────────────────────
  // Tankları durumlarına göre grupla ve say
  const tankSummary: TankSummary = buildTankSummary(tanks);

  // ── Batch Özetleri ─────────────────────────────────────────────────
  // Her batch için temel metrikler ve tank bilgisi
  const batchSnapshots: BatchSnapshot[] = batches.map(b => {
    // Batch'in atandığı ilk tankın adı
    const tankName = b.tankAllocations?.[0]?.tank?.name ?? 'Bilinmiyor';

    return {
      id: b.id,
      batchNumber: b.batchNumber,
      species: b.species?.commonName ?? 'Bilinmiyor',
      status: b.status,
      currentQuantity: b.currentQuantity,
      currentBiomassKg: b.currentBiomassKg,
      tankName,
      daysInProduction: b.daysInProduction,
      mortalityRate: b.mortalityRate,
    };
  });

  // ── Yemleme Durumu ─────────────────────────────────────────────────
  const feedingStatus: FeedingStatus = {
    plannedToday: feedingPlan?.totalPlannedKg ?? 0,
    completedToday: feedingPlan?.totalActualKg ?? 0,
    completionPercent: feedingPlan?.completionPercent ?? 0,
  };

  // ── Sağlık Olayları Özeti ──────────────────────────────────────────
  const activeHealthEvents = {
    total: healthStats?.active ?? (criticalHealth?.length ?? 0),
    critical: healthStats?.critical ?? (criticalHealth?.length ?? 0),
    underTreatment: healthStats?.underTreatment ?? 0,
    quarantined: healthStats?.quarantined ?? 0,
  };

  // ── Görevler Özeti ─────────────────────────────────────────────────
  // Toplam aktif görevler ve gecikmiş görevler
  const todaysTasks = {
    total: tasksData?.total ?? 0,
    completed: 0, // workOrders sorgusu sadece aktif görevleri döndürür
    overdue: overdueOrders?.length ?? 0,
  };

  // ── Hava Durumu Özeti ──────────────────────────────────────────────
  const latestWeather: WeatherSnapshot = buildWeatherSnapshot(weather);

  // ── Batch Sayısını Sınırla ──────────────────────────────────────────
  const MAX_BATCHES = 15;
  const limitedBatches = batchSnapshots
    .sort((a, b) => b.mortalityRate - a.mortalityRate)
    .slice(0, MAX_BATCHES);

  // ── Adım 5: Sonucu Birleştir ve Döndür ─────────────────────────────
  const snapshot: FarmSnapshot = {
    snapshotTimestamp: new Date().toISOString(),
    sites: siteSnapshots,
    activeBatches: limitedBatches,
    tankSummary,
    todaysTasks,
    activeHealthEvents,
    feedingStatus,
    overdueMaintenanceCount: overdueOrders?.length ?? 0,
    latestWeather,
    notes,
    briefingSummary: '',
  };

  // Insight cümlesi — tüm snapshot verisi toplandıktan sonra oluşturulur
  snapshot.briefingSummary = generateSnapshotInsight(snapshot);

  return {
    content: [{ type: 'text', text: JSON.stringify(snapshot) }],
  };
}

// ============================================================================
// YARDIMCI FONKSİYONLAR
// ============================================================================

/**
 * Promise.allSettled sonucunu güvenli şekilde çıkarır.
 *
 * NASIL ÇALIŞIR:
 *   1. result.status === 'fulfilled' ise result.value döner
 *   2. result.status === 'rejected' ise null döner ve notes'a uyarı eklenir
 *
 * Bu fonksiyon "fail-safe extraction" sağlar — hiçbir sorgu hatası
 * tüm snapshot'ı çökertmez.
 *
 * @param result - Promise.allSettled'dan gelen tek bir sonuç
 * @param label - Hata mesajında kullanılacak sorgu etiketi (Türkçe)
 * @param notes - Uyarı mesajlarının ekleneceği dizi
 * @returns Başarılı sonuç veya null
 */
function extractSettled<T>(
  result: PromiseSettledResult<T>,
  label: string,
  notes: string[],
): T | null {
  if (result.status === 'fulfilled') {
    return result.value;
  }

  // rejected — hata mesajını çıkar
  const reason = result.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  notes.push(`${label} sorgusu başarısız: ${message}`);
  return null;
}

/**
 * Tank listesinden özet istatistik oluşturur.
 *
 * NASIL ÇALIŞIR:
 *   1. Tüm tanklar taranır
 *   2. Her tank durumuna göre sayılır:
 *      - active: isActive === true ve status !== 'maintenance'
 *      - maintenance: status === 'maintenance' veya 'MAINTENANCE'
 *      - empty: currentBiomass === 0 veya çok düşük
 *      - overCapacity: capacityInfo.utilizationPercent > 100
 *   3. Total = tanks.length
 *
 * EXTENSIBLE:
 *   - Yeni tank durumları (ör: quarantine, cleaning) eklenebilir
 *   - Yüzdelik hesaplamalar eklenebilir
 *
 * @param tanks - Tank bilgileri dizisi
 * @returns Tank durumu özeti
 */
function buildTankSummary(
  tanks: Array<{
    status: string;
    isActive: boolean;
    currentBiomass: number;
    capacityInfo?: { utilizationPercent: number };
  }>,
): TankSummary {
  let active = 0;
  let maintenance = 0;
  let empty = 0;
  let overCapacity = 0;

  for (const tank of tanks) {
    const statusLower = (tank.status ?? '').toLowerCase();

    // Bakım durumunda mı?
    if (statusLower === 'maintenance' || statusLower === 'under_maintenance') {
      maintenance++;
      continue;
    }

    // Boş tank mı? (biyokütle 0 veya çok düşük)
    if (tank.currentBiomass <= 0) {
      empty++;
      continue;
    }

    // Kapasite aşımı mı? (kullanım oranı %100'ün üzerinde)
    if (tank.capacityInfo && tank.capacityInfo.utilizationPercent > 100) {
      overCapacity++;
    }

    // Aktif tank sayısı
    if (tank.isActive) {
      active++;
    }
  }

  return {
    total: tanks.length,
    active,
    maintenance,
    empty,
    overCapacity,
  };
}

/**
 * Hava durumu verisinden özet oluşturur.
 *
 * NASIL ÇALIŞIR:
 *   1. weather null ise varsayılan (bilinmiyor) döner
 *   2. Sıcaklık ve rüzgar hızı doğrudan alınır
 *   3. Durum bilgisi (condition) rüzgar hızı ve yağışa göre belirlenir:
 *      - Rüzgar > 20 m/s → "Fırtınalı"
 *      - Rüzgar > 10 m/s → "Rüzgarlı"
 *      - Yağış > 0 → "Yağmurlu"
 *      - Aksi halde → "Normal"
 *
 * EXTENSIBLE:
 *   - Dalga yüksekliği, basınç gibi ek parametreler eklenebilir
 *   - Deniz kafesi operasyonları için deniz durumu bilgisi eklenebilir
 *
 * @param weather - Anlık hava durumu verisi (null olabilir)
 * @returns Hava durumu özeti
 */
function buildWeatherSnapshot(
  weather: {
    temperature?: number;
    windSpeed?: number;
    precipitation?: number;
  } | null | undefined,
): WeatherSnapshot {
  if (!weather) {
    return {
      temperature: null,
      windSpeed: null,
      condition: 'Veri yok',
    };
  }

  // Durum belirleme — basit kural tabanlı
  let condition = 'Normal';
  if (weather.windSpeed !== undefined) {
    if (weather.windSpeed > 20) {
      condition = 'Fırtınalı';
    } else if (weather.windSpeed > 10) {
      condition = 'Rüzgarlı';
    }
  }
  if (weather.precipitation !== undefined && weather.precipitation > 0) {
    condition = condition === 'Normal' ? 'Yağmurlu' : `${condition}, Yağmurlu`;
  }

  return {
    temperature: weather.temperature ?? null,
    windSpeed: weather.windSpeed ?? null,
    condition,
  };
}

/**
 * Snapshot verisinden Türkçe briefing özeti oluşturur.
 *
 * AI'ın ham veriyi ayrıştırmadan durumu kavramasını sağlar.
 * Dikkat gerektiren durumlar (kapasite aşımı, gecikmiş bakım,
 * kritik sağlık olayları) vurgulanır.
 */
function generateSnapshotInsight(snapshot: FarmSnapshot): string {
  const parts: string[] = [];

  // Site/tank/batch özeti
  parts.push(
    `${snapshot.sites.length} site, ${snapshot.tankSummary.total} tank ` +
    `(${snapshot.tankSummary.active} aktif), ${snapshot.activeBatches.length} batch`,
  );

  // Kapasite aşımı uyarısı
  if (snapshot.tankSummary.overCapacity > 0) {
    parts.push(`${snapshot.tankSummary.overCapacity} tank kapasite aşımında`);
  }

  // Yemleme durumu
  if (snapshot.feedingStatus.completionPercent < 80) {
    parts.push(`Yemleme: %${snapshot.feedingStatus.completionPercent} tamamlandı (hedefin altında)`);
  } else {
    parts.push(`Yemleme: %${snapshot.feedingStatus.completionPercent} tamamlandı`);
  }

  // Kritik sağlık olayları
  if (snapshot.activeHealthEvents.critical > 0) {
    parts.push(`${snapshot.activeHealthEvents.critical} kritik sağlık olayı aktif`);
  }

  // Gecikmiş bakım
  if (snapshot.overdueMaintenanceCount > 0) {
    parts.push(`${snapshot.overdueMaintenanceCount} gecikmiş bakım`);
  }

  // Gecikmiş görevler
  if (snapshot.todaysTasks.overdue > 0) {
    parts.push(`${snapshot.todaysTasks.overdue} gecikmiş görev`);
  }

  return parts.join('. ') + '.';
}
