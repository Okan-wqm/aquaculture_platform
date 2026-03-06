/**
 * IEC 61131-3 Structured Text IDE - Frontend Tip Tanimlari
 *
 * Bu dosya ST editoru icin tum frontend tiplerini icerir:
 * - WebSocket protokol tipleri (STRequest, STResponse, STServerPush)
 * - AST node tipleri (frontend outline/problems icin basitlestirilmis)
 * - Editor state tipleri
 * - IEC 61131-3 veri tipleri ve enumlar
 * - JSON bundle tipleri
 */

// ============================================================================
// IEC 61131-3 Temel Enumlar
// ============================================================================

/** IEC 61131-3 POU (Program Organization Unit) tipleri */
export const enum POUType {
  PROGRAM = 'PROGRAM',
  FUNCTION_BLOCK = 'FUNCTION_BLOCK',
  FUNCTION = 'FUNCTION',
}

/** IEC 61131-3 veri tipleri */
export const enum STDataType {
  // Boolean
  BOOL = 'BOOL',
  // Tamsayi tipleri
  SINT = 'SINT',
  INT = 'INT',
  DINT = 'DINT',
  LINT = 'LINT',
  USINT = 'USINT',
  UINT = 'UINT',
  UDINT = 'UDINT',
  ULINT = 'ULINT',
  // Ondalik tipleri
  REAL = 'REAL',
  LREAL = 'LREAL',
  // Zaman tipleri
  TIME = 'TIME',
  DATE = 'DATE',
  TOD = 'TOD',
  DT = 'DT',
  // String
  STRING = 'STRING',
  WSTRING = 'WSTRING',
  // Bit string tipleri
  BYTE = 'BYTE',
  WORD = 'WORD',
  DWORD = 'DWORD',
  LWORD = 'LWORD',
  // Bileşik tipler
  ARRAY = 'ARRAY',
  STRUCT = 'STRUCT',
  // Jenerik tipler (IntelliSense icin)
  ANY = 'ANY',
  ANY_NUM = 'ANY_NUM',
  ANY_REAL = 'ANY_REAL',
  ANY_INT = 'ANY_INT',
  ANY_BIT = 'ANY_BIT',
  ANY_STRING = 'ANY_STRING',
  ANY_DATE = 'ANY_DATE',
}

/** Program calisma modu (IEC 61131-3 uyumlu) */
export const enum STExecutionMode {
  /** Periyodik calisma (scan cycle bazli) */
  CYCLIC = 'CYCLIC',
  /** Olay tetiklemeli calisma */
  EVENT = 'EVENT',
}

/** Degisken kapsam bloklari (IEC 61131-3) */
export const enum STVariableScope {
  VAR = 'VAR',
  VAR_INPUT = 'VAR_INPUT',
  VAR_OUTPUT = 'VAR_OUTPUT',
  VAR_IN_OUT = 'VAR_IN_OUT',
  VAR_GLOBAL = 'VAR_GLOBAL',
  VAR_TEMP = 'VAR_TEMP',
  VAR_EXTERNAL = 'VAR_EXTERNAL',
}

// ============================================================================
// WebSocket Protokol Tipleri
// ============================================================================

/** Client -> Server istek tipleri */
export type STRequestType =
  | 'analyze'
  | 'hover'
  | 'complete'
  | 'format'
  | 'outline'
  | 'definition'
  | 'references';

/** Client -> Server istek mesaji */
export interface STRequest {
  type: STRequestType;
  /** UUID v4 format */
  requestId: string;
  /** Otomasyon programinin ID'si */
  programId?: string;
  /** ST kaynak kodu (MAX_SOURCE_SIZE limitine tabi) */
  code: string;
  /** Cursor pozisyonu (0-based) */
  position?: STPosition;
  /** Incremental update icin range */
  range?: STRange;
}

/** Server -> Client cevap tipleri */
export type STResponseType =
  | 'diagnostics'
  | 'hover'
  | 'completions'
  | 'formatted'
  | 'outline'
  | 'definition'
  | 'references'
  | 'error';

/** Server -> Client cevap mesaji */
export interface STResponse {
  type: STResponseType;
  /** Eslesen requestId */
  requestId: string;
  /** Tip'e gore degisen veri */
  data: unknown;
  /** Isleme suresi (milisaniye) */
  processingTimeMs?: number;
}

