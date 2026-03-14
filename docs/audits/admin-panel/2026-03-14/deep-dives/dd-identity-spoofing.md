# Deep Dive: Admin Identity Spoofing Vektorleri

**Tarih:** 2026-03-14
**Tetikleyen:** HIGH-001 (P5 raporu), P2 raporu client-supplied identity bulgulari
**Kapsam:** admin-api-service icindeki tum client-supplied admin identity kullanim noktalari
**Ciddiyet:** YUKSEK -- audit trail manipulasyonu + horizontal privilege escalation

---

## 1. Tum Client-Supplied Identity Kullanim Noktalari

### Kategori A: @Query('adminId') -- Dogrudan Admin Kimligi Sahteciligi

| # | Dosya | Satir | Endpoint | Parametre | Kullanim |
|---|-------|-------|----------|-----------|----------|
| A1 | `debug-tools.controller.ts` | 393 | `POST /debug/sessions` | `@Query('adminId')` | Debug session baslatan admin olarak kaydedilir |
| A2 | `debug-tools.controller.ts` | 606 | `POST /debug/feature-overrides` | `@Query('adminId')` | Feature flag override yapan admin olarak kaydedilir |
| A3 | `debug-tools.controller.ts` | 618 | `POST /debug/feature-overrides/:id/revert` | `@Query('adminId')` | Override'i geri alan admin olarak kaydedilir |
| A4 | `debug-tools.controller.ts` | 655 | `GET /debug/feature-overrides` | `@Query('adminId')` | Filtre parametresi (okuma, dusuk risk) |

### Kategori B: @Body('*By') -- Audit Trail Actor Sahteciligi (Billing)

| # | Dosya | Satir | Endpoint | Parametre | Kullanim |
|---|-------|-------|----------|-----------|----------|
| B1 | `billing.controller.ts` | 119 | `POST /billing/plans/:id/deprecate` | `@Body('updatedBy')` | Plan deprecate eden kisi |
| B2 | `billing.controller.ts` | 138 | `POST /billing/plans/seed` | `@Body('createdBy')` | Default plan'lari olusturan kisi |
| B3 | `billing.controller.ts` | 199 | `POST /billing/discounts/:id/deactivate` | `@Body('updatedBy')` | Indirim kodunu deaktive eden kisi |
| B4 | `billing.controller.ts` | 222 | `POST /billing/discounts/apply` | `@Body('redeemedBy')` | Indirim kodunu kullanan kisi |
| B5 | `billing.controller.ts` | 334 | `POST /billing/subscriptions/tenant/:id/cancel` | `@Body('cancelledBy')` | Aboneligi iptal eden kisi |
| B6 | `billing.controller.ts` | 348 | `POST /billing/subscriptions/tenant/:id/reactivate` | `@Body('reactivatedBy')` | Aboneligi yeniden aktive eden kisi |
| B7 | `billing.controller.ts` | 357 | `POST /billing/subscriptions/tenant/:id/extend-trial` | `@Body('extendedBy')` | Deneme suresini uzatan kisi |
| B8 | `billing.controller.ts` | 529 | `POST /billing/custom-plans/:id/approve` | `@Body('approverId')` | Ozel plani onaylayan kisi |
| B9 | `billing.controller.ts` | 538 | `POST /billing/custom-plans/:id/reject` | `@Body('rejectedBy')` | Ozel plani reddeden kisi |
| B10 | `billing.controller.ts` | 622 | `POST /billing/invoices/:id/mark-paid` | `@Body('markedBy')` | Faturayi odenmis isareyleyen kisi |
| B11 | `billing.controller.ts` | 631 | `POST /billing/invoices/:id/void` | `@Body('voidedBy')` | Faturayi gecersiz kilan kisi |

### Kategori C: @Body('updatedBy') / @Body('createdBy') -- Settings

| # | Dosya | Satir | Endpoint | Parametre | Kullanim |
|---|-------|-------|----------|-----------|----------|
| C1 | `settings.controller.ts` | 82 | `PUT /settings/bulk` | `@Body() { updatedBy }` | Toplu ayar guncelleyen kisi |
| C2 | `settings.controller.ts` | 113 | `PUT /settings/config/email` | `@Body() { updatedBy }` | Email konfigurasyonu degistiren kisi |
| C3 | `settings.controller.ts` | 155 | `PUT /settings/config/maintenance` | `@Body() { updatedBy }` | Bakim modunu degistiren kisi |
| C4 | `settings.controller.ts` | 186 | `PUT /settings/config/billing` | `@Body() { updatedBy }` | Faturalama konfigurasyonu degistiren kisi |
| C5 | `settings.controller.ts` | 230 | `POST /settings/import` | `@Body() { updatedBy }` | Ayarlari import eden kisi |

