# Grup G - Frontend-Backend Path Uyumsuzluk Düzeltmeleri

**Tarih:** 2026-03-14
**Hedef dosya:** `web/modules/admin-panel/src/services/adminApi.ts`
**Kural:** Backend'e dokunulmadı, sadece frontend path'leri backend'e uyarlandı.

---

## H18: Announcement Unpublish Path Uyumsuzluğu

| | Eski (Frontend) | Backend (Doğru) |
|---|---|---|
| Path | `POST /support/announcements/:id/unpublish` | `POST /support/announcements/:id/cancel` |

**Sorun:** Frontend `unpublish` endpoint'ine istek atıyordu, backend'de bu endpoint yok. Backend'deki gerçek endpoint `cancel`.

**Düzeltme (satır 893-895):**
```typescript
// Fix: H18 -- backend path uyumu (unpublish -> cancel)
unpublishAnnouncement: (id: string) =>
  apiFetch<Announcement>(`/support/announcements/${id}/cancel`, { method: 'POST' }),
```

**Referans:** `apps/admin-api-service/src/support/controllers/announcement.controller.ts` satir 155-158 (`@Post(':id/cancel')`)

---

## H19: Settings Get/Update Path Kayması

| | Eski (Frontend) | Backend (Doğru) |
|---|---|---|
| GET | `/settings/${key}` | `/settings/key/:key` |
| PUT | `/settings/${key}` | `/settings/key/:key` |

**Sorun:** Frontend'de `key/` prefix'i eksikti. Frontend `/settings/smtp_host` diye istek atıyordu, backend `/settings/key/smtp_host` bekliyor. Bu, backend'in `key/:key` route'una ulaşamadan diğer route'larla (`:id` gibi) çakışmaya veya 404'e yol açıyordu.

**Düzeltme (satır 1805-1808):**
```typescript
// Fix: H19 -- backend path uyumu (/settings/${key} -> /settings/key/${key})
get: (key: string) => apiFetch<SystemSetting>(`/settings/key/${key}`),
update: (key: string, value: unknown, updatedBy?: string) =>
  apiFetch<SystemSetting>(`/settings/key/${key}`, { method: 'PUT', body: JSON.stringify({ value, updatedBy }) }),
```

**Referans:** `apps/admin-api-service/src/settings/settings.controller.ts` satir 53 (`@Get('key/:key')`) ve satir 62 (`@Put('key/:key')`)

---

## H21: Impersonation Session Revoke/Terminate Path Farkı

| | Eski (Frontend) | Backend (Doğru) |
|---|---|---|
| Path | `POST /impersonation/sessions/:id/revoke` | `POST /impersonation/sessions/:id/terminate` |

**Sorun:** Frontend `revokeSession` fonksiyonu `/revoke` endpoint'ine istek atıyordu, backend'de bu endpoint yok. Backend'deki gerçek endpoint `terminate`.

**Düzeltme (satir 1519-1521):**
```typescript
// Fix: H21 -- backend path uyumu (revoke -> terminate)
revokeSession: (id: string, revokedBy: string, reason?: string) =>
  apiFetch<ImpersonationSession>(`/impersonation/sessions/${id}/terminate`, { method: 'POST', body: JSON.stringify({ revokedBy, reason }) }),
```

**Referans:** `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` satir 334 (`@Post('sessions/:id/terminate')`)

---

## Ozet

| Bulgu | Durum | Degisiklik |
|-------|-------|------------|
| H18 - Announcement unpublish | DUZELTILDI | `unpublish` -> `cancel` |
| H19 - Settings path kaymasi | DUZELTILDI | `/settings/${key}` -> `/settings/key/${key}` (2 yer) |
| H21 - Impersonation revoke | DUZELTILDI | `revoke` -> `terminate` |

**Toplam degisiklik:** 3 bulgu, 4 satir degisikligi (H19 iki endpoint iceriyordu), tek dosya.
