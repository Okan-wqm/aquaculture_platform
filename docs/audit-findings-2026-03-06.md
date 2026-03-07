# 8-Agent Audit Report - SCADA Builder & ST IDE
**Tarih:** 2026-03-06
**Kapsam:** Son commit'lerdeki SCADA Builder ve ST IDE degisiklikleri

---

## Ozet

| Agent | Odak | CRITICAL | HIGH | MEDIUM | LOW | TOPLAM |
|-------|------|----------|------|--------|-----|--------|
| 1 | TypeScript type safety | 2 | 14 | 11 | 12 | 39 |
| 2 | React patterns & hooks | 1 | 8 | 8 | 0 | 17 |
| 3 | Security & input validation | 0 | 3 | 7 | 4 | 14 |
| 4 | Performance & memory | 4 | 10 | 8 | 5 | 27 |
| 5 | Cross-layer consistency | 0 | 3 | 4 | 3 | 10 |
| 6 | UX & accessibility | 12 | 20 | 12 | 0 | 44 |
| 7 | Backend GraphQL | 1 | 4 | 7 | 3 | 15 |
| 8 | IEC 61131-3 compliance | 2 | 4 | 8 | 2 | 16 |
| **TOPLAM** | | **22** | **66** | **65** | **29** | **182** |

---

## CRITICAL Bulgular (20)

### C1. WebSocket Language Service Pipeline Tamamen Calismiyor (Agent 5)
- **Dosya:** Birden fazla dosya
- **Sorun:** 4 katmanli ariza zinciri:
  1. Frontend WS servisini hic cagirmiyor (`useStLanguageService` hic import edilmiyor)
  2. Socket.IO ack/event uyumsuz (gateway return vs client `st:response` event)
  3. 3/7 NATS subscription eksik (outline, definition, references)
  4. Response data cift sarmalanmis (bridge + gateway)
- **Etki:** Tum compile/validate islemleri sahte regex sonuclari donduruyor
- **Dosyalar:**
  - `web/modules/sensor-module/src/hooks/useStEditor.ts`
  - `web/modules/sensor-module/src/hooks/useStLanguageService.ts`
  - `apps/gateway-api/src/websocket/st-language.gateway.ts`
  - `apps/gateway-api/src/websocket/st-language-bridge.service.ts`
  - `apps/sensor-service/src/automation/compiler/nats-handlers/st-language.handler.ts`

### C2. Stale Closure - compile/validate Yanlis Kaynak Kodunu Isler (Agent 2 + 4)
- **Dosya:** `web/modules/sensor-module/src/hooks/useStEditor.ts:159-229`
- **Sorun:** `compile` ve `validate` callback'leri `activeProgram`'a bagli, her tuslama `activeProgram` referansini degistiriyor. 800ms delay ile eski kaynak kodu validate edilebiliyor.
- **Ayrica:** Her tuslama `compile`, `validate`, `save`, `formatCode` callback'larini yeniden olusturuyor ve 3 global event listener'i yeniden kaydettiriyor.

### C3. `toScadaPackageJSON()` Her Render'da Cagriliyor (Agent 4)
- **Dosya:** `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:511`
- **Sorun:** DeployScadaDialog'a `packageData={toScadaPackageJSON()}` her render'da cagiriliyor, dialog kapali olsa bile tum paket serialize ediliyor.

### C4. `onResize` Closure Tum Node Kimliklerini Bozuyor (Agent 4)
- **Dosya:** `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:129-133`
- **Sorun:** `storeNodes` memo icinde inline `onResize` fonksiyonu, `selectedWidgetId` degistiginde TUM node data referanslarini yeniliyor, 50 widget = 50 gereksiz re-render.

### C5. Monaco `options` Objesi Her Render'da Yeniden Olusturuluyor (Agent 4)
- **Dosya:** `web/modules/sensor-module/src/components/unified-editor/StEditorPanel.tsx:528-541`
- **Sorun:** Inline obje literali Monaco'nun her render'da diff yapmasina neden oluyor.

