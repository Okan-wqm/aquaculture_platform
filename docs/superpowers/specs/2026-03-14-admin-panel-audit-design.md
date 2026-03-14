# Admin Panel Audit -- Adaptif Ajan Ordusu Spec v2

| Alan | Deger |
|------|-------|
| Versiyon | 2.0 |
| Tarih | 2026-03-14 |
| Onceki | v1.0 (ayni tarih, 4 uzman tarafindan reddedildi) |
| Durum | Kullanici onayina sunuluyor |

---

## Revizyon Gecmisi

| Versiyon | Tarih | Degisiklik |
|----------|-------|------------|
| 1.0 | 2026-03-14 | Ilk tasarim |
| 2.0 | 2026-03-14 | 4 uzman incelemesi sonrasi tam yeniden yazim. Dosya yollari dogrulanarak duzeltildi, orkestrasyon Claude Code kisitlarina uyarlanarak yeniden tasarlandi, ajan sorumluluk cakismalari cozuldu, hata yonetimi ve olculebilir basari kriterleri eklendi, bilinen sorunlar gercek kod bulgulariyla desteklendi. |

---

## 1. Amac ve Kapsam

### 1.1 Problem

Admin panel (SUPER_ADMIN araci) platformun en yetkili ve en az denetlenen moduludur. Database Explorer ile dogrudan SQL calistirabilen, impersonation ile kullanici taklit edebilen, tenant lifecycle'i yoneten bu modul icin kapsamli bir statik kod analizi yapilmamistir.

### 1.2 Hedef

Admin panel'in frontend ve backend kod tabanini birden fazla perspektiften (guvenlik, mimari, performans, test, UX, teknik borc) analiz eden, bulgulari capraz referansla sentezleyen ve oncelikli aksiyon plani ureten bir ajan ordusu sistemi olusturmak.

### 1.3 Kapsam

| Dahil | Haric |
|-------|-------|
| `web/modules/admin-panel/src/` (72 dosya, ~44K satir) | Runtime/canli sistem testi |
| `apps/admin-api-service/src/` (211 dosya, ~69K satir) | Diger servisler (auth, sensor, farm vb.) |
| Statik kod analizi | Deployment, CI/CD analizi |
| Frontend-backend kontrat uyumu | GraphQL schema analizi (admin panel REST kullaniyor) |

### 1.4 Cikti Dizini

```
docs/audits/admin-panel/2026-03-14/
```

### 1.5 Varsayimlar ve Kisitlamalar

| # | Varsayim/Kisitlama | Etki |
|---|---------------------|------|
| V1 | Claude Code Agent tool'u paralel spawn destekler ama orkestrator batch bitmeden ara karar alamaz | CRITICAL_IMMEDIATE mekanizmasi kullanilamaz |
| V2 | Paralel ajanlar ayni dosyayi okuyabilir (read-only) ama ayni dosyaya yazamazlar | MANIFEST.md coklu yazar icin uygun degil |
| V3 | Her alt ajan kendi context window'unda calisir (1M token) | Sentez ajaninin tum raporlari okumasi mumkun ama ozet modu gerekli |
| V4 | Ajan basina pratik calisma suresi ~5-15 dakika | Toplam sistem suresi ~60-90 dakika |
| V5 | MAX_CONCURRENT_AGENTS = 4 (guvenilir paralel batch boyutu) | Dalga 2, 2a ve 2b olarak ikiye bolunur |

---

## 2. Terminoloji

| Terim | Tanim |
|-------|-------|
| Ajan (Agent) | Claude Code Agent tool ile spawn edilen alt gorev birimi |
| Dalga (Wave) | Ayni anda paralel calisan ajan grubu |
| Orkestrator | Dalga yonetimi, rapor degerlendirme ve dinamik ajan spawn kararlarini veren ana kontrol dongusu |
| Deep-dive | Planli ajanlarin kesfettigi kritik/yuksek bulgular icin spawn edilen odakli analiz ajani |
| Resolver | Iki ajanin celisen bulgulari icin spawn edilen karar ajani |
| Spawn request | Bir ajanin raporunda "bu konuda daha derin bakilmali" talebi |
| Contradiction | Iki ajanin ayni konu hakkinda zit gorusleri |

### Severity Tanimlari

| Severity | Tanim | Ornek |
|----------|-------|-------|
| CRITICAL | Exploit edilebilir guvenlik acigi, veri kaybi riski, sistem cokertme potansiyeli | SQL injection, auth bypass, cross-tenant data leak |
| HIGH | Ciddi kalite/guvenlik sorunu ama exploit icin ek kosullar gerekli | Rate limiting eksikligi, God file, mock data sayfasi |
| MEDIUM | Iyilestirme gerektiren ama acil olmayan sorun | Tutarsiz pattern, eksik error handling, a11y ihlali |
| LOW | Kozmetik veya minimal etkili sorun | Naming tutarsizligi, unused import, TODO yorumu |
| INFO | Bilgilendirme, onerilen iyilestirme | Refactoring onerisi, best practice notu |

---

## 3. Dogrulanmis Kod Tabani Envanteri

Asagidaki sayilar gercek dosya sistemi taramasi ile dogrulanmistir (2026-03-14).

### 3.1 Frontend (`web/modules/admin-panel/src/`)

| Metrik | Deger |
|--------|-------|
| Toplam kaynak dosya | 72 (test dahil) |
| Sayfa dosyasi | 39 |
| Component dosyasi | 12 |
| Hook dosyasi | 5 |
| Service dosyasi | 1 (adminApi.ts, 3116 satir) |
| Test dosyasi | 6 |
| Route sayisi | 40 (38 named + 1 index + 1 fallback) |
| Toplam sayfa satir sayisi | 28,856 |

**600+ satirlik buyuk sayfalar (20 adet):**

| Dosya | Satir | Not |
|-------|-------|-----|
| DatabaseManagementPage.tsx | 1355 | MOCK DATA -- sifir API cagrisi |
| ImpersonationPage.tsx | 1276 | |
| CreateTenantPage.tsx | 1129 | |
| TenantConfigurationPage.tsx | 1057 | Kismi mock data |
| CompliancePage.tsx | 959 | |
| DatabaseExplorerPage.tsx | 944 | adminApi.ts bypass, kendi fetch wrapper |
| AuditTrailPage.tsx | 934 | |
| TenantDetailPage.tsx | 913 | |
| UserManagementPage.tsx | 902 | |
| AnalyticsDashboardPage.tsx | 901 | |
| SecurityDashboardPage.tsx | 889 | |
| ActivityLogPage.tsx | 879 | |
| DebugToolsPage.tsx | 872 | |
| MessagingPage.tsx | 845 | |
| AnnouncementsPage.tsx | 807 | |
| OnboardingPage.tsx | 804 | MOCK DATA -- sifir API cagrisi |
| TicketsPage.tsx | 803 | |
| MaintenancePage.tsx | 770 | |
| PerformanceDashboardPage.tsx | 756 | |
| ModulePricingPage.tsx | 754 | |

