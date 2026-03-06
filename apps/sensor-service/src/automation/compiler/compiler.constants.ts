/**
 * ST Compiler - Sabitler ve Guvenlik Limitleri
 *
 * IEC 61131-3 Structured Text parser, worker thread pool
 * ve WebSocket gateway icin tum sabit degerleri icerir.
 */

// ============================================================================
// Parser Guvenlik Limitleri (Plan Bolum 9.1.2)
// ============================================================================

/** Maksimum kaynak kod boyutu (byte) — 100 KB */
export const MAX_SOURCE_SIZE = 100 * 1024;

/** Maksimum AST/nesting derinligi (seviye) */
export const MAX_AST_DEPTH = 50;

/** Parse timeout suresi (milisaniye) */
export const PARSE_TIMEOUT_MS = 5_000;

/** Maksimum diagnostik sayisi (asiminda parse durur) */
export const MAX_DIAGNOSTICS = 100;

/** Maksimum token sayisi (lexer asiminda durur) */
export const MAX_TOKEN_COUNT = 500_000;

/** Maksimum hata sayisi (asiminda "too many errors" ile durur) */
export const MAX_ERRORS = 100;

// ============================================================================
// WebSocket Limitleri (Plan Bolum 4.3.5)
// ============================================================================

/** Tenant basina maksimum eszamanli WS baglanti */
export const WS_MAX_CONNECTIONS_PER_TENANT = 5;

/** Baglanti basina maksimum mesaj/saniye */
export const WS_MAX_MESSAGES_PER_SECOND = 10;

/** Tenant basina maksimum mesaj/dakika */
export const WS_MAX_MESSAGES_PER_MINUTE = 100;

/** Maksimum WS mesaj boyutu (byte) — 150 KB */
export const WS_MAX_MESSAGE_SIZE = 150 * 1024;

/** Bos baglanti timeout suresi (milisaniye) — 5 dakika */
export const WS_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// Worker Thread Pool Ayarlari
// ============================================================================

/** Worker thread havuz boyutu (CPU cekirdek sayisina gore ayarlanir) */
export const WORKER_POOL_MIN_THREADS = 1;

/** Maksimum worker thread sayisi */
export const WORKER_POOL_MAX_THREADS = 4;

/** Worker idle timeout (milisaniye) */
export const WORKER_IDLE_TIMEOUT_MS = 30_000;

/** Tek bir worker task'in maksimum calisma suresi (milisaniye) */
export const WORKER_TASK_TIMEOUT_MS = 10_000;

// ============================================================================
// NATS Subject Tanimlari (Plan Bolum 4.6)
// ============================================================================

/** NATS subject'leri - request-reply (gateway-api -> sensor-service) */
export const NATS_SUBJECTS = {
  /** Parse + semantic analiz */
  ANALYZE: 'st.language.analyze',
  /** IntelliSense onerileri */
  COMPLETE: 'st.language.complete',
  /** Hover tooltip bilgisi */
  HOVER: 'st.language.hover',
  /** Kod formatlama */
  FORMAT: 'st.language.format',
  /** Outline (document symbols) */
  OUTLINE: 'st.language.outline',
  /** Go-to-definition */
  DEFINITION: 'st.language.definition',
  /** Find references */
  REFERENCES: 'st.language.references',
} as const;

/** NATS request timeout'lari (milisaniye) */
export const NATS_TIMEOUTS = {
  /** Analyze request timeout */
  [NATS_SUBJECTS.ANALYZE]: 10_000,
  /** Complete request timeout */
  [NATS_SUBJECTS.COMPLETE]: 3_000,
  /** Hover request timeout */
  [NATS_SUBJECTS.HOVER]: 3_000,
  /** Format request timeout */
  [NATS_SUBJECTS.FORMAT]: 5_000,
  /** Outline request timeout */
  [NATS_SUBJECTS.OUTLINE]: 5_000,
  /** Definition request timeout */
  [NATS_SUBJECTS.DEFINITION]: 3_000,
  /** References request timeout */
  [NATS_SUBJECTS.REFERENCES]: 5_000,
} as const;

/** NATS event subject'leri (sensor-service -> diger servisler) */
export const NATS_EVENTS = {
  /** Program kaydedildiginde (diagnostics tekrar calistirilir) */
  PROGRAM_SAVED: 'events.AutomationProgramSaved',
  /** Program PLC'ye deploy edildiginde */
  PROGRAM_DEPLOYED: 'events.AutomationProgramDeployed',
  /** SCADA tag'leri degistiginde (IntelliSense cache invalidation) */
  TAGS_UPDATED: 'events.AutomationTagsUpdated',
  /** Function Block tanimlari degistiginde */
  FB_DEFINITIONS_CHANGED: 'events.AutomationFBDefinitionsChanged',
} as const;

/**
 * Tenant-scoped NATS event subject'i olusturur.
 * Ornek: buildEventSubject('events.AutomationProgramSaved', 'tenant-123')
 *        → 'events.AutomationProgramSaved.tenant-123'
 */
export function buildEventSubject(baseSubject: string, tenantId: string): string {
  return `${baseSubject}.${tenantId}`;
}

// ============================================================================
// IEC 61131-3 Scan Cycle Limitleri
// ============================================================================

/** Minimum scan cycle suresi (milisaniye) */
export const MIN_SCAN_CYCLE_MS = 1;

/** Varsayilan scan cycle suresi (milisaniye) */
export const DEFAULT_SCAN_CYCLE_MS = 100;

/** Maksimum scan cycle suresi (milisaniye) */
export const MAX_SCAN_CYCLE_MS = 60_000;

// ============================================================================
// JSON Bundle Limitleri
// ============================================================================

/** Maksimum JSON bundle boyutu (byte) — 1 MB */
export const MAX_BUNDLE_SIZE = 1 * 1024 * 1024;

/** Desteklenen bundle versiyonu */
export const SUPPORTED_BUNDLE_VERSION = '2.0';

/** Bundle schema URL */
export const BUNDLE_SCHEMA_URL = 'https://suderra.com/schemas/automation-bundle-v2.json';

// ============================================================================
// Performans Hedefleri (referans, enforce edilmez)
// ============================================================================

/** Lexer throughput hedefi: 100KB < 200ms */
export const PERF_LEXER_TARGET_MS = 200;

/** Parser throughput hedefi: 100KB < 500ms */
export const PERF_PARSER_TARGET_MS = 500;

/** Semantic analysis hedefi: 100KB < 1s */
export const PERF_SEMANTIC_TARGET_MS = 1_000;

/** WS round-trip hedefi (p95): < 500ms */
export const PERF_WS_ROUNDTRIP_TARGET_MS = 500;

/** IntelliSense latency hedefi (p95): < 200ms */
export const PERF_INTELLISENSE_TARGET_MS = 200;
