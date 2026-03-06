/**
 * ST Compiler - Backend Tip Tanimlari
 *
 * Worker thread input/output, NATS mesaj, derleme sonuc
 * ve dahili parser tipleri icin kullanilir.
 */

// ============================================================================
// Diagnostik Tipleri (Backend)
// ============================================================================

/** Diagnostik oncelik seviyesi */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/** Diagnostik kaynagi */
export type DiagnosticSource = 'st-lexer' | 'st-parser' | 'st-semantic';

/** Kaynak kodu konum araligi (0-based) */
export interface SourceRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** Otomatik duzeltme onerisi */
export interface QuickFix {
  description: string;
  newText: string;
  range: SourceRange;
}

/** Diagnostik mesaji */
export interface Diagnostic {
  range: SourceRange;
  severity: DiagnosticSeverity;
  message: string;
  /**
   * Hata kodu.
   * Format: ST{L|P|S|T}{numara}
   * L=Lexer, P=Parser, S=Semantic, T=Type
   */
  code: string;
  source: DiagnosticSource;
  fix?: QuickFix;
}

// ============================================================================
// Worker Thread Tipleri
// ============================================================================

/** Worker'a gonderilen istek tipi */
export type WorkerTaskType =
  | 'analyze'
  | 'complete'
  | 'hover'
  | 'format'
  | 'outline'
  | 'definition'
  | 'references';

/** Worker thread giris verisi */
export interface WorkerInput {
  /** Istek tipi */
  taskType: WorkerTaskType;
  /** ST kaynak kodu */
  code: string;
  /** Tenant ID (izolasyon icin) */
  tenantId: string;
  /** Program ID */
  programId?: string;
  /** Cursor pozisyonu (hover, complete, definition icin) */
  position?: { line: number; character: number };
  /** Guvenlik limitleri (constants'tan aktarilir) */
  limits: WorkerLimits;
}

/** Worker'a aktarilan guvenlik limitleri */
export interface WorkerLimits {
  maxSourceSize: number;
  maxAstDepth: number;
  parseTimeoutMs: number;
  maxDiagnostics: number;
  maxTokenCount: number;
  maxErrors: number;
}

/** Worker thread cikis verisi - analyze */
export interface WorkerAnalyzeResult {
  taskType: 'analyze';
  success: boolean;
  diagnostics: Diagnostic[];
  /** Basitlestirilmis AST (outline icin) */
  outline?: OutlineNode[];
  /** Isleme suresi (ms) */
  processingTimeMs: number;
}

/** Worker thread cikis verisi - complete */
export interface WorkerCompleteResult {
  taskType: 'complete';
  success: boolean;
  completions: CompletionEntry[];
  processingTimeMs: number;
}

/** Worker thread cikis verisi - hover */
export interface WorkerHoverResult {
  taskType: 'hover';
  success: boolean;
  contents?: string;
  range?: SourceRange;
  processingTimeMs: number;
}

/** Worker thread cikis verisi - format */
export interface WorkerFormatResult {
  taskType: 'format';
  success: boolean;
  formattedCode?: string;
  processingTimeMs: number;
}

/** Worker thread cikis verisi - outline */
export interface WorkerOutlineResult {
  taskType: 'outline';
  success: boolean;
  outline: OutlineNode[];
  processingTimeMs: number;
}

/** Worker thread cikis verisi - definition */
export interface WorkerDefinitionResult {
  taskType: 'definition';
  success: boolean;
  location?: DefinitionLocation;
  processingTimeMs: number;
}

/** Worker thread cikis verisi - references */
export interface WorkerReferencesResult {
  taskType: 'references';
  success: boolean;
  references: ReferenceLocation[];
  processingTimeMs: number;
}

/** Worker thread cikis verisi discriminated union */
export type WorkerOutput =
  | WorkerAnalyzeResult
  | WorkerCompleteResult
  | WorkerHoverResult
  | WorkerFormatResult
  | WorkerOutlineResult
  | WorkerDefinitionResult
  | WorkerReferencesResult;

/** Worker hata sonucu */
export interface WorkerError {
  code: string;
  message: string;
}

// ============================================================================
// Outline (Document Symbols)
// ============================================================================

/** Outline dugum tipi */
export type OutlineNodeKind =
  | 'program'
  | 'functionBlock'
  | 'function'
  | 'varBlock'
  | 'variable'
  | 'struct'
  | 'enum'
  | 'method'
  | 'property';