**Mock data kullanan sayfalar (bilinen):**
1. `DatabaseManagementPage.tsx` -- Tamamen mock (mockSchemas, mockMigrations, mockBackups, mockHealth)
2. `OnboardingPage.tsx` -- Tamamen mock (mockSteps, mockProgress, mockResources)
3. `TenantConfigurationPage.tsx` -- Kismi mock (mockConfig)

**adminApi.ts bypass eden dosyalar:**
1. `DatabaseExplorerPage.tsx` -- Kendi fetch wrapper'i, kendi getAuthHeader duplicate'i

### 3.2 Backend (`apps/admin-api-service/src/`)

| Metrik | Deger |
|--------|-------|
| Toplam kaynak dosya | 211 (test dahil) |
| Controller | 33 |
| Service | 58 |
| Entity | 31 |
| Test dosyasi | 30 |
| Modul | 16 |

**Dogrulanmis kritik dosya yollari:**

| Spec v1'deki yanlis yol | Gercek yol |
|--------------------------|------------|
| `database-explorer/database-explorer.service.ts` | `database-management/controllers/explorer.controller.ts` |
| `impersonation/impersonation.service.ts` | `impersonation/services/impersonation.service.ts` |
| (bilinmiyordu) | `impersonation/controllers/debug-tools.controller.ts` |

**Guard durumu:**
- `PlatformAdminGuard` APP_GUARD olarak global kayitli (`app.module.ts:125-126`)
- 17 controller ek `@UseGuards` ile redundant koruma
- 16 controller global guard'a guvenip acik `@UseGuards` kullanmiyor
- 2 controller'da `@Public()` dekoratoru var: `health.controller.ts` (4 method), `password-reset.controller.ts` (2 method), `global-settings.controller.ts` (1 method)
- `ThrottlerGuard` kaldirilmis (app.module.ts:128-131 yorum satirlari) -- global rate limiting YOK

**CQRS durumu:**
- Yalnizca `tenant/` modulunde CQRS (CommandBus/QueryBus) var
- Diger 15 modul klasik Controller -> Service -> Repository pattern kullaniyor

---

## 4. Bilinen Sorunlar (Pre-Audit)

4 uzman ajanin on-incelemesinde kesfedilen, spec v1'de bilinmeyen gercek kod bulgulari:

| # | Severity | Bulgu | Dosya | Bulan Uzman |
|---|----------|-------|-------|-------------|
| KS-1 | CRITICAL | `DebugToolsController` admin kimligini `@Query('adminId')` ile aliyor, JWT'den degil -- audit trail spoofing mumkun | `impersonation/controllers/debug-tools.controller.ts:393-394` | Guvenlik Mimari |
| KS-2 | CRITICAL | `DatabaseManagementPage.tsx` (1355 satir) tamamen mock data kullaniyor, sifir API cagrisi, kullanici sahte veri goruyor | `pages/DatabaseManagementPage.tsx:120-163` | Yazilim Muhendisi |
| KS-3 | CRITICAL | Frontend QueryEditor `query` field gonderiyor, backend `sql` bekliyor -- DTO contract mismatch | `QueryEditor.tsx:54` vs `explorer.controller.ts:183-184` | Guvenlik Mimari |
| KS-4 | CRITICAL | `DatabaseExplorerPage.tsx` adminApi.ts'yi bypass edip kendi fetch wrapper'ini yaziyor -- retry/error handling/envelope unwrap atlanir | `pages/DatabaseExplorerPage.tsx:63-181` | Yazilim Muhendisi |
| KS-5 | HIGH | SQL blacklist'te `SET search_path` yok -- schema isolation bypass mumkun | `explorer.controller.ts:837-845` | Guvenlik Mimari |
| KS-6 | HIGH | `includeSensitive` flag client-controlled -- SUPER_ADMIN password hash/token cleartext gorebilir | `explorer.controller.ts:145-146, 361, 399` | Guvenlik Mimari |
| KS-7 | HIGH | `ThrottlerGuard` kaldirilmis, global rate limiting sifir | `app.module.ts:128-131` | Guvenlik + Muhendis |
| KS-8 | HIGH | React Query yuklu + shared singleton ama hicbir yerde kullanilmiyor, homebrew useAsyncData | `package.json:17`, `useAsyncData.ts` | Yazilim Muhendisi |
| KS-9 | HIGH | 38 route'un hicbirinde `React.lazy` yok -- monolitik bundle | `Module.tsx` | Yazilim Muhendisi |
| KS-10 | HIGH | CQRS sadece tenant modulunde, diger 15 modul klasik pattern -- mimari tutarsizlik | `tenant/tenant.controller.ts:70-71` | Yazilim Muhendisi |

Bu bulgular audit sirasinda dogrulanacak ve derinlestirilecektir. Ajanlar bunlari baz alabilir ama sadece bunlarla sinirli kalmamalidirlar.

---

## 5. Dizin Yapisi

```
docs/audits/admin-panel/2026-03-14/
├── wave-1/
│   ├── 01-frontend-map.md
│   ├── 02-backend-map.md
│   ├── 03-contract-map.md
│   └── 04-dependency-map.md
├── wave-2a/
│   ├── 05-security.md
│   ├── 06-bugs.md
│   ├── 07-performance.md
│   └── 08-architecture.md
├── wave-2b/
│   ├── 09-testing.md
│   ├── 10-ux-a11y.md
│   ├── 11-tech-debt.md
│   └── 12-feature-completeness.md
├── deep-dives/
│   └── dd-{konu}.md              (dinamik, max 8)
├── resolvers/
│   └── rv-{konu}.md              (dinamik, max 3)
├── wave-3/
│   ├── 13-security-x-arch.md
│   ├── 14-bug-x-perf.md
│   ├── 15-test-x-security.md
│   └── 16-completeness-x-contract.md
├── wave-4/
│   ├── 17-final-synthesis.md
│   └── 18-qa-review.md
└── SUMMARY.md                    (orkestrator en sonda yazar, canli tablo DEGIL)
```

