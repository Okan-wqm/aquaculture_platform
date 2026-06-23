// ============================================================================
// MCP Farm Intelligence Server — Tool Kayıt Modülü
// ============================================================================
//
// 11 tool'u MCP server'a kaydeder.
//
// NASIL ÇALIŞIR:
//   1. Tüm tool dosyalarından definition (tanım) ve handler (işleyici) import edilir
//   2. Tool'lar needsClient bayrağına göre kategorize edilir
//   3. ListToolsRequestSchema handler'ı → tüm tool tanımlarını listeler
//   4. CallToolRequestSchema handler'ı → çağrılan tool'u bulur ve çalıştırır
//
// KATEGORİLER (3 kategori, 11 tool):
//   Math (5 tool) — Saf hesaplama, GraphQL gerektirmez:
//     - predict_feeding_impact: Yem etkisi tahmin
//     - calculate_oxygen_budget: Oksijen bütçesi
//     - calculate_growth_metrics: Büyüme metrikleri (SGR, FCR, K)
//     - calculate_carrying_capacity: Taşıma kapasitesi
//     - calculate_water_chemistry: Su kimyası (NH3, CO2, alkalinite)
//
//   Context (2 tool) — Veri sorgulama, GraphQL gerektirir:
//     - get_farm_snapshot: Çiftlik anlık görüntüsü
//     - get_entity_timeline: Varlık olay geçmişi
//
//   Intelligence (4 tool) — Akıllı analiz, GraphQL gerektirir:
//     - detect_anomalies: Anomali tespiti
//     - correlate_domains: Cross-domain korelasyon
//     - analyze_root_cause: Kök neden analizi
//     - assess_risk: Risk değerlendirmesi
//
// HANDLER İMZA FARKLARI:
//   - Math tool'ları: handler(params) → GraphQL client almaz
//   - Context/Intelligence tool'ları: handler(params, client) → GraphQL client alır
//   Bu fark needsClient bayrağı ile yönetilir.
//
// EXTENSIBLE:
//   Yeni tool eklemek için:
//   1. İlgili kategori klasörüne tool dosyası oluşturun
//   2. definition ve handler export edin
//   3. Bu dosyada import + allTools dizisine ekleme yapın
// ============================================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { GraphQLClient } from '../graphql/client.js';
import { handleToolError } from '../utils/error-handler.js';

// ── Math Tool Import'ları ────────────────────────────────────────
// Bu tool'lar saf hesaplama yapar — harici veri kaynağı gerektirmez.
// Her biri belirli bir akuakültür formülünü uygular.
import { definition as predictFeedingDef, handler as predictFeedingHandler } from './math/predict-feeding-impact.js';
import { definition as oxygenBudgetDef, handler as oxygenBudgetHandler } from './math/calculate-oxygen-budget.js';
import { definition as growthMetricsDef, handler as growthMetricsHandler } from './math/calculate-growth-metrics.js';
import { definition as carryingCapacityDef, handler as carryingCapacityHandler } from './math/calculate-carrying-capacity.js';
import { definition as waterChemistryDef, handler as waterChemistryHandler } from './math/calculate-water-chemistry.js';
import { definition as waterTreatmentDef, handler as waterTreatmentHandler } from './math/plan-water-treatment.js';
import { definition as waterCycleDef, handler as waterCycleHandler } from './math/simulate-water-cycle.js';

// ── Context Tool Import'ları ─────────────────────────────────────
// Bu tool'lar GraphQL üzerinden çiftlik verisini sorgular.
// Anlık durum bilgisi ve olay geçmişi sunar.
import { definition as farmSnapshotDef, handler as farmSnapshotHandler } from './context/get-farm-snapshot.js';
import { definition as entityTimelineDef, handler as entityTimelineHandler } from './context/get-entity-timeline.js';

