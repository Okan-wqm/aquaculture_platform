// ============================================================================
// MCP Farm Intelligence Server — Giriş Noktası (Entry Point)
// ============================================================================
//
// Uygulamanın başlangıç dosyası — konfigürasyon, server ve transport kurulumu.
//
// NASIL ÇALIŞIR:
//   1. Konfigürasyon yüklenir (ortam değişkenleri veya varsayılanlar)
//   2. Global log seviyesi ayarlanır
//   3. MCP server oluşturulur (tool'lar + prompt'lar kaydedilir)
//   4. Transport moduna göre bağlantı kurulur:
//      - stdio: stdin/stdout üzerinden JSON-RPC (Claude Desktop/Code uyumlu)
//      - sse: HTTP Server-Sent Events endpoint (web entegrasyonu)
//   5. Server istekleri dinlemeye başlar
//
// TRANSPORT MODLARI:
//   stdio (varsayılan):
//     - Claude Desktop ve Claude Code ile entegrasyon
//     - stdin'den istek okur, stdout'a yanıt yazar
//     - stderr'e log mesajları yazar (stdout MCP protokolü için ayrılmış)
//     - Tek kullanıcı, tek session
//
//   sse (deneysel):
//     - Web tarayıcı entegrasyonu için tasarlanmış
//     - HTTP SSE endpoint üzerinden çalışır
//     - Henüz tam desteklenmiyor — geliştirme aşamasında
//
// KULLANIM:
//   # Varsayılan (stdio modu):
//   node dist/index.js
//
//   # SSE modu (deneysel):
//   MCP_TRANSPORT=sse MCP_PORT=3009 node dist/index.js
//
//   # Geliştirme modu:
//   npm run dev
//
//   # JWT token ile:
//   MCP_JWT_TOKEN="eyJ..." node dist/index.js
//
// ORTAM DEĞİŞKENLERİ:
//   GATEWAY_URL — GraphQL Gateway adresi (varsayılan: http://localhost:3000/graphql)
//   MCP_JWT_TOKEN — JWT Bearer token (opsiyonel — yoksa sadece math tool'ları çalışır)
//   MCP_TRANSPORT — Transport modu: 'stdio' (varsayılan) veya 'sse'
//   MCP_PORT — SSE modu port (varsayılan: 3009)
//   MCP_LOG_LEVEL — Log seviyesi: debug, info, warn, error (varsayılan: info)
//   MCP_REQUEST_TIMEOUT — GraphQL istek timeout (ms, varsayılan: 30000)
// ============================================================================

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { createMcpServer } from './server.js';
import { setLogLevel } from './utils/logger.js';

// ── Ana Fonksiyon ─────────────────────────────────────────────────
/**
 * Uygulama giriş noktası — server'ı başlatır.
 *
 * NASIL ÇALIŞIR:
 *   1. loadConfig() → ortam değişkenlerinden konfigürasyon yüklenir
 *   2. setLogLevel() → global log seviyesi ayarlanır
 *   3. createMcpServer() → tool ve prompt'lar kaydedilir
 *   4. Transport'a göre bağlantı kurulur (stdio veya sse)
 *   5. Server istek dinlemeye başlar
 *
 * Hata durumunda process.exit(1) ile çıkılır.
 */
async function main(): Promise<void> {
  // ── Konfigürasyon Yükleme ────────────────────────────────────
  // Ortam değişkenleri okunur, tanımlı olmayanlar için varsayılanlar kullanılır
  // McpConfig nesnesi oluşturulur: gatewayUrl, jwtToken, transport, port, logLevel, requestTimeout
  const config = loadConfig();

  // ── Log Seviyesi Ayarlama ────────────────────────────────────
  // Global log seviyesi tüm logger instance'larını etkiler
  // Örnek: 'warn' → sadece warn ve error mesajları görünür
  setLogLevel(config.logLevel);

  // ── MCP Server Oluşturma ─────────────────────────────────────
  // Server oluşturulur, tool'lar ve prompt'lar kaydedilir
  // JWT varsa GraphQL client de oluşturulur
  const server = createMcpServer(config);

  // ── Transport Bağlama ────────────────────────────────────────
  // Transport moduna göre server'ı uygun iletişim kanalına bağlar
  if (config.transport === 'stdio') {
    // ── stdio Transport ─────────────────────────────────────
    // StdioServerTransport: stdin'den JSON-RPC oku, stdout'a yaz
    //
    // Claude Desktop/Code bu modu kullanır:
    //   Claude → stdin'e JSON-RPC isteği yazar
    //   Server → stdout'a JSON-RPC yanıtı yazar
    //
    // DİKKAT: console.log() KULLANMAYIN!
    //   stdout MCP protokolü için ayrılmıştır.
    //   Log mesajları stderr'e yazılmalıdır (console.error).
    //   Logger modülü console.error kullanır — güvenlidir.
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // stderr'e yaz — stdout MCP JSON-RPC için ayrılmış durumda
    console.error('Farm Intelligence MCP Server başlatıldı (stdio modu)');

  } else if (config.transport === 'sse') {
    // ── SSE Transport (Deneysel) ─────────────────────────────
    // Server-Sent Events üzerinden MCP iletişimi
    //
    // KULLANIM SENARYOSU:
    //   Web tarayıcıdaki bir chat arayüzünden MCP server'a bağlanma
    //   HTTP SSE endpoint üzerinden gerçek zamanlı yanıt akışı
    //
    // DURUM: Henüz tam uygulanmadı
    //   SSE transport implementasyonu SDK versiyonuna bağlı olarak değişebilir.
    //   Şu an stdio modu önerilir.
    //
    // GELECEK PLANI:
    //   1. Express veya http.createServer ile SSE endpoint oluştur
    //   2. SSEServerTransport ile MCP server'ı bağla
    //   3. CORS ve authentication middleware ekle
    //   4. Health check endpoint ekle (/health)

    console.error(`Farm Intelligence MCP Server başlatıldı (SSE modu, port: ${config.port})`);
    console.error('SSE modu henüz tam desteklenmiyor — stdio kullanın');
    process.exit(1);
  }
}

// ── Uygulama Başlatma ─────────────────────────────────────────────
// main() async fonksiyondur — Promise reject olursa hata loglanır ve çıkılır
// Bu pattern Node.js'te async entry point için standart yaklaşımdır
main().catch((error) => {
  console.error('Server başlatma hatası:', error);
  process.exit(1);
});
