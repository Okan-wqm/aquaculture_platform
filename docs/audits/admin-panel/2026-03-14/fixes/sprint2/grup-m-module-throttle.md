# Grup M - Module Ayristirma & Per-Route Throttle

**Tarih:** 2026-03-14
**Grup:** M (Backend Mimari Uzmani)
**Sprint:** 2

---

## H15: DebugToolsModule ImpersonationModule Icerisinden Ayristirma

### Sorun
DebugToolsModule (controller, entity'ler, servisler) ImpersonationModule icerisinde bulunuyordu. Bu Single Responsibility Principle'a (SRP) aykiri olup, iki farkli sorumlulugu tek module kariyordu. Ayrica debug araclari production'da devre disi birakilirken, ImpersonationModule icindeki conditional logic ile yapilamasi modulu karisik ve bakimi zor hale getiriyordu.

### Yapilan Degisiklikler

#### 1. Yeni DebugToolsModule olusturuldu
**Dosya:** `apps/admin-api-service/src/debug-tools/debug-tools.module.ts`

- `DebugToolsController` (debug endpoint'leri)
- Entity'ler: `DebugSession`, `CapturedQuery`, `CapturedApiCall`, `CacheEntrySnapshot`, `FeatureFlagOverride`
- Servisler: `DebugToolsService` (facade), `DebugSessionService`, `QueryInspectorService`, `ApiCallInspectorService`, `CacheInspectorService`, `FeatureFlagDebugService`
- Tum debug-related bilesenleri kendi modulune tasindi

#### 2. ImpersonationModule temizlendi
**Dosya:** `apps/admin-api-service/src/impersonation/impersonation.module.ts`

- Debug-related entity, controller ve servis import'lari kaldirildi
- Sadece impersonation sorumluluklari kaldi:
  - `ImpersonationController`
  - `ImpersonationSession`, `ImpersonationPermission` entity'leri
  - `ImpersonationService`
- Eski production mode controller filtering mantigi kaldirildi (artik moduldeki)

#### 3. AppModule'a conditional import eklendi
**Dosya:** `apps/admin-api-service/src/app.module.ts`

- `NODE_ENV === 'production'` kontrolu ile `DebugToolsModule` sadece non-production ortamlarda yuklenir
- Production'da log mesaji ile bildirilir
- Spread operatoru ile `conditionalModules` dizisi imports'a eklenir

### Mimari Kazanim
- **SRP:** Her modul tek bir sorumlulugu tasir
- **Guvenlik:** Debug araclari production'da modul seviyesinde devre disi
- **Bakim:** Debug araclari bagimsiz olarak gelistirilebilir/test edilebilir

---

## H8: ThrottlerGuard Kaldirilmis -- Per-Route Throttle Eklenmesi

### Sorun
Global `ThrottlerGuard` kaldirilmisti cunku admin panelinde ~15 concurrent dashboard istegi 429 baskisina yol aciyordu. Ancak hassas endpoint'ler (impersonation, billing, database explorer) tamamen rate limiting'siz kalmisti. Bu endpoint'lere brute-force veya yetkisiz toplu islem saldirisi yapilabilirdi.

### Yapilan Degisiklikler

Tum throttle dekoratorleri `@aquaculture/backend-common` paketindeki hazir yardimci fonksiyonlar kullanilarak eklendi:
- `@ThrottleSensitive()` -> 3 istek / 5 dakika (hassas islemler)
- `@ThrottleExport()` -> 5 istek / saat (veri disa aktarma)

#### 1. Impersonation Controller
**Dosya:** `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`

| Endpoint | Dekorator | Limit |
|----------|-----------|-------|
| `POST /impersonation/sessions/start` | `@ThrottleSensitive()` | 3 req / 5 min |
| `POST /impersonation/sessions/:id/end` | `@ThrottleSensitive()` | 3 req / 5 min |
| `POST /impersonation/sessions/:id/terminate` | `@ThrottleSensitive()` | 3 req / 5 min |

#### 2. Billing Controller
**Dosya:** `apps/admin-api-service/src/billing/billing.controller.ts`

| Endpoint | Dekorator | Limit |
|----------|-----------|-------|
| `POST /billing/subscriptions/tenant/:tenantId/cancel` | `@ThrottleSensitive()` | 3 req / 5 min |
| `POST /billing/invoices/:invoiceId/mark-paid` | `@ThrottleSensitive()` | 3 req / 5 min |
| `POST /billing/invoices/:invoiceId/void` | `@ThrottleSensitive()` | 3 req / 5 min |

#### 3. Database Explorer Controller
**Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`

| Endpoint | Dekorator | Limit |
|----------|-----------|-------|
| `POST /database/explorer/query` (raw SQL) | `@ThrottleSensitive()` | 3 req / 5 min |
| `POST /database/explorer/schemas/:schema/tables/:table/rows` (INSERT) | `@ThrottleSensitive()` | 3 req / 5 min |
| `PUT /database/explorer/schemas/:schema/tables/:table/rows/:id` (UPDATE) | `@ThrottleSensitive()` | 3 req / 5 min |
| `DELETE /database/explorer/schemas/:schema/tables/:table/rows/:id` (DELETE) | `@ThrottleSensitive()` | 3 req / 5 min |
| `GET /database/explorer/schemas/:schema/tables/:table/export` (EXPORT) | `@ThrottleExport()` | 5 req / hour |

### Mimari Kazanim
- **Guvenlik:** Hassas endpoint'ler brute-force saldirilarindan korunur
- **Denge:** Global guard eklenmedi (admin panelindeki 429 flood sorunu tekrarlanmaz)
- **Esneklik:** Her endpoint kendi rate limit yapilandirmasina sahip
- **Tutarlilik:** `backend-common` paketindeki standart dekoratorler kullanildi (ThrottleDefaults.SENSITIVE = 3 req / 300s)

---

## Degisiklik Ozeti

| Dosya | Degisiklik | Bulgu |
|-------|-----------|-------|
| `src/debug-tools/debug-tools.module.ts` | YENI - DebugTools bagimsiz modul | H15 |
| `src/impersonation/impersonation.module.ts` | Debug bilesenleri cikarildi | H15 |
| `src/app.module.ts` | Conditional DebugToolsModule import | H15 |
| `src/impersonation/controllers/impersonation.controller.ts` | @ThrottleSensitive() eklendi (3 endpoint) | H8 |
| `src/billing/billing.controller.ts` | @ThrottleSensitive() eklendi (3 endpoint) | H8 |
| `src/database-management/controllers/explorer.controller.ts` | @ThrottleSensitive() + @ThrottleExport() eklendi (5 endpoint) | H8 |

## Onkosuller
- `ThrottlerModule` app.module.ts'de zaten import edilmis (satir 90)
- `@aquaculture/backend-common` paketi `Throttle`, `ThrottleSensitive`, `ThrottleExport` dekoratorlerini export ediyor
- `ThrottlerGuard` global guard olarak eklenmedi (tasarim karari korundu)
