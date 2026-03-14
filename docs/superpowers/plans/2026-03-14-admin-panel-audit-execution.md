# Admin Panel Audit -- Orkestrasyon Uygulama Plani

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin panel (frontend + backend) icin 18 planli ajan + dinamik deep-dive/resolver ajanlari ile kapsamli statik kod auditi calistirmak.

**Architecture:** Dalga-bazli orkestrasyon. 4'er ajanlik paralel batch'ler halinde calisir. Her dalga sonrasinda orkestrator raporlari degerlendirir, spawn talepleri toplar, gerekirse deep-dive/resolver ajanlari olusturur. Tum raporlar `docs/audits/admin-panel/2026-03-14/` altina yazilir.

**Tech Stack:** Claude Code Agent tool (opus model), Markdown raporlar, dosya sistemi uzerinden ajan-arasi iletisim.

**Spec:** `docs/superpowers/specs/2026-03-14-admin-panel-audit-design.md`

---

## Chunk 1: Hazirlik ve Dalga 1 (Kesif)

### Task 1: Dizin Yapisini Olustur

**Files:**
- Create: `docs/audits/admin-panel/2026-03-14/wave-1/` (dizin)
- Create: `docs/audits/admin-panel/2026-03-14/wave-2a/` (dizin)
- Create: `docs/audits/admin-panel/2026-03-14/wave-2b/` (dizin)
- Create: `docs/audits/admin-panel/2026-03-14/deep-dives/` (dizin)
- Create: `docs/audits/admin-panel/2026-03-14/resolvers/` (dizin)
- Create: `docs/audits/admin-panel/2026-03-14/wave-3/` (dizin)
- Create: `docs/audits/admin-panel/2026-03-14/wave-4/` (dizin)

- [ ] **Step 1: Tum dizinleri olustur**

```bash
mkdir -p docs/audits/admin-panel/2026-03-14/{wave-1,wave-2a,wave-2b,deep-dives,resolvers,wave-3,wave-4}
```

---

### Task 2: Dalga 1 -- 4 Kesif Ajani (Paralel)

4 ajani tek bir mesajda paralel spawn et. Her biri kendi raporunu yazar.

- [ ] **Step 1: 4 ajani paralel spawn et**

Asagidaki 4 Agent tool cagrisini **tek mesajda** gonder:

**Ajan P1 -- Frontend Haritaci:**
```
subagent_type: admin-panel
model: opus
name: P1-frontend-map
prompt: |
  Sen admin panel audit ekibinin Frontend Haritaci ajanisisin (P1).

  ## GOREV
  Admin panel frontend kod tabaninin yapisal haritasini cikar.

  ## KONTROL LISTESI
  1. web/modules/admin-panel/src/ altindaki her dosyanin tam yolunu ve satir sayisini listele
  2. 500+ satirlik dosyalari [BUYUK] etiketi ile isaretle
  3. Her sayfa icin data fetch pattern'ini belirle ve etiketle:
     - [API] -- adminApi.ts uzerinden veri cekiyor
     - [ASYNC] -- useAsyncData hook'u kullaniyor
     - [DIRECT_FETCH] -- Kendi fetch() cagrisi var, adminApi.ts bypass ediyor
     - [MOCK] -- API cagrisi yok, hardcoded/mock data kullaniyor
     - [MIXED] -- Birden fazla pattern karisik
  4. Component -> hook -> service import dependency graph'ini ciz
  5. Kullanilmayan export'lari tespit et
  6. Module.tsx'teki route'lari listele (path + component eslesmesi)
  7. React.lazy kullanimini kontrol et (var mi yok mu)

  KRITIK: "Bu sayfa gercekten API'ye baglanmis mi?" sorusunu HER SAYFA icin sor.

  ## RAPOR FORMATI
  Raporun su bolumleri icersin:
  - Yonetici Ozeti (3-5 cumle)
  - Dosya Envanteri (tablo: dosya yolu, satir sayisi, etiket)
  - Data Fetch Pattern Haritasi (sayfa bazinda)
  - Dependency Graph
  - Route Haritasi
  - Bulgular (varsa spawn talepleri)

  ## CIKTI
  Raporunu docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md dosyasina yaz.
  Maksimum 1000 satir.
```

**Ajan P2 -- Backend Haritaci:**
```
subagent_type: admin-api-service
model: opus
name: P2-backend-map
prompt: |
  Sen admin panel audit ekibinin Backend Haritaci ajanisisin (P2).

  ## GOREV
  Admin API Service backend kod tabaninin yapisal haritasini cikar.

  ## KONTROL LISTESI
  1. apps/admin-api-service/src/ altindaki her controller icin: dosya yolu, HTTP method+path listesi, guard durumu (@UseGuards var/yok, @Public() var/yok)
  2. Her service icin: dosya yolu, inject ettigi dependency'ler, public method'lar
  3. Her entity icin: dosya yolu, tablo adi, iliskiler, schema
  4. CQRS kullanim haritasi: hangi moduller CommandBus/QueryBus kullaniyor, hangileri klasik pattern
  5. Modul yapisi: her NestJS module'un import/export/providers/controllers
  6. Admin identity alinma sekli: her endpoint'te admin kimligini nereden aliyor? (req.user JWT mi, @Query('adminId') client-supplied mi)
  7. ThrottlerGuard durumu: global guard var mi, per-route throttle var mi

  ## RAPOR FORMATI
  - Yonetici Ozeti (3-5 cumle)
  - Controller Haritasi (tablo: controller, endpoint'ler, guard, identity source)
  - Service Haritasi (tablo: service, dependency'ler, public method'lar)
  - Entity Haritasi (tablo: entity, tablo, iliskiler, schema)
  - CQRS Durum Haritasi
  - Bulgular + Spawn Talepleri

  ## CIKTI
  Raporunu docs/audits/admin-panel/2026-03-14/wave-1/02-backend-map.md dosyasina yaz.
  Maksimum 1000 satir.
```

