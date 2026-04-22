# Sensor-Service → Rust Hibrit Migrasyon Planı

> **Onay:** 2026-04-20 — bu dosya `/root/.claude/plans/bence-dogrulamaya-gerek-yok-snazzy-kazoo.md`
> dosyasındaki onaylı planın repo-içi sürümüdür. ADR referansları edge-agent
> ADR serisinin (ADR-019..ADR-024 zaten kullanılmıştır) çakışmaması için
> 025-029 aralığına kaydırılmıştır. İçerik diğer her açıdan birebirdir.

**Branch akışı:** `agentic` feature branch → her faz ayrı PR → GitHub Actions yeşil → CODEOWNERS approve → `main` merge. Force push yok, hook bypass yok.

---

## Context — Neden Bu Plan

**Problem:**
- `sensor-service` (NestJS, 19,147 LoC, 512MB/0.5vCPU bütçe) multi-tenant ingestion için fiziksel limite yaklaşıyor: UUID regex hotspot (~30K eval/sn potansiyel), `buffer.splice()` GC pressure (50-100ms pause), TypeORM `INSERT VALUES` 1000-row chunk (COPY'den 50-100× yavaş — TigerData benchmark), `O(50)` tenant schema scan cache miss'te, 687× `as any` (113 dosya).
- Hedef: multi-tenant, başlangıç 1-10K msg/sn, **altyapı 100K msg/sn'e hazır**, aynı 512MB/0.5vCPU bütçesinde.
- Edge'de zaten olgun Rust (`sens-api-gateway`, 59,707 LoC, IEC 62443 SL2, hardened, `unwrap_used = "deny"`). Edge↔cloud parser drift riski var (Modbus, LoRaWAN, OPC-UA hem TS hem Rust'ta yazılmış).

**Hedef Sonuç:**
- Aynı bütçede **5-10× ingestion kapasitesi** (Faz 2 sonu: 50K msg/sn sustained, Faz 4 sonu: 100K)
- Edge ve cloud **tek `protocol-codec` crate** — drift sıfır, field debug 5 dk
- Memory-safe binary parsing (Modbus CRC, LoRaWAN MIC) — buffer-overflow CVE class elimine
- `as any` ingestion path'inden sıfırlanır, compile-time tenant pinning
- Tüm mevcut mimari kazanımlar (SEC-M16, schema-per-tenant, mTLS cert-only, batch processor, continuous aggregate) **bozulmadan** korunur

**Mimari Karar:** Sidecar over NATS, NAPI-RS değil, gRPC değil. Detay → `docs/adr/_draft/025-rust-sidecar-architecture.md`.

---

## Workspace Topolojisi

```
/var/aqua-saas/
├── Cargo.toml                          # YENİ: virtual workspace
├── crates/                             # YENİ: paylaşılan Rust kod
│   ├── protocol-codec/                 # Modbus/LoRaWAN/OPC-UA/S7/EthernetIP parser
│   ├── tenant-context/                 # TenantId, SchemaName newtype + PhantomData scope
│   ├── event-contracts-rs/             # JSON Schema → Rust codegen (typify)
│   ├── nats-client/                    # async-nats mTLS factory (cert-only, ADR-015)
│   └── observability/                  # tracing + OTLP common config
├── apps/
│   ├── sensor-service/                 # MEVCUT — Faz 3'te küçülür (control plane)
│   └── sensor-ingestion/               # YENİ Rust binary (Faz 2)
└── sens-api-gateway/                   # MEVCUT (paralel agent yönetiyor) — Faz 4'te crate paylaşımı
```

**Nx ↔ Cargo:** `tools/executors/cargo/` custom executor, her crate `project.json` build/test/lint targetleri tanımlar; `nx affected` Rust'ı da kapsar.

---

## Korunacak Mimari Özellikler (her fazda regression test)

