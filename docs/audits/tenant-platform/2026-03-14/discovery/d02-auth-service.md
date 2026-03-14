# D02 - Auth Service Deep Audit

**Auditor:** Kimlik Dogrulama Uzmani (D2)
**Tarih:** 2026-03-14
**Kapsam:** apps/auth-service/src/ -- Enterprise guvenlik perspektifinden tam inceleme
**Oncelik Notasyonu:** [KRITIK] / [YUKSEK] / [ORTA] / [DUSUK] / [BILGI]

---

## 1. DOSYA YAPISI VE MIMARI GENEL BAKIS

### 1.1 Dosya Listesi (78 TypeScript dosyasi)

```
apps/auth-service/src/
  app.module.ts                    # Root module: TypeORM(auth schema), GraphQL Fed v2, JWT, EventBus
  main.ts                          # Bootstrap: helmet, CORS, cookie-parser, ValidationPipe
  constants/auth.constants.ts      # Merkezi guvenlik sabitleri

  audit/
    audit-log.entity.ts            # AuditLog entity (severity, IP, userAgent)
    audit-log.service.ts           # Guvenlik olaylarini loglar, gunluk temizlik cron'u
    audit.module.ts

  database/
    seed.service.ts                # Baslangicta module + SUPER_ADMIN olusturur

  privacy/
    data-masking.service.ts        # (bos dosya - henuz implement edilmemis)
    gdpr-compliance.service.ts     # (bos dosya - henuz implement edilmemis)

  rate-limit/
    rate-limiter.service.ts        # (bos dosya - henuz implement edilmemis)
    throttle.decorator.ts

  utils/
    sanitize.ts                    # HTML escape, SQL identifier validasyonu

  modules/
    authentication/                # Cekirdek auth (login, register, JWT, refresh)
    tenant/                        # Tenant CRUD, admin, role, mobile settings
    system-module/                 # Platform modulleri (farm, sensor, hr, hydroponics)
    gdpr/                          # User consent yonetimi
    messaging/                     # SuperAdmin <-> TenantAdmin mesajlasma
    support/                       # Destek talep sistemi
    announcement/                  # Platform duyurulari

  health/
    health.module.ts
    health.controller.ts
```

### 1.2 Mimari Ozellikler

| Ozellik | Deger |
|---------|-------|
| Framework | NestJS + GraphQL Federation v2 (Apollo) |
| Veritabani | PostgreSQL, TypeORM, `auth` semasi |
| JWT | @nestjs/jwt, HMAC (HS256 varsayilan) |
| Sifre Hash | bcryptjs, 12 salt round |
| Olay Yolu | NATS via @platform/event-bus |
| Varsayilan Port | 4001 (env: AUTH_SERVICE_PORT) |
| Sema Izolasyonu | auth schema (paylasilmaz), tenant_* schemalari (SchemaManagerService) |

---

## 2. JWT IMPLEMENTASYONU

### 2.1 Imzalama ve Dogrulama

**Algoritma:** HMAC-SHA256 (varsayilan). Asimetrik anahtar (RS256) kullanilmiyor.

**Anahtar Yonetimi (app.module.ts:108-175):**
- Uretim: `JWT_SECRET` env degiskeni zorunlu, min 32 karakter
- Gelistirme: `ALLOW_DEV_JWT_SECRET=true` + `DEV_JWT_SECRET` (min 32 karakter) gerekli
- Uretimde JWT_SECRET yoksa uygulama baslamaz (fail-fast)

```typescript
// app.module.ts:160-164
if (secret.length < SECURITY_CONSTANTS.JWT_SECRET_MIN_LENGTH) {
  throw new Error(`JWT_SECRET must be at least ${SECURITY_CONSTANTS.JWT_SECRET_MIN_LENGTH} characters`);
}
```

**JWT Payload Yapisi:**
```typescript
interface JwtPayload {
  sub: string;           // User ID
  email: string;         // Kullanici emaili
  role: Role;            // Tekil rol
  roles: Role[];         // Rol dizisi (uyumluluk)
  tenantId: string|null; // SUPER_ADMIN icin null
  modules?: string[];    // Modul kodlari
  jti?: string;          // Token blacklisting icin JWT ID
  iat?: number;          // Issued at
  exp?: number;          // Expiration
}
```

**Sign Options:**
- `expiresIn`: varsayilan 15 dakika (`JWT_EXPIRES_IN` env)
- `issuer`: `JWT_ISSUER` env (varsayilan: "aquaculture-platform")
- `audience`: `JWT_AUDIENCE` env (varsayilan: "aquaculture-platform")

### 2.2 Token Dogrulama (jwt-auth.guard.ts)

- Audience claim dogrulanir (cross-service replay korunmasi)
- Token blacklist kontrolu: hem JTI bazli hem user-level invalidation
- `@Public()` decorator ile public endpoint'ler isaretlenir
- GraphQL ve HTTP context destegi

**[BILGI] OLUMLU:** Audience dogrulama, JTI blacklist, user-level blacklist -- iyi katmanli koruma.

### 2.3 Token Blacklisting

- `ITokenBlacklist` interface'i (`@platform/backend-common`)
- Optional inject (`@Optional()`) -- implement edilmemisse bypass olur
- `logout()`: Tum refresh token'lar revoke + JTI blacklist
- `logoutAllDevices()`: Tum refresh token'lar + user-level blacklist

### 2.4 Guvenlik Degerlendirmesi