### Kategori D: @Query('updatedBy') -- Tenant Configuration

| # | Dosya | Satir | Endpoint | Parametre | Kullanim |
|---|-------|-------|----------|-----------|----------|
| D1 | `tenant-configuration.controller.ts` | 110 | `PUT /settings/tenant/:id/user-limits` | `@Query('updatedBy')` | Kullanici limitlerini degistiren kisi |
| D2 | `tenant-configuration.controller.ts` | 128 | `PUT /settings/tenant/:id/storage` | `@Query('updatedBy')` | Depolama konfigurasyonunu degistiren kisi |
| D3 | `tenant-configuration.controller.ts` | 155 | `PUT /settings/tenant/:id/api` | `@Query('updatedBy')` | API konfigurasyonunu degistiren kisi |
| D4 | `tenant-configuration.controller.ts` | 257 | `PUT /settings/tenant/:id/branding` | `@Query('updatedBy')` | Marka ayarlarini degistiren kisi |
| D5 | `tenant-configuration.controller.ts` | 275 | `PUT /settings/tenant/:id/security` | `@Query('updatedBy')` | Guvenlik konfigurasyonunu degistiren kisi |
| D6 | `tenant-configuration.controller.ts` | 325 | `PUT /settings/tenant/:id/notifications` | `@Query('updatedBy')` | Bildirim konfigurasyonunu degistiren kisi |
| D7 | `tenant-configuration.controller.ts` | 343 | `PUT /settings/tenant/:id/features` | `@Query('updatedBy')` | Feature flag'lari degistiren kisi |
| D8 | `tenant-configuration.controller.ts` | 377 | `PUT /settings/tenant/:id/data-retention` | `@Query('updatedBy')` | Veri saklama politikasini degistiren kisi |

### Kategori E: @Body('createdBy') -- IP Access

| # | Dosya | Satir | Endpoint | Parametre | Kullanim |
|---|-------|-------|----------|-----------|----------|
| E1 | `ip-access.controller.ts` | 127 | `POST /settings/ip-access/whitelist/bulk` | `@Body() { createdBy }` | IP whitelist kurallarini olusturan kisi |
| E2 | `ip-access.controller.ts` | 141 | `POST /settings/ip-access/blacklist/bulk` | `@Body() { createdBy }` | IP blacklist kurallarini olusturan kisi |

### Kategori F: @Body() DTO -- Compliance

| # | Dosya | Satir | Endpoint | Parametre | Kullanim |
|---|-------|-------|----------|-----------|----------|
| F1 | `compliance.controller.ts` | 89-90 | `POST /security/compliance/reports` | `@Body() { generatedBy, generatedByName }` | Uyum raporu olusturan kisi |

### Kategori G: Hardcoded 'admin' -- Phantom Identity

| # | Dosya | Satir | Endpoint | Deger | Kullanim |
|---|-------|-------|----------|-------|----------|
| G1 | `audit-trail.controller.ts` | 297 | `POST /security/audit/retention-policies` | `createdBy: 'admin'` | Retention policy olusturan kisi |
| G2 | `security-monitoring.controller.ts` | 503 | `PUT /security/monitoring/incidents/:id` | `'admin'` | Incident'i guncelleyen kisi |
| G3 | `ticket.controller.ts` | 200 | `POST /support/tickets` | `createdBy: 'tenant-user-id'` | Ticket olusturan kisi |

### Kategori H: Kismen Duzeltilmis (Referans)

| # | Dosya | Satir | Durum | Kullanim |
|---|-------|-------|-------|----------|
| H1 | `impersonation.controller.ts` | 263-273 | DUZELTILMIS | `grantPermission`: `req.user.id` JWT'den |
| H2 | `impersonation.controller.ts` | 300-317 | DUZELTILMIS | `startImpersonation`: `req.user.id/email` JWT'den |
| H3 | `impersonation.controller.ts` | 321-331 | DUZELTILMIS | `endImpersonation`: `req.user.id` JWT'den |
| H4 | `impersonation.controller.ts` | 334-346 | DUZELTILMIS | `terminateSession`: `req.user.id` JWT'den |
| H5 | `global-settings.controller.ts` | 404 | KISMEN | `req.user?.email \|\| req.user?.id \|\| 'admin'` fallback |