| # | Özellik | Kanıt dosya | Kayıp = BLOCKER |
|---|---|---|---|
| 1 | Schema-per-tenant (ADR-011) | `e2e/tests/integration/schema-invariants.spec.ts` | ✓ |
| 2 | NATS cert-only (ADR-014/015) | `e2e/tests/integration/nats-invariants.spec.ts` + Rust client coverage | ✓ |
| 3 | Event flat pattern (ADR-006) | clippy lint + `event-contracts-rs` codegen | ✓ |
| 4 | Batch processor 500ms/500-row | `apps/sensor-service/src/ingestion/batch-processor.service.ts` (DOKUNULMAZ) | ✓ |
| 5 | Continuous aggregate 1h/1d/7d | `apps/sensor-service/src/timescale/continuous-aggregate.service.ts` | ✓ |
| 6 | SEC-M16 tenant-scoped cache key | `apps/sensor-service/src/cache/sensor-topic-cache.service.ts` | ✓ |
| 7 | TenantContextMiddleware JWT-first | mevcut, dokunulmaz | ✓ |
| 8 | `getScopedRepository()` zorunlu, `getRepository()` yasak | mevcut | ✓ |
| 9 | `maskPii()` auto-mask (StructuredLogger) | Rust tarafında `secrecy::Secret<T>` + tracing layer | ✓ |
| 10 | Audit logs `shared.audit_logs` | yeni `vector_id` alanı zenginleşir | ✓ |

---

## Faz 0 — Setup + Baseline (1 hafta, 2 paralel PR)

### PR-A: Repo Scaffold (sıfır runtime impact)
- `Cargo.toml` virtual workspace
- 5 crate iskeleti (`#![forbid(unsafe_code)]` + workspace lints)
- `tools/executors/cargo/` Nx custom executor
- `.github/workflows/rust-ci.yml`: fmt/clippy/test/deny/audit + musl cross-build matrix
- `docs/adr/_draft/025-rust-sidecar-architecture.md`
- `docs/adr/_draft/026-protocol-codec-ssot.md`
- Bu plan dosyası (`docs/plans/sensor-rust-migration/PLAN.md`)
- Implementation log (`docs/plans/sensor-rust-migration/PROGRESS.md`)

**CI gate:** `cargo test --workspace` boş ama yeşil. Nx affected Rust target'ları algılıyor.
**Rollback:** 1 PR revert.

### PR-B: Baseline Ölçüm (BLOCKING — sayısız Faz 2 başlamaz)
**Yük üretici:** `tools/scripts/perf-baseline.ts` — `mqtt-bench` veya custom tokio MQTT publisher (50 tenant × 200 sensor × 10 channel sentetik).
**Profil:** 1K, 5K, 10K, 15K msg/sn, her seviyede 5 dk sürdürülebilir + 30sn 2× burst.

**Ölçülecek (Prometheus + custom):**
| Metrik | Yöntem |
|---|---|
| p50/p95/p99 ingestion latency | payload `producer_ts` → DB `now() - producer_ts` |
| RSS + V8 heap | `process.memoryUsage()` |
| GC pause | `--trace-gc` + `perf_hooks.PerformanceObserver` `gc` |
| DB commit latency | `pg_stat_statements.mean_exec_time` filtered INSERT sensor_metrics |
| MQTT inflight QoS-1 | mosquitto/EMQ exporter |
| Drop sayısı | NEGATIVE_CACHE hit, validation drop |

**Profiling:** `clinic.js flame` Node process'te → regex/splice/JSON.parse hot doğrula. `pg_stat_statements` ile gerçek INSERT exec time. `perf record -g` container içinde.

**Çıktı:** `docs/perf/baseline-2026-04.md`. Bu olmadan Faz 2 başlamaz.

**Karar gate:** Eğer baseline 15K msg/sn'i sustained tutuyorsa Rust ROI yeniden değerlendirilir (saha + güvenlik kazanımları yine geçerli kalır — sidecar kararı tek başına performansla sınırlı değil).

---

## Faz 1 — `protocol-codec` Crate (3-4 hafta, 1 PR)

**Hedef:** En yüksek code reuse + güvenlik kazanımı. Edge ve cloud aynı binary semantiği paylaşmak zorunda. Detay → `docs/adr/_draft/026-protocol-codec-ssot.md`.

