// ============================================================================
// MCP Farm Intelligence Server — Prompt Kayıt Modülü
// ============================================================================
//
// Tüm MCP prompt'larını tek noktadan dışa aktarır.
//
// NASIL ÇALIŞIR:
//   1. Her prompt kendi dosyasında tanımlanır (prompt tanımı + mesaj üretici fonksiyon)
//   2. Bu modül hepsini re-export eder
//   3. server.ts bu modülü import ederek prompt'ları MCP server'a kaydeder
//
// MEVCUT PROMPT'LAR:
//   - daily_operations: Günlük operasyon brifingi (çiftlik/site bazında)
//   - batch_review: Batch detaylı inceleme (360 derece analiz)
//
// YENİ PROMPT EKLEMEK İÇİN:
//   1. src/prompts/ altına yeni dosya oluşturun (örn: harvest-planning.ts)
//   2. promptDefinition ve getMessages fonksiyonunu export edin
//   3. Bu dosyaya re-export satırı ekleyin
//   4. server.ts'deki prompt kayıt bloğuna yeni prompt'u ekleyin
// ============================================================================

// ── Günlük Operasyon Brifing Prompt'u ────────────────────────────
// Çiftliğin genel durumu, anomaliler, riskler ve öncelikli aksiyonlar
export { dailyOperationsPrompt, getDailyOperationsMessages } from './daily-operations.js';

// ── Batch İnceleme Prompt'u ──────────────────────────────────────
// Geçmiş olaylar, anomaliler, korelasyonlar ve risk değerlendirmesi
export { batchReviewPrompt, getBatchReviewMessages } from './batch-review.js';
