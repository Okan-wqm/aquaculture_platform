# Grup V - Backend Endpoint Fixes

**Tarih:** 2026-03-14
**Sprint:** 4
**Grup:** V - Backend Endpoint Uzmani

## Cozulen Bulgular

### H20/40: SystemSettingsPage security/rate-limits PUT endpointleri

**Problem:** Frontend `PUT /settings/config/security` ve `PUT /settings/config/rate-limits` endpointlerini cagiriyor ancak backend'de sadece GET endpointleri mevcut.

**Cozum:**

1. **Service katmani** (`system-setting.service.ts`):
   - `updateSecurityConfig()` metodu eklendi: `sessionTimeoutMinutes`, `maxLoginAttempts`, `lockoutDurationMinutes`, `passwordMinLength`, `mfaEnabled`, `enforceHttps` alanlarini gunceller
   - `updateRateLimitConfig()` metodu eklendi: `globalRpm`, `perUserRpm`, `perTenantRpm`, `apiKeyRpm` alanlarini gunceller
   - Her iki metod da mevcut `upsertSetting()` pattern'ini kullanarak setting key'lerini gunceller

2. **Controller katmani** (`settings.controller.ts`):
   - `PUT /settings/config/security` endpoint'i eklendi
   - `PUT /settings/config/rate-limits` endpoint'i eklendi
   - JWT'den kullanici kimlik dogrulamasi (`req.user.id`)
   - `@UseGuards(PlatformAdminGuard)` class seviyesinde zaten mevcut
   - Guncelleme sonrasi guncel config donuluyor (mevcut `updateEmailConfig` ve `updateBillingConfig` pattern'ine uygun)

**Degisiklik yapilan dosyalar:**
- `apps/admin-api-service/src/settings/settings.controller.ts`
- `apps/admin-api-service/src/settings/services/system-setting.service.ts`

---

### H21/41: ImpersonationPage extend session endpoint

**Problem:** Frontend `POST /impersonation/sessions/:id/extend` endpoint'ini cagiriyor (`{ additionalMinutes }` body ile) ancak backend'de bu endpoint mevcut degil.

**Cozum:**

1. **DTO** (`impersonation.controller.ts` icinde):
   - `ExtendSessionDto` class'i eklendi
   - `additionalMinutes: number` -- `@IsInt()`, `@Min(5)`, `@Max(120)` validation

2. **Service katmani** (`impersonation.service.ts`):
   - `extendSession(sessionId, additionalMinutes, extendedBy)` metodu eklendi
   - Session var mi ve ACTIVE mi kontrolu
   - **Session ownership kontrolu:** Sadece oturumu baslatan admin uzatabilir (`superAdminId === extendedBy`)
   - **Maksimum sure kontrolu:** Permission'daki `maxSessionDurationMinutes` ile toplam sure kontrolu
   - Uzatma islemi audit log olarak `actionsPerformed` dizisine kaydedilir
   - In-memory cache (`activeSessions`) guncellenir

3. **Controller katmani** (`impersonation.controller.ts`):
   - `POST /impersonation/sessions/:id/extend` endpoint'i eklendi
   - `@ThrottleSensitive()` decorator'u eklendi (hassas islem - 3 req / 5 min)
   - JWT'den kullanici kimlik dogrulamasi (`req.user.id`)
   - `@UseGuards(PlatformAdminGuard)` class seviyesinde zaten mevcut

**Degisiklik yapilan dosyalar:**
- `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`

---

## Guvenlik Kontrolleri

| Kontrol | H20 Security | H20 Rate-Limits | H21 Extend |
|---------|:---:|:---:|:---:|
| PlatformAdminGuard | + (class) | + (class) | + (class) |
| JWT identity (req.user.id) | + | + | + |
| Session ownership | N/A | N/A | + |
| DTO validation | inline type | inline type | class-validator |
| @ThrottleSensitive | - | - | + |
| Audit logging | via upsertSetting | via upsertSetting | actionsPerformed |

## Derleme Durumu

- TypeScript derleme hatasi: YOK (degisiklik yapilan dosyalarda)
- Mevcut pattern'lere tam uyum saglanmistir