**Ajan P3 -- Kontrat Haritaci:**
```
subagent_type: general-purpose
model: opus
name: P3-contract-map
prompt: |
  Sen admin panel audit ekibinin Kontrat Haritaci ajanisisin (P3).

  ## GOREV
  Frontend'in cagirdigi tum API endpoint'leri ile backend'in sundugu endpoint'leri eslestir.

  ## HEDEF DOSYALAR
  Frontend API cagrilari:
  - web/modules/admin-panel/src/services/adminApi.ts (3116 satir, ana API client)
  - web/modules/admin-panel/src/pages/DatabaseExplorerPage.tsx (dogrudan fetch -- adminApi bypass)
  - web/modules/admin-panel/src/components/database/*.tsx (dogrudan fetch)
  - web/modules/admin-panel/src/hooks/useUserPermissions.ts
  - Diger tum pages/*.tsx dosyalarinda dogrudan fetch() cagrilari

  Backend endpoint'ler:
  - apps/admin-api-service/src/**/*.controller.ts (33 controller)

  ## KONTROL LISTESI
  1. Frontend'teki TUM API cagrilarini tara (adminApi.ts + dogrudan fetch yapan diger dosyalar)
  2. Her cagri icin: URL, HTTP method, request body field adlari, expected response tipi
  3. Her backend endpoint icin: path, method, DTO property adlari, response tipi
  4. Eslesmeyenleri etiketle:
     - [ORPHAN_FE] -- Frontend cagiriyor ama backend'de yok
     - [ORPHAN_BE] -- Backend var ama frontend cagirmiyor
     - [FIELD_MISMATCH] -- Request body field adlari uyusmuyor (bilinen: frontend "query" gonderiyor, backend "sql" bekliyor)
     - [TYPE_MISMATCH] -- Response tipi uyusmuyor
  5. Error response format tutarliligi kontrol et
  6. whitelist: true + forbidNonWhitelisted: true (main.ts:97-98) -- reject edilen field'lar var mi?

  ## CIKTI
  Raporunu docs/audits/admin-panel/2026-03-14/wave-1/03-contract-map.md dosyasina yaz.
  Maksimum 1000 satir.
```

**Ajan P4 -- Bagimlilik Haritaci:**
```
subagent_type: general-purpose
model: opus
name: P4-dependency-map
prompt: |
  Sen admin panel audit ekibinin Bagimlilik Haritaci ajanisisin (P4).

  ## GOREV
  Frontend ve backend'in dependency ve build konfigurasyonu analizi.

  ## HEDEF DOSYALAR
  - web/modules/admin-panel/package.json
  - web/modules/admin-panel/vite.config.ts
  - web/modules/admin-panel/webpack.config.js
  - web/modules/admin-panel/tsconfig.json
  - web/modules/admin-panel/tailwind.config.js
  - apps/admin-api-service/package.json
  - apps/admin-api-service/webpack.config.js
  - web/shell/vite.config.ts (Module Federation host config karsilastirmasi icin)

  ## KONTROL LISTESI
  1. package.json'da tanimli ama kodda hic import edilmeyen paketleri bul (@tanstack/react-query biliniyor, baska var mi?)
  2. Module Federation shared singleton versiyonlari: admin-panel vs shell uyumlu mu?
  3. vite.config.ts expose listesi (4 endpoint) vs gercek kullanim
  4. webpack.config.js bos -- neden var? Legacy mi?
  5. Build tool tutarsizligi: frontend Vite, backend Webpack
  6. Bos/placeholder dosyalar: bootstrap.tsx, App.tsx, routes.tsx -- legacy mi?
  7. Dev dependency'ler vs production dependency'ler dogru ayrilmis mi?

  ## CIKTI
  Raporunu docs/audits/admin-panel/2026-03-14/wave-1/04-dependency-map.md dosyasina yaz.
  Maksimum 1000 satir.
```

- [ ] **Step 2: 4 ajanin tamamlanmasini bekle**

Tum ajanlar tamamlaninca devam et.

- [ ] **Step 3: Dalga 1 raporlarini kontrol et**

4 rapor dosyasinin olusup olusmadigini kontrol et:
```bash
ls -la docs/audits/admin-panel/2026-03-14/wave-1/
```
Beklenen: 01-frontend-map.md, 02-backend-map.md, 03-contract-map.md, 04-dependency-map.md

Eksik rapor varsa: ajanin ciktisini oku ve raporu manuel olustur.

---

## Chunk 2: Dalga 2a (Guvenlik, Bug, Performans, Mimari)

### Task 3: Dalga 2a -- 4 Uzman Ajani (Paralel)

Dalga 1 raporlarini baz alarak 4 uzman ajani paralel spawn et.

- [ ] **Step 1: 4 ajani paralel spawn et**

