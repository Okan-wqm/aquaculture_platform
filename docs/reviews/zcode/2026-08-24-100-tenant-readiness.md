# 100 Tenant Readiness v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 100 tenant için 2K MQTT msg/s sürekli üretim zarfını; 60 dakikalık
kesinti tamponu, tenant izolasyonu, ölçülebilir veri dayanıklılığı, doğrulanmış
retention/cold-storage zinciri ve ölçüm kapılı Rust sidecar promotion ile
kanıtlamak.

**Architecture:** Schema-per-tenant ve NATS JetStream korunur. MQTT, JetStream
event ve PostgreSQL metric satır hızları ayrı kapasite eksenleri olarak
yönetilir; tenant telemetri hakkı admin tarafından onaylanan billing
entitlement'ından gelir. Hot telemetry tenant şemalarında kalır, P90D sonrasına
uzanan sözleşmelerde RAW Parquet tenant bucket'ına aktarılır ve yalnız
verify edilmiş zaman aralıkları PostgreSQL'den düşürülür.

**Tech Stack:** Nx, Node.js 20+, NestJS, mqtt.js, NATS JetStream, PostgreSQL,
TimescaleDB, Redis, Mosquitto, MinIO, Prometheus/Alertmanager, Rust,
rumqttc, tokio-postgres ve async-nats.

**Spec:** docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#repo-kanitli-dogrulama

**Status:** APPROVED PLAN — implementation started 2026-08-24 (six amendments applied).

**Date:** 2026-08-24

> **Amendment set (2026-08-24, kabul edilmiş):** (1) Entitlement Task 0'dan
> çıkarıldı → paralel Task 8; Task 1–3 entitlement'ı beklemez. (2) Retention tier
> tablosu LEGAL-HIGH-001 hukuk kapısına bağlandı. (3) Sabit worktree SHA'sı güncel HEAD
> ile değiştirildi; dosya/hedef doğrulamaları eklendi. (4) RETRY ve DLQ-dolu
> tasarım notları eklendi. (5) GHCR workflow, capacity-check sidecar görünürlüğü,
> NATS store_dir göçü ve mosquitto queue formülü geri eklendi. (6) 2K msg/s zarfı
> kilitli karar olarak işlendi (kullanıcı onayı 2026-08-24).

## Global Constraints

- Mimari değişmez: schema-per-tenant, NATS, cert-CN identity; Kafka, shard/router,
  shared telemetry hypertable ve PgBouncer eklenmez.
- Üretim zarfı 2K MQTT msg/s toplam sürekli yüktür. 15K msg/s yalnız 5 dakikalık
  stres testidir ve 60 dakikalık backlog taahhüdü değildir. **Kilitli ürün kararı
  (kullanıcı onayı 2026-08-24)** — tüm disk/tampon boyutlandırması buna bağlıdır.
- Sıfır-kayıp ifadesi yalnız aktif entitlement içindeki QoS1 mesajları, sağlıklı
  diskler ve en fazla 60 dakikalık outage için geçerlidir. Backup restore için
  ayrı WAL-G RPO ölçülür.
- Cross-tenant sensor tabloları açık schema: 'sensor' taşır ve
  MODULE_SCHEMAS.sensor.infrastructureTables listesine eklenir. Per-tenant
  sensor_metrics entity'si schema belirtmez.
- NATS servisleri yalnız infrastructure/nats/services.yaml üzerinden tanımlanır;
  generated nats.conf elle düzenlenmez.
- Her implementasyon adımı test-first ilerler. Her faz sonunda
  nx affected --target=test, nx affected --target=lint, npm run type-check ve
  npm run format:check yeşil olmalıdır.
- Faz 3 ayrıca cargo fmt --all -- --check, cargo clippy --workspace -- -D warnings
  ve cargo test --workspace çalıştırır.
- Her fix commit'i bu belgedeki bir finding anchor'ını Closes: satırıyla kapatır
  ve aktif branch'e push edilir. Force push ve hook bypass yasaktır.
- Kullanıcıya ait mevcut untracked dosyalar korunur. Özellikle
  apps/billing-service/src/database/migrations/1802100000000-AddPlanChangeOperationSaga.ts
  yeniden oluşturulmaz, üzerine yazılmaz ve bu planın commit'ine alınmaz.

---

## Repo-Kanıtlı Doğrulama

### Hüküm

Plan v2'nin mimari yönü doğrudur, fakat aynen uygulanması yeni veri kaybı ve
kapasite yanılgısı üretir. Aşağıdaki düzeltmeler bu v3 planında zorunludur.

| Konu            | Repo gerçeği                                                                                                          | v3 kararı                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Tasarım hızı    | docs/perf/baseline-2026-04.md içindeki tüm sonuç alanları ölçülmemiştir; 15K değeri Rust ROI eşiğidir.                | 2K msg/s sürekli, 15K msg/s beş dakika stres.                                                        |
| Hız eksenleri   | Bir MQTT payload birden çok channel row ve event üretebilir.                                                          | M=MQTT msg/s, E=JetStream event/s, R=PG row/s ayrı ölçülür.                                          |
| Mesaj boyutu    | tools/scripts/perf-baseline.ts sentetik JSON üretir; 600–750B production ölçümü yoktur.                               | MQTT wire, Mosquitto persistence ve JetStream stored p95/p99 ayrı ölçülür.                           |
| NATS kapasitesi | infrastructure/docker/nats/nats.conf max_file_store=2GB. Event bus stream'i 1.5GiB, 1M message, Discard Old kullanır. | Telemetry için Discard New ve entitlement tabanlı byte/message cap.                                  |
| Mosquitto       | infrastructure/mosquitto/mosquitto-production.conf max_queued_messages=1000 ve max_inflight_messages=20 kullanır.     | Persistent QoS1 session; queue budget = 2K × 60dk × ölçülen bayt × 1,2 (default 1000 kabul edilmez). |
| MQTT ACK        | mqtt-client.service.ts PID/timestamp clientId, clean:true ve fire-and-forget handler kullanır.                        | mqtt.js handleMessage callback'i durable disposition sonrasına alınır.                               |
| Writer          | SensorMetricWriterService.enqueue void döner; flush buffer'ı yazmadan splice eder.                                    | Tenant-bazlı Promise result, bounded retry ve DB-side deadline.                                      |
| Sidecar         | apps/sensor-ingestion/src/main.rs MQTT mesajlarını loglayıp düşürür. Sink shared sensor.sensor_metrics hedefler.      | Faz 3 gerçek pipeline inşasıdır; sidecar bugün production-ready değildir.                            |
| Schema          | TS tenant adı 16 hex, Rust 32 hex üretir.                                                                             | TS sözleşmesi SSoT; Rust 16-hex ve golden-vector test.                                               |
| Aktif reader    | MetricQueryService ve TimeBucketService sensor.sensor_metrics hard-code eder.                                         | Faz 0'da tenant schema-aware sorgu ve hard-code invariant'ı.                                         |
| Retention       | Matrix retired sensor_readings/1825 gün gösterir; ADR-024 Proposed durumundadır.                                      | sensor_metrics + ISO period + ledger/restore kanıtı.                                                 |
| Edge queue      | OfflineQueue default false; dolunca düşük öncelikli eski mesajı siler.                                                | Default-on; admitted telemetry için sessiz eviction yok.                                             |
| Billing         | CUSTOM plan, quoteId/customPlanId ve SENSOR_READINGS meter mevcuttur.                                                 | Telemetri hakkı PLAN_CATALOG sabiti değil, tenant'a özel approved entitlement.                       |

### Düzeltilmiş Kapasite Matematiği

- 15.000 × 600–750B × 3.600s × 1,20 =
  38,88–48,60 GB decimal. Yaklaşık 40GB yalnız alt sınırdır.
- 2.000 × 600–750B × 3.600s × 1,20 =
  5,184–6,480 GB decimal. Bu değer broker overhead ölçülmeden deploy değeri
  değildir.
- 1.000 row/s × 90 gün × 0,5KB = 3,888TB decimal; yüzde 20 rezervle
  4,666TB. 2.000 row/s için sırasıyla 7,776TB ve 9,331TB.