**[ORTA] BULGU-001: JWT Secret Rotasyonu Yok**
Mevcut implementasyonda JWT secret rotasyon mekanizmasi bulunmuyor. Tek bir statik secret
kullaniliyor. Secret sizdirildigi takdirde tum token'lar gecerli kalir ve rotasyon icin
uygulama yeniden baslatilmasi gerekir.
- **Dosya:** `app.module.ts:108-175`
- **Oneri:** Dual-secret destegi (primary + previous) ile sifir-kesinti rotasyon eklensin.
  Alternatif olarak RS256 asimetrik imzalama ile JWKS endpoint destegi dusunulsun.

**[DUSUK] BULGU-002: Email JWT Payload Icinde**
JWT payload'da `email` alani mevcut. Token ele gecirildiginde PII ifsa olur.
GDPR veri minimizasyonu ilkesine aykiri olabilir.
- **Dosya:** `authentication.service.ts:886-894`
- **Oneri:** JWT payload'dan email cikarilsin; gerektiginde `sub` (userId) ile DB'den alinsin.

**[BILGI] OLUMLU-001: JTI + User-Level Blacklist**
Token iptal mekanizmasi kapsamli. Tek token iptali (JTI) ve kullanici bazli toplu iptal
destekleniyor. Logout isleminde hem refresh hem access token iptal ediliyor.

---

## 3. SIFRE YONETIMI

### 3.1 Hashing Algoritmasi

**Algoritma:** bcryptjs
**Salt Rounds:** 12 (`SECURITY_CONSTANTS.BCRYPT_SALT_ROUNDS`)
**Uygulama:** User entity `@BeforeInsert` / `@BeforeUpdate` hook

```typescript
// user.entity.ts:182-183
const bcryptHashPattern = /^\$2[aby]?\$\d{2}\$/;
if (this.password && !bcryptHashPattern.test(this.password)) {
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
}
```

**[BILGI] OLUMLU-002:** bcrypt hash pattern regex ile cift hash onleniyor. `startsWith('$2')`
yerine tam regex kullanilmasi dogru yaklasim.

### 3.2 Sifre Politikasi (DTO Validasyonu)

```
RegisterInput / AcceptInvitationInput:
- Min 8 karakter, max 128 karakter
- En az 1 buyuk harf, 1 kucuk harf, 1 rakam, 1 ozel karakter
- Regex: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,128}$/
```

**SUPER_ADMIN Seed Sifresi:**
- Min 12 karakter, zorunlu karisik icerik
- Uretimde `SUPER_ADMIN_PASSWORD` env degiskeni zorunlu

### 3.3 Password Reset Flow

**[YUKSEK] BULGU-003: Password Reset Flow Eksik**
User entity'de `passwordResetToken` ve `passwordResetExpires` alanlari var, ancak
`AuthenticationService` icinde password reset mutation/endpoint bulunmuyor.
`TenantService.createTenantAdminUser()` reset token olusturuyor fakat bunu dogrulamak
icin bir flow yok. Sifremi unuttum akisi uygulanmamis.
- **Dosya:** `user.entity.ts:147-149`, `tenant.service.ts:226-230`
- **Oneri:** `forgotPassword(email)` ve `resetPassword(token, newPassword)` mutation'lari eklensin.
  Token SHA-256 ile hashlenip DB'de saklanmasi iyi, ancak dogrulama endpoint'i gerekli.

**[BILGI] OLUMLU-003:** Tenant admin olusturmada reset token SHA-256 ile hashleniyor
(plaintext saklanmiyor). Iyi pratik.

### 3.4 MFA Durumu

**[ORTA] BULGU-004: MFA Sadece Entity Seviyesinde**
`User` entity'de `mfaEnabled` ve `mfaSecret` alanlari var, ancak MFA dogrulama
lojigi (TOTP setup, verify, recovery codes) implement edilmemis. MFA secret sifrelenmemis
(plaintext olarak saklanma riski).
- **Dosya:** `user.entity.ts:127-135`
- **Yorum:** Entity'de TODO yorumu mevcut: "MFA secret should be encrypted at rest using AES-256"
- **Oneri:** MFA implementasyonu tamamlansin. `mfaSecret` AES-256 ile sifrelenmeli.

---

## 4. REFRESH TOKEN YONETIMI

### 4.1 Saklama

- **Depolama:** PostgreSQL `auth.refresh_tokens` tablosu
- **Hash:** `HASH_REFRESH_TOKENS=true` (varsayilan) oldugunda bcrypt ile hashlenir
- **Plaintext:** Istemciye doner; DB'de sadece hash saklanir
- **Cookie:** httpOnly, secure (uretimde), sameSite=lax, path=/

### 4.2 Token Formati

```
Hash modu: {userId}:{64-byte-random-hex}
Normal mod: {64-byte-random-hex}
```

UserId prefix'i ile hash karsilastirmasi tek kullanicinin token'lari ile sinirlandirilir
(performans optimizasyonu).

### 4.3 Token Rotasyonu

Her `refreshToken()` cagirisinda:
1. Mevcut token pessimistic lock ile kilitlenir (SELECT FOR UPDATE)
2. Token revoke edilir
3. Yeni token ciftleri uretilir
4. Islem transaction icinde gerceklesir

### 4.4 Revocation

- Logout: Tum refresh token'lar revoke
- Kullanici deaktivasyonu: Tum refresh token'lar revoke (`TenantAdminService.deactivateUser`)
- Seans siniri: `MAX_SESSIONS_PER_USER` (varsayilan 5)
- `revokedReason` alani ile neden takibi

