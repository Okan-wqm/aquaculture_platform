# Grup H - Kucuk Guvenlik Fix'leri

**Tarih:** 2026-03-14
**Grup:** H (Small Security Fixes)
**Faz:** 3

---

## Ozet

4 guvenlik bulgusunu duzelten minimal degisiklikler:

| Bulgu | Aciklama | Durum |
|-------|----------|-------|
| H23 | Bulk IP array boyut siniri yok | DUZELTILDI |
| H24 | JSON.parse prototype pollution | DUZELTILDI |
| H26 | Session ownership kontrolu yok | DUZELTILDI |
| H14 | 16 controller implicit guard | DUZELTILDI |

---

## H23: Bulk IP DTO -- Array Boyut Siniri ve Validasyon

**Dosya:** `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts`

**Sorun:** `bulkWhitelist` ve `bulkBlacklist` endpoint'leri inline type `{ ips: string[]; tenantId?: string; createdBy?: string }` kullaniyordu. IP array'inde boyut siniri ve format validasyonu yoktu. `createdBy` client-supplied idi.

**Cozum:**
- `BulkIpDto` class'i olusturuldu:
  - `@IsArray()` + `@ArrayMaxSize(500)` -- en fazla 500 IP
  - `@IsIP(undefined, { each: true })` -- her eleman gecerli IP olmali
  - `@IsOptional() @IsString() tenantId` -- opsiyonel tenant filtresi
- `createdBy` parametresi body'den kaldirildi, JWT'den (`req.user.id`) alinmaya baslandi
- Her iki bulk endpoint de `BulkIpDto` ve `@Req()` kullanacak sekilde guncellendi

---

## H24: JSON.parse Prototype Pollution Korunmasi

**Dosya:** `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`

**Sorun:** `getFeatureFlagValue` endpoint'inde `JSON.parse(defaultValue)` dogrudan kullaniliyordu. Saldirgan `{"__proto__":{"polluted":true}}` gibi bir deger gonderebilirdi.

**Cozum:**
- Parse sonucu sanitize ediliyor: sadece primitive degerler kabul edilir (string, number, boolean, null)
- `typeof parsed === 'object' && parsed !== null` ise (object veya array) raw string'e fallback
- Gecersiz JSON durumunda parse hatasi yakalanip raw string kullaniliyor

---

## H26: Session Ownership Kontrolu

**Dosya:** `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`

**Sorun:** `endImpersonation` metodu herhangi bir authenticated admin'in herhangi bir oturumu sonlandirmasina izin veriyordu. Oturum sahibi (superAdminId) kontrolu yoktu.

**Cozum:**
- `endedBy` parametresi verildiginde `session.superAdminId !== endedBy` kontrolu eklendi
- Eslesme yoksa `ForbiddenException('Bu oturumu sonlandirma yetkiniz yok')` firlatiyor
- `endedBy` verilmezse (ic cagirilarda, ornegin `endAllSessionsForAdmin`) kontrol atlanir -- geriye uyumluluk korunur

---

## H14: Explicit Guard -- 16 Controller

**Sorun:** `PlatformAdminGuard` global guard olarak `APP_GUARD` ile kayitli olsa da, 16 controller'da class-level `@UseGuards(PlatformAdminGuard)` dekoratoru eksikti. Bu defense-in-depth prensibini ihlal eder: modul bagimsiz test edilirse veya global guard yanlislikla kaldirilirsa bu controller'lar korumasiz kalir.

**Atlanan controller'lar:**
- `health.controller.ts` -- @Public() dekoratoru var (saglik kontrolu, public olmali)
- `password-reset.controller.ts` -- @Public() dekoratoru var (sifre sifirlama, public olmali)

**Duzeltilen controller'lar (16 adet):**

| # | Dosya | Route |
|---|-------|-------|
| 1 | `settings/controllers/tenant-configuration.controller.ts` | `settings/tenant` |
| 2 | `settings/controllers/email-template.controller.ts` | `settings/email-templates` |
| 3 | `settings/controllers/ip-access.controller.ts` | `settings/ip-access` |
| 4 | `system-management/controllers/job-queue.controller.ts` | `system/jobs` |
| 5 | `system-management/controllers/error-tracking.controller.ts` | `system/errors` |
| 6 | `system-management/controllers/performance.controller.ts` | `system/performance` |
| 7 | `system-management/controllers/global-settings.controller.ts` | `system/settings` |
| 8 | `security/controllers/compliance.controller.ts` | `security/compliance` |
| 9 | `security/controllers/security-monitoring.controller.ts` | `security/monitoring` |
| 10 | `security/controllers/activity-log.controller.ts` | `security/activities` |
| 11 | `security/controllers/audit-trail.controller.ts` | `security/audit` |
| 12 | `support/controllers/onboarding.controller.ts` | `support/onboarding` |
| 13 | `support/controllers/announcement.controller.ts` | `support/announcements` |
| 14 | `support/controllers/messaging.controller.ts` | `support/messages` |
| 15 | `support/controllers/ticket.controller.ts` | `support/tickets` |
| 16 | `tenant/tenant.controller.ts` | `tenants` |

**Not:** `global-settings.controller.ts` class-level guard eklenirken mevcut method-level `@Public()` dekoratoru (`getProvisioningConfig`) korundu. Method-level `@UseGuards(PlatformAdminGuard)` (`updateProvisioningConfig`) redundant olarak kaldi ama defense-in-depth olarak birakildi.

---

## Degisiklik Ozeti

- **4 dosya** guncellendi (H23, H24, H26 + H14 ip-access)
- **15 ek dosya** guncellendi (H14 explicit guard)
- **Toplam:** 19 dosya degisikligi
- **Yeni dosya:** 0
- **Silinen dosya:** 0
