# IEC 61131-3 Structured Text IDE - Design & Implementation Plan

**Tarih:** 2026-03-06
**Revizyon:** v2.0 (6 uzman agent audit sonrasi)
**Sayfa:** `/sensor/automation` → ST Code tab
**Yaklaşım:** Aşamalı (Faz 1A-1C: Editör + Parser + Güvenlik, Faz 2A-2D: Codesys Entegrasyonu)

---

## 1. Genel Bakış

### 1.1 Hedef

Mevcut Monaco-tabanli ST editörünü (sensor-module icerisinde `StEditorPanel.tsx`), endustriyel düzeyde bir IEC 61131-3 Structured Text IDE deneyimine yükseltiyoruz. Hedef sayfa: `/sensor/automation/new` → **ST Code** sekmesi.

### 1.2 Kapsam (Scope)

| Kapsam | Faz 1 (Hafta 1-6) | Faz 2 (Hafta 7-14) |
|--------|-------------------|---------------------|
| **Editör** | Monaco + IntelliSense, hover, snippet, outline, problems panel | Online monitoring overlay, debug breakpoint UI |
| **Parser** | Recursive descent ST parser (lexer → AST → semantic analysis) | - |
| **Backend** | WS Language Service (JWT auth, rate limit, tenant izolasyon) | Codesys REST client + circuit breaker |
| **Güvenlik** | WS auth, parser limitleri, bundle sanitizasyon, PLC credential şifreleme | Deploy dual-approval, online monitoring yetkilendirme |
| **Bundle** | JSON bundle v2 import/export (güvenli, versiyonlu) | Codesys proje formatina donuşum |
| **Derleme** | Mock compiler (ICompilerService) | Codesys Automation Server entegrasyonu |
| **Deploy** | - | Compile → boot app → PLC deploy pipeline |
| **Monitoring** | - | Variable watch, force values, trace recorder |
| **Debug** | - | Breakpoint, single-step, online change |

### 1.3 Mevcut Durum

- `StEditorPanel.tsx` (514 satır): Temel Monaco editör, 3-kolonlu layout, save/load GraphQL entegrasyonu mevcut.
- `useStEditor.ts` (337 satır): Editor state hook, compile/validate flow mevcut.
- `st-language-enhanced.ts` (162 satır): Monarch tokenizer, basit keyword renklendirme mevcut.
- `StCompletionProvider.ts` (246 satır): Keywords + types + 13 FB + snippets + device tags.
- Backend: `automation.service.ts` uzerinden CRUD operasyonlari mevcut, WS language service yok.
- SCADA tag sistemi: `UnifiedTag` entity ve GraphQL resolver'lari mevcut, editore entegre degil.
- PLC kontrol: `plc-control` modülü mevcut (baglanti, telemetri, alarm), ancak ST derleme/deploy yok.

### 1.4 IEC 61131-3 Uyumluluk Hedefi

Faz 1'de desteklenecek IEC 61131-3 ogeleri:

- **POU tipleri:** PROGRAM, FUNCTION_BLOCK, FUNCTION
- **Veri tipleri:** BOOL, INT, DINT, REAL, LREAL, TIME, STRING, DATE, TOD, DT, BYTE, WORD, DWORD, LWORD, ARRAY, STRUCT
- **Kontrol yapilari:** IF/ELSIF/ELSE, CASE, FOR, WHILE, REPEAT, EXIT, RETURN
- **Operatorler:** Aritmetik (+, -, *, /, MOD), karşilaştirma (=, <>, <, >, <=, >=), lojik (AND, OR, XOR, NOT)
- **Composed expression:** AND, OR, NOT ile bileşik koşul ifadeleri
- **Standart FB'ler:** TON, TOF, TP, CTU, CTD, CTUD, SR, RS, R_TRIG, F_TRIG, HYSTERESIS, PID
- **TIME literal aritmetigi:** T#5s, T#100ms, T#1h30m, TIME aritmetik operasyonlari
- **Degişken bloklari:** VAR, VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_GLOBAL, VAR_TEMP, VAR_EXTERNAL
- **Execution modlari:** CYCLIC (eski CONTINUOUS), EVENT (eski TRIGGERED)

> **NOT:** SCHEDULED modu IEC 61131-3'te PLC seviyesinde tanimli degildir. Zamanlanmiş çalişma SCADA seviyesinde (cron/scheduler) yapilmalidir. Bu nedenle SCHEDULED modu kaldirilmiştir.

---

## 2. Mimari

### 2.1 Mimari Karar Gecmisi

| Sorun | Eski Plan | Yeni Karar | Gerekce |
|-------|-----------|------------|---------|
| Sensor-service 69K satir, SRP ihlali | Parser + WS gateway sensor-service icerisinde | Parser sensor-service'te kalir, WS gateway gateway-api'ye tasinir | Parser domain verisine yakin durmali. WS baglanti yonetimi gateway-api'nin sorumlulugudur. |
| WS gateway cakismasi | sensor-service'e yeni Socket.io server | gateway-api'deki mevcut Socket.io'ya `/st-language` namespace eklenir | Tek Socket.io server, tek nginx WS config, tek JWT/CORS/tenant isolation. |
| NATS event bus eksik | Hic NATS yok | NATS request-reply + event pattern | Platform NATS-based. Gateway-api WS isteklerini NATS uzerinden sensor-service'e delege eder. |
| Server-push eksik | Sadece request/response | STServerPush interface eklendi | LSP standardi: server proaktif olarak diagnostics, tag degisiklikleri push eder. |
| Parser guvenlik limitleri yok | Tanimsiz | Security layer + limitler eklendi | CPU-bound parser, kotu niyetli input'larla DoS vektoru olusturabilir. |
| Worker thread yok | Ana thread'de parser | Worker thread pool (piscina) | Node.js single-threaded. 10K satirlik ST kodu parse etmek event loop'u bloke eder. |

