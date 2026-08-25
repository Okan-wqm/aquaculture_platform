# 100-İşletme Hazırlık Planı v4 — Repo-Doğrulanmış Birleşik Plan

**Durum:** IN-PROGRESS  
**Kapsam:** 100 ACTIVE tenant için telemetry ingest, işleme, saklama, geri yükleme ve silme hazırlığı  
**Tasarım zarfı:** 2.000 MQTT msg/s sürekli; 15.000 msg/s yalnız 5 dakikalık stres  
**Hukuk kapısı:** `LEGAL-001` çözülene kadar bütün raw drop işlemleri kapalı

## 1. Doğrulama sonucu

v3 ile son gönderilen plan aynı tasarım yönünde ve birleştirilebilir. Aşağıdaki düzeltmeler v4’te bağlayıcıdır:

| Konu                   | Nihai karar                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasarım zarfı          | 2.000 MQTT msg/s sürekli; 15.000 msg/s yalnız 5 dakikalık stres. M, E ve R ayrı ölçülür.                                                                                                                                                                                                                                                                                                                                                  |
| 15K hacim hesabı       | 600–750 B ile 5 dakika yaklaşık **3,24–4,05 GB**; 3–3,5 GB kabul edilmez.                                                                                                                                                                                                                                                                                                                                                                 |
| 60 dakika toparlanma   | Yeni 2K ingress sürerken 60 dakikalık backlog 60 dakikada boşalacak; yaklaşık **4K M/s eşdeğeri** ve karşılık gelen E/R kapasitesi kanıtlanacak.                                                                                                                                                                                                                                                                                          |
| Entitlement            | Eski Task 8 olmaktan çıkarılıp **Task 1** yapılacak. Tenant aktivasyonu, queue boyutu ve yük testi için önkoşuldur.                                                                                                                                                                                                                                                                                                                       |
| MQTT PUBACK            | mqtt.js `handleMessage(packet, callback)` kullanılacak. `message` eventi veya `customHandleAcks` dayanıklılık kapısı sayılamaz.                                                                                                                                                                                                                                                                                                           |
| Kaynak kimliği         | Edge’de üretilmiş `sourceEventId` ve üretici zamanı zorunlu. MQTT packet ID olay kimliği değildir. Kararlı kimliği olmayan legacy veri quarantine’e gider.                                                                                                                                                                                                                                                                                |
| Commit→publish zinciri | Generic outbox kullanılmayacak; per-tenant `sensor_ingest_receipts` ve `sensor_event_dispatch` eklenecek. PUBACK, commit ve bütün child JetStream PubAck’lerinden sonra verilecek.                                                                                                                                                                                                                                                        |
| DLQ                    | `AQUACULTURE_DLQ/dlq.>` 72 saat ve ayrı `AQUACULTURE_QUARANTINE/quarantine.mqtt` 24 saat. `24s/72s` hatası düzeltilir.                                                                                                                                                                                                                                                                                                                    |
| Retry                  | Geçici altyapı hataları delivery limitiyle sessizce DLQ’ya düşmez. Sınırlı backoff ve alarm uygulanır; bilinmeyen hata beş gerçek denemeden sonra DLQ’ya gider.                                                                                                                                                                                                                                                                           |
| Sidecar geçişi         | Planlı çift yazım yok. Sürümlü owner-policy, effective epoch ve drain bariyeri kullanılır.                                                                                                                                                                                                                                                                                                                                                |
| Retention              | Hukuk onayına kadar **bütün raw drop işlemleri kapalıdır**. Export/verify/restore çalışabilir.                                                                                                                                                                                                                                                                                                                                            |
| Hukuk bulgusu          | `LAW-001` yerine `LEGAL-001` kullanılır. Repo veya mevcut mevzuat P5Y ham sensör saklama süresini kanıtlamıyor; kaynak yalnızca kayıt yükümlülükleri gösteriyor: [Su Ürünleri Yetiştiriciliği Yönetmeliği](https://www.tarimorman.gov.tr/BSGM/Belgeler/Duyurular/2026/Bing%C3%B6l%20A%C5%9Fa%C4%9F%C4%B1%20Kalek%C3%B6y%20Baraj%20G%C3%B6l%C3%BC/Ek-8%20Su%20%C3%9Cr%C3%BCnleri%20Yeti%C5%9Ftiricili%C4%9Fi%20Y%C3%B6netmeli%C4%9Fi.pdf). |
| Chunk/offset birimleri | Cagg offsetleri `24h/7d/30d`; chunk adayları `1h/6h/24h`.                                                                                                                                                                                                                                                                                                                                                                                 |
| Migration ID           | Sabit `18022...` kullanılmaz. Uygulama anındaki HEAD ve ilgili migration runner kontrol edilerek generator ile benzersiz ID üretilir. Kullanıcının untracked `180210...` dosyasına dokunulmaz.                                                                                                                                                                                                                                            |
| Worktree               | Sabit SHA veya repo içi `.worktrees` kullanılmaz. Güncel `HEAD` üzerinden dış worktree açılır.                                                                                                                                                                                                                                                                                                                                            |

## 2. Kilitli mimari ve ortak sözleşmeler

- Schema-per-tenant `tenant_<16hex>` tek doğruluk kaynağıdır. Kafka, shard/router, shared hypertable ve PgBouncer eklenmez.
- NATS kimliği yalnız cert CN’dir. ACL kaynağı `infrastructure/nats/services.yaml`; üretilmiş `nats.conf` elle değiştirilmez.
- Güvence kapsamı: QoS1, ACTIVE entitlement, sağlıklı diskler ve en fazla 60 dakikalık kesinti. Taşıma at-least-once, iş etkisi veritabanı tekillikleriyle exactly-once olacaktır.
- QoS0, malformed payload, kapasite reddi, kararlı kimliği olmayan legacy veri, cihaz kaybı ve operatör silmesi kapsam dışı olarak ayrı sayaçlanır.
- Backup/restore “sıfır kayıp” değildir; WAL-G için ayrı RPO ≤300 saniye kapısı vardır.
- Her task test-first yürütülür. Her task sonunda affected test/lint, type-check ve format-check; Rust değişikliklerinde fmt/clippy/test çalıştırılır.
- Her düzeltme commit’i ilgili `Closes:` bulgusunu taşır ve aktif branch’e push edilir. Force-push, hook bypass ve kırmızı test commit’i yasaktır.

Önemli yeni sözleşmeler:

```ts
type TelemetryCapacityActivationState =
  | 'PENDING_CAPACITY'
  | 'RESERVED'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'RELEASED'
  | 'EXPIRED';

interface TelemetryCapacityEntitlementChangedEvent extends BaseEvent {
  operationId: string;
  reservationId: string;
  entitlementId: string;
  entitlementVersion: number;
  activationState: TelemetryCapacityActivationState;
  effectiveAt: string;
  capacityEnvelopeVersion: number;
  sustainedIngressMessagesPerSecond: number; // M
  sustainedMetricRowsPerMinute: number; // R
}

type MqttDisposition = 'COMMITTED' | 'RETRY' | 'POISON' | 'NOT_OWNER' | 'ERASED_TENANT';

interface IngressOwnerPolicy {
  tenantId: string;
  version: number;
  owner: 'NESTJS' | 'RUST';
  effectiveEpoch: string;
  state: 'PREPARING' | 'ACTIVE' | 'DRAINING';
}
```

Per-tenant ingest tabloları:

- `sensor_ingest_receipts`: `source_event_id` tekilliği, payload digest, üretici zamanı/sırası ve commit durumu.
- `sensor_event_dispatch`: deterministic child event, subject, payload, PubAck stream/sequence ve dispatch durumu.
- Metric upsert, receipt ve dispatch satırları aynı tenant transaction’ında yazılır.
- Publisher yalnız transaction sonrasında batch publish eder; crash/redelivery pending dispatch’ten devam eder.
- ACK’lenmiş dispatch kayıtları en az yedi gün tutulur; pending kayıtlar hiçbir zaman yaş nedeniyle silinmez.
- Alert, farm projection ve benzeri iş etkileri kendi transaction’larında child event ID tabanlı DB unique constraint taşır.

## 3. Uygulama görevleri

### Adım P — Güvenli başlangıç ve plan kaydı

Güncel `HEAD` üzerinden `/var/aqua-saas-100-tenant-readiness-v4` dış worktree’si ve `feat/100-tenant-readiness-v4` branch’i oluşturulur. Branch/path mevcutsa silinmez; çakışma raporlanır.

Birleşik v4 belge dış worktree’de yazılır. Root worktree’deki bütün untracked dosyalar, özellikle billing migration’ı, aynen korunur. `invariants:test` hedefinin mevcut olduğu kabul edilir ve ilk doğrulama `npx nx test invariants --runInBand` ile yapılır. Plan-only commit push edilir.

### Task 0 — Okuyucu güvenliği, aday kapasite ve monitoring temeli

#### OBS-CRITICAL-003 — Aktif metric reader'lar tenant sınırını atlıyor

- CRITICAL-003 için failing invariant yazılır: aktif sorgularda paylaşılan `sensor.sensor_metrics` ve `sensor.metrics_*` yasaktır.
- `metric-query` ve `time-bucket` public metotları `tenantId` alır; doğrulanmış schema adı ve tenant context kullanır.
- Harici host araçları 2K×30 dakika ve 15K×5 dakika çalışacak şekilde hazırlanır. MQTT wire bytes, broker persistence delta, JetStream stored bytes/event, fan-out E/M, rows/message R/M, heap/index/WAL ve tenant dağılımı ölçülür.
- Task 0’daki hesaplar “candidate sizing” olarak işaretlenir; HIGH-005 ancak Task 6 yük kapılarında kapanır.
- NATS exporter 8222’ye bağlanır; Mosquitto exporter en az yetkili `$SYS` hesabı kullanır. Scrape hedefleri dışarıya açılmaz.
- Observability API’nin mevcut auth guard’ı ile Prometheus scrape credential’ı uyumlu hale getirilir.
- Alertmanager receiver gerçek makbuzla, deadman ise heartbeat kesilmesiyle test edilir.
- Monitoring servislerinin tek kanonik sahibi `docker-compose.monitoring.yml` olur.

**Gate:** tenant-aware reader testleri, ölçüm artefakt şablonları, aktif capacity gate’leri ve alarm makbuzu.

**Rollback:** yeni reader/deploy aktivasyonu kapatılır; veri dönüşümü yapılmadığından geri veri göçü yoktur.

**Alarmlar:** disk/inode/IOPS, scrape-down, broker drop/queue, PubAck reddi, PG pool/timeout ve capacity backlog.

### Task 1 — Entitlement ve kapasite admission

- Admin DB’de sürümlü capacity envelope ve append-only reservation/entitlement ledger oluşturulur.
- Rezervasyon SERIALIZABLE transaction’da envelope satırını kilitler, aktif rezervasyon toplamını kontrol eder ve sonucu `PENDING_CAPACITY` veya rezervasyon olarak kaydeder.
- PENDING artış mevcut ACTIVE entitlement’ı bozmaz.
- Billing, onaylanan entitlement sürümünün immutable snapshot’ını tutar; değişiklik event’i operation ID ile idempotent outbox’tan çıkar.
- Tenant ancak ACTIVE entitlement, tenant hypertable ve cagg post-step tamamlandıktan sonra ACTIVE olabilir.
- M/R kapasitesi olmayan yeni tenant için provisioning çağrısı yapılmaz.
- Admin yüzeyi platform-admin guard, audit ve security event taşır.
- Teknik activation ile hukukça onaylı retention/tier durumu ayrı alanlardır.

**Gate:** dolu zarf testinde yeni tenant PENDING kalır; eski entitlement işlemeye devam eder; atomik rezervasyon concurrency testi geçer.

**Rollback:** yeni entitlement sürümü RELEASED/SUPERSEDED yapılır; önceki ACTIVE sürüm korunur.

**Alarmlar:** envelope kullanım oranı, pending rezervasyon, entitlement drift, activation/outbox gecikmesi.

### Task 2 — PUBACK, writer, receipt/dispatch, DLQ ve erasure

- MQTT ingress deployment-stable zorunlu client ID, `clean:false`, QoS1 ve singleton session owner kullanır.
- `client.handleMessage(packet, callback)` override edilir. Callback yalnız receipt+metric+dispatch commit’i ve bütün child PubAck’lerinden sonra bir kez çağrılır.
- RETRY veya 10 saniyelik absolute deadline durumunda callback çağrılmaz; bağlantı kontrollü kapatılarak persistent session redelivery tetiklenir.
- DB acquire 2s, lock 1s, statement 5s ile sınırlıdır. Aynı callback içinde retry yalnız hata ilk üç saniyede geldiyse ve en az yedi saniye bütçe kaldıysa yapılır.
- Writer `enqueue(): Promise<WriteOutcome>` döndürür; flush ticket snapshot’ı korunur ve bir tenantın hatası diğer tenant waiter’larını reddetmez.
- Metric satırına `source_event_id`, `source_timestamp` ve gerekirse `source_sequence` blue-green tenant migration’ıyla eklenir.
- Upsert sırası `(source_timestamp, source_sequence null-sentinel, source_event_id)` tuple karşılaştırmasıyla yapılır. Eşit kaynak kimliği committed no-op’tur; eski redelivery yeniyi ezemez.
- Edge `sourceEventId` üretir. Kararlı producer zamanı bulunmayan legacy payload quarantine’e gider.
- `AQUACULTURE_DLQ` ve `AQUACULTURE_QUARANTINE` ayrı stream’lerdir. Subject kapsamları çakışmaz.
- Poison doğrudan DLQ/quarantine’e; retryable altyapı hatası sınırlı backoff ile tekrar denemeye; bilinmeyen hata beş gerçek işlem denemesinden sonra DLQ’ya gider.
- Original source yalnız DLQ PubAck’inden sonra ACK edilir. DLQ doluysa original ACK edilmez ve CRITICAL alarm üretilir.
- Replay original stable ID ile publish eder, PubAck bekler ve sonra DLQ mesajını ACK eder.
- Erasure receipt, dispatch, DLQ, quarantine, telemetry subject, MQTT auth/cache ve ilerideki arşiv nesnelerini kapsar. Erased tenant tombstone’u ACK-drop davranışı üretir.

**Gate:** 5 dakika PG kill/reconnect sonrası sıfır eksik source ID, sıfır çift iş etkisi; DLQ PubAck hatasında original ACK yok.

**Rollback:** durable profil yalnız pending=0 iken legacy moda alınabilir; broker queue, receipt/dispatch ve DLQ korunur.

**Alarmlar:** callback deadline, writer queue, pool, redelivery, broker/edge queue, DLQ depth/oldest, replay ve unique-conflict.

### Task 3 — Telemetry stream ve ACL

- Tek route registry `events|telemetry → stream` eşlemesini setup, publish, subscribe ve wildcard yollarında kullanır.
- `SensorReading` ve desteklenen legacy `SensorMetricIngested` `telemetry.<tenant>.*` köküne taşınır.
- Rust sidecar commit sonrası doğrudan canonical `SensorReading` üretir; aynı veriyi tekrar `SensorMetricIngested` olarak yayımlayıp ikinci kez yazdırmaz.
- Bilinmeyen subject root fail-closed olur.
- Telemetry boyutu ölçümle hesaplanır:

  `max_bytes = ceil(E_design × stored_event_p99_bytes × 3600 × 1.20)`

  `max_msgs = ceil(E_design × 3600 × 1.20)`

  `max_age=90m`, `DiscardNew`.

- Durable başına `max_ack_pending=max(10000, ceil(E_i×handler_p99_seconds×1.2))`.
- File-store kapısı bütün EVENTS, TELEMETRY, DLQ ve QUARANTINE stream’lerini içerir:

  `max_file_store ≥ 1.25 × Σ(stream.max_bytes)`.

- Dedicated provisioner CN stream create/update sahibi olur. Uygulama CN’lerinde bare `$JS.API.>` yasaktır; yalnız tam consumer/fetch/info izinleri bulunur.
- Rollout: NATS offline store migration ve `/jsz` doğrulama → stream create → iki ayrı v2 durable ile legacy+telemetry dual-subscribe → tek publisher switch → reconciliation → legacy drain.
- Blind dual-publish yasaktır.

**Gate:** telemetry subscription doğru stream’de durable açar; ACL invariant’ları ve tenant-minute reconciliation geçer.

**Rollback:** route telemetry→dual-subscribe→legacy alınır; yeni stream silinmez ve kontrollü drain edilir.

**Alarmlar:** PubAck rejection, stream utilization, consumer pending/ack-pending, redelivery, tombstone ve registry rejection.

### Task 4 — Rust sidecar restorasyonu ve tek pilot

- TS↔Rust golden fixture `tenant_<16hex>` üretimini kilitler; bilinmeyen veya hatalı schema fail-closed olur.
- rumqttc manual ACK açılır. Pipeline MQTT validate → tenant receipt/batch → tenant transaction → commit → deterministic JetStream publish/PubAck → MQTT ACK şeklindedir.
- Her PG bağlantısında bir kez `pg_temp._sensor_metrics_stage ... ON COMMIT PRESERVE ROWS` oluşturulur.
- Transaction başında `set_config('app.current_tenant', ..., true)`, `search_path=pg_catalog`, stage truncate/COPY ve doğrulanmış schema-qualified upsert yapılır.
- `sensor_ingestion` rolünde yalnız LOGIN/CONNECT/TEMP, tenant schema USAGE ve gereken DML vardır. CREATE SCHEMA ve BYPASSRLS reddedilir. TLS+SCRAM zorunludur.
- Node ve Rust aynı sürümlü ingress owner policy’yi tüketir. Stale/unknown policy mesajı ACK’lemez.
- Güncel policy’de `NOT_OWNER`, yalnız diğer backend ACTIVE ise o session kopyasını ACK-drop eder.
- Handoff: yeni owner PREPARING → eski owner admission durdurur ve source ID drain eder → epoch bariyeri kaydedilir → yeni owner ACTIVE olur. Planlı çift yazım yoktur.
- Gerçek Mosquitto, NATS ve Timescale kullanılan equivalence harness; GHCR image; droplet compose/TOML/cert/resource budget ve honesty invariant tamamlanır.
- Promotion için aynı host/image/config üzerinde üç adet 2K×30 dakika çalışma gerekir: sıfır reconciliation farkı, p99 Node’dan kötü değil ve CPU-seconds/admitted-source en az %20 düşük.

**Gate:** tek pilot tenantta parity %100 ve tek iş etkisi. Genel promotion kararı Task 6 ölçüm kapısında verilir.

**Rollback:** policy NESTJS’e epoch bariyeriyle döner; Rust drain=0 doğrulanıp durdurulur.

**Alarmlar:** policy lag/stale, schema/RLS denial, COPY/commit/PubAck latency, Rust pending ve parity drift.

### Task 5 — Ledger retention ve cagg güvenliği

Task 0 sonrasında Task 2–3 ile paralel yürüyebilir; bütün raw drop yolları kapalı kalır.

- Platform `sensor.telemetry_archive_events` append-only lifecycle ledger’ı `EXPORT_STARTED→EXPORTED→VERIFIED→DROPPED` geçişlerini DB fonksiyonuyla doğrular.
- Runtime roller için direct UPDATE/DELETE yasaktır. Exact tenant/range overlap advisory lock ile engellenir.
- FAILED terminaldir; retry yeni operation ID ve `supersedes_operation_id` ile başlar.
- Normal lifecycle ledger immutable kalır. Tenant erasure için legal-hold kontrolü yapan ayrı privileged fonksiyon; object deletion sonrası tenant bağlantılı ledger verisini siler ve hassas olmayan kanıtı canonical erasure evidence ledger’a yazar.
- Cagg provisioning hypertable transaction’ından sonra autocommit post-step olarak, tenant ACTIVE olmadan önce çalışır.
- Mevcut tenantlar rate-limited RECONCILE edilir.
- `getRefreshStatus(tenantId)` `view_schema` ile filtreler. Refresh tenant ve view allowlist ister, alt kaynak horizonunu aşan pencereyi reddeder.
- Cagg offsets `24h/7d/30d`; chunk adayları `1h/6h/24h`, ölçülmüş 256–512 MiB hedefinden seçilir.
- Raw/cagg reconciliation aynı tenant, range, bucket boundary ve late watermark üzerinden `COUNT(raw)` ile `SUM(sample_count)` karşılaştırır.
- Eski raw Timescale retention job’ları tüm tenantlardan kaldırılır. Servis seviyesinde `sensor_metrics` retention reddedilir ve `timescaledb_information.jobs` entegrasyon testi kullanılır.
- Retention registry ISO-8601 calendar period destekler.
- `P30D/P90D/P365D/P5Y` yalnız PROPOSED ürün değerleridir.
- `TELEMETRY_RETENTION_ENABLED=false` kalır. `LEGAL-001` onaylanmadan raw drop yapılamaz.

**Gate:** doğrulanmamış aralık düşürülemez; doğrudan ledger mutasyonu ve raw retention job invariant’ı geçer.

**Rollback:** export ve retention flag kapalı tutulur; düşürülmüş veri varsa yalnız doğrulanmış Parquet/WAL-G’den döner.

**Alarmlar:** provision failure, refresh lag, raw/cagg drift, lifecycle stall ve unauthorized drop attempt.

### Task 6 — Harici yük, arıza matrisi ve donanım kararları

- 100 ACTIVE entitlement tenant ile harici, çok süreçli 2K×30 dakika test çalışır.
- Artefakt source IDs, M/E/R, rows/message, child IDs, DLQ, iş etkileri ve tenant-minute reconciliation içerir.
- PG 5 dakika kill, sensor-service/NATS/Mosquitto restart, 30 dakika outage, 60 dakika buffer, DLQ replay ve queue’da veri varken tenant erasure test edilir.
- Yeni 2K ingress devam ederken 60 dakikalık backlog en fazla 60 dakikada boşalır. Sistem yaklaşık 4K M/s eşdeğeri ile bunun ölçülmüş E/R karşılığını sürdüremezse gate başarısızdır.
- 15K×5 dakika yalnız stress testidir; OOM/crash olmamalı ve her kabul/red sebebi sayılmalıdır.
- Donanım kapıları: p95 CPU ≤%70, working-set RAM ≤%75, volume ve IOPS ≤%70.
- CPU/RAM başarısızlığı droplet resize; storage/IOPS başarısızlığı ayrı volume ve offline verified NATS store migration dalını açar.
- Raw tablolar FORCE RLS ve uncompressed kalır. Compression yalnız tenant-local cagg/rollup’ta; izolasyon testi, ≥%30 storage faydası ve ≤%10 p99 regresyonu aranır.
- WAL-G scratch restore RPO ≤300 saniye, >P90D cagg, tenant schema ve archive ledger sağkalımını kanıtlar. pg_dump P5Y kanıtı sayılmaz.

**Gate:** sıfır eksik kabul ID, sıfır açıklanamayan drop, sıfır çift etki, p99<5s, recovery/drain ve donanım eşikleri.

**Rollback:** kapasite aktivasyonu durdurulur; resize/volume tamamlanmadan yeni entitlement ACTIVE yapılmaz.

**Alarmlar:** reconciliation farkı, drain ETA, CPU/RAM/IOPS, WAL-G lag/restore ve sidecar parity.

### Task 7 — Tenant-izole cold storage ve restore

- Her tenant için ayrı bucket/policy kullanılır; prefix-only izolasyon yasaktır.
- Exporter, verifier ve restore ayrı kimliklerdir; presign TTL 15 dakikadır.
- Export `REPEATABLE READ READ ONLY`, deterministik PK sırası, transaction snapshot ve WAL LSN kullanır.
- RAW Parquet zorunludur; aggregate tek başına archive sayılmaz.
- Manifest range, row count, min/max, schema version, snapshot, LSN, object key ve SHA-256 içerir.
- Independent verifier kendi kimliğiyle objeyi tekrar okur; schema/count/min/max/hash birebir değilse VERIFIED yazamaz.
- Restore izole, TTL’li scratch schema’ya yapılır; production tablolarına yazma yetkisi yoktur.
- Synthetic P90D–P365D ve >P365D aralıklarında gerçek percentile/waveform sorgusu ve count/hash parity kanıtlanır.
- Erasure her destructive adımdan hemen önce legal hold’u yeniden kontrol eder; pending export’u, presign’i, bucket’ı ve kontrollü ledger bağlantılarını temizler.
- Export backlog 100 tenant × yaklaşık 90 günlük başlangıç hacmi için throttled ve haftalara yayılmıştır.

**Gate:** restore parity tamamlanır. Retention pilotu ancak ayrıca `LEGAL-001` onaylanmışsa açılabilir.

**Rollback:** export/retention flag kapatılır; doğrulanmış nesne ve lifecycle kanıtları korunur.

**Alarmlar:** export backlog, manifest mismatch, policy drift, restore failure, presign misuse, legal-hold veto ve erasure residue.

### Task 8 — Final mimari ve belge kapıları

- Architecture invariant; dependency/import/config/deployment graph’ında Kafka/kafkajs, `KAFKA_ENABLED`, KafkaStreamsService, shard map, PgBouncer ve shared hypertable bulunmadığını doğrular.
- No-op `kafka-streams.service.ts` ve bütün registration/import’ları silinir.
- Aktif sensor SQL’inde shared `sensor.sensor_metrics` yasaklanır.
- Tek tenant schema utility invariant’ı korunur.
- ADR, PROGRESS, retention matrix ve runbook yalnız ölçülmüş artefaktları ifade eder.
- Tam doğrulama: affected test/lint, type-check, format-check, Rust fmt/clippy/test ve `build:all`.
- Finding kapanışları: OBS-CRITICAL-003 (plan CRITICAL-003) Task 0; HIGH-011 Task 1; CRITICAL-001/002 ve HIGH-008 Task 2; HIGH-007 Task 3; CRITICAL-004 Task 4; HIGH-009 Task 5; HIGH-005/006 Task 6; HIGH-010 Task 7.
- `LEGAL-001` çözülmemişse teknik çalışma tamamlanabilir fakat raw retention aktivasyonu ve hukuk iddialı ticari readiness BLOCKED kalır.

## 4. Rollout sırası

```text
P: dış worktree + birleşik plan commit/push
└─ T0: reader + candidate capacity + monitoring
   ├─ T1: entitlement/admission
   │  └─ T2: MQTT/writer/DLQ durability
   │     └─ T3: telemetry stream/ACL
   │        └─ T4: sidecar tek pilot
   └─ T5: ledger/cagg; T2–T3 ile paralel, raw drop kapalı

T1 + T2 + T3 + T4 pilot + T5
└─ T6: dış yük/arıza/donanım kapıları
   └─ T7: cold storage/restore
      └─ retention pilot; yalnız LEGAL-001 de onaylıysa
         └─ kontrollü tenant grupları
            └─ T8 final kapılar
```

## 5. Definition of Done

- 2K×30 dakika harici testte sıfır eksik kabul ID, sıfır reconciliation farkı ve sıfır çift iş etkisi.
- Süregelen 2K ingress altında 60 dakikalık backlog en fazla 60 dakikada boşalır.
- 15K×5 dakika stress çalışmasında crash/OOM yoktur; her mesaj kabul veya açık red sınıfındadır.
- MQTT source ACK, tenant commit ve bütün gerekli JetStream PubAck’leri olmadan mümkün değildir.
- Telemetry ayrı stream’dedir; bare-root NATS yetkisi yoktur.
- Rust ve Node aynı tenant schema, receipt/dispatch ve event kimliği sözleşmesine uyar; handoff tek iş etkisi üretir.
- FORCE RLS raw katmanda korunur; cagg compression kararı ölçüm ve invariant ile aynı PR’dadır.
- Doğrulanmamış veri düşürülmez; cold restore count/hash ve gerçek analitik sorgularla geçer.
- WAL-G RPO ≤300 saniye ve >P90D cagg sağkalımı kanıtlanır.
- Erasure broker, telemetry, DLQ/quarantine, receipt/dispatch, cache, object storage ve kontrollü ledger temizliğini kapsar.
- Hukuk onayı olmadan raw retention flag’i hiçbir tenant için açılmaz.
- Her task rollback, alarm, yeşil test, finding bağlantılı commit ve push ile tamamlanır.