**Toplam:** 37 client-supplied identity kullanim noktasi (4 duzeltilmis, 3 hardcoded, 30 aktif zafiyet)

---

## 2. Neden JWT (req.user) Yerine Client-Supplied?

### Kok Neden Analizi

**DebugToolsController (A1-A4):**
Controller'da `@Req()` import edilmemis, `Request` tipi kullanilmiyor. Controller baslangicindan beri
frontend'in adminId'yi query parametresi olarak gondermesi uzerine tasarlanmis. Ayni moduldeki
`ImpersonationController` SECURITY FIX comment'leri ile duzeltilmis (H1-H4), ancak bu duzeltme
`DebugToolsController`'a uygulanmamis. Bu, iki controller'in farkli zamanlarda veya farkli
gelistiriciler tarafindan yazildigini gosteriyor.

**BillingController (B1-B11):**
11 endpoint'te 8 farkli `*By` alan adi kullaniliyor. Controller'da `@Req()` veya `@CurrentUser()`
hicbir yerde kullanilmiyor. Bu, billing modulu tasariminin "kim yapti" bilgisini bir is mantigi
parametresi olarak gormesinden kaynaklaniyor -- guvenlik bilinci eksikligi.

**SettingsController (C1-C5):**
`updatedBy` her zaman opsiyonel (`?`). Gonderilmezse `undefined` olarak kaydediliyor. Bu, "varsa
kaydet" yaklasimi -- audit trail zorunlulugu yok.

**TenantConfigurationController (D1-D8):**
8 endpoint'in hepsi ayni pattern: `@Query('updatedBy') updatedBy?: string`. URL query string'inde
identity tasimak en tehlikeli varyant -- server loglarinda, proxy loglarinda, browser gecmisinde
gorunur.

**IpAccessController (E1-E2):**
Inline type kullanimi (`{ ips: string[]; tenantId?: string; createdBy?: string }`) -- DTO sinifi
bile olusturulmamis. Hizli prototipleme belirtisi.

**ComplianceController (F1):**
`GenerateReportDto` icinde `generatedBy` ve `generatedByName` zorunlu alanlar. Uyum raporunun
kimin tarafindan olusturuldugu kritik bir bilgidir ve kesinlikle client-supplied olmamalidir.

**Hardcoded 'admin' (G1-G3):**
Comment'lerde "Would come from auth context" yaziyor -- gelecekte duzeltilecek placeholder
olarak birakilmis. Ancak bu haliyle tum retention policy, incident update ve ticket islemleri
ayni phantom "admin" kimligine atfedilir, gercek operator bilinmez.

---

## 3. Audit Trail Manipulasyonu Senaryosu

### Senaryo: Fatura Sahteciligi Izlerini Gizleme

**Onkosul:** Admin A (merakli/kotu niyetli), Admin B (kidemli finans yoneticisi), her ikisi de
SUPER_ADMIN rolunde.

**Adim 1 -- Sahte Fatura Onaylama:**
```http
POST /billing/invoices/inv-12345/mark-paid HTTP/1.1
Authorization: Bearer <Admin_A_JWT>
Content-Type: application/json

{
  "amount": 15000,
  "markedBy": "admin-b-uuid-goes-here"
}
```
Sonuc: Veritabaninda `invoices.markedBy = 'admin-b-uuid'` kaydedilir. Audit trail Admin B'yi
gosteriyor, islem Admin A tarafindan yapildi.

**Adim 2 -- Abonelik Iptali:**
```http
POST /billing/subscriptions/tenant/tenant-xyz/cancel HTTP/1.1
Authorization: Bearer <Admin_A_JWT>
Content-Type: application/json

{
  "reason": "Non-payment (customer requested)",
  "cancelledBy": "admin-b-uuid-goes-here"
}
```
Sonuc: Musterinin aboneligi iptal edildi, iz Admin B'de.

**Adim 3 -- Indirim Kodu Suistimali:**
```http
POST /billing/discounts/apply HTTP/1.1
Authorization: Bearer <Admin_A_JWT>
Content-Type: application/json

{
  "code": "VIP50",
  "tenantId": "admin-a-own-tenant",
  "originalAmount": 10000,
  "redeemedBy": "admin-b-uuid-goes-here"
}
```
Sonuc: Admin A kendi tenant'ina %50 indirim uyguladi, iz Admin B'de.