**Ajan P5 -- Guvenlik Denetcisi:**
```
subagent_type: general-purpose
model: opus
name: P5-security
prompt: |
  Sen admin panel audit ekibinin Guvenlik Denetcisi ajanisisin (P5). 15 yillik pentest deneyimine sahip bir guvenlik uzmani gibi davran.

  ## OKUMANIZ GEREKEN RAPORLAR
  Oncelikle su raporlari oku:
  - docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/02-backend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/03-contract-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/04-dependency-map.md

  ## HEDEF DOSYALAR (oncelik sirasinda)
  - apps/admin-api-service/src/database-management/controllers/explorer.controller.ts
  - apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts
  - apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts
  - apps/admin-api-service/src/impersonation/services/impersonation.service.ts
  - apps/admin-api-service/src/guards/platform-admin.guard.ts
  - apps/admin-api-service/src/filters/global-exception.filter.ts
  - apps/admin-api-service/src/settings/controllers/ip-access.controller.ts
  - apps/admin-api-service/src/app.module.ts
  - web/modules/admin-panel/src/services/adminApi.ts
  - web/modules/admin-panel/src/components/database/QueryEditor.tsx
  - web/modules/admin-panel/src/pages/DatabaseExplorerPage.tsx

  ## KONTROL LISTESI (40 madde, 8 kategori)

  A. Authentication & Authorization:
  A1: Her controller'da @UseGuards vs global APP_GUARD tutarliligi
  A2: Admin identity source -- JWT (req.user) vs client-supplied (@Query('adminId'), @Headers)
  A3: Session ownership -- bir admin baska admin'in impersonation session'ini manipule edebilir mi?
  A4: @Public() dekoratoru kullanim analizi
  A5: Role case-sensitivity tutarliligi

  B. SQL Injection (Database Explorer):
  B1: Raw SQL endpoint regex bypass analizi
  B2: SET search_path bypass testi
  B3: PL/pgSQL anonymous block (DO $$ ... END $$) bypass testi
  B4: Nested SQL comment bypass testi
  B5: pg_catalog / information_schema meta-data leak
  B6: pg_sleep DoS, current_setting() config leak
  B7: Frontend-backend field name mismatch (query vs sql)
  B8: isValidIdentifier bypass senaryolari
  B9: NODE_ENV !== 'production' tek savunma hatti riski

  C. Sensitive Data Exposure:
  C1: includeSensitive flag client-controlled
  C2: Export endpoint sensitive data masking
  C3: Error response'larda DB yapisal bilgi sizintisi
  C4: LocalStorage query history hassas veri

  D. Cross-Tenant Isolation:
  D1: ALLOWED_SCHEMAS sinirlamasi
  D2: Raw SQL ile tenant_* schema erisim
  D3: Impersonation allowedTenants fail-closed?
  D4: Debug session tenantId isolation

  E. Rate Limiting & DoS:
  E1: ThrottlerGuard kaldirilmis -- korunmasiz endpoint'ler
  E2: Export endpoint max row -- DB load
  E3: Bulk IP rule array boyut siniri
  E4: Raw SQL statement_timeout

  F. CSRF & Network:
  F1: credentials: 'include' CSRF riski
  F2: CORS origin validation
  F3: X-Forwarded-For spoofing

  G. Impersonation-Specific:
  G1: Token hash timing attack
  G2: Session expiry cron race condition
  G3: notifyTenantAdmin stub
  G4: In-memory activeSessions restart tutarsizligi

  H. Input Validation:
  H1: DTO validation coverage
  H2: Bulk operation array size limits
  H3: JSON.parse(defaultValue) prototype pollution

  ## RAPOR FORMATI
  - Yonetici Ozeti (3-5 cumle)
  - Bulgular: Her bulgu icin severity, dosya:satir, aciklama, kanit (kod alintisi), etki, onerilen fix, effort (S/M/L/XL)
  - Spawn Talepleri: Daha derin bakilmasi gereken konular (id, severity, trigger, hedef dosyalar, gerekce)
  - Celiskiler: Okunan raporlarla celisen bulgu (varsa)
  - Oneriler

  ## KURALLAR
  1. Sadece kanita dayali bulgu raporla -- her bulgu icin dosya:satir referansi VE kod alintisi
  2. Bilinen sorunlardan (KS-1 ila KS-10) bagimsiz calis. Dogrula veya cercut et.
  3. Spawn talepleri icin ayri bolum
  4. Maksimum 500 satir

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-2a/05-security.md
```

**Ajan P6 -- Bug Avcisi:**
```
subagent_type: general-purpose
model: opus
name: P6-bugs
prompt: |
  Sen admin panel audit ekibinin Bug Avcisi ajanisisin (P6).

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/02-backend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/03-contract-map.md

  ## GOREV
  Mantiksal hatalar, race condition, edge case buglari bul.

  ## KONTROL LISTESI
  1. Race condition: useAsyncData concurrent request, cache invalidation zamanlama
  2. Null/undefined: Optional chaining eksikligi, API response null kontrolu
  3. State senkronizasyon: Pagination + filter + data fetch sirasi
  4. Error boundary: Catch edilmeyen promise rejection, component crash
  5. Retry mantigi: apiFetch 3x otomatik retry + useAsyncData retry -- cift retry var mi?
  6. Off-by-one: Pagination offset hesaplama
  7. Memory leak: useEffect cleanup, AbortController, event listener
  8. Type safety: any kullanimi, unsafe type assertion
  9. Edge case: Bos liste, tek sayfa pagination, uzun string, ozel karakter
  10. useAsyncData global Map cache boyut limiti yok -- memory growth riski
  11. URL state sync: usePagination/useFilters URL sync race condition
  12. Data freshness: Cache TTL sonrasi stale data
  13. Concurrent request: Ayni endpoint'e paralel cagri davranisi (request dedup)

  ## HEDEF DOSYALAR
  - web/modules/admin-panel/src/hooks/useAsyncData.ts
  - web/modules/admin-panel/src/hooks/usePagination.ts
  - web/modules/admin-panel/src/hooks/useFilters.ts
  - web/modules/admin-panel/src/services/adminApi.ts (apiFetch fonksiyonu)
  - Birden fazla buyuk sayfa dosyasi (en az 5 farkli sayfa oku)

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-2a/06-bugs.md
  Maksimum 500 satir.
```