### C6. `validationResult` `any[]` Kullanir (Agent 1)
- **Dosya:** `web/modules/sensor-module/src/components/unified-editor/StEditorPanel.tsx:70`
- **Sorun:** `errors: any[]; warnings: any[]; infos: any[]` - Diagnostic tipini kullanmali.

### C7. `handleEditorMount` `any` Parametre Kullanir (Agent 1)
- **Dosya:** `web/modules/sensor-module/src/components/unified-editor/StEditorPanel.tsx:235`
- **Sorun:** `editor: any, monaco: any` - 20+ satir tiplanmamis kod.

### C8. `validateStructuredText` GraphQL Mutation Backend'de Yok (Agent 7)
- **Dosya:** `web/modules/sensor-module/src/graphql/automation.queries.ts:270-283`
- **Sorun:** Frontend mutation export ediyor ama backend resolver yok. Runtime'da her zaman basarisiz.

### C9. Preview Mode `pointer-events-none` Tum Etkilesimi Engelliyor (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:454`
- **Sorun:** Scroll, zoom, pan dahil tum pointer event'leri engelleniyor.

### C10. Program Silme Onay Dialogu Yok (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/components/unified-editor/StEditorPanel.tsx:483-492`
- **Sorun:** Trash ikonuna tiklamak aninda ve geri donusumsuz siliyor.

### C11. Widget Silme (Delete Tusu) Onay Yok (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:212-220`

### C12. Ekran Silme Onay Yok (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:104-107, 169-180, 238-248`

### C13. Adim/Degisken/Gecis Silme Onay ve aria-label Yok (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx`

### C14. Turke Karakterler Sistematik Olarak Eksik (Agent 6)
- **Dosyalar:** Tum 5 ana dosya
- **Sorun:** s->s (s yerine s), c->c (c yerine c), g->g, u->u, o->o, i->i, I->I eksik
- **Ornek:** "Ekrani Sil" -> "Ekrani Sil", "Cokla" -> "Cogalt", "Aciklama" -> "Aciklama"
- **~100+ instance** AutomationProgramEditorPage.tsx'de en yogun

### C15. Tab Bar ARIA Semantikleri Yok (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx:117-157`
- **Sorun:** `role="tablist"`, `role="tab"`, `aria-selected`, ok tusu navigasyonu yok.

### C16. Reject Modal Focus Trap Yok (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:614-651`

### C17. Toolbar Butonlarinda ARIA Label Yok (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/components/unified-editor/StEditorPanel.tsx:311-426`

### C18. Program List Ogeleri Klavye Erisimi Yok (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/components/unified-editor/StEditorPanel.tsx:467-494`

### C19. Paket Adi Input Label Yok (Agent 6)
- **Dosya:** `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx:289-295`

### C20. `DeploymentStatus` Isim Catismasi DTO vs Entity (Agent 7)
- **Dosya:** `apps/sensor-service/src/automation/dto/automation.dto.ts:996` vs `entities/deployment-log.entity.ts:17`
- **Sorun:** Ayni isimle `@ObjectType()` class ve `registerEnumType` enum kayitli.

---

## HIGH Bulgular (62)

### Performance (Agent 4)
- **H1.** `compile/validate/save/formatCode` her tuslama yeniden olusturuluyor (`useStEditor.ts:148-382`)
- **H2.** `beforeunload` handler her tuslama yeniden kaydediliyor (`useStEditor.ts:274-286`)
- **H3.** `buildOutline` debounce olmadan her tuslama calisiyor (`useStEditor.ts:296-361`)
- **H4.** `storeNodes` memo `selectedWidgetId`'ye bagli - 50 widget re-render (`ScreenCanvas.tsx:136`)
- **H5.** `onNodesChange` closure `widgets`'i yakalayip churn olusturuyor (`ScreenCanvas.tsx:195`)
- **H6.** Tum `screens` array'i her widget mutation'da klonlaniyor (`scadaPackageStore.ts:311-358`)
- **H7.** `handleWidgetConfigChange` `screens`'e bagli, her degisiklikte yeniden olusturuyor (`ScadaPackageBuilderPage.tsx:215-227`)
- **H8.** `handleAlarmRulesChange` ayni sorun (`ScadaPackageBuilderPage.tsx:230-249`)
- **H9.** Inline arrow'lar PropertiesPanel memo'sunu bozuyor (`ScadaPackageBuilderPage.tsx:466-477`)
- **H10.** `emergencyStop` default objesi her render'da yeniden olusturuluyor (`ScadaPackageBuilderPage.tsx:469-474`)