### Deliverable
- **`crates/protocol-codec/`** — pure functions, no I/O
- İlk modül: `modbus` (TCP/RTU/ASCII). `decode_holding_registers(bytes, spec) -> Result<NormalizedValue, ParseError>`
- `nom` parser, `bytes::Buf` checked indexing, `#![forbid(unsafe_code)]`
- CRC-16-Modbus implementation (gateway `sens-api-gateway/src/modbus.rs` referans, kopyalanmaz — paralel agent yönetiyor)
- Function code whitelist `[0x01,0x02,0x03,0x04,0x05,0x06,0x0F,0x10]`
- `enum ParseError { LengthMismatch, BadCrc, UnsupportedFc(u8), Truncated, TenantMismatch }`
- 50+ golden fixture (`crates/protocol-codec/tests/golden/`) — hex dump + beklenen JSON
- `cargo-fuzz` target + 24 saat AFL run hedef = 0 crash
- `proptest` roundtrip: encode→decode 1M random byte → no panic, only `Err` veya valid frame

### Drift Test (CI INVARIANT)
- `tools/scripts/check-codec-drift.sh` — aynı golden fixture set'i hem Rust hem TS testleri okur
- TS side: `apps/sensor-service/src/protocol/adapters/__tests__/codec-drift.spec.ts` mevcut `ModbusTcpAdapter` ile decode → byte-eşit çıktı assert
- CI'da çıktı diff = exit 1

### Sonraki Modüller (aynı PR'da değil, takip PR'larında)
- `lorawan` (PHY decrypt + FPort routing — gateway `sens-api-gateway/src/lora/codec.rs` semantik referans)
- `opcua_node`, `s7_db`, `ethernet_ip_cip`

### Threat Coverage
- **CVE-2024-10918 sınıfı** (libmodbus stack-based buffer overflow) — compile-time elimine
- **Modbus length-confusion** — `nom` checked length parser
- **LoRaWAN MIC bypass** — `lorawan-encoding` crate + `secrecy::Secret<AppSKey>`

**CI gate:** `cargo test`, `cargo clippy -- -D warnings`, codec-drift.sh = 0 diff, fuzz 30dk smoke.
**Rollback:** Crate workspace member'dan çıkar, NestJS adapter'lar etkilenmez.
**ADR:** 026 promote to Accepted.

---

## Faz 2 — `sensor-ingestion` Rust Sidecar (4-6 hafta, 1 PR)

**Hedef:** En yüksek performans ROI. Aynı 0.25 vCPU + 256 MB ile **50K msg/sn sustained**.

### Kapsam (sadece bu pipeline Rust'a)
1. MQTT subscribe (`sensors/#`, `tenants/+/devices/+/io_data`)
2. Topic parse + tenant/sensor resolution (cache-backed)
3. Payload validate (UUID, range, quality code, **topic↔payload tenantId eşleşme** — Vektör 2 mitigation)
4. Batch buffer
5. **TimescaleDB binary COPY** (`tokio-postgres::CopyInSink`)
6. NATS event publish (`@platform/event-contracts` flat — `event-contracts-rs` codegen ile)

**Kapsam DIŞI:** sensor CRUD, schema migration, GraphQL API, automation/ST compile (Faz 4), continuous aggregate management, edge command, calibration, alarm engine — hepsi NestJS sensor-service'te kalır.

### Crate Seçimleri (kanıtlı, tahmin değil)

| Sorun | Crate | Gerekçe |
|---|---|---|
| Async runtime | **tokio 1.43** | gateway ile aynı |
| MQTT | **rumqttc 0.25** | gateway zaten kullanıyor, pure Rust + rustls |
| TLS | **rustls** | gateway tutarlı, no OpenSSL |
| Concurrent cache | **papaya** | read-heavy 99:1 workload, DashMap'ten read throughput üstün, predictable latency (seqlock-based lock-free read) |
| Topic match | manual zero-alloc parser + `papaya<TenantId, Vec<Pattern>>` | AOT compile `Vec<Segment>` enum (Plus/Hash/Literal), byte-by-byte slice walk |
| UUID validate | **uuid 1.x** `Uuid::try_parse` | regex değil — strict 36-byte parser, 0 allocation, ~10ns vs JS regex ~500ns + 3 alloc |
| String interning | **lasso 0.7** | gateway zaten kullanıyor, `Spur` u32 interned key |
| Buffer/payload | **bytes::Bytes** | rumqttc zero-copy döner, hot path'te `String` dönüşüm YASAK |
| JSON parse | **simd-json** veya **sonic-rs** | serde_json'dan 2-3× hızlı (AVX2/NEON) |
| Postgres | **tokio-postgres** + **`CopyInSink`** binary | TigerData: COPY 50-100× INSERT |
| Postgres TLS | **tokio-postgres-rustls-improved** + `sslmode=verify-full` + SCRAM channel binding | Vektör 9 mitigation |
| Connection pool | **deadpool-postgres** | bb8'den düşük overhead |
| NATS | **async-nats 0.37+** | mTLS + cert CN auth (`add_client_certificate`, ADR-014/015 uyumlu) |
| Metrics | **metrics + metrics-exporter-prometheus** | atomik counter/histogram |
| Tracing | **tracing** + JSON subscriber | gateway uyumlu, NestJS pino formatına uyarlanır |
| Profiling | **tokio-console** + **pprof-rs** | `/debug/pprof/profile` flamegraph endpoint |
| Allocator | **mimalloc** vs **jemalloc** | 0.5 vCPU container'da glibc fragmentation; A/B benchmark |