/** Server -> Client proaktif bildirim tipleri */
export type STServerPushType =
  | 'diagnostics_update'
  | 'tags_changed'
  | 'fb_definitions_changed'
  | 'program_deployed'
  | 'connection_limit_warning';

/** Server -> Client proaktif bildirim mesaji */
export interface STServerPush {
  type: STServerPushType;
  data: unknown;
  /** ISO 8601 formatinda zaman damgasi */
  timestamp: string;
}

/** Hata kodlari */
export type STErrorCode =
  | 'SOURCE_TOO_LARGE'
  | 'PARSE_TIMEOUT'
  | 'WORKER_BUSY'
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'TENANT_MISMATCH'
  | 'INTERNAL_ERROR';

/** WS hata cevabi */
export interface STErrorResponse {
  type: 'error';
  requestId: string;
  error: {
    code: STErrorCode;
    message: string;
  };
}

// ============================================================================
// Diagnostics (Hata/Uyari/Bilgi)
// ============================================================================

/** Diagnostik oncelik seviyesi */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/** Diagnostik kaynagi */
export type DiagnosticSource = 'st-lexer' | 'st-parser' | 'st-semantic';

/** Pozisyon bilgisi (0-based) */
export interface STPosition {
  line: number;
  character: number;
}

/** Kaynak kodu araligi */
export interface STRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** Otomatik duzeltme onerisi */
export interface STQuickFix {
  description: string;
  newText: string;
  range: STRange;
}

/**
 * Diagnostik mesaji
 * Lexer, parser veya semantic analizden gelen hata/uyari/bilgi
 */
export interface STDiagnostic {
  /** Kaynak kodundaki konum */
  range: STRange;
  /** Oncelik seviyesi */
  severity: DiagnosticSeverity;
  /** Kullaniciya gosterilecek mesaj */
  message: string;
  /**
   * Hata kodu.
   * Format: ST{L|P|S|T}{numara}
   * L=Lexer, P=Parser, S=Semantic, T=Type
   */
  code: string;
  /** Hangi analiz asamasindan geldi */
  source: DiagnosticSource;
  /** Otomatik duzeltme onerisi (varsa) */
  fix?: STQuickFix;
}

// ============================================================================
// AST Node Tipleri (Frontend - basitlestirilmis)
// ============================================================================

/**
 * AST node tipleri - discriminated union.
 * Backend'deki tam AST'nin frontend icin sadeleştirilmiş hali.
 * Outline panel ve problems panel icin kullanilir.
 */
export type ASTNodeKind =
  | 'program'
  | 'functionBlock'
  | 'function'
  | 'varBlock'
  | 'variable'
  | 'ifStatement'
  | 'caseStatement'
  | 'forLoop'
  | 'whileLoop'
  | 'repeatLoop'
  | 'assignment'
  | 'fbCall'
  | 'functionCall'
  | 'returnStatement'
  | 'exitStatement'
  | 'expression'
  | 'arrayType'
  | 'structType'
  | 'enumType';

/** Temel AST node */
export interface ASTNodeBase {
  kind: ASTNodeKind;
  /** Kaynak kodundaki konum */
  range: STRange;
  /** Alt dugumler */
  children?: ASTNode[];
}

/** POU (Program/FB/Function) dugumu */
export interface ASTPOUNode extends ASTNodeBase {
  kind: 'program' | 'functionBlock' | 'function';
  name: string;
  returnType?: string;
}

/** Degisken blok dugumu (VAR, VAR_INPUT, vb.) */
export interface ASTVarBlockNode extends ASTNodeBase {
  kind: 'varBlock';
  scope: STVariableScope;
}

/** Degisken tanimlama dugumu */
export interface ASTVariableNode extends ASTNodeBase {
  kind: 'variable';
  name: string;
  dataType: string;
  initialValue?: string;
}

/** If deyimi dugumu */
export interface ASTIfNode extends ASTNodeBase {
  kind: 'ifStatement';
}

/** Case deyimi dugumu */
export interface ASTCaseNode extends ASTNodeBase {
  kind: 'caseStatement';
  selectorExpr?: string;
}

/** For dongusu dugumu */
export interface ASTForLoopNode extends ASTNodeBase {
  kind: 'forLoop';
  variable?: string;
}

/** While dongusu dugumu */
export interface ASTWhileLoopNode extends ASTNodeBase {
  kind: 'whileLoop';
}

/** Repeat dongusu dugumu */
export interface ASTRepeatLoopNode extends ASTNodeBase {
  kind: 'repeatLoop';
}

