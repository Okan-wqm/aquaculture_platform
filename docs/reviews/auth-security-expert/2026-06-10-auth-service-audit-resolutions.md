# auth-service Audit — Çözüm Kayıt Dokümanı (Resolution Log)

Kaynak denetim: `docs/reviews/2026-06-10-auth-service-audit.md` (33 bulgu).
Bu doküman her bulgunun **Sorun → Çözüm → Değişen dosyalar → Doğrulama** kaydını tutar ve her düzeltmeyle AYNI PR içinde güncellenir. Durum makinesi: OPEN → IN-PROGRESS → RESOLVED.

Dalga planı: `/root/.claude/plans/tamam-bulgular-duzeltme-plan-fancy-taco.md` (4 dalga = 4 PR).

---

## AUDIT-CRITICAL-004 — Test kapısı main'de kırmızı (11/16 suite çöküyordu)

- **Durum:** RESOLVED (Wave 1, PR pending)
- **Sorun:** auth-service unit suite'i main üzerinde 11/16 suite, 99/244 test başarısızdı. Üretim kodu refactor edilmiş (token üretimi `TokenService`'e taşınmış, sayaçlar atomik `increment`/`UPDATE…RETURNING`'e geçmiş, getStats SQL aggregation'a dönmüş, reset event'i PII-free v2 olmuş) ama test harness'ları takip etmemişti. Güven zincirinin kökündeki serviste regresyon koruması fiilen sıfırdı.
- **Çözüm (kök neden, assertion zayıflatma YOK):**
  - DI sürüklenmesi: 4 kırık test modülüne eksik provider'lar eklendi (`TokenService`, `MfaService`, `BypassRlsService`, `MobileUserSettings`/`Invitation`/`UserModuleAssignment` repo token'ları).
  - bcryptjs mühürlü namespace: `compare`/`hash` spy-edilebilir `jest.fn` sarmalayıcıları olarak yeniden ihraç edildi (varsayılan davranış = gerçek implementasyon).
  - `refreshToken()` non-hashed yol: transaction mock'u SQL kabul kurallarını (isRevoked=false, expiresAt>now) aynen uygular — passthrough mock negatif-yol testlerini anlamsızlaştırırdı.
  - Paylaşımlı QueryBuilder factory: announcement/messaging/support spec'lerinde `createQueryBuilder` her çağrıda YENİ obje döndürüyordu; test bir instance'ı prime ederken servis başkasını okuyordu. Tek paylaşımlı builder/repo'ya geçildi.
  - Stale sözleşmeler güncel mimariye hizalandı: SQL-agregeli `getStats` (`getRawOne` priming), atomik `increment` assertion'ları, PII-free `PasswordResetRequested` v2 (opak `actionTokenId` + PII yokluğu assertion'ı — DAHA GÜÇLÜ test), blacklist `'user_logout'` reason argümanı, session-limit delegasyon sözleşmesi, entegrasyon akışlarında by-id kullanıcı çözümleme (çift lookup gerçeğine uygun).