### Tokio Runtime Tuning
- `worker_threads = 2` (0.35 vCPU bütçesi → fazlası context switch)
- `max_blocking_threads = 8` (DB COPY blocking pool ayrı)
- `enable_lifo_slot()` — local task locality
- `thread_stack_size = 256 * 1024`
- **NO** `spawn_blocking` hot path'te

### Mimari (single binary)
```
rumqttc EventLoop ──► tokio::mpsc<Bytes> (cap 50K)
   │
   ▼
N × parse worker (tokio task)
   │  topic_parse (zero-alloc, slice walk)
   │  papaya.get((TenantId, TopicSpur)) → Arc<SensorMeta>
   │  validate (uuid::try_parse, range, quality, topic↔payload tenant bind)
   │  push → channel<MetricRow>
   ▼
Batch aggregator (1 task, time + size triggered)
   ├─ flush_at_size: 10_000 rows
   ├─ flush_at_interval: 100ms
   └─► COPY worker pool (4 connection)
        binary tuple encode → CopyInSink
        ▼
        NATS publisher (async-nats, ADR-006 flat events)
        Cache invalidate listener (NATS subscribe)
```

### Multi-Tenant Cache (SEC-M16 KORUNUR + güçlendirilir)
- `papaya<(TenantId, TopicSpur), Arc<SensorMeta>>` — key tenant-scoped
- Cross-tenant mismatch derleme zamanı engelli: `Scoped<'t, T>` lifetime branding (GhostCell pattern), `PhantomData<&'t TenantId>`
- Cache miss: NATS request-reply `sensor.lookup.by-topic` → sensor-service Redis SSoT, sidecar L2 cache
- Negative cache: `moka` TTL 30s
- Per-tenant token-bucket (`governor` crate) — DoS mitigasyonu
- Bounded per-tenant LRU max 10K entry

### COPY Pipeline ON CONFLICT Karar (Faz 2 Gate)
Mevcut: `INSERT ... ON CONFLICT DO UPDATE SET value/raw_value/quality_code = EXCLUDED.*`.
COPY'de `ON CONFLICT` yok. **2 seçenek, product owner imzası gerekli:**
- **(A)** UNLOGGED staging table: `COPY → sensor_metrics_stage` → `INSERT ... ON CONFLICT DO UPDATE; TRUNCATE stage`. Tek round-trip ekstra; semantic 1:1 korunur.
- **(B)** Append-only kabul edilirse, COPY direkt + duplicate'leri loglayıp drop. Daha hızlı ama davranış değişikliği.

### TimescaleDB Chunk Retune (paralel PR, lock-free)
- Mevcut yük (1-10K msg/sn): 1 saat
- 100K hedefe yaklaşırken: 5 dk
Yeni migration: `V015__retune_sensor_metrics_chunk.sql` → `set_chunk_time_interval('sensor_metrics', INTERVAL '1 hour')`.

### Deployment + Strangler Fig
- Yeni compose service `sensor-ingestion` (256 MB / 0.25 vCPU)
- NestJS sensor-service paralel çalışır
- Per-tenant feature flag: `INGEST_BACKEND=rust|node`
- Rollback: feature flag flip

