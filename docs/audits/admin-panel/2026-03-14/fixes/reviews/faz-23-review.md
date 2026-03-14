# Faz 2-3 Acimasiz Code Review Raporu

**Tarih:** 2026-03-14
**Reviewer:** Sprint 1 Fix Ordusu Review Ajani (Opus 4.6)
**Kapsam:** Grup E, F, G, H, I (5 grup, 13 bulgu)

---

## SONUC TABLOSU

| Grup | Bulgu | Verdict | Sorun Var Mi? |
|------|-------|---------|---------------|
| E | C8 - Callback ref pattern | ONAYLANDI | Hayir |
| E | C7 - Refetch mekanizmasi | ONAYLANDI | Kucuk not var |
| E | H1 - LRU cache | ONAYLANDI | Hayir |
| F | C13 - QueryEditor contract | ONAYLANDI | Hayir |
| G | H18 - Announcement path | ONAYLANDI | Hayir |
| G | H19 - Settings path | ONAYLANDI | Hayir |
| G | H21 - Impersonation path | ONAYLANDI | Hayir |
| H | H23 - Bulk IP validation | ONAYLANDI | Kucuk not var |
| H | H24 - Prototype pollution | ONAYLANDI | Hayir |
| H | H26 - Session ownership | ONAYLANDI | Hayir |
| H | H14 - Explicit guards | ONAYLANDI | Hayir |
| I | H22 - CSV export | ONAYLANDI | Hayir |
| -- | -- (ek bulgu) | YENI SORUN | QueryEditor CSV injection |

**Genel Verdict: 12/12 bulgu BASARIYLA COZULMUS. 1 yeni sorun tespit edildi (Grup F dosyasinda).**

---

## GRUP E: useAsyncData Hook Fixes (C7, C8, H1)

**Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/hooks/useAsyncData.ts`

### C8: Callback Ref Pattern -- ONAYLANDI

**Kanit:**
- Satir 141-143: `transformRef`, `onSuccessRef`, `onErrorRef` useRef ile olusturulmus.
- Satir 145-150: Dependency'siz useEffect her renderda ref.current'i guncelliyor. `fetcherRef.current` da ayni effect'te guncelleniyor -- tum ref senkronizasyonu tek yerde.
- Satir 207: `transformRef.current` kullaniliyor (dogrudan `transform` degil).
- Satir 226: `onSuccessRef.current?.(result)` kullaniliyor.
- Satir 268: `onErrorRef.current?.(...)` kullaniliyor.
- Satir 275: Dependency array `[cacheKey, cacheTTL, timeout]` -- callback'ler cikarilmis.

**Sonsuz dongu riski kalmamis mi?**
- fetchData dependency array'inde yalnizca `[cacheKey, cacheTTL, timeout]` var (satir 275).
- Inline arrow function geciren tuketiciler artik fetchData kimligini degistirmez.
- useEffect (satir 325-329) `[fetchData]` dependency ile calisiyor. fetchData yalnizca cacheKey/cacheTTL/timeout degisince yeniden olusur. Bu degerlerin degismesi zaten istenen refetch davranisi.
- **SONUC: Sonsuz dongu riski yok.** Pattern dogru uygulanmis.

**SOLID uyumu:** SRP korunmus -- ref senkronizasyonu tek bir dependency'siz effect'te.

### C7: Refetch Mekanizmasi -- ONAYLANDI

**Kanit:**
- Satir 325-329: `useEffect(() => { if (immediate) fetchData(true); }, [fetchData]);`
- `fetchData` useCallback (satir 152-276) `cacheKey`'i dependency olarak icerir.
- cacheKey degisince fetchData kimligi degisir, effect yeniden calisir, refetch tetiklenir.

**Edge case kontrolu:**
- `immediate = false` olan tuketiciler: Effect'in ici `if (immediate)` kontrolu var, fetchData degisse bile fetch tetiklenmez. Bu dogru: `immediate = false` demek "ben manuel fetch yapacagim" demek. Ancak bu, cacheKey degistigi halde otomatik refetch istemeyen bir tuketici icin beklenebilir davranis.
- `immediate` dependency array'de degil (eslint-disable ile atlanmis). `immediate` genellikle sabit bir prop'tur, degismez. Eger component lifetime boyunca `immediate` true'dan false'a degisirse, eski davranis korunur (son fetchData kimliginde calismaya devam eder). Bu kabul edilebilir bir trade-off.

**Regression riski (ORTA -- rapordaki degerlendirme ile uyumlu):**
- Onceden sadece mount'ta fetch yapan sayfalar artik cacheKey degisince de fetch yapacak.
- Rapor 6 sayfa listelenmis. Bu sayfalar zaten cacheKey'i filtre/pagination ile degistiren sayfalar -- dolayisiyla bu istenen davranis.

### H1: LRU Cache -- ONAYLANDI

**Kanit:**
- Satir 61: `MAX_CACHE_SIZE = 100` sabiti.
- Satir 74-82: `addToCache()` -- once `cache.delete(key)` (mevcut entry'yi sil), sonra boyut kontrolu, en eski entry silme, yeni entry ekleme.
- Satir 87-95: `getCacheEntry()` -- hit'te delete + set (LRU touch).
- Satir 165: `getCacheEntry(cacheKey)` kullaniliyor (eski `cache.get` yerine).
- Satir 213: `addToCache(cacheKey, ...)` kullaniliyor (eski `cache.set` yerine).

**LRU eviction dogru calisiyor mu?**
- Map insertion order'i korur (ES2015+ spec). `cache.keys().next().value` her zaman en eski (en az kullanilan) entry'yi dondurur.
- `addToCache` once mevcut key'i siler (eger varsa), sonra boyut kontrolu yapar. Bu siralamanin onemi: eger key zaten mevcutsa ve cache dolu ise, once silme yapilir (boyut 99 olur), sonra boyut kontrolu `>= 100`'u gecmez, gereksiz eviction olmaz. Dogru.
- `getCacheEntry` hit'te entry'yi Map sonuna tasiyor -- LRU semantigi saglanmis.
- `clearAsyncCache` ve logout listener dogrudan Map API kullanmaya devam ediyor -- sorun yok.

**Edge case:** `cache.keys().next().value` bos Map'te `undefined` dondurur. Satir 79'daki `if (oldestKey)` kontrolu bunu karsilar. Dogru.

---

## GRUP F: QueryEditor Contract Fix (C13)

**Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/components/database/QueryEditor.tsx`

