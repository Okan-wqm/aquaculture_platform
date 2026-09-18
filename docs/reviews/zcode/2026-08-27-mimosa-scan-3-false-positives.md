# Mimosa Derin Güvenlik Taraması — 3/4: Yanlış Pozitif Analizi

**Tarih:** 2026-08-27 · Kaynak tarama: `scan-2026-08-27T11-31-42.404Z-8c8fad3c69f8` (künye: dosya 1)

Bu dosya, manuel kaynak-kod doğrulamasıyla **çürütülen** bulguları sınıf sınıf
gerekçeleriyle kaydeder. Amaç iki yönlüdür: (1) plan aşamasında ölü bulgularla
uğraşmamak, (2) sonraki Mimosa taramalarında bu sınıfların exclude/refütasyon
envanterine hazır olması. Her sınıfta kanıt olarak okunan kaynak konum verilir.

## Birinci-parti HIGH adjudikasyon özeti (19 bulgu)

| Konum                                                                   | Mimosa başlığı             | Karar         | Sınıf |
| ----------------------------------------------------------------------- | -------------------------- | ------------- | ----- |
| `apps/gateway-api/src/proxy/service-proxy.service.ts:419`               | SSRF                       | **ADAY (C1)** | —     |
| `apps/sensor-service/.../provisioning.controller.ts:316`                | kaynak sahiplik bağı yok   | **ADAY (C3)** | —     |
| `libs/backend-common/src/health/standard-health.controller.ts:25`       | komut enjeksiyonu          | ÇÜRÜTÜLDÜ     | FP-1  |
| `apps/gateway-api/src/health/health.controller.ts:17`                   | komut enjeksiyonu          | ÇÜRÜTÜLDÜ     | FP-1  |
| `apps/admin-api-service/src/health/health.controller.ts:25`             | komut enjeksiyonu          | ÇÜRÜTÜLDÜ     | FP-1  |
| `apps/sensor-service/src/ingestion/sensor-metric-writer.service.ts:324` | komut enjeksiyonu          | ÇÜRÜTÜLDÜ     | FP-2  |
| `apps/farm-service/.../cdse-render-admission.ts:46`                     | kod enjeksiyonu (eval)     | ÇÜRÜTÜLDÜ     | FP-3  |
| `apps/auth-service/.../mfa.service.ts:132`                              | zayıf şifreleme            | ÇÜRÜTÜLDÜ     | FP-4  |
| `apps/farm-service/.../maskinporten.service.ts:529`                     | zayıf şifreleme            | ÇÜRÜTÜLDÜ     | FP-5  |
| `libs/event-contracts/src/auth-credential-queries.ts:44`                | hardcoded credential       | ÇÜRÜTÜLDÜ     | FP-6  |
| `libs/event-contracts/src/config-runtime.ts:62`                         | hardcoded credential       | ÇÜRÜTÜLDÜ     | FP-6  |
| `libs/event-contracts/src/tenant-commands.ts:311`                       | hardcoded credential       | ÇÜRÜTÜLDÜ     | FP-6  |
| `libs/event-contracts/src/tenant-commands.ts:324`                       | hardcoded credential       | ÇÜRÜTÜLDÜ     | FP-6  |
| `apps/auth-service/src/database/seed.service.ts:173`                    | findOne idor girişi        | ÇÜRÜTÜLDÜ     | FP-7  |
| `apps/auth-service/src/database/seed.service.ts:184`                    | save path-traversal girişi | ÇÜRÜTÜLDÜ     | FP-7  |
| `apps/auth-service/src/database/seed.service.ts:245`                    | save path-traversal girişi | ÇÜRÜTÜLDÜ     | FP-7  |
| `apps/db-migrate/src/main.ts:791`                                       | query sql-injection girişi | ÇÜRÜTÜLDÜ     | FP-9  |
| `apps/db-migrate/src/main.ts:1182`                                      | sql-injection (1 hop)      | ÇÜRÜTÜLDÜ     | FP-9  |
| `sens-api-gateway/src/scada_server.rs:953`                              | query sql-injection girişi | ÇÜRÜTÜLDÜ     | FP-8  |

## FP-1 — `require()` çağrısı "komut enjeksiyonu" sanıldı (3 bulgu)

`standard-health-controller.ts:22-29`, `gateway health.controller.ts:17`,
`admin-api health.controller.ts:24` içindeki
`require(packageJsonPath).version` / `safeRequireVersion(packageJsonPath)`
yardımcıları, sabit paket adlarıyla (`@nestjs/core/package.json`) çalışır ve
yanıtı HTTP gövdesine koyar. `require` = modül yükleme; `child_process.exec`
değildir, kullanıcı girdisi içermez. Tarayıcı deseni: _çağrı adı benzerliği_.

## FP-2 — Lokal `exec` callback'i `child_process.exec` sanıldı

`sensor-metric-writer.service.ts:319` imzası:
`exec: (sql: string, params: unknown[]) => Promise<unknown>` — bu, çağrıya
`(sql, params) => manager.query(sql, params)` olarak verilen **parametreli SQL
callback'idir** (satır 307, 324). Shell yürütme yok; `resolveTenantSchema`
SSoT doğrulamasından geçer. Tarayıcı deseni: _parametre adı benzerliği_.

## FP-3 — Redis Lua `EVAL` portu JS `eval` sanıldı

