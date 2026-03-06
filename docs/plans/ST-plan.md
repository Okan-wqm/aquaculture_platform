# IEC 61131-3 Structured Text IDE - Design & Implementation Plan

**Tarih:** 2026-03-06
**Sayfa:** `/sensor/automation/new` → ST Code tab
**Yaklaşım:** Aşamalı (Faz 1: Editör + Parser, Faz 2: Codesys Entegrasyonu)

---

## 1. Genel Bakış

Mevcut Monaco-based ST editörünü ultra-profesyonel bir IEC 61131-3 IDE deneyimine yükseltiyoruz:

- IntelliSense (keyword + değişken + SCADA tag + cross-program FB referansları)
- LSP-style WebSocket diagnostics (backend ST parser)
- JSON bundle save/load/export/import
- Codesys Automation Server entegrasyonu için hazır interface

## 2. Mimari

```
┌─────────────────────────────────────────────────────────────┐
│  BROWSER (Frontend - sensor-module)                         │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Monaco Editor (ST Code Tab - tam IDE)                   ││
│  │ - STCompletionProvider (IntelliSense)                   ││
│  │ - STHoverProvider (tip/doku bilgisi)                    ││
│  │ - STDiagnosticsProvider (hata işaretleri)               ││
│  │ - STFormattingProvider (auto format)                    ││
│  │ - STSnippetProvider (kod şablonları)                    ││
│  │ - STOutlinePanel (sol panel, AST ağacı)                 ││
│  │ - STProblemsPanel (alt panel, diagnostics)              ││
│  │ - STEditorToolbar (üst bar)                             ││
│  └────────────────────────┬────────────────────────────────┘│
│                           │ WebSocket (wss://)              │
└───────────────────────────┼─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  BACKEND (sensor-service / NestJS)                          │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ ST Language Service (WebSocket Gateway)                  ││
│  │ ┌─────────┐  ┌──────────┐  ┌──────────────────────────┐││
│  │ │  Lexer  │→│  Parser  │→│  Semantic Analyzer        │││
│  │ │ (tokens)│  │  (AST)   │  │ (type check, scope)      │││
│  │ └─────────┘  └──────────┘  └──────────────────────────┘││
│  └────────────────────────┬────────────────────────────────┘│
│  ┌────────────────────────▼────────────────────────────────┐│
│  │ ICompilerService (Faz 1: mock, Faz 2: Codesys client)   ││
│  └────────────────────────┬────────────────────────────────┘│
└───────────────────────────┼─────────────────────────────────┘
                            │ REST API (Faz 2)
┌───────────────────────────▼─────────────────────────────────┐
│  CODESYS AUTOMATION SERVER  (ayrı Linux sunucu)             │
│  - ST source → derlenmiş boot application                   │
│  - Target-specific compilation (ARM/x86)                    │
│  - Codesys Gateway → PLC runtime'lara deploy                │
└───────────────────────────┬─────────────────────────────────┘
                            │ TCP/IP
┌───────────────────────────▼─────────────────────────────────┐
│  PLC'LER (sahada - Linux tabanlı)                           │
│  - CODESYS Control for Linux SL (x86)                       │
│  - CODESYS Control for Linux ARM SL (ARM)                   │
│  - Runtime derlenmiş kodu çalıştırır                        │
└─────────────────────────────────────────────────────────────┘
```

## 3. Bileşen Yapısı

### 3.1 Frontend (sensor-module)

