# Platform bootstrap Stage-008 linked-sequence review (2026-06-11)

Reviewer: infra-expert + data-expert (Round-2 Adım-0 production deploy zinciri)
Scope: `apps/db-migrate/src/sql/platform-bootstrap/008-least-privilege-hardening.sql`

## INFRA-HIGH-008 — 008'in sahiplik döngüsü kolona-bağlı sequence'larda Postgres tarafından reddediliyor; CI sınıfı yapısal olarak göremiyor

**Severity:** HIGH (production deploy db-migrate fazında ölüyor — full deploy bloke)

**Gözlem:** main@cdee46c80 deploy'u Phase-0 Stage-008'de öldü: `cannot change owner of
sequence "migrations_id_seq" — Sequence is linked to table "migrations"`. Süperuser'la
bile aynı hata: PostgreSQL, serial/identity kolonuna bağlı sequence'ın sahibini doğrudan
ALTER SEQUENCE ile DEĞİŞTİRTMEZ (yalnız tablo ALTER edilince birlikte taşınır).

**Neden CI hiç görmedi:** bootstrap-from-scratch testlerinde 008 koşarken servis şemaları
BOŞ (servis migration'ları Phase-0'dan SONRA koşar) — döngünün ALTER edeceği relation yok.
Sınıf yalnız ÖN-VAR-OLAN veritabanında (production) tetiklenir.

**İkinci kusur (aynı döngü):** sahibi zaten hedef-rol olan relation'lar da ALTER ediliyordu —
en-az-yetkili db_migrate koşusunda, sahibi olmadığı legacy nesnelere çarpma riski.

**Fix:** Tek döngü → üç geçiş: (1) tablolar/partitioned/foreign — bağlı sequence'lar
kaskadla taşınır; (2) view+matview; (3) YALNIZ bağsız sequence'lar (pg_depend deptype
a/i dışlaması). Her geçişte owner-zaten-hedef olanlar atlanır (idempotency — hizalı
veritabanında sıfır ALTER).

**Ampirik doğrulama:** (a) Aynı üç-geçişli mantık production'da operatör-onaylı süperuser
onarımı olarak koştu: 309 legacy süperuser-sahipli relation → 0 (hedef `<svc>_schema_owner`
rolleri + db_migrate üyelikleri 008'in kendi prelude'üyle oluşturuldu). (b) DÜZELTİLMİŞ
008 dosyası production-hizalı DB'de BEGIN/ROLLBACK sarmalında uçtan uca temiz koştu (DO
tamamlandı, kalıcı değişiklik sıfır).

**Operasyonel not:** Production sahiplik onarımı bu PR'dan ÖNCE uygulandı (deploy'u açmak
için); bu PR aynı sınıfın bir daha yaşanmamasını ve taze-olmayan ortamlarda bootstrap'ın
çalışmasını sağlar.