/** Atama deyimi dugumu */
export interface ASTAssignmentNode extends ASTNodeBase {
  kind: 'assignment';
  target?: string;
}

/** Function block cagri dugumu */
export interface ASTFBCallNode extends ASTNodeBase {
  kind: 'fbCall';
  instanceName?: string;
  fbTypeName?: string;
}

/** Fonksiyon cagri dugumu */
export interface ASTFunctionCallNode extends ASTNodeBase {
  kind: 'functionCall';
  functionName?: string;
}

/** Return deyimi dugumu */
export interface ASTReturnNode extends ASTNodeBase {
  kind: 'returnStatement';
}

/** Exit deyimi dugumu */
export interface ASTExitNode extends ASTNodeBase {
  kind: 'exitStatement';
}

/** Expression dugumu */
export interface ASTExpressionNode extends ASTNodeBase {
  kind: 'expression';
}

/** Array tipi dugumu */
export interface ASTArrayTypeNode extends ASTNodeBase {
  kind: 'arrayType';
  elementType?: string;
  dimensions?: string;
}

/** Struct tipi dugumu */
export interface ASTStructTypeNode extends ASTNodeBase {
  kind: 'structType';
  name: string;
}

/** Enum tipi dugumu */
export interface ASTEnumTypeNode extends ASTNodeBase {
  kind: 'enumType';
  name: string;
}

/** Tum AST node discriminated union'i */
export type ASTNode =
  | ASTPOUNode
  | ASTVarBlockNode
  | ASTVariableNode
  | ASTIfNode
  | ASTCaseNode
  | ASTForLoopNode
  | ASTWhileLoopNode
  | ASTRepeatLoopNode
  | ASTAssignmentNode
  | ASTFBCallNode
  | ASTFunctionCallNode
  | ASTReturnNode
  | ASTExitNode
  | ASTExpressionNode
  | ASTArrayTypeNode
  | ASTStructTypeNode
  | ASTEnumTypeNode;

// ============================================================================
// Editor State Tipleri
// ============================================================================

/** Outline agaci dugum tipi (sol panel icin) */
export interface STOutlineNode {
  /** Benzersiz dugum kimlik */
  id: string;
  /** Gosterilecek etiket */
  label: string;
  /** Ikon tipi (lucide-react ikon adi) */
  icon: STOutlineIcon;
  /** Kaynak kodundaki satir (tiklandiginda navigate icin) */
  line: number;
  /** Karakter offset */
  character?: number;
  /** Alt dugumler */
  children?: STOutlineNode[];
  /** Ek bilgi (ornegin tip bilgisi) */
  detail?: string;
}

/** Outline dugum ikon tipleri */
export type STOutlineIcon =
  | 'box'           // PROGRAM
  | 'boxes'         // FUNCTION_BLOCK
  | 'function'      // FUNCTION
  | 'braces'        // VAR block
  | 'variable'      // variable
  | 'git-branch'    // IF/CASE
  | 'repeat'        // FOR/WHILE/REPEAT
  | 'type'          // TYPE/STRUCT/ENUM
  | 'play'          // FB instance
  | 'arrow-right';  // assignment

/** Problems panel'deki tek bir problem kaydi */
export interface STProblem {
  /** Diagnostik bilgisi */
  diagnostic: STDiagnostic;
  /** Dosya/program adi */
  source: string;
}

/** Derleme sonucu */
export interface STCompileResult {
  /** Derleme basarili mi */
  success: boolean;
  /** Diagnostikler */
  diagnostics: STDiagnostic[];
  /** Hata sayisi */
  errorCount: number;
  /** Uyari sayisi */
  warningCount: number;
  /** Derleme suresi (ms) */
  compileTimeMs: number;
}

/** WS baglanti durumu */
export type STConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** ST Editor ana state'i */
export interface STEditorState {
  /** Aktif program ID */
  programId: string | null;
  /** Kaynak kod (Monaco'dan) */
  code: string;
  /** Son kaydedilen kod (dirty check icin) */
  savedCode: string;
  /** Derleme sonucu */
  compileResult: STCompileResult | null;
  /** Mevcut diagnostikler */
  diagnostics: STDiagnostic[];
  /** Outline agaci */
  outline: STOutlineNode[];
  /** WS baglanti durumu */
  connectionStatus: STConnectionStatus;
  /** Son WS istek suresi */
  lastRequestTimeMs: number | null;
  /** Derleme devam ediyor mu */
  isCompiling: boolean;
  /** Formatlama devam ediyor mu */
  isFormatting: boolean;
  /** Kod degistirildi mi (kaydedilmemis) */
  isDirty: boolean;
}

