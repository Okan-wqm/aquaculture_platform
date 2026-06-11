# DATA-HIGH-006 kapanışı: platform.create_messaging_partition (SECURITY DEFINER) (2026-06-11)

İki domain ajanı (data-expert + messaging-expert) bağımsız tasarım incelemesi
yaptı; hükümler yakınsadı ve lider tarafından **ampirik probe ile test edilip
DÜZELTİLDİ** (pinli production imajı `timescale/timescaledb-ha:pg16@sha256:b3d0...`,
tek seferlik konteyner, production'a dokunulmadı).

## Ampirik kanıtlar (tasarımı bağlayan)

1. **Şema-CREATE + MEVCUT partition + IF NOT EXISTS → no-op.** Production'ın
   bugün ayakta kalma sebebi (seremoni partition'ları mevcut).
2. **Şema-CREATE ile YENİ partition → `must be owner of table messages`.**
   pg16'da `CREATE TABLE ... PARTITION OF` parent tablo SAHİPLİĞİ ister —
   DATA-HIGH-005 carve-out'u yalnız no-op yolunu açmıştı; ilk gerçek yeni
   partition (aylık cron, ayın 1'i) production'ı yine düşürecekti. Ajan
   tasarımlarının "adanmış role şema-CREATE yeter" varsayımı YANLIŞTI; bu
   yüzden adanmış `messaging_partition_definer` rolü reddedildi (sahip-rol
   üyeliği gerektirecek, "daha dar yetki" gerekçesi buharlaşıyor).
3. **Parent-sahibi role ait SECURITY DEFINER fonksiyon + EXECUTE → çalışıyor.**

## Uygulanan tasarım

- **Stage 010** (`010-messaging-partition-definer.sql`):
  `platform.create_messaging_partition(p_schema, p_table, p_year, p_month)`
  — SECURITY DEFINER, sahip `messaging_schema_owner` (kaynak şemadaki tüm
  messaging parent'larının 008-sahibi), `SET search_path = pg_catalog,
  pg_temp`, tablo allowlist'i (`messages`,`message_receipts`), şema deseni
  (`^(messaging|tenant_[a-f0-9]{16})$`), yıl/ay bant doğrulaması, `%I/%L`,
  ay sınırları server-side (`make_date + interval`), partition adlandırması
  mevcut konvansiyonla birebir. `REVOKE ... FROM PUBLIC` + `GRANT EXECUTE TO
  messaging_service` (tek meşru çağıran).
- **Tenant-şema yetki normalizasyonu:** 010 backfill döngüsü mevcut
  `tenant_*` şemalarında messaging-domain ilişkilerini (`messages`,
  `message_receipts` + `_YYYY_MM` çocukları) `messaging_schema_owner`'a
  re-own eder + şemaya USAGE,CREATE verir. İleri yol: provisioner
  `APPLYING_GRANTS` aşaması (`grantTenantMessagingPartitionAuthority`,
  libs/backend-common/src/database/messaging-partition-privileges.ts) her
  yeni tenant için aynısını yapar. **ORPHAN-HIGH-088'in messaging-partition
  dilimi bu ikiliyle SSOT'a bağlandı** (geniş runtime-DML grant SSOT'u
  kuyruktanki provisioner/compliance yapısal PR'ında kalır).
- **008 carve-out söküldü** (SQL + spec assertion BİRLİKTE — çift yönlü
  kilit: assertion artık `false` bekler + sahip-rol karşı-probu `true`).
- **PartitionManagerService:** raw DDL + JS tarih aritmetiği + ölü
  `already exists` catch'i silindi; tek DDL yüzeyi
  `SELECT platform.create_messaging_partition($1,$2,$3,$4)`; fail-fast boot
  korunur.
- **Invariant:** `tests/invariants/messaging-partition-ddl-authority.spec.ts`
  kaynak-metin bekçisi (raw DDL'in sessiz geri dönüşü CI-kırmızı).
- **Mavi-yeşil geçiş:** yeni imaj yalnız EXECUTE'a bağımlı (ileri-uyumlu);
  db-migrate konteyner restart'larından ÖNCE koşar. Tek artık pencere: eski
  imajın aylık cron'u deploy ortasında ateşlerse (yalnız ayın 1'i) geçici
  alert üretir, konteyner değişiminde kendiliğinden iyileşir.

## DATA-MEDIUM-003 — 009 definer fonksiyonlarında search_path pin'i yoktu

**Severity:** MEDIUM · **Owner:** data-expert · aynı PR'da düzeltildi.

`platform.request_tenant_schema_provisioning` ve
`request_tenant_schema_deletion` SECURITY DEFINER olup `search_path`
pinlemiyordu (klasik privilege-escalation sınıfı; gövdeler tam-nitelikli
olduğundan sömürülebilirlik düşük — yine de zorunlu hijyen). Pin eklendi;
`tenant-schema-provisioner.contract.spec.ts` artık definer-sayısı ==
pin-sayısı invariant'ını taşıyor.

## Kanıt envanteri

- `apps/db-migrate/src/sql/platform-bootstrap/010-messaging-partition-definer.sql`
- `apps/db-migrate/src/sql/platform-bootstrap/008-least-privilege-hardening.sql:127`
- `apps/db-migrate/src/sql/platform-bootstrap/009-tenant-schema-provisioner.sql` (2× pin)
- `libs/backend-common/src/database/messaging-partition-privileges.ts`
- `apps/db-migrate/src/tenant-schema-provisioner.ts` (APPLYING_GRANTS)
- `apps/messaging-service/src/partition/partition-manager.service.ts`
- `apps/db-migrate/src/__tests__/platform-bootstrap.integration.spec.ts`
  (assertion flip + definer smoke + restart-survive uzantısı)
- `tests/invariants/messaging-partition-ddl-authority.spec.ts`