### TypeScript (Agent 1)
- **H11.** `as any` cast language config (`StEditorPanel.tsx:248`)
- **H12.** `as any` cast completion provider (`StEditorPanel.tsx:250-252`)
- **H13.** `languages.some` callback `any` kullanir (`StEditorPanel.tsx:241-243`)
- **H14.** `onDidChangeCursorPosition` parametre `any` (`StEditorPanel.tsx:256`)
- **H15.** `editorRef` `React.RefObject<any>` (`StEditorPanel.tsx:729`)
- **H16.** `navigateToLine` 3x `as any` cast (`useStEditor.ts:403-407`)
- **H17.** `editorRef`/`monacoRef` index signature escape (`useStEditor.ts:109-110`)
- **H18.** `programId` `useParams`'den `undefined` olabilir ama `string` olarak kullanilir (`AutomationProgramEditorPage.tsx:249`)
- **H19.** `DeployTarget` cast dogrulanmadan (`AutomationProgramEditorPage.tsx:344`)
- **H20.** `ProgramType` cast dogrulanmadan (`AutomationProgramEditorPage.tsx:866`)
- **H21.** `variant={'dots' as any}` ReactFlow (`ScreenCanvas.tsx:306`)
- **H22.** `Record<string, any>` widget config (`ScadaPackageBuilderPage.tsx:216`)
- **H23.** `Record<string, unknown>` -> `Record<string, any>` sessiz genisleme (`ScadaPackageBuilderPage.tsx:201-212`)
- **H24.** `JSON.parse` try-catch yok drop handler (`ScreenCanvas.tsx:236`)

### React (Agent 2)
- **H25.** Stale closure compile/validate (800ms delay) (`useStEditor.ts:159-200`)
- **H26.** Event listener churn per keystroke (`useStEditor.ts:403-439`)
- **H27.** `syncingFromStore` race condition (`ScreenCanvas.tsx:184-186`)
- **H28.** Stale `widgets` drag handler'da (`ScreenCanvas.tsx:175`)
- **H29.** `onResize` identity churn (`ScreenCanvas.tsx:129-133`)
- **H30.** Tum sayfa widget drag'da re-render (`ScadaPackageBuilderPage.tsx`)
- **H31.** `toScadaPackageJSON()` her render cagriliyor (`ScadaPackageBuilderPage.tsx:511`)
- **H32.** Monaco cursor listener dispose edilmiyor (`StEditorPanel.tsx:206-208`)

### Security (Agent 3)
- **H33.** `JSON.parse` on DnD data guvenliksiz (`ScreenCanvas.tsx:236`)
- **H34.** DnD data validation yok (`ScreenCanvas.tsx:236-242`)
- **H35.** `String.replace` injection program name ile (`AutomationProgramEditorPage.tsx`)

### Cross-Layer (Agent 5)
- **H36.** `useStLanguageService` tamamen disconnected (`useStEditor.ts`, `StEditorPanel.tsx`)
- **H37.** NATS handler 4/7 subject'e subscribe (3 eksik) (`st-language.handler.ts:77-88`)
- **H38.** Gateway Socket.IO ack vs client `st:response` event uyumsuz (`st-language.gateway.ts:204`, `st-websocket.service.ts:96,151`)

### Backend GraphQL (Agent 7)
- **H39.** `AutomationEventsPublisher` hic cagirilmiyor, NATS event zinciri olu (`automation.service.ts`)
- **H40.** `varName` MaxLength uyumsuzluk: DTO 100, entity 50 - DB crash (`automation.dto.ts:698`, `program-variable.entity.ts:78`)
- **H41.** NATS handler 3 subject eksik (Agent 5 ile ayni bulgu) (`st-language.handler.ts:77-88`)
- **H42.** MAX_CONNECTIONS_PER_TENANT uyumsuz: gateway 50 vs constants 5 (`st-language.gateway.ts:74`, `compiler.constants.ts:35`)