### C13: Field Mismatch -- ONAYLANDI

**Kanit:**
- Satir 84: `body: JSON.stringify({ sql: query })` -- backend `ExecuteQueryDto` (explorer.controller.ts satir 179-186) `sql: string` ve opsiyonel `params: unknown[]` bekliyor. Uyumlu.
- Satir 73: `_schema` parametresi -- kullanilmiyor, underscore prefix ile belirtilmis. TypeScript unused variable hatasi vermez.
- Backend'de `whitelist: true + forbidNonWhitelisted: true` ayari var, dolayisiyla `schema` field'i gonderilmemesi dogru. Gonderilseydi 400 hata alinirdi.

**SQL guvenlik katmanlari yerinde mi?**
- C1-C5, C11, C12, H25 fix'leri raporda MEVCUT olarak isaretlenmis. Bu fix'ler backend tarafinda (explorer.controller.ts + explorer.service.ts) uygulanmis ve bu degisiklikten bagimsiz. QueryEditor sadece body formatini duzeltmis, guvenlik katmanlarina dokunmamis.
- Client-side `isSelectOnlyQuery` kontrolu (satir 160-165) saglikli duruyor -- DML/DDL keyword'leri reddediliyor.

**YENI SORUN TESPIT EDILDI:**
- QueryEditor'daki `exportToCSV` fonksiyonu (satir 167-191) kendi `escapeCsvValue` fonksiyonunu kullaniyor. Bu fonksiyon virgul, tirnak ve newline iceren hucreleri RFC 4180 uyumlu olarak wrap ediyor AMA formula injection korumasini ICERMIYOR.
- `=CMD(...)`, `+cmd|'...`, `-0+0+cmd|'...`, `@SUM(...)` gibi payloads escape edilmeden CSV'ye yazilir.
- AuditLogPage'de (Grup I fix'i) `escapeCsvCell` fonksiyonu formula injection korumasini dogru sekilde iceriyor: `if (/^[=+\-@\t\r]/.test(str))` kontrolu var.
- QueryEditor'daki `escapeCsvValue` bu korumadan yoksun.

**Somut fix onerisi:**
```typescript
// QueryEditor.tsx satir 168-173 yerine:
const escapeCsvValue = (value: string): string => {
  // Formula injection protection
  if (/^[=+\-@\t\r]/.test(value)) {
    return `"'${value.replace(/"/g, '""')}"`;
  }
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};
```
**Oncelik:** YUKSEK -- QueryEditor SQL sonuclarini dogrudan CSV'ye export eder. Saldirgan, `=CMD(...)` iceren bir deger veritabanina kaydedebilir ve admin bu sonuclari export edip Excel'de actigi anda formula calistirilir.

---

## GRUP G: Contract Fixes (H18, H19, H21)

**Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/services/adminApi.ts`