**Degisiklikler (v1'den):**
- MANIFEST.md kaldirildi (concurrent write riski)
- Dalga 2, 2a ve 2b olarak bolundu
- P12 "Data Flow" -> "Feature Completeness" olarak degistirildi (mock data tespiti icin)
- Dalga 3'ten P17 (Debt x Arch) cikarildi (P8 ile overlap)
- Ajan sayisi 19 -> 18 olarak optimize edildi
- SUMMARY.md sadece en sonda bir kez yazilir

---

## 6. Rapor Protokolu

### 6.1 Rapor Formati

Her ajan raporunu asagidaki formatta yazar:

```markdown
# [Rapor Basligi]

## Meta
- Ajan: {ajan-id}
- Tip: planned | deep-dive | resolver
- Dalga: 1 | 2a | 2b | 3 | 4 | deep | resolve
- Okunan raporlar: {dosya listesi}
- Toplam bulgu: X critical, Y high, Z medium, W low, V info

## Spawn Talepleri
(Eger daha derin incelenmesi gereken bir sey bulduysa)

### SPAWN-001
- **ID:** dd-{konu}
- **Severity:** critical | high
- **Tetikleyen:** {bulgunun kisa aciklamasi}
- **Hedef dosyalar:** {dosya listesi}
- **Gerekce:** {neden deep-dive gerekli}

## Celiskiler
(Eger okunan baska bir ajanin raporuyla celisen bulgu varsa)

### CONFLICT-001
- **Celisen ajan:** {diger ajan id}
- **Konu:** {ne hakkinda}
- **Bu ajan:** {bu ajanin gorusu}
- **Diger ajan:** {diger ajanin gorusu}
- **Onerilen resolver:** rv-{konu}

## Yonetici Ozeti
{3-5 cumle: en onemli bulgular, genel durum degerlendirmesi}

## Bulgular

### CRITICAL-001: {Baslik}
- **Dosya:** `{tam/yol/dosya.ts}:{satir}`
- **Aciklama:** {sorunun teknik detayi}
- **Kanit:** {koddan alintiyla destekle}
- **Etki:** {exploit/hata senaryosu}
- **Onerilen fix:** {somut cozum -- PR-ready detayda degil ama uygulanabilir}
- **Effort:** S | M | L | XL
- **Iliskili raporlar:** {varsa capraz referans}

### HIGH-001: {Baslik}
...

## Oneriler
{Genel mimari/strateji onerileri, bulgu bazinda degil}
```

**Degisiklikler (v1'den):**
- YAML frontmatter kaldirildi, yerine okunabilir Markdown basliklar (Claude'un dogal dil parse'i daha guvenilir)
- Her bulguya "Effort" eklendi (S/M/L/XL)
- Her bulguya "Kanit" eklendi (kod alintisi zorunlu)
- Spawn talepleri ayri bolum (daha kolay taranir)
- Minimum icerik: en az Yonetici Ozeti + 1 bulgu veya "bulgu yok" acik beyani

### 6.2 Rapor Boyut Limiti

- Dalga 1 (kesif) ajanlari: maksimum 1000 satir
- Dalga 2 (uzman) ajanlari: maksimum 500 satir
- Dalga 3 (capraz) ajanlari: maksimum 400 satir
- Deep-dive ajanlari: maksimum 600 satir
- Dalga 4 sentez: limit yok (ama ozetleri kullanir)

---

## 7. Ajan Tanimlari

### 7.1 Dalga 1 -- Kesif Ajanlari (4 paralel)

Kod tabanini tarayip yapisal harita cikarir. Tum sonraki ajanlar bunlarin ciktisini okur.

---

#### P1: Frontend Haritaci

- **Subagent type:** `admin-panel`
- **Cikti:** `wave-1/01-frontend-map.md`
- **Hedef dizin:** `web/modules/admin-panel/src/`
- **Gorev:** Frontend kod tabaninin yapisal haritasini cikar.

**Kontrol listesi:**
1. Her dosyanin tam yolunu ve satir sayisini listele
2. 500+ satirlik dosyalari `[BUYUK]` etiketi ile isaretle
3. Her sayfa icin data fetch pattern'ini belirle ve etiketle:
   - `[API]` -- adminApi.ts uzerinden veri cekiyor
   - `[ASYNC]` -- useAsyncData hook'u kullaniyor
   - `[DIRECT_FETCH]` -- Kendi fetch() cagrisi var, adminApi.ts bypass ediyor
   - `[MOCK]` -- API cagrisi yok, hardcoded/mock data kullaniyor
   - `[MIXED]` -- Birden fazla pattern karisik
4. Component -> hook -> service import dependency graph'ini ciz
5. Kullanilmayan export'lari tespit et
6. Module.tsx'teki route'lari listele (path + component eslesmesi)
7. `React.lazy` kullanimini kontrol et (var mi yok mu, nerede)

**KRITIK TALIMAT:** "Bu sayfa gercekten API'ye baglanmis mi?" sorusunu her sayfa icin sor. Mock data kullanan sayfalar audit'in en onemli kesiflerinden biri.

---

#### P2: Backend Haritaci

- **Subagent type:** `admin-api-service`
- **Cikti:** `wave-1/02-backend-map.md`
- **Hedef dizin:** `apps/admin-api-service/src/`
- **Gorev:** Backend kod tabaninin yapisal haritasini cikar.

**Kontrol listesi:**
1. Her controller icin: dosya yolu, HTTP method+path listesi, guard durumu (`@UseGuards` var/yok, `@Public()` var/yok)
2. Her service icin: dosya yolu, inject ettigi dependency'ler, disari expose ettigi public method'lar
3. Her entity icin: dosya yolu, tablo adi, iliskiler (OneToMany, ManyToOne vb.), schema
4. CQRS kullanim haritasi: hangi moduller CommandBus/QueryBus kullaniyor, hangileri klasik pattern
5. Modul yapisi: her NestJS module'un import/export/providers/controllers listesi
6. Admin identity alinma sekli: her endpoint'te admin kimligini nereden aliyor? (`req.user` JWT'den mi, `@Query('adminId')` client-supplied mi)
7. ThrottlerGuard durumu: global guard var mi, hangi endpoint'lerde per-route throttle var

---

#### P3: Kontrat Haritaci

- **Subagent type:** `general-purpose`
- **Cikti:** `wave-1/03-contract-map.md`
- **Hedef dosyalar:**
  - `web/modules/admin-panel/src/services/adminApi.ts`
  - `web/modules/admin-panel/src/pages/DatabaseExplorerPage.tsx` (dogrudan fetch)
  - `web/modules/admin-panel/src/components/database/*.tsx` (dogrudan fetch)
  - `web/modules/admin-panel/src/hooks/useUserPermissions.ts`
  - `apps/admin-api-service/src/**/*.controller.ts`
- **Gorev:** Frontend'in cagirdigi tum API endpoint'leri ile backend'in sundugu endpoint'leri eslestir.

**Kontrol listesi:**
1. Frontend'teki TUM API cagrilarini tara (sadece adminApi.ts degil, tum dosyalardaki `fetch()` cagrilari dahil)
2. Her cagri icin: URL, HTTP method, request body field adlari, expected response tipi
3. Her backend endpoint icin: path, method, DTO class adi, response tipi
4. Eslesmeyenleri etiketle:
   - `[ORPHAN_FE]` -- Frontend cagiriyor ama backend'de endpoint yok
   - `[ORPHAN_BE]` -- Backend endpoint var ama frontend hic cagirmiyor
   - `[FIELD_MISMATCH]` -- Request body field adlari uyusmuyor (orn: `query` vs `sql`)
   - `[TYPE_MISMATCH]` -- Response tipi uyusmuyor
5. Error response format tutarliligi: backend `{success, data, meta}` envelope donduruyor mu, frontend bunu bekliyor mu?
6. `whitelist: true` + `forbidNonWhitelisted: true` (main.ts:97-98) -- frontend'in gonderdigi ama DTO'da olmayan field'lar reject mi ediliyor?

---

#### P4: Bagimlilik Haritaci

- **Subagent type:** `general-purpose`
- **Cikti:** `wave-1/04-dependency-map.md`
- **Hedef dosyalar:**
  - `web/modules/admin-panel/package.json`
  - `web/modules/admin-panel/vite.config.ts`
  - `apps/admin-api-service/package.json`
  - `apps/admin-api-service/webpack.config.js`
  - Shell uygulamasinin Module Federation config'i (shared singleton uyumu icin)
- **Gorev:** Dependency ve build konfigurasyonu analizi.

**Kontrol listesi:**
1. package.json'da tanimli ama kodda hic import edilmeyen paketleri bul (`@tanstack/react-query` biliniyor, baska var mi?)
2. Module Federation shared singleton versiyonlari: admin-panel vs shell uyumlu mu?
3. vite.config.ts expose listesi (4 endpoint) vs gercek kullanim
4. webpack.config.js bos -- neden var? Kaldirilmali mi?
5. Build tool tutarsizligi: frontend Vite, backend Webpack
6. `bootstrap.tsx`, `App.tsx`, `routes.tsx` bos dosyalar -- neden var?

---

### 7.2 Dalga 2a -- Uzman Analiz (4 paralel)

Her biri Dalga 1 raporlarini okuyarak baslar.

---

#### P5: Guvenlik Denetcisi

- **Subagent type:** `general-purpose` (model: opus)
- **Okur:** 01-frontend-map, 02-backend-map, 03-contract-map, 04-dependency-map
- **Cikti:** `wave-2a/05-security.md`
- **Hedef dosyalar (kritik):**
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts`
  - `apps/admin-api-service/src/filters/global-exception.filter.ts`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts`
  - `web/modules/admin-panel/src/services/adminApi.ts`
  - `web/modules/admin-panel/src/components/database/QueryEditor.tsx`
  - `web/modules/admin-panel/src/pages/DatabaseExplorerPage.tsx`

**Kontrol listesi (40 madde, 8 kategori):**

**A. Authentication & Authorization**
- A1: Her controller'da `@UseGuards` vs global APP_GUARD tutarliligi
- A2: Admin identity source -- JWT (`req.user`) vs client-supplied (`@Query('adminId')`, `@Headers`)
- A3: Session ownership -- bir admin baska admin'in impersonation session'ini manipule edebilir mi?
- A4: `@Public()` dekoratoru kullanim analizi -- hangi endpoint'ler auth bypass?
- A5: Role case-sensitivity -- `SUPER_ADMIN` string eslesmesi tutarli mi?

**B. SQL Injection (Database Explorer)**
- B1: Raw SQL endpoint regex bypass analizi
- B2: `SET search_path` bypass testi (blocked statement listesinde mi?)
- B3: PL/pgSQL anonymous block (`DO $$ ... END $$`) bypass testi
- B4: Nested SQL comment (`/* /* */ DROP */`) bypass testi
- B5: `pg_catalog` / `information_schema` meta-data leak analizi
- B6: `pg_sleep` DoS, `current_setting()` config leak testi
- B7: Frontend-backend field name mismatch (`query` vs `sql`) kontrol
- B8: Schema/table identifier injection -- `isValidIdentifier` bypass senaryolari
- B9: `NODE_ENV !== 'production'` tek savunma hatti -- staging ortaminda acik mi?

**C. Sensitive Data Exposure**
- C1: `includeSensitive` flag client-controlled -- audit log, ek auth var mi?
- C2: Export endpoint sensitive data masking tutarliligi
- C3: Error response'larda DB yapisal bilgi sizintisi (dev/staging)
- C4: LocalStorage'daki query history hassas veri riski

**D. Cross-Tenant Isolation**
- D1: ALLOWED_SCHEMAS sinirlamasi yeterliligi
- D2: Raw SQL ile `tenant_*` schema erisim kontrolu
- D3: Impersonation `allowedTenants` fail-closed mu?
- D4: Debug session `tenantId` isolation

**E. Rate Limiting & DoS**
- E1: ThrottlerGuard kaldirilmis -- hangi endpoint'ler korunmasiz?
- E2: Export endpoint max 10K row -- DB load etkisi
- E3: Bulk IP rule ekleme -- array boyut siniri var mi?
- E4: Raw SQL `statement_timeout` -- paralel sorgu flood?

**F. CSRF & Network**
- F1: `credentials: 'include'` ile cookie gonderimi -- CSRF riski
- F2: CORS konfigurasyonu -- origin validation
- F3: `X-Forwarded-For` spoofing -- IP access rules

**G. Impersonation-Specific**
- G1: Token hash (SHA-256) storage -- timing attack?
- G2: Session expiry cron race condition window
- G3: `notifyTenantAdmin` stub (log only) -- tenant bilgilendirilmiyor
- G4: In-memory `activeSessions` cache -- service restart tutarsizligi

**H. Input Validation**
- H1: DTO validation coverage -- tum endpoint'lerde class-validator var mi?
- H2: Bulk operation array size limits
- H3: `JSON.parse(defaultValue)` -- prototype pollution riski

---

#### P6: Bug Avcisi

- **Subagent type:** `general-purpose` (model: opus)
- **Okur:** 01, 02, 03
- **Cikti:** `wave-2a/06-bugs.md`
- **Gorev:** Mantiksal hatalar, race condition, edge case buglari.

**Kontrol listesi:**
1. Race condition: useAsyncData concurrent request, cache invalidation zamanlama
2. Null/undefined: Optional chaining eksikligi, API response null kontrolu
3. State senkronizasyon: Pagination + filter + data fetch sirasi
4. Error boundary: Catch edilmeyen promise rejection, component crash
5. Retry mantigi: `apiFetch` 3x otomatik retry yapiyor, `useAsyncData` retry yapmiyor (kullaniciya birakiyor) -- cift retry YOK ama bunu dogrula
6. Off-by-one: Pagination offset hesaplama
7. Memory leak: useEffect cleanup, AbortController
8. Type safety: `any` kullanimi, unsafe type assertion
9. Edge case: Bos liste, tek sayfa pagination, uzun string, ozel karakter
10. useAsyncData global Map cache boyut limiti yok -- memory growth riski

**NOT:** P12 (Data Flow) v1'den cikarildi, data flow analizi bu ajana dahil edildi.

---

#### P7: Performans Analisti

- **Subagent type:** `general-purpose` (model: opus)
- **Okur:** 01, 02
- **Cikti:** `wave-2a/07-performance.md`

**Kontrol listesi:**
1. N+1 Query: Backend'de loop icinde DB sorgusu
2. Re-render: useCallback/useMemo eksikligi, prop drilling, inline object/function creation
3. Bundle size: 38 route lazy loading yok, React.lazy kullanilmamis
4. Cache: useAsyncData TTL degerleri, stale data riski, mutation sonrasi invalidation
5. DB Index: Sik kullanilan sorgularda index analizi
6. Memory: Global Map cache buyukluk siniri yok, large dataset client-side
7. API call: Duplicate cagri, waterfall pattern
8. Heavy computation: DataGrid rendering, large list (pagination vs infinite scroll)
9. Module Federation: Shared singleton bundle maliyeti (React Query yuklu ama kullanilmiyor)

---

#### P8: Mimari Elestirmen

- **Subagent type:** `general-purpose` (model: opus)
- **Okur:** 01, 02
- **Cikti:** `wave-2a/08-architecture.md`

**Kontrol listesi:**
1. **SRP:** adminApi.ts 3116 satir (1800+ tip tanimi + 1300 API fonksiyonu). Decomposition analizi: tipleri ayir, httpClient'i ayir, domain-bazli API modulleri olustur
2. **Katman analizi:** pages -> components -> hooks -> services yonu tutarli mi? Sayfalar dogrudan fetch() cagiriyor mu? Sayfalar kendi utility/component'lerini mi tanimlyor?
3. **CQRS tutarsizligi:** Tenant modulunde CQRS var, diger 15 modulde yok -- kasitli mi, mimari borclanma mi?
4. **Data fetch pattern tutarsizligi:** 4 farkli pattern var (adminApi, useAsyncData, direct fetch, mock data) -- standartlasma onerisi
5. **Sayfa monolitizmi:** 20 sayfa 600+ satir -- SRP ihlali, sayfa icinde tanimlanan utility/component'ler
6. **Backend modul kohezyon:** `ImpersonationModule` icinde `DebugToolsController` -- farkli domain ayni modulde
7. **Pattern consistency:** CSS-in-JS (InviteUserModal, PermissionCheckboxes) vs Tailwind (diger hersey)
8. **Error handling stratejisi:** Tutarli error propagation var mi?
9. **Module Federation:** 4 expose vs 38 route -- granularity uygun mu?

**SORUMLULUK SINIRI:** Bu ajan sadece yapisal/mimari sorunlara bakar. Dead code, TODO, unused import gibi kod-seviyesi temizlik konulari P11'in (Teknik Borc) sorumlulugundadir.

---

### 7.3 Dalga 2b -- Uzman Analiz (4 paralel)

Dalga 2a bittikten sonra baslar. Orkestrator Dalga 2a raporlarini degerlendirir, sonra 2b'yi baslatir.

---

#### P9: Test Denetcisi

- **Subagent type:** `general-purpose` (model: opus)
- **Okur:** 01, 02, 03
- **Cikti:** `wave-2b/09-testing.md`

**Kontrol listesi:**
1. Frontend test coverage: 6 test dosyasi / 72 kaynak = %8.3 -- hangi sayfalar/component'ler test edilmeli?
2. Backend test coverage: 30 test dosyasi / 181 kaynak = %16.6 -- hangi controller/service'ler test edilmeli?
3. Kritik flow test durumu: tenant create, impersonation, database explorer, billing
4. Mock kalitesi: Mevcut testlerdeki mock'lar gercek davranisi yansitir mi?
5. Edge case coverage: Hata senaryolari, bos input, buyuk input
6. Integration test: Frontend-backend entegrasyon testi var mi?
7. Risk-bazli test onceliklendirme matrisi olustur (guvenlik riski x test coverage)

---

#### P10: UX & Erisilebilirlik

- **Subagent type:** `general-purpose` (model: opus)
- **Okur:** 01
- **Cikti:** `wave-2b/10-ux-a11y.md`

**Kontrol listesi:**
1. ARIA: Role, label, describedby eksiklikleri
2. Keyboard: Tab order, focus management, keyboard shortcut
3. Responsive: Mobile/tablet gorunum, breakpoint davranisi
4. Loading state: Skeleton/spinner tutarliligi
5. Error state: Kullanici dostu hata mesajlari, retry secenegi
6. Empty state: Bos liste/tablo ne gosteriyor?
7. i18n: Turkce/Ingilizce karisimi, hardcoded string'ler (AlertRuleBuilder label'lari Turkce)
8. Form UX: Validation feedback, submit durumu
9. Color contrast: WCAG AA uyumu