### 4.5 Guvenlik Degerlendirmesi

**[BILGI] OLUMLU-004:** Refresh token hash'leme, rotation, pessimistic locking, httpOnly
cookie -- hepsi enterprise seviyesinde iyi implementasyon.

**[ORTA] BULGU-005: Refresh Token Replay Detection Eksik**
Eger bir refresh token calinir ve saldirgan kullanirsa, mevcut token revoke olur
ve yeni token saldirgan icin uretilir. Gercek kullanici eski token ile geldiginde
"revoked" hatasi alir -- ancak sistem otomatik olarak tum oturumlari kapatmaz
(token ailesi invalidasyonu yok).
- **Dosya:** `authentication.service.ts:496-620`
- **Oneri:** Token family tracking eklensin. Revoke edilmis bir token tekrar
  kullanildiginda, o kullanicinin tum token'lari otomatik olarak revoke edilsin
  (olasi token calmasi sinyali).

**[DUSUK] BULGU-006: Refresh Token Cookie + Body Dual Kanal**
Resolver'da hem cookie hem body'den token kabul ediliyor (`context.req.cookies?.refresh_token || input.refreshToken`).
Cookie oncelikli ancak body fallback'i XSS ile token calmaya kapı acar.
- **Dosya:** `auth.resolver.ts:135`
- **Oneri:** Body fallback'i kaldirilsin veya deprecation sureci baslatilsin.

---

## 5. BRUTE FORCE VE ACCOUNT LOCKOUT

### 5.1 Implementasyon

```
Varsayilan Degerleri:
- MAX_FAILED_ATTEMPTS: 5
- LOCKOUT_DURATION_MINUTES: 30
- MIN_LOGIN_DURATION_MS: 200
```

**Atomik Increment (authentication.service.ts:839-872):**
```sql
UPDATE auth.users
SET "failedLoginAttempts" = "failedLoginAttempts" + 1,
    "lockedUntil" = CASE
      WHEN "failedLoginAttempts" + 1 >= $2 THEN $3::timestamp
      ELSE "lockedUntil"
    END
WHERE id = $1
RETURNING "failedLoginAttempts", "lockedUntil"
```

- Atomik SQL ile race condition onlenir
- Basarili giriste `failedLoginAttempts = 0`, `lockedUntil = null`
- Kilitli hesap giris denemesinde CRITICAL audit log

### 5.2 Zamanlama Saldirisi Korunmasi

```typescript
// authentication.service.ts:243-246 -- Kullanici bulunamazsa dummy hash
await bcrypt.compare(input.password, '$2a$12$dummy.hash...');
await this.ensureMinDuration(startTime); // Min 200ms
```

- Kullanici bulunamasa bile bcrypt karsilastirmasi yapilir
- `ensureMinDuration()` tum login dallarinda cagrilir
- `TimingSafeService` injectable (optional)

**[BILGI] OLUMLU-005:** Zamanlama saldirisi korunmasi kapsamli -- dummy hash + minimum
sureli login. Kullanici numaralama engellenyor.

### 5.3 Rate Limiting

**[YUKSEK] BULGU-007: Rate Limiter Bos**
`rate-limit/rate-limiter.service.ts` dosyasi bos (0 satir). Resolver yorumlarinda
"Rate limited at gateway level" deniyor, ancak gateway rate limit konfigurasyonu
bu audit kapsaminda dogrulanamadi.
- **Dosya:** `rate-limit/rate-limiter.service.ts`
- **Oneri:** Auth service seviyesinde de rate limiting eklensin (defense in depth).
  Login endpoint icin IP + email bazli rate limit ozellikle onemli.
  Eger gateway rate limit yeterliyse, bu dokumante edilmeli.

---

## 6. TENANT YONETIMI

### 6.1 Tenant Olusturma (tenant.service.ts:110-208)

**Akis:**
1. Slug uretimi (name'den veya input'tan)
2. Duplicate kontrol (name + slug)
3. Trial suresi hesabi (14 gun)
4. Tenant kaydinin olusturulmasi (PENDING status)
5. **Senkron provizyon:** Schema olusturma (`SchemaManagerService.createTenantSchema`)
6. Admin kullanici olusturma (contactEmail varsa)
7. Status ACTIVE'e guncelleme
8. TenantCreated event yayini

**Schema Izolasyonu:**
- Format: `tenant_{ilk16karakter_uuid}` (ornek: `tenant_4b529829ea7948da`)
- Varsayilan moduller: sensor, farm, hr
- Hata durumunda tenant PENDING kalir (manuel mudahale gerekir)

### 6.2 Tenant Lifecycle

| Status | Anlam |
|--------|-------|
| PENDING | Schema olusturulmamis veya provizyon basarisiz |
| ACTIVE | Tam islevsel |
| SUSPENDED | Gecici olarak askiya alinmis |
| CANCELLED | Kalici olarak iptal edilmis |

**Plan Turleri:** TRIAL (14 gun), STARTER, PROFESSIONAL, ENTERPRISE
**Max Users:** Plan bazli (5/10/50/500 varsayilan)

### 6.3 Guvenlik Degerlendirmesi

**[ORTA] BULGU-008: Suspended Tenant Kullanici Girisi Engellenmemis**
Tenant `SUSPENDED` veya `CANCELLED` statusunde olsa bile, o tenant'in kullanicilari
giris yapabilir. Login flow'da tenant status kontrolu yapilmiyor.
- **Dosya:** `authentication.service.ts:230-353` (login metodu)
- **Oneri:** Login sirasinda `user.tenantId` uzerinden tenant statsu kontrol edilsin.
  SUSPENDED/CANCELLED tenant kullanicilari icin giris engellensin.

