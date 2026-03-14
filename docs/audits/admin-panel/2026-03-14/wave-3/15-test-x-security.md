# P15: Capraz Analiz -- Test x Guvenlik

**Tarih:** 2026-03-14
**Kaynak Raporlar:** P5 (Guvenlik Denetcisi), P9 (Test Denetcisi)
**Ajan:** Capraz Analiz Ajani (P15)

---

## Yonetici Ozeti

Guvenlik risk matrisi (P5) ile test kapsam haritasi (P9) ust uste konuldugunda kritik bir resim ortaya cikmaktadir: **P5 raporundaki 15 guvenlik bulgusunun yalnizca 3'u herhangi bir test tarafindan kapsanmaktadir.** Kapsanan 3 bulgunun da kapsamasi kismi veya yuzeyseldir. En tehlikeli kombinasyon: CRITICAL seviye SQL injection bypass vektorleri (SET search_path, DO bloklari, set_config) icin hicbir test yoktur -- mevcut explorer-security testleri bu bypass'lari dogrudan test etmemektedir. Ayrica tenant.security.spec.ts'deki 32 adet `expect(true).toBe(true)` placeholder'i, guvenlik testlerinin %60'inin hicbir sey dogrulamadigini gostermekte ve sahte bir guvenlik guvencesi olusturmaktadir.

---

## 1. SQL Injection Bypass (P5 CRITICAL) x Explorer Testleri (P9)

### Mevcut Durum

P5 raporu 3 CRITICAL bulgu tanimlamistir:
- **CRITICAL-001:** `SET search_path` / `set_config()` ile tenant izolasyonu kirma
- **CRITICAL-002:** `DO $$ ... END $$` PL/pgSQL bloklari ile regex bypass
- **CRITICAL-003:** `NODE_ENV` tek savunma hatti -- CRUD endpoint'lerinde kontrol yok

P9 raporu `explorer-security.spec.ts` dosyasini "COK IYI" olarak derecelendirmistir.

### Dogrulama Sonuclari

`explorer-security.spec.ts` dosyasinin kaynak kodu incelendi. Mevcut testler:
- 9 malicious schema/table identifier testi (MEVCUT, etkili)
- 11 dangerous statement bloklama testi -- DROP, DELETE, INSERT, UPDATE vb. (MEVCUT)
- 9 dangerous function bloklama testi -- pg_read_file, dblink vb. (MEVCUT)
- Production'da raw SQL engelleme testi (MEVCUT)
- Comment stripping bypass testi (MEVCUT, ancak sadece basit senaryo)

### Test Edilmeyen CRITICAL Bypass Vektorleri

| P5 Bulgusu | Bypass Vektoru | Test Durumu | Risk |
|-----------|---------------|-------------|------|
| CRITICAL-001 | `SELECT set_config('search_path','tenant_abc',true)` | YOK | Tenant veri sizintisi |
| CRITICAL-001 | `SET search_path = 'tenant_abc'` keyword'u | YOK | `dangerousStatements`'ta SET yok |
| CRITICAL-002 | `SELECT 1; DO $$ BEGIN EXECUTE 'DROP TABLE x'; END $$;` | YOK | DDL bypass |
| CRITICAL-002 | Nested comment: `/* /* */ SET ... */` | YOK | Keyword gizleme |
| CRITICAL-003 | CRUD endpoint'leri (POST/PUT/DELETE rows) NODE_ENV yok | YOK | Production'da veri degisikligi |
| HIGH-004 | `SELECT * FROM pg_catalog.pg_authid` | YOK | DB credential leak |
| HIGH-004 | `SELECT * FROM information_schema.columns WHERE table_schema='tenant_abc'` | YOK | Tenant schema kesfif |
| LOW-005 | `SELECT pg_sleep(29)` | YOK | DoS vektoru |
| LOW-005 | `SELECT current_setting('data_directory')` | YOK | Config leak |

**Sonuc:** Explorer testleri "bilinen" saldiri vektorlerini iyi kapsar, ancak P5'in tespiti olan **bypass vektorlerinin hicbirini test etmez**. Test suite'i yanlis bir guvenlik guvencesi vermektedir.

---

## 2. Identity Spoofing (P5 HIGH-001) x Debug-Tools Testi

