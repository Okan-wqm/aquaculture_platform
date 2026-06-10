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

---

## Bekleyen bulgular (denetim kayıt defteri)

| ID | Dalga | Durum |
|---|---|---|
| SEC-CRITICAL-001 (register tenantId enjeksiyonu) | W1.2 | OPEN |
| SEC-CRITICAL-002 (boş rate-limit stub'ları) | W1.3 | OPEN |
| AUDIT-CRITICAL-005 (reuse-detection test kapsamı) | W2 | OPEN |
| SEC-HIGH-001..004, SEC-MEDIUM-001..004 | W2 | OPEN |
| MT-HIGH-001..010, MT-MEDIUM-001..008, DATA-LOW-001 | W3 | OPEN |
| PERF-HIGH-001..014, PERF-MEDIUM-001..012, SEC-LOW-001 | W4 | OPEN |
| MT-LOW-001 (tenantBySlug id/status sızıntısı) | W1.2 | OPEN |
