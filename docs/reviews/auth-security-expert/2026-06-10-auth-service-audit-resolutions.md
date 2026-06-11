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

## Bekleyen bulgular (denetim kayıt defteri)

| ID | Dalga | Durum |
|---|---|---|
| AUDIT-CRITICAL-005 (reuse-detection test kapsamı) | W2 | OPEN |
| SEC-HIGH-001..004, SEC-MEDIUM-001..004 | W2 | OPEN |
| MT-HIGH-003 (TenantStatus SSoT + state machine) | W3.1+W3.3-c | RESOLVED — backend (PR #390); web copies → ORPHAN-MEDIUM-089 |
| DATA-HIGH-001 (transactional outbox adoption) | W3.2+W3.3-a/b | RESOLVED (PR #390 — no auth domain service injects raw EventBus) |
| MT-HIGH-001..002, DATA-HIGH-002..003, MT-MEDIUM-001..002, DATA-MEDIUM-001..002, DATA-LOW-001 | W3 | OPEN |
| PERF-HIGH-001..003, AUDIT-HIGH-009, PERF-MEDIUM-001..003, AUDIT-MEDIUM-015, SEC-LOW-001 | W4 | OPEN |