```
web/modules/sensor-module/src/
├── components/automation/
│   ├── st-editor/
│   │   ├── STEditorContainer.tsx      # Ana container (layout yönetimi)
│   │   ├── STEditorToolbar.tsx        # [Save][Validate][Format][Export][Import]
│   │   ├── STOutlinePanel.tsx         # Sol panel - AST ağaç yapısı
│   │   ├── STProblemsPanel.tsx        # Alt panel - errors/warnings/info
│   │   ├── STMonacoEditor.tsx         # Monaco wrapper + providers
│   │   └── providers/
│   │       ├── st-language.ts         # Geliştirilmiş dil tanımı
│   │       ├── st-completion.ts       # IntelliSense provider
│   │       ├── st-hover.ts            # Hover info provider
│   │       ├── st-diagnostics.ts      # Marker yönetimi
│   │       ├── st-formatting.ts      # Code formatter
│   │       ├── st-snippets.ts         # Kod şablonları
│   │       ├── st-definition.ts       # Go to definition
│   │       ├── st-references.ts       # Find references
│   │       └── st-symbols.ts          # Document symbols (outline)
│   ├── json-bundle/
│   │   ├── ExportDialog.tsx           # JSON export dialog
│   │   ├── ImportDialog.tsx           # JSON import dialog
│   │   └── bundle.utils.ts           # Serialize/deserialize
│   └── STEditor.tsx                   # KALDIRILACAK (yeni STEditorContainer ile değiştirilecek)
├── hooks/
│   └── useSTLanguageService.ts        # WebSocket bağlantısı hook'u
├── services/
│   └── st-websocket.service.ts        # WebSocket client
└── types/
    └── st-editor.types.ts             # Editor tipleri
```

### 3.2 Backend (sensor-service)

```
apps/sensor-service/src/automation/
├── compiler/
│   ├── lexer/
│   │   ├── st-lexer.ts               # Source → Token stream
│   │   ├── st-tokens.ts              # Token enum tanımları
│   │   └── st-keywords.ts            # IEC 61131-3 keyword sözlüğü
│   ├── parser/
│   │   ├── st-parser.ts              # Token stream → AST
│   │   ├── st-ast.ts                 # AST node tipleri
│   │   └── st-errors.ts              # Parse error tipleri
│   ├── analyzer/
│   │   ├── semantic-analyzer.ts      # AST → diagnostics
│   │   ├── symbol-table.ts           # Scope-aware sembol tablosu
│   │   └── type-checker.ts           # IEC 61131-3 tip sistemi
│   ├── formatter/
│   │   └── st-formatter.ts           # AST → formatted code
│   ├── services/
│   │   ├── compiler.service.ts       # ICompilerService implementasyonu
│   │   └── compiler.interface.ts     # ICompilerService interface
│   └── compiler.module.ts            # NestJS module
├── language-service/
│   ├── st-language.gateway.ts        # WebSocket gateway
│   ├── st-language.service.ts        # Diagnostics, hover, completion
│   └── language-service.module.ts    # NestJS module
└── dto/
    └── json-bundle.dto.ts            # JSON bundle validation DTO
```

## 4. Özellikler Detay

### 4.1 IntelliSense (Autocomplete)

| Kaynak | Yükleme Zamanı | Veri |
|--------|----------------|------|
| IEC 61131-3 Keywords | Statik (frontend) | IF, FOR, WHILE, PROGRAM, FUNCTION_BLOCK, VAR, ... |
| Standart Fonksiyonlar | Statik (frontend) | ABS, SQRT, MAX, MIN, LEN, LEFT, RIGHT, MID, ... |
| Standart FB'ler | Statik (frontend + doku) | TON, TOF, TP, CTU, CTD, CTUD, SR, RS, PID, ... |
| Program Değişkenleri | AST parse (backend) | VAR bloğundaki tanımlı değişkenler |
| SCADA Tag'leri | GraphQL query (backend) | Sensor kanalları, I/O noktaları |
| Diğer Program FB'leri | GraphQL query (backend) | Tenant'taki diğer otomasyon programlarının fonksiyonları |

### 4.2 Snippets