- sensor_metrics 19 kolon ve altı secondary index taşıdığı için 0,5KB varsayımı
  yalnız alt sınırdır. Gerçek heap/index/WAL byte/row ölçülür.
- 100 tenant × 90 gün = 9.000 tenant-day export birimi. Bu chunk sayısı değildir;
  bir saatlik chunk kullanılırsa aynı pencere 216.000 chunk üretir.

## Kilitlenmiş Ürün ve Operasyon Kararları

### Tenant telemetri entitlement'ı

Admin tenant oluştururken veya sözleşme değiştirirken tenant ihtiyacına göre iki
kapasite değeri seçer:

- sustainedIngressMessagesPerSecond
- sustainedMetricRowsPerMinute

Admin UI cihaz sayısı, mesaj aralığı ve channel fan-out üzerinden hesaplayıcı
gösterir; sözleşmeye onaylanan türetilmiş M/R değerleri yazılır. Billing custom
plan/quote aynı miktarları fiyat girdisi olarak kullanır; SENSOR_READINGS meter
commit edilmiş gerçek row kullanımını ölçer.

Yeni entitlement kurulu throughput, storage, broker veya bağlantı zarfını
aşıyorsa teklif korunur fakat işlem PENDING_CAPACITY kalır:

- Yeni tenant ACTIVE yapılmaz.
- Mevcut tenant eski entitlement ile çalışmaya devam eder.
- Resize/volume kanıtı sonrası yeni entitlement atomik aktive edilir.
- Yetkili admin bile zero-loss SLO'sunu sessizce aşamaz.

### Saklama sözleşmesi

> **PROPOSED — LEGAL-HIGH-001:** Bu tablo, İSG/Su Ürünleri Yönetmeliği'nin minimum saklama
> gereksinimlerine karşı hukuk onayı alındıktan sonra yürürlüğe girer. Onay gelmeden
> FREE/TRIAL/STARTER kısaltmaları ve CUSTOM dönemler aktifleştirilemez.

| Plan         |    Toplam raw erişim dönemi |  Hot PG raw | Cold RAW Parquet |
| ------------ | --------------------------: | ----------: | ---------------: |
| FREE         |                        P30D |        P30D |              Yok |
| TRIAL        |                        P90D |        P90D |              Yok |
| STARTER      |                        P90D |        P90D |              Yok |
| PROFESSIONAL |                       P365D |        P90D |       P90D–P365D |
| ENTERPRISE   |              P5Y varsayılan |        P90D |         P90D–P5Y |
| CUSTOM       | Onaylı sonlu ISO-8601 dönem | En çok P90D |      Kalan dönem |

Enterprise unlimited retention kaldırılır. P5Y takvim yılıdır; 1825 günlük sabit
değer deletion hesabında kullanılmaz. Daha uzun CUSTOM dönem ancak fiyat ve
kapasite rezervasyonu birlikte onaylanır.

### Zero-loss kapsamı

Garanti:

- QoS1 source message
- aktif entitlement içinde
- edge, broker ve JetStream data volume sağlıklı
- outage en fazla 60 dakika
- at-least-once transport, exactly-once business effect

Kapsam dışı fakat görünür ve ölçülür:

- QoS0
- malformed/quarantine payload
- quota veya fiziksel queue exhaustion
- edge disk/cihaz kaybı
- operatör tarafından veri silme
- backup restore; bunun hedefi WAL-G RPO en fazla 300 saniyedir

## Public Interfaces and Data Contracts

### Event-contracts

```typescript
export interface TelemetryCapacityEntitlement {
  sustainedIngressMessagesPerSecond: number;
  sustainedMetricRowsPerMinute: number;
  version: number;
  effectiveAt: string;
}

export type TelemetryCapacityActivationState =
  | 'PENDING_CAPACITY'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'RELEASED';

export interface TelemetryCapacityEntitlementChangedEvent extends BaseEvent {
  eventType: 'TelemetryCapacityEntitlementChanged';
  entitlementVersion: number;
  sustainedIngressMessagesPerSecond: number;
  sustainedMetricRowsPerMinute: number;
  activationState: TelemetryCapacityActivationState;
  effectiveAt: string;
}

export interface DlqEnvelope {
  tenantId?: string;
  originalStream: string;
  originalSubject: string;
  originalSequence?: number;
  sourceEventId?: string;
  payloadBase64: string;
  failureClass: string;
  errorDigest: string;
  deliveryCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
  replayedBy?: string;
  replayedAt?: string;
}
```

### MQTT disposition

```typescript
export type MqttDisposition =
  | { kind: 'COMMITTED'; sourceEventId: string }
  | { kind: 'RETRY'; reason: string }
  | { kind: 'POISON'; dlqSubject: string }
  | { kind: 'ERASED_TENANT'; tenantId: string };

export type MqttMessageHandler = (
  topic: string,
  message: Buffer,
  context: { packetId?: number; duplicate: boolean },
) => Promise<MqttDisposition>;
```

### Event bus route registry

```typescript
export interface EventRoute {
  subjectRoot: 'events' | 'telemetry';
  stream: 'AQUACULTURE_EVENTS' | 'AQUACULTURE_TELEMETRY';
}

export interface SubscriptionOptions {
  durableName?: string;
  consumerVersion: number;
  maxInflight?: number;
  maxAckPending?: number;
  handlerDeadlineMs?: number;
}
```

SensorMetricIngested ve SensorReading route kayıtları telemetry kökünü kullanır;
diğer domain event'leri events kökünde kalır. publish, publishTo, subscribe,
subscribeWildcard ve stream setup aynı registry'yi tüketir.

### Archive ledger

Cross-tenant tablo sensor.telemetry_archive_events olur ve entity açık
schema: 'sensor' taşır.

```sql
CREATE TABLE sensor.telemetry_archive_events (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  tenant_schema varchar(23) NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  state varchar(24) NOT NULL,
  source_row_count bigint,
  source_snapshot text,
  source_wal_lsn pg_lsn,
  object_key text,
  parquet_sha256 char(64),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL
);
```

State yalnız append ile ilerler:
EXPORT_STARTED → EXPORTED → VERIFIED → DROPPED. FAILED yeni event'tir; eski satır
UPDATE edilmez. Current-state view en yeni transition'ı türetir.

## File and Responsibility Map

| Alan                 | Ana dosyalar                                                                       | Sorumluluk                                        |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| Capacity contracts   | libs/event-contracts/src/billing/telemetry-capacity.ts                             | Ortak entitlement/event tipleri ve validator      |
| Admin provisioning   | apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts | Capacity reservation ve PENDING_CAPACITY state    |
| Billing              | apps/billing-service/src/billing/entities/subscription.entity.ts                   | Onaylı entitlement snapshot ve pricing quantities |
| MQTT durability      | apps/sensor-service/src/shared-mqtt/mqtt-client.service.ts                         | Persistent session ve delayed PUBACK              |
| Ingest orchestration | apps/sensor-service/src/ingestion/mqtt-listener.service.ts                         | Parse, persist, publish, disposition              |
| Metric write         | apps/sensor-service/src/ingestion/sensor-metric-writer.service.ts                  | Tenant batch result ve DB deadline                |
| Event routing        | platform/libs/event-bus/src/nats/nats-event-bus.ts                                 | Subject-root → stream registry                    |
| NATS ACL             | infrastructure/nats/services.yaml                                                  | Cert-CN izin SSoT                                 |
| Sidecar              | apps/sensor-ingestion/src/main.rs ve persistence.rs                                | MQTT → tenant PG → JetStream PubAck               |
| Aggregate lifecycle  | apps/sensor-service/src/timescale/continuous-aggregate.service.ts                  | Provision, refresh, status ve cagg policy         |
| Retention ledger     | apps/sensor-service/src/archive/                                                   | Export, verify, drop ve restore orchestration     |
| Cold storage         | apps/sensor-service/src/archive/parquet/                                           | Tenant-day Parquet + manifest                     |
| Monitoring           | infrastructure/monitoring/droplet/                                                 | Exporter, scrape ve alert rules                   |
| Gates                | tests/invariants ve e2e/tests/integration                                          | Mimari ve rollout invariants                      |

## Finding Registry