### 2.2 Mimari Diyagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER (Frontend - sensor-module MFE)                             │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ Monaco Editor (ST Code Tab - tam IDE)                           ││
│  │ ┌──────────────────────┐  ┌──────────────────────────────────┐ ││
│  │ │ STCompletionProvider │  │ STDiagnosticsProvider            │ ││
│  │ │ STHoverProvider      │  │ STOutlinePanel / STProblemsPanel │ ││
│  │ │ STFormattingProvider │  │ STSnippetProvider                │ ││
│  │ └──────────────────────┘  └──────────────────────────────────┘ ││
│  │              │                           │                      ││
│  │              └─────────┬─────────────────┘                      ││
│  │           useSTLanguageService (hook)                            ││
│  │                        │ socket.io-client                       ││
│  └────────────────────────┼────────────────────────────────────────┘│
│                           │ wss:// (namespace: /st-language)        │
└───────────────────────────┼─────────────────────────────────────────┘
                            │
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
  NGINX (reverse proxy)     │
│   location /socket.io     │                                        │
    ├─ /sensors    → gateway-api:3000 (mevcut)
│   └─ /st-language → gateway-api:3000 (YENi namespace, ayni port)   │
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
                            │
┌───────────────────────────▼─────────────────────────────────────────┐
│  GATEWAY-API (NestJS - mevcut servis)                               │
│  ┌───────────────────────────────────────────────────────────┐      │
│  │ WebSocket Layer (tek Socket.io server, coklu namespace)   │      │
│  │  /sensors  (SensorReadingsGateway - MEVCUT, DEGISMEZ)     │      │
│  │  /st-language (STLanguageGateway - YENi)                  │      │
│  │    ├─ handleConnection: JWT dogrulama, tenantId cikartma  │      │
│  │    ├─ @SubscribeMessage('st:request') → NATS delege       │      │
│  │    └─ NATS listener → client'a push (diagnostics, tags)   │      │
│  └──────────────────────────┬────────────────────────────────┘      │
│  ┌──────────────────────────▼────────────────────────────────┐      │
│  │ NATS Bridge (NatsBridgeService - GENISLETILMIS)           │      │
│  │  ├─ events.SensorReadingReceived.>     (MEVCUT)           │      │
│  │  ├─ events.AutomationProgramDeployed.> (YENi - push)      │      │
│  │  ├─ events.AutomationTagsUpdated.>     (YENi - push)      │      │
│  │  └─ st.language.* (request-reply)      (YENi - delege)    │      │
│  └──────────────────────────┬────────────────────────────────┘      │
└─────────────────────────────┼───────────────────────────────────────┘
                              │ NATS (nats://aqua-nats:4222)
┌─────────────────────────────▼───────────────────────────────────────┐
│  SENSOR-SERVICE (NestJS - mevcut servis)                            │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ ST Compiler Module (automation/compiler/)                    │    │
│  │  ┌─────────────────────────────────────────────────────┐    │    │
│  │  │ Security Layer                                       │    │    │
│  │  │  max_source_size: 512 KB | max_ast_depth: 64 level   │    │    │
│  │  │  parse_timeout: 5000 ms  | max_diagnostics: 200      │    │    │
│  │  └──────────────┬──────────────────────────────────────┘    │    │
│  │  ┌──────────────▼──────────────────────────────────────┐    │    │
│  │  │ Worker Thread Pool (piscina)                         │    │    │
│  │  │  ┌─────────┐  ┌──────────┐  ┌───────────────────┐   │    │    │
│  │  │  │  Lexer  │→│  Parser  │→│ Semantic Analyzer  │   │    │    │
│  │  │  └─────────┘  └──────────┘  └───────────────────┘   │    │    │
│  │  └─────────────────────────────────────────────────────┘    │    │
│  │  STLanguageHandler (NATS request handler)                   │    │
│  │    @MessagePattern('st.language.*')                         │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  NATS Event Publisher:                                              │
│    sensor.automation.program.saved     → diagnostics re-run         │
│    sensor.automation.program.deployed  → audit + bildirim           │
│    sensor.tags.updated                 → IntelliSense cache inv.    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ REST API (Faz 2)
┌────────────────────────────▼────────────────────────────────────────┐
│  CODESYS AUTOMATION SERVER  (ayri Linux sunucu - Faz 2)             │
│  - ST source → derlenmiş boot application                           │
│  - Target-specific compilation (ARM/x86)                            │
│  - Codesys Gateway → PLC runtime'lara deploy                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │ TCP/IP
┌────────────────────────────▼────────────────────────────────────────┐
│  PLC'LER (sahada - Linux tabanli)                                   │
│  - CODESYS Control for Linux SL (x86) / ARM SL                      │
│  - Runtime derlenmis kodu calistirir                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 Veri Akisi (Sequence)

```
Browser                    gateway-api                NATS              sensor-service
  │                            │                        │                     │
  │─── WS connect ────────────>│                        │                     │
  │    (JWT in auth obj)       │                        │                     │
  │<── connected ──────────────│                        │                     │
  │                            │                        │                     │
  │─── st:request ────────────>│                        │                     │
  │    {type:'analyze',code}   │                        │                     │
  │                            │── NATS request ───────>│                     │
  │                            │   st.language.analyze   │                     │
  │                            │                        │──── Worker Thread ──>│
  │                            │                        │     Lexer→Parser→   │
  │                            │                        │     SemanticAnalyzer │
  │                            │                        │<─── diagnostics ────│
  │                            │<─ NATS reply ─────────│                     │
  │<── st:response ────────────│                        │                     │
  │    {type:'diagnostics'}    │                        │                     │
  │                            │                        │                     │
  │ ─ ─ ─ ─ ─ SERVER PUSH (proaktif) ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
  │                            │  events.AutomationTagsUpdated.{tid}  │
  │                            │<─ NATS event ─────────│  (tag eklendi)
  │<── st:push ────────────────│                        │                     │
  │    {type:'tags_changed'}   │                        │                     │
```

---

## 3. Bileşen Yapısı

### 3.1 Frontend (sensor-module)

> **KRİTİK NOT:** Mevcut `StEditorPanel.tsx` (514 satır), `useStEditor.ts` (337 satır),
> `st-language-enhanced.ts` (162 satır), ve `StCompletionProvider.ts` (246 satır) dosyaları
> sıfırdan yazılmayacaktır. Bu dosyalar **baz alınarak** genişletilecektir.
> `[M]` = mevcut, değiştirilecek | `[N]` = yeni eklenecek

```
web/modules/sensor-module/src/
├── components/unified-editor/
│   ├── StEditorPanel.tsx                [M] Ana 3-kolonlu layout (mevcut 514 satir)
│   │                                         Degisiklik: Outline panel, Problems panel,
│   │                                         toolbar genisletme (Format, Export, Import)
│   ├── st-language-enhanced.ts          [M] Monarch tokenizer (mevcut 162 satir)
│   │                                         Degisiklik: Eksik keyword eklenmesi
│   │                                         (METHOD, PROPERTY, INTERFACE, ENUM vb.)
│   ├── StCompletionProvider.ts          [M] CompletionItemProvider (mevcut 246 satir)
│   │                                         Degisiklik: ~120 yeni standart fonksiyon/FB
│   ├── StOutlineTree.tsx                [N] Recursive tree (lucide-react + Tailwind)
│   │                                         MUI TreeView KULLANILMAYACAK (0 dependency)
│   ├── StProblemsPanel.tsx              [N] Alt panel - errors/warnings/info listesi
│   ├── providers/
│   │   ├── index.ts                     [N] Barrel export + lazy registration
│   │   │   ─── FAZ 1A: Statik (backend WS gerektirmez) ───
│   │   ├── st-snippets.ts               [N] 36 snippet tanimi
│   │   ├── st-formatting.ts             [N] DocumentFormattingEditProvider
│   │   │   ─── FAZ 1B: Dinamik (backend WS gerektirir) ───
│   │   ├── st-diagnostics.ts            [N] DiagnosticProvider (WS marker yonetimi)
│   │   ├── st-hover.ts                  [N] HoverProvider (WS: tip bilgisi)
│   │   ├── st-definition.ts             [N] DefinitionProvider (WS: go-to-definition)
│   │   ├── st-references.ts             [N] ReferenceProvider (WS: find references)
│   │   └── st-symbols.ts               [N] DocumentSymbolProvider (WS: outline)
│   └── json-bundle/
│       ├── ExportDialog.tsx             [N] JSON export dialog
│       ├── ImportDialog.tsx             [N] JSON import dialog (drag & drop)
│       └── bundle.utils.ts             [N] Serialize/deserialize + sanitize
├── hooks/
│   ├── useStEditor.ts                   [M] Editor state hook (mevcut 337 satir)
│   │                                         Degisiklik: WS, outline, problems state
│   └── useStLanguageService.ts          [N] WebSocket hook (useSensorSocket pattern)
├── services/
│   └── st-websocket.service.ts          [N] socket.io-client singleton
└── types/
    └── st-editor.types.ts               [N] Tum ST editor tipleri
```

### 3.2 Backend (sensor-service + gateway-api)

#### 3.2.1 sensor-service (Parser + NATS Handler)

```
apps/sensor-service/src/automation/
├── compiler/                                # ST Compiler sub-module
│   ├── compiler.module.ts                   # NestJS module
│   ├── compiler.constants.ts                # Guvenlik limitleri
│   ├── lexer/
│   │   ├── st-lexer.ts                      # Source → Token stream
│   │   ├── st-tokens.ts                     # Token enum (200+ token)
│   │   └── st-keywords.ts                   # IEC 61131-3 keyword sozlugu
│   ├── parser/
│   │   ├── st-parser.ts                     # Token stream → AST (recursive descent)
│   │   ├── st-ast.ts                        # AST node tipleri (discriminated unions)
│   │   └── st-errors.ts                     # Parse error tipleri + recovery
│   ├── analyzer/
│   │   ├── semantic-analyzer.ts             # AST → diagnostics
│   │   ├── symbol-table.ts                  # Scope-aware sembol tablosu
│   │   └── type-checker.ts                  # IEC 61131-3 tip sistemi
│   ├── formatter/
│   │   └── st-formatter.ts                  # AST → formatted code
│   ├── worker/
│   │   ├── st-worker.ts                     # Worker thread entry point (piscina)
│   │   ├── st-worker-pool.service.ts        # Pool yonetimi + graceful shutdown
│   │   └── st-worker.types.ts              # Worker input/output tipleri
│   ├── services/
│   │   ├── st-language.service.ts           # Orchestrator: validate → worker → sonuc
│   │   ├── st-intellisense.service.ts       # SCADA tag + FB completion saglayici
│   │   ├── compiler.interface.ts            # ICompilerService interface (Faz 2)
│   │   └── compiler.service.ts              # Mock compiler (Faz 2 placeholder)
│   └── nats-handlers/
│       └── st-language.handler.ts           # @MessagePattern('st.language.*')
├── events/
│   └── automation-events.publisher.ts       # NATS event yayinci
├── dto/
│   └── json-bundle.dto.ts                   # JSON bundle validation DTO
├── entities/                                # MEVCUT - degismez
├── automation.module.ts                     # MEVCUT - CompilerModule import eklenecek
├── automation.service.ts                    # MEVCUT
└── automation.resolver.ts                   # MEVCUT
```

#### 3.2.2 gateway-api (WS Gateway + NATS Bridge)

```
apps/gateway-api/src/websocket/
├── sensor-readings.gateway.ts               # MEVCUT - DEGISMEZ
├── st-language.gateway.ts                   # YENi - /st-language namespace
│                                            #   JWT + tenant room izolasyonu
│                                            #   @SubscribeMessage('st:request')
├── nats-bridge.service.ts                   # MEVCUT - GENISLETILECEK
│                                            #   + st.language.* request-reply
│                                            #   + events.Automation*.> dinle
└── st-language-bridge.service.ts            # YENi - ST-specific NATS bridge
```

---

## 4. Özellikler Detay

### 4.1 IntelliSense (Autocomplete)

> **MEVCUT DURUM:** `StCompletionProvider.ts` halihazirda 5 kategori IntelliSense sagliyor:
> Keywords (66), Types (20), Function Blocks (13), Snippets (12), Device Tags (dinamik).
> Asagidaki tablo kapsamı **%30'dan %90+'a** cikarir.

#### 4.1.1 Kaynak Tablosu

| Kaynak | Yukleme Zamani | Mevcut | Eklenecek | Toplam |
|--------|----------------|--------|-----------|--------|
| IEC 61131-3 Keywords | Statik (frontend) | 66 | +12 (METHOD, PROPERTY, INTERFACE, vb.) | 78 |
| Standart Fonksiyonlar | Statik (frontend) | 0 | +72 (asagidaki listeye bkz.) | 72 |
| Standart FB'ler | Statik (frontend + doku) | 13 | +11 | 24 |
| IEC Veri Tipleri | Statik (frontend) | 20 | +6 (ANY, ANY_NUM, vb.) | 26 |
| Tip Dönüşüm Fonk. | Statik (frontend) | 0 | +52 (*_TO_* pattern) | 52 |
| Program Degiskenleri | AST parse (backend WS) | Yok | Faz 1B | Dinamik |
| SCADA Tag'leri | Mevcut (setTags) | Var | Degisiklik yok | Dinamik |
| Diger Program FB'leri | GraphQL query (backend) | Yok | Faz 1B | Dinamik |

#### 4.1.2 Standart Fonksiyon Katalogu

**Matematiksel Fonksiyonlar**

| Fonksiyon | Imza | Aciklama |
|-----------|------|----------|
| `ABS` | `ABS(x : ANY_NUM) : ANY_NUM` | Mutlak deger |
| `SQRT` | `SQRT(x : ANY_REAL) : ANY_REAL` | Karekoku |
| `LN` | `LN(x : ANY_REAL) : ANY_REAL` | Dogal logaritma |
| `LOG` | `LOG(x : ANY_REAL) : ANY_REAL` | 10 tabanli logaritma |
| `EXP` | `EXP(x : ANY_REAL) : ANY_REAL` | e^x ustel fonksiyon |
| `EXPT` | `EXPT(base : ANY_REAL, exp : ANY_NUM) : ANY_REAL` | Kuvvet alma |
| `SIN` | `SIN(x : ANY_REAL) : ANY_REAL` | Sinus (radyan) |
| `COS` | `COS(x : ANY_REAL) : ANY_REAL` | Kosinus |
| `TAN` | `TAN(x : ANY_REAL) : ANY_REAL` | Tanjant |
| `ASIN` | `ASIN(x : ANY_REAL) : ANY_REAL` | Ark sinus |
| `ACOS` | `ACOS(x : ANY_REAL) : ANY_REAL` | Ark kosinus |
| `ATAN` | `ATAN(x : ANY_REAL) : ANY_REAL` | Ark tanjant |
| `ATAN2` | `ATAN2(y, x : ANY_REAL) : ANY_REAL` | Iki arguman ark tanjant |
| `TRUNC` | `TRUNC(x : ANY_REAL) : ANY_INT` | Tam sayiya kesme |
| `MOD` | `MOD(a, b : ANY_INT) : ANY_INT` | Modulo |

**Secim ve Sinir Fonksiyonlari**

| Fonksiyon | Imza | Aciklama |
|-----------|------|----------|
| `MAX` | `MAX(a, b, ... : ANY) : ANY` | Maksimum |
| `MIN` | `MIN(a, b, ... : ANY) : ANY` | Minimum |
| `LIMIT` | `LIMIT(MN, IN, MX : ANY) : ANY` | Sinirlandirma |
| `SEL` | `SEL(G : BOOL, IN0, IN1 : ANY) : ANY` | Binary secici |
| `MUX` | `MUX(K : ANY_INT, IN0, IN1, ... : ANY) : ANY` | Multiplexer |
| `MOVE` | `MOVE(IN : ANY) : ANY` | Deger kopyalama |

**String Fonksiyonlari**

| Fonksiyon | Imza | Aciklama |
|-----------|------|----------|
| `LEN` | `LEN(IN : STRING) : INT` | String uzunlugu |
| `LEFT` | `LEFT(IN : STRING, L : INT) : STRING` | Soldan L karakter |
| `RIGHT` | `RIGHT(IN : STRING, L : INT) : STRING` | Sagdan L karakter |
| `MID` | `MID(IN : STRING, L, P : INT) : STRING` | Ortadan L karakter |
| `CONCAT` | `CONCAT(IN1, IN2, ... : STRING) : STRING` | Birlestirme |
| `INSERT` | `INSERT(IN1, IN2 : STRING, P : INT) : STRING` | Ekleme |
| `DELETE` | `DELETE(IN : STRING, L, P : INT) : STRING` | Silme |
| `REPLACE` | `REPLACE(IN1, IN2 : STRING, L, P : INT) : STRING` | Degistirme |
| `FIND` | `FIND(IN1, IN2 : STRING) : INT` | Arama |

**Bit Manipulasyon**

| Fonksiyon | Imza | Aciklama |
|-----------|------|----------|
| `SHL` | `SHL(IN : ANY_BIT, N : ANY_INT) : ANY_BIT` | Sola kaydirma |
| `SHR` | `SHR(IN : ANY_BIT, N : ANY_INT) : ANY_BIT` | Saga kaydirma |
| `ROL` | `ROL(IN : ANY_BIT, N : ANY_INT) : ANY_BIT` | Dondurmeli sola |
| `ROR` | `ROR(IN : ANY_BIT, N : ANY_INT) : ANY_BIT` | Dondurmeli saga |

**Tip Donusum Fonksiyonlari:** ~52 kombinasyon (`*_TO_*` pattern: BOOL_TO_INT, INT_TO_REAL, REAL_TO_INT, DINT_TO_STRING, TIME_TO_DINT, vb.)

#### 4.1.3 Standart Function Block Katalogu

| FB | Kategori | Mevcut? | Parametre Imzasi |
|----|----------|---------|------------------|
| `TON` | Timer | Evet | `IN:BOOL, PT:TIME -> Q:BOOL, ET:TIME` |
| `TOF` | Timer | Evet | `IN:BOOL, PT:TIME -> Q:BOOL, ET:TIME` |
| `TP` | Timer | Evet | `IN:BOOL, PT:TIME -> Q:BOOL, ET:TIME` |
| `CTU` | Counter | Evet | `CU:BOOL, R:BOOL, PV:INT -> Q:BOOL, CV:INT` |
| `CTD` | Counter | Evet | `CD:BOOL, LD:BOOL, PV:INT -> Q:BOOL, CV:INT` |
| `CTUD` | Counter | Evet | `CU:BOOL, CD:BOOL, R:BOOL, LD:BOOL, PV:INT -> QU:BOOL, QD:BOOL, CV:INT` |
| `SR` | Bistable | Evet | `S1:BOOL, R:BOOL -> Q1:BOOL` |
| `RS` | Bistable | Evet | `S:BOOL, R1:BOOL -> Q1:BOOL` |
| `R_TRIG` | Edge | Evet | `CLK:BOOL -> Q:BOOL` |
| `F_TRIG` | Edge | Evet | `CLK:BOOL -> Q:BOOL` |
| `PID` | Control | Evet | `SETPOINT:REAL, PV:REAL, KP:REAL, KI:REAL, KD:REAL -> OUT:REAL` |
| `HYSTERESIS` | Control | Evet | `IN:REAL, HIGH:REAL, LOW:REAL -> Q:BOOL` |
| `MAVG` | Filter | Evet | `IN:REAL, N:INT -> OUT:REAL` |
| `RAMP` | Control | **Yeni** | `IN:REAL, RATE:REAL, CYCLE:TIME -> OUT:REAL` |
| `BLINK` | Timer | **Yeni** | `ENABLE:BOOL, TIMELOW:TIME, TIMEHIGH:TIME -> Q:BOOL` |
| `DERIVATIVE` | Math | **Yeni** | `IN:REAL, CYCLE:TIME -> OUT:REAL` |
| `INTEGRAL` | Math | **Yeni** | `IN:REAL, CYCLE:TIME, R:BOOL -> OUT:REAL` |
| `PID_COMPACT` | Control | **Yeni** | `SETPOINT:REAL, INPUT:REAL, MANUAL:BOOL -> OUTPUT:REAL, STATE:INT` |
| `SEMA` | Sync | **Yeni** | `CLAIM:BOOL, RELEASE:BOOL -> BUSY:BOOL` |
| `LIMITALARM` | Alarm | **Yeni** | `IN:REAL, HH:REAL, H:REAL, L:REAL, LL:REAL -> QHH/QH/QL/QLL:BOOL` |
| `SCALE` | Math | **Yeni** | `IN:REAL, IN_MIN/MAX:REAL, OUT_MIN/MAX:REAL -> OUT:REAL` |
| `DEADBAND` | Filter | **Yeni** | `IN:REAL, DB:REAL, LAST:REAL -> OUT:REAL` |
| `LINEARIZE` | Math | **Yeni** | `IN:REAL, X:ARRAY, Y:ARRAY -> OUT:REAL` |
| `TOTALIZER` | Counter | **Yeni** | `IN:REAL, CYCLE:TIME, R:BOOL -> OUT:REAL` |

### 4.2 Snippets

Mevcut 12 snippet (StCompletionProvider.ts satir 99-160) korunarak **24 yeni snippet** eklenir. Toplam: **36 snippet**.

Yeni snippet'lar: FUNCTION, METHOD, PROPERTY, INTERFACE, TYPE_ENUM, TYPE_STRUCT, ARRAY_DECL, ARRAY_2D, R_TRIG, F_TRIG, TOF_timer, CTU_counter, CTUD_counter, RAMP, BLINK, LIMITALARM, PID_COMPACT, SCALE, IO_ADDRESS, VAR_GLOBAL_BLOCK, VAR_TEMP_BLOCK, IF_ELSIF_CHAIN, FOR_ARRAY, AQUA_PUMP_CONTROL.

### 4.3 WebSocket Protocol

#### 4.3.1 Baglanti

```typescript
const socket = io('/st-language', {
  auth: { token: jwtToken },  // Query param DEGIL (güvenlik)
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});
```

#### 4.3.2 Client → Server: STRequest

```typescript
interface STRequest {
  type: 'analyze' | 'hover' | 'complete' | 'format' | 'outline' | 'definition' | 'references';
  requestId: string;       // UUID v4
  programId?: string;
  code: string;            // MAX_SOURCE_SIZE (512 KB) limitine tabi
  position?: { line: number; character: number };  // 0-based
  range?: { startLine: number; endLine: number };   // incremental update
}
```

#### 4.3.3 Server → Client: STResponse

```typescript
interface STResponse {
  type: 'diagnostics' | 'hover' | 'completions' | 'formatted'
      | 'outline' | 'definition' | 'references' | 'error';
  requestId: string;
  data: any;  // type'a gore degisir
  processingTimeMs?: number;
}

interface Diagnostic {
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code: string;        // Format: ST{L|P|S|T}{numara}
  source: 'st-lexer' | 'st-parser' | 'st-semantic';
  fix?: { description: string; newText: string; range: Diagnostic['range'] };
}

type STErrorCode =
  | 'SOURCE_TOO_LARGE' | 'PARSE_TIMEOUT' | 'WORKER_BUSY'
  | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'TENANT_MISMATCH' | 'INTERNAL_ERROR';
```

#### 4.3.4 Server → Client: STServerPush (Proaktif Bildirimler)

```typescript
interface STServerPush {
  type: 'diagnostics_update' | 'tags_changed' | 'fb_definitions_changed'
      | 'program_deployed' | 'connection_limit_warning';
  data: any;
  timestamp: string;  // ISO 8601
}
```

#### 4.3.5 Güvenlik Limitleri

| Limit | Deger | Aciklama |
|-------|-------|----------|
| Max baglanti/tenant | 50 | Her baglanti ~2KB RAM |
| Max mesaj/s/client | 10 | Debounce ile 3-4 req/s tipik |
| Max mesaj/dk/tenant | 500 | DDoS koruması |
| Max mesaj boyutu | 1 MB | 512KB source + overhead |
| Idle timeout | 5 dk | Bos baglantilar kapatilir |

### 4.4 JSON Bundle Format

```json
{
  "$schema": "https://suderra.com/schemas/automation-bundle-v2.json",
  "bundleVersion": "2.0",
  "schemaVersion": "2.0",
  "exportedAt": "2026-03-06T14:30:00Z",
  "exportedBy": "user@company.com",
  "exportedFrom": { "platform": "suderra-aquaculture", "version": "1.5.0" },
  "program": {
    "programCode": "WATER_PUMP_001",
    "programName": "Su Pompasi Kontrol",
    "programType": "ST",
    "executionMode": "CYCLIC",
    "scanCycleMs": 100,
    "minScanCycleMs": 1,
    "structuredTextCode": "..."
  },
  "variables": [...],
  "steps": [],
  "transitions": []
}
```

> **GÜVENLİK:** `deployConfig` alanı v2'de **kaldırıldı** (SSRF vektörü). Import sırasında `__proto__`/`constructor` filtrelenir. Max boyut: 1MB.

### 4.5 Editör Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ Toolbar: [+ New] | [▶ Compile F5] [✓ Validate F7] | [↑ Deploy F9]   │
│          [💾 Save] [⟳ Format] | [↓ Export JSON] [↑ Import JSON]      │
├────────────┬──────────────────────────────────────────┬────────────────┤
│ Sol Panel  │  Monaco Editor (flex-1)                  │ Sag Panel      │
│ (w-48)     │                                          │ (w-64)         │
│ ┌────────┐ │  1  PROGRAM WaterPumpControl             │ OUTPUT         │
│ │PROGRAMS│ │  2  VAR                                  │ ✓ Compile OK   │
│ │▸ Main *│ │  3      waterTemp : REAL;                │                │
│ │  Pump  │ │  4      pumpOn : BOOL;                   │  - veya -      │
│ └────────┘ │  5  END_VAR                              │ ✕ Ln 14: err   │
│ ┌────────┐ │  6  ...                                  │ ▲ Ln 8: warn   │
│ │OUTLINE │ │                                          │                │
│ │▾PROGRAM│ │                                          │                │
│ │ ▾ VAR  │ │                                          │                │
│ │  water │ │                                          │                │
│ └────────┘ │                                          │                │
├────────────┴──────────────────────────────────────────┴────────────────┤
│ PROBLEMS  [2 errors] [1 warning]                            [▾ ▴]     │
│ ✕ E001  Ln 14  Missing END_IF                                         │
│ ✕ E002  Ln 18  Type mismatch: BOOL := REAL                            │
│ ▲ W001  Ln 8   GOTO usage is discouraged                              │
└────────────────────────────────────────────────────────────────────────┘
```

Layout: Flexbox (mevcut StEditorPanel pattern'i ile tutarlı). CSS Grid **kullanılmayacak**.

### 4.6 NATS Event Contracts

#### 4.6.1 Request-Reply (gateway-api → sensor-service)

| Subject | Timeout | Aciklama |
|---------|---------|----------|
| `st.language.analyze` | 10s | Parse + semantic analysis |
| `st.language.complete` | 3s | IntelliSense onerileri |
| `st.language.hover` | 3s | Hover tooltip |
| `st.language.format` | 5s | Kod formatlama |

Tenant bilgisi NATS header'inda tasinir (`x-tenant-id`).

#### 4.6.2 Event Contracts (sensor-service → diger servisler)

| Event Subject | Publisher | Consumer |
|---------------|-----------|----------|
| `events.AutomationProgramSaved.{tenantId}` | sensor-service | gateway-api (push), sensor-service (re-validate) |
| `events.AutomationProgramDeployed.{tenantId}` | sensor-service | gateway-api (push), notification-service |
| `events.AutomationTagsUpdated.{tenantId}` | sensor-service | gateway-api (IntelliSense invalidation) |
| `events.AutomationFBDefinitionsChanged.{tenantId}` | sensor-service | gateway-api (cross-ref update) |

---

## 5. Codesys Alim Listesi

### 5.1 Zorunlu Ürünler

| Ürün | Açiklama | Kullanim |
|------|----------|----------|
| **CODESYS Automation Server** | Merkezi yönetim platformu | ST derleme, PLC yönetimi, deployment |
| **CODESYS Development System** | IEC 61131-3 derleyici | Automation Server derleme bağımlılığı |
| **CODESYS Control for Linux SL** | x86 Linux PLC runtime | Endüstriyel PC'lerde çalıştırma |
| **CODESYS Control for Linux ARM SL** | ARM Linux PLC runtime | ARM cihazlarda çalıştırma |

### 5.2 Opsiyonel Ürünler

| Ürün | Kullanim |
|------|----------|
| **CODESYS Edge Gateway** | TLS ile güvenli PLC iletişimi |
| **CODESYS Virtual Control SL** | Test/simülasyon, CI/CD |
| **CODESYS OPC UA Server** | Dış SCADA entegrasyonu |

### 5.3 Resilience Patern Gereksinimleri (Faz 2)

| Patern | Konfigürasyon |
|--------|---------------|
| Circuit Breaker | 5 ardışık hata → OPEN, 30s → HALF_OPEN |
| Retry + Backoff | Max 3, base 1s, max 30s, jitter ±500ms |
| Connection Pooling | Max 5 bağlantı, idle 60s |
| Timeout | Compile: 120s, Deploy: 180s, Status: 10s |
| Bulkhead | Tenant başına max 2 compile, toplam max 10 |
| Health Check | 30s ping, 3 başarısız → alarm |

---

## 6. Implementation Plan

### Faz 1A — Temel Editör ve Parser (Hafta 1-2)

**Hedef:** Mevcut `StEditorPanel.tsx`'i genişleterek temel IDE deneyimi + ST parser çekirdeği.

| Görev | Dosya | Süre |
|-------|-------|------|
| Token tanimlari | `st-tokens.ts` | 2s |
| Keyword sozlugu | `st-keywords.ts` | 2s |
| Lexer | `st-lexer.ts` (max 100KB, 5s timeout) | 8s |
| AST node tipleri | `st-ast.ts` | 4s |
| Parser | `st-parser.ts` (composed expressions, 50 max depth) | 16s |
| Hata tipleri | `st-errors.ts` | 2s |
| Monarch tokenizer | `st-language.ts` (TIME literal renklendirme) | 4s |
| Statik completion | `st-completion.ts` (R_TRIG, F_TRIG, HYSTERESIS dahil) | 4s |
| Snippet tanimi | `st-snippets.ts` | 2s |
| Hover provider | `st-hover.ts` (statik doku) | 4s |
| Symbol table | `symbol-table.ts` | 6s |
| Tip kontrolu | `type-checker.ts` (TIME aritmetigi dahil) | 8s |
| Semantic analyzer | `semantic-analyzer.ts` | 8s |
| Editör container | `STEditorContainer.tsx` | 6s |
| Toolbar | `STEditorToolbar.tsx` | 3s |
| Monaco wrapper | `STMonacoEditor.tsx` | 4s |

**Faz 1A Toplam:** ~77 saat (~2 hafta)

### Faz 1B — Backend WS Gateway + Güvenlik (Hafta 3-4)

**Hedef:** Backend WS language service + güvenlik katmanı + dinamik IntelliSense.

| Görev | Dosya | Süre |
|-------|-------|------|
| WS Gateway | `st-language.gateway.ts` (JWT auth, tenant izolasyon) | 8s |
| Rate limiter | `st-ws-rate-limiter.ts` (10 msg/s, 100 msg/min) | 4s |
| Message DTO | `st-ws-message.dto.ts` (class-validator) | 3s |
| Language service | `st-language.service.ts` | 10s |
| Compiler interface | `compiler.interface.ts` + mock | 5s |
| WS hook | `useSTLanguageService.ts` | 6s |
| WS client | `st-websocket.service.ts` | 4s |
| Dinamik completion | SCADA tag + FB referans sorgulama | 6s |
| Diagnostics provider | `st-diagnostics.ts` | 4s |
| Definition/Reference | `st-definition.ts`, `st-references.ts` | 6s |
| Symbol provider | `st-symbols.ts` | 3s |
| PLC credential şifreleme | AES-256-GCM migration | 6s |
| Parser güvenlik limitleri | enforce 100KB, 50 depth, 5s | 2s |
| CORS | `buildWsCorsConfig()` pattern | 1s |

**Faz 1B Toplam:** ~78 saat (~2 hafta)

### Faz 1C — JSON Bundle + Panel'ler + Test (Hafta 5-6)

**Hedef:** JSON bundle sistemi, outline/problems panel, ARRAY/STRUCT desteği, kapsamlı test.

| Görev | Dosya | Süre |
|-------|-------|------|
| Bundle DTO | `json-bundle.dto.ts` (deployConfig reddi) | 4s |
| Bundle utils | `bundle.utils.ts` (sanitize, v1→v2 migration) | 6s |
| Export/Import dialog | `ExportDialog.tsx`, `ImportDialog.tsx` | 10s |
| GraphQL mutations | `exportAutomationBundle`, `importAutomationBundle` | 4s |
| Outline panel | `STOutlinePanel.tsx` (Tailwind recursive tree) | 6s |
| Problems panel | `STProblemsPanel.tsx` | 4s |
| ARRAY/STRUCT | parser güncelleme | 8s |
| Sayfa entegrasyonu | ST Code sekmesi degisim | 4s |
| Birim testleri | Lexer, parser, semantic (~260 senaryo) | 16s |
| Entegrasyon testleri | WS, bundle e2e | 8s |
| Güvenlik testleri | Prototype pollution, JWT bypass | 6s |

**Faz 1C Toplam:** ~78 saat (~2 hafta)

### Faz 1 Toplam: ~6 hafta (1 geliştirici)

---

## 7. Teknik Kararlar

| # | Karar | Seçim | Gerekçe |
|---|-------|-------|---------|
| 1 | Parser tipi | Recursive Descent | IEC 61131-3 grameri için yeterli, debug edilebilir |
| 2 | WS lib (backend) | `@nestjs/websockets` + `socket.io` | NestJS native, mevcut altyapı |
| 3 | WS lib (frontend) | `socket.io-client` (singleton) | Mevcut useSensorSocket pattern'i referans |
| 4 | Debounce | 300ms | Yazarken çok sık WS istegi gondermemek icin |
| 5 | AST format | TS discriminated unions | Tip güvenliği |
| 6 | JSON schema | JSON Schema Draft 7 | Standart |
| 7 | Outline ağacı | **lucide-react + Tailwind** (~~MUI TreeView~~) | MUI yok, 0 dependency, ~390KB tasarruf |
| 8 | Split panel | **Flexbox** (~~CSS Grid~~) | Mevcut tüm panel'ler Flexbox |
| 9 | Provider fazlama | **2 fazlı** (statik → dinamik) | Backend-dependent olanlar Faz 1B'de |
| 10 | Mevcut kod | **Baz al, genişlet** (~~sıfırdan yaz~~) | ~1259 satır çalışan kod mevcut |
| 11 | IEC kapsam | **~%90+** (~~%30~~) | 72 fonksiyon + 24 FB + 52 tip dönüşüm |

**Yeni dependency sayısı: 0** (tüm gerekli paketler projede zaten mevcut)

---

## 8. Faz 2 Roadmap (Codesys Entegrasyonu)

### Faz 2A — Codesys Altyapısı + Resilience (Hafta 7-9)

| Görev | Süre |
|-------|------|
| Automation Server kurulumu + lisans | 3 gün |
| REST API keşfi + Postman koleksiyonu | 2 gün |
| `CodesysClientService` + circuit breaker + retry | 5 gün |
| Bulkhead + health check + rate limit | 3 gün |
| SFC qualifier semantiği (N, P, S, R) | 2 gün |
| ICompilerService gerçek implementasyon | 1 gün |

### Faz 2B — Compile/Deploy Pipeline + Dual-Approval (Hafta 10-11)

| Görev | Süre |
|-------|------|
| Compile pipeline (ST → boot app → artifact) | 3 gün |
| Device-level lock (Redis distributed lock) | 2 gün |
| **Dual-approval (4-eyes principle)** — 2 farklı admin onayı | 3 gün |
| Deploy engine + rollback (son 5 versiyon) | 3 gün |
| Deploy UI + audit log | 3 gün |

### Faz 2C — Online Monitoring (Hafta 12-13)

| Görev | Süre |
|-------|------|
| Variable watch (PLC'den canlı okuma) | 3 gün |
| Watch panel UI (overlay) | 3 gün |
| Force values (TENANT_ADMIN yetkisi zorunlu) | 2 gün |
| Trace recorder + grafik | 5 gün |
| PLC durum paneli | 2 gün |

### Faz 2D — Debug Support + Online Change (Hafta 14+)

| Görev | Süre |
|-------|------|
| Breakpoint UI + backend | 4 gün |
| Single-step (into/over/out) | 3 gün |
| Call stack + variable inspection | 4 gün |
| Online change (PLC durdurmadan) | 3 gün |
| Debug güvenliği (30dk timeout) | 1 gün |

> Faz 2D tamami opsiyonel, Codesys debug API desteğine bağımlıdır.

### Faz 2 Toplam: ~8 hafta (1-2 geliştirici)

---

## 9. Güvenlik Gereksinimleri

### 9.1 P0 — Kritik (Faz 1'de Uygulanmalı)

**9.1.1 WebSocket Gateway JWT Authentication**
- Mevcut `SensorReadingsGateway` pattern'i: JWT in auth obj, tenant room izolasyonu
- Token'sız veya geçersiz token → bağlantı reddedilir

**9.1.2 ST Parser Güvenlik Limitleri**

| Limit | Değer | Aşım Davranışı |
|-------|-------|----------------|
| Max kod boyutu | 100 KB | `ST_CODE_TOO_LARGE`, parse başlamaz |
| Max nesting derinliği | 50 seviye | `ST_NESTING_TOO_DEEP`, parse durur |
| Parse timeout | 5 saniye | `ST_PARSE_TIMEOUT`, worker cancel |
| Max token sayısı | 500.000 | `ST_TOO_MANY_TOKENS`, lexer durur |
| Max hata sayısı | 100 | "too many errors" ile durur |

**9.1.3 WebSocket Rate Limiting**

| Limit | Değer |
|-------|-------|
| Mesaj/s (bağlantı) | 10 msg/s |
| Mesaj/dk (tenant) | 100 msg/min |
| Eşzamanlı bağlantı (tenant) | 5 |
| Mesaj boyutu | 150 KB |

**9.1.4 PLC Credential Şifreleme**
- AES-256-GCM ile mevcut plaintext → şifreli migration
- Anahtar: `PLC_CREDENTIAL_ENCRYPTION_KEY` env var (32 byte, base64)
- Anahtar yoksa servis başlatılmaz (fail-fast)

### 9.2 P1 — Yüksek (Faz 1B-1C)

- **PLC Deploy Dual-Approval:** 2 farklı TENANT_ADMIN onayı, aynı kullanıcı talep+onay yapamaz
- **JSON Bundle Sanitizasyon:** `__proto__` filtreleme, max 1MB, deployConfig strip
- **Multi-Tenant WS İzolasyon:** Tenant-scoped tag/program sorguları, room izolasyonu

### 9.3 P2 — Orta (Faz 1C veya Faz 2)

- WS message DTO validation (class-validator)
- CORS konfigürasyonu (buildWsCorsConfig pattern)
- ST kod güvenlik kuralları: sonsuz döngü, büyük ARRAY, recursive FB, division by zero

---

## 10. Test Stratejisi

### 10.1 Birim Testleri

| Test Grubu | Senaryo | Kapsam Hedefi |
|------------|---------|---------------|
| Lexer | ~86 (keyword, literal, operatör, yorum, hata, performans) | %95+ |
| Parser | ~95 (POU, VAR, kontrol, expression, TIME, ARRAY, hata kurtarma) | %90+ |
| Semantic Analyzer | ~58 (tip, scope, kullanılmayan var, güvenlik kuralları) | %85+ |
| Bundle | ~25 (geçerli, migration, güvenlik, edge case) | %95+ |

### 10.2 Entegrasyon Testleri

| Test Grubu | Senaryo |
|------------|---------|
| WS bağlantı (auth, token, tenant) | ~5 |
| WS analyze akışı | ~5 |
| WS rate limiting | ~5 |
| Bundle import/export e2e | ~5 |
| Editör entegrasyonu | ~3 |

### 10.3 Altyapı

- Jest + @nestjs/testing + React Testing Library
- CI: Her PR'da tüm testler, kapsam düşüşü → PR bloklanır
- Genel kapsam hedefi: **%85+**

---

## 11. Doğrulama Kriterleri

### 11.1 Faz 1A
- [ ] ST kodu (PROGRAM, FB, FUNCTION) tokenize ve parse edilebiliyor
- [ ] IF/FOR/WHILE/REPEAT/CASE + composed expressions (AND/OR/NOT) parse ediliyor
- [ ] TIME literal'leri (T#5s, T#100ms) tanınıyor
- [ ] R_TRIG, F_TRIG, HYSTERESIS IntelliSense'te görünüyor
- [ ] Monaco'da gelişmiş syntax highlighting çalışıyor
- [ ] Semantic analyzer tanımsız değişken ve tip uyumsuzluğu tespit ediyor

### 11.2 Faz 1B
- [ ] WS JWT auth çalışıyor (geçersiz token → bağlantı reddediliyor)
- [ ] Rate limiting çalışıyor (10 msg/s aşımında drop)
- [ ] Tenant izolasyonu sağlanmış
- [ ] Dinamik completion: SCADA tag'leri IntelliSense'te görünüyor
- [ ] PLC credential'ları AES-256-GCM ile şifrelenmiş

### 11.3 Faz 1C
- [ ] JSON bundle v2 export/import çalışıyor
- [ ] v1→v2 migration çalışıyor
- [ ] Import'ta deployConfig strip + prototype pollution koruması
- [ ] Outline + Problems panel çalışıyor
- [ ] ARRAY/STRUCT desteği
- [ ] Genel test kapsaması %85+

### 11.4 Performans Kriterleri

| Metrik | Hedef |
|--------|-------|
| Lexer throughput | 100KB < 200ms |
| Parser throughput | 100KB < 500ms |
| Semantic analysis | 100KB < 1s |
| WS round-trip (analyze) | < 500ms (p95) |
| IntelliSense latency | < 200ms (p95) |
| Scan cycle minimum | **1ms** |