### Mevcut Durum

P5 raporu `DebugToolsController`'da 4 endpoint'in `@Query('adminId')` ile client-supplied kimlik kullandigini tespit etmistir (satir 393, 606, 618, 655).

### Test Dogrulamasi

Codebase'de `debug-tools` icin **hicbir test dosyasi mevcut degildir**. Glob ve grep ile tarama yapildi:
- `apps/admin-api-service/src/**/*debug*spec*` -- SONUC YOK
- `apps/admin-api-service/src/**/*impersonation*spec*` -- SONUC YOK

| Endpoint | Guvenlik Riski | Test | Sonuc |
|----------|---------------|------|-------|
| `POST debug/sessions` + `@Query('adminId')` | Kimlik sahteciligi | YOK | KRITIK BOSLUK |
| `POST debug/feature-overrides` + `@Query('adminId')` | Audit trail manipulasyonu | YOK | KRITIK BOSLUK |
| `DELETE debug/feature-overrides` + `@Query('adminId')` revertedBy | Sahte revert kaydii | YOK | KRITIK BOSLUK |
| `GET debug/feature-overrides/value` + `JSON.parse(defaultValue)` | Prototype pollution | YOK | KRITIK BOSLUK |

**Sonuc:** 30+ endpoint'li bir controller icin sifir test. Identity spoofing guvenlik acigi tamamen gorulmezdir.

---

## 3. CRUD Production'da Acik (P5 HIGH-005) x Test Durumu

### Mevcut Durum

P5 raporu CRUD endpoint'lerinin (INSERT satir 542, UPDATE satir 589, DELETE satir 647) hicbir `NODE_ENV` kontrolu olmadigini tespit etmistir. Raw SQL endpoint'i production'da bloke edilirken, CRUD endpoint'leri tum ortamlarda acik kalmaktadir.

### Test Dogrulamasi

`explorer-security.spec.ts` CRUD testleri incelendi (Section 5, satir 452-491):

| Test | Ne Kontrol Eder | Ne Kontrol Etmez |
|------|-----------------|-------------------|
| `reject insert with no data` | Bos data validasyonu | Production'da erisilip erisilmedigini |
| `reject insert with malicious column names` | SQL injection sutun adi | NODE_ENV kontrolu |
| `reject update with no data` | Bos data validasyonu | Ortam kontrolu |
| `reject update with malicious column names` | SQL injection | Production durumu |
| `validate identifiers in delete` | Identifier validasyonu | Ortam kontrolu |

**5 CRUD testi var, ancak hicbiri ortam kontrolu test etmiyor.** Testler input validation'a odaklanmis, production erisim kontrolu atlanmis.

**Sonuc:** CRUD testleri fonksiyonel validasyonu kapsar, ancak P5'in tespit ettigi "production'da acik kalma" riskini test etmez. Production'da bir SUPER_ADMIN `auth.users` tablosuna INSERT yapabilir -- bu senaryo icin test yoktur.

---

## 4. Impersonation Session Manipulasyonu (P5 MEDIUM-007) x Test Durumu

### Mevcut Durum

P5 raporu `endImpersonation` metodunun session ownership kontrolu yapmadigini tespit etmistir (satir 442-466). `session.superAdminId !== endedBy` kontrolu yoktur. Admin A, Admin B'nin oturumunu sonlandirabilir.

### Test Dogrulamasi

- `ImpersonationController` testi: **YOK**
- `ImpersonationService` testi: **YOK**
- `impersonation.service.ts` incelendi -- `endImpersonation(sessionId, endReason, endedBy)` parametresinde `endedBy` sadece log icin kullanilir, yetki kontrolu yapilmaz.
- Ayrica ImpersonationService icinde rate limiting mantigi var (satir 72-120) -- bu da test edilmemistir.

| Flow | Guvenlik Riski | Test | Bosluk Tipi |
|------|---------------|------|-------------|
| `startImpersonation` | Yetki yukseltme | YOK | Controller + service |
| `endImpersonation` | Cross-admin session sonlandirma | YOK | Ownership kontrolu |
| `terminateSession` | Session sahiplik | YOK | Service level |
| `validateSession` | Token dogrulama | YOK | Auth flow |
| `grantPermission` | Permission escalation | YOK | RBAC |
| Rate limiting | Brute-force onleme | YOK | In-memory rate limit |