**[BILGI] OLUMLU-006:** Schema izolasyonu iyi. `getTableSchema()` ve `getTableData()` da
tenant'in erisebilecegi sema'lara erisim sinirli. `auth` semasi acikca dislanmis.
SQL identifier validasyonu ile injection korunmasi saglanmis.

**[ORTA] BULGU-009: Tenant Silme Yok**
Tenant iptal edildikten sonra schema ve verilerin temizlenmesi icin bir mekanizma yok.
GDPR Article 17 (silme hakki) acisinden sorunlu olabilir.
- **Dosya:** `tenant.service.ts` -- sadece status degisikligi var, schema drop yok
- **Oneri:** Tenant data export + schema drop mekanizmasi eklensin (retention suresi sonunda).

---

## 7. KULLANICI YONETIMI

### 7.1 CRUD Islemleri

| Islem | Metod | Yetki |
|-------|-------|-------|
| Self-register | `register()` | Public (kapatilabilir) |
| Invite user | `assignUserToModule()` | TENANT_ADMIN |
| Accept invitation | `acceptInvitation()` | Public (token ile) |
| Deactivate | `deactivateUser()` | TENANT_ADMIN |
| Activate | `activateUser()` | TENANT_ADMIN |
| Role update | `assignModuleManager()` | TENANT_ADMIN |
| Delete | -- | **YOK** |

**[BILGI]** Self-registration `REGISTRATION_ENABLED=false` ile kapatilabilir (enterprise icin varsayilan).

### 7.2 Kullanici Deaktivasyonu

```typescript
// tenant-admin.service.ts:400-433
user.isActive = false;
await this.userRepository.save(user);
// Tum refresh token'lar revoke edilir
await this.refreshTokenRepository.update(
  { userId, isRevoked: false },
  { isRevoked: true, revokedAt: new Date(), revokedReason: 'User deactivated' },
);
```

**[BILGI] OLUMLU-007:** Deaktivasyonda refresh token'lar revoke ediliyor. Mevcut
access token'lar suresi dolana kadar gecerli kalir (max 15 dk).

**[ORTA] BULGU-010: Kullanici Hard Delete Yok**
GDPR Article 17 geregi kullanici silme hakki var. Mevcut implementasyon sadece
`isActive = false` yapiyor, kisisel veriler (email, isim, telefon, IP) silinmiyor.
- **Oneri:** GDPR uyumlu kullanici silme (veya anonimize etme) mekanizmasi eklensin.

---

## 8. DAVET AKISI (INVITATION FLOW)

### 8.1 Token Uretimi

```typescript
// invitation.entity.ts:178-181
static generateToken(): string {
  return crypto.randomBytes(32).toString('hex'); // 64 hex karakter, 256 bit entropy
}
```

### 8.2 Davet Kabul Akisi (authentication.service.ts:378-450)

1. Transaction baslatilir
2. Invitation satirindaki pessimistic lock (TOCTOU korunmasi)
3. `canBeAccepted()` kontrolu (PENDING/RESENT + expired degil)
4. User entity guncelleme (sifre set, invitation token temizle)
5. Invitation status ACCEPTED olarak guncelle
6. Transaction commit
7. InvitationAccepted event yayini
8. Token cifti uretimi

**[BILGI] OLUMLU-008:** `SELECT FOR UPDATE` ile TOCTOU race condition onleniyor. Esanli
iki kabul denemesi engellenyor.

### 8.3 Davet Ekspire ve Sinirlar

- Varsayilan sure: 7 gun (`DEFAULT_INVITATION_EXPIRY_DAYS`)
- Tekrar gonderme limiti: 5 (`sendCount < 5`)
- RESENT statuslu davetler de kabul edilebilir

### 8.4 Guvenlik Degerlendirmesi

**[DUSUK] BULGU-011: Invitation Token Rate Limit Yok**
`validateInvitation` query'si public ve rate limit'siz. Brute force ile gecerli
token tahmin edilmeye calisiabilir (256 bit entropy ile pratikte imkansiz olsa da).
- **Dosya:** `auth.resolver.ts:172-175`
- **Oneri:** Rate limit eklensin (defense in depth).

---

## 9. GDPR UYUMLULUGU

### 9.1 Consent Yonetimi (user-consent.service.ts)

| Ozellik | Durum |
|---------|-------|
| Rizayi kaydet | Var (recordConsent, recordBulkConsent) |
| Rizayi geri cek | Var (withdrawConsent, sebep takibi) |
| Riza durumu sorgula | Var (getConsentStatus, DISTINCT ON optimizasyonu) |
| Riza gecmisi | Var (getConsentHistory, sayfalama) |
| Versiyon takibi | Var (currentVersion = '2.0.0') |
| Guncellik kontrolu | Var (isConsentOutdated) |
| IP/UserAgent kaydi | Var |
| SuperAdmin erisimi | Var (sadece okuma) |
| Tenant izolasyonu | Var (tenantId alani) |

### 9.2 Privacy Servisleri