### Başarı Kriterleri (sayısal, sıkı)
| Metrik | Hedef | Ölçüm |
|---|---|---|
| Sustainable throughput | **≥ 50K msg/sn** | yük üretici 10 dk |
| p99 ingestion latency | **< 10ms @ 50K msg/sn** | producer_ts → db_commit_ts |
| RSS memory | **≤ 256 MB** | docker stats |
| CPU | **≤ 0.35 vCPU** | container limit |
| Allocation/msg | **< 100 bytes** hot path | `dhat` heap profile |
| Syscall/msg | **< 1** (batch amortized) | `strace -c` 60sn |
| Veri kaybı | **0 mesaj** crash/restart | broker QoS-1 inflight redelivery test |

### Test
- `tests/integration/dual-write-equivalence.spec.ts` — aynı MQTT mesajı iki backend'e gider, NATS event byte-eşit
- `criterion` benchmark suite: topic_parse, uuid_validate, copy_batch_encode (per-PR diff regression)
- `cargo flamegraph --bin sensor-ingestion` CI nightly

**CI gate:** Tüm Faz 1 gate'leri + dual-write 24h soak test = drift 0.
**Rollback:** Feature flag `INGEST_BACKEND=node` global.
**ADR:** 027 — `Per-tenant ingest backend toggle`.

---

## Faz 3 — Sensor-Service Küçültme (3-4 hafta, 1 PR)

**Hedef:** NestJS sensor-service control plane'e indirgenir. Bütçe normale döner.

### Değişiklik
- **Servis adı KORUNUR** (`sensor-service`) — schema ownership ADR-011 kırılmaz
- İç modül rename: `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` deprecated
- Yeni: `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts` — Rust event'i tüketir → `BatchProcessorService.enqueue()` (KORUNUR)
- Protocol adapter'lar `parse()` `@deprecated`, `validate()`/schema/UI metadata korunur
- Module loader profile: `SENSOR_SERVICE_PROFILE=control-plane` env

### Yeni Sorumluluklar (sensor-service)
- Control plane: sensor CRUD, calibration, retention policy
- Persistence: BatchProcessor + TimescaleDB hypertable + continuous aggregate (KORUNUR)
- Aggregation queries: GraphQL resolvers
- Cache miss request handler (NATS reply)

### Bütçe
- NestJS 192 MB / 0.2 vCPU (down from 512/0.5)
- Rust ingestion 192 MB / 0.25 vCPU
- Headroom 128 MB / 0.05 vCPU

### Test
- `e2e/tests/sensor-ingest-equivalence.e2e.ts` 24h soak, drift counter = 0
- Mevcut 24 spec + ~890 test case **tümü yeşil**

**CI gate:** schema-invariants + nats-invariants + dual-write equivalence = pass.
**Rollback:** Module loader profile reset, NATS consumer disable.
**ADR:** 028 — `Sensor-service control/data plane separation`.

---

## Faz 4 — Konsolidasyon (3 hafta, 1 PR — paralel agent ile koordinasyonlu)

**Hedef:** Duplicate kod sıfırlanır, edge ve cloud aynı crate'leri paylaşır.

### Adımlar
1. `sens-api-gateway/Cargo.toml` `protocol-codec` ve `event-contracts-rs` path-dep alır
2. Gateway içindeki `modbus.rs` parsing kodu silinir
3. Gateway `lora/codec.rs` → `protocol-codec/src/lorawan` ile birleştirilir
4. ST compiler: TS Piscina worker silinir, NATS request-reply `scripts.compile`
5. PLC kontrol komutları: TS implementation silinir
6. `apps/sensor-service/src/protocol/adapters/` parser kodları purge — sadece config validation + UI metadata
7. **`as any` sweep:** Rust path'lerine geçen kod sıfırlanır + ESLint custom rule

### ST Sandbox Güçlendirme
- `wasmtime` engine: `consume_fuel`, `epoch_interruption`, memory limit 16 MiB, sıfır WASI capability
- Tenant başına ayrı `Engine`/`Store`
- Timeout: epoch tick 100 ms, tenant script max 50 ms CPU

### Hot Tenant Sharding (100K hedefe son adım)
- Parse worker'lar consistent-hash by tenant_id
- Benchmark: tek tenant 50K msg/sn, 100 tenant 1K msg/sn karma

### Hypercore (Columnar Compression)
- Chunk'lar 24h sonrası columnar — disk %80-90 tasarruf

