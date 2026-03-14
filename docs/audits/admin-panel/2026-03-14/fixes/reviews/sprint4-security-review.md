# Sprint 4 Guvenlik Review

**Tarih:** 2026-03-14
**Reviewer:** Guvenlik Review Ajanı (OWASP Top 10 / SANS 25 perspektifi)
**Kapsam:** Grup V (Backend Endpoint'ler), Grup U (DatabaseManagement), Grup X (Controller Testleri)

---

## Genel Degerlendirme

Sprint 4 kapsaminda incelenen degisiklikler genel olarak guvenlik bilincini yansitmaktadir. JWT-tabanli kimlik dogrulama, session ownership kontrolleri, rate limiting ve input validation dogru bir mimari uzerinde insa edilmistir. Ancak birkac MEDIUM seviyesinde sorun ve iyilestirme alani tespit edilmistir. CRITICAL veya HIGH seviyesinde bir zafiyet bulunmamistir.

---

## Endpoint Bazli Guvenlik Analizi

### 1. SettingsController (`settings.controller.ts`)

| Endpoint | Guard | Identity | Validation | Throttle | Risk | Sonuc |
|---|---|---|---|---|---|---|
| `GET /settings` | Class-level `@UseGuards(PlatformAdminGuard)` (satir 23) | N/A (read-only) | Query param string karsilastirma | Yok | LOW | KABUL |
| `GET /settings/category/:category` | Class-level guard | N/A | Enum category param | Yok | LOW | KABUL |
| `GET /settings/key/:key` | Class-level guard | N/A | String param | Yok | LOW | KABUL |
| `PUT /settings/key/:key` | Class-level guard | `req.user.id` JWT (satir 71) | `UpdateSystemSettingDto` | Yok | MEDIUM | KOSULLU KABUL |
| `PUT /settings/bulk` | Class-level guard | `req.user.id` JWT (satir 93) | Inline body type | Yok | MEDIUM | KOSULLU KABUL |
| `PUT /settings/config/email` | Class-level guard | `req.user.id` JWT (satir 128) | Inline body type | Yok | MEDIUM | KOSULLU KABUL |
| `PUT /settings/config/security` | Class-level guard | `req.user.id` JWT (satir 159) | Inline body type | Yok | MEDIUM | KOSULLU KABUL |
| `PUT /settings/config/rate-limits` | Class-level guard | `req.user.id` JWT (satir 188) | Inline body type | Yok | MEDIUM | KOSULLU KABUL |
| `PUT /settings/config/maintenance` | Class-level guard | `req.user.id` JWT (satir 216) | Inline body type | Yok | MEDIUM | KOSULLU KABUL |
| `PUT /settings/config/billing` | Class-level guard | `req.user.id` JWT (satir 250) | Inline body type | Yok | LOW | KABUL |
| `POST /settings/import` | Class-level guard | `req.user.id` JWT (satir 296) | Inline body type | Yok | MEDIUM | KOSULLU KABUL |
| `GET /settings/export` | Class-level guard | N/A | Yok | Yok | LOW | KABUL |
| `POST /settings/key/:key/reset` | Class-level guard | YOK | Yok | Yok | MEDIUM | KOSULLU KABUL |
| `GET /settings/system/info` | Class-level guard | N/A | Yok | Yok | LOW | KABUL |
| `GET /settings/features/:featureKey` | Class-level guard | N/A | Yok | Yok | LOW | KABUL |

**Guard Kaniti:** Satir 23'te `@UseGuards(PlatformAdminGuard)` class-level dekorator mevcut. Bu, tum endpoint'lerin guard tarafindan korunmasini saglar. `PlatformAdminGuard` (platform-admin.guard.ts satir 111) JWT'yi `jwt.verify()` ile dogruluyor, `sub` field'dan user ID cikariyor ve `SUPER_ADMIN`/`PLATFORM_ADMIN` role kontrolu yapiyor.

**Identity Kaniti:** Tum PUT/POST mutasyon endpoint'lerinde `(req as any).user?.id` ile JWT'den user ID alinmaktadir (satirlar 71, 93, 128, 159, 188, 216, 250, 296). Guard (satir 117-123) `request.user` objesine `id: payload.sub` atamaktadir.

### 2. ImpersonationController (`impersonation.controller.ts`)

| Endpoint | Guard | Identity | Validation | Throttle | Risk | Sonuc |
|---|---|---|---|---|---|---|
| `GET /impersonation/permissions` | Class-level guard (satir 245) | N/A | `QueryPermissionsDto` (class-validator) | Yok | LOW | KABUL |
| `POST /impersonation/permissions` | Class-level guard | `req.user.id` JWT (satir 274) | `GrantPermissionDto` (full validation) | Yok | LOW | KABUL |
| `GET /impersonation/permissions/:superAdminId` | Class-level guard | N/A | String param | Yok | LOW | KABUL |
| `POST /impersonation/permissions/:superAdminId/revoke` | Class-level guard | N/A | String param | Yok | LOW | KABUL |
| `POST /impersonation/sessions/start` | Class-level guard | `req.user.id + .email` JWT (satir 316-317) | `StartImpersonationDto` (full validation) | `@ThrottleSensitive()` (3/5min) | LOW | KABUL |
| `POST /impersonation/sessions/:id/end` | Class-level guard | `req.user.id` JWT (satir 340) | Minimal body | `@ThrottleSensitive()` | LOW | KABUL |
| `POST /impersonation/sessions/:id/terminate` | Class-level guard | `req.user.id` JWT (satir 356) | `{ reason: string }` body | `@ThrottleSensitive()` | LOW | KABUL |
| `POST /impersonation/sessions/:id/extend` | Class-level guard | `req.user.id` JWT (satir 371) | `ExtendSessionDto` (Min/Max validated) | `@ThrottleSensitive()` | LOW | KABUL |
| `GET /impersonation/sessions/validate` | Class-level guard | N/A | Header token | Yok | LOW | KABUL |
| `GET /impersonation/sessions/active` | Class-level guard | N/A | Yok | Yok | LOW | KABUL |
| `GET /impersonation/sessions` | Class-level guard | N/A | `QuerySessionsDto` (validated) | Yok | LOW | KABUL |
| `POST /impersonation/sessions/:id/log-action` | Class-level guard | N/A | `LogActionDto` (validated) | Yok | LOW | KABUL |
| `GET /impersonation/audit/summary` | Class-level guard | N/A | Query string params | Yok | LOW | KABUL |

### 3. ImpersonationService (`impersonation.service.ts`)

| Kontrol | Durum | Kanit |
|---|---|---|
| Session ownership (end) | MEVCUT | Satir 457: `if (endedBy && session.superAdminId !== endedBy)` -> ForbiddenException |
| Session ownership (extend) | MEVCUT | Satir 514: `if (session.superAdminId !== extendedBy)` -> ForbiddenException |
| Session ownership (terminate) | EKSIK | Satir 473-493: `terminateSession` herhangi bir admin tarafindan cagrilabilir. Ownership kontrolu yok. BKSA: asagida detayli analiz. |
| Max duration (extend) | MEVCUT | Satir 523-533: Permission'dan `maxSessionDurationMinutes` alinip toplam sure kontrol ediliyor |
| Rate limiting (start) | MEVCUT | Satir 322-334: In-memory rate limiting (5 req / 5 min per admin+IP) |
| Token hashing | MEVCUT | Satir 373: `hashToken(rawImpersonationToken)` SHA-256 ile DB'ye kaydediliyor |
| Permission fail-closed | MEVCUT | Satir 296-299: `allowedTenants` bos ise impersonation reddediliyor |
| Concurrent session limit | MEVCUT | Satir 306-310: `maxConcurrentSessions` kontrolu |
| Permission escalation koruması | MEVCUT | Satir 385-399: Request permissions sadece KISITLAYABILIR, genisletemez |

### 4. DatabaseManagementPage (`DatabaseManagementPage.tsx`)

| Kontrol | Durum | Kanit |
|---|---|---|
| SQL Injection riski | YOK | Tum sayfa mock data kullaniyor (satirlar 120-350). Hicbir API cagirisi yok. `fetch()`, `axios`, `apiClient` vb. kullanim yok. |
| XSS riski | MINIMAL | React JSX otomatik escaping saglar. `dangerouslySetInnerHTML` kullanilmiyor. |
| Kullanici input sanitizasyonu | N/A | Herhangi bir form submit islemi backend'e gonderilmiyor. Butonlar gorsel olarak mevcut ama handler'lar bos. |

---

## Test Guvenlik Kalitesi

### `impersonation.controller.spec.ts` (712 satir)

**Kapsanan guvenlik senaryolari:**

1. **Guard enforcement (satirlar 124-160):** Guard'in her request'te cagrildigini, `false` donunce 403, exception atinca dogru HTTP status donundugunu test ediyor. YETERLI.

2. **JWT identity injection testi (satirlar 172-186):** Client'in `superAdminId: 'attacker-injected-id'` gondermesine ragmen servisin `authenticatedUser.id` aldigini dogruluyor. Bu, identity spoofing saldiri senaryosunu DOGRUDAN kapsiyor.

3. **Identity override via headers (satirlar 357-369):** `x-admin-id: 'attacker-injected'` header'inin etkisiz oldugunu dogruluyor. YETERLI.

4. **Unauthenticated request (satirlar 200-211, 371-380, 427-437):** Guard'in user set etmemesi durumunda 500 donundugunu test ediyor.

5. **Input validation (satirlar 238-337):** UUID format, enum validation, min/max limitleri, maxLength kontrolleri. KAPSAMLI.

6. **ThrottleSensitive metadata (satirlar 506-536):** `startImpersonation`, `endImpersonation`, `terminateSession` metodlarinda THROTTLE_CONFIG metadata'sinin varligini ve limit=3, ttl=300 oldugunu dogruluyor. YETERLI.

7. **Class-level guard (satirlar 542-549):** `__guards__` metadata'sinin `PlatformAdminGuard` icerdigini dogruluyor. YETERLI.

8. **Error propagation (satirlar 635-672):** NotFoundException (404), ForbiddenException (403) propagasyonunu test ediyor. YETERLI.

**Kapsanmayan guvenlik senaryolari:**

1. `extendSession` endpoint'i icin test EKSIK -- extend icin JWT identity, ownership check, min/max duration validation testleri yok.
2. `terminateSession` icin ownership kontrolunun OLMADIGINI sorgulayan bir test yok.
3. Expired token, malformed token gibi JWT edge case'leri controller testlerinde yok (guard testlerinde olmali).

**Eksik test dosyalari:**
- `billing.controller.spec.ts` -- BULUNAMADI
- `debug-tools.controller.spec.ts` -- BULUNAMADI

---

## Bulunan Guvenlik Sorunlari

### MEDIUM-001: Settings Endpoint'lerinde Input Validation DTO Eksikligi

**Etkilenen endpoint'ler:**
- `PUT /settings/config/email` (satir 117-126)
- `PUT /settings/config/security` (satir 148-156)
- `PUT /settings/config/rate-limits` (satir 179-185)
- `PUT /settings/config/maintenance` (satir 209-213)
- `PUT /settings/config/billing` (satir 241-247)
- `PUT /settings/bulk` (satir 90)

**Sorun:** Bu endpoint'lerin body parametreleri inline TypeScript type olarak tanimlanmis, class-validator dekoratoru KULLANILMIYOR. NestJS'in `ValidationPipe` sadece `class-validator` dekoratorleri olan siniflarla calisir. Inline TypeScript interface'ler calisma zamaninda yok olur.

**Exploit senaryosu:**
```json
PUT /settings/config/security
{
  "sessionTimeoutMinutes": -999999,
  "maxLoginAttempts": 999999,
  "lockoutDurationMinutes": 0,
  "passwordMinLength": 1,
  "mfaEnabled": false
}
```
Bu request gecerli kabul edilir. `sessionTimeoutMinutes: -999999` hemen expire olan session'lar, `passwordMinLength: 1` zayif parola politikasi, `maxLoginAttempts: 999999` brute-force korumasini devre disi birakir.

**Azaltici faktor:** Sadece PlatformAdmin erisebilir. Ancak compromised admin hesabi veya insider threat senaryosunda kotu niyetli konfigurasyona karsi koruma yoktur.

**Fix onerisi:** Her config endpoint icin `class-validator` dekoratorleri olan DTO sinifi olusturulmali:
```typescript
class UpdateSecurityConfigDto {
  @IsOptional() @IsInt() @Min(5) @Max(1440) sessionTimeoutMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) maxLoginAttempts?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1440) lockoutDurationMinutes?: number;
  @IsOptional() @IsInt() @Min(6) @Max(128) passwordMinLength?: number;
  @IsOptional() @IsBoolean() mfaEnabled?: boolean;
  @IsOptional() @IsBoolean() enforceHttps?: boolean;
}
```

### MEDIUM-002: Settings Endpoint'lerinde Rate Limiting Eksikligi

**Etkilenen endpoint'ler:** Tum `PUT` ve `POST` endpoint'leri `settings.controller.ts` icinde.

**Sorun:** Impersonation controller'da hassas endpoint'lere `@ThrottleSensitive()` eklenirken, settings controller'da hicbir endpoint'e rate limiting uygulanmamis.

**Exploit senaryosu:** Compromised admin token ile `PUT /settings/config/security` endpoint'i saniyede yuzlerce kez cagirilabilir, surekli konfigurasyonu degistirerek servisin tutarsiz bir durumda kalmasina neden olabilir (race condition).

**Fix onerisi:** Ozellikle `PUT /settings/config/security`, `PUT /settings/config/maintenance`, `POST /settings/import` endpoint'lerine `@ThrottleSensitive()` eklenmelidir.

### MEDIUM-003: `POST /settings/key/:key/reset` Endpoint'inde Audit Trail Eksikligi

**Sorun:** Satir 79-82'de `resetToDefault` cagriliyor ancak `updatedBy` bilgisi iletilmiyor. Kim hangi ayari sifirladigi kayit altina alinmiyor.

**Kanit:** Controller'da:
```typescript
@Post('key/:key/reset')
async resetToDefault(@Param('key') key: string) {
  return this.settingsService.resetToDefault(key);
}
```
`req.user.id` alinmiyor. Diger tum mutasyon endpoint'lerinde (`PUT key/:key`, `PUT bulk`, `PUT config/*`) userId alinip `updatedBy` olarak iletilmektedir.

**Fix onerisi:**
```typescript
@Post('key/:key/reset')
async resetToDefault(@Param('key') key: string, @Req() req: Request) {
  const userId = (req as any).user?.id;
  if (!userId) throw new UnauthorizedException('User not authenticated');
  return this.settingsService.resetToDefault(key, userId);
}
```

### MEDIUM-004: terminateSession Ownership Kontrolu Tasarim Karari

**Sorun:** `endImpersonation` (satir 457) ve `extendSession` (satir 514) session ownership kontrolu yapiyor -- sadece session'i baslatan admin bitirebilir/uzatabilir. Ancak `terminateSession` (satir 473-493) bunu yapmiyor.

**Analiz:** Bu KASITLI bir tasarim karari olabilir. "Terminate" bir ust duzey yonetim islemidir (ornegin: guvenlik olayinda baska bir admin'in oturumunu sonlandirma). "End" ise normal sonlandirmadir. Ancak bu fark koddaki yorumlardan anlasilmiyor.

**Risk:** Herhangi bir PlatformAdmin, baska bir admin'in impersonation session'ini terminate edebilir. Bu bir guvenlik acigi degil, ancak:
1. Yetki ayrimi (separation of duties) perspektifinden dokumanlanmali
2. Terminate isleminin audit log'da acikca kim tarafindan yapildigi kayit altinda (satir 485: `Terminated by ${terminatedBy}: ${reason}`)

**Sonuc:** KABUL (tasarim karari olarak) -- ancak test dosyasinda bu davranisi dogrulayan bir test olmali.

### MEDIUM-005: Unauthenticated User Durumunda HTTP 500 Donusu

**Sorun:** Test dosyasinda (satirlar 200-211, 371-380, 427-437, 491-499) guard'in user set etmemesi durumunda `HttpStatus.INTERNAL_SERVER_ERROR` (500) beklenmektedir. Bunun nedeni controller'larin `throw new Error('User not authenticated')` kullanmasi -- bu NestJS tarafindan 500 olarak handle edilir, 401 degil.

**Kanit:** Impersonation controller satirlari 317-319:
```typescript
if (!user?.id || !user?.email) {
  throw new Error('User not authenticated');
}
```
`Error` yerine `UnauthorizedException` kullanilmalidir. Settings controller'da (satirlar 72, 94, 129, vb.) `UnauthorizedException` dogru kullanilmaktadir, ancak impersonation controller'da `new Error()` kullanilmaktadir.

**Guvenlik etkisi:** 500 hatasi sunucu stack trace'ini loglara yazarak potansiyel bilgi sizintisi yaratir. 401 donusu daha uygun ve guvenlidir.

**Fix onerisi:** Impersonation controller'daki tum `throw new Error('User not authenticated')` ifadelerini `throw new UnauthorizedException('User not authenticated')` ile degistirin.

### LOW-001: Encryption Salt Hardcoded

**Dosya:** `system-setting.service.ts`, satirlar 935, 949.

**Sorun:** `crypto.scryptSync(this.encryptionKey, 'salt', 32)` -- salt degeri sabit 'salt' string'i olarak hardcoded. Bu, ayni sifre ile her zaman ayni anahtar uretilmesine neden olur.

**Risk:** ENCRYPTION_KEY'in ele gecirilmesi durumunda rainbow table saldirisina karsi koruma azdir. Ancak ENCRYPTION_KEY zaten env variable olarak korunmaktadir ve production'da kontrol ediliyor (satir 82-85).

**Fix onerisi:** Unique salt kullanilmali veya her encrypt isleminde random salt uretilip ciphertext ile birlikte saklanmali.

### LOW-002: DatabaseManagementPage Tamamen Mock Data Kullanıyor

**Sorun:** Tum sayfa mock/hardcoded data kullaniyor. Hicbir API cagirisi yok. Butonlar (Create Schema, Run Migration, Create Backup, Restore, Apply Index, vb.) hicbir handler'a bagli degil.

**Guvenlik etkisi:** SIFIR -- cunku backend'e hicbir request gitmiyor. Ancak ileride gercek API entegrasyonu yapildiginda bu butonlara dogru guvenlik kontrolleri eklenmelidir. Ozellikle "Apply Index" butonu (satir 1279) `createStatement` icerigi dogrudan render ediliyor -- ileride bu string backend'e gonderilirse SQL injection riski olusur.

---

## Test Dosyalari Durumu

| Test Dosyasi | Durum | Guvenlik Kalitesi |
|---|---|---|
| `impersonation.controller.spec.ts` | MEVCUT (712 satir) | IUYI -- identity spoofing, header injection, guard enforcement, input validation, throttle metadata testleri var |
| `billing.controller.spec.ts` | BULUNAMADI | EKSIK |
| `debug-tools.controller.spec.ts` | BULUNAMADI | EKSIK |

---

## Ozet Skor Tablosu

| Kategori | Skor | Notlar |
|---|---|---|
| AuthZ (Guard) | 9/10 | Tum controller'larda class-level PlatformAdminGuard mevcut. Guard implementasyonu saglam (JWT verify, role check, min secret length). |
| Identity (JWT vs Client) | 8/10 | Tum mutasyon endpoint'lerinde JWT-based identity. `resetToDefault` ve impersonation controller'daki Error tipi (-2 puan). |
| Input Validation | 6/10 | Impersonation controller'da mukemmel DTO validation. Settings controller'da inline type'lar, runtime validation YOK (-4 puan). |
| Rate Limiting | 7/10 | Impersonation'da @ThrottleSensitive + service-level rate limiting. Settings'de tamamen eksik (-3 puan). |
| Session Security | 9/10 | Ownership check (end/extend), max duration, concurrent limit, token hashing, expire cron. terminate ownership kasitli eksik. |
| Audit Trail | 8/10 | updatedBy cogu yerde mevcut. resetToDefault eksik (-2 puan). |
| Error Handling | 7/10 | Settings controller UnauthorizedException kullaniyor. Impersonation controller plain Error kullaniyor (-3 puan). |
| SQL Injection | 10/10 | TypeORM parameterized queries. Frontend mock data. |
| Test Coverage | 6/10 | Impersonation testleri iyi. extendSession testi eksik. 2 test dosyasi bulunamadi (-4 puan). |

**Agirlikli Genel Skor: 7.8/10**

---

## Sonuc: KOSULLU ONAY

Sprint 4 degisiklikleri, CRITICAL veya HIGH seviyesinde bir guvenlik acigi icermiyor. Mimari guvenlik kararlari (JWT-based identity, PlatformAdminGuard, session ownership, token hashing, fail-closed permission) dogru uygulanmistir.

**Onay kosullari (sonraki sprint'te cozulmeli):**

1. **MEDIUM-001:** Settings config endpoint'leri icin class-validator DTO'lari olusturulmali (ZORUNLU)
2. **MEDIUM-003:** `resetToDefault` endpoint'ine `updatedBy` audit trail eklenmeli (ZORUNLU)
3. **MEDIUM-005:** Impersonation controller'daki `throw new Error()` ifadeleri `UnauthorizedException` ile degistirilmeli (ZORUNLU)
4. **MEDIUM-002:** Settings controller'a `@ThrottleSensitive()` eklenmeli (ONERILEN)
5. **MEDIUM-004:** `terminateSession` ownership karari dokumanlanmali veya test eklenmeli (ONERILEN)

Bu kosullar karsilanana kadar production deploy'a **DUR** denilmemelidir ancak sonraki sprint'in baslangicinda bu fix'ler oncelikli olarak ele alinmalidir.