`cdse-render-admission.ts:46`: `eval(script: string, numberOfKeys: number, …)`
— `CdseRenderRedisPort` arayüzü, Redis `EVAL` komutunun tipsiz portudur. Lua
script'leri dosya içinde hardcoded sabittir; şablon içine yalnız sayısal
sabitler gider. JS kod enjeksiyonu (CWE-95) değildir.

## FP-4 — HMAC-SHA1 "kırılmış algoritma" sanıldı (TOTP)

`mfa.service.ts:127-134`: RFC 4226 HOTP üretimi `crypto.createHmac('sha1', secret)`
kullanır. SHA1 çarpışma zafiyetleri HMAC'ye taşınmaz; HOTP/TOTP standardının
(RFC 4226/6238) zorunlu algoritması budur. Google Authenticator uyumluluğu
gereğidir.

## FP-5 — RS256 JWT imzalama "zayıf algoritma" sanıldı

`maskinporten.service.ts:520-532`: `jwt.sign(payload, privateKeyPem, { algorithm: 'RS256' })`
— RSA-SHA256, Maskinporten/Mattilsynet entegrasyonunun gerektirdiği standart
imza algoritmasıdır. MD5/SHA1/DES/ECB değildir.

## FP-6 — NATS subject string'leri "hardcoded credential" sanıldı (4 bulgu)

- `auth-credential-queries.ts:44`: `VERIFY_PASSWORD: 'request.auth.verifyPassword'`
- `config-runtime.ts:62`: `STRIPE_SECRET_KEY: 'billing.stripe_secret_key'` (config anahtar **adı**)
- `tenant-commands.ts:311/324`: `RESET_USER_PASSWORD` / `RESET_PASSWORD` subject sabitleri

Bunlar olay yolu/ad çözerler; gizli değer değildirler. Tarayıcı deseni:
_anahtar adındaki "PASSWORD/SECRET" kelimesi_.

## FP-7 — Boot-time env seeding "idor/path-traversal" sanıldı + diller arası zincir hatası

`seed.service.ts:163-202`: `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` env
değişkenlerinden **servis açılışında** bir kez okunur; HTTP isteği kaynaklı
değildir (idor tanımı gereksiz). `userRepository.save()` TypeORM kalıcılığıdır;
Mimosa'nın iddia ettiği taint zinciri `save(sink:path-traversal)` **Rust**
dosyası `scripting/storage.rs:324`'te tanımlı bir sink'e bağlanıyor — TypeScript
çağrısının Rust sink'ine akması analiz motorunun diller arası karıştırmasıdır.

## FP-8 — Bellek içi trend motoru "SQL injection" sanıldı (aynı dil karıştırma)

`scada_server.rs:953`: `engine.query(&params.tag, params.from, params.to)` —
trend engine'in bellek içi sorgu API'sidir; SQL'e dokunmaz. Taint zinciri
TS test dosyası `__tests__/tenant-erasure-target-executor.hooks.spec.ts`'te
tanımlı bir sink'i gösteriyor: kanıt zinciri Rust → TS test eşileşmesi,
gerçek veri akışını temsil etmiyor.

## FP-9 — db-migrate parametreli INSERT "sql-injection" sanıldı

`apps/db-migrate/src/main.ts:791` bölgesi: `queryRunner.query(INSERT … VALUES
($1,…,$8) ON CONFLICT …, [releaseId, gitSha, …])` — tamamen placeholder +
parametre dizisi. Kaynak değerler env'den gelen operatör metaverisi
(`DEPLOY_SHA` vb.) olup istismar modeli zaten içeriden-tehdit. :1182'deki
`runTenantSchemaProvisioner` zinciri de aynı parametreli çalıştırıcıya iner.

## FP-10 (sink toplu refütasyonu) — `audit-log.service.ts:124` sink'i ~200 MEDIUM'un panjesi

Mimosa'nın 227 adetlik "cross-file taint" ailesinin ~200'ü tek sink'te
birleşiyor: _`audit/audit-log.service.ts:124` SQL yürütme_. Dosyanın tamamında
`.query(`, `LIKE`, ham SQL yok (grep kanıtı); kalıcılık
`auditLogRepository.save(entity)` (satır 110) üzerinden parametreli TypeORM
insert'idir. Sink çürütüldüğünde ona akan tüm zincirler statik olarak
kapanır. Aynı gerekçe `aqua-ctl.ts:229` sink'ine akan orta kümeye de
**muhtemelen** uygulanır, ancak o dosya bu oturumda satır düzeyinde
doğrulanmadığından "doğrulanmadı" olarak kayda geçti (dosya 4 listesinde).

## MEDIUM kümesinden çürütülenler

- `seed.service.ts:184/245` taint (FP-7 ile aynı kök),
- `db-migrate main.ts` taint ailesi (FP-9),
- `mongo-sort-injection` ailesi (6+3 bulgu): tamamı minify build
  çıktılarındaki `wrap/canonicalJson` eşleşmelerine akıyor — dosya 4 gürültü
  kümesinde,
- XSS ailesi (`web/modules` build çıktıları, `web/shell` dahil 3 bulgu
  **doğrulanmadı** — dosya 4).

## Yordam notu

Bu refütasyonlar yalnızca **statik okuma** kanıtına dayanır; davranışsal test
(yanıt zamanı, hata zarfı) içermez. C1–C3 adayları (dosya 2) hariç, plan
aşamasında bu dosyadaki kararlar yeniden açılmamalıdır; aksi bir kanıt
gelirse ilgili satır güncellenir.
