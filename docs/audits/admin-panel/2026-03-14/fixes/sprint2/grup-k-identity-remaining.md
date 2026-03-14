# Sprint 2 - Grup K: Client-Supplied Identity Fix Report

**Tarih:** 2026-03-14
**Bulgu:** C6 Faz 3-5 -- Client-supplied identity (updatedBy, createdBy, verifiedBy, completedBy, generatedBy)
**Pattern:** `@Body()` / `@Query()` ile alınan identity alanlarini JWT `req.user.id` ile degistir

---

## Degisiklik Ozeti

### Toplam: 20 endpoint duzeltildi (4 dosya)

---

### 1. settings.controller.ts (6 fix)

| # | Endpoint | Method | Eski Kaynak | Yeni Kaynak |
|---|----------|--------|-------------|-------------|
| 1 | `PUT /settings/key/:key` | `updateSetting` | `@Body() dto.updatedBy` | `req.user.id` |
| 2 | `PUT /settings/bulk` | `bulkUpdate` | `@Body() body.updatedBy` | `req.user.id` |
| 3 | `PUT /settings/config/email` | `updateEmailConfig` | `@Body() body.updatedBy` | `req.user.id` |
| 4 | `PUT /settings/config/maintenance` | `setMaintenanceMode` | `@Body() body.updatedBy` | `req.user.id` |
| 5 | `PUT /settings/config/billing` | `updateBillingConfig` | `@Body() body.updatedBy` | `req.user.id` |
| 6 | `POST /settings/import` | `importSettings` | `@Body() body.updatedBy` | `req.user.id` |

**Yapilan:**
- `Req`, `UnauthorizedException` import eklendi
- `Request` (express) import eklendi
- Her metoda `@Req() req: Request` eklendi
- `updatedBy` alani body type'lardan cikarildi
- `const userId = (req as any).user?.id` ile JWT'den alinip service'e aktarildi
- `UnauthorizedException` firlatma eklendi

---

### 2. tenant-configuration.controller.ts (8 fix)

| # | Endpoint | Method | Eski Kaynak | Yeni Kaynak |
|---|----------|--------|-------------|-------------|
| 1 | `PUT /settings/tenant/:tenantId/user-limits` | `updateUserLimits` | `@Query('updatedBy')` | `req.user.id` |
| 2 | `PUT /settings/tenant/:tenantId/storage` | `updateStorageConfig` | `@Query('updatedBy')` | `req.user.id` |
| 3 | `PUT /settings/tenant/:tenantId/api` | `updateApiConfig` | `@Query('updatedBy')` | `req.user.id` |
| 4 | `PUT /settings/tenant/:tenantId/branding` | `updateBranding` | `@Query('updatedBy')` | `req.user.id` |
| 5 | `PUT /settings/tenant/:tenantId/security` | `updateSecurityConfig` | `@Query('updatedBy')` | `req.user.id` |
| 6 | `PUT /settings/tenant/:tenantId/notifications` | `updateNotificationConfig` | `@Query('updatedBy')` | `req.user.id` |
| 7 | `PUT /settings/tenant/:tenantId/features` | `updateFeatureFlags` | `@Query('updatedBy')` | `req.user.id` |
| 8 | `PUT /settings/tenant/:tenantId/data-retention` | `updateDataRetentionConfig` | `@Query('updatedBy')` | `req.user.id` |

**Yapilan:**
- `Query` import kaldirildi (artik kullanilmiyor)
- `Req`, `UnauthorizedException` import eklendi
- `Request` (express) import eklendi
- Tum `@Query('updatedBy')` parametreleri `@Req() req: Request` ile degistirildi
- Her endpoint'e auth guard check eklendi

---

### 3. ip-access.controller.ts (1 fix)

| # | Endpoint | Method | Eski Kaynak | Yeni Kaynak |
|---|----------|--------|-------------|-------------|
| 1 | `POST /settings/ip-access` | `createRule` | `@Body() dto.createdBy` (DTO icinde) | `req.user.id` via spread override |

**Yapilan:**
- `@Req() req: Request` eklendi
- `{ ...dto, createdBy: userId }` ile client degerini override
- Not: Bulk whitelist/blacklist endpoint'leri Sprint 1'de zaten duzeltilmisti (H23 fix)

---

### 4. compliance.controller.ts (5 fix)

| # | Endpoint | Method | Eski Kaynak | Yeni Kaynak |
|---|----------|--------|-------------|-------------|
| 1 | `POST /security/compliance/data-requests` | `createDataRequest` | `@Body() dto.requesterId` | `req.user.id` |
| 2 | `PUT /security/compliance/data-requests/:id` | `updateDataRequest` | Hardcoded `'admin'` / `'Admin User'` | `req.user.id` / `req.user.name` |
| 3 | `POST /security/compliance/data-requests/:id/verify` | `verifyIdentity` | `@Body() dto.verifiedBy` | `req.user.id` |
| 4 | `POST /security/compliance/data-requests/:id/complete` | `completeDataRequest` | `@Body() dto.completedBy` | `req.user.id` |
| 5 | `POST /security/compliance/reports` | `generateReport` | `@Body() dto.generatedBy/generatedByName` | `req.user.id` / `req.user.name` |

**Yapilan:**
- `Req`, `UnauthorizedException` import eklendi
- `Request` (express) import eklendi
- DTO'lardan identity alanlari cikarildi:
  - `CreateDataRequestDto.requesterId` cikarildi
  - `VerifyIdentityDto.verifiedBy` cikarildi
  - `CompleteDataRequestDto.completedBy` cikarildi
  - `GenerateReportDto.generatedBy` ve `generatedByName` cikarildi
- `updateDataRequest`: hardcoded `'admin'`/`'Admin User'` -> `req.user.id`/`req.user.name`
- `generateReport`: `userName` fallback zincirii: `req.user.name || req.user.email || userId`

---

## Service Degisiklikleri

**SIFIR** - Hicbir service dosyasinda degisiklik yapilmadi. Tum fix'ler controller seviyesinde, service imzalari aynen korundu.

---

## Guvenlik Notu

Tum duzeltilen endpoint'lerde:
1. `@Req() req: Request` ile HTTP request nesnesine erisiyor
2. `(req as any).user?.id` ile JWT payload'dan kullanici ID'sini aliyor
3. `UnauthorizedException` ile kimlik dogrulanmamis istekleri reddediyor
4. Client-supplied identity degerleri ya DTO'dan cikarildi ya da spread ile override edildi
5. Service imzalari degistirilmedi, geriye uyumluluk korundu
