// ============================================================================
// MCP Farm Intelligence Server — Server Kurulum Modülü
// ============================================================================
//
// Model Context Protocol (MCP) server'ını oluşturur ve yapılandırır.
//
// NASIL ÇALIŞIR:
//   1. MCP Server instance oluşturulur (server bilgisi + yetenekler)
//   2. JWT token varsa → decode edilir → GraphQL client oluşturulur
//   3. JWT token yoksa → sadece math tool'ları kullanılabilir (graceful degradation)
//   4. 11 tool kaydedilir (5 math + 2 context + 4 intelligence)
//   5. 2 prompt kaydedilir (daily_operations + batch_review)
//   6. Hazır server nesnesi döndürülür (transport bağlama index.ts'de yapılır)
//
// MİMARİ:
//   index.ts (giriş noktası)
//     → server.ts (bu dosya — server oluşturma)
//       → tools/index.ts (tool kayıt)
//       → prompts/index.ts (prompt kayıt)
//       → graphql/client.ts (GraphQL iletişim)
//       → auth/session-context.ts (JWT session)
//
// GRACEFUL DEGRADATION (Zarif Düşüş):
//   JWT token yoksa veya geçersizse:
//   - GraphQL client oluşturulmaz (null kalır)
//   - Math tool'ları normal çalışır (offline hesaplama)
//   - Context/Intelligence tool'ları hata döner ("GraphQL bağlantısı gerekli")
//   Bu sayede sunucu tamamen çökmez, kısıtlı modda çalışır.
//
// EXTENSIBLE:
//   - Yeni tool eklemek: tools/ klasörüne ekle, tools/index.ts'e import et
//   - Yeni prompt eklemek: prompts/ klasörüne ekle, prompts/index.ts'e export et
//   - Yeni capability eklemek: capabilities nesnesine ekle (resources, logging vb.)
// ============================================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

// ── Yerel Import'lar ─────────────────────────────────────────────
// Prompt import'ları: her prompt'un tanım nesnesi (ListPrompts'ta döner) ve
// mesaj üretici fonksiyonu (GetPrompt'ta çağrılır) import edilir
import { createSessionContext, isTokenExpired } from './auth/session-context.js';
import { McpConfig } from './config.js';
import { GraphQLClient } from './graphql/client.js';
import {
  dailyOperationsPrompt,
  getDailyOperationsMessages,
  batchReviewPrompt,
  getBatchReviewMessages,
} from './prompts/index.js';
import { registerAllTools } from './tools/index.js';
import { createLogger } from './utils/logger.js';

// ── createMcpServer Fonksiyonu ───────────────────────────────────
/**
 * MCP server'ını oluşturur, tool ve prompt'ları kaydeder.
 *
 * NASIL ÇALIŞIR:
 *   1. Server instance oluşturma (name + version + capabilities)
 *   2. GraphQL client kurulumu (JWT token → session → client)
 *   3. Tool kayıt (registerAllTools — 11 tool)
 *   4. Prompt kayıt (ListPrompts + GetPrompt handler'ları)
 *   5. Hazır server döndürme
 *
 * @param config - MCP konfigürasyon nesnesi (loadConfig'den gelir)
 * @returns Yapılandırılmış MCP Server instance'ı
 */