**Sonuc:** Impersonation modulu (controller + service + 16 endpoint) icin sifir test. P5'in tespit ettigi session ownership guvenlik acigi tamamen korumasizdir.

---

## 5. Placeholder Testlerin Guvenlik Etkisi

### Mevcut Durum

P9 raporu `tenant.security.spec.ts`'de ~%60 oraninda `expect(true).toBe(true)` placeholder oldugunu tespit etmistir. Kaynak kod analizi 32 adet placeholder oldugunu dogrulamistir.

### Placeholder'larin Guvenlik Kapsami

| Test Kategorisi | Placeholder Sayisi | Neyi "Test Eder" Gorunuyor | Gercek Durum |
|----------------|-------------------|-----------------------------|-------------|
| Cross-Tenant Access | 4 | Tenant izolasyonu | Hicbir assertion calistirmiyor |
| Schema-Level Isolation | 2 | Schema escape | Mock kurulmus, kontrol yapilmamis |
| Auth/Token Handling | 4 | JWT rejection | Hicbir HTTP istegi yapmiyor |
| RBAC | 4 | Rol bazli erisim | Sadece `expect(true)` |
| Authorization Bypass | 2 | Header manipulation | Yorum satirinda "would check" |
| IDOR | 2 | Obje referansi | Hicbir kontrol yok |
| CSRF/Request Forgery | 2 | CSRF korumasio | Hicbir kontrol yok |
| Business Logic | 3 | Tier limits, self-suspension | Hicbir kontrol yok |
| Information Disclosure | 3 | Enumeration, log redaction | Hicbir kontrol yok |
| Audit Trail | 3 | Log kaydii | Hicbir kontrol yok |
| Rate Limiting | 1 | Rate limit | `expect(true)` |
| Data Access | 2 | Sensitive data | Kosullu assertion |

**32 placeholder test, CI/CD'de "PASSED" gosterir.** Bu, ekibin "guvenlik testleri gecti" yanilsamasina yol acar. P5'in tespit ettigi CSRF riski (MEDIUM-006), IDOR riskleri ve authorization bypass'larin hicbiri gercekten test edilmemektedir, ancak test dosyasi bunlari kapsiyormus gibi gorunur.

---

## 6. Risk-Bazli Test Onceliklendirme Matrisi

### Derecelendirme Kriterleri
- **Guvenlik Riski:** P5 raporundaki severity (CRITICAL/HIGH/MEDIUM/LOW)
- **Test Durumu:** YOK / PLACEHOLDER / KISMI / MEVCUT
- **Oncelik:** P1 (hemen) / P2 (sprint icinde) / P3 (sonraki sprint) / P4 (backlog)