---

#### P11: Teknik Borc Dedektifi

- **Subagent type:** `general-purpose` (model: opus)
- **Okur:** 01, 02
- **Cikti:** `wave-2b/11-tech-debt.md`

**Kontrol listesi:**
1. Dead code: Kullanilmayan fonksiyon, component, import, export
2. TODO/FIXME/HACK: Kod icindeki notlar (sayisi + konumu)
3. Duplicate: Tekrar eden kod bloklari (ozellikle adminApi.ts'deki getAuthHeader vs DatabaseExplorerPage'dekini)
4. Unused dependency: React Query yuklu ama kullanilmiyor. Baska var mi?
5. Legacy dosyalar: Bos webpack.config.js, bootstrap.tsx, App.tsx, routes.tsx
6. Type debt: `any` kullanimi, `as` type assertion, missing type annotation
7. Naming tutarsizligi: dosya/fonksiyon/degisken adlandirma

**SORUMLULUK SINIRI:** Bu ajan sadece kod-seviyesi temizlik konularina bakar. Mimari pattern tutarsizligi, layer violation, SRP gibi yapisal sorunlar P8'in (Mimari) sorumlulugundadir.

---

#### P12: Feature Completeness Auditor (YENI)

- **Subagent type:** `general-purpose` (model: opus)
- **Okur:** 01, 03
- **Cikti:** `wave-2b/12-feature-completeness.md`
- **Gorev:** Her sayfanin gercekten calisip calismadigini dogrula.