**[YUKSEK] BULGU-012: Privacy Servisleri Bos**
`privacy/data-masking.service.ts` ve `privacy/gdpr-compliance.service.ts` dosyalari
bos (0 satir). GDPR uyumlulugu icin kritik fonksiyonlar eksik:
- Kisisel veri export (Article 20 - data portability)
- Kisisel veri silme/anonimize (Article 17 - right to erasure)
- Veri maskeleme (log'larda, API yanitlarinda PII gizleme)
- **Oneri:** Bu servisleri implement edin. En azindan:
  - `exportUserData(userId)`: Tum kisisel verileri JSON/CSV olarak export
  - `deleteUserData(userId)`: Anonimize veya hard delete
  - `maskEmail(email)`: `j***@example.com` formati

### 9.3 PII Koruma (Entity Seviyesinde)

User entity'de PII alanlari `@HideField()` ile GraphQL'den gizleniyor:
- `password`, `invitationToken`, `invitationExpiresAt`, `invitedBy`
- `phoneNumber`, `lastLoginIp`, `passwordResetToken`, `passwordResetExpires`
- `mfaSecret`

**[BILGI] OLUMLU-009:** PII alanlari GraphQL'den dogru sekilde gizlenmis.

---

## 10. MESSAGING, SUPPORT VE ANNOUNCEMENTS

### 10.1 Tenant Izolasyonu

| Modul | Tenant Scope | Cross-Tenant Erisim |
|-------|-------------|---------------------|
| Messaging | `thread.tenantId` filtresi | SUPER_ADMIN tum tenant'lari gorur |
| Support | `ticket.tenantId` filtresi | SUPER_ADMIN tum ticket'lari gorur |
| Announcements | `scope` + `tenantId` | Platform-wide + tenant-scoped ayrim |

**Messaging:**
- TENANT_ADMIN: Sadece kendi tenant thread'leri
- SUPER_ADMIN: Tum thread'ler
- Internal notes: Sadece SUPER_ADMIN gorebilir
- Tenant izolasyonu: `getThread()` icinde kontrol

**Support:**
- Ticket olusturma: TENANT_ADMIN (tenantId otomatik set)
- Internal notes: Sadece SUPER_ADMIN
- SLA takibi: Priority bazli response/resolution deadline

**Announcements:**
- Platform scope: SUPER_ADMIN olusturur, tum tenant'lar gorur
- Tenant scope: TENANT_ADMIN olusturur, sadece kendi kullanicilari gorur
- Acknowledgment takibi: View + explicit acknowledgment

### 10.2 Guvenlik Degerlendirmesi

**[DUSUK] BULGU-013: Messaging XSS Korunmasi Eksik**
Mesaj icerigi (`content`) dogrudan DB'ye yazilip geri donduruluyor. `sanitize.ts`
utils mevcut ancak messaging/support/announcement service'lerinde kullanilmiyor.
- **Dosya:** `messaging.service.ts:250-260`, `support.service.ts:271-280`
- **Oneri:** Mesaj icerikleri saklamadan once `sanitizeString()` ile temizlensin.

**[BILGI] OLUMLU-010:** Atomic increment kullaniliyor (`messageCount`, `commentCount`,
`viewCount`, `acknowledgmentCount`) -- race condition'lara karsi korunma saglanmis.

---

## 11. GUARD, MIDDLEWARE VE ERISIM KONTROLU

### 11.1 Middleware Zinciri (app.module.ts:193-201)

```
CorrelationIdMiddleware -> UserContextMiddleware -> TenantContextMiddleware -> RequestLoggingMiddleware
```

Tum route'lara uygulanir (`forRoutes('*')`).

### 11.2 Guard ve Decorator'lar

| Guard/Decorator | Kaynak | Kullanim |
|-----------------|--------|----------|
| `JwtAuthGuard` | auth-service | Token dogrulama, blacklist kontrolu |
| `@Public()` | backend-common | Guard bypass |
| `@SuperAdminOnly()` | backend-common | Sadece SUPER_ADMIN |
| `@TenantAdminOrHigher()` | backend-common | TENANT_ADMIN + SUPER_ADMIN |
| `@CurrentUser(field)` | backend-common | JWT payload'dan alan alma |

### 11.3 Erisim Kontrol Matrisi

| Endpoint | Guard | Yetki |
|----------|-------|-------|
| `login` | @Public | Herkes |
| `register` | @Public | Herkes (kapatilabilir) |
| `refreshToken` | @Public | Gecerli refresh token |
| `acceptInvitation` | @Public | Gecerli invitation token |
| `validateInvitation` | @Public | Herkes |
| `tenantBySlug` | @Public | Herkes (sinirli veri) |
| `logout` | JwtAuthGuard | Authenticated |
| `me` | JwtAuthGuard | Authenticated |
| `createTenant` | JwtAuthGuard + SuperAdminOnly | SUPER_ADMIN |
| `tenants` | JwtAuthGuard + SuperAdminOnly | SUPER_ADMIN |
| `suspendTenant` | JwtAuthGuard + SuperAdminOnly | SUPER_ADMIN |
| `tenant(id)` | JwtAuthGuard + TenantAdminOrHigher | Kendi tenant'i + SUPER_ADMIN |
| `updateTenant` | JwtAuthGuard + TenantAdminOrHigher | Sinirli alanlar + SUPER_ADMIN tam |
| `tenantStats` | JwtAuthGuard + TenantAdminOrHigher | Kendi tenant'i |
| `assignUserToModule` | JwtAuthGuard + TenantAdminOrHigher | TENANT_ADMIN |
| `deactivateTenantUser` | JwtAuthGuard + TenantAdminOrHigher | TENANT_ADMIN |

### 11.4 Guvenlik Degerlendirmesi

**[BILGI] OLUMLU-011:** `updateTenant` mutasyonunda TENANT_ADMIN icin sinirli alan listesi
uygulanmis (`allowedFields`). Status, plan ve maxUsers degisikligi engellenmis.

**[BILGI] OLUMLU-012:** `tenantBySlug` public query'sinde sadece minimal bilgi donuyor
(id, name, slug, logoUrl, status). Plan, maxUsers, settings, contactEmail gizli.

**[ORTA] BULGU-014: JwtAuthGuard APP_GUARD Degil**
`JwtAuthGuard` her resolver/controller'da manuel olarak `@UseGuards(JwtAuthGuard)`
ile uygulanmak zorunda. Unutulursa endpoint korumasiz kalir. Global APP_GUARD olarak
tanimlanmamis.
- **Dosya:** `authentication.module.ts:24`
- **Oneri:** JwtAuthGuard'i `APP_GUARD` olarak tanimlayin ve sadece public endpoint'ler
  icin `@Public()` kullanilin. Bu, varsayilan olarak koruma saglar ve unutma riskini
  ortadan kaldirir.

---

## 12. CROSS-TENANT AUTH BYPASS ANALIZI

### 12.1 Login

- Email global unique (tum tenant'lar tek `auth.users` tablosu)
- Login'de tenant secimi yok -- email ile kullanici bulunur, tenant JWT'ye konur
- **[BILGI]** Cross-tenant login riski yok cunku email unique

### 12.2 Tenant Izolasyon Kontrolleri

| Islem | Kontrol | Dosya |
|-------|---------|-------|
| `tenant(id)` query | `role !== SUPER_ADMIN && userTenantId !== id` | tenant.resolver.ts:65 |
| `updateTenant` | `role !== SUPER_ADMIN && userTenantId !== id` | tenant.resolver.ts:95 |
| `getThread` | `thread.tenantId !== user.tenantId` | messaging.service.ts:114 |
| `getTicket` | `ticket.tenantId !== user.tenantId` | support.service.ts:145 |
| `getTableData` | `allowedSchemas.includes(input.schemaName)` | tenant-admin.service.ts:566 |
| `getTableSchema` | `allowedSchemas.includes(schemaName)` | tenant.service.ts:710 |

### 12.3 Potansiyel Bypass Noktalari

**[YUKSEK] BULGU-015: SUPER_ADMIN null tenantId ile Her Tenant'a Erisim**
SUPER_ADMIN kullanicilarin `tenantId = null` olmasi tasarim geregi. Ancak bazi
service metotlari `@TenantAdminOrHigher()` decorator'unu kullaniyor ve `@CurrentUser('tenantId')`
ile gelen null degerini direkt kullaniyorlar (ornegin `tenantStats`, `tenantDatabase`).
`null` tenantId ile cagrildiginda beklenmeyen davranis olusabilir.
- **Dosya:** `tenant.resolver.ts:156-158` (`tenantStats` null tenantId alabilir)
- **Oneri:** SUPER_ADMIN icin tenant-specific query'lerde explicit `tenantId` parametresi
  zorunlu tutulsun veya null tenantId kontrolu eklensin.

**[BILGI] OLUMLU-013:** `getTableData()` ve `getTableSchema()` icinde `auth` semasi
acikca dislanmis -- sifre hash'leri, MFA secret'lar gibi hassas verilere tenant
admin'lerin erismesi engellenmis.

---

## 13. AUDIT LOGGING

### 13.1 Kapsam

| Olay | Severity | Loglanir mi? |
|------|----------|--------------|
| LOGIN_SUCCESS | INFO | Evet |
| LOGIN_FAILED (user not found) | WARNING | Evet |
| LOGIN_FAILED_INVALID_PASSWORD | WARNING | Evet |
| LOGIN_BLOCKED_ACCOUNT_LOCKED | WARNING | Evet |
| ACCOUNT_LOCKED | CRITICAL | Evet |
| LOGOUT | - | Hayir |
| REGISTER | - | Hayir |
| INVITATION_ACCEPTED | - | Hayir |
| USER_DEACTIVATED | - | Hayir |
| ROLE_CHANGED | - | Hayir |
| TENANT_CREATED | - | Hayir (sadece event) |

**[ORTA] BULGU-016: Audit Log Kapsamasi Yetersiz**
Sadece login ile ilgili olaylar audit log'a yaziliyor. Kullanici yonetimi,
tenant yonetimi, rol degisiklikleri, davet islemleri loglanmiyor.
- **Dosya:** `audit-log.service.ts`, `authentication.service.ts`
- **Oneri:** Tum guvenlik-kritik islemler (deactivate, role change, tenant create,
  invitation accept, password reset) audit log'a yazilsin.

### 13.2 Log Saklama ve Temizlik

```typescript
@Cron(CronExpression.EVERY_DAY_AT_2AM)
async scheduledLogCleanup(): Promise<void> {
  const retentionDays = configService.get('AUDIT_LOG_RETENTION_DAYS', 90);
  await this.deleteOldLogs(retentionDays);
}
```

**[BILGI]** 90 gun varsayilan saklama suresi. Uyumluluk gereksinimleri icin yeterli mi
degerlendirilmeli (bazi regulasyonlar 1-7 yil gerektirir).

### 13.3 Hata Yonetimi

```typescript
// authentication.service.ts:168-171
} catch (error) {
  // Don't fail the main operation if audit logging fails
  this.logger.error(`Failed to log security event: ${action}`, error);
}
```

**[BILGI] OLUMLU-014:** Audit logging hatalari ana islemi engellemez. Dogru yaklasim.

---

## 14. HTTP GUVENLIK BASIKLIKLARI

### 14.1 Helmet Konfigurasyonu (main.ts:33-58)

| Baslik | Deger |
|--------|-------|
| Content-Security-Policy | Uretimde aktif (strict) |
| Strict-Transport-Security | 1 yil, includeSubDomains, preload |
| X-Content-Type-Options | nosniff |
| X-Frame-Options | DENY |
| Referrer-Policy | strict-origin-when-cross-origin |
| X-Powered-By | Gizli |
| X-XSS-Protection | Aktif |

### 14.2 CORS (main.ts:81-102)

- Uretimde wildcard `*` engellenmis (fail-fast)
- `CORS_ORIGINS` env degiskeni ile explicit origin listesi zorunlu
- Credentials sadece explicit origin'lerde aktif

### 14.3 Validation Pipe (main.ts:62-76)

```typescript
new ValidationPipe({
  whitelist: true,           // Bilinmeyen alanlar siliniyor
  forbidNonWhitelisted: true,// Bilinmeyen alanlarda hata
  transform: true,
  validationError: { target: false, value: false }, // Ic detaylari gizle
  disableErrorMessages: isProduction, // Uretimde validation mesajlari gizli
})
```

**[BILGI] OLUMLU-015:** Kapsamli HTTP guvenlik konfigurasyonu. Whitelist validasyon,
CORS kisitlamasi, helmet basikliklari -- hepsi enterprise seviyesinde.

### 14.4 GraphQL Introspection

```typescript
// app.module.ts:100
introspection: !isProduction
```

**[BILGI] OLUMLU-016:** Uretimde GraphQL introspection kapatilmis. Schema kesfi engellenmis.

---

## 15. VERITABANI GUVENLIGI

### 15.1 SSL Konfigurasyonu (app.module.ts:61-82)

- Uretimde SSL devre disi birakilirsa ve CA yoksa hata verir
- `rejectUnauthorized = true` varsayilan
- CA sertifikasi dosyadan okunabilir

### 15.2 Veritabani Sifresi

- Uretimde `DATABASE_PASSWORD` zorunlu (yoksa hata)
- Gelistirmede `postgres` varsayilan

### 15.3 Connection Pool

```
max: 20, min: 5, idleTimeoutMillis: 30000
```

### 15.4 Schema Izolasyonu

- Auth service `auth` semasini sahiplenir
- Tenant verileri `tenant_*` semalarinda (SchemaManagerService ile yonetilir)
- `synchronize` sadece `DATABASE_SYNC=true` ile aktif

**[BILGI] OLUMLU-017:** Uretimde DB sifresiz calisma engellenmis. SSL konfigurasyonu
MITM korunmasi sagliyor.

---

## 16. TENANT ROLE SERVISI (RBAC)

### 16.1 Yapi

Tenant-scoped roller `tenant_*` schema'larinda saklanir:
- `tenant_roles`: Rol tanimlari (name, level, isSystem, isDefault)
- `tenant_role_permissions`: Panel + resource bazli izinler
- `user_role_assignments`: Kullanici-rol atamasi

### 16.2 Varsayilan Roller

| Rol | Level | Sistem? | Varsayilan? |
|-----|-------|---------|-------------|
| Supervisor | 70 | Evet | Hayir |
| Technician | 50 | Evet | Hayir |
| Feed Manager | 50 | Evet | Hayir |
| Operator | 30 | Evet | Evet |
| Viewer | 10 | Evet | Hayir |

### 16.3 Guvenlik Onlemleri

- Tum CRUD islemleri SERIALIZABLE transaction icinde
- Pessimistic locking (FOR UPDATE) ile race condition onlemi
- Sistem rolleri silinemez, isim/level degistirilemez
- Atanmis kullanicisi olan rol silinemez

**[BILGI] OLUMLU-018:** SERIALIZABLE transaction + pessimistic locking ile rol yonetimi
guclu sekilde korunmus. Concurrent islemlere karsi savunma iyi.

---

## 17. OLAY YAYINI (EVENT BUS)

### 17.1 Yayinlanan Olaylar

| Olay | Tetik |
|------|-------|
| UserRegistered | Self-registration |
| UserLoggedIn | Basarili login |
| InvitationAccepted | Davet kabulu |
| UserInvited | Tenant admin olusturma |
| TenantCreated | Yeni tenant |
| TenantUpdated | Tenant guncelleme |

### 17.2 Guvenlik Notu

**[DUSUK] BULGU-017: Event Icerigi PII Barindirabilir**
`UserInvitedEvent` icinde `email`, `firstName`, `lastName` gibi PII alanlari var.
Event bus (NATS) uzerinden bu veriler diger servislere iletiliyor. NATS sifreleme
durumu bu audit kapsaminda degerlendirilemedi.
- **Dosya:** `tenant.service.ts:258-272`
- **Oneri:** NATS baglantisinda TLS zorunlu kildigindan emin olun. Event payload'larinda
  PII yerine referans ID'ler kullanmayi degerlendirin.

---

## 18. BULGU OZET TABLOSU

| ID | Seviye | Baslik | Dosya |
|----|--------|--------|-------|
| BULGU-001 | ORTA | JWT Secret Rotasyonu Yok | app.module.ts |
| BULGU-002 | DUSUK | Email JWT Payload Icinde (PII) | authentication.service.ts |
| BULGU-003 | YUKSEK | Password Reset Flow Eksik | authentication.service.ts, user.entity.ts |
| BULGU-004 | ORTA | MFA Sadece Entity Seviyesinde, Implement Edilmemis | user.entity.ts |
| BULGU-005 | ORTA | Refresh Token Replay Detection (Family Tracking) Eksik | authentication.service.ts |
| BULGU-006 | DUSUK | Refresh Token Cookie + Body Dual Kanal | auth.resolver.ts |
| BULGU-007 | YUKSEK | Rate Limiter Service Bos (Implement Edilmemis) | rate-limiter.service.ts |
| BULGU-008 | ORTA | Suspended/Cancelled Tenant Kullanicilari Giris Yapabiliyor | authentication.service.ts |
| BULGU-009 | ORTA | Tenant Silme/Data Cleanup Mekanizmasi Yok | tenant.service.ts |
| BULGU-010 | ORTA | Kullanici Hard Delete / Anonimize Yok (GDPR Art.17) | tenant-admin.service.ts |
| BULGU-011 | DUSUK | Invitation Token Brute Force Rate Limit Yok | auth.resolver.ts |
| BULGU-012 | YUKSEK | Privacy Servisleri (data-masking, gdpr-compliance) Bos | privacy/ |
| BULGU-013 | DUSUK | Messaging/Support XSS Input Sanitization Eksik | messaging.service.ts |
| BULGU-014 | ORTA | JwtAuthGuard APP_GUARD Olarak Tanimlanmamis | authentication.module.ts |
| BULGU-015 | YUKSEK | SUPER_ADMIN null tenantId Sorgularda Hatali Davranis | tenant.resolver.ts |
| BULGU-016 | ORTA | Audit Log Kapsamasi Yetersiz (Sadece Login) | audit-log.service.ts |
| BULGU-017 | DUSUK | Event Payload'larinda PII | tenant.service.ts |

**Dagalim:** 4 YUKSEK, 7 ORTA, 5 DUSUK, 18 OLUMLU

---

## 19. OLUMLU BULGULAR OZETI

| ID | Baslik |
|----|--------|
| OLUMLU-001 | JTI + User-Level Token Blacklisting |
| OLUMLU-002 | bcrypt Hash Pattern Regex ile Cift Hash Onleme |
| OLUMLU-003 | Tenant Admin Reset Token SHA-256 ile Hashleniyor |
| OLUMLU-004 | Refresh Token Hash + Rotation + Pessimistic Lock + httpOnly Cookie |
| OLUMLU-005 | Zamanlama Saldirisi Korunmasi (Dummy Hash + Min Duration) |
| OLUMLU-006 | Schema Izolasyonu ve auth Semasi Dislama |
| OLUMLU-007 | Deaktivasyonda Refresh Token Revoke |
| OLUMLU-008 | Invitation Accept TOCTOU Korunmasi (SELECT FOR UPDATE) |
| OLUMLU-009 | PII Alanlari @HideField ile GraphQL'den Gizli |
| OLUMLU-010 | Atomic Increment ile Race Condition Onleme |
| OLUMLU-011 | Tenant Update'de Sinirli Alan Listesi |
| OLUMLU-012 | tenantBySlug Minimal Bilgi Ifsa |
| OLUMLU-013 | auth Schema Tenant Admin'lerden Gizli |
| OLUMLU-014 | Audit Log Hatasi Ana Islemi Engellemez |
| OLUMLU-015 | Kapsamli HTTP Guvenlik (Helmet, CORS, ValidationPipe) |
| OLUMLU-016 | Uretimde GraphQL Introspection Kapali |
| OLUMLU-017 | DB Sifresiz Uretim Engeli + SSL MITM Korunmasi |
| OLUMLU-018 | SERIALIZABLE Transaction + Pessimistic Lock (Rol Yonetimi) |

---

## 20. ONCELIKLI AKSIYONLAR

### Acil (Sprint 1 -- 2 hafta)
1. **BULGU-007:** Rate limiter service'i implement edin (login: IP+email bazli, register: IP bazli)
2. **BULGU-008:** Login flow'a tenant status kontrolu ekleyin
3. **BULGU-015:** SUPER_ADMIN tenantId=null ile tenant-scoped query'lerde guard ekleyin

### Kisa Vade (Sprint 2-3 -- 4 hafta)
4. **BULGU-003:** Password reset flow'u implement edin (forgotPassword + resetPassword)
5. **BULGU-012:** Privacy servisleri implement edin (data export, data delete/anonymize)
6. **BULGU-014:** JwtAuthGuard'i APP_GUARD olarak tanimlayin
7. **BULGU-016:** Audit log kapsamasini genisletin (tum guvenlik-kritik islemler)

### Orta Vade (Sprint 4-6 -- 8 hafta)
8. **BULGU-004:** MFA implementasyonunu tamamlayin (TOTP setup/verify, recovery codes)
9. **BULGU-001:** JWT secret rotation mekanizmasi ekleyin
10. **BULGU-005:** Refresh token family tracking ekleyin
11. **BULGU-009:** Tenant data cleanup (schema drop + data export) mekanizmasi ekleyin
12. **BULGU-010:** GDPR uyumlu kullanici silme/anonimize mekanizmasi ekleyin

---

*Rapor Sonu -- D02 Auth Service Deep Audit*
*Toplam: 78 dosya incelendi, 17 bulgu (4 YUKSEK, 7 ORTA, 5 DUSUK, 1 BILGI), 18 olumlu bulgu*