// ── Intelligence Tool Import'ları ────────────────────────────────
// Bu tool'lar GraphQL verisini analiz ederek içgörü üretir.
// Anomali tespiti, korelasyon analizi, kök neden ve risk değerlendirmesi.
import { definition as detectAnomaliesDef, handler as detectAnomaliesHandler } from './intelligence/detect-anomalies.js';
import { definition as correlateDomainsDef, handler as correlateDomainsHandler } from './intelligence/correlate-domains.js';
import { definition as rootCauseDef, handler as rootCauseHandler } from './intelligence/analyze-root-cause.js';
import { definition as assessRiskDef, handler as assessRiskHandler } from './intelligence/assess-risk.js';

// ── Tool Tipi Tanımı ─────────────────────────────────────────────
/**
 * Dahili tool kayıt yapısı.
 *
 * Her tool'un 3 bileşeni vardır:
 *   def: MCP tool tanımı (name, description, inputSchema)
 *   handler: Tool çağrıldığında çalışacak fonksiyon
 *   needsClient: GraphQL client gerektiriyor mu?
 *
 * needsClient = false → handler(params) imzası (Math tool'ları)
 * needsClient = true  → handler(params, client) imzası (Context/Intelligence)
 *
 * TİP GÜVENLİĞİ:
 *   def    → MCP SDK'nın kanonik `Tool` tipi (name/description/inputSchema/annotations).
 *   handler → ham (doğrulanmamış) argümanları alır; her handler kendi içinde
 *            inputSchema.parse(params) ile Zod doğrulaması yapar. Bu yüzden
 *            sınır tipi `Record<string, unknown>` — girdi güven sınırını geçer.
 *            Dönüş tipi MCP SDK'nın kanonik `CallToolResult` tipidir.
 *   needsClient ayrımcısı (discriminant) iki handler imzasını ayırır:
 *     false → handler(params)
 *     true  → handler(params, client)
 */
type ToolEntry =
  | {
      def: Tool;
      handler: (params: Record<string, unknown>) => Promise<CallToolResult>;
      needsClient: false;
    }
  | {
      def: Tool;
      handler: (params: Record<string, unknown>, client: GraphQLClient) => Promise<CallToolResult>;
      needsClient: true;
    };

// ── registerAllTools Fonksiyonu ──────────────────────────────────
/**
 * Tüm tool'ları MCP server'a kaydeder.
 *
 * NASIL ÇALIŞIR:
 *   1. 11 tool'un tanım ve handler'ları bir dizide toplanır
 *   2. ListToolsRequestSchema → tool listesi döndürülür
 *   3. CallToolRequestSchema → çağrılan tool bulunur ve çalıştırılır
 *   4. Hata durumunda handleToolError ile MCP uyumlu hata yanıtı oluşturulur
 *
 * İKİ TÜR HANDLER:
 *   - Math tool'ları sadece params alır (saf hesaplama)
 *   - Context/Intelligence tool'ları params + client alır (veri sorgulama)
 *   needsClient bayrağı ile doğru imza kullanılır
 *
 * @param server - MCP Server instance'ı (tool'lar buna kaydedilir)
 * @param client - GraphQL client (null olabilir — JWT yoksa)
 */