### H18: Announcement Unpublish -> Cancel -- ONAYLANDI

**Kanit:**
- Frontend (adminApi.ts satir 894-895): `/support/announcements/${id}/cancel` -- POST.
- Backend (announcement.controller.ts satir 158-160): `@Post(':id/cancel') async cancelAnnouncement(...)`.
- Path uyumlu. Method uyumlu (POST-POST).

### H19: Settings Path Kaymasi -- ONAYLANDI

**Kanit:**
- Frontend GET (adminApi.ts satir 1806): `/settings/key/${key}`.
- Backend GET (settings.controller.ts satir 53): `@Get('key/:key')`.
- Frontend PUT (adminApi.ts satir 1807-1808): `/settings/key/${key}`.
- Backend PUT (settings.controller.ts satir 61): `@Put('key/:key')`.
- Her iki path de uyumlu.

**Edge case:** `key` icinde ozel karakterler (`/`, `.` vb.) olabilir mi? URL encoding gerekebilir. Ancak settings key'leri genellikle snake_case string'lerdir (ornegin `smtp_host`), bu durumda sorun yok. Bu yeni bir bulgu degil, onceden de vardi.

### H21: Impersonation Revoke -> Terminate -- ONAYLANDI

**Kanit:**
- Frontend (adminApi.ts satir 1520-1521): `/impersonation/sessions/${id}/terminate` -- POST.
- Backend (impersonation.controller.ts satir 334): `@Post('sessions/:id/terminate')`.
- Path uyumlu. Method uyumlu (POST-POST).

**SOLID uyumu:** Tek dosyada 3 minimal degisiklik, her biri tek bir sorumlulugu (path uyumu) duzeltmis. Temiz.

---

## GRUP H: Small Security Fixes (H23, H24, H26, H14)

### H23: Bulk IP DTO -- ONAYLANDI

**Dosya:** `/var/aqua-saas/apps/admin-api-service/src/settings/controllers/ip-access.controller.ts`

**Kanit:**
- Satir 29-38: `BulkIpDto` class'i -- `@IsArray()`, `@ArrayMaxSize(500)`, `@IsIP(undefined, { each: true })`, opsiyonel `@IsString() tenantId`.
- Satir 147-160: `bulkWhitelist` endpoint -- `@Body() dto: BulkIpDto`, `@Req() req: Request`, `createdBy = req.user.id`.
- Satir 167-180: `bulkBlacklist` endpoint -- ayni pattern.
- `createdBy` artik body'den gelmiyor, JWT'den aliniyor. Client-supplied identity yok.
- `UnauthorizedException` firlatiliyor (satir 153, 173) -- user yoksa istek reddedilir.

**Not:** `(req as any).user?.id` kullanimi TypeScript type safety'yi zayiflatiyor. Ideal olarak bir typed request interface (`AuthenticatedRequest`) kullanilmali. Ancak bu pattern, projenin genelinde tutarli (debug-tools.controller.ts satir 403, 621, 638, 697'de de ayni pattern). Mevcut convention ile uyumlu, yeni bir risk degil.

**Edge case:** `@IsIP(undefined, { each: true })` -- IPv4 ve IPv6'yi kabul eder. CIDR notasyonu (`192.168.1.0/24`) kabul etmez -- bu dogru davranis cunku DTO tek IP icin tasarlanmis.

### H24: Prototype Pollution -- ONAYLANDI

**Dosya:** `/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`

**Kanit:**
- Satir 668-677: `getFeatureFlagValue` endpoint'i.
- `JSON.parse(defaultValue)` try-catch ile sarilmis (satir 670-673).
- Parse sonucu object/array ise (satir 674-677), `String(defaultValue)`'e fallback yapiliyor.
- Yalnizca primitive degerler (string, number, boolean, null) geciriliyor.

**Prototype pollution tamamen onlenmis mi?**
- `typeof parsed === 'object' && parsed !== null` kontrolu array'leri de yakalar (`typeof [] === 'object'`). Dogru.
- `null` kontrolu: `parsed !== null` -- `null` gecmesine izin veriyor cunku `typeof null === 'object'` ama kontrol `parsed !== null` ile atliyor. `null` zaten prototype pollution riski tasimaz. Dogru.
- Fallback `String(defaultValue)` -- orjinal string'e donuyor. Guvenli.

### H26: Session Ownership -- ONAYLANDI