// ============================================================================
// Hover & Completion Tipleri
// ============================================================================

/** Hover bilgisi (tooltip icin) */
export interface STHoverInfo {
  /** Markdown icerik */
  contents: string;
  /** Vurgulanacak range */
  range?: STRange;
}

/** Completion item tipi */
export type STCompletionKind =
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
export interface STCompletionItem {
  /** Gosterilecek etiket */
  label: string;
  /** Completion tipi */
  kind: STCompletionKind;
  /** Detay bilgi (tip, imza vb.) */
  detail?: string;
  /** Aciklama (markdown) */
  documentation?: string;
  /** Eklenecek metin */
  insertText: string;
  /** Snippet mi (tab stop'lar var mi) */
  isSnippet?: boolean;
  /** Siralama onceligi (dusuk = once) */
  sortOrder?: number;
}

/** Go-to-definition sonucu */
export interface STDefinitionLocation {
  /** Hedef program ID */
  programId?: string;
  /** Hedef dosyadaki range */
  range: STRange;
}

/** Find references sonucu */
export interface STReferenceLocation {
  programId?: string;
  range: STRange;
  /** Referans tipi */
  kind: 'definition' | 'read' | 'write';
}

// ============================================================================
// JSON Bundle Tipleri (v2)
// ============================================================================

/** Bundle meta bilgisi */
export interface STBundleExportInfo {
  platform: string;
  version: string;
}

/** Bundle degisken tanimlari */
export interface STBundleVariable {
  varName: string;
  displayName?: string;
  dataType: string;
  scope: string;
  initialValue?: string;
  description?: string;
  ioConfigId?: string;
  ioTagName?: string;
  engUnit?: string;
  minValue?: number;
  maxValue?: number;
  alarmHH?: number;
  alarmH?: number;
  alarmL?: number;
  alarmLL?: number;
}

/** Bundle program tanimlari */
export interface STBundleProgram {
  programCode: string;
  programName: string;
  programType: string;
  executionMode: string;
  scanCycleMs: number;
  minScanCycleMs?: number;
  structuredTextCode: string;
  description?: string;
  category?: string;
}

/** Bundle SFC adim tanimlari */
export interface STBundleStep {
  stepCode: string;
  stepName: string;
  type: string;
  positionX: number;
  positionY: number;
  entryAction?: string;
  exitAction?: string;
  timeoutMs?: number;
  onTimeout?: string;
}

/** Bundle SFC gecis tanimlari */
export interface STBundleTransition {
  transitionCode: string;
  fromStepCode: string;
  toStepCode: string;
  condition: string;
  priority: number;
}

/**
 * JSON Bundle v2 format.
 * Import/export icin kullanilan seri hale getirilmis program formati.
 * deployConfig alani v2'de kaldirildi (SSRF vektoru).
 */
export interface STBundle {
  $schema: string;
  bundleVersion: '2.0';
  schemaVersion: '2.0';
  /** ISO 8601 formatinda export zamani */
  exportedAt: string;
  /** Export eden kullanici e-posta'si */
  exportedBy: string;
  /** Platform bilgisi */
  exportedFrom: STBundleExportInfo;
  /** Program tanimlari */
  program: STBundleProgram;
  /** Degisken tanimlari */
  variables: STBundleVariable[];
  /** SFC adimlari (varsa) */
  steps: STBundleStep[];
  /** SFC gecisleri (varsa) */
  transitions: STBundleTransition[];
}

// ============================================================================
// WS Baglanti Konfigurasyonu
// ============================================================================

/** WebSocket baglanti secenekleri */
export interface STWebSocketConfig {
  /** JWT token */
  token: string;
  /** Yeniden baglanti denemesi sayisi */
  reconnectionAttempts: number;
  /** Minimum bekleme suresi (ms) */
  reconnectionDelay: number;
  /** Maksimum bekleme suresi (ms) */
  reconnectionDelayMax: number;
}

/** Varsayilan WS konfigurasyonu */
export const ST_WS_DEFAULTS: STWebSocketConfig = {
  token: '',
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
};

/** Debounce suresi (ms) - kullanici yazarken WS isteği gondermeden once bekleme */
export const ST_DEBOUNCE_MS = 300;