| ID                  | Severity | Status | Owner                   | Deadline    |
| ------------------- | -------- | ------ | ----------------------- | ----------- |
| SENSOR-CRITICAL-086 | CRITICAL | OPEN   | sensor-service          | Faz 1 exit  |
| SENSOR-CRITICAL-087 | CRITICAL | OPEN   | sensor-service          | Faz 1 exit  |
| SENSOR-CRITICAL-088 | CRITICAL | OPEN   | sensor-service/data     | Faz 0 exit  |
| SENSOR-CRITICAL-089 | CRITICAL | OPEN   | sensor-ingestion        | Faz 3 exit  |
| SENSOR-HIGH-090     | HIGH     | OPEN   | platform-infra          | Faz 0 exit  |
| SENSOR-HIGH-091     | HIGH     | OPEN   | observability           | Faz 0 exit  |
| SENSOR-HIGH-092     | HIGH     | OPEN   | platform-event-bus      | Faz 2 exit  |
| SENSOR-HIGH-093     | HIGH     | OPEN   | sensor-service/security | Faz 1 exit  |
| SENSOR-HIGH-094     | HIGH     | OPEN   | sensor-service/data     | Faz 4 exit  |
| SENSOR-HIGH-095     | HIGH     | OPEN   | sensor-service/SRE      | Faz 6 exit  |
| SENSOR-HIGH-096     | HIGH     | OPEN   | admin-api/billing       | Task 8 exit |
| LEGAL-HIGH-001      | HIGH     | OPEN   | legal/compliance        | Task 8 exit |

### SENSOR-CRITICAL-086 — MQTT yolu source commit'ten önce PUBACK verebiliyor

Mevcut handler Promise sonucunu beklemez ve mqtt.js callback kapısını
kullanmamaktadır. Kabul: persistent session, QoS1 ve disposition-after-commit
contract test ile sabitlenir.

### SENSOR-CRITICAL-087 — Writer buffer kayıp penceresi

enqueue void döner, flush yazmadan splice eder. Kabul: tenant bazlı waiter,
bounded local retry, DB-side timeout ve source redelivery.

### SENSOR-CRITICAL-088 — Per-tenant storage sözleşmesi aktif reader'larda delinmiş

MetricQueryService ve TimeBucketService shared schema hard-code eder. Kabul:
validated tenant schema ve active-code invariant.

### SENSOR-CRITICAL-089 — Sidecar readiness iddiası canlı binary ile uyuşmuyor

Binary stub drain çalıştırır ve sink shared hypertable hedefler. Kabul: gerçek
per-tenant pipeline, PubAck ve honesty invariant.

### SENSOR-HIGH-090 — Host ve broker kapasitesi ilan edilen zarfı taşımıyor

Mevcut compose cap'i host fiziksel kaynağını aşar; NATS file store 2GB'dir.
Kabul: M/E/R ölçümü, resource ledger ve resize/volume hard gate.

### SENSOR-HIGH-091 — Broker ve teslimat gözlemlenebilirliği eksik

Prometheus NATS/Mosquitto scrape etmez ve Alertmanager teslimatı kanıtlı değildir.
Kabul: exporter, rule, receiver receipt ve deadman.

### SENSOR-HIGH-092 — Tek event stream telemetry backlog için güvenli değil

Telemetry ve domain event'leri aynı stream/cap altındadır. Kabul: route registry,
ayrı stream ve dual-subscribe migration.

### SENSOR-HIGH-093 — Terminal failure/DLQ/replay zinciri yok

max_deliver sonu sessiz terminal olabilir. Kabul: app-classified retry,
PubAck-before-original-ACK DLQ ve rate-limited replay CN.

### SENSOR-HIGH-094 — Retention policy ile export doğrulaması bağlı değil

Current registry process-local, matrix drift etmiş ve raw drop ledger'a bağlı
değildir. Kabul: append-only archive event chain ve verify-before-drop invariant.

### SENSOR-HIGH-095 — P90D sonrası RAW verinin kullanılabilir DR yolu kanıtsız

MinIO vardır fakat tenant-isolated Parquet export/restore zinciri yoktur. Kabul:
tenant-day export, independent verify, scratch restore ve erasure.

### SENSOR-HIGH-096 — Tenant ihtiyacına göre kapasite fiyatlama/provisioning bağı yok

Custom quote ve usage meter vardır, telemetri capacity entitlement'ı yoktur.
Kabul: admin-selected M/R, billing snapshot ve PENDING_CAPACITY saga. (Task 8'e
taşındı; hiçbir fazın önkoşulu değildir.)

### LEGAL-HIGH-001 — Plan-tier retention tablosu yasal onaysız yürürlüğe giremez

Saklama sözleşmesi tablosu, İSG/Su Ürünleri Yönetmeliği minimum saklama
gereksinimlerine karşı doğrulanmadan PROPOSED kalır. Kabul: hukuk onayı kanıtı
bu belgeye eklenir; onaysız tier aktivasyonu invariant ile engellenir.

---

## Task 0: Capacity Measurement, Storage Truth and Observability Foundation

**Depends on:** None. (Telemetry capacity entitlement Task 8'e taşındı; bu task'ın
kapsamı değildir ve Task 1–3 onu beklemez.)

**Files:**

- Modify: apps/sensor-service/src/sensor/services/metric-query.service.ts
- Modify: apps/sensor-service/src/aggregation/time-bucket.service.ts
- Modify: tools/scripts/perf-baseline.ts
- Modify: scripts/deploy/droplet-capacity.sh
- Modify: docker-compose.droplet.yml
- Modify: docker-compose.monitoring.yml
- Modify: infrastructure/monitoring/droplet/prometheus.yml
- Test: tests/invariants/telemetry-storage-contract.spec.ts

**Produces:**

- Tenant-aware metric readers
- Measured M/E/R capacity artifact
- Independent capacity gates
- Broker and host monitoring baseline

- [ ] **Step 0.1: Create the implementation branch from the current HEAD**

Run:

```bash
git checkout -b feat/100-tenant-readiness-v3
```

The branch is cut from the CURRENT active HEAD — no pinned SHA. A separate
worktree is optional; if one is used, copy this untracked design record into it
first and run npm install there.

Expected: original dirty workspace and every untracked file remain unchanged.

- [ ] **Step 0.2: Reproduce the test runner before feature work**

Run:

```bash
npm install
npx nx test invariants --runInBand
```

Expected: test discovery succeeds. Verify the `invariants` nx target exists; if
it does not, use `npx jest tests/invariants --runInBand` and record the correct
command here. If yargs fails before discovery, fix the workspace
dependency/root-cause and rerun this exact command before Step 0.3.

- [ ] **Step 0.3: Write and satisfy tenant-storage reader invariants**

```typescript
it('contains no active shared sensor metric SQL', () => {
  for (const file of ACTIVE_SENSOR_QUERY_FILES) {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/sensor\.(sensor_metrics|metrics_1min|metrics_1hour|metrics_1day)/);
  }
});
```

Every public query/status/refresh method receives tenantId, resolves the
validated active mapping and executes in tenant context. `ACTIVE_SENSOR_QUERY_FILES`
covers the active SQL-bearing readers (today: metric-query.service.ts and
time-bucket.service.ts) so comment-only references cannot mask real SQL.

- [ ] **Step 0.4: Measure M/E/R and storage bytes**

Run 100 tenant profiles from an external load host:

1. 2K MQTT msg/s for 30 minutes.
2. Record MQTT wire bytes and Mosquitto persistence delta.
3. Record JetStream /jsz bytes and event count delta.
4. Record rows/message and PG heap/index/WAL delta per tenant.
5. Run 15K msg/s for five minutes and record accepted/rejected counts.

Write immutable JSON and Markdown artifacts under docs/perf/results/ with the
exact git SHA, payload distribution and host identity.

- [ ] **Step 0.5: Implement independent capacity gates**

The deploy preflight rejects when any condition is false:

- image pull: existing 35GiB/20 percent policy
- NATS: max_file_store below stream bytes plus 25 percent reserve
- broker volumes: projected 60-minute queue plus 20 percent reserve
- PG: measured-envelope-derived hot-retention projection plus 20 percent
  (Task 8 entitlement değerleri hazır olduğunda devralır)