```
Tetikleyici → Üretilen Kod
─────────────────────────────────────────────
program→    PROGRAM ${1:ProgramName}\nVAR\n  ${2}\nEND_VAR\n\n${3}\nEND_PROGRAM
fb→         FUNCTION_BLOCK ${1:FBName}\nVAR_INPUT\n  ${2}\nEND_VAR\n...
if→         IF ${1:condition} THEN\n  ${2}\nEND_IF;
ifelse→     IF ${1:condition} THEN\n  ${2}\nELSE\n  ${3}\nEND_IF;
for→        FOR ${1:i} := ${2:0} TO ${3:10} BY ${4:1} DO\n  ${5}\nEND_FOR;
while→      WHILE ${1:condition} DO\n  ${2}\nEND_WHILE;
case→       CASE ${1:expression} OF\n  ${2:1}: ${3};\n  ${4:2}: ${5};\nELSE\n  ${6};\nEND_CASE;
ton→        ${1:timer} : TON;\n${1:timer}(IN := ${2:startCond}, PT := T#${3:5s});
pid→        ${1:ctrl} : PID;\n${1:ctrl}(SETPOINT := ${2}, ACTUAL := ${3}, KP := ${4:1.0});
```

### 4.3 WebSocket Protocol

```typescript
// Client → Server
interface STRequest {
  type: 'analyze' | 'hover' | 'complete' | 'format' | 'outline' | 'definition' | 'references';
  requestId: string;
  programId?: string;
  code: string;
  position?: { line: number; character: number };
}

// Server → Client
interface STResponse {
  type: 'diagnostics' | 'hover' | 'completions' | 'formatted' | 'outline' | 'definition' | 'references';
  requestId: string;
  data: any;
}

interface Diagnostic {
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code?: string;        // Hata kodu, ör: "ST001"
  source: 'st-parser';
}
```

### 4.4 JSON Bundle Format

```json
{
  "$schema": "https://suderra.com/schemas/automation-bundle-v1.json",
  "version": "1.0",
  "exportedAt": "2026-03-06T14:30:00Z",
  "exportedBy": "user@company.com",
  "platform": "suderra-aquaculture",
  "program": {
    "programCode": "WATER_PUMP_001",
    "programName": "Su Pompası Kontrol",
    "description": "Havuz sıcaklığına göre pompa kontrolü",
    "programType": "ST",
    "executionMode": "CONTINUOUS",
    "scanCycleMs": 100,
    "priority": 5,
    "structuredTextCode": "PROGRAM WaterPumpControl\nVAR\n  waterTemp : REAL;\n  pumpOn : BOOL;\nEND_VAR\n\nIF waterTemp > 28.0 THEN\n  pumpOn := TRUE;\nEND_IF;\n\nEND_PROGRAM",
    "tags": ["pump", "temperature"],
    "metadata": {}
  },
  "variables": [
    {
      "varName": "waterTemp",
      "displayName": "Su Sıcaklığı",
      "dataType": "REAL",
      "scope": "INPUT",
      "initialValue": "0.0",
      "ioTagName": "water_temp",
      "engUnit": "°C",
      "minValue": 0,
      "maxValue": 50,
      "alarmHH": 35.0,
      "alarmH": 30.0,
      "alarmL": 15.0,
      "alarmLL": 10.0
    }
  ],
  "steps": [],
  "transitions": [],
  "deployConfig": {
    "deployTarget": "CODESYS_PLC",
    "targetPlcModel": "WAGO PFC200",
    "targetPlcAddress": "192.168.1.100",
    "targetPlcPort": 11740,
    "targetPlcProtocol": "CODESYS_V3"
  }
}
```

### 4.5 Editör Layout