**Kontrol listesi:**
1. Her sayfa icin backend entegrasyon durumunu kontrol et:
   - `[FULLY_INTEGRATED]` -- Tum CRUD operasyonlari backend'e bagli
   - `[PARTIALLY_INTEGRATED]` -- Bazi operasyonlar mock, bazilari gercek
   - `[MOCK_ONLY]` -- Tamamen mock data, backend entegrasyonu yok
   - `[BROKEN_CONTRACT]` -- API cagrisi var ama backend'le uyumsuz (field mismatch vb.)
2. adminApi.ts'de tanimli ama hicbir sayfa tarafindan cagirilmayan API fonksiyonlarini `[UNUSED_API]` isaretle
3. `databaseApi` namespace'inin 20 fonksiyonundan kacini gercekten hangi sayfa cagiriyor?
4. CRUD tamamlanmisligi: list + create + update + delete var mi yoksa sadece list mi?
5. Her Mock data kullanan sayfa icin: hangi adminApi fonksiyonlari baglanmali? (mapping tablosu)

---

### 7.4 Deep-Dive Ajanlari (Dalga 2 sonrasi, max 4 paralel)

Dalga 2a ve 2b bittikten sonra, orkestrator tum raporlardaki spawn taleplerini toplar, deduplicate eder, severity'e gore siralar ve max 4 paralel deep-dive baslatir.