- MinIO/log/Prometheus: measured projection plus 20 percent
- CPU/RAM: steady p95 CPU above 70 percent or working set above 75 percent

NATS receives at least 512MiB/1CPU reservation. Gate failure produces
PENDING_CAPACITY and requires droplet resize or a dedicated nats_data volume.

- [ ] **Step 0.6: Consolidate monitoring and prove alert delivery**

Make docker-compose.monitoring.yml canonical. Add digest-pinned NATS exporter
for 8222, a dedicated least-privileged Mosquitto SYS exporter, protected
observability scrape credentials, broker/consumer/DLQ rules, a real
Alertmanager receiver receipt and external deadman.

- [ ] **Step 0.7: Verify and commit**

```bash
npx nx test sensor-service --runInBand
npx jest tests/invariants/telemetry-storage-contract.spec.ts --runInBand
nx affected --target=lint
npm run type-check
npm run format:check
git commit -m "feat(sensor): tenant-aware telemetry readers and measured capacity gates

Close the shared-schema read path and gate deploys on measured envelope
numbers before durability and stream work begins.

Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-CRITICAL-088
Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-090
Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-091"
git push -u origin feat/100-tenant-readiness-v3
```

**Exit gate:** Measured M/E/R artifact, tenant-aware readers, data-volume
decision and delivered alert receipt all exist. (Capacity reservation Task 8'in
çıkış kapısıdır.)

**Rollback:** Disable capacity activation, keep pending quotes, restore previous
monitoring compose. For NATS store migration: stop publishers, stop NATS,
migrate nats_data content to the new store with checksums, rebind, restart and
compare /jsz sequences.

**Alarms:** disk/inode/IOPS, scrape-down, broker queue/drop, JetStream rejected
PubAck, PG pool/timeouts. (capacity-reservation backlog alarmı Task 8 ile gelir.)

---

## Task 1: ACK-After-Commit MQTT, Writer and DLQ

**Depends on:** Task 0 exit gate.

**Files:**

- Modify: apps/sensor-service/src/shared-mqtt/mqtt-client.service.ts
- Modify: apps/sensor-service/src/ingestion/mqtt-listener.service.ts
- Modify: apps/sensor-service/src/ingestion/sensor-metric-writer.service.ts
- Create: apps/sensor-service/src/ingestion/dlq/dlq-publisher.service.ts
- Create: apps/sensor-service/src/ingestion/dlq/dlq-envelope.ts
- Create: tools/scripts/telemetry-dlq-replay.ts
- Modify: apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts
- Modify: apps/farm-service/src/events/listeners/sensor-temperature-projection.listener.ts
- Modify: apps/gateway-api/src/websocket/nats-bridge.service.ts
- Modify: sens-api-gateway/src/config.rs
- Modify: sens-api-gateway/src/offline_queue.rs
- Test: apps/sensor-service/src/ingestion/**tests**/mqtt-listener.service.spec.ts
- Test: apps/sensor-service/src/ingestion/**tests**/sensor-metric-writer.service.spec.ts
- Test: e2e/tests/integration/telemetry-durability.spec.ts

**Produces:**

- QoS1 delayed PUBACK
- Tenant-result writer contract
- Deterministic event identity
- DLQ/replay and idempotent business effects

- [ ] **Step 1.1: Pin failing MQTT ACK behavior**

```typescript
it('does not release PUBACK until metric commit and child PubAck succeed', async () => {
  const callback = jest.fn();
  writer.enqueue.mockReturnValue(deferredWrite.promise);
  jetstream.publish.mockReturnValue(deferredPubAck.promise);

  client.handlePacket(qos1Packet(), callback);
  expect(callback).not.toHaveBeenCalled();

  deferredWrite.resolve({ tenantId: TENANT_ID, committedRows: 4 });
  await flushPromises();
  expect(callback).not.toHaveBeenCalled();

  deferredPubAck.resolve({ duplicate: false, seq: 42 });
  await flushPromises();
  expect(callback).toHaveBeenCalledTimes(1);
});
```

Run:

```bash
npx nx test sensor-service --runInBand
```

Expected: FAIL because current message dispatch does not own the mqtt.js callback.

- [ ] **Step 1.2: Implement persistent MQTT session and disposition**

Require MQTT_CLIENT_ID, set clean:false, subscribe QoS1 and override mqtt.js
handleMessage. COMMITTED, POISON with successful DLQ PubAck and ERASED_TENANT
release callback. RETRY or ten-second deadline closes the connection without
PUBACK so the persistent session redelivers.

**Tasarım notu:** "bağlantıyı kapat" ile "callback'i çağırmadan bekle (broker
inflight=20 backpressure)" alternatifleri ilk uygulama gününde geçici DB kesintisi
altında ölçülür; kazanan belgeye işlenir. Varsayılan: bağlantıyı kapat.

- [ ] **Step 1.3: Make writer result tenant-scoped and bounded**

enqueue returns Promise<WriteOutcome>. A flush snapshots, not destructively
forgets, pending tickets. One tenant's failure rejects only that tenant's
waiters. One bounded in-handler retry is allowed; source redelivery owns later
attempts.

Dedicated metric pool defaults:

- acquire timeout 2 seconds
- lock_timeout 1 second
- statement_timeout 5 seconds
- handler hard deadline 10 seconds
- NATS ack_wait 30 seconds

Upsert uses:

```sql
WHERE COALESCE(EXCLUDED.source_timestamp, EXCLUDED.time)
   >= COALESCE(sensor_metrics.source_timestamp, sensor_metrics.time)
```

- [ ] **Step 1.4: Implement deterministic post-commit publication**

Edge assigns sourceEventId before durable queue insertion. Legacy fallback is
UUIDv5 over tenant, sensor, producer timestamp and canonical payload SHA-256.
Each child SensorReading event ID is UUIDv5 over sourceEventId and channelId.
Nats-Msg-Id equals child event ID.

On redelivery the publisher sends the same event again; it never assumes a prior
publish succeeded. Retry count is a NATS header and DLQ field, not event payload.
GraphQL/manual writes keep the transactional generic outbox.

- [ ] **Step 1.5: Make downstream business effects idempotent**

Alert creation/notification uses unique (rule_id, source_event_id). The alert
outbox is written in the same transaction. Farm projection upserts by event ID.
Gateway forwards eventId and the web client deduplicates its reconnect window.
Alert handler rethrows retryable failures instead of swallowing them.

- [ ] **Step 1.6: Implement DLQ and replay**

Create AQUACULTURE_DLQ with dlq.>, max_age 72h, Discard New and measured
max_bytes. Tenant subjects are dlq.<tenant>.<type>; unattributable poison uses
dlq.quarantine.mqtt with 24h retention.

Broker max_deliver is unlimited. Poison goes directly to DLQ; transient
infrastructure errors retry; five repeated unknown failures go to DLQ. Original
message is ACKed only after DLQ PubAck. Replay CN republishes with the original
eventId, waits PubAck, then ACKs DLQ.

**DLQ-dolu davranışı:** DLQ PubAck reddedilirse original mesaj NAK'lenir ve
CRITICAL alarm tetiklenir; doluluk %100'de quarantine subject (24s TTL) feda
sırasına girer — DLQ asla sessiz taşmaz.

- [ ] **Step 1.7: Make edge queue default-safe**

OfflineQueueConfig defaults enabled. Remove drop-oldest for admitted telemetry;
return explicit QueueFull and expose 70/85/100 percent alarms. Queue row and disk
caps come from entitlement × 60 minutes × measured bytes ×1.2.

- [ ] **Step 1.8: Extend erasure and cache invalidation**

Purge sensor_outbox, telemetry stream subject, DLQ subject, downstream
idempotency/outbox rows and later archive objects. Add tenant-wide MQTT auth and
sensor metadata cache invalidation broadcast. Ingress checks an erased-tenant
tombstone before any write and ACK-drops such messages without recreating data.

- [ ] **Step 1.9: Verify failure drills and commit**