**Ajan P7 -- Performans Analisti:**
```
subagent_type: general-purpose
model: opus
name: P7-performance
prompt: |
  Sen admin panel audit ekibinin Performans Analisti ajanisisin (P7).

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/02-backend-map.md

  ## KONTROL LISTESI
  1. N+1 Query: Backend'de loop icinde DB sorgusu
  2. Re-render: useCallback/useMemo eksikligi, prop drilling, inline object/function
  3. Bundle size: 38 route lazy loading yok, React.lazy kullanilmamis -- monolitik bundle
  4. Cache: useAsyncData TTL degerleri, stale data riski, mutation sonrasi invalidation
  5. DB Index: Sik kullanilan sorgularda index analizi
  6. Memory: Global Map cache buyukluk siniri yok, large dataset client-side
  7. API call: Duplicate cagri, waterfall pattern
  8. Heavy computation: DataGrid rendering, large list
  9. Module Federation: Shared singleton bundle maliyeti (React Query yuklu ama kullanilmiyor)
  10. Database Explorer: Large result set handling, pagination verimliligi

  ## HEDEF DOSYALAR
  - web/modules/admin-panel/src/hooks/useAsyncData.ts
  - web/modules/admin-panel/src/Module.tsx (lazy loading kontrolu)
  - web/modules/admin-panel/src/components/database/DataGrid.tsx
  - web/modules/admin-panel/vite.config.ts (shared singletons)
  - apps/admin-api-service/src/ altindan en az 5 service dosyasi (N+1 query kontrolu)

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-2a/07-performance.md
  Maksimum 500 satir.
```

**Ajan P8 -- Mimari Elestirmen:**
```
subagent_type: general-purpose
model: opus
name: P8-architecture
prompt: |
  Sen admin panel audit ekibinin Mimari Elestirmen ajanisisin (P8). SOLID, Clean Architecture, DDD konularinda derin deneyimin var.

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/02-backend-map.md

  ## KONTROL LISTESI
  1. SRP: adminApi.ts 3116 satir (1800+ tip tanimi + 1300 API fonksiyonu) -- decomposition analizi
  2. Katman analizi: pages -> components -> hooks -> services yonu tutarli mi?
  3. CQRS tutarsizligi: Tenant modulunde CQRS var, diger 15 modulde yok
  4. Data fetch pattern tutarsizligi: 4 farkli pattern (adminApi, useAsyncData, direct fetch, mock data)
  5. Sayfa monolitizmi: 20 sayfa 600+ satir -- sayfa icinde tanimlanan utility/component
  6. Backend modul kohezyon: ImpersonationModule icinde DebugToolsController
  7. Pattern consistency: CSS-in-JS vs Tailwind karisimi
  8. Error handling stratejisi tutarliligi
  9. Module Federation: 4 expose vs 38 route granularity

  SORUMLULUK SINIRI: Dead code, TODO, unused import gibi kod-seviyesi temizlik P11'in isidir, senin degil.

  ## HEDEF DOSYALAR
  - web/modules/admin-panel/src/services/adminApi.ts
  - web/modules/admin-panel/src/Module.tsx
  - web/modules/admin-panel/src/hooks/useAsyncData.ts
  - En az 5 buyuk sayfa dosyasi
  - apps/admin-api-service/src/app.module.ts
  - apps/admin-api-service/src/impersonation/impersonation.module.ts
  - apps/admin-api-service/src/tenant/tenant.controller.ts (CQRS ornegi)
  - En az 3 klasik pattern controller (CQRS olmayan)

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-2a/08-architecture.md
  Maksimum 500 satir.
```

- [ ] **Step 2: 4 ajanin tamamlanmasini bekle**

- [ ] **Step 3: Dalga 2a raporlarini kontrol et**
```bash
ls -la docs/audits/admin-panel/2026-03-14/wave-2a/
```

- [ ] **Step 4: Dalga 2a raporlarini degerlendir**

Her raporu oku ve su bilgileri cikar:
1. Spawn talepleri: Her rapordaki "Spawn Talepleri" bolumunu oku, severity'e gore sirala
2. Celiskiler: "Celiskiler" bolumunu oku, contradiction_log'a ekle
3. Critical bulgu sayisi: Her rapordan critical/high/medium/low sayilarini not al

spawn_queue ve contradiction_log'u bellek/not olarak tut (sonraki adimda kullanilacak).

---

## Chunk 3: Dalga 2b (Test, UX, Teknik Borc, Feature Completeness)

### Task 4: Dalga 2b -- 4 Uzman Ajani (Paralel)

- [ ] **Step 1: 4 ajani paralel spawn et**

**Ajan P9 -- Test Denetcisi:**
```
subagent_type: general-purpose
model: opus
name: P9-testing
prompt: |
  Sen admin panel audit ekibinin Test Denetcisi ajanisisin (P9).

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/02-backend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/03-contract-map.md

  ## KONTROL LISTESI
  1. Frontend test coverage: 6 test / 72 dosya = %8.3 -- hangi sayfalar/component'ler test edilmeli?
  2. Backend test coverage: 30 test / 181 dosya = %16.6 -- hangi controller/service'ler test edilmeli?
  3. Kritik flow test durumu: tenant create, impersonation, database explorer, billing
  4. Mock kalitesi: Mevcut testlerdeki mock'lar gercek davranisi yansitir mi?
  5. Edge case coverage: Hata senaryolari, bos input, buyuk input test edilmis mi?
  6. Integration test: Frontend-backend entegrasyon testi var mi?
  7. Risk-bazli test onceliklendirme matrisi olustur (guvenlik riski yuksek + test yok = KRITIK)

  ## HEDEF DOSYALAR
  Frontend testleri:
  - web/modules/admin-panel/src/hooks/__tests__/*.spec.ts (3 dosya)
  - web/modules/admin-panel/src/components/AlertRuleBuilder/__tests__/*.spec.tsx
  - web/modules/admin-panel/src/pages/__tests__/*.spec.tsx (2 dosya)

  Backend testleri:
  - apps/admin-api-service/src/ altindaki tum __tests__/ dizinleri (30 dosya)

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-2b/09-testing.md
  Maksimum 500 satir.
```