**Spawn karar matrisi:**

| Spawn Talebi Severity | Orkestrator Davranisi |
|------------------------|-----------------------|
| critical | Ilk batch'te spawn et |
| high | Ikinci batch'te spawn et (ilk batch bittikten sonra) |
| medium | Dalga 3 capraz ajanlarina birak, deep-dive yapma |
| low | Sadece final rapora not olarak ekle |

**Deep-dive ajan sablonu:**

```
Sen bir deep-dive analiz ajanisisin. Belirli bir konuda derinlemesine inceleme yapiyorsun.

## GOREV
{tetikleyen bulgunun detayli aciklamasi}

## HEDEF DOSYALAR
{spawn_request.target_files -- tam yollar}

## OKUMANIZ GEREKEN RAPORLAR
{tetikleyen ajanin raporu + ilgili wave-1 raporlari}
Rapor dosyalari: docs/audits/admin-panel/2026-03-14/{rapor_yolu}

## BEKLENEN CIKTI
1. Tetikleyen bulguyu dogrula veya cercut et (false positive mi?)
2. Eger dogruysa: exploit/hata senaryosu yaz (adim adim)
3. Somut fix onerisi ver (hangi dosya, hangi satir, ne degismeli)
4. Iliskili ikincil bulgulari raporla

## KURALLAR
1. Sadece kanita dayali bulgu raporla -- her iddia icin dosya:satir referansi ver
2. Koddan alintiyla destekle
3. Raporunu docs/audits/admin-panel/2026-03-14/deep-dives/dd-{konu}.md dosyasina yaz
4. Maksimum 600 satir
5. Bu ajan baska deep-dive spawn edemez (derinlik limiti: 1)
```

**Kaynak limiti:** `DEEP_DIVE_BUDGET = 8`

---

### 7.5 Resolver Ajanlari (gerektiginde)

Iki ajanin celisen bulgulari tespit edildiginde orkestrator tarafindan spawn edilir.

**Resolver ajan sablonu:**
```
Iki analiz ajani ayni konu hakkinda zit goruslere sahip. Senin gorevini:
1. Her iki ajanin raporunu oku
2. Ilgili kodu dogrudan incele
3. Trade-off analizi yap
4. Net bir karar ver ve gerekcelendir

## CELISEN GORUSLER
- Ajan A ({ajan_id}): {gorusu}
- Ajan B ({ajan_id}): {gorusu}

## KARAR FORMATI
- **Karar:** {A dogru | B dogru | ikisi de kismen dogru, su sentez onerisi}
- **Gerekce:** {teknik analiz}
- **Aksiyon:** {ne yapilmali}
```

**Kaynak limiti:** `RESOLVER_BUDGET = 3`

---

### 7.6 Dalga 3 -- Capraz Analiz (4 paralel)

Tum deep-dive'lar tamamlandiktan sonra baslar. Birden fazla uzmanin bulgularini capraz okuyarak sistemik sorunlari tespit eder.

---

#### P13: Guvenlik x Mimari

- **Okur:** 05-security, 08-architecture, 02-backend-map + ilgili deep-dive raporlari
- **Cikti:** `wave-3/13-security-x-arch.md`
- **Odak:**
  - adminApi.ts God file guvenlik yuzeyini nasil etkiliyor?
  - Global APP_GUARD'a bagimlilik -- tek nokta hatasi (single point of failure) riski
  - Controller-level guard tutarsizligi guvenlik boslugu yaratir mi?
  - Error handling stratejisi bilgi sizintisina yol aciyor mu?
  - Development-only endpoint'ler (`NODE_ENV`) production'a kacabilir mi?

#### P14: Bug x Performans

- **Okur:** 06-bugs, 07-performance
- **Cikti:** `wave-3/14-bug-x-perf.md`
- **Odak:**
  - Cache invalidation bug + N+1 query = stale data?
  - Memory leak + retry loop = crash?
  - Re-render + state sync = UI glitch?
  - Module Federation shared singleton + unused React Query = bundle bloat + bug?

#### P15: Test x Guvenlik

- **Okur:** 09-testing, 05-security
- **Cikti:** `wave-3/15-test-x-security.md`
- **Odak:**
  - Guvenlik acigi olan + test edilmemis = KRITIK bosluk matrisi
  - SQL injection var ama test yok?
  - Impersonation flow test edilmis mi?
  - RBAC bypass senaryolari test edilmis mi?
  - Risk-bazli test onceliklendirme matrisi olustur