### Başarı Kriterleri (Faz 4 final)
| Metrik | Hedef |
|---|---|
| Sustainable throughput | **≥ 100K msg/sn** |
| p99 latency | **< 5ms** |
| Total RSS (sidecar + node) | **≤ 480 MB** (32 MB headroom) |
| CPU | **≤ 0.45 vCPU** (5% headroom) |
| Burst tolerance | **2× = 200K msg/sn 30sn** zero loss |
| `as any` count (ingestion path) | **0** |
| Duplicate parser kod (TS+Rust) | **0** |

**CI gate:** tüm önceki gate'ler + edge agent compatibility test.
**Rollback:** Gateway agent versiyonu pin downgrade.
**ADR:** 029 — `Edge agent shared crate adoption`.

---

## Threat Coverage Matrisi

| Vektör | Faz 0 (TS) | Faz 1 | Faz 2 | Faz 3 | Faz 4 |
|---|---|---|---|---|---|
| 1 binary frame DoS/corruption | Açık | KAPALI | — | — | — |
| 2 topic↔payload tenant bind | Açık | — | KAPALI | — | — |
| 3 prototype pollution | Açık | — | KAPALI | — | — |
| 4 cache flood DoS | Açık | — | KAPALI | — | — |
| 5 zombie subscription | Açık | — | KAPALI | — | — |
| 6 schema name SQLi | Açık | — | KAPALI | — | — |
| 7 SEC-M16 cache | KAPALI | KAPALI | KAPALI+ | KAPALI+ | KAPALI+ |
| 8 ST language sandbox | Açık | — | — | — | KAPALI |
| 9 PG mTLS verify-full | Açık | — | KAPALI | — | — |
| 10 PII log leak | Kısmi | — | KAPALI | KAPALI+ | KAPALI+ |

---

## Critical Files for Implementation

**Yeni (oluşturulacak):**
- `Cargo.toml` (workspace manifest) ✓ Faz 0 PR-A
- `crates/protocol-codec/` ✓ skeleton in Faz 0 PR-A
- `crates/tenant-context/` ✓
- `crates/event-contracts-rs/` ✓
- `crates/nats-client/` ✓
- `crates/observability/` ✓
- `apps/sensor-ingestion/` (Faz 2)
- `tools/executors/cargo/` ✓ Faz 0 PR-A
- `.github/workflows/rust-ci.yml` ✓ Faz 0 PR-A
- `database/migrations/modules/sensor/V015__retune_sensor_metrics_chunk.sql` (Faz 2)
- `docs/adr/_draft/025-rust-sidecar-architecture.md` ✓ Faz 0 PR-A
- `docs/adr/_draft/026-protocol-codec-ssot.md` ✓ Faz 0 PR-A
- `docs/adr/_draft/027-per-tenant-ingest-backend-toggle.md` (Faz 2)
- `docs/adr/_draft/028-sensor-service-control-data-separation.md` (Faz 3)
- `docs/adr/_draft/029-edge-agent-shared-crate-adoption.md` (Faz 4)
- `docs/perf/baseline-2026-04.md` (Faz 0 PR-B)

**Değişecek:**
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (Faz 3)
- `apps/sensor-service/src/cache/sensor-topic-cache.service.ts` (Faz 2 — semantik korunur)
- `apps/sensor-service/src/protocol/adapters/industrial/modbus-{tcp,rtu,ascii}.adapter.ts` (Faz 4)
- `apps/sensor-service/src/protocol/adapters/wireless/lorawan.adapter.ts` (Faz 4)
- `infrastructure/nats/services.yaml` (Faz 2 — `sensor_ingestion` CN eklenir)
- `docker-compose.droplet.yml`, `docker-compose.staging.yml`, `docker-compose.prod.yml` (Faz 2)
- `database/migrations/modules/sensor/V002__create_hypertable.sql` (chunk interval V015 ile)

**DOKUNULMAZ (invariant 1-10):**
- `apps/sensor-service/src/ingestion/batch-processor.service.ts`
- `apps/sensor-service/src/timescale/continuous-aggregate.service.ts`
- `apps/sensor-service/src/timescale/hypertable.service.ts`
- `libs/backend-common/src/utils/service-identity.util.ts`
- `libs/event-contracts/src/schemas/`