```bash
npx nx test sensor-service --runInBand
npx nx test alert-engine --runInBand
npx nx test farm-service --runInBand
npx nx test gateway-api --runInBand
cargo test --manifest-path sens-api-gateway/Cargo.toml
nx affected --target=lint
npm run type-check
npm run format:check
git commit -m "feat(sensor): acknowledge telemetry after durable commit

Make MQTT, metric persistence, JetStream publication and DLQ replay one
observable at-least-once chain with idempotent business effects.

Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-CRITICAL-086
Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-CRITICAL-087
Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-093"
git push
```

**Exit gate:** Five-minute PG kill and MQTT reconnect yield zero missing admitted
source IDs and zero duplicate business effects. DLQ failure never ACKs original.

**Rollback:** SENSOR_DURABLE_INGEST_PROFILE=legacy may be selected only after
MQTT/consumer pending reaches zero. DLQ and queued source messages are preserved.

**Alarms:** handler deadline, writer queue, pool saturation, source redelivery,
edge/broker queue, DLQ depth/oldest, replay failure and duplicate-effect conflict.

---

## Task 2: Telemetry Stream Separation and ACL Surgery

**Depends on:** Task 1 exit gate.

**Files:**

- Modify: platform/libs/event-bus/src/nats/nats-event-bus.ts
- Create: platform/libs/event-bus/src/nats/event-route-registry.ts
- Modify: infrastructure/nats/services.yaml
- Regenerate: infrastructure/docker/nats/nats.conf
- Modify: docker-compose.droplet.yml
- Modify: apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts
- Modify: apps/farm-service/src/events/listeners/sensor-temperature-projection.listener.ts
- Modify: apps/gateway-api/src/websocket/nats-bridge.service.ts
- Test: platform/libs/event-bus/src/nats/**tests**/nats-event-bus.telemetry.spec.ts
- Test: e2e/tests/integration/nats-invariants.spec.ts

**Produces:**

- AQUACULTURE_TELEMETRY stream
- Subject-root route registry
- Monotonic consumer versioning
- Least-privilege JetStream ACL

- [ ] **Step 2.1: Write route regression tests**

```typescript
it('creates SensorReading durable on AQUACULTURE_TELEMETRY', async () => {
  await bus.subscribe('SensorReading', handler, options({ consumerVersion: 2 }));
  expect(jsm.consumers.add).toHaveBeenCalledWith(
    'AQUACULTURE_TELEMETRY',
    expect.objectContaining({ filter_subject: 'telemetry.*.SensorReading' }),
  );
});

it('rejects publishTo for an unknown root', async () => {
  await expect(bus.publishTo('unknown.tenant.Event', event)).rejects.toThrow(
    'Unknown event subject root',
  );
});
```

- [ ] **Step 2.2: Implement one route registry**

SensorMetricIngested and SensorReading route to telemetry and
AQUACULTURE_TELEMETRY. All other domain events default to events and
AQUACULTURE_EVENTS. setup, publish, publishTo, subscribe and wildcard lookup use
the same registry; no method reconstructs a stream name independently.

- [ ] **Step 2.3: Size the telemetry stream**

Set subjects telemetry.>, Discard New and max_age 90 minutes. max_bytes and
max_msgs use 60-minute E rate multiplied by 1.2. At full design rate the
byte/message gate gives 20 percent outage headroom; max_age cleans low-rate stale
messages.

max_ack_pending is:

```text
max(10000, ceil(E × measured_p99_handler_seconds × 1.2))
```

Local pull concurrency remains bounded by metric pool and batch capacity.

- [ ] **Step 2.4: Narrow ACL and regenerate**

Replace broad $JS.API.> access with exact stream/consumer-create/fetch subjects.
Add dlq_replayer and any new CN in services.yaml, mint matching certs and run:

```bash
python3 scripts/nats/generate-nats-conf.py
npx jest e2e/tests/integration/nats-invariants.spec.ts --runInBand
```

Expected: generated block matches services.yaml; telemetry publish coverage and
bare-root prohibition pass.

- [ ] **Step 2.5: Execute ordered rollout**

1. Restart NATS with new file-store budget — migrate existing nats_data content
   to the new store first, checksum-verified — and verify /jsz.
2. Create telemetry stream.
3. Deploy consumerVersion=2 consumers in dual-subscribe mode.
4. Switch publishers to telemetry subjects.
5. Compare legacy/new sequence watermark and tenant-minute reconciliation.
6. Enable legacy-subject tombstone alarm.
7. Stop legacy consumers only after drain is zero.

Blind dual-publish is prohibited.

- [ ] **Step 2.6: Verify and commit**

```bash
npx nx test event-bus --runInBand
npx jest e2e/tests/integration/nats-invariants.spec.ts --runInBand
nx affected --target=test
nx affected --target=lint
npm run type-check
npm run format:check
git commit -m "feat(event-bus): isolate high-rate telemetry stream

Route telemetry and domain events through one registry and enforce
least-privilege JetStream lifecycle permissions.

Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-092"
git push
```

**Exit gate:** Telemetry and domain subjects are non-overlapping; NATS preflight
proves file store is at least the sum of declared stream budgets; every migrated
publisher receives PubAck; versioned consumers reach zero pending on the legacy
route; and tenant-minute reconciliation reports neither loss nor unintended
duplicate delivery across alert, farm projection and gateway consumers.

**Rollback:** Switch EVENT_BUS_TELEMETRY_ROUTE_MODE from telemetry to dual, then
legacy. Keep the new stream and drain it; do not delete it during rollback.

**Alarms:** rejected PubAck, stream bytes/messages, consumer pending,
ack-pending, redelivery, legacy tombstone traffic and route-registry rejection.

---

## Task 3: Live Rust Sidecar and Tenant Promotion

**Depends on:** Tasks 1 and 2 exit gates.

**Files:**

- Modify: crates/tenant-context/src/lib.rs
- Modify: apps/sensor-ingestion/src/main.rs
- Modify: apps/sensor-ingestion/src/persistence.rs
- Modify: apps/sensor-ingestion/src/events.rs
- Modify: crates/nats-client/src/lib.rs
- Modify: apps/db-migrate/src/platform-bootstrap.service.ts
- Modify: infrastructure/nats/services.yaml
- Modify: docker-compose.droplet.yml
- Modify: docs/adr/025-rust-sidecar-architecture.md
- Modify: docs/adr/027-per-tenant-ingest-backend-toggle.md
- Modify: docs/plans/sensor-rust-migration/PROGRESS.md
- Test: crates/tenant-context/tests/schema-golden.rs
- Test: e2e/tests/sensor-ingest-equivalence.e2e-spec.ts
- Test: tests/invariants/sensor-ingestion-honest-deployment.spec.ts

**Produces:**

- TS/Rust 16-hex tenant parity
- Per-tenant COPY/upsert sink
- JetStream PubAck
- Versioned per-tenant backend policy and kill switch

- [ ] **Step 3.1: Write shared schema golden vectors**

Use one fixture containing valid UUID → tenant\_<16hex> mappings. Both TS and
Rust read the same fixture. Unknown schema, uppercase, wrong length and UUID
mapping mismatch must fail closed.

- [ ] **Step 3.2: Replace the stub pipeline**

Wire rumqttc manual ACK:

```text
MQTT Publish
  → topic/payload validation
  → tenant batch
  → tenant transaction
  → binary COPY/upsert
  → commit
  → deterministic JetStream publish
  → PubAck
  → rumqttc ACK
```

- [ ] **Step 3.3: Implement connection-local staging**

On every pool connection create:

```sql
CREATE TEMP TABLE _sensor_metrics_stage (...)
ON COMMIT PRESERVE ROWS;
```

At each tenant transaction:

1. SET LOCAL app.current_tenant with a parameterized value.
2. SET LOCAL search_path = pg_catalog.
3. TRUNCATE the temp stage.
4. Binary COPY.
5. Schema-qualified upsert into validated tenant sensor_metrics.
6. Commit.

UNLOGGED stage and CREATE SCHEMA are prohibited.

- [ ] **Step 3.4: Add the dedicated PG role**

Bootstrap sensor_ingestion with LOGIN, CONNECT, TEMP, tenant-schema USAGE and
narrow sensor_metrics SELECT/INSERT/UPDATE. Deny CREATE SCHEMA and BYPASSRLS.
Provisioner applies privileges to both existing and new tenants. PG uses
CA-verified TLS plus SCRAM/password; NATS continues cert-CN-only identity. The
sidecar PG pool becomes visible to tools/scripts/database/capacity-check.sh
(connection-budget invariant).

