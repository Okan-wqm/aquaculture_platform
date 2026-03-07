# ST IDE Durum Raporu - 2026-03-07

## Ozet

ST IDE plani (`docs/plans/ST-plan.md`) 847 satirlik kapsamli bir tasarim dokumani.
Implementasyon ~14,200 satir kod uretmis ancak **4 kritik entegrasyon hatasi** nedeniyle
ST language service (IntelliSense, diagnostics, formatting) **fiilen calismamaktadir**.

Automation sayfasi (`/sensor/automation/new`) **temel islevleri calisiyor**:
program olusturma, ST kodu yazma, kaydetme, listeleme. Ancak gercek zamani
dil servisleri (compile, validate, autocomplete, go-to-definition) mock/stub durumunda.

---

## 1. Ne Uygulanmis? (Tamamlanan Kisimlar)

### 1.1 Compiler Pipeline (9,080 satir - PRODUCTION-QUALITY)

| Bilesen | Dosya | Satir | Durum |
|---------|-------|-------|-------|
| Lexer | `compiler/lexer/` | 582 | URETIM KALITESI - El yazimi, regex yok |
| Parser | `compiler/parser/st-parser.ts` | 1,786 | URETIM KALITESI - Recursive descent + Pratt |
| AST Types | `compiler/parser/st-ast.ts` | 533 | TAM |
| Semantic Analyzer | `compiler/analyzer/semantic-analyzer.ts` | 1,188 | KOD VAR ama ENTEGRE DEGIL |
| Type Checker | `compiler/analyzer/type-checker.ts` | ~500 | KOD VAR ama semantic analyzer'a bagimli |
| Symbol Table | `compiler/analyzer/symbol-table.ts` | 555 | TAM - 27 fonksiyon, 23 FB, tip donusumleri |
| Formatter | `compiler/formatter/st-formatter.ts` | 765 | TAM - Parser AST'sini dogru kullaniyor |
| Worker Thread | `compiler/worker/st-worker.ts` | 417 | KISMEN - piscina handler, 7 task tipi |
| NATS Handler | `compiler/nats-handlers/st-language.handler.ts` | ~200 | KISMEN - 4/7 subject |
| WS Gateway | `gateway-api/websocket/st-language.gateway.ts` | ~300 | TAM ama protokol hatasi |
| WS Bridge | `gateway-api/websocket/st-language-bridge.service.ts` | ~200 | TAM ama double-wrapping |
| Frontend WS Service | `services/st-websocket.service.ts` | ~150 | TAM ama ack/event uyumsuzlugu |
| Frontend Hook | `hooks/useStLanguageService.ts` | ~100 | TAM ama HICBIR YERDE IMPORT EDILMIYOR |

### 1.2 Frontend Sayfalari (CALISIYOR)

| Bilesen | Dosya | Durum |
|---------|-------|-------|
| Program Listesi | `AutomationProgramsPage.tsx` | CALISIYOR |
| Program Editoru | `AutomationProgramEditorPage.tsx` | CALISIYOR (temel islevler) |
| ST Editor Panel | `StEditorPanel.tsx` | CALISIYOR (Monaco editor, embedded mode) |
| Route Tanimlari | `Module.tsx` satirlar 107-109 | DOGRU |
| Sidebar Link | `SensorSidebar.tsx` | DOGRU |
| GraphQL Queries | `automation.queries.ts` | 16 query/mutation UYUMLU |

### 1.3 Backend Resolver/Service (CALISIYOR)

| Bilesen | Dosya | Durum |
|---------|-------|-------|
| AutomationResolver | `automation.resolver.ts` | 11 query + 24 mutation |
| AutomationService | `automation.service.ts` | TAM CRUD + deploy |
| Entity'ler | `entities/*.entity.ts` | 6 entity (Program, Step, StepAction, Transition, Variable, DeploymentLog) |
| CompilerModule | `compiler/compiler.module.ts` | Dogru wire edilmis |

### 1.4 IEC 61131-3 Uyumluluk