**Ajan P10 -- UX & Erisilebilirlik:**
```
subagent_type: general-purpose
model: opus
name: P10-ux-a11y
prompt: |
  Sen admin panel audit ekibinin UX & Erisilebilirlik ajanisisin (P10).

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md

  ## KONTROL LISTESI
  1. ARIA: Role, label, describedby eksiklikleri
  2. Keyboard: Tab order, focus management, keyboard shortcut
  3. Responsive: Mobile/tablet gorunum, breakpoint davranisi
  4. Loading state: Skeleton/spinner tutarliligi
  5. Error state: Kullanici dostu hata mesajlari, retry secenegi
  6. Empty state: Bos liste/tablo ne gosteriyor?
  7. i18n: Turkce/Ingilizce karisimi, hardcoded string'ler (AlertRuleBuilder'da Turkce label'lar var)
  8. Form UX: Validation feedback, submit durumu
  9. Color contrast: WCAG AA uyumu

  ## HEDEF DOSYALAR
  En az 10 farkli sayfa dosyasini oku:
  - web/modules/admin-panel/src/pages/ altindan cesitli sayfalar
  - web/modules/admin-panel/src/components/ altindaki tum component'ler
  - web/modules/admin-panel/src/components/AdminSidebar.tsx (navigation)

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-2b/10-ux-a11y.md
  Maksimum 500 satir.
```

**Ajan P11 -- Teknik Borc Dedektifi:**
```
subagent_type: general-purpose
model: opus
name: P11-tech-debt
prompt: |
  Sen admin panel audit ekibinin Teknik Borc Dedektifi ajanisisin (P11).

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/02-backend-map.md

  ## KONTROL LISTESI
  1. Dead code: Kullanilmayan fonksiyon, component, import, export
  2. TODO/FIXME/HACK: Kod icindeki notlar (sayisi + konumu)
  3. Duplicate: Tekrar eden kod bloklari (ozellikle adminApi.ts getAuthHeader vs DatabaseExplorerPage)
  4. Unused dependency: React Query yuklu ama kullanilmiyor. Baska var mi?
  5. Legacy dosyalar: Bos webpack.config.js, bootstrap.tsx, App.tsx, routes.tsx
  6. Type debt: any kullanimi, as type assertion, missing type annotation
  7. Naming tutarsizligi: dosya/fonksiyon/degisken adlandirma

  SORUMLULUK SINIRI: Mimari pattern tutarsizligi, layer violation, SRP gibi yapisal sorunlar P8'in isidir, senin degil. Sen kod-seviyesi temizlik konularina bak.

  ## HEDEF DOSYALAR
  - Tum frontend kaynak dosyalari (grep/glob ile tara)
  - apps/admin-api-service/src/ altindan cesitli dosyalar

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-2b/11-tech-debt.md
  Maksimum 500 satir.
```

**Ajan P12 -- Feature Completeness Auditor:**
```
subagent_type: general-purpose
model: opus
name: P12-feature-completeness
prompt: |
  Sen admin panel audit ekibinin Feature Completeness Auditor ajanisisin (P12). YENI bir rol -- spec v1'de yoktu, v2'de eklendi.

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/03-contract-map.md

  ## GOREV
  Her sayfanin gercekten calisip calismadigini dogrula. Mock data kullanan, backend entegrasyonu eksik veya kirik contract'i olan sayfalari tespit et.

  ## KONTROL LISTESI
  1. Her sayfa icin backend entegrasyon durumunu kontrol et:
     - [FULLY_INTEGRATED] -- Tum CRUD operasyonlari backend'e bagli
     - [PARTIALLY_INTEGRATED] -- Bazi operasyonlar mock, bazilari gercek
     - [MOCK_ONLY] -- Tamamen mock data, backend entegrasyonu yok
     - [BROKEN_CONTRACT] -- API cagrisi var ama backend'le uyumsuz
  2. adminApi.ts'de tanimli ama hicbir sayfa tarafindan cagirilmayan API fonksiyonlarini [UNUSED_API] isaretle
  3. CRUD tamamlanmisligi: list + create + update + delete var mi yoksa sadece list mi?
  4. Mock data kullanan her sayfa icin: hangi adminApi fonksiyonlari baglanmali? (mapping tablosu)

  ## HEDEF DOSYALAR
  - web/modules/admin-panel/src/services/adminApi.ts (tum API namespace'ler)
  - web/modules/admin-panel/src/pages/ altindaki TUM sayfa dosyalari (39 dosya)
  - Ozellikle bilinen mock sayfalar:
    - DatabaseManagementPage.tsx
    - OnboardingPage.tsx
    - TenantConfigurationPage.tsx

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-2b/12-feature-completeness.md
  Maksimum 500 satir.
```

- [ ] **Step 2: 4 ajanin tamamlanmasini bekle**

- [ ] **Step 3: Dalga 2b raporlarini kontrol et**
```bash
ls -la docs/audits/admin-panel/2026-03-14/wave-2b/
```

- [ ] **Step 4: Dalga 2a + 2b birlesik degerlendirme**

Tum 8 uzman raporunu oku. Su bilgileri cikar:
1. Tum spawn taleplerini topla ve deduplicate et (ayni target_files -> birlestir)
2. Tum celiskileri topla
3. spawn_queue'yu severity'e gore sirala:
   - critical severity -> deep-dive batch 1
   - high severity -> deep-dive batch 2
4. Toplam bulgu sayilarini not al (dalga 4 icin)

---

## Chunk 4: Deep-Dive ve Resolver Ajanlari

### Task 5: Deep-Dive Batch 1 (max 4 paralel)

- [ ] **Step 1: spawn_queue'dan critical severity olanlari sec**