**Adim 4 -- Izleri Silme (Tenant Config):**
```http
PUT /settings/tenant/tenant-xyz/data-retention?updatedBy=admin-b-uuid HTTP/1.1
Authorization: Bearer <Admin_A_JWT>
Content-Type: application/json

{
  "auditLogRetentionDays": 7
}
```
Sonuc: Audit log saklama suresi 7 gune dusuruldu. 7 gun sonra kanit otomatik silinir.
Bu degisikligin iz'i de Admin B'ye ait gorunuyor.

**Etki:**
- Admin B suclaniyor, Admin A gorulmuyor
- Eger Admin B hesabini inceleyen biri varsa: "Bu kadar islem yapmis" diyecek
- Gercek saldirgan (Admin A) audit trail'de hic gorulmuyor
- Veri saklama suresi kisaltilarak kanit imhasi otomatiklesiyor

---

## 4. Horizontal Privilege Escalation Senaryosu

### Senaryo: Admin A, Admin B'nin Debug Session'ini ve Feature Flag Yetkisini Ele Geciriyor

**Onkosul:** Admin A (junior admin, sinirli erisim), Admin B (senior admin, genis erisim).
Her ikisi de SUPER_ADMIN ama organizasyonel olarak Admin B daha yetkili.

**Adim 1 -- Admin B'nin Kimligiyle Debug Session Baslatma:**
```http
POST /debug/sessions?adminId=admin-b-uuid HTTP/1.1
Authorization: Bearer <Admin_A_JWT>
Content-Type: application/json

{
  "tenantId": "target-tenant-uuid",
  "sessionType": "QUERY_INSPECTOR",
  "durationMinutes": 480
}
```
Sonuc: 8 saatlik bir debug session baslatildi. Session kayitlarinda `adminId = Admin B`.
Admin A, target tenant'in query'lerini ve API cagrilarini gozetleyebilir. Sorusturma
yapildiginda "Admin B bu session'i acmis" denecek.

**Adim 2 -- Admin B'nin Kimligiyle Feature Flag Override:**
```http
POST /debug/feature-overrides?adminId=admin-b-uuid HTTP/1.1
Authorization: Bearer <Admin_A_JWT>
Content-Type: application/json

{
  "tenantId": "target-tenant-uuid",
  "featureKey": "billing.bypass_payment_check",
  "originalValue": false,
  "overrideValue": true,
  "reason": "Customer support request #12345"
}
```
Sonuc: Target tenant icin odeme kontrolu devre disi birakildi. Override `Admin B` tarafindan
yapilmis gorunuyor. Admin A artik target tenant icin ucretsiz islem yapabilir.

**Adim 3 -- Admin B'nin Kimligiyle Uyum Raporu:**
```http
POST /security/compliance/reports HTTP/1.1
Authorization: Bearer <Admin_A_JWT>
Content-Type: application/json

{
  "complianceType": "SOC2",
  "reportPeriodStart": "2026-01-01",
  "reportPeriodEnd": "2026-03-14",
  "generatedBy": "admin-b-uuid",
  "generatedByName": "Admin B Name"
}
```
Sonuc: SOC2 uyum raporu Admin B'nin imzasiyla olusturuldu. Bu rapor disariya sunulursa,
Admin B sorumlu tutuluyor.

**Adim 4 -- IP Whitelist ile Kalici Erisim:**
```http
POST /settings/ip-access/whitelist/bulk HTTP/1.1
Authorization: Bearer <Admin_A_JWT>
Content-Type: application/json

{
  "ips": ["203.0.113.50"],
  "createdBy": "admin-b-uuid"
}
```
Sonuc: Admin A'nin kisisel IP adresi whitelist'e eklendi, iz Admin B'de. Hesabi
kilitlense bile IP whitelist uzerinden erisim devam edebilir (eger IP-based auth
mekanizmasi varsa).