| Kategori | Skor | Detay |
|----------|------|-------|
| Standart FB'ler | **%100** | 10/10 zorunlu (TON, TOF, TP, CTU, CTD, CTUD, SR, RS, R_TRIG, F_TRIG) + 12 bonus |
| POU Tipleri | **%100+** | PROGRAM, FB, FUNCTION + METHOD, PROPERTY, INTERFACE |
| Var Bloklari | **%100** | VAR, VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_GLOBAL, VAR_TEMP, VAR_EXTERNAL + CONSTANT, RETAIN |
| Kontrol Yapilari | **%100** | IF, CASE, FOR, WHILE, REPEAT, RETURN, EXIT |
| Veri Tipleri | **%100** | Tum elementary + ARRAY, STRUCT, ENUM, Subrange, WSTRING |
| Literal Formatlar | **%100** | Integer, Real, String, Bool, Time, Date, Hex, Octal, Binary, Typed prefix |
| Standart Fonksiyonlar | **%66** | 33/50 (opertor fonksiyon formlari eksik: ADD, SUB, MUL, DIV, MOD, GT, GE, EQ, LE, LT, NE, AND, OR, XOR, NOT) |
| Tip Donusumleri | **%90** | 462 otomatik uretim (BCD donusumleri eksik) |
| Opertor Onceligi | **%95** | 8/9 seviye (SHL/SHR/ROL/ROR birlesmis) |

---

## 2. Ne Calismiyorr? (4 Katmanli Ariza Zinciri)

### KRITIK BUG #1: useStLanguageService Hicbir Yerde Import Edilmiyor

**Dosya:** `hooks/useStLanguageService.ts`
**Etkilenen:** `hooks/useStEditor.ts`

`useStEditor.ts` tamamen **mock** implementasyon kullaniyor:
- `compile()` -> `setTimeout(r, 800)` ile sahte delay, regex eslesmesi
- `validate()` -> sadece GOTO kullanimi arayan sahte validator
- `buildOutline()` -> lokal regex parse
- `formatCode()` -> lokal indent hesaplama

`useStLanguageService()` hook'u yazilmis ama `useStEditor` icinde **import edilmemiyor**.
Yani tum backend pipeline dead code.

**Duzeltme:** `useStEditor.ts`'de `useStLanguageService()` import edip mock'lari
gercek WS cagrilariyla degistirmek.

---

### KRITIK BUG #2: WebSocket Ack vs Event Protokol Uyumsuzlugu

**Frontend:** `st-websocket.service.ts` satir 96 - `this.socket.on('st:response', ...)` dinliyor
**Backend:** `st-language.gateway.ts` - `@SubscribeMessage('st:request')` return degeri donduruyor

NestJS `@SubscribeMessage` dekoratoru return degerini **acknowledgement callback** olarak gonderir,
`st:response` event'i **hicbir zaman emit etmez**. Frontend sonsuza dek bekleyip timeout olur.

**Duzeltme:** Frontend'deki `request()` metodunu NestJS ack pattern'ine cevirmek:
```typescript
this.socket.emit('st:request', req, (response: STResponse) => {
  clearTimeout(timer);
  resolve(response);
});
```

---

### KRITIK BUG #3: NATS Response Double-Wrapping

**Dosya:** `st-language-bridge.service.ts` satir 146-167

Bridge `NatsLanguageReply` objesini olduğu gibi donduruyor. Gateway bunu tekrar sariyor:
```json
{
  "type": "diagnostics",
  "data": {                    // 1. katman (Gateway)
    "success": true,
    "type": "diagnostics",
    "data": [ ...diagnostics ] // 2. katman (NATS reply)
  }
}
```

Frontend `response.data` diye eristiginde `NatsLanguageReply` objesini alir, gercek veriyi degil.

**Duzeltme:** Gateway'de `natsReply.data` olarak unwrap etmek.

---

### KRITIK BUG #4: 3 NATS Subject Dinleyicisi Eksik

**Dosya:** `st-language.handler.ts`

7 NATS subject tanimli, sadece 4'une subscribe edilmis:
- ✅ `st.language.analyze`
- ✅ `st.language.complete`
- ✅ `st.language.hover`
- ✅ `st.language.format`
- ❌ `st.language.outline` - Eksik
- ❌ `st.language.definition` - Eksik
- ❌ `st.language.references` - Eksik

**Duzeltme:** 3 handler metodu ve subscription eklemek.

---

### KRITIK BUG #5: Semantic Analyzer AST Uyumsuzlugu

**Parser AST:** `kind: 'program'`, `location: SourceLocation`
**Semantic Analyzer AST:** `type: 'Program'`, `loc: ASTLocation`

Iki farkli AST formati kullaniliyor. Worker thread icinde `try/catch` ile sessizce basarisiz oluyor.
Semantic analiz (tip kontrolu, degisken dogrulama) **fiilen calismamaktadir**.

**Duzeltme:** Semantic analyzer'i parser'in `kind`-tabanli AST'sini kullanacak sekilde yeniden yazmak.

---

### KRITIK BUG #6: `**` Operatoru Right-Associativity

**Dosya:** `st-parser.ts` satir 1443

```typescript
const nextMinPrec = opToken.type === TokenType.POWER ? prec : prec;
```