### UX (Agent 6)
- **H43.** Resize handle klavye erisimi yok (`StEditorPanel.tsx:303-306`)
- **H44.** Toolbar `role="toolbar"` yok (`StEditorPanel.tsx:309`)
- **H45.** CompileStatusBadge accessible text yok (`StEditorPanel.tsx:620-656`)
- **H46.** Export/Import dialog focus management yok (`StEditorPanel.tsx:596-613`)
- **H47.** Canvas acil durumda islem rehberligi yok (`ScreenCanvas.tsx:278-282`)
- **H48.** ReactFlow canvas ARIA label yok (`ScreenCanvas.tsx:287-324`)
- **H49.** Drop handler hata yonetimi yok (`ScreenCanvas.tsx:236`)
- **H50.** Klavye ile widget ekleme yok (`ScreenCanvas.tsx:223-275`)
- **H51.** Context menu position off-screen olabilir (`ScreenTabBar.tsx:83,214`)
- **H52.** Context menu klavye erisimi yok (`ScreenTabBar.tsx:205-251`)
- **H53.** Add screen dropdown ARIA yok (`ScreenTabBar.tsx:182-201`)
- **H54.** Dropdown/context menu kapatildiginda focus kaybi (`ScreenTabBar.tsx:62-73`)
- **H55.** Rename input accessible label yok (`ScreenTabBar.tsx:122-136`)
- **H56.** Device dropdown focus yonetimi yok (`ScadaPackageBuilderPage.tsx:331-374`)
- **H57.** Deploy menu ARIA yok (`ScadaPackageBuilderPage.tsx:410-416`)
- **H58.** Save hata geri bildirimi yok (`ScadaPackageBuilderPage.tsx:184-185`)
- **H59.** Save button disabled contrast yetersiz (`ScadaPackageBuilderPage.tsx:383-387`)
- **H60.** Tab bar ARIA yok (`AutomationProgramEditorPage.tsx:156-179`)
- **H61.** Form input label'lari eksik (`AutomationProgramEditorPage.tsx:913-1265`)
- **H62.** Rollback button click handler yok (`AutomationProgramEditorPage.tsx:1472-1478`)

---

## MEDIUM Bulgular (57)

### Performance
- M1. `duplicateScreen` shallow clone - nested config paylasimi (`scadaPackageStore.ts:261-264`)
- M2. `syncingFromStore` flag reset rAF ile fragile (`ScreenCanvas.tsx:184-186`)
- M3. Bos array referansi her render degisiyor (`ScreenCanvas.tsx:86-87`)
- M4. `getScreenViewport` default obje her cagirida yeni (`scadaPackageStore.ts:299-302`)
- M5. Monaco `onChange` her render yeni fonksiyon (`StEditorPanel.tsx:526`)
- M6. Cursor position listener dispose edilmiyor (`StEditorPanel.tsx:206-208`)
- M7. `updateSource` programs array map'liyor her tuslama (`useStEditor.ts:135-144`)
- M8. `compile` `src.split('\n')` 2 kez cagiriyor (`useStEditor.ts:175,186`)

### TypeScript
- M9. `d.severity` cast chain fragile (`StEditorPanel.tsx:301`)
- M10. Kullanilmayan `prog` degiskeni (`StEditorPanel.tsx:326`)
- M11. `useStEditor` return type explicit degil (`useStEditor.ts:60`)
- M12. `compile/validate` `undefined | CompileDiagnostic[]` donuyor (`useStEditor.ts:174,219`)
- M13. `applyMarkers` kullanilmadan once ataniyor (`useStEditor.ts:212,241`)
- M14. `graphqlFetch` type parameter yok (`AutomationProgramEditorPage.tsx:382+`)
- M15. `data?.programSteps || []` `||` vs `??` (`AutomationProgramEditorPage.tsx:561-563`)
- M16. `handleMutationError` return type yok (`AutomationProgramEditorPage.tsx:358-361`)
- M17. `JSON.parse` try-catch yok (`ScreenCanvas.tsx:236`)
- M18. `w.config?.label as string` unsafe cast (`ScreenCanvas.tsx:127-128`)

