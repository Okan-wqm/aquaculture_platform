# Runbook: Feeding v1 emekliliği — G-kapısı kanıtları + cold-storage restore

**Owner:** farm platform team
**İlgili plan:** `docs/plans/farm-mod-l-nde-feeding-s-stemi-keen-hopper` — "Faz 8
Yıkıcı Emeklilik (R-serisi)" bölümü. R2 drop'larının TEK geri dönüş yolu bu
runbook'tur: drop migration'larının `down()`'u veri geri getiremez.

## Amaç

1. R1/R2 alt-PR'ları başlamadan önce G-kapılarının KANITLA doğrulanması.
2. Drop öncesi cold-storage export'un standart üretimi (G3).
3. Felaket durumunda v1 tablolarının arşivden geri yüklenmesi.

## 1. G-kapısı kanıt sorguları

Tüm sorgular tenant şeması başına koşar (`tenant_<uuid>` search_path'i;
operatör `scripts/` altındaki tenant-fanout yardımcılarıyla dolaşır).

### G1 — legacy motor bir tam release "kapalı-ama-kodda" çalıştı

```sql
-- Son release penceresinde YENİ execution üretilmediğinin kanıtı.
-- Beklenen: max_created < son release tarihi (her tenant'ta).
SELECT max("createdAt") AS max_created FROM daily_feeding_executions;
```

Ek koşul: prod ortam değişkenlerinde `FEEDING_LEGACY_ENGINE_ENABLED`
unset ya da `false` (deploy manifest'inden doğrulanır).

### G2 — mobil drain penceresi bitti (≥30 gün)

```sql
-- Son 30 günde drain edilen legacy recordFeeding komutu SIFIR olmalı.
SELECT count(*) AS recent_record_feeding
  FROM farm_mobile_command_receipts
 WHERE "operationType" = 'recordFeeding'
   AND "createdAt" > now() - interval '30 days';
```

Ek koşul: mobil Sync Status telemetrisinde bekleyen `recordFeeding`
kuyruk kaydı yok.

### G4 — finansal mutabakat (backfill penceresi, ±%1)

```sql
-- Batch başına: totalFeedConsumed vs feeding_records toplamı.
SELECT b.id,
       b."totalFeedConsumed"                       AS batch_total,
       COALESCE(SUM(fr."actualAmount"), 0)          AS records_total
  FROM batches_v2 b
  LEFT JOIN feeding_records fr ON fr."batchId" = b.id
 GROUP BY b.id, b."totalFeedConsumed"
HAVING abs(b."totalFeedConsumed" - COALESCE(SUM(fr."actualAmount"), 0))
       > GREATEST(0.01 * b."totalFeedConsumed", 0.001);
-- Beklenen: SIFIR satır. Satır dönerse drop'lar BAŞLAMAZ; sapma
-- inventory-count/mutabakat akışıyla kapatılır.
```

## 2. G3 — cold-storage export üretimi

Drop edilecek yedi yüzeyin dump'ı tenant şeması başına alınır ve hash'lenir:

```bash
TABLES="feed_inventory daily_feeding_executions feeding_protocols \
feeding_programs feeding_program_tanks batch_feed_assignments feeding_tables"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
for T in $TABLES; do
  pg_dump "$DATABASE_URL" --schema="$TENANT_SCHEMA" --table="\"$T\"" \
    --data-only --format=custom \
    -f "feeding-v1-$TENANT_SCHEMA-$T-$STAMP.dump"
done
sha256sum feeding-v1-$TENANT_SCHEMA-*-$STAMP.dump > \
  feeding-v1-$TENANT_SCHEMA-$STAMP.sha256
# Dump + .sha256 dosyaları kalıcı arşive (cold storage) yüklenir;
# hash listesi R2 PR gövdesine yapıştırılır.
```

Not: `batches_v2.protocolId` ve `feeds."feedingTable"` KOLON drop'ları için
ayrıca kolon-düzeyi export alınır:

```sql
\copy (SELECT id, "protocolId" FROM batches_v2 WHERE "protocolId" IS NOT NULL) TO 'batches-protocolId.csv' CSV HEADER
\copy (SELECT id, "feedingTable" FROM feeds WHERE "feedingTable" IS NOT NULL) TO 'feeds-feedingTable.csv' CSV HEADER
```

## 3. Restore prosedürü (felaket senaryosu)

1. Hash doğrula: `sha256sum -c feeding-v1-<schema>-<stamp>.sha256`.
2. Tablo DDL'i arşivdeki release tag'inden gelir (drop migration'ından
   önceki commit'in `1800000000000-Baseline.ts` + ardılları); hedef şemada
   tabloyu O release'in migration zinciriyle yeniden yarat (geçici şema
   önerilir: `restore_tmp`).
3. `pg_restore --data-only --schema=<hedef> --table=<tablo> <dump>`.
4. Veri SALT-OKUNUR incelenir; canlı şemaya geri bağlama YAPILMAZ —
   v2 motoru tek gerçektir, restore yalnız denetim/kurtarma içindir.

## 4. Kapı kaydı

Her R-PR gövdesine şu blok yapıştırılır (kanıt olmadan merge YOK):

```
G1: max(daily_feeding_executions.createdAt) = <değer> (< release <tarih>)
G2: recent_record_feeding = 0 (30g)
G3: sha256 listesi = <link/hash'ler>
G4: mutabakat sorgusu = 0 satır
```