#### P16: Feature Completeness x Kontrat

- **Okur:** 12-feature-completeness, 03-contract-map, 06-bugs
- **Cikti:** `wave-3/16-completeness-x-contract.md`
- **Odak:**
  - Mock data sayfalarinin backend'le entegrasyon yol haritasi
  - Orphan API endpoint'lerinin mock sayfalara baglanma potansiyeli
  - Frontend error handling backend hata formatiyla uyumlu mu?
  - API timeout'ta kullaniciya ne gosteriyor?

---

### 7.7 Dalga 4 -- Sentez (2 sirali)

---

#### P17: Bas Analist

- **Okur:** TUM raporlarin **Yonetici Ozeti + Bulgular** bolumlerini okur (tam rapor degil, ozet modu)
- **Cikti:** `wave-4/17-final-synthesis.md`
- **Gorev:**
  1. Tum bulgulari severity ile onceliklendir (tek liste)
  2. Tekrar eden temalari belirle (kok neden analizi)
  3. Bulgulari gruplara ayir: guvenlik / mimari / performans / test / UX / teknik borc / feature gap
  4. Aksiyon plani olustur: ne yapmali, hangi sirada, tahmini effort (S/M/L/XL)
  5. Bagimlilik grafi: hangi fix'ler baska fix'lere bagimli?
  6. Quick win listesi: S effort + high/critical impact
  7. Duplicate/overlap bulgu temizligi

#### P18: Kalite Kontrol

- **Okur:** P17 raporu + secilmis CRITICAL/HIGH bulgularin referans verdigi kaynak dosyalar (tum kodu degil)
- **Cikti:** `wave-4/18-qa-review.md`
- **Gorev:**
  1. P17'deki CRITICAL ve HIGH bulgulari dogrudan koda bakarak dogrula:
     - Referans verilen dosya mevcut mu?
     - Referans verilen satir +/- 10 satir icinde ilgili kod var mi?
     - Iddia edilen sorun gercekten gozlemlenebilir mi?
  2. Dogrulanamayan bulguları `[FALSE_POSITIVE]` olarak isaretle
  3. Kacirilmis olabilecek kritik alanlari tara (son gecis)
  4. Rapor tutarliligi: ajanlar birbiriyle celisiyor mu?
  5. Oneri kalitesi: onerilen fix'ler uygulanabilir mi?

---

## 8. Orkestrasyon Mantigi

```
FONKSIYON orkestrator_v2():

  HAZIRLIK:
    docs/audits/admin-panel/2026-03-14/ dizin yapisini olustur
    (wave-1/, wave-2a/, wave-2b/, deep-dives/, resolvers/, wave-3/, wave-4/)
    spawn_queue = []
    contradiction_log = []

  DALGA 1 (4 paralel, ~8 dakika):
    P1, P2, P3, P4 ajanlarini paralel spawn et
    Tum ajanlarin bitmesini bekle
    4 raporu oku -- spawn_requests kontrol et (Dalga 1'de beklenmez ama olabilir)

  DALGA 2a (4 paralel, ~10 dakika):
    P5, P6, P7, P8 ajanlarini paralel spawn et
    Tum ajanlarin bitmesini bekle

  DALGA 2a DEGERLENDIRME:
    4 raporu oku
    spawn_requests topla → deduplicate et (ayni target_files'a sahip istekleri birlestir)
    critical → spawn_queue'ya ekle (oncelik: 1)
    high → spawn_queue'ya ekle (oncelik: 2)
    contradictions → contradiction_log'a ekle

  DALGA 2b (4 paralel, ~10 dakika):
    P9, P10, P11, P12 ajanlarini paralel spawn et
    Tum ajanlarin bitmesini bekle

  DALGA 2b DEGERLENDIRME:
    4 raporu oku
    spawn_requests topla → deduplicate et → spawn_queue'ya ekle
    contradictions → contradiction_log'a ekle

  DEEP-DIVE BATCH 1 (max 4 paralel, ~8 dakika):
    spawn_queue'dan critical severity olanlari sec (max 4)
    Paralel spawn et, tum ajanlarin bitmesini bekle
    EGER spawn_queue'da high severity kalanlar varsa:

  DEEP-DIVE BATCH 2 (max 4 paralel, ~8 dakika):
    Kalan high severity deep-dive'lari spawn et (max 4)
    Tum ajanlarin bitmesini bekle

  RESOLVER (max 2 paralel, gerekirse, ~5 dakika):
    contradiction_log'da celiski varsa:
    max 2 resolver ajani spawn et
    Tum ajanlarin bitmesini bekle (veya Dalga 3 ile paralel)

  DALGA 3 (4 paralel, ~8 dakika):
    NOT: Tum deep-dive'lar ve resolver'lar TAMAMLANMIS olmali
    P13, P14, P15, P16 ajanlarini paralel spawn et
    Tum ajanlarin bitmesini bekle
    Raporlari oku (spawn_requests / contradictions olabilir ama budget tukenmisse skip)

  DALGA 4 (sirali, ~15 dakika):
    P17 (Bas Analist) spawn et -- tum raporlarin ozet bolumlerini okur
    P17 bitince P18 (Kalite Kontrol) spawn et

    EGER P18 yeni dogrulanmis CRITICAL buldu:
      VE wave4_iteration < 2:
        Son bir deep-dive spawn et
        P17'yi tekrar spawn et (guncellenmis sentez)
        wave4_iteration++
    DEGILSE:
      Tamamlandi

  FINAL:
    SUMMARY.md yaz (toplam ajan sayisi, bulgu ozeti, sure)
    Kullaniciya sonuclari sun
```

**Tahmini toplam sure:** 60-90 dakika
**Tahmini toplam ajan:** 18 planli + 4-8 deep-dive + 0-3 resolver = 22-29

---

## 9. Kaynak Limitleri

| Parametre | Deger | Gerekce |
|-----------|-------|---------|
| MAX_CONCURRENT_AGENTS | 4 | Claude Code'da guvenilir paralel batch boyutu |
| DEEP_DIVE_BUDGET | 8 | 2 batch x 4 paralel |
| RESOLVER_BUDGET | 3 | Celiskiler sinirli sayida bekleniyor |
| MAX_DEPTH | 1 | Deep-dive baska deep-dive spawn edemez |
| MAX_WAVE4_ITERATIONS | 2 | P18-P17 dongusu max 2 kez tekrar eder |
| REPORT_MAX_LINES | 500-1000 | Ajan tipine gore (Bolum 6.2) |
| MODEL | opus | Tum ajanlar Claude Opus 4.6 kullanir |