Ternary'nin iki kolu ayni deger - **no-op**. `**` left-associative olarak parse ediliyor.
IEC 61131-3'e gore `2 ** 3 ** 4` = `2 ** (3 ** 4)` olmalidir.

**Duzeltme:** `prec : prec` -> `prec - 1 : prec`

---

### KRITIK BUG #7: Worker Pool STUB

**Dosya:** `services/st-worker-pool.service.ts` (boş sonuç dönüyor)
**Gercek pool:** `worker/st-worker-pool.service.ts` (piscina) - mevcut ama import edilmiyor

**Duzeltme:** `services/` stub'i silinip `worker/` versiyonu kullanilmali.

---

## 3. Diger Sorunlar

### Backend

| # | Seviye | Sorun | Dosya |
|---|--------|-------|-------|
| B1 | KRITIK | `validateStructuredText` mutation backend'de yok | `automation.resolver.ts` |
| B2 | KRITIK | `AutomationEventsPublisher` inject edilmemis, NATS event'leri yayinlanmiyor | `automation.service.ts` |
| B3 | BILGI | 13 backend mutation/query frontend'de tanimlanmamis (lockProgram, rollback, vb.) | `automation.queries.ts` |

### Frontend

| # | Seviye | Sorun | Dosya |
|---|--------|-------|-------|
| F1 | ORTA | Ctrl+S embedded modda backend'e kaydetmiyor | `useStEditor.ts:172-180` |
| F2 | DUSUK | Compile/Validate mock sonuc veriyor | `useStEditor.ts:184-258` |
| F3 | DUSUK | "New" butonu embedded modda yaniltici | `StEditorPanel.tsx:413-423` |
| F4 | COK DUSUK | Export/Import local state kullanir | `StEditorPanel.tsx:499-517` |

### Edge SCADA Uyumlulugu

| # | Seviye | Sorun | Dosya |
|---|--------|-------|-------|
| E1 | KOZMETIK | Screen ikon eslesmesi - Lucide vs emoji | `scada-edge.html:1238` |

---

## 4. Duzeltme Oncelik Sirasi

### Sprint 1: ST Language Service Canlandirma (4 is)

1. **useStEditor.ts icinde useStLanguageService import et** - Mock'lari gercek WS cagrilarina bagla
2. **st-websocket.service.ts'de ack pattern'e gec** - `socket.emit('st:request', req, callback)`
3. **Gateway'de response unwrap** - `natsReply.data` olarak ic veriyi cikar
4. **NATS handler'a 3 eksik subscription ekle** - outline, definition, references

### Sprint 2: Compiler Pipeline Duzeltmeleri (3 is)

5. **Semantic analyzer AST uyumsuzlugunu coz** - `kind` vs `type` donusumu veya yeniden yazim
6. **`**` operatoru right-associativity duzelt** - `prec - 1`
7. **Worker pool stub'i gercek piscina ile degistir**

### Sprint 3: Backend Entegrasyon (2 is)

8. **validateStructuredText resolver ekle** - CompilerModule'deki parser'a delege et
9. **AutomationEventsPublisher inject et** - CRUD/deploy islemlerinde event publish et

### Sprint 4: UX Iyilestirmeler (4 is)

10. **Ctrl+S embedded modda parent handleSave'i cagirsin**
11. **hideActions'a 'new' secenegi ekle**
12. **Screen ikon eslesmesini duzelt** (edge runtime)
13. **Eksik operator fonksiyon formlarini ekle** (ADD, SUB vb. fonksiyon olarak)

---

## 5. Sonuc

| Metrik | Deger |
|--------|-------|
| Toplam yazilan kod | ~14,200 satir |
| Frontend sayfalar/bilesenler | CALISIYOR (temel islevler) |
| Backend CRUD + deploy | CALISIYOR |
| IEC 61131-3 lexer/parser | URETIM KALITESI |
| IEC 61131-3 standart kutuphane | %80+ |
| Language service pipeline | CALISMIYORR (4 katmanli ariza) |
| Semantic analiz | CALISMIYORR (AST uyumsuzlugu) |
| Edge SCADA uyumlulugu | %95+ (1 kozmetik sorun) |
| GraphQL frontend-backend uyumu | %95+ (2 eksik) |

**Genel degerlendirme:** ST IDE'nin compiler altyapisi saglam (lexer, parser, AST, formatter uretim kalitesinde).
Ancak bu altyapi frontend'e baglanmamis durumda. 4 katmanli entegrasyon ariza zinciri nedeniyle
tum language service ozellikleri (diagnostics, autocomplete, hover, go-to-definition, formatting)
mock/stub olarak calisiyor. Sprint 1'deki 4 duzeltme ile pipeline canlandirilabilir.