export function registerAllTools(server: Server, client: GraphQLClient | null): void {

  // ── Tool Listesi ──────────────────────────────────────────────
  // Her tool: { def, handler, needsClient }
  // Sıralama: Math → Context → Intelligence
  const allTools: ToolEntry[] = [
    // ── Math Tool'ları ────────────────────────────────────────
    // Saf hesaplama — GraphQL client gerektirmez
    // Bu tool'lar offline modda bile çalışır
    { def: predictFeedingDef,    handler: predictFeedingHandler,    needsClient: false },
    { def: oxygenBudgetDef,      handler: oxygenBudgetHandler,      needsClient: false },
    { def: growthMetricsDef,     handler: growthMetricsHandler,     needsClient: false },
    { def: carryingCapacityDef,  handler: carryingCapacityHandler,  needsClient: false },
    { def: waterChemistryDef,    handler: waterChemistryHandler,    needsClient: false },
    { def: waterTreatmentDef,    handler: waterTreatmentHandler,    needsClient: false },
    { def: waterCycleDef,        handler: waterCycleHandler,        needsClient: false },

    // ── Context Tool'ları ─────────────────────────────────────
    // GraphQL üzerinden veri sorgulama
    { def: farmSnapshotDef,      handler: farmSnapshotHandler,      needsClient: true },
    { def: entityTimelineDef,    handler: entityTimelineHandler,    needsClient: true },

    // ── Intelligence Tool'ları ────────────────────────────────
    // Veri analizi ve içgörü üretimi
    { def: detectAnomaliesDef,   handler: detectAnomaliesHandler,   needsClient: true },
    { def: correlateDomainsDef,  handler: correlateDomainsHandler,  needsClient: true },
    { def: rootCauseDef,         handler: rootCauseHandler,         needsClient: true },
    { def: assessRiskDef,        handler: assessRiskHandler,        needsClient: true },
  ];

  // ── Tool Listeleme Handler'ı ──────────────────────────────────
  // MCP istemcisi "tools/list" isteği gönderdiğinde tüm tool tanımlarını döner.
  // Her tool tanımı: { name, description, inputSchema }
  // Claude bu listeye bakarak hangi tool'u çağıracağına karar verir.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(t => t.def),
  }));

  // ── Tool Çağrı Handler'ı ──────────────────────────────────────
  // MCP istemcisi "tools/call" isteği gönderdiğinde ilgili tool çalıştırılır.
  //
  // Akış:
  //   1. İstek parametrelerinden tool adı ve argümanları alınır
  //   2. allTools dizisinde eşleşen tool aranır
  //   3. Bulunamazsa → hata mesajı döndürülür
  //   4. needsClient=true ama client=null → GraphQL bağlantı hatası döndürülür
  //   5. Tool handler çağrılır (needsClient'a göre doğru imza ile)
  //   6. Hata oluşursa handleToolError ile MCP uyumlu yanıta dönüştürülür
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // ── Tool Arama ──────────────────────────────────────────
    // Çağrılan tool'u tanım adına göre bul
    const tool = allTools.find(t => t.def.name === name);

    // ── Bilinmeyen Tool Kontrolü ─────────────────────────────
    // İstemci var olmayan bir tool çağırdıysa hata dön
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Bilinmeyen tool: ${name}` }],
        isError: true,
      };
    }

    // ── Argümanları Normalize Et ─────────────────────────────
    // MCP CallToolRequest'te arguments opsiyoneldir; yoksa boş kayıt kullanılır.
    // Handler'lar ham (doğrulanmamış) girdiyi kendi içinde Zod ile doğrular.
    const toolArgs: Record<string, unknown> = args ?? {};

    try {
      // ── Tool Handler Çağrısı ────────────────────────────────
      // needsClient ayrımcısı handler imzasını daraltır:
      //   true  → handler(params, client) — Context/Intelligence (GraphQL gerekir)
      //   false → handler(params)        — Math (saf hesaplama)
      if (tool.needsClient) {
        // ── GraphQL Client Kontrolü ──────────────────────────
        // Context/Intelligence tool'ları client gerektirir.
        // client null ise (JWT token yoksa) bu tool'lar çalışamaz.
        if (!client) {
          return {
            content: [{
              type: 'text',
              text: `${name} tool'u GraphQL bağlantısı gerektirir. GATEWAY_URL ve MCP_JWT_TOKEN ayarlanmalı.`,
            }],
            isError: true,
          };
        }
        return await tool.handler(toolArgs, client);
      }
      return await tool.handler(toolArgs);
    } catch (error) {
      // ── Hata İşleme ────────────────────────────────────────
      // Yakalanan hata MCP uyumlu yanıta dönüştürülür
      // handleToolError bilinen hata tiplerini tanıyıp uygun mesaj üretir
      return handleToolError(error, name);
    }
  });
}