**Adim 5 -- Tenant Guvenlik Konfigurasyonunu Zayiflatma:**
```http
PUT /settings/tenant/target-tenant-uuid/security?updatedBy=admin-b-uuid HTTP/1.1
Authorization: Bearer <Admin_A_JWT>
Content-Type: application/json

{
  "maxLoginAttempts": 999,
  "sessionTimeoutMinutes": 99999,
  "requireMfa": false
}
```
Sonuc: Target tenant'in guvenlik ayarlari zayiflatildi. MFA devre disi, brute-force
korumasiz, oturum suresi neredeyse sinirsiz. Iz Admin B'de.

**Zincirleme Etki:**
1. Admin A, Admin B'nin kimligiyle kritik degisiklikler yapti
2. Audit trail tamamen Admin B'ye isaret ediyor
3. Sorusturma Admin B'ye yonlendirildiginde, Admin B gercek JWT loglari ile
   kendini aklamaya calisiyor ama "audit log" ile "JWT log" celisiyor
4. Bu celiski, audit trail'in guvenilirligini tamamen sarsiyor
5. Hicbir audit kaydina guvenilemiyor -- tum sistem integrity'si kirilmis

---

## 5. Fix Onerisi: Her Endpoint Icin req.user Gecis Plani

### Faz 0: Altyapi Hazirligi (Oncelik: ACIL, Effort: S)

**Mevcut Durum:** `ImpersonationController` zaten `@Req() req: Request` ile `(req as any).user`
kullaniyor. `TenantController` ise `@CurrentUser()` decorator'u kullaniyor. Iki farkli pattern
mevcut.

**Oneri:** `@CurrentUser()` decorator'unu standart olarak sec (zaten mevcut ve tip-guvenli).

```typescript
// Zaten mevcut: apps/admin-api-service/src/decorators/ altinda
// @CurrentUser() -> req.user objesini dondurur
// AdminUser interface: { id: string; email: string; roles: string[]; role: string; tenantId?: string }
```

### Faz 1: Kritik -- DebugToolsController (Effort: S, Oncelik: P0)

**A1-A3 icin degisiklik:**

Her uc endpoint icin:
1. Controller'a `Req` import'unu ekle
2. `@Query('adminId') adminId: string` parametresini kaldir
3. `@Req() req: Request` ekle
4. `(req as any).user.id` ile adminId'yi JWT'den al

Etkilenen endpoint'ler:
- `POST /debug/sessions` (satir 390-410)
- `POST /debug/feature-overrides` (satir 603-613)
- `POST /debug/feature-overrides/:id/revert` (satir 615-621)

**A4 icin degisiklik:**
- `GET /debug/feature-overrides` (satir 652-669): `@Query('adminId')` burada filtre
  parametresi olarak kullaniliyor, tehlike dusuk. Ama yine de kaldirmak ve filtrelemeyi
  baska bir mekanizma ile yapmak daha temiz.

### Faz 2: Yuksek -- BillingController (Effort: M, Oncelik: P0)

**B1-B11 icin degisiklik:**

1. Controller'a `@Req()` veya `@CurrentUser()` import'unu ekle
2. Her 11 endpoint'te `@Body('*By')` parametresini kaldir
3. `req.user.id` (veya `req.user.email`) ile degistir

Ornek (B5 -- cancelSubscription):
```
Oncesi:  @Body('cancelledBy') cancelledBy: string
Sonrasi: (ek parametre yok, controller icerisinde req.user.id kullan)
```

**Service tarafinda degisiklik gerekli mi?**
Hayir -- service'ler zaten `string` parametre aliyor. Sadece controller'da kaynagi degisiyor.

**Frontend etkisi:**
Frontend'in body'den `cancelledBy`, `updatedBy` vs. gondermesine gerek kalmayacak.
Geriye donuk uyumluluk icin: frontend hala gonderse bile backend YOKSAYMALI, JWT'den almali.

### Faz 3: Yuksek -- SettingsController + TenantConfigurationController (Effort: M, Oncelik: P1)

**C1-C5 (SettingsController):**
- Body icindeki `updatedBy` alanini yoksay
- `@Req() req: Request` ekle, `req.user.id` kullan