- [ ] **Step 3.5: Make policy mutation durable and guarded**

Existing tenants are seeded NESTJS. New tenant provisioning must create a policy
before ACTIVE. Platform-admin guarded mutation writes versioned policy, audit
and transactional domain outbox. Node and Rust load a boot snapshot and consume
monotonic changes. Unknown policy means neither backend writes.

Policy flip may briefly process the same source on both paths; deterministic
event IDs, NATS dedup and downstream uniqueness prevent double farmer alarms.
Kill switch sets the tenant back to NESTJS and waits for Rust in-flight drain.

- [ ] **Step 3.6: Replace no-op equivalence test**

Staging harness starts real Mosquitto, NATS, TimescaleDB, sensor-service and
sidecar. Assert:

- identical tenant row count/value/quality/source timestamp
- zero shared sensor.sensor_metrics writes
- identical child event IDs
- exactly one alert/notification effect
- PubAck failure leaves MQTT message unacked
- policy kill switch returns processing to Node

- [ ] **Step 3.7: Verify and commit**

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
npx nx test sensor-service --runInBand
npx jest tests/invariants/sensor-ingestion-honest-deployment.spec.ts --runInBand
npm run type-check
git commit -m "feat(sensor-ingestion): complete tenant-safe sidecar pipeline

Replace the stub drain with a policy-controlled per-tenant persistence and
JetStream acknowledgement path.

Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-CRITICAL-089"
git push
```

**Exit gate:** Delivery prerequisites — staging harness compose, GHCR image
build/push workflow, droplet compose entry with TOML config, client certs and
resource budget — all exist. Correctness parity 100 percent, p99 no worse than
Node, CPU per message at least 20 percent lower and all pool/resource limits
pass. Promote one pilot tenant before expanding tenant groups.

**Rollback:** Set pilot tenant policy to NESTJS, wait Rust pending/in-flight zero,
then stop sidecar. Verify source IDs, metric results and business-effect
uniqueness.

**Alarms:** policy-version lag, unknown policy, schema rejection, RLS denial,
COPY/commit/PubAck latency, Rust pending and Node/Rust parity.

---

## Task 4: Ledger-Driven Retention and Continuous Aggregates

**Depends on:** Task 0 storage contract. May be implemented alongside Tasks 1–2,
but deletion remains disabled until Task 6.

**Files:**

- Create: apps/sensor-service/src/database/migrations/1817000000000-CreateTelemetryArchiveLedger.ts
- Create: apps/sensor-service/src/archive/entities/telemetry-archive-event.entity.ts
- Create: apps/sensor-service/src/archive/telemetry-retention-orchestrator.service.ts
- Modify: libs/backend-common/src/database/schema-manager.service.ts
- Modify: apps/sensor-service/src/timescale/continuous-aggregate.service.ts
- Modify: apps/sensor-service/src/timescale/retention-policy.service.ts
- Modify: docs/compliance/retention-matrix.md
- Test: apps/sensor-service/src/archive/**tests**/telemetry-retention-orchestrator.spec.ts
- Test: tests/invariants/retention-matrix-coverage.spec.ts

**Produces:**

- Append-only export/drop ledger
- Provisioner-owned cagg creation
- Tenant-safe refresh/status
- Measured chunk interval

- [ ] **Step 4.1: Pin verify-before-drop with a failing test**

```typescript
it('refuses a drop boundary containing an unverified tenant-day', async () => {
  ledger.latestStateForRange.mockResolvedValue([
    { day: '2026-01-01', state: 'VERIFIED' },
    { day: '2026-01-02', state: 'EXPORTED' },
  ]);

  await expect(orchestrator.dropBefore(TENANT_ID, '2026-01-03')).rejects.toThrow(
    'Unverified archive range',
  );
  expect(timescale.dropChunks).not.toHaveBeenCalled();
});
```

- [ ] **Step 4.2: Implement append-only ledger**

Every state transition inserts a new event. Unique operation/state constraints
make retries idempotent. The derived current-state view selects the latest event
per operation/range. Add the table to sensor infrastructureTables and erasure
coverage.

- [ ] **Step 4.3: Move cagg provisioning out of boot sweep**

Tenant provisioner runs ensureAggregatesForTenant after the hypertable exists
and before tenant ACTIVE. Existing tenants enter rate-limited RECONCILE.
Invariant scanner verifies both migration delivery and provisioner post-step.

- [ ] **Step 4.4: Fix refresh/status tenant routing**

getRefreshStatus takes tenantId and filters view_schema. refresh takes tenantId,
validated view name and time range; it invokes schema-qualified
refresh_continuous_aggregate and rejects a range older than its lower-tier
source.

Scheduled start offsets:

- metrics_1min: 24 hours
- metrics_1hour: 7 days
- metrics_1day: 30 days

Replay/backfill explicitly refreshes affected windows in dependency order.
Reconciliation compares raw count with SUM(sample_count), not cagg row count.

- [ ] **Step 4.5: Retune chunks from measured size**

Read timescaledb_information dimensions and chunk relation sizes. For every
tenant choose the largest of 1h, 6h and 24h whose projected heap+index chunk is
between 256MiB and 512MiB at its entitlement. Existing chunks remain mixed;
export and drop use time boundaries, never arbitrary chunk-name lists.

- [ ] **Step 4.6: Replace retention drift**

Make a declarative code registry the SSoT. Update the matrix to sensor_metrics
and P30D/P90D/P365D/P5Y. Add invariant coverage over registry, matrix,
MODULE_SCHEMAS and provisioner. Raw sensor_metrics must never receive
add_retention_policy.

- [ ] **Step 4.7: Verify and commit**

```bash
npx nx test sensor-service --runInBand
npx nx test backend-common --runInBand
npx jest tests/invariants/retention-matrix-coverage.spec.ts --runInBand
nx affected --target=lint
npm run type-check
npm run format:check
git commit -m "feat(sensor): gate telemetry retention on archive evidence

Make continuous aggregate provisioning tenant-complete and require an
append-only verified export chain before any raw chunk drop.

Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-094"
git push
```

**Exit gate:** New tenant is not ACTIVE without cagg resources; no unverified
range can reach drop_chunks; matrix/registry/provisioner invariant is green.

**Rollback:** Set TELEMETRY_RETENTION_ENABLED=false. Restore prior chunk interval
for future chunks only. Dropped rows are restored from verified Parquet or
WAL-G, never by destructive migration down.

**Alarms:** cagg provision failure, refresh lag, raw-vs-sample_count mismatch,
archive state failure, unverified drop attempt and reconciliation backlog.

---

## Task 5: External Load, Failure and Decision Gates

**Depends on:** Tasks 1 and 2; sidecar decision additionally depends on Task 3.

**Files:**

- Modify: tools/scripts/perf-baseline.ts
- Create: tools/scripts/telemetry-reconciliation.ts
- Create: tools/scripts/telemetry-failure-drill.ts
- Create: docs/runbooks/telemetry-capacity-and-recovery.md
- Modify: docs/perf/baseline-2026-04.md
- Test: e2e/tests/integration/telemetry-reconciliation.spec.ts

**Produces:**

- Immutable load artifacts
- RLS/compression ADR decision
- Sidecar promotion verdict
- Hardware/volume verdict
- WAL-G restore evidence

- [ ] **Step 5.1: Run the 100-tenant steady profile**

External multi-process generator runs 2K MQTT msg/s against 100
entitlement-compliant tenants for 30 minutes. Reconciliation artifact contains
published source IDs, expected rows/message, per-tenant-minute count, child
event IDs, DLQ/reject totals and business-effect IDs.

Pass:

- missing admitted source IDs = 0
- tenant-minute row difference = 0
- duplicate business effects = 0
- unaccounted broker drop = 0
- handler p99 below 5 seconds and hard max below 10 seconds

- [ ] **Step 5.2: Execute resilience matrix**

At 2K msg/s:

1. Kill PostgreSQL for 5 minutes.
2. Stop/restart sensor-service.
3. Stop/restart NATS.
4. Stop/restart Mosquitto.
5. Hold cloud path unavailable for 30 minutes.
6. Fill the complete 60-minute edge/broker buffer.
7. Restore and measure drain time.
8. Replay known DLQ fixtures.
9. Erase a tenant with queued telemetry.

Pass: zero missing admitted IDs, zero duplicate effects, drain at most 60
minutes and only expected poison fixtures in DLQ.

- [ ] **Step 5.3: Execute 15K stress**

Run 15K msg/s for five minutes. Pass means no OOM, crash or corruption; every
accepted message reconciles and every rejection/backpressure result is counted.
It does not extend the 60-minute SLO to 15K.

- [ ] **Step 5.4: Decide hardware**

Keep current hardware only if steady p95 CPU is at most 70 percent, working set
at most 75 percent of assigned RAM, data volumes at most 70 percent and IOPS p95
at most 70 percent of measured capacity. Otherwise activate the documented
droplet resize/volume branch before tenant capacity activation.

- [ ] **Step 5.5: Decide RLS/compression**

Raw sensor_metrics always keeps FORCE RLS. Benchmark uncompressed raw plus
tenant-scoped aggregate/cold compression. Enable compression only outside raw
when isolation tests pass, storage improves at least 30 percent and p99
query/ingest latency worsens no more than 10 percent. ADR and
timescale-rls-columnstore invariant change in the same PR.

- [ ] **Step 5.6: Execute WAL-G scratch restore**

Restore a physical backup onto a scratch droplet. Measure RPO at most 300
seconds; verify tenant schemas, archive ledger and cagg data older than P90D.
Logical pg_dump is not accepted as the five-year DR proof.

- [ ] **Step 5.7: Publish evidence and commit**

```bash
npx nx test aqua-scripts --runInBand # hedef yoksa doğru test komutu ile değiştirilir
npx jest e2e/tests/integration/telemetry-reconciliation.spec.ts --runInBand
nx affected --target=lint
npm run type-check
npm run format:check
git commit -m "test(sensor): prove telemetry capacity and recovery gates