| # | Endpoint/Feature | Guvenlik Riski (P5) | Test Durumu (P9) | Bosluk Turu | Oncelik |
|---|-----------------|---------------------|------------------|-------------|---------|
| 1 | `POST /explorer/query` -- SET/set_config bypass | CRITICAL-001: Tenant izolasyonu kirma | KISMI: SQL injection testi var, bypass yok | Bypass vektoru test edilmemis | **P1** |
| 2 | `POST /explorer/query` -- DO $$ PL/pgSQL bypass | CRITICAL-002: DDL/DML calistirma | KISMI: Comment test var, DO testi yok | Bypass vektoru test edilmemis | **P1** |
| 3 | `POST/PUT/DELETE /explorer/.../rows` -- NODE_ENV yok | CRITICAL-003 + HIGH-005: Production CRUD | KISMI: Input validation var, ortam testi yok | Ortam kontrolu testi yok | **P1** |
| 4 | `POST /debug/sessions` + `@Query('adminId')` | HIGH-001: Kimlik sahteciligi | YOK: Hicbir test mevcut degil | Tum controller test disinda | **P1** |
| 5 | `GET /explorer/.../data?includeSensitive=true` | HIGH-002: Hassas veri maskeleme bypass | KISMI: Maskeleme testi var, yetki testi yok | Client-controlled flag testi yok | **P1** |
| 6 | `POST /explorer/query` -- pg_catalog/information_schema | HIGH-004: Meta-data leak | YOK: blockedSchemas testi yok | Sistem katalog erisimi test edilmemis | **P1** |
| 7 | `POST /impersonation/sessions/start` | P5 MEDIUM-007 + P9 KRITIK | YOK: Controller + service sifir test | Tum impersonation flow test disinda | **P1** |
| 8 | `POST /impersonation/sessions/:id/end` -- ownership | MEDIUM-007: Cross-admin session | YOK: Ownership kontrolu yok, testi de yok | Session sahiplik dogrulamasi yok | **P1** |
| 9 | `tenant.security.spec.ts` placeholder'lar | Sahte guvenlik guvencesi (cross-cutting) | PLACEHOLDER: 32x `expect(true).toBe(true)` | CI/CD yanilis rapor | **P1** |
| 10 | `POST /billing/subscriptions/:id/cancel` + `cancelledBy` | HIGH (Audit trail sahteciligi) | YOK: BillingController sifir test | Client-supplied identity, test yok | **P2** |
| 11 | `POST /billing/custom-plans/:id/approve` + `approverId` | HIGH (Finansal onay sahteciligi) | YOK: BillingController sifir test | Client-supplied approver, test yok | **P2** |
| 12 | `POST /billing/invoices/:id/void` + `voidedBy` | HIGH (Fatura iptal sahteciligi) | YOK: BillingController sifir test | Client-supplied voider, test yok | **P2** |
| 13 | `GET /debug/feature-overrides/value` + JSON.parse | MEDIUM-005: Prototype pollution | YOK: Hicbir test mevcut degil | Kontrolsuz JSON.parse testi yok | **P2** |
| 14 | `POST /settings/ip-access/whitelist/bulk` -- array limit | MEDIUM-003: DoS via unbounded array | YOK: IP access controller testi yok | DTO validation testi yok | **P2** |
| 15 | `POST /settings/ip-access/whitelist/bulk` -- createdBy | MEDIUM-004: Audit trail manipulasyonu | YOK: IP access controller testi yok | Client-supplied identity testi yok | **P2** |
| 16 | `POST /explorer/query` -- pg_sleep DoS | LOW-005: Connection pool tuketme | YOK: dangerousFunctions listesinde yok | pg_sleep/current_setting testi yok | **P2** |
| 17 | ThrottlerGuard kaldirilmis -- tum endpoint'ler | MEDIUM-001: Rate limit yok | YOK: throttler-guard.spec.ts var ama global devre disi | Guard testi var, kaldirilma testi yok | **P3** |
| 18 | `credentials:'include'` + CSRF token yok | MEDIUM-006: CSRF riski (Bearer azaltir) | PLACEHOLDER: tenant.security CSRF testi sahte | Gercek CSRF testi yok | **P3** |
| 19 | `tenant.e2e.spec.ts` tamamen `describe.skip` | E2E kapsam sifir | SKIP: 100+ satir comment'li assertion | E2E altyapisi yok | **P3** |
| 20 | SecurityMonitoringController -- hardcoded identity | HIGH: Gercek kullanici kimligi alinmiyor | YOK: Controller testi yok | Identity dogrulama testi yok | **P3** |

---

## 7. Tehlikeli Kesisim Noktalari

### 7.1 "Tested but Vulnerable" Yanilsamasi

Explorer-security testleri "COK IYI" dereceli (P9) ancak P5'in CRITICAL bulgularini kapsamamaktadir. Bu, ekibin "SQL injection testlerimiz var" diyerek bypass vektorlerini goz ardi etmesine yol acar. Mevcut testler `DROP`, `DELETE` gibi basit keyword'leri engeller; ancak `set_config()`, `DO $$`, `pg_catalog` gibi sofistike vektorleri dogrulamaz.

### 7.2 Placeholder Testlerin Maskeleme Etkisi

`tenant.security.spec.ts` 9 guvenlik kategorisini (CSRF, IDOR, RBAC, rate limiting vb.) "test eder" gorunur. CI/CD'de 45+ test "PASSED" olarak raporlanir. Ancak bu testlerin hicbiri gercek bir assertion icermez. P5'in MEDIUM-006 (CSRF), MEDIUM-007 (session ownership), HIGH-001 (identity spoofing) bulgulari bu placeholder'lar tarafindan "kapsanmis" gibi gorunur ama gercekte korumasizdir.