Dalga 2 raporlarindan gelen spawn taleplerini degerlendir. Ornek beklenen talepler:
- dd-sql-injection (P5'ten, critical)
- dd-identity-spoofing (P5'ten, critical -- adminId query param)
- dd-mock-data-integration (P12'den, high)
- dd-god-file-decomposition (P8'den, high)

Max 4 deep-dive sec, DEEP_DIVE_BUDGET=8'den dus.

- [ ] **Step 2: Deep-dive ajanlarini paralel spawn et**

Her deep-dive icin spec Bolum 5.1'deki sablonu kullan:
```
subagent_type: general-purpose
model: opus
name: dd-{konu}
prompt: |
  Sen bir deep-dive analiz ajanisisin. Belirli bir konuda derinlemesine inceleme yapiyorsun.

  ## GOREV
  {tetikleyen bulgunun detayli aciklamasi -- spawn talebinden kopyala}

  ## HEDEF DOSYALAR
  {spawn_request.target_files -- tam yollar}

  ## OKUMANIZ GEREKEN RAPORLAR
  {tetikleyen ajanin raporu: docs/audits/admin-panel/2026-03-14/{rapor_yolu}}
  {ilgili wave-1 raporlari}

  ## BEKLENEN CIKTI
  1. Tetikleyen bulguyu dogrula veya cercut et (false positive mi?)
  2. Eger dogruysa: exploit/hata senaryosu yaz (adim adim)
  3. Somut fix onerisi ver (hangi dosya, hangi satir, ne degismeli)
  4. Iliskili ikincil bulgulari raporla

  ## KURALLAR
  1. Her iddia icin dosya:satir referansi VE kod alintisi
  2. Maksimum 600 satir
  3. Bu ajan baska deep-dive spawn edemez (derinlik: 1)

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/deep-dives/dd-{konu}.md
```

- [ ] **Step 3: Tamamlanmayi bekle**

- [ ] **Step 4: Kalan budget varsa Deep-Dive Batch 2**

spawn_queue'da high severity kalanlar varsa ve DEEP_DIVE_BUDGET > 0 ise, max 4 daha spawn et.

---

### Task 6: Resolver Ajanlari (gerekirse)

- [ ] **Step 1: contradiction_log'u kontrol et**

Eger iki ajan celisen bulgu raporladiysa, resolver spawn et (max 2 paralel, RESOLVER_BUDGET=3).

```
subagent_type: general-purpose
model: opus
name: rv-{konu}
prompt: |
  Iki analiz ajani ayni konu hakkinda zit goruslere sahip. Senin gorevin:
  1. Her iki ajanin raporunu oku
  2. Ilgili kodu dogrudan incele
  3. Trade-off analizi yap
  4. Net bir karar ver ve gerekcelendir

  ## CELISEN GORUSLER
  - Ajan A ({id}): {gorusu}
  - Ajan B ({id}): {gorusu}

  ## RAPORLAR
  - docs/audits/admin-panel/2026-03-14/{ajan_a_raporu}
  - docs/audits/admin-panel/2026-03-14/{ajan_b_raporu}

  ## KARAR FORMATI
  - Karar: {A dogru | B dogru | sentez}
  - Gerekce: {teknik analiz}
  - Aksiyon: {ne yapilmali}

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/resolvers/rv-{konu}.md
  Maksimum 400 satir.
```

- [ ] **Step 2: Celiski yoksa bu adimu atla**

---

## Chunk 5: Dalga 3 (Capraz Analiz) ve Dalga 4 (Sentez)

### Task 7: Dalga 3 -- 4 Capraz Analiz Ajani (Paralel)

ONKOSUL: Tum deep-dive ve resolver ajanlari tamamlanmis olmali.

- [ ] **Step 1: 4 capraz analiz ajanini paralel spawn et**

**Ajan P13 -- Guvenlik x Mimari:**
```
subagent_type: general-purpose
model: opus
name: P13-security-x-arch
prompt: |
  Sen admin panel audit ekibinin Capraz Analiz ajanisin (P13): Guvenlik x Mimari.

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-2a/05-security.md
  - docs/audits/admin-panel/2026-03-14/wave-2a/08-architecture.md
  - docs/audits/admin-panel/2026-03-14/wave-1/02-backend-map.md
  - docs/audits/admin-panel/2026-03-14/deep-dives/ altindaki tum raporlar (varsa)

  ## ODAK
  Mimari kararlarin guvenlik sonuclari:
  1. adminApi.ts God file guvenlik yuzeyini nasil etkiliyor?
  2. Global APP_GUARD tek nokta hatasi (single point of failure) riski
  3. Controller-level guard tutarsizligi guvenlik boslugu yaratir mi?
  4. Error handling stratejisi bilgi sizintisina yol aciyor mu?
  5. NODE_ENV korumasindaki endpoint'ler production'a kacabilir mi?
  6. ImpersonationModule icindeki DebugToolsController -- domain karisimi guvenlik riski

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-3/13-security-x-arch.md
  Maksimum 400 satir.
```

**Ajan P14 -- Bug x Performans:**
```
subagent_type: general-purpose
model: opus
name: P14-bug-x-perf
prompt: |
  Sen admin panel audit ekibinin Capraz Analiz ajanisin (P14): Bug x Performans.

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-2a/06-bugs.md
  - docs/audits/admin-panel/2026-03-14/wave-2a/07-performance.md

  ## ODAK
  Performans sorunlari bug'a donusuyor mu?
  1. Cache invalidation bug + N+1 query = stale data?
  2. Memory leak + retry loop = crash?
  3. Re-render + state sync = UI glitch?
  4. Module Federation shared singleton + unused React Query = bundle bloat + runtime error?
  5. Monolitik bundle + lazy loading yok = sayfa yukleme sirasinda race condition?

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-3/14-bug-x-perf.md
  Maksimum 400 satir.
```

**Ajan P15 -- Test x Guvenlik:**
```
subagent_type: general-purpose
model: opus
name: P15-test-x-security
prompt: |
  Sen admin panel audit ekibinin Capraz Analiz ajanisin (P15): Test x Guvenlik.

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-2b/09-testing.md
  - docs/audits/admin-panel/2026-03-14/wave-2a/05-security.md

  ## ODAK
  Guvenlik risk matrisi ile test coverage haritasini ust uste koy:
  1. SQL injection bulgusu var + bu endpoint test edilmemis = KRITIK bosluk
  2. Impersonation flow test edilmis mi?
  3. RBAC bypass senaryolari test edilmis mi?
  4. Identity spoofing (adminId query param) test edilmis mi?
  5. Risk-bazli test onceliklendirme matrisi olustur:
     Matris formati: [Endpoint/Feature] x [Guvenlik Riski Severity] x [Test Durumu] = [Oncelik]

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-3/15-test-x-security.md
  Maksimum 400 satir.
```

**Ajan P16 -- Feature Completeness x Kontrat:**
```
subagent_type: general-purpose
model: opus
name: P16-completeness-x-contract
prompt: |
  Sen admin panel audit ekibinin Capraz Analiz ajanisin (P16): Feature Completeness x Kontrat.

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-2b/12-feature-completeness.md
  - docs/audits/admin-panel/2026-03-14/wave-1/03-contract-map.md
  - docs/audits/admin-panel/2026-03-14/wave-2a/06-bugs.md

  ## ODAK
  1. Mock data sayfalarinin backend'le entegrasyon yol haritasi
  2. Orphan API endpoint'lerinin mock sayfalara baglanma potansiyeli
  3. Frontend error handling backend hata formatiyla uyumlu mu?
  4. API timeout'ta kullaniciya ne gosteriyor?
  5. BROKEN_CONTRACT durumundaki sayfalar icin fix onceligi

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-3/16-completeness-x-contract.md
  Maksimum 400 satir.
```

- [ ] **Step 2: Tamamlanmayi bekle**

- [ ] **Step 3: Dalga 3 raporlarini kontrol et**
```bash
ls -la docs/audits/admin-panel/2026-03-14/wave-3/
```

---

### Task 8: Dalga 4 -- Sentez (Sirali)

- [ ] **Step 1: P17 Bas Analist spawn et**

```
subagent_type: general-purpose
model: opus
name: P17-synthesis
prompt: |
  Sen admin panel audit ekibinin Bas Analist ajanisisin (P17). Tum audit raporlarini sentezleyip final rapor ureteceksin.

  ## OKUMANIZ GEREKEN RAPORLAR
  Asagidaki raporlarin HER BIRININ "Yonetici Ozeti" ve "Bulgular" bolumlerini oku:

  Wave 1:
  - docs/audits/admin-panel/2026-03-14/wave-1/01-frontend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/02-backend-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/03-contract-map.md
  - docs/audits/admin-panel/2026-03-14/wave-1/04-dependency-map.md

  Wave 2a:
  - docs/audits/admin-panel/2026-03-14/wave-2a/05-security.md
  - docs/audits/admin-panel/2026-03-14/wave-2a/06-bugs.md
  - docs/audits/admin-panel/2026-03-14/wave-2a/07-performance.md
  - docs/audits/admin-panel/2026-03-14/wave-2a/08-architecture.md

  Wave 2b:
  - docs/audits/admin-panel/2026-03-14/wave-2b/09-testing.md
  - docs/audits/admin-panel/2026-03-14/wave-2b/10-ux-a11y.md
  - docs/audits/admin-panel/2026-03-14/wave-2b/11-tech-debt.md
  - docs/audits/admin-panel/2026-03-14/wave-2b/12-feature-completeness.md

  Deep-dives (varsa):
  - docs/audits/admin-panel/2026-03-14/deep-dives/ altindaki tum md dosyalari

  Resolvers (varsa):
  - docs/audits/admin-panel/2026-03-14/resolvers/ altindaki tum md dosyalari

  Wave 3:
  - docs/audits/admin-panel/2026-03-14/wave-3/13-security-x-arch.md
  - docs/audits/admin-panel/2026-03-14/wave-3/14-bug-x-perf.md
  - docs/audits/admin-panel/2026-03-14/wave-3/15-test-x-security.md
  - docs/audits/admin-panel/2026-03-14/wave-3/16-completeness-x-contract.md

  ## GOREV
  1. Tum bulgulari severity ile onceliklendir (tek birlesik liste)
  2. Duplicate/overlap bulgu temizligi (ayni bulgu farkli ajanlardan geldiyse birlestir)
  3. Tekrar eden temalari belirle (kok neden analizi)
  4. Bulgulari gruplara ayir: guvenlik / mimari / performans / test / UX / teknik borc / feature gap
  5. Aksiyon plani olustur: ne yapmali, hangi sirada, effort (S/M/L/XL)
  6. Bagimlilik grafi: hangi fix'ler baska fix'lere bagimli?
  7. Quick win listesi: S effort + high/critical impact

  ## RAPOR FORMATI
  # Admin Panel Audit -- Final Sentez Raporu

  ## Yonetici Ozeti
  {10 cumle: genel durum, en kritik bulgular, onerilen yol haritasi}

  ## Istatistikler
  - Toplam ajan: X planli + Y deep-dive + Z resolver
  - Toplam bulgu: X critical, Y high, Z medium, W low, V info
  - Mock data sayfasi: X adet
  - Test coverage: frontend %X, backend %Y

  ## Oncelikli Bulgu Listesi
  {Severity sirasinda, duplicate temizlenmis, her bulgu: baslik, severity, kaynak ajan, dosya:satir, etki, fix, effort}

  ## Kok Neden Analizi
  {Sorunlarin kaynagi nerede? Ornegin: "mimari katmanlama yoklugu hem SRP ihlali, hem mock data, hem inconsistent fetch pattern'e yol aciyor"}

  ## Aksiyon Plani
  {Oncelik sirasi, effort, bagimlilik, sprint onerisi}

  ## Quick Wins
  {S effort + high/critical impact}

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-4/17-final-synthesis.md
```

- [ ] **Step 2: P17 tamamlanmasini bekle**

- [ ] **Step 3: P18 Kalite Kontrol spawn et**

```
subagent_type: general-purpose
model: opus
name: P18-qa-review
prompt: |
  Sen admin panel audit ekibinin Kalite Kontrol ajanisisin (P18). Son dogrulama gecisini yapiyorsun.

  ## OKUMANIZ GEREKEN RAPORLAR
  - docs/audits/admin-panel/2026-03-14/wave-4/17-final-synthesis.md (ANA RAPOR)

  ## GOREV
  P17 sentez raporundaki CRITICAL ve HIGH bulgulari dogrudan koda bakarak dogrula.

  Her CRITICAL/HIGH bulgu icin:
  1. Referans verilen dosya mevcut mu? (Read tool ile kontrol et)
  2. Referans verilen satir +/- 10 satir icinde ilgili kod var mi?
  3. Iddia edilen sorun gercekten gozlemlenebilir mi?
  4. Dogrulanamayan bulguyu [FALSE_POSITIVE] olarak isaretle

  Ek olarak:
  5. Kacirilmis olabilecek kritik alanlari tara
  6. Oneri kalitesi: onerilen fix'ler uygulanabilir mi?

  ## RAPOR FORMATI
  # Kalite Kontrol Raporu

  ## Dogrulama Sonuclari
  | # | Bulgu | Dosya Mevcut | Satir Dogru | Sorun Gorulur | Sonuc |
  |---|-------|-------------|-------------|---------------|-------|
  | CRITICAL-001 | ... | Evet/Hayir | Evet/Hayir | Evet/Hayir | DOGRULANDI / FALSE_POSITIVE |

  ## False Positive Listesi
  {Dogrulanamayan bulgular ve nedenleri}

  ## Kacirilmis Alanlar
  {QA gecisinde bulunan yeni bulgular (varsa)}

  ## Sonuc
  - Dogrulama orani: X / Y (%Z)
  - Yeni critical bulgu: Evet/Hayir

  ## CIKTI
  docs/audits/admin-panel/2026-03-14/wave-4/18-qa-review.md
```

- [ ] **Step 4: P18 tamamlanmasini bekle**

- [ ] **Step 5: P18 yeni CRITICAL buldu mu kontrol et**

P18 raporunu oku. Eger "Yeni critical bulgu: Evet" ise VE wave4_iteration < 2 ise:
- Yeni deep-dive spawn et (budget varsa)
- P17'yi yeni verilerle tekrar spawn et
- wave4_iteration++

Eger "Hayir" ise: devam et.

---

### Task 9: Final -- SUMMARY.md

- [ ] **Step 1: Tum rapor dosyalarini say**
```bash
find docs/audits/admin-panel/2026-03-14/ -name "*.md" | wc -l
```

- [ ] **Step 2: SUMMARY.md yaz**

Asagidaki bilgileri iceren ozet dosyasini olustur:

```markdown
# Admin Panel Audit Summary
**Tarih:** 2026-03-14
**Sure:** {baslangic - bitis}

## Istatistikler
- Planli ajan: 18
- Deep-dive ajan: {sayi}
- Resolver ajan: {sayi}
- Toplam rapor: {sayi}

## Bulgu Ozeti
- CRITICAL: {sayi}
- HIGH: {sayi}
- MEDIUM: {sayi}
- LOW: {sayi}
- INFO: {sayi}
- False positive: {sayi} ({oran})

## Basari Kriterleri
| Kriter | Hedef | Sonuc | Durum |
|--------|-------|-------|-------|
| BK-1: Ajan tamamlanma | >= 89% | {X/18} | {OK/FAIL} |
| BK-2: Deep-dive spawn | >= 1 | {sayi} | {OK/FAIL} |
| BK-3: Cross-reference | >= 5 | {sayi} | {OK/FAIL} |
| BK-4: Dogrulama orani | >= 80% | {oran} | {OK/FAIL} |
| BK-5: CRITICAL fix onerisi | 100% | {oran} | {OK/FAIL} |
| BK-6: Aksiyon plani | Evet | {Evet/Hayir} | {OK/FAIL} |
| BK-7: Bilinen sorun dogrulama | >= 8/10 | {X/10} | {OK/FAIL} |
| BK-8: Mock data listesi | Evet | {Evet/Hayir} | {OK/FAIL} |

## Raporlar
{tum rapor dosyalarinin listesi + kisa aciklama}
```

Dosya: `docs/audits/admin-panel/2026-03-14/SUMMARY.md`

- [ ] **Step 3: Kullaniciya sonuclari sun**

Final sentez raporunun (17-final-synthesis.md) ozetini kullaniciya goster.

---

## Hata Yonetimi Referansi

Plan uygulamasi sirasinda asagidaki senaryolarda su sekilde davran:

| Senaryo | Davranis |
|---------|----------|
| Ajan rapor dosyasi yazmadan bitti | Ajan ciktisini dogrudan oku, raporu orkestrator olarak yaz |
| Dalga 1 raporu eksik, Dalga 2 baslatilacak | Eksik rapora ragmen devam et, Dalga 2 ajanlarina eksik raporu bildirme notu ekle |
| Deep-dive budget (8) tukendi, yeni critical spawn talebi geldi | SUMMARY.md'ye "UNRESOLVED" olarak not dus |
| Resolver karar veremedi | Her iki gorusu sentez raporuna dahil et, kullaniciya sun |
| P18 QA 2. iterasyonda da critical buldu | Durdur, mevcut sentezi final kabul et |