export function createMcpServer(config: McpConfig): Server {
  // ── Logger Oluşturma ────────────────────────────────────────
  // Bu modüle özel logger — mesajlar "[MCP-Server]" ön eki ile loglanır
  const logger = createLogger('MCP-Server');

  // ── MCP Server Instance ─────────────────────────────────────
  // Server bilgisi: Claude ve diğer MCP istemcileri bu bilgiyi görür
  // Capabilities: Bu server'ın ne sunduğunu belirtir
  //   - tools: {} → tool desteği aktif (tool'lar ayrıca kaydedilir)
  //   - prompts: {} → prompt desteği aktif (prompt'lar ayrıca kaydedilir)
  const server = new Server(
    {
      name: 'farm-intelligence',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},     // Tool desteği açık — 11 tool kaydedilecek
        prompts: {},   // Prompt desteği açık — 2 prompt kaydedilecek
      },
    },
  );

  // ============================================================================
  // AŞAMA 1: GraphQL Client Kurulumu
  // ============================================================================
  //
  // JWT token → decode → session context → GraphQL client
  //
  // Olası senaryolar:
  //   A) Token var, geçerli → client oluşturulur (tam işlevsel mod)
  //   B) Token var, geçersiz → decode hatası → client null (kısıtlı mod)
  //   C) Token yok → client null (kısıtlı mod)
  //
  // Kısıtlı modda sadece math tool'ları çalışır (offline hesaplama)
  // ============================================================================

  let client: GraphQLClient | null = null;

  if (config.jwtToken) {
    try {
      // ── Token Süre Kontrolü ────────────────────────────────
      // Süresi dolmuş token ile client oluşturmak anlamsız — her istek 401 alır
      if (isTokenExpired(config.jwtToken)) {
        logger.warn('JWT token süresi dolmuş — sadece math tool\'ları kullanılabilir');
      } else {
        // ── JWT'den Session Oluştur ────────────────────────────
        // Token decode edilir (verify yapılmaz — gateway güvenliği sağlar)
        // tenantId, userId, roles bilgileri çıkarılır
        const session = createSessionContext(config.jwtToken);

        // ── GraphQL Client Oluştur ─────────────────────────────
        // Session bilgileriyle gateway'e bağlanacak client hazırlanır
        // Authorization ve x-tenant-id header'ları otomatik eklenir
        client = new GraphQLClient(config, session);

        logger.info(`GraphQL client hazır — tenant: ${session.tenantId}`);
      }
    } catch (e) {
      // ── JWT Decode Hatası ──────────────────────────────────
      // Token bozuk, formatı yanlış veya gerekli alanlar eksik
      // Sunucu çökmez, kısıtlı modda devam eder
      logger.warn('JWT decode başarısız — sadece math tool\'ları kullanılabilir');
    }
  } else {
    // ── Token Yok Senaryosu ──────────────────────────────────
    // MCP_JWT_TOKEN ortam değişkeni ayarlanmamış
    // Claude Desktop/Code ile kullanılırken bu normal olabilir
    // (kullanıcı sadece hesaplama tool'larını kullanmak isteyebilir)
    logger.info('JWT token yok — sadece math tool\'ları kullanılabilir');
  }

  // ============================================================================
  // AŞAMA 2: Tool Kayıt
  // ============================================================================
  //
  // registerAllTools fonksiyonu:
  //   - 11 tool'un ListTools ve CallTool handler'larını kaydeder
  //   - client=null ise context/intelligence tool'ları hata döner
  //   - Math tool'ları her zaman çalışır
  // ============================================================================

  registerAllTools(server, client);
  logger.info('11 tool kaydedildi (5 math + 2 context + 4 intelligence)');

  // ============================================================================
  // AŞAMA 3: Prompt Kayıt
  // ============================================================================
  //
  // MCP prompt'ları, AI'ya belirli görevleri yapması için hazır talimatlar sunar.
  // Kullanıcı bir prompt seçtiğinde, AI otomatik olarak gerekli tool'ları çağırır.
  //
  // Kayıtlı prompt'lar:
  //   - daily_operations: Günlük çiftlik brifingi
  //   - batch_review: Batch detaylı inceleme
  //
  // İki handler kaydedilir:
  //   1. ListPromptsRequestSchema → mevcut prompt'ların listesi
  //   2. GetPromptRequestSchema → seçilen prompt'un mesaj dizisi
  // ============================================================================

  // ── Prompt Tanımları Dizisi ────────────────────────────────────
  // Her prompt tanımı: { name, description, arguments }
  // ListPrompts yanıtında bu dizi döndürülür
  const prompts = [dailyOperationsPrompt, batchReviewPrompt];

  // ── ListPrompts Handler ───────────────────────────────────────
  // MCP istemcisi "prompts/list" isteği gönderdiğinde
  // tüm prompt tanımlarını döndürür.
  // Claude bu listeyi kullanıcıya gösterebilir veya
  // otomatik olarak uygun prompt'u seçebilir.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts,
  }));

  // ── GetPrompt Handler ─────────────────────────────────────────
  // MCP istemcisi "prompts/get" isteği gönderdiğinde
  // seçilen prompt'un mesajlarını döndürür.
  //
  // Akış:
  //   1. İstek parametrelerinden prompt adı ve argümanları alınır
  //   2. Prompt adına göre ilgili mesaj üretici fonksiyon çağrılır
  //   3. Üretilen mesaj dizisi { messages: [...] } formatında döner
  //   4. Bilinmeyen prompt adı → Error fırlatılır
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // ── daily_operations Prompt'u ─────────────────────────────
    // Günlük operasyon brifing — tüm çiftlik veya belirli bir site
    if (name === 'daily_operations') {
      return {
        messages: getDailyOperationsMessages(args || {}),
      };
    }

    // ── batch_review Prompt'u ─────────────────────────────────
    // Batch detaylı inceleme — olay geçmişi + anomali + risk
    if (name === 'batch_review') {
      return {
        messages: getBatchReviewMessages(args as { batchId: string; days?: string }),
      };
    }

    // ── Bilinmeyen Prompt ─────────────────────────────────────
    // İstemci var olmayan bir prompt istedi
    throw new McpError(ErrorCode.InvalidRequest, `Bilinmeyen prompt: ${name}`);
  });

  logger.info('2 prompt kaydedildi (daily_operations + batch_review)');

  // ── Hazır Server Döndürme ──────────────────────────────────────
  // Server artık tam yapılandırılmış durumda:
  //   - 11 tool kaydı (ListTools + CallTool)
  //   - 2 prompt kaydı (ListPrompts + GetPrompt)
  //   - GraphQL client (varsa)
  // Transport bağlama (stdio/sse) index.ts'de yapılacak
  return server;
}