### 7.3 Test Yok + Guvenlik Acigi = Kara Delik

3 modul hem guvenlik acigi hem de sifir test durumundadir:

| Modul | Endpoint Sayisi | Guvenlik Bulgu Sayisi (P5) | Test Sayisi | Durum |
|-------|----------------|---------------------------|-------------|-------|
| DebugToolsController | 30+ | 2 (HIGH-001, MEDIUM-005) | 0 | KARA DELIK |
| ImpersonationController | 16 | 1 (MEDIUM-007) | 0 | KARA DELIK |
| BillingController | ~50 | 3 (client-supplied identity) | 0 | KARA DELIK |

Bu 3 modul toplam ~96 endpoint icerir ve hicbirinde guvenlik testi yoktur.

### 7.4 CRUD + NODE_ENV Boşlugu

Raw SQL endpoint'i production'da bloke edilir ve bunun testi vardir. Ancak CRUD endpoint'leri (INSERT/UPDATE/DELETE) production'da acik kalir ve bunu test eden hicbir test yoktur. P5 bunu HIGH-005 olarak raporlamistir. Explorer-security testleri CRUD input validation'i test eder (5 test) ama production erisim kontrolunu degil. Bu, "testlerimiz var" diyerek production riskini goz ardi etme tehlikesi olusturur.

---

## 8. Oneriler

### P1: Kritik -- Hemen (Sprint 1, Hafta 1)

1. **Placeholder temizligi:** `tenant.security.spec.ts`'deki 32 placeholder'i ya gercek assertion'larla degistir ya da dosyayi sil. CI/CD'de sahte "PASSED" raporunu sonlandir.
2. **Explorer bypass testleri:** `SET search_path`, `set_config()`, `DO $$`, `pg_catalog.pg_authid`, `information_schema.columns`, `pg_sleep`, `current_setting` icin negatif testler ekle.
3. **CRUD ortam testi:** CRUD endpoint'lerinin production'da bloke edilip edilmedigini test et (`NODE_ENV=production` senaryosu).
4. **DebugTools identity testi:** `@Query('adminId')` yerine `req.user.id` kullanildigini dogrulayan test yaz (once kodu duzelttikten sonra).

### P2: Yuksek -- Sprint 1 icinde

5. **Impersonation controller testi:** `startImpersonation`, `endImpersonation` (ownership kontrolu), `validateSession` testleri yaz.
6. **Billing identity testleri:** `cancelledBy`, `approverId`, `voidedBy` parametrelerinin JWT'den alinip alinmadigini dogrula.
7. **IP access bulk testi:** Array boyut siniri ve `createdBy` dogrulama testleri ekle.

### P3: Orta -- Sprint 2

8. **E2E altyapisi:** `tenant.e2e.spec.ts`'deki `describe.skip`'i kaldir, test DB kurulumu yap.
9. **ThrottlerGuard testi:** Global throttle kaldirilmasinin etkisini ve per-route throttle eksikligini dokumante eden test yaz.
10. **includeSensitive yetki testi:** `includeSensitive=true` icin ek yetkilendirme kontrolu testi ekle.

---

## 9. Sayisal Ozet

| Metrik | Deger |
|--------|-------|
| P5 toplam bulgu | 15 (3 CRITICAL, 5 HIGH, 7 MEDIUM, 5 LOW) |
| Herhangi bir testle kapsanan P5 bulgusu | 3 (%20) |
| Tam kapsanan P5 bulgusu | 0 (%0) |
| Kismi kapsanan P5 bulgusu (bypass testi eksik) | 3 (CRITICAL-001 kismi, CRITICAL-003 kismi, HIGH-002 kismi) |
| Test yok + guvenlik acigi bulunan modul | 3 (DebugTools, Impersonation, Billing) |
| Bu modullerin toplam endpoint sayisi | ~96 |
| Placeholder guvenlik testi sayisi | 32 |
| Placeholder'larin etkiledigi guvenlik kategorisi | 9 (CSRF, IDOR, RBAC, rate limit, audit vb.) |
| Matristeki P1 oncelikli madde | 9 |
| Matristeki P2 oncelikli madde | 7 |
| Kapanmasi gereken en acil bosluk | Explorer bypass + Placeholder temizligi |