Record externally generated reconciliation, outage, hardware and restore
evidence before sidecar or retention promotion.

Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-090"
git push
```

**Exit gate:** The externally generated M/E/R scenarios publish signed,
machine-readable reconciliation artifacts; the five-minute PG kill, 30-minute
outage, restart and drain drills meet their declared loss/duplicate/recovery
limits; the WAL-G scratch restore proves its separate RPO; and the RLS,
sidecar-promotion and hardware ADR decisions are recorded with the invariant
changes required by each decision.

**Rollback:** Load tooling does not mutate production policy. Any pilot setting
used during drills returns to its pre-drill entitlement/backend flag and pending
queues are drained before test data cleanup.

**Alarms:** reconciliation difference, drain ETA, CPU/RAM/IOPS, WAL-G lag,
restore verification and pilot parity.

---

## Task 6: Tenant-Isolated Cold Storage and Restore

**Depends on:** Tasks 4 and 5 exit gates.

**Files:**

- Create: apps/sensor-service/src/archive/parquet/telemetry-parquet-exporter.service.ts
- Create: apps/sensor-service/src/archive/parquet/telemetry-parquet-verifier.service.ts
- Create: apps/sensor-service/src/archive/telemetry-archive-restore.service.ts
- Create: apps/sensor-service/src/archive/dto/request-archive-restore.dto.ts
- Create: tools/scripts/telemetry-archive-restore.ts
- Modify: docs/adr/024-compliance-retention-matrix.md
- Test: apps/sensor-service/src/archive/**tests**/telemetry-parquet-exporter.spec.ts
- Test: e2e/tests/integration/telemetry-cold-restore.spec.ts

**Produces:**

- Mandatory RAW and aggregate Parquet
- Per-tenant bucket/policy
- Independent manifest verification
- Async rehydration
- Retention activation gate

- [ ] **Step 6.1: Write snapshot/manifest tests**

```typescript
it('does not append VERIFIED until an independent read matches the manifest', async () => {
  exporter.write.mockResolvedValue(manifest({ sourceRowCount: 1440, sha256: SHA }));
  verifier.readAndVerify.mockResolvedValue({ sourceRowCount: 1439, sha256: SHA });

  await expect(job.exportTenantDay(TENANT_ID, DAY)).rejects.toThrow('Archive row-count mismatch');
  expect(ledger.append).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'VERIFIED' }));
});
```

- [ ] **Step 6.2: Create per-tenant buckets and policy**

Validate canonical tenant UUID before deriving the environment/tenant bucket
name. Give exporter write, verifier read and restore read permissions through
separate identities. Prefix-only tenant isolation is prohibited. Presigned URL
TTL is 15 minutes.

- [ ] **Step 6.3: Export deterministic tenant-day objects**

Inside REPEATABLE READ capture txid_current_snapshot and current WAL LSN. Query
raw rows in deterministic primary-key order and write one RAW Parquet plus
aggregate Parquet per tenant-day. Manifest includes range, count, min/max,
snapshot, LSN, object key and SHA-256.

- [ ] **Step 6.4: Verify in a separate reader**

Verifier downloads the object using its own identity, recalculates schema,
count, min/max and SHA-256 and appends VERIFIED only on exact equality. Export
and verify retries reuse operation ID and cannot create conflicting current
state.

- [ ] **Step 6.5: Implement async cold retrieval**

Admin-authorized tenant/time-range request rehydrates selected Parquet into an
isolated scratch tenant schema. Percentile, waveform and calibration-delta jobs
consume this restored raw source. Completion artifact records row count and hash
parity, then destroys the scratch resource through its owner-scoped lifecycle.

- [ ] **Step 6.6: Integrate erasure and legal hold**

Tenant erasure cancels pending exports, invalidates presigned access and purges
the tenant bucket plus ledger-owned object references. Active legal hold blocks
deletion and writes an auditable veto event; it cannot be bypassed by the normal
erasure worker.

- [ ] **Step 6.7: Run restore hard gate**

Restore at least one Professional P90D–P365D raw range and one Enterprise
greater-than-P365D range. Reconcile row counts/hashes and run a real percentile
calculation. Only then may TELEMETRY_RETENTION_ENABLED become true for the pilot
tenant.

- [ ] **Step 6.8: Promote ADR and commit**

```bash
npx nx test sensor-service --runInBand
npx jest e2e/tests/integration/telemetry-cold-restore.spec.ts --runInBand
nx affected --target=lint
npm run type-check
npm run format:check
git commit -m "feat(sensor): archive and restore tenant telemetry

Bind raw retention to independently verified tenant-isolated Parquet and a
tested rehydration path.

Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-095"
git push
```

**Exit gate:** Independent Parquet verify, async rehydration, WAL-G restore and
erasure all pass. ADR-024 may become Accepted only at this point.

**Rollback:** Set TELEMETRY_COLD_EXPORT_ENABLED=false and
TELEMETRY_RETENTION_ENABLED=false. Preserve existing objects and append-only
ledger. Restore dropped ranges from verified Parquet or WAL-G.

**Alarms:** export backlog/oldest age, manifest mismatch, bucket policy drift,
restore failure, presign abuse, legal-hold veto and erasure residue.

---

## Task 7: Explicit Non-Goals and Final Architecture Gates

**Depends on:** Tasks 0–6.

**Files:**

- Remove: apps/sensor-service/src/stream-processing/kafka-streams.service.ts
- Create: tests/invariants/telemetry-architecture-contract.spec.ts
- Modify: docs/adr/025-rust-sidecar-architecture.md
- Modify: docs/adr/027-per-tenant-ingest-backend-toggle.md
- Modify: docs/compliance/retention-matrix.md
- Modify: docs/plans/sensor-rust-migration/PROGRESS.md

**Produces:**

- Enforced no-Kafka/no-shard/no-shared-hypertable contract
- Honest sidecar and retention documentation
- Final 100-tenant evidence index

- [ ] **Step 7.1: Add final architecture invariant**

```typescript
it('keeps the telemetry architecture inside the approved boundaries', () => {
  expect(activeDependencies()).not.toContain('kafkajs');
  expect(activeSensorSql()).not.toMatch(/sensor\.sensor_metrics/);
  expect(sourceTree()).not.toContain('KafkaStreamsService');
  expect(canonicalTenantSchemaUtilityCount()).toBe(1);
});
```

The invariant also confirms no tenant router/shard map, no PgBouncer deployment
and no shared telemetry hypertable.

- [ ] **Step 7.2: Remove the no-op Kafka placeholder**

Delete the service and all imports/providers. Do not replace it with another
placeholder abstraction.

- [ ] **Step 7.3: Reconcile documentation with live behavior**

Update sidecar PROGRESS, ADR-025, ADR-027, retention matrix and deployment
runbooks from verified artifacts only. Do not use generic ADR-022 promotion:
docs/adr contains historical number collisions. Control/data separation needing
a new decision receives a unique canonical ADR filename.

- [ ] **Step 7.4: Run complete verification**

```bash
nx affected --target=test
nx affected --target=lint
npm run type-check
npm run format:check
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
npm run build:all
```

Expected: every command exits zero; load/restore evidence links resolve and every
finding row is RESOLVED with a closing commit.

- [ ] **Step 7.5: Commit and push**

```bash
git commit -m "chore(sensor): lock 100-tenant readiness boundaries