**D1-D8 (TenantConfigurationController):**
- `@Query('updatedBy')` parametrelerini kaldir (URL'de identity OLMAMALI)
- `@Req() req: Request` ekle, `req.user.id` kullan
- **OZEL RISK:** Query parametreleri proxy/CDN loglarinda, browser gecmisinde,
  Referer header'inda gorunur. `?updatedBy=admin-uuid` bilgi sizintisidir.

### Faz 4: Orta -- IpAccessController + ComplianceController (Effort: S, Oncelik: P1)

**E1-E2 (IpAccessController):**
- Inline type'i DTO sinifina donustur (zaten bulk array validation eksik)
- `createdBy` alanini kaldir
- `@Req() req: Request` ekle

**F1 (ComplianceController):**
- `GenerateReportDto`'dan `generatedBy` ve `generatedByName` kaldir
- `@Req() req: Request` ekle
- `req.user.id` ve `req.user.email` kullan

### Faz 5: Dusuk -- Hardcoded 'admin' Duzeltmeleri (Effort: S, Oncelik: P2)

**G1 (AuditTrailController):**
```
Oncesi:  createdBy: 'admin', // Would come from auth context
Sonrasi: @Req() req -> createdBy: req.user.id
```

**G2 (SecurityMonitoringController):**
```
Oncesi:  'admin', // Would come from auth context
Sonrasi: @Req() req -> req.user.id
```

**G3 (TicketController):**
```
Oncesi:  createdBy: 'tenant-user-id', // In production, would come from auth context
Sonrasi: @CurrentUser() user -> createdBy: user.id
```
Not: Bu endpoint `@AllowTenantAdmin()` kullandiginden, `@CurrentUser()` zaten mevcut
pattern olarak kullanilabilir (ayni controller'in diger endpoint'lerinde kullaniliyor).

### Faz 6: Ek Onlem -- GlobalSettingsController (Effort: S, Oncelik: P2)

**H5 (GlobalSettingsController satir 404):**
```
Oncesi:  const updatedBy = req.user?.email || req.user?.id || 'admin';
Sonrasi: const updatedBy = req.user.id; // Guard zaten auth zorunlu kiliyor, fallback gereksiz
```
Fallback `|| 'admin'` kalintisindan kurtulunmali. PlatformAdminGuard basarili
gecilmisse `req.user` kesinlikle var demektir.

---

## Ek: Etki Matrisi

| Kategori | Etkilenen Endpoint | Audit Trail Riski | Horizontal Escalation | Effort |
|----------|-------------------|-------------------|----------------------|--------|
| A (Query adminId) | 4 | KRITIK | EVET | S |
| B (Body *By - Billing) | 11 | YUKSEK | EVET | M |
| C (Body updatedBy - Settings) | 5 | ORTA | HAYIR | S |
| D (Query updatedBy - TenantConfig) | 8 | YUKSEK (URL leak) | HAYIR | M |
| E (Body createdBy - IP Access) | 2 | ORTA | EVET | S |
| F (Body generatedBy - Compliance) | 1 | YUKSEK | EVET | S |
| G (Hardcoded 'admin') | 3 | DUSUK (tanimlanamaz) | HAYIR | S |
| **TOPLAM** | **34 aktif** | | | |

---

## Ek: ImpersonationController Duzeltme Referansi

`ImpersonationController` (satir 260-346) SECURITY FIX comment'leri ile duzeltilmis
ve dogru pattern'i gosteriyor:

```typescript
// Satir 304-305
// SECURITY FIX: Get admin identity from verified JWT token, not client-supplied headers
const user = (req as any).user;
if (!user?.id || !user?.email) {
  throw new Error('User not authenticated');
}
```

Bu pattern tum diger controller'lara uygulanmalidir. Guard gecildikten sonra
`req.user` her zaman mevcuttur (`id`, `email`, `roles`, `role` alanlari ile).

---

## Sonuc

37 noktanin 30'unda admin kimligi client'tan aliniyor, 3'unde hardcoded, sadece 4'u
duzeltilmis durumda. Bu, admin-api-service'in audit trail'inin **guvenilmez** oldugu
anlamina gelir. Herhangi bir authenticated SUPER_ADMIN, herhangi bir baska admin'in
kimligiyle islem yapabilir ve iz birakmadan audit trail'i manipule edebilir.

**Oncelik Sirasi:**
1. **P0 (Bu hafta):** Faz 1 (DebugToolsController) + Faz 2 (BillingController) -- 15 endpoint
2. **P1 (Bu sprint):** Faz 3 + Faz 4 -- 15 endpoint
3. **P2 (Sonraki sprint):** Faz 5 + Faz 6 -- 4 endpoint

**Toplam Effort:** ~2-3 gun gelistirme + 1 gun test. Hic bir service degisikligi gerektirmiyor,
sadece controller layer'da parametre kaynagi degisiyor.