**Referans (paralel agent yönetiyor, dokunma):**
- `sens-api-gateway/src/modbus.rs`
- `sens-api-gateway/src/lora/codec.rs`
- `sens-api-gateway/src/mqtt.rs`
- `sens-api-gateway/Cargo.toml`

---

## Verification (E2E)

### Faz 0 PR-A
```bash
nx affected --target=test           # Rust target'lar dahil
cargo clippy --workspace -- -D warnings
cargo deny check
```

### Faz 0 PR-B
```bash
docker compose -f docker-compose.droplet.yml up -d sensor-service
ts-node tools/scripts/perf-baseline.ts --rate 5000 --duration 300
cat docs/perf/baseline-2026-04.md
```

### Faz 1
```bash
cargo test -p protocol-codec
cargo fuzz run modbus_decode --max-total-time=1800
bash tools/scripts/check-codec-drift.sh
nx test sensor-service --testPathPattern=codec-drift
```

### Faz 2
```bash
docker compose up -d sensor-ingestion
INGEST_BACKEND=rust ts-node tools/scripts/perf-baseline.ts --rate 50000 --duration 600
nx test sensor-service --testPathPattern=dual-write-equivalence
cargo bench -p sensor-ingestion --bench ingest_pipeline
```

### Faz 3
```bash
SENSOR_SERVICE_PROFILE=control-plane docker compose up -d sensor-service
nx test sensor-service
nx run-many --target=test --projects=sensor-service,sensor-ingestion
```

### Faz 4
```bash
nx affected --target=test
cargo test --workspace
bash tools/scripts/check-codec-drift.sh
```

---

## Risk Register

| Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|
| Rust takım bus-factor=1 | Yüksek | Yüksek | Faz 0'da pair, gateway pattern reuse, `unwrap_used = "deny"` |
| ON CONFLICT semantik değişimi | Orta | Yüksek | Faz 2 gate'inde A/B kararı, regression test |
| Sidecar OOM kill | Orta | Orta | mimalloc + bounded channel |
| NATS mTLS cert CN drift | Düşük | Yüksek | services.yaml SSoT, CI invariant |
| Veri kaybı broker drop | Orta | Yüksek | rumqttc QoS-1 + persistent session |
| Chunk retune lock | Düşük | Düşük | `set_chunk_time_interval` lock-free |
| Faz 0 baseline 50K+ çıkar | Düşük | (proje iptal — iyi haber) | Bütçe sadece Faz 0'a harcanır |
| `sens-api-gateway` paralel agent çatışması | Orta | Orta | Faz 4'e kadar gateway dokunulmaz, koordineli PR |
| Multi-platform binary build | Düşük | Orta | Cross.toml gateway zaten kullanıyor |

---

## Commit/PR Akışı

**Branch:** `agentic` (mevcut)

| Faz | PR | İlk commit |
|---|---|---|
| 0-A | `agentic-rust-faz0` → agentic | feat(rust-workspace): cargo virtual workspace + 5 crate skeletons |
| 0-B | TBD | chore(perf): sensor-service ingestion baseline measurement |
| 1 | TBD | feat(protocol-codec): modbus tcp/rtu/ascii drift-zero crate |
| 2 | TBD | feat(sensor-ingestion): rust mqtt → copy → nats sidecar (per-tenant toggle) |
| 3 | TBD | refactor(sensor-service): control plane separation, nats consumer |
| 4 | TBD | refactor: protocol-codec adoption + duplicate purge + st sandbox |

Her PR: GitHub Actions yeşil → CODEOWNERS approve → `main` merge. Force push yasak. Hook bypass yasak.

---

## Açık Karar (product owner imzası bekleniyor)

1. **Faz 2 ON CONFLICT seçimi** (A: staging table, B: append-only). Şu anki davranış: re-publish'te value/raw_value/quality_code güncelleniyor. Edge'in bu davranışa bağımlı olup olmadığı kontrol edilmeli.
2. **Faz 0 baseline gate katılığı:** sustained 15K msg/sn'in altındaysa Faz 2'yi başlat; üstündeyse Rust ROI yeniden değerlendir (ama altyapı hazırlığı anlamlı kalır — saha ve güvenlik kazanımları yine geçerli).