```
┌──────────────────────────────────────────────────────────────┐
│ [💾 Save] [✓ Validate] [⟳ Format] [↓ Export] [↑ Import]     │
├───────────┬──────────────────────────────────────────────────┤
│ Outline   │ Monaco Editor                          minimap ▐ │
│           │                                                ▐ │
│ ▼ PROGRAM │ PROGRAM WaterPumpControl                       ▐ │
│   ▼ VAR   │ VAR                                            ▐ │
│     water │   waterTemp : REAL;                             ▐ │
│     pumpOn│   pumpOn : BOOL;                                ▐ │
│   ▼ Body  │ END_VAR                                        ▐ │
│     IF    │                                                ▐ │
│           │ IF waterTemp > 28.0 THEN                       ▐ │
│           │   pumpOn := TRUE;                               ▐ │
│           │ END_IF;                                         ▐ │
│           │                                                ▐ │
│           │ END_PROGRAM                                    ▐ │
├───────────┴──────────────────────────────────────────────────┤
│ PROBLEMS [2 errors] [1 warning]                              │
│ ⛔ E001 Line 5: Undeclared variable 'flowRate'               │
│ ⛔ E002 Line 8: Type mismatch: expected BOOL, got REAL       │
│ ⚠ W001 Line 3: Variable 'pumpOn' assigned but never read    │
└──────────────────────────────────────────────────────────────┘
```

## 5. Codesys Alım Listesi

Faz 2 entegrasyonu için alınması gereken Codesys ürünleri:

### 5.1 Zorunlu Ürünler

| Ürün | SKU | Açıklama | Tahmini Fiyat | Kullanım |
|------|-----|----------|---------------|----------|
| **CODESYS Automation Server** | - | Bulut tabanlı/self-hosted merkezi yönetim platformu | Abonelik bazlı (aylık) | ST kodunu uzaktan derleme, PLC yönetimi, deployment |
| **CODESYS Development System** | - | IEC 61131-3 geliştirme ortamı (derleyici dahil) | Ücretsiz (temel) | Automation Server'ın derleme yapabilmesi için |
| **CODESYS Control for Linux SL** | 2302000005-SW | x86 Linux PLC runtime | Lisans bazlı | x86 tabanlı endüstriyel PC'lerde çalıştırma |
| **CODESYS Control for Linux ARM SL** | 2302000039-SW | ARM Linux PLC runtime | Lisans bazlı | ARM tabanlı cihazlarda (Raspberry Pi, custom HW) |

### 5.2 Opsiyonel Ürünler

| Ürün | SKU | Açıklama | Kullanım |
|------|-----|----------|----------|
| **CODESYS Edge Gateway** | - | TLS ile güvenli PLC iletişimi | Automation Server ↔ PLC arası güvenli tünel |
| **CODESYS Virtual Control SL** | 000138 | Hardware-independent runtime | Test/simülasyon ortamı, CI/CD pipeline |
| **CODESYS OPC UA Server** | - | OPC-UA desteği | Dış SCADA sistemleriyle entegrasyon |
| **CODESYS Visualization** | - | Web visualization | PLC üzerinde HMI |

### 5.3 Entegrasyon Mimarisi (Faz 2)

```
Suderra Backend (NestJS)
        │
        │ REST API / gRPC
        ▼
CODESYS Automation Server (Linux VM - self-hosted veya cloud)
  ├── CODESYS Compiler (ST → native code)
  ├── Project Manager (proje oluşturma/yönetim)
  ├── Device Manager (PLC listesi)
  └── Deployment Engine
        │
        │ CODESYS Gateway Protocol (TCP)
        ▼
PLC Runtime (CODESYS Control for Linux)
  ├── IEC 61131-3 Task Scheduler
  ├── I/O Driver Manager
  └── OPC-UA Server (opsiyonel)
```

### 5.4 Alternatif: Self-Hosted Derleme

Automation Server yerine doğrudan derleme yapma seçeneği:

```bash
# CODESYS command-line scripting ile derleme
codesys --profile="CODESYS V3.5 SP20" --runscript="compile.py" --project="program.project"
```

Bu yaklaşım için CODESYS Development System'ın headless çalıştırılması gerekir (Linux desteği sınırlı, genelde Windows VM gerektirir).

**Öneri:** Automation Server tercih edilmeli - REST API'si var, multi-tenant uyumlu, ölçeklenebilir.

