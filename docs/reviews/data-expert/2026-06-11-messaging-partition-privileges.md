# Messaging partition yaşam döngüsü × Stage-008 least-privilege çatışması (2026-06-11)

Production açılışında (2026-06-11) ampirik olarak kanıtlanan gerçek tasarım
çatışması: `PartitionManagerService` (apps/messaging-service) bootstrap'ta ve
aylık cron'da `messages` / `message_receipts` için RANGE partition DDL'i
üretir; Stage-008 ise runtime rollerini USAGE+DML'e indirger. PostgreSQL,
`CREATE TABLE IF NOT EXISTS`'te şema CREATE yetkisini VARLIK kontrolünden
ÖNCE denetler (ampirik kanıt: partition mevcutken dahi `permission denied
for schema messaging`) — sonuç: messaging-service crash-loop. CI bu sınıfı
yapısal olarak göremiyordu: from-scratch testte 008 anında şemalar boş,
partition contract e2e'si hardening'siz koşuyor.

## DATA-HIGH-005 — Stage-008 her deploy'da operasyonel-zorunlu messaging CREATE grant'ini geri söküyor

**Severity:** HIGH · **Owner:** data-expert · **Cycle:** 2026-06-11-production-opening

Recovery sırasında `GRANT CREATE ON SCHEMA messaging TO messaging_service`
elle verildi; ancak 008 idempotent olarak her deploy'da
`REVOKE ALL ON SCHEMA %I` + `GRANT USAGE` koşar → bir SONRAKİ deploy
grant'i söker ve production aynı crash-loop'a geri düşer. Elle verilen
grant'in bootstrap SSOT'unda sahibi yoktu.

### Düzeltme (bu PR)

1. `008-least-privilege-hardening.sql`: spec döngüsünde `messaging` için
   açık, gerekçeli carve-out — `GRANT CREATE ON SCHEMA messaging TO
   messaging_service`. Yalnız messaging; WHY bloğu DATA-HIGH-006'ya işaret
   ediyor.
2. `platform-bootstrap.integration.spec.ts` hardening testi:
   `has_schema_privilege('messaging_service','messaging','CREATE') = true`
   assertion'ı + carve-out'un GENİŞLEMEDİĞİNİ kanıtlayan farm karşı-probu.
   DATA-HIGH-006 endgame'i grant'i sökerken bu assertion'ı bilinçli olarak
   false'a çevirecek (tek PR'da SQL + spec birlikte döner).

### Tier sınıfı

Tier-3 (make it detectable) + SSOT: çalışan runtime sözleşmesi bootstrap
SSOT'una taşındı; sökülme sınıfı artık integration testte kırmızı.
Tier-1 nihai hali DATA-HIGH-006'nın definer-fonksiyon refactor'ü.

## DATA-HIGH-006 — PartitionManagerService runtime DDL'i: SECURITY DEFINER endgame

**Severity:** HIGH · **Owner:** messaging-expert · **Deadline:** 2026-06-18

Kalıcı mimari çözüm: partition oluşturma DDL'i runtime rolünden alınıp
`messaging_schema_owner` sahipli `SECURITY DEFINER` fonksiyona taşınır
(search_path sabitlenmiş, yalnız beklenen tablo deseni, ay-aralığı
parametreli); `PartitionManagerService` yalnız `SELECT
messaging.ensure_month_partition(...)` çağırır; runtime rolüne fonksiyon
EXECUTE verilir, şema CREATE grant'i ve DATA-HIGH-005 carve-out'u (SQL +
spec assertion birlikte) sökülür. Tenant-şema partition'ları için de aynı
fonksiyon deseni geçerli olacak.

### Kanıt

- `apps/db-migrate/src/sql/platform-bootstrap/008-least-privilege-hardening.sql:127`
- `apps/messaging-service/src/messaging/services/partition-manager.service.ts`
- Production kanıtı: 2026-06-11 messaging crash-loop → elle grant → sağlıklı
  (ledger: /root/repo-cleanup-20260610/ledger.md)