### Security
- M19. Prototype pollution korumasi eksik JSON import (`StEditorPanel.tsx`)
- M20. Max program sayisi siniri yok (`useStEditor.ts`)
- M21. Widget config validation yok (`ScreenCanvas.tsx`)
- M22. Context menu XSS riski (`ScreenTabBar.tsx`)
- M23. Form input sanitization yok (`AutomationProgramEditorPage.tsx`)
- M24. CSRF token yok GraphQL mutation'larinda (`automation.queries.ts`)
- M25. Rate limiting yok frontend'de (`useStEditor.ts`)

### Cross-Layer
- M26. `validateStructuredText` GraphQL mutation backend yok (`automation.queries.ts:270-283`)
- M27. Gateway error response `data:` vs frontend `error:` alani uyumsuz (`st-language.gateway.ts:414`, `st-websocket.service.ts:96-108`)
- M28. `useStEditor.save()` backend persistence yok (TODO) (`useStEditor.ts:154`)
- M29. NATS reply double-wrapped (`st-language-bridge.service.ts:160-166`, `st-language.gateway.ts:268-275`)

### Backend GraphQL
- M30. `DEPLOY_PROGRAM_MUTATION` eksik alanlar istemiyor (`automation.queries.ts:196-205`)
- M31. `automationPrograms` N+1 sorgu (stepCount/transitionCount/variableCount) (`automation.resolver.ts:634-667`)
- M32. Pagination metadata yok (`automation.queries.ts:12-41`)
- M33. NATS event subject tenant ID dot riski (`compiler.constants.ts:122-124`)
- M34. WS `STRequest.range` hic tuketilmiyor (`st-language.gateway.ts:32`)
- M35. MAX_CONNECTIONS_PER_TENANT tutarsiz (50 vs 5) (`st-language.gateway.ts:74`, `compiler.constants.ts:35`)
- M36. `DEPLOY_SCADA_PACKAGE` mutation 2 dosyada tanimli (`scada-package.queries.ts:66`, `scada-deploy.queries.ts:3`)

### UX
- M37-M57. Cesitli ARIA, label, landmark, contrast, loading state, focus, navigation sorunlari (detay yukarida)

---

## LOW Bulgular (27)

### TypeScript
- L1-L12. Return type annotations, unused state vars, enum typing, magic numbers (detay yukarida)

### Security
- L13-L16. CSP, cookie flags, error exposure, debug console.log (detay yukarida)

### Cross-Layer
- L17. Frontend `STErrorCode` `RATE_LIMITED` eksik (`st-editor.types.ts:152-159`)
- L18. `OutlineNode` vs `STOutlineNode` tip uyumsuzlugu (`useStEditor.ts:21-28`)
- L19. Deploy button (F9) no-op (`useStEditor.ts:424-427`)

### Backend
- L20. `unlockProgram` resolver userId/isTenantAdmin gondermiyor (`automation.resolver.ts:524-529`)
- L21. `useStEditor` WS entegrasyonu yok (bilinen gap) (`useStEditor.ts`)

### Performance
- L22-L27. RegExp in loop, timeout cleanup, ID collision risk, wrapper callbacks (detay yukarida)

---

## Oncelikli Fix Listesi

### Sprint 1: Kritik Duzeltmeler (Hemen)
1. **SCADA Builder canvas sorunu** - Widget surukle-birak calismasi lazim
2. **Turkce karakterler** - Tum dosyalarda sistematik duzeltme
3. **Stale closure fix** - useStEditor ref pattern'e gec
4. **toScadaPackageJSON** - Conditional render veya useMemo
5. **JSON.parse try-catch** - Drop handler guvenlik
6. **pointer-events-none** - Preview mode duzeltme
7. **Monaco options** - Module-level constant