---

## 10. Hata Yonetimi ve Recovery

| Senaryo | Davranis |
|---------|----------|
| Ajan 15 dakikadan fazla surerse | Claude Code otomatik timeout uygular. Orkestrator eksik raporu "tamamlanmadi" olarak not alir, kalan ajanlarla devam eder. |
| Ajan rapor dosyasi yazmadan biterse | Orkestrator ciktiyi dogrudan okur ve ozet raporu kendisi yazar. |
| Ajan yanlis formatta rapor yazarsa | Orkestrator raporu dogal dil olarak okur (strict parse degil). Spawn talepleri ve celiskiler icin ayri "Spawn Talepleri" ve "Celiskiler" basliklari aranir. |
| Deep-dive budget tukendikten sonra yeni critical cikarsa | Orkestrator bunu P17 sentez raporuna "UNRESOLVED -- budget asildi, manuel inceleme gerekli" olarak yazar. |
| Resolver karar veremezse | Her iki goruse de atifta bulunularak "UNRESOLVED" olarak sentez raporuna dahil edilir. Kullaniciya sunulur. |
| Dalga 4 dongusu 2 iterasyonu asarsa | Durdurulur. P17'nin mevcut sentezi final rapor olarak kabul edilir. |
| Ajan birbiriyle celisen ama contradiction raporlamayan bulgu | P17 (Bas Analist) tum raporlari okurken tutarsizliklari tespit eder ve not duser. |

---

## 11. Basari Kriterleri

Her kriter olculebilir ve dogrulanabilir olarak tanimlanmistir.

| # | Kriter | Olcum Yontemi | Hedef |
|---|--------|---------------|-------|
| BK-1 | Planli ajanlarin tamamlanma orani | Tamamlanan / toplam planli ajan | >= 16/18 (%89+) |
| BK-2 | En az 1 deep-dive spawn edilmis | spawn_queue boyutu > 0 | Evet |
| BK-3 | Raporlar arasi cross-reference var | Dalga 2+ raporlarinda "Iliskili raporlar" referansi sayisi | >= 5 |
| BK-4 | False positive orani kabul edilebilir | P18 (QA) dogrulamasindan gecen CRITICAL+HIGH / toplam CRITICAL+HIGH | >= %80 dogrulama |
| BK-5 | Her CRITICAL bulgu icin somut fix onerisi | Fix onerisi olan CRITICAL / toplam CRITICAL | %100 |
| BK-6 | Sentez raporu aksiyon plani icerir | P17 raporunda oncelikli aksiyon listesi var mi | Evet, effort tahmini ile |
| BK-7 | Bilinen sorunlar (KS-1 ile KS-10) dogrulanmis | Bilinen sorunlarin kac tanesi ajanlar tarafindan dogrulanip raporlanmis | >= 8/10 |
| BK-8 | Mock data sayfalarinin tam listesi cikarilmis | P12 (Feature Completeness) raporunda MOCK_ONLY listesi | Evet |

---

## 12. Kapsam Disi (Out of Scope)

- Diger mikro-servislerin (auth, sensor, farm vb.) analizi
- GraphQL gateway analizi
- Runtime performans testi (load test, stress test)
- Deployment ve CI/CD pipeline analizi
- Veritabani schema optimizasyonu (ancak SQL injection analizi kapsamda)
- Frontend'in diger modullerle (shared-ui vb.) entegrasyon analizi (ancak Module Federation config kapsamda)
- Fix'lerin uygulanmasi (audit sadece bulgu ve oneri uretir)

---

## 13. Uygulama Plani

| Adim | Islem | Tahmini Sure |
|------|-------|--------------|
| 1 | Dizin yapisini olustur | 1 dakika |
| 2 | Dalga 1: 4 kesif ajani (paralel) | 8 dakika |
| 3 | Dalga 1 degerlendirme | 2 dakika |
| 4 | Dalga 2a: 4 uzman ajani (paralel) | 10 dakika |
| 5 | Dalga 2a degerlendirme | 3 dakika |
| 6 | Dalga 2b: 4 uzman ajani (paralel) | 10 dakika |
| 7 | Dalga 2b degerlendirme | 3 dakika |
| 8 | Deep-dive batch 1: max 4 (paralel) | 8 dakika |
| 9 | Deep-dive batch 2: max 4 (paralel, gerekirse) | 8 dakika |
| 10 | Resolver: max 2 (paralel, gerekirse) | 5 dakika |
| 11 | Dalga 3: 4 capraz analiz (paralel) | 8 dakika |
| 12 | Dalga 4: P17 sentez + P18 QA (sirali) | 15 dakika |
| 13 | Final: SUMMARY.md yaz | 2 dakika |
| **TOPLAM** | | **~60-85 dakika** |

---

## 14. Ajan Prompt Sablonu

Tum ajanlar asagidaki cekirdek talimatlarla spawn edilir:

```
Sen admin panel audit ekibinin bir uyesisin. Gorev: {gorev_ozeti}

## ROLLER VE SORUMLULUK
{rol_tanimi}
Sorumluluk sinirin: {sinir_aciklamasi}

## KONTROL LISTESI
{numarali_kontrol_listesi}

## OKUMANIZ GEREKEN RAPORLAR
Asagidaki raporlari oku ve bulgularini baz al:
{her rapor icin tam dosya yolu: docs/audits/admin-panel/2026-03-14/{rapor_yolu}}

## ODAK DOSYALARI
{hedef_dosya_listesi -- tam yollar}

## RAPOR FORMATI
Raporunu Bolum 6.1'deki formatta yaz.
Dosya yolu: docs/audits/admin-panel/2026-03-14/{cikti_yolu}

## KURALLAR
1. Sadece kanita dayali bulgu raporla. Her bulgu icin dosya:satir referansi VE kod alintisi ver.
2. Spec'in "Bilinen Sorunlar" bolumundeki onceden tanimli bulgulardan bagimsiz calis. Eger bilinen sorun kodda dogrulanmiyorsa acikca belirt.
3. Daha derin inceleme gereken bir sey bulduysan "Spawn Talepleri" bolumune yaz.
4. Okudugun baska bir ajanin raporuyla celisen bir bulgun varsa "Celiskiler" bolumune yaz.
5. Raporun maksimum {max_satir} satir olsun.
6. Raporun en az su bolumleri icersin: Yonetici Ozeti + Bulgular (en az 1) + Oneriler.
7. Opus 4.6 modeli kullan.
```