Remove the Kafka placeholder and make the measured telemetry architecture,
retention and sidecar truth enforceable in CI.

Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-092
Closes: docs/reviews/zcode/2026-08-24-100-tenant-readiness.md#SENSOR-HIGH-094"
git push
```

**Exit gate:** All finding rows are RESOLVED by linked evidence; the final
architecture invariant proves no active Kafka, shard router, PgBouncer or shared
telemetry hypertable; sidecar and retention documents match deployed truth; and
the complete TypeScript and Rust verification set exits zero.

**Rollback:** Revert only the documentation/invariant commit if it describes a
runtime state that has not actually shipped. Do not restore the no-op Kafka
provider or relax architecture invariants to make CI green; instead keep the
release blocked and reopen the corresponding finding.

**Alarms:** CI architecture-invariant failure, unresolved or overdue finding,
stale/missing capacity evidence, sidecar catalog-versus-compose drift and
retention-matrix-versus-registry drift.

## Task 8: Telemetry Capacity Entitlement (PARALLEL — hiçbir fazın önkoşulu değildir)

**Depends on:** None. Task 0'ın ölçüm artefaktı yalnızca sizing girdisi olarak
kullanılır; Task 1–3 bu task'ı beklemez.

**Files:**

- Create: libs/event-contracts/src/billing/telemetry-capacity.ts
- Create: apps/billing-service/src/database/migrations/1802200000000-AddTelemetryCapacityEntitlement.ts
  (numara, korumalı untracked 1802100000000-AddPlanChangeOperationSaga.ts ile
  çakışmayacak şekilde doğrulanır)
- Create: apps/admin-api-service/src/migrations/1808300000000-TelemetryCapacityReservations.ts
- Modify: apps/admin-api-service/src/tenant/dto/tenant.dto.ts
- Modify: apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts
- Modify: apps/admin-api-service/src/billing/entities/custom-plan.entity.ts
- Modify: apps/billing-service/src/billing/entities/subscription.entity.ts
- Test: apps/admin-api-service/src/tenant/**tests**/tenant-provisioning-workflow.service.spec.ts
- Test: tests/invariants/plan-limits-ssot.spec.ts

**Produces:**

- TelemetryCapacityEntitlement contract
- Atomic capacity reservation with PENDING_CAPACITY saga
- Billing entitlement snapshot and pricing quantities
- Admin M/R calculator wired to the SENSOR_READINGS meter

- [ ] **Step 8.1: Write failing capacity-contract tests**

```typescript
it('keeps a new tenant pending when installed ingress capacity is exhausted', async () => {
  capacity.sumActiveAndReserved.mockResolvedValue({
    ingressMessagesPerSecond: 1990,
    metricRowsPerMinute: 100000,
  });

  const result = await workflow.createTenantOperation(
    requestWithTelemetry({ sustainedIngressMessagesPerSecond: 20 }),
  );

  expect(result.state).toBe('PENDING_CAPACITY');
  expect(billing.activateEntitlement).not.toHaveBeenCalled();
});

it('keeps the old entitlement active during a pending limit increase', async () => {
  const result = await workflow.changeTelemetryEntitlement(
    TENANT_ID,
    entitlement({ version: 2, sustainedIngressMessagesPerSecond: 500 }),
  );

  expect(result.activationState).toBe('PENDING_CAPACITY');
  expect(await activeEntitlement(TENANT_ID)).toMatchObject({ version: 1 });
});
```

Run:

```bash
npx nx test admin-api-service --runInBand
```

Expected: FAIL because capacity reservation contract/state does not exist.

- [ ] **Step 8.2: Implement entitlement persistence and atomic reservation**

Use an admin-schema reservation row locked in the existing provisioning
transaction. Billing subscription limits carry the approved immutable
entitlement snapshot. Activation publishes TelemetryCapacityEntitlementChanged
through the low-rate transactional billing outbox. New tenant remains PENDING
and existing tenant keeps its prior version until activation.

- [ ] **Step 8.3: Admin calculator and usage metering**

Admin UI shows the device-count × interval × channel fan-out calculator and
writes the approved derived M/R values to the quote; the SENSOR_READINGS meter
reports committed actual row usage as the pricing input.

- [ ] **Step 8.4: Gate tier activation on LEGAL-HIGH-001**

Retention tier activation requires the recorded legal sign-off artifact; an
invariant blocks any tier activation while LEGAL-HIGH-001 is OPEN.

**Exit gate:** Capacity reservation live; over-envelope quotes stay
PENDING_CAPACITY; retention tier table remains PROPOSED until LEGAL-HIGH-001 closes.

**Rollback:** Disable capacity activation; quotes stay pending; prior
entitlements keep working until a resize/volume proof activates the new one.

**Alarms:** capacity-reservation backlog, entitlement-version lag, meter/usage
drift.

## Rollout Order

```text
Task 0
  → Task 1
  → Task 2
  → Task 3

Task 4 may start after Task 0 and run alongside Tasks 1–2,
but deletion remains disabled.

Task 8 runs fully parallel; no other task depends on it.

Tasks 1 + 2 + Task 3 pilot
  → Task 5
  → Task 6
  → retention pilot
  → rate-limited tenant groups
  → Task 7 final gate
```

## Definition of Done

- [ ] 100 active/reserved tenant entitlements fit the installed M/R/storage
      envelope; over-capacity requests remain PENDING_CAPACITY.
- [ ] 2K msg/s external steady run has zero missing admitted IDs, zero
      reconciliation difference and zero duplicate business effects.
- [ ] Full 60-minute outage buffer drains in at most 60 minutes.
- [ ] 15K×5-minute stress has no crash/OOM/corruption and every accepted/rejected
      message is accounted for.
- [ ] MQTT PUBACK is impossible before PG commit and required child/DLQ PubAck.
- [ ] Telemetry uses AQUACULTURE_TELEMETRY; domain events remain in
      AQUACULTURE_EVENTS.
- [ ] NATS ACL is generated from services.yaml and has no broad bare-root API
      permission.
- [ ] Rust sidecar uses tenant\_<16hex>, tenant RLS context and per-tenant sink.
- [ ] Node/Rust policy flip creates one logical downstream business effect.
- [ ] No raw chunk is dropped without an append-only VERIFIED archive chain.
- [ ] Professional and Enterprise cold RAW restore drills pass hash/count parity.
- [ ] WAL-G scratch restore reports RPO at most 300 seconds and retains
      greater-than-P90D aggregate data.
- [ ] Erasure covers broker queues, streams, DLQ, outboxes, caches, ledger and
      tenant bucket, subject to legal hold.
- [ ] Every phase has an executable rollback, delivered alarms, green tests,
      Closes traceability and pushed commits.
- [ ] Kafka, shard/router, shared telemetry hypertable and PgBouncer are absent
      from the production graph.

## Implementation Tracking

This document is the design-of-record and finding ledger. Implementation
workers update only checkbox/status/evidence fields in the same commit that
delivers the corresponding behavior. A checkbox is never marked complete from
code presence alone; its named test or operational artifact must be green and
linked.