- **Kapı onarımı sırasında yakalanan ÜRETİM hataları (ayrı bulgular, aşağıda):** CLAUDE-HIGH-013, CLAUDE-HIGH-014, CLAUDE-HIGH-015, CLAUDE-MEDIUM-012.
- **Değişen dosyalar:** `apps/auth-service/src/modules/authentication/__tests__/{authentication.service,password-reset}.spec.ts`, `modules/tenant/__tests__/tenant-user-management.service.spec.ts`, `modules/tenant/services/user-lifecycle.service.spec.ts`, `modules/{announcement,messaging,support}/__tests__/*.spec.ts`, `migrations/__tests__/1800100000000-RestoreCaseInsensitiveEmailUniqueness.spec.ts` (eski 1781300000000 spec'in yerine).
- **Doğrulama:** `nx test auth-service` → **16/16 suite, 249/249 test YEŞİL**. CI linki PR'da eklenecek.

## CLAUDE-HIGH-013 — Baseline konsolidasyonu `auth.users` e-posta benzersizlik index'ini KAYBETMİŞ (HIGH, veri bütünlüğü)

- **Durum:** RESOLVED (Wave 1, PR pending)
- **Sorun:** `1800000000000-Baseline.ts` squash'ı ne `UNIQUE(email)` ne de `UNIQUE(LOWER(email))` index'ini içeriyordu — arşivlenen `EnforceCaseInsensitiveEmailUniqueness1781300000000` migration'ının kurduğu koruma Baseline'dan yeni kurulan her veritabanında yoktu. Normalizasyonu unutan herhangi bir kod yolu / raw SQL, aynı adrese kimlik doğrulayan mükerrer hesap oluşturabilirdi. Kırmızı migration spec'i tam da bu kaybı yakalıyordu — spec silinmedi, koruma geri getirildi.
- **Çözüm (Tier-1 make-impossible):** Yeni migration `1800100000000-RestoreCaseInsensitiveEmailUniqueness.ts` — duplicate ön-kontrolü (DDL'den ÖNCE, ihlalde operatöre adres listesiyle hard-fail) + `CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key" ON "auth"."users" (LOWER("email"))`. Orijinal timeline'dan geçmiş production DB'lerde no-op (idempotent). `down()` yalnızca index'i düşürür (Baseline durumuna döner; rollback'te kısıt KURMAZ). Davranışsal spec birebir taşındı ve şema-nitelikli SQL'i asserte eder.
- **Değişen dosyalar:** `apps/auth-service/src/migrations/1800100000000-RestoreCaseInsensitiveEmailUniqueness.ts` (+spec), `modules/authentication/entities/user.entity.ts` (yorum işaretçileri yeni migration adına).
- **Doğrulama:** Migration spec 6/6 yeşil; glob-kayıt (`migrations/[0-9]*`) otomatik alır.

## CLAUDE-HIGH-014 — `createTenantUser`, `UserLifecycleService.createUser`'ın satır-satır KOPYASIydı (HIGH, SSoT)

- **Durum:** RESOLVED (Wave 1, PR pending)
- **Sorun:** `TenantUserManagementService.createTenantUser` kullanıcı-yaratma pipeline'ının (tenant doğrulama, e-posta benzersizliği, davet token hash'leme, mobil ayar provisioning, rol ataması) tamamını `UserLifecycleService.createUser` ile birebir DUPLIKE ediyordu. Spec'in belgelediği delegasyon sözleşmesi üretimde kopyala-yapıştır ile değiştirilmişti — iki yaratma yolu, garantili drift.
- **Çözüm (Tier-1):** `createTenantUser` artık ince bir delegasyon facade'ı: tenant varlık guard'ı + `userLifecycleService.createUser(...)`. Tek yaratma yolu. Konstruktöre `UserLifecycleService` enjekte edildi (modül zaten her ikisini sağlıyor; dairesel bağımlılık yok).
- **Not (Wave 3'e route edilen gözlem):** `deleteTenantUser` benzer şekilde inline — tenant domain konsolidasyonu (W3.3) kapsamında lifecycle'a delege edilecek. Plan fazında kayıtlı; sessiz erteleme değil.
- **Değişen dosyalar:** `modules/tenant/services/tenant-user-management.service.ts`.
- **Doğrulama:** `tenant-user-management.service.spec.ts` delegasyon testleri 4/4 yeşil.

## CLAUDE-HIGH-015 — `updateTenant` rol-bazlı alan filtrelemesi YOKTU; resolver yorumu var diye iddia ediyordu (MT-HIGH-001'in Wave-1 dilimi)

- **Durum:** RESOLVED (Wave 1 dilimi; MT-HIGH-001'in saga/DTO-split kısmı Wave 3'te)
- **Sorun:** `tenant.resolver.ts` "filtering is handled inside TenantService.update()" diyordu ama `update(id, input)` tüm input'u `Object.assign` ile yazıyordu — TENANT_ADMIN kendi tenant'ında `plan`/`status`/`maxUsers` mutasyonu yapabilirdi. Ölü `updateTenantSettings` metodu (filtrelemenin aslı) çağrısız duruyordu.
- **Çözüm (Tier-1):** `update(id, input, role)` — SUPER_ADMIN tam alan; diğer roller profil allow-list'i (`name, description, logoUrl, contactEmail, contactPhone, address, settings`) + governance alanlarında loud `ForbiddenException`. `updateTenantSettings` silindi (tek güncelleme yolu, tek `TenantUpdated` emisyon noktası). Resolver rolü geçiriyor; yorum artık doğru.
- **Değişen dosyalar:** `modules/tenant/services/tenant.service.ts`, `modules/tenant/resolvers/tenant.resolver.ts`.
- **Doğrulama:** `tenant-update-consolidation.spec.ts` 5/5 yeşil (rol parametresi + izolasyon + SUPER_ADMIN yolu).

## CLAUDE-MEDIUM-012 — `myModules` ve `getMyMobileSettings` rol kapıları sözleşmeyle çelişiyordu (MEDIUM, ADR-008)

- **Durum:** RESOLVED (Wave 1, PR pending)
- **Sorun:** `myModules` metodunun kendi doc-yorumu ve servis implementasyonu MODULE_USER/MANAGER dallarını desteklerken dekorator `@TenantAdminOrHigher()` idi (ölü dal + modül kullanıcısı kendi modüllerini listeleyemez). `getMyMobileSettings` hiç rol dekoratörü taşımıyordu (örtük, test edilemez minimum-rol sözleşmesi).
- **Çözüm (Tier-1):** backend-common'a `ModuleUserOrHigher()` dekoratörü eklendi (tüm kimlikli platform rolleri, ROLES_KEY metadata ile test edilebilir); her iki self-scoped endpoint'e uygulandı.
- **Değişen dosyalar:** `libs/backend-common/src/decorators/roles.decorator.ts`, `modules/tenant/resolvers/tenant-admin.resolver.ts`, `modules/tenant/resolvers/mobile-settings.resolver.ts`.
- **Doğrulama:** `tenant-admin-resolver-guards.spec.ts` + `mobile-settings-resolver-guards.spec.ts` yeşil.

## SEC-CRITICAL-001 — Public `register` mutation: doğrulanmamış istemci tenantId'si (cross-tenant hesap enjeksiyonu)

- **Durum:** RESOLVED (Wave 1, PR #378)
- **Sorun:** `@Public()` register mutation'ı istemciden gelen `tenantId`'yi hiçbir tenant varlık/ACTIVE/maxUsers doğrulaması yapmadan persist ediyor ve doğrulanmamış e-postaya anında token çifti veriyordu. Anonim bir saldırgan, herhangi bir kurban tenant'ına aktif MODULE_USER hesabı ekleyebilirdi. Yüzey ölüydü: hiçbir gerçek UI kullanmıyordu (shell /register → /login yönlendirir, "invitation-only").
- **Çözüm (Tier-1 make-impossible):** Mutation, DTO (`register.dto.ts`), servis metodu ve `REGISTRATION_ENABLED` bayrağı TAMAMEN KALDIRILDI; üretici/tüketicisi olmayan `UserRegisteredEvent` sözleşmesi de kaldırıldı (BREAKING CHANGE). Kullanıcı yaratma tek sahipli iki sunucu-yönetimli yoldan akar: davet akışı (`acceptInvitation`) ve provisioning saga ilk-admin yolu. Gateway süpürmesi: `SENSITIVE_MUTATIONS`'tan 'register', rate-limit register bucket'ı + env anahtarları + path'leri, tenant-context public-path girdileri kaldırıldı. E2E alias probu `forgotPassword`'a taşındı. Yeni `public-surface-contract.spec.ts` yeniden-ekleme girişimini CI'da kırar.
- **Değişen dosyalar:** `auth.resolver.ts`, `authentication.service.ts`, `register.dto.ts` (silindi), `libs/event-contracts/src/auth-events.ts`, gateway `graphql-alias-limit.plugin.ts` / `rate-limit.guard.ts` / `rate-limit.config.ts` / `tenant-context.interceptor.ts` / `tenant-context.middleware.ts` (+spec'leri), `e2e/tests/security/graphql-limits.spec.ts`, yeni `public-surface-contract.spec.ts`.
- **Doğrulama:** auth-service 17/17 suite (252 test) yeşil; dokunulan gateway spec'lerinde failure seti baseline ile birebir aynı (yeni hata yok); GraphQL contract-drift gate yeşil.

## MT-LOW-001 — `tenantBySlug` public sorgusu iç tenant `id` + `status` sızdırıyordu

- **Durum:** RESOLVED (Wave 1, PR #378)
- **Sorun:** Kimliksiz erişilebilir `tenantBySlug`, slug→UUID hasadı sağlıyordu — SEC-CRITICAL-001 enjeksiyonunu "UUID tahmin et"ten "slug'la sorgula"ya indiren bacak. `status` da tenant yaşam döngüsü durumunu anonim sızdırıyordu.
- **Çözüm (Tier-1):** `TenantPublicInfo`'dan `id` ve `status` kaldırıldı; sorgu yalnız marka bilgisi (name/slug/logoUrl) döner. Exact-keys sözleşme testi yanlışlıkla alan eklemeyi kırar. (Doğrulandı: web/e2e'de hiçbir tüketici bu alanları kullanmıyordu.)
- **Değişen dosyalar:** `tenant.resolver.ts`, `public-surface-contract.spec.ts`.
- **Doğrulama:** exact-keys testi `['logoUrl','name','slug']` asserte ediyor; suite yeşil.

## AUDIT-CRITICAL-006 — YENİ BULGU: gateway-api test gate'i main'de KIRMIZI (17 suite / 254 test örneği)

- **Durum:** RESOLVED (PR #380 — GitHub CI tüm check'ler YEŞİL, 0 hata; commit'ler 657db9630 + 70b291e32 + e16318a69). 21 kırık suite / 254 kırık test örneği → **32/32 suite, 1070/1070 test yeşil**. Onarım sırasında 3 üretim hatası düzeltildi: slow-call circuit-breaker'ın success-yolunda hiç değerlendirilmemesi (ölü özellik), `forceOpen()` kill-switch'inin kayıtsız serviste sessiz no-op olması, 429 yanıtlarında RFC 6585 `Retry-After` HEADER eksikliği + dekoratör metadata şekil doğrulaması; ayrıca error-mapping'de `not null violation` → 400. PR #380 operatör merge'ini bekliyor.
- **Sorun:** Wave-1 doğrulaması sırasında keşfedildi ve temiz baseline'da (Wave-1 değişiklikleri stash'liyken koşularak) doğrulandı: AUDIT-CRITICAL-004 ile aynı sistemik sınıf. Kümeler: AuthGuard DI drift (JwtService provider eksik), ServiceProxy servis-kaydı doğrulama drift'i ('test-service' kayıtsız), bayat ETag spec'i (md5 32-hex bekliyor, üretim sha256 64-hex), TenantIsolationGuard sıkılaşmış tenant-association kontrolleri, ResponseTransform/RequestLogging/CacheControl kümeleri. CI test job'ı artık enforce ediyor (`continue-on-error removed: failing tests must block PR merge`) — kırmızı, gate'in advisory olduğu dönemden birikme. backend-common diff'i gateway-api'yi affected yaptığından Wave-1 PR CI'ını bloklar; bu yüzden önce ayrı `fix(gateway)` PR'ı yeşillenir, Wave-1 rebase eder.

## SEC-CRITICAL-002 — auth-service'te yerel rate limiting yoktu (0-byte stub dosyaları)

- **Durum:** RESOLVED (PR #383, commit f110a8170)
- **Sorun:** `rate-limit/` klasöründe 0-byte stub'lar dururken yorumlar "gateway seviyesinde limitlenir" iddia ediyordu. Gateway bypass'ı veya iç ağdan doğrudan subgraph erişimi `login`, `verifyMfaLogin` (6 haneli TOTP uzayı!), `forgotPassword`, `resetPassword`, `refreshToken` üzerinde SIFIR hız kontrolüyle karşılaşıyordu (ADR-008 ihlali).
- **Çözüm (Tier-1/2):** Yeni platform SSoT modülü `libs/backend-common/src/rate-limit/` — **atomik Lua** `INCR`+koşullu`PEXPIRE`+`PTTL` tek script (GET→parse→SET yarışının kökten kaldırılması; sayaçlar replikalar arası paylaşımlı), HTTP+GraphQL guard, explicit-config modu (`@RateLimit` dekoratörü — her limitli yüzey review'da görünür ve metadata-reflection ile test edilir), kimlik önceliği `özel-id > user > tenant:ip > ip`, RFC 6585 `Retry-After` + `X-RateLimit-*`, **üretimde fail-CLOSED** (Redis'i düşürebilen saldırgan limitsiz credential stuffing kazanamaz), dev'de loglanan-enforcing in-process fallback. auth-service pencereleri: login 5/15dk (hesap-başına e-posta anahtarı — IP rotasyonu işlemez), verifyMfaLogin 5/15dk (challenge-token anahtarı — oturum başına 5 tahmin), forgotPassword 3/saat (e-posta), resetPassword 3/saat, refreshToken 10/5dk. Guard sırası `ServiceIdentity → RateLimit → JwtAuth` (pre-auth yüzeyler korunur). Stub'lar SİLİNDİ.
- **Değişen dosyalar:** `libs/backend-common/src/rate-limit/*` (6 dosya + 2 spec), `tsconfig.base.json` (path), `auth.resolver.ts`, `mfa.resolver.ts`, `app.module.ts`, `rate-limit-contract.spec.ts` (yeni), `apps/auth-service/src/rate-limit/*` (silindi), `tenant-update-consolidation.spec.ts` (command-receipt sözleşmesine yükseltildi).
- **Doğrulama:** backend-common + auth-service 18/18 suite (260 test) yeşil; sözleşme spec'i her pencereyi sabitliyor; GitHub CI PR #383'te.

---

# Wave 2 — Security hardening (PR #385, squash `2dfe96068`)

> Bu bölüm Tier-4 registry-close (2026-06-14) sırasında eklendi: W2 düzeltmeleri PR #385 ile main'e merge'liydi ama resolution log'da per-finding bölüm + registry `closing_commits` yoktu. Her bölüm, kapanış öncesi 18-ajanlı adversarial doğrulama workflow'u + session-lead firsthand teyidiyle grounded.

## AUDIT-CRITICAL-005 — Refresh-token reuse detection (production hashed path) test kapsamı SIFIRDI (W2)

- **Durum:** RESOLVED (PR #385, squash `2dfe96068`)
- **Sorun:** Üretimdeki `HASH_REFRESH_TOKENS=true` reuse-detection yolunun hiçbir katmanda (unit/integration/e2e) testi yoktu — trust-anchor üzerinde sıfır regresyon koruması.
- **Çözüm:** `refresh-token-reuse.spec.ts` (249 satır, 5 senaryo) production hashed yolunu (`HASH_REFRESH_TOKENS=true`) açıkça koşuyor: replay tespiti (401), family-scoped revocation (user-wide değil), access-token blacklist, session revocation, `familyId` taşıyan SecurityEvent emission. Üretim akışı `refreshTokenWithHash → detectRefreshTokenReuse → revokeTokenFamilyOnReuseDetection` (authentication.service.ts:748-850) tamamen wired.
- **Doğrulama:** firsthand-teyitli — spec mevcut (249 satır); W2 squash `2dfe96068` dosyaya dokundu (git show --stat).

## SEC-HIGH-001 — TOTP kodları one-time-use değildi — intra-window replay (W2)

- **Durum:** RESOLVED (PR #385, squash `2dfe96068`)
- **Sorun:** TOTP doğrulaması `lastUsedTimeStep` izlemiyordu; aynı 6-haneli kod pencere içinde (login + step-up) tekrar oynatılabiliyordu.
- **Çözüm (Tier-1, race-proof):** `verifyTOTP` eşleşen time-step'i döndürüyor; `lastUsedTotpStep` kolonu (user.entity.ts:236, migration 1800400000000) koşullu atomik UPDATE ile yazılıyor — yalnız `lastUsedTotpStep IS NULL OR < CAST(:step AS bigint)` olduğunda başarılı (affected=1); replay affected=0 ile reddedilir. Üç MFA yolunun (setup/login/step-up) hepsine uygulandı (mfa.service.ts:309-333).
- **Doğrulama:** mfa.spec replay-reddini sabitliyor; firsthand-teyitli (conditional UPDATE `IS NULL OR < step` + affected check).

## SEC-HIGH-002 — Login not-found dalı malformed bcrypt dummy hash ile karşılaştırıyordu — asimetrik timing (W2)

- **Durum:** RESOLVED (PR #385, squash `2dfe96068`)
- **Sorun:** Kullanıcı bulunamadığında geçersiz bir dummy hash string'i (`$2a$12$dummy.hash...`) ile karşılaştırılıyor ve pepper HMAC atlanıyordu — found/not-found timing farkı hesap-varlığı sızdırıyordu.
- **Çözüm:** `getDummyPasswordHash()` (authentication.service.ts:141-146) `hashPassword(crypto.randomBytes())` ile GEÇERLİ peppered dummy hash üretiyor; not-found dalı bunu found dalıyla aynı `verifyPassword` pipeline'ından (pepper HMAC + bcrypt.compare, password.util.ts:121-148) geçiriyor (line 219). Eski malformed string tamamen kaldırıldı.
- **Doğrulama:** firsthand-teyitli; her iki dal aynı peppered bcrypt yolunu koşuyor → timing simetrik.

## SEC-HIGH-003 — Issued JWT'ler kid header taşımıyordu, JWKS kid yayınlıyordu (W2)

- **Durum:** RESOLVED (PR #385, squash `2dfe96068`; underlying fix `c08d74aaa`)
- **Sorun:** İmzalanan JWT'lerde `kid` header yoktu ama JWKS endpoint `kid` yayınlıyordu — key rotation deterministik tüketilemiyordu (consumer hangi anahtarın doğrulayacağını bilemiyor).
- **Çözüm (Tier-1, make-impossible):** Merkezi `getActiveSigningKid()` SSoT (backend-common, jwt-verification.utils.ts:184-186) HEM token imzalayıcı (token.service.ts:220 `signAsync` keyid) HEM JWKS controller (jwks.controller.ts:62,126) tarafından tüketiliyor — her JWT'nin kid'i yayınlanan JWKS girdisiyle eşleşir, drift yapısal olarak imkansız.
- **Doğrulama:** jwks.controller.spec kid SSoT-match + rotation overlap; firsthand-teyitli.

## SEC-HIGH-004 — JWKS yanıtı kalıcı cache'leniyordu — rotation sonrası TTL/invalidation yok (W2)

- **Durum:** RESOLVED (PR #385, squash `2dfe96068`; underlying fix `c08d74aaa`)
- **Sorun:** JWKS yanıtı process ömrü boyunca cache'leniyordu; key rotation sonrası eski key-set servis ediliyor, yeni-key token'lar JWKS'i erken çekmiş servislerde doğrulanamıyordu.
- **Çözüm:** TTL-bazlı invalidation — `JWKS_CACHE_TTL_MS` (default 5dk), `cacheExpiresAt` ile expiry takibi, request-anında TTL kontrolü (süresi dolunca refresh), in-process TTL ile eşleşen `Cache-Control` header (jwks.controller.ts:29-53,88).
- **Doğrulama:** jwks.controller.spec TTL-expiry senaryosu (fake timers — pencere içi stale kid, sonra yeni kid); firsthand-teyitli.

## SEC-MEDIUM-003 — Refresh reuse revocation per-user idi, per-family değil — familyId kolonu yoktu (W2)

- **Durum:** RESOLVED (PR #385, squash `2dfe96068`; underlying fix `c55748b4c`)
- **Sorun:** Reuse tespitinde tüm kullanıcı token'ları revoke ediliyordu (over-revoke); token soy-zinciri için `familyId` kolonu yoktu, SecurityEvent family-id taşımıyordu.
- **Çözüm:** `familyId` kolonu (refresh-token.entity.ts:38, indexed, migration 1800500000000); reuse-detection family-scoped revocation yapıyor (`{userId, familyId}` koşullu UPDATE, legacy NULL family için `{userId}` fallback — authentication.service.ts:914); SecurityEvent family-id taşıyor (line 949).
- **Doğrulama:** refresh-token-reuse.spec family-scoped revocation + SecurityEvent family-id alanını production yolunda sabitliyor; firsthand-teyitli.

## SEC-MEDIUM-004 — validateToken enforceAccessTokenType'ı atlıyordu — refresh/MFA token'lar valid görünüyordu (W2)

- **Durum:** RESOLVED (PR #385, squash `2dfe96068`; underlying fix `c55748b4c`)
- **Sorun:** `validateToken` introspection sorgusu token tipini zorlamıyordu — refresh/MFA token'lar `valid:true` olarak introspect oluyordu.
- **Çözüm:** `validateToken` (authentication.service.ts:1026) artık `enforceAccessTokenType(payload, logger, isProduction)` çağırıyor (line 1043) — `payload.type !== 'access'` ise UnauthorizedException. Aynı guard jwt-auth.guard.ts:78'de de var (backend-common SSoT, jwt-verification.utils.ts:73-96).
- **Doğrulama:** validate-token.spec access geçer / refresh+MFA reddedilir; firsthand-teyitli.

> **W2 NOT (SEC-MEDIUM-001/002 W2'de değil):** SEC-MEDIUM-001 (tenant-role assign/update role-ceiling + self-target guard) ve SEC-MEDIUM-002 (role-change/user-delete audit fail-closed) W2'de KAPANMADI — W2 kodu bunları gerçekten düzeltmemişti (canlı priv-esc olarak Wave-5 D1 audit'inde tespit edildi). Bunları Wave-5 D1 (PR #447) düzeltiyor; registry close #447 CODEOWNERS merge'inde olacak.

---

## MT-HIGH-003 — Tenant yaşam döngüsünde ARCHIVED/PURGED terminali ve geçiş-yasallığı kontrolü YOKTU (W3.1)

- **Durum:** RESOLVED — backend (PR #390; W3.1 foundation + W3.3-c command-service consolidation; CI yeşil sha 92414ca4 + W3.3-c). **W3.3-c:** provisioning command-service'in kendi drifting yerel `lifecycleTransitionPolicy`'si (machine'le 6 geçişte sapan paralel legality tablosu) tamamen silindi; edge-legality artık tek SSoT `TenantStatusMachine.assertTransition`'a delege ediliyor. Yerel `LIFECYCLE_COMMANDS` haritası YALNIZCA command-authorization (machine edge'lerinin alt-kümesi: hangi komut hangi geçişi sürebilir — ActivateTenant'ın SUSPENDED tenant'ı reaktive etmesini engeller); subset invariant'ı bir architecture testiyle (`lifecycle-commands.spec`) sabitlendi. **Option B (yama değil, doğru model):** PROVISIONING artık gerçek persist edilen bir faz — yeni `BEGIN_PROVISIONING` komutuyla saga `reserve→PENDING → BeginProvisioning→PROVISIONING → ACTIVE`; PENDING→ACTIVE skip'i kalktı, machine katı+dürüst kaldı (gevşetilmedi). FailProvisioning tolerant compensation (PROVISIONING dışından no-op). admin-api saf NATS-client + `begin_provisioning` saga adımı. **Kalan (backend-dışı):** 3 frontend TenantStatus kopyası = ORPHAN-MEDIUM-089 (web codegen-owned). gateway + event tipleme W3.1'de tamamlandı.
- **Sorun:** Tenant statüsü 8 ayrı yerde, 3'ü casing/değer-kümesi olarak uyumsuz kopyalanmıştı (shared-contracts unwired 6 değer; auth/admin 8 değer; gateway lowercase + non-canonical TRIAL/EXPIRED; 3 frontend kopyası). "Bu tenant suspended mı?" sorusunun cevabı modüle göre değişiyordu. GDPR Art-17 purge için temsil edilebilir bir terminal (PURGED) yoktu ve illegal sıçrama (örn. PURGED→ACTIVE) hiç engellenmiyordu. Login bloğu yalnız SUSPENDED+CANCELLED'ı reddediyordu — DEACTIVATED/ARCHIVED/PENDING/PROVISIONING* tenant'lar kimlik doğrulayabiliyordu (latent güvenlik açığı).
- **Çözüm (Tier-1, make-it-impossible):** Canonical 9-değerli `TenantStatus` (+PURGED) + `TenantStatusMachine` `@platform/event-contracts`'ta (wired+her-yerde-tüketilen SSoT; shared-contracts unwired olduğu için orada değil). Makine tek geçiş matrisi: `canTransition`/`assertTransition` (yazımları kapılar), `isLoginAllowed` (fail-closed allow-list — yalnız ACTIVE, slip-through kapandı), `isTerminal` (PURGED). Yeni kural = tek satır tablo düzenlemesi. shared-contracts canonical'ı re-export ediyor. auth entity local enum'u bıraktı, canonical'ı re-export ediyor; login `isLoginAllowed`'a bağlandı. Test mock drift'i (`'active'`≠`'ACTIVE'`) düzeltildi.
- **Değişen dosyalar:** `libs/event-contracts/src/enums/{tenant-status.enum,tenant-status.machine}.ts` (+spec), `libs/event-contracts/src/index.ts`, `libs/shared-contracts/src/enums/tenant-status.enum.ts` (re-export), `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts`, `apps/auth-service/src/modules/authentication/services/authentication.service.ts`, `apps/auth-service/src/modules/authentication/__tests__/authentication.service.spec.ts`.
- **Doğrulama:** event-contracts 217/217 (table-driven makine spec'i her legal/illegal çifti + login allow-list + terminallik + matris tamlığını sabitliyor); auth-service 287/287 (her non-ACTIVE statünün login'i blokladığını sabitleyen it.each). GitHub CI PR #390'da.

---

## DATA-HIGH-001 — Auth domain event'leri raw fire-and-forget event-bus ile yayınlanıyordu, durable garanti yoktu (W3.2)

- **Durum:** RESOLVED (PR #390 — W3.2 outbox altyapısı + W3.3-a/b ile yapısal politika tamamlandı; CI yeşil sha 013076226 + 780e0c0e + 883bbda9). Artık **HİÇBİR auth domain servisi raw `EVENT_BUS` enjekte etmiyor** — durable state-change event'leri (UserDeleted, TenantStatusChanged, first-admin UserInvited) `auth_outbox`'a yazma transaction'ı içinde enqueue ediliyor; audit-log-backed telemetri + `createUser` non-transactional olduğu için (ORPHAN-HIGH-090) henüz durable-olamayan user-lifecycle UserInvited yalnızca allowlisted `BestEffortEventPublisher` üzerinden geçiyor. **W3.3-a:** ölü `tenant.service` lifecycle/create method'ları (raw publish'lerin taşıyıcısı) tamamen silindi (MT-HIGH-001/002). **W3.3-b:** `tenant-provisioning-command.service` raw event-bus'tan çıkarıldı — lifecycle geçişleri tek emission noktasından (transitionTenantStatus) TenantStatusChanged, first-admin createTenantAdmin'in receipt-tx'i içinde UserInvited enqueue ediyor (atomik). Kalan tek best-effort UserInvited = ORPHAN-HIGH-090 (ayrı izleniyor).
- **Sorun:** Auth domain servisleri durumu değiştiren event'leri (UserDeleted, UserInvited, profil/parola sinyalleri, tenant yaşam döngüsü) `eventBus.publish()` ile fire-and-forget yayınlıyordu. DB yazımı commit olup event NATS'a ulaşmadan process ölürse, yayın kaybı kalıcı: downstream servisler (messaging/hr/farm/sensor) tutarsız kalır. En kritik vektör UserDeleted — kaybı GDPR Art-17 cross-service silmeyi hiç tetiklemez, kişisel veri downstream'de kalıcı olarak kalır (dual-write tutarsızlığı).
- **Çözüm (Tier-1/Tier-2):** `auth_outbox` tablosu + `AuthOutboxModule` (`OutboxModule.forFeature`, `@Global`) + `@SourceOnlyMigration` (messaging-outbox şablonu). İki yönlü yapısal politika: durable event'ler `OutboxPublisher.enqueue(event, manager)` ile yazma transaction'ı **içinde** (atomik commit, dual-write kaybı imkansız); audit-log-backed/platform-scoped telemetri `BestEffortEventPublisher` allowlist'i üzerinden (lossy-kabul = açık, reviewable, allowlist dışı event throw eder → durable-outbox'a zorlar). Raw `@Inject('EVENT_BUS')` auth domain servislerinden yapısal olarak kaldırılıyor.
  - **UserDeleted → DURABLE:** gdpr-compliance, erasure transaction'ı içinde enqueue — UserDeleted ile anonimleştirme atomik commit, GDPR cross-service tetikleyici kaybı imkansız.
  - **UserProfileUpdated/UserPasswordChanged** (account.service), **UserLoggedIn + PasswordReset{Requested,Completed}** (authentication.service) → BestEffortEventPublisher (audit log = durable SoT).
  - **UserInvited** (user-lifecycle + tenant-user-management) → BestEffortEventPublisher (invitation row = durable kayıt; kayıp event admin'in pending davetiyeyi görüp yeniden göndermesiyle kurtarılabilir, veri-kaybı vektörü değil). Henüz durable DEĞİL: `createUser` non-transactional dual-write (**ORPHAN-HIGH-090**) — durable upgrade önce user-creation akışının tek transaction'a sarılmasını gerektiriyor.
- **Değişen dosyalar:** `apps/auth-service/src/outbox/{auth-outbox.entity,auth-outbox.module,best-effort-event-publisher}.ts` (+spec'ler), `apps/auth-service/src/migrations/1800600000000-CreateAuthOutboxTable.ts`, `apps/auth-service/src/privacy/gdpr-compliance.service.ts` (+spec), `apps/auth-service/src/modules/authentication/services/{account,authentication}.service.ts`, `apps/auth-service/src/modules/tenant/services/{user-lifecycle,tenant-user-management}.service.ts` (+spec'ler).
- **Doğrulama:** auth-service **303/303 test yeşil** (best-effort allowlist it.each + durable-required event'leri REFUSES eden it.each + gdpr UserDeleted'ın outbox+tx-manager ile enqueue edildiğini sabitleyen spec). GitHub CI PR #390 (sha 013076226 + 780e0c0e). `tenant.service` taşıması W3.3'te tamamlanınca RESOLVED'e geçecek.

---

## MT-MEDIUM-002 — `auth.tenants.farm_count` / `sensor_count`: SSoT'su olmayan, hep-0 denormalizasyon (W3.4)

- **Durum:** RESOLVED (PR #390 — W3.4). Stale denormalizasyon kolonları `auth.tenants`'tan kaldırıldı; admin-api gerçek sayıları okuma-anında **kaynak-tablolardan** (`tenant_<uuid>.farms` / `.sensors`) hesaplıyor.
- **Sorun:** `auth.tenants` `farm_count` / `sensor_count` kolonlarını taşıyordu ama **hiçbir yazıcı bunları güncellemiyordu** — her provisioning yolu 0 yazıyor, tenant kendi şemasında farm/sensor oluşturdukça hiçbir şey reconcile etmiyordu. admin-api tenant-detail resource-usage görünümü bu kolonları okuyup kalıcı-0 bir kullanım rakamı gösteriyordu (canlı şemaya karşı doğrulandı: hep 0). `user_count`'tan farklı olarak (auth user-creation anında bakımlı), farms/sensors per-tenant `tenant_<uuid>.farms`/`.sensors` tablolarının sahipliğinde — auth bunları cross-service event tüketmeden bakamaz.
- **Çözüm (Tier-1: doğru SSoT'yu yapısal kıl):** sahip per-tenant tablolar tek doğru kaynak. Migration `auth.tenants`'tan stale denormalizasyonu düşürüyor (`DROP COLUMN IF EXISTS` → idempotent, replay no-op; `-- DESTRUCTIVE:` marker + pg_dump/ops stage-gate). admin-api `TenantDetailService.countTenantResource()` ile gerçek sayıyı okuma-anında hesaplıyor: önce `information_schema` varlık-kontrolü (provisioning'i tamamlanmamış tenant / SUPER_ADMIN pseudo-tenant = 0 kaynak, hata değil), sonra `COUNT(*)` — auth user-stats için zaten kullandığı aynı cross-schema analitik deseni. Hiçbir hata yutulmuyor (tablo eksikliği fail-loud değil, kontrollü 0). Entity alanları + her iki servisteki provisioning yazıcıları + test fixture'ları (caller-update) temizlendi.
- **Değişen dosyalar:** `apps/auth-service/src/migrations/1800900000000-DropTenantFarmSensorCounts.ts` (yeni), `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts`, `apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts`, `apps/admin-api-service/src/tenant/entities/tenant.entity.ts`, `apps/admin-api-service/src/tenant/services/{tenant-detail,tenant-provisioning-workflow}.service.ts`, `apps/admin-api-service/src/tenant/__tests__/{tenant-api.integration,tenant-provisioning.service}.spec.ts`.
- **Doğrulama:** migration-sql-lint geçti (R1 marker + IF EXISTS idempotency); type-check her iki servis temiz; canlı DB'de çift-çalıştırma idempotency kanıtlandı (residual 0); gerçek-kaynak `COUNT` `tenant_<uuid>.farms`/`.sensors`'a karşı çalışıyor; `tenant-api.integration.spec.ts` PASS; diff-lint değişen dosyalarımda temiz (`countTenantResource` generic-typed query, cast yok). Reader düşürmeden önce 2-3× doğrulandı — kör drop değil, kaynak-tablo SSoT'su.

---

## MT-MEDIUM-001 — `PlanTier` non-ordinal + no `planLevel` JWT claim + `TRIAL`/`isTrialActive` dual representation (W3.4)

- **Durum:** RESOLVED (PR #390 — W3.4, iki commit: ordinal + JWT claim, sonra TRIAL collapse).
- **Sorun:** Üç ayrı kusur: (1) `TenantPlan` sırasız string enum'du — "en az PROFESSIONAL" tarzı tier-gating her callsite'ta ad-hoc bir rank map gerektiriyordu (drift vektörü). (2) JWT hiçbir plan-tier sinyali taşımıyordu — her tier kontrolü gateway'de request-başına tenant lookup demekti. (3) Trial-lik ÜÇ şekilde temsil ediliyordu: `plan === TRIAL`, stored `is_trial_active` boolean, ve `trialEndsAt` — ve bunlar drift ediyordu (canlı DB'de is_trial_active=false ama trialEndsAt set olan tenant var). En kötüsü: entity'nin `isOnTrial()` helper'ı `plan === TRIAL`'a kapı koyuyordu, ki canlı veride SIFIR satır eşleşiyor (tenant'lar gerçek tier'da trial yapıyor, plan='trial' değil) — yani her aktif trial sessizce "trial değil" olarak raporlanıyordu (latent bug).
- **Çözüm (Tier-1):**
  - **Ordinal SSoT:** `PLAN_LEVEL: Record<TenantPlan, number>` (`@platform/event-contracts`) — FREE/TRIAL=0, STARTER=1, PROFESSIONAL=2, ENTERPRISE=3. Tip-exhaustive (plan eklemek ama rank'lamamak compile error) + `planLevel()`/`planMeetsMinimum()`. TRIAL, FREE-eşdeğeri rank'lanır çünkü trial bir STATE'tir (trialEndsAt'tan türer), paid tier değil — plan string'i asla paid-tier minimum'u sağlamaz.
  - **JWT claim:** `token.service` çözülen ordinal'i opsiyonel `planLevel` claim'i olarak access-token'a basar; `resolveTenantPlanLevel` mevcut module+permission read'leriyle **parallel** koşar (tek Promise.all, üçüncü serial round-trip değil); tenant'sız platform hesapları (SUPER_ADMIN) için omit edilir. Verify-side gateway JwtPayload eşleşen opsiyonel alanı kazanır.
  - **TRIAL collapse:** `trialEndsAt` tek kaynak. `isOnTrial()`/`isTrialExpired()` yalnız trialEndsAt'tan türer (plan===TRIAL kapısı silindi — latent bug fix). auth entity'de `isTrialActive` derived getter (GraphQL @Field korunur, şema değişmez); admin-api read-replica entity'den TAMAMEN kaldırıldı (tenant-detail.service trialEndsAt'tan inline türetir — read-replica olmayan kolonu SELECT edemez). Stored `is_trial_active` kolonu drop edildi (idempotent migration). `ReserveTenantCommand`'dan redundant `isTrialActive` input'u + provisioning yazıcıları (auth handler, admin workflow ×3) kaldırıldı — command yalnız trialEndsAt taşır.
- **Değişen dosyalar:** `libs/event-contracts/src/enums/tenant-plan.enum.ts` (+spec), `libs/event-contracts/src/tenant-commands.ts`, `apps/auth-service/src/modules/authentication/services/token.service.ts` (+spec), `apps/gateway-api/src/types/index.ts`, `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts` (+spec), `apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts`, `apps/auth-service/src/migrations/1801000000000-DropTenantIsTrialActive.ts` (yeni), `apps/admin-api-service/src/tenant/{entities/tenant.entity,services/tenant-detail.service,services/tenant-provisioning-workflow.service}.ts` (+ tenant.integration/tenant-provisioning spec fixture'ları).
- **Doğrulama:** tenant-plan.enum.spec (7) ikinci-tanık ordinal matrisi + gating semantiği; token.service.spec (3) claim include/omit/0-fallback; tenant.entity.spec (5) trial türetme + **bug-fix regresyon guard'ı** (STARTER + future trialEndsAt → isOnTrial=true); lifecycle-commands (16) + tenant.integration (28) + tenant-api.integration (36) yeşil (regresyon yok); migration-sql-lint + canlı DB idempotency (residual 0); auth+admin+event-contracts type-check temiz. **is_trial_active full cross-service drop** operator kararıyla (Tam drop now) yapıldı. (`DATA-LOW-001` — trialEndsAt'ı billing.subscriptions projeksiyonu yapma — ayrı, hâlâ açık.)

---

## DATA-LOW-001 — `auth.tenants` subscription kolonları billing SSoT'sini reconciliation'sız kopyalıyordu (W3.4)

- **Durum:** RESOLVED (PR #390 — W3.4, cross-service event-driven projeksiyon: contract + billing emit + auth consumer + NATS authz).
- **Sorun:** `auth.tenants` `plan` / `trialEndsAt` / `subscriptionEndsAt` kolonlarını taşıyor — bunlar billing.subscriptions'ın (abonelik durumunun SSoT'su) bir kopyası. Hiçbir reconciliation yolu yoktu: provisioning anında set ediliyorlardı, sonra billing tarafında plan değişimi / trial bitişi / iptal olduğunda auth kopyası **drift ediyordu**. `plan`, MT-MEDIUM-001 `planLevel` JWT claim'ini beslediği için stale plan = yanlış tier-gating.
- **Çözüm (Tier-2: olay-güdümlü tek-yönlü projeksiyon):** billing tam abonelik durumunu taşıyan bir tenant-facing event emit ediyor; auth onu tüketip kendi kopyasını billing'e aynalıyor.
  - **Contract:** `TenantSubscriptionChangedEvent` opsiyonel additive `trialEndsAt` / `subscriptionEndsAt` / `subscriptionStatus` alanlarıyla zenginleştirildi (eski producer'lar geçerli kalır; JSON Schema nullable-date dalı + alanlar; coverage fixture'ı taşıyor).
  - **billing emit (SSoT yayını):** `change-subscription-plan` (plan değişimi — birincil drift + JWT-relevant) ve `cancel-subscription` (status→cancelled + endDate) handler'ları, kaydedilmiş subscription'dan (planTier / status / trialEndDate / endDate) tam durumu okuyup `TenantSubscriptionChanged` co-emit ediyor (fail-soft, mevcut SubscriptionUpdated/Cancelled emit'leri gibi — publish hatası abonelik değişimini rollback etmez). Expire (scheduler) yalnız status değiştirir; auth subscription-status kolonu saklamadığı + endDate zaten change/cancel anında projekte edildiği için ek emit gerektirmez.
  - **auth consumer (projeksiyon):** yeni `TenantSubscriptionProjectionHandler` `onModuleInit`'te `subscribeWildcard('TenantSubscriptionChanged', this)` (platform-genelindeki yerleşik desen) ile abone oluyor; `handle()` yalnız event'in taşıdığı alanları `auth.tenants`'a yazıyor (tanımsız bırakılanı atlar), bilinmeyen plan'ı projekte etmez (fail-loud log), geçersiz tenantId'yi reddeder (cross-tenant yazımı önler), affected=0'da throw etmez. Tek-yönlü — billing'e asla geri yazmaz.
  - **NATS authz (ADR-015):** `services.yaml`'a billing publish `AQUACULTURE_EVENTS.TenantSubscriptionChanged.>` eklendi + `nats.conf` regen edildi (auth zaten `AQUACULTURE_EVENTS.>` wildcard ile subscribe ettiği için auth değişikliği gerekmedi).
- **Değişen dosyalar:** `libs/event-contracts/src/{tenant-events.ts,schemas/tenant-events.schema.ts}` (+spec), `apps/auth-service/src/modules/tenant/event-handlers/tenant-subscription-projection.handler.ts` (yeni, +spec), `apps/auth-service/src/modules/tenant/tenant.module.ts`, `apps/billing-service/src/billing/handlers/{change-subscription-plan,cancel-subscription}.handler.ts`, `infrastructure/nats/services.yaml`, `infrastructure/docker/nats/nats.conf`.
- **Doğrulama:** tenant-events.schema.spec (19) projeksiyon alanlarını kabul ediyor (nullable-date dahil); `tenant-subscription-projection.handler.spec` (6) — subscribe-on-boot, plan+trial+sub-end projeksiyonu, explicit-null trial, unknown-plan skip-but-project-dates, invalid-tenantId refüze, affected=0 no-throw; auth + billing + event-contracts type-check temiz; billing handler'larının pre-existing test failure'ları (`repository.create` mock eksiği) STASH ile pre-existing + quarantined (billing-service affected-target-policy) doğrulandı — co-emit regresyon değil.

---

## Bekleyen bulgular (denetim kayıt defteri)

| ID | Dalga | Durum |
|---|---|---|
| AUDIT-CRITICAL-005 (reuse-detection test kapsamı) | W2 | RESOLVED (PR #385 — production hashed-path reuse spec, 249 satır) |
| SEC-HIGH-001..004 (TOTP one-time-use, login timing, JWT kid, JWKS TTL) | W2 | RESOLVED (PR #385, squash 2dfe96068) |
| SEC-MEDIUM-003..004 (refresh familyId, validateToken access-type) | W2 | RESOLVED (PR #385, squash 2dfe96068) |
| SEC-MEDIUM-001..002 (role-ceiling/self-target guard, fail-closed audit) | W5-D1 | RESOLVED on branch (PR #447 CLEAN, CODEOWNERS merge bekliyor) — registry close #447 merge'inde |
| MT-HIGH-003 (TenantStatus SSoT + state machine) | W3.1+W3.3-c | RESOLVED — backend (PR #390); web copies → ORPHAN-MEDIUM-089 |
| DATA-HIGH-001 (transactional outbox adoption) | W3.2+W3.3-a/b | RESOLVED (PR #390 — no auth domain service injects raw EventBus) |
| MT-HIGH-001..002 (dead sync-provisioning path + unsafe update) | W3.3-a | RESOLVED (PR #390, 883bbda9) |
| DATA-MEDIUM-001 (JSON Schema validators, NATS trust boundary) | W3.4 | RESOLVED — 13 tenant + 10 auth events (23) validated; coverage specs green |
| DATA-HIGH-003 (AuthSchemaBootstrapService — un-versioned schema writer) | W3.4 | RESOLVED — runtime DDL already gone (no-DDL guard); redundant with SchemaDriftModule, deleted |
| DATA-HIGH-002 (timestamp → timestamptz) | W3.4 | RESOLVED — 27 auth cols converted (migration + entities); empirically verified vs live DB |
| DATA-MEDIUM-002 (tenantId nullability) | W3.4 | RESOLVED — invitations.tenantId NOT NULL; refresh_tokens.tenantId stays nullable (all 317 NULL rows are SUPER_ADMIN, documented exception); broad camelCase/snake_case rename deliberately out of scope (cosmetic, high-risk) |
| MT-MEDIUM-002 (unmaintained farm_count/sensor_count denormalization) | W3.4 | RESOLVED — dropped from auth.tenants; admin-api counts real-time from tenant_<uuid>.farms/.sensors (source-of-truth tables) |
| MT-MEDIUM-001 (PlanTier ordinal + planLevel JWT claim + TRIAL/isTrialActive collapse) | W3.4 | RESOLVED — PLAN_LEVEL SSoT + planLevel claim + trial derived from trialEndsAt (is_trial_active dropped) |
| DATA-LOW-001 (auth.tenants subscription columns vs billing SSoT) | W3.4 | RESOLVED — event-driven projection: billing emits TenantSubscriptionChanged on plan-change/cancel, auth TenantSubscriptionProjectionHandler mirrors plan/trialEndsAt/subscriptionEndsAt |
| PERF-HIGH-001..003, AUDIT-HIGH-009, PERF-MEDIUM-001..003, AUDIT-MEDIUM-015, SEC-LOW-001 | W4 | OPEN |
