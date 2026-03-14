# Sprint 4 Security Review Feedback - Fix Report

**Tarih:** 2026-03-14
**Scope:** admin-api-service MEDIUM severity guvenlik bulgulari (5 adet)

---

## MEDIUM-001: Settings PUT endpoint'leri DTO validation eksikligi

**Sorun:** `PUT /settings/config/security` ve `PUT /settings/config/rate-limits` endpoint'leri inline TypeScript type kullaniyordu. `class-validator` dekoratorleri olmadigi icin `sessionTimeoutMinutes: -999999` veya `passwordMinLength: 1` gibi gecersiz degerler gonderilebiliyordu.

**Cozum:** Iki yeni DTO class'i olusturuldu:
- `UpdateSecurityConfigDto` -- `@IsInt()`, `@Min()`, `@Max()`, `@IsBoolean()` dekoratorleri ile
- `UpdateRateLimitConfigDto` -- `@IsInt()`, `@Min()`, `@Max()` dekoratorleri ile

**Validation kurallari:**
| Alan | Tip | Min | Max |
|---|---|---|---|
| sessionTimeoutMinutes | int | 5 | 1440 |
| maxLoginAttempts | int | 1 | 20 |
| lockoutDurationMinutes | int | 1 | 1440 |
| passwordMinLength | int | 8 | 128 |
| mfaEnabled | boolean | - | - |
| enforceHttps | boolean | - | - |
| globalRpm | int | 10 | 10000 |
| perUserRpm | int | 5 | 5000 |
| perTenantRpm | int | 10 | 10000 |
| apiKeyRpm | int | 5 | 5000 |

**Dosya:** `apps/admin-api-service/src/settings/settings.controller.ts`

---

## MEDIUM-002: Settings PUT endpoint'lerine @ThrottleSensitive() eklenmesi

**Sorun:** Guvenlik ayarlarini degistirmek hassas operasyondu, rate-limit korunmasi yoktu.

**Cozum:** `@ThrottleSensitive()` dekoratoru asagidaki endpoint'lere eklendi:
- `PUT /settings/config/security`
- `PUT /settings/config/rate-limits`

`ThrottleSensitive` import'u `@aquaculture/backend-common`'dan eklendi (impersonation controller'daki mevcut pattern takip edildi).

**Dosya:** `apps/admin-api-service/src/settings/settings.controller.ts`

---

## MEDIUM-003: POST /settings/key/:key/reset audit trail eksikligi

**Sorun:** `resetToDefault` endpoint'i `req.user.id` kullanmiyordu, kim tarafindan reset yapildiginin izi yoktu.

**Cozum:**
1. Controller'da `@Req() req: Request` parametresi eklendi, `userId` JWT'den alinip `resetToDefault(key, userId)` olarak geciriliyor.
2. Service'in `resetToDefault` metodu `updatedBy?: string` parametresi kabul edecek sekilde guncellendi.
3. `setting.updatedBy = updatedBy` atamasi eklendi, log mesajina kullanici bilgisi dahil edildi.

**Dosyalar:**
- `apps/admin-api-service/src/settings/settings.controller.ts`
- `apps/admin-api-service/src/settings/services/system-setting.service.ts`

---

## MEDIUM-005: Impersonation controller'da throw new Error -> UnauthorizedException

**Sorun:** 5 farkli yerde `throw new Error('User not authenticated')` kullaniliyordu. Bu, NestJS exception filter'larini bypass ederek 500 Internal Server Error donuyordu (401 yerine).

**Cozum:** Tum 5 occurrence `throw new UnauthorizedException('User not authenticated')` ile degistirildi. `UnauthorizedException` import'u `@nestjs/common`'dan eklendi.

Etkilenen metotlar:
- `grantPermission` (POST /permissions)
- `startImpersonation` (POST /sessions/start)
- `endImpersonation` (POST /sessions/:id/end)
- `terminateSession` (POST /sessions/:id/terminate)
- `extendSession` (POST /sessions/:id/extend)

**Dosya:** `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`

---

## Derleme Dogrulamasi

TypeScript derleme testi (`tsc --noEmit`) basariyla tamamlandi -- hata yok.

## Degisiklik Ozeti

| Dosya | Degisiklik |
|---|---|
| `apps/admin-api-service/src/settings/settings.controller.ts` | MEDIUM-001, MEDIUM-002, MEDIUM-003 |
| `apps/admin-api-service/src/settings/services/system-setting.service.ts` | MEDIUM-003 (resetToDefault updatedBy) |
| `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` | MEDIUM-005 |