### Sprint 2: HIGH Duzeltmeler
8. **selectedWidgetId memo** - storeNodes'dan cikar
9. **onResize stabilize** - Context veya stable ref
10. **beforeunload ref pattern** - Ref kullan, empty deps
11. **buildOutline debounce** - 300ms setTimeout
12. **varName MaxLength** - DTO 50 veya entity 100
13. **DeploymentStatus isim catismasi** - DTO rename
14. **Silme islemleri onay dialogu** - Tum destructive actions
15. **ARIA semantikleri** - Tab bar, toolbar, dropdown

### Sprint 3: Entegrasyon
16. **WS Language Service wiring** - useStLanguageService bagla
17. **Socket.IO ack pattern** - Gateway veya client duzelt
18. **NATS subscriptions** - 3 eksik subject ekle
19. **Response unwrap** - Bridge double-wrap duzelt
20. **AutomationEventsPublisher** - Service'e inject et

---

## Agent 8: IEC 61131-3 Compliance Bulgulari

### CRITICAL
- **IEC-C1.** Semantic analyzer parser'in AST tipleriyle UYUMSUZ - `kind: 'identifier'` vs `type: 'Identifier'`. Semantic analyzer olu kod. (`semantic-analyzer.ts:44-274`)
- **IEC-C2.** SHL/SHR/ROL/ROR binary operator olarak isleniyor ama IEC 61131-3'te FONKSIYON. (`st-parser.ts:98-101`)

### HIGH
- **IEC-H1.** `**` (POWER) sag-iliskilendirme bozuk - ternary'de iki dal ayni. `2**3**4 = (2**3)**4` olarak isleniyor, dogru: `2**(3**4)`. (`st-parser.ts:1442-1444`)
- **IEC-H2.** Typed literal tip oneki AST'de kayboluyor - `INT#5` vs `DINT#5` ayirt edilemiyor. (`st-parser.ts:1600-1608`)
- **IEC-H3.** Cross-family implicit conversion eksik (INT->REAL). (`type-checker.ts:301-331`)
- **IEC-H4.** Iki yarisan Monaco dil tanimi farkli ID'lerle (`iec61131-st` vs `structured-text`). (`st-language.ts` vs `st-language-enhanced.ts`)

### MEDIUM
- **IEC-M1.** TIME literal scanner gecersiz birim kabul ediyor (`T#5x3q`). (`st-lexer.ts:548-557`)
- **IEC-M2.** DATE literal scanner gecersiz format kabul ediyor (`D#999-999-999`). (`st-lexer.ts:560-565`)
- **IEC-M3.** VAR_OUTPUT caller-side write kisitlamasi uygulanmiyor. (`semantic-analyzer.ts`)
- **IEC-M4.** WSTRING birlestirilince STRING donuyor. (`type-checker.ts:147`)
- **IEC-M5.** Mixed signed/unsigned DINT'e default ediyor, minimum safe tip hesaplanmiyor. (`type-checker.ts:402`)
- **IEC-M6.** REPEAT...UNTIL formatter'da noktali virgul eksik. (`st-formatter.ts:584`)
- **IEC-M7.** CONTINUE keyword Monaco'da var ama IEC standardinda yok. (`st-language.ts:50`, `st-language-enhanced.ts:69`)
- **IEC-M8.** IntelliSense completions eksik (FUNCTION, METHOD, REPEAT snippets yok). (`st-language.ts:133-152`)

### LOW
- **IEC-L1.** OOP keywords (EXTENDS, IMPLEMENTS) token olarak tanimlanmamis. (`st-keywords.ts`)
- **IEC-L2.** Basic Monaco cift tirnak string highlight eksik. (`st-language.ts:98`)

---

## Ek: SCADA Builder Canvas Sorunu (Investigasyon)

### ROOT CAUSE: Canvas 0 yukseklige dusuyoryuzden
- **Dosya:** `ScadaPackageBuilderPage.tsx:454`
- **Sorun:** `<div className="flex-1">` parent div'de `display: flex` yok. CanvasInner'daki `<div className="flex-1">` flex parent olmadan calismiyor, yukseklik 0'a dusuyor.
- **Fix:** Parent div'e `flex flex-col` ekle veya ScreenCanvas wrapper'ina `h-full` ekle.