## 6. Implementation Plan - Faz 1

### Adım 1: Backend ST Lexer/Parser
- `st-tokens.ts` - IEC 61131-3 token tanımları
- `st-keywords.ts` - Keyword sözlüğü
- `st-lexer.ts` - Tokenizer
- `st-ast.ts` - AST node tipleri
- `st-parser.ts` - Recursive descent parser
- `st-errors.ts` - Hata tipleri

### Adım 2: Backend Semantic Analyzer
- `symbol-table.ts` - Scope-aware değişken tablosu
- `type-checker.ts` - IEC 61131-3 tip sistemi
- `semantic-analyzer.ts` - AST traversal + diagnostics

### Adım 3: Backend WebSocket Language Service
- `st-language.gateway.ts` - NestJS WebSocket gateway
- `st-language.service.ts` - analyze, hover, complete, format, outline
- `language-service.module.ts` - Module tanımı
- `compiler.interface.ts` - ICompilerService interface
- `compiler.service.ts` - Mock compiler (Faz 2 için placeholder)

### Adım 4: Frontend Monaco Providers
- `st-language.ts` - Geliştirilmiş dil tanımı (monarch tokenizer)
- `st-completion.ts` - CompletionItemProvider (statik + dynamic)
- `st-hover.ts` - HoverProvider
- `st-diagnostics.ts` - Marker management
- `st-formatting.ts` - DocumentFormattingEditProvider
- `st-snippets.ts` - Snippet tanımları
- `st-definition.ts` - DefinitionProvider
- `st-references.ts` - ReferenceProvider
- `st-symbols.ts` - DocumentSymbolProvider

### Adım 5: Frontend Editor Components
- `STEditorContainer.tsx` - Ana layout (split panels)
- `STEditorToolbar.tsx` - Toolbar
- `STOutlinePanel.tsx` - Sol panel
- `STProblemsPanel.tsx` - Alt panel
- `STMonacoEditor.tsx` - Monaco wrapper
- `useSTLanguageService.ts` - WebSocket hook
- `st-websocket.service.ts` - WebSocket client

### Adım 6: JSON Bundle System
- `json-bundle.dto.ts` - Backend validation
- `bundle.utils.ts` - Frontend serialize/deserialize
- `ExportDialog.tsx` - Export UI
- `ImportDialog.tsx` - Import UI
- GraphQL mutation: `exportAutomationBundle`, `importAutomationBundle`

### Adım 7: Integration & Refactor
- `AutomationProgramEditorPage.tsx` - ST Code tab'ını yeni editörle değiştir
- Mevcut `STEditor.tsx`'i kaldır
- Test & polish

## 7. Teknik Kararlar

| Karar | Seçim | Neden |
|-------|-------|-------|
| Parser tipi | Recursive Descent | IEC 61131-3 grameri için yeterli, basit, debug edilebilir |
| WebSocket lib | `@nestjs/websockets` + `socket.io` | NestJS native, mevcut altyapıyla uyumlu |
| Frontend WS | `socket.io-client` | Backend ile uyumlu |
| Debounce süresi | 300ms | Yazarken çok sık istek atmamak için |
| AST format | TypeScript discriminated unions | Tip güvenli, IDE desteği iyi |
| JSON schema | JSON Schema Draft 7 | Validation için standart |
| Outline ağacı | MUI TreeView | Mevcut UI kit ile uyumlu |
| Split panel | CSS Grid + resize handle | Lightweight, kütüphane gereksiz |

## 8. Faz 2 Roadmap (Codesys Entegrasyonu)

1. Codesys Automation Server kurulumu (Linux VM)
2. REST API client yazımı (`compiler.service.ts` mock → gerçek)
3. Proje oluşturma/derleme pipeline
4. Boot application alma ve PLC'ye deploy
5. Online monitoring (PLC değişken değerlerini canlı izleme)
6. Debug support (breakpoint, single-step - opsiyonel)