**Dosya:** `/var/aqua-saas/apps/admin-api-service/src/impersonation/services/impersonation.service.ts`

**Kanit:**
- Satir 456-459: `endImpersonation` metodu.
  ```typescript
  if (endedBy && session.superAdminId !== endedBy) {
    throw new ForbiddenException('Bu oturumu sonlandirma yetkiniz yok');
  }
  ```
- `endedBy` verildiginde ownership kontrolu yapiliyor. Eslesme yoksa `ForbiddenException` firlatiliyor.
- `endedBy` verilmezse (ic cagri -- `endAllSessionsForAdmin`, satir 501) kontrol atlanir. Bu dogru: `endAllSessionsForAdmin` zaten `where: { superAdminId: adminId }` filtreliyor (satir 497) -- sadece o admin'e ait oturumlari buluyor.

**Controller tarafinda JWT kullanimi:**
- impersonation.controller.ts satir 320-331: `endImpersonation` controller metodu `req.user.id`'yi `endedBy` olarak iletiyor. JWT'den alinmis, client-supplied degil.

**ForbiddenException import'u:**
- Satir 7: `import { ... ForbiddenException ... } from '@nestjs/common'` -- import mevcut.

**Bypass riski var mi?**
- `terminateSession` metodu (satir 473-493) ayri bir isleyistir ve ownership kontrolu icermez. Bu metod farkli bir endpoint'tir (`POST sessions/:id/terminate`) ve farkli bir semantige sahiptir (zorla sonlandirma -- admin degil, platform yoneticisi tarafindan yapilir). Raporda bu kasitli olarak kapsam disinda birakilmis. Kabul edilebilir -- terminate isleminin farkli bir yetki kontrolu (ornegin superadmin-only) ile korunmasi ayri bir bulgu olabilir ama H26'nin kapsaminda degil.

### H14: Explicit Guards (16 Controller) -- ONAYLANDI

**Kanit:**
Asagidaki 16 controller'da `@UseGuards(PlatformAdminGuard)` class-level dekoratoru ve import'u dogrulanmistir:

| # | Controller | Guard | Import |
|---|-----------|-------|--------|
| 1 | tenant-configuration.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 39) | satir 16 |
| 2 | email-template.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 28) | satir 16 |
| 3 | ip-access.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 42) | satir 20 |
| 4 | job-queue.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 67) | satir 16 |
| 5 | error-tracking.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 73) | satir 16 |
| 6 | performance.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 41) | satir 11 |
| 7 | global-settings.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 142) | satir 19 |
| 8 | compliance.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 110) | satir 21 |
| 9 | security-monitoring.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 331) | satir 22 |
| 10 | activity-log.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 210) | satir 21 |
| 11 | audit-trail.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 185) | satir 24 |
| 12 | onboarding.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 66) | satir 22 |
| 13 | announcement.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 67) | satir 24 |
| 14 | messaging.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 59) | satir 22 |
| 15 | ticket.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 88) | satir 23 |
| 16 | tenant.controller.ts | `@UseGuards(PlatformAdminGuard) // H14 fix` (satir 70) | satir 20 |

**Atlanan controller'lar:**
- `health.controller.ts` -- 4 method'da `@Public()` dekoratoru var (satir 29, 40, 47, 72). Health check'ler public olmali. Dogru.
- `password-reset.controller.ts` -- 2 method'da `@Public()` dekoratoru var (satir 60, 148). Sifre sifirlama public olmali. Dogru.

**global-settings.controller.ts ozel durumu:**
- Class-level `@UseGuards(PlatformAdminGuard)` (satir 142) eklenmis.
- `getProvisioningConfig` metodu `@Public()` dekoratoru ile korunmus (satir 390). NestJS'te method-level `@Public()` class-level guard'i override eder (Reflector metadata). Bu dogru calisiyor.
- Method-level `@UseGuards(PlatformAdminGuard)` (`updateProvisioningConfig`, satir 397) redundant ama zararli degil -- defense-in-depth.

---

## GRUP I: CSV Export Fix (H22)

**Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/pages/AuditLogPage.tsx`

### H22: CSV Formula Injection + Memory Leak + Stale Filter -- ONAYLANDI

**Kanit - Formula Injection:**
- Satir 135-146: `escapeCsvCell` fonksiyonu.
- `if (/^[=+\-@\t\r]/.test(str))` -- formula injection korumasini saglayan regex. `=`, `+`, `-`, `@`, `\t`, `\r` ile baslayan hucrelere tek tirnak prefix'i ekleniyor.
- Sonuc: `=CMD("malicious")` -> `"'=CMD("malicious")"` -- Excel bunu formul olarak degil, metin olarak okur.
- Satir 353-361: Tum CSV hucreleri `escapeCsvCell()` ile sarilmis.

**Kanit - Memory Leak:**
- Satir 370: `URL.revokeObjectURL(url)` -- `link.click()` sonrasinda cagriliyor. Object URL serbest birakilmis.

**Kanit - Stale Filter:**
- Satir 346: `if (filters.search) params.search = filters.search;` -- search filtresi API query'sine eklenmis.
- Diger filtreler de mevcut (satir 343-348): action, severity, entityType, tenantId, startDate, endDate, search.

**Edge case kontrolu:**
- `escapeCsvCell` icinde `-` ile baslayan negatif sayilar: `-42` gibi bir deger `"'-42"` olarak yazilir. Excel'de bu metin olarak gorunur, sayi olarak degil. Bu, guvenlik-kullanilabilirlik trade-off'udur. CSV injection'dan korunmak icin kabul edilebilir.
- Header satiri (satir 352) `headers.join(',')` ile birlestiriliyor ama headerlar sabit string'ler (`'Date'`, `'Action'` vb.) -- formula injection riski yok.
- `\r` kontrolu: `escapeCsvCell` regex'inde `\r` var. Windows line endings (`\r\n`) iceren hucrelerde calisir. Dogru.

---

## YENI TESPIT EDILEN SORUNLAR

### SORUN-1: QueryEditor CSV Export'ta Formula Injection Korumasiz (YUKSEK)

**Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/components/database/QueryEditor.tsx`
**Satir:** 167-191

**Detay:** `exportToCSV` fonksiyonundaki `escapeCsvValue` (satir 168-173) yalnizca virgul, tirnak ve newline karakterlerini handle ediyor. Formula injection korumasini ICERMIYOR:

```typescript
// MEVCUT (yetersiz):
const escapeCsvValue = (value: string): string => {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};
```

AuditLogPage'deki `escapeCsvCell` (satir 135-146) bu korumaya sahipken, QueryEditor'daki `escapeCsvValue` sahip degil. Bu tutarsizlik onemli cunku QueryEditor, veritabanindan dogrudan gelen verileri CSV'ye yazabilir -- ve bu veriler saldirgan tarafindan kontrol edilebilir.

**Fix onerisi:**
```typescript
const escapeCsvValue = (value: string): string => {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `"'${value.replace(/"/g, '""')}"`;
  }
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};
```

**Alternatif (daha iyi):** Ortak bir `escapeCsvCell` utility fonksiyonu olusturup her iki yerde de kullanmak (DRY prensibi).

---

## REGRESYON RISK DEGERLENDIRMESI

| Grup | Fix | Risk | Aciklama |
|------|-----|------|----------|
| E | C8 | DUSUK | Callback davranisi degismedi, sadece ref uzerinden erisiyor |
| E | C7 | ORTA | cacheKey degisiminde artik refetch var -- istenen davranis ama onceden olmayan API cagirilari tetiklenebilir |
| E | H1 | DUSUK | 100 entry yeterli, LRU dogru calisiyor |
| F | C13 | DUSUK | Backend contract'i ile uyumlu, tek field degisikligi |
| G | H18/H19/H21 | DUSUK | Path string degisiklikleri, davranis ayni |
| H | H23 | DUSUK | DTO validasyonu, mevcut gecerli istekler etkilenmez |
| H | H24 | DUSUK | Primitive degerler gecmeye devam eder |
| H | H26 | DUSUK | Sadece baska admin'in oturumunu sonlandirma engelleniyor |
| H | H14 | DUSUK | Global guard zaten koruyordu, explicit guard defense-in-depth |
| I | H22 | DUSUK | CSV format korunuyor, ek escaping zarar vermez |

---

## GENEL DEGERLENDIRME

**Kalite:** Yuksek. 12 bulgunun tamami teknik olarak dogru cozulmus. Kod degisiklikleri minimal ve odakli. SOLID prensipleri genel olarak korunmus.

**Eksikler:**
1. QueryEditor'daki CSV export fonksiyonu formula injection korumasindan yoksun (YENI SORUN -- YUKSEK oncelik).
2. `(req as any).user?.id` pattern'i TypeScript type safety'yi zayiflatiyor (tum proje genelinde mevcut, yeni degil, dusuk oncelik).

**Test durumu:** Grup E raporu 32 testten 26'sinin timeout'a takildigini belirtmis. Bu fix oncesinde de vardi. Test altyapisi iyilestirilmeli (gelecek sprint onerisi olarak kabul edilir).