/** Outline dugumu */
export interface OutlineNode {
  name: string;
  kind: OutlineNodeKind;
  range: SourceRange;
  detail?: string;
  children?: OutlineNode[];
}

// ============================================================================
// Completion (IntelliSense)
// ============================================================================

/** Completion girdi tipi */
export type CompletionEntryKind =
  | 'keyword'
  | 'function'
  | 'functionBlock'
  | 'variable'
  | 'type'
  | 'snippet'
  | 'tag'
  | 'constant'
  | 'operator';

/** Completion onerisi */
export interface CompletionEntry {
  label: string;
  kind: CompletionEntryKind;
  detail?: string;
  documentation?: string;
  insertText: string;
  isSnippet?: boolean;
  sortOrder?: number;
}

// ============================================================================
// Definition & References
// ============================================================================

/** Go-to-definition sonucu */
export interface DefinitionLocation {
  programId?: string;
  range: SourceRange;
}

/** Find references sonucu */
export interface ReferenceLocation {
  programId?: string;
  range: SourceRange;
  kind: 'definition' | 'read' | 'write';
}

// ============================================================================
// NATS Mesaj Tipleri
// ============================================================================

/** NATS request header'inda tasınan tenant bilgisi */
export interface NatsRequestHeaders {
  'x-tenant-id': string;
  'x-user-id'?: string;
  'x-request-id'?: string;
}

/** NATS request payload (gateway-api -> sensor-service) */
export interface NatsLanguageRequest {
  /** Istek tipi */
  type: WorkerTaskType;
  /** Orijinal WS request ID (izleme icin) */
  requestId: string;
  /** Otomasyon program ID */
  programId?: string;
  /** ST kaynak kodu */
  code: string;
  /** Cursor pozisyonu */
  position?: { line: number; character: number };
}

/** NATS reply payload (sensor-service -> gateway-api) */
export interface NatsLanguageReply {
  /** Basarili mi */
  success: boolean;
  /** Orijinal request ID */
  requestId: string;
  /** Cevap tipi */
  type: string;
  /** Cevap verisi (tip'e gore degisir) */
  data: unknown;
  /** Isleme suresi (ms) */
  processingTimeMs?: number;
  /** Hata bilgisi (basarisizsa) */
  error?: WorkerError;
}

/** NATS event payload — program kaydedildi */
export interface NatsEventProgramSaved {
  tenantId: string;
  programId: string;
  programCode: string;
  version: number;
  savedBy: string;
  savedAt: string;
}

/** NATS event payload — program deploy edildi */
export interface NatsEventProgramDeployed {
  tenantId: string;
  programId: string;
  programCode: string;
  version: number;
  deployedBy: string;
  deployedAt: string;
  targetDevice?: string;
}

/** NATS event payload — SCADA tag'leri guncellendi */
export interface NatsEventTagsUpdated {
  tenantId: string;
  /** Eklenen tag ID'leri */
  added?: string[];
  /** Silinen tag ID'leri */
  removed?: string[];
  /** Guncellenen tag ID'leri */
  updated?: string[];
}

/** NATS event payload — FB tanimlari degisti */
export interface NatsEventFBDefinitionsChanged {
  tenantId: string;
  /** Eklenen/guncellenen FB isimleri */
  changedFBs: string[];
}

// ============================================================================
// Compiler Service Interface Tipleri (Faz 2 hazirligi)
// ============================================================================

/** Derleme istegi */
export interface CompileRequest {
  tenantId: string;
  programId: string;
  code: string;
  /** Hedef platform */
  targetPlatform?: 'linux_x86' | 'linux_arm' | 'simulation';
}

/** Derleme sonucu */
export interface CompileResult {
  success: boolean;
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  compileTimeMs: number;
  /** Derlenmis artifact (Faz 2 - Codesys boot application) */
  artifactId?: string;
  artifactSize?: number;
}

/** Deploy istegi */
export interface DeployRequest {
  tenantId: string;
  programId: string;
  artifactId: string;
  targetAddress: string;
  targetPort: number;
  /** Onaylayan kullanici ID'leri (dual-approval) */
  approvedBy: [string, string];
}

/** Deploy sonucu */
export interface DeployResult {
  success: boolean;
  deployedAt: string;
  message?: string;
  /** Geri alma icin onceki versiyon bilgisi */
  previousVersion?: number;
}
