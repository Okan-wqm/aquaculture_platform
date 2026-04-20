# ADR-025: Rust Sidecar Architecture for sensor-service Ingestion

**Status:** Accepted (Faz 2 stage 14 — 2026-04-20)
**Date:** 2026-04-20
**Deciders:** Okan (platform owner) + sensor-service maintainers + sens-api-gateway maintainer
**Owner:** Okan
**Related plans:** `docs/plans/sensor-rust-migration/PLAN.md`
**Related ADRs:** ADR-006 (event flat pattern), ADR-011 (schema-per-tenant), ADR-014/015 (NATS cert-only auth)

---

## Context (WHY)

`sensor-service` (NestJS, 19,147 LoC) MQTT/LoRaWAN/OPC-UA/Modbus telemetri ingestion'ında ölçülmüş darboğazlara yaklaşıyor:

- Per-message UUID regex'i her çağrıda yeniden derleniyor (hot path'te ~30K eval/sn potansiyel @ 10K msg/sn).
- `buffer.splice(0, N)` ile flush dökümü 50-100ms V8 GC pause yaratabiliyor.
- TypeORM INSERT VALUES + 1000-row chunk; PostgreSQL COPY binary protokolü kullanılmıyor (TigerData benchmark: COPY 50-100× INSERT VALUES).
- Cache miss path 50+ tenant şemasında lineer tarama (`sensor-topic-cache.service.ts`).
- 113 dosyada 687× `as any` — type system bypass, multi-tenant boundary için risk.

Hedef: multi-tenant, başlangıç 1-10K msg/sn, **altyapı 100K msg/sn'e hazır** ve **aynı 512 MB / 0.5 vCPU bütçesinde**.

Edge tarafında zaten olgun bir Rust kod tabanı var (`sens-api-gateway`, 59,707 LoC, IEC 62443 SL2 hardened, `unwrap_used = "deny"`). Edge↔cloud arasında Modbus, LoRaWAN ve OPC-UA parser'ları ayrı dillerde — drift kaçınılmaz.

---

## Decision (WHAT)

Sensor-service ingestion path'i **ayrı bir Rust process** (`sensor-ingestion` sidecar) olarak konumlandırılır. NestJS `sensor-service` control plane (CRUD, GraphQL, schema migration, batch processor, continuous aggregate) olarak kalır. İki taraf NATS üzerinden konuşur.

### Reddedilen Alternatifler

| Alternatif | Reddetme nedeni |
|---|---|
| **NAPI-RS native module** (Rust kodu NestJS process'i içinde) | Rust panic NestJS process'ini öldürür (deploy resilience kaybı). N-API ABI farklı Node sürümleri ile kırılgan. Multi-arch (.node binary per platform/Node ABI) build complexity. Ortak crash domain test isolation'ı bozar. |
| **gRPC service** (HTTP/2 üzerinden) | ADR-014/015 NATS'i SSoT yapmış — ikinci bir transport ekstra auth yüzeyi açar (mTLS double pipeline). HTTP/2 RST flood class attack surface. Gateway zaten NATS değil yalnız MQTT konuşuyor; gRPC eklemek iki yeni stack birden. |
| **Tam rewrite (NestJS sensor-service'i Rust'a komple taşı)** | 6-12 ay engineering effort. Mevcut control-plane (GraphQL, calibration UI, NestJS DI) düşük QPS — Rust'ta ergonomik kayıp. Big-bang rewrite test/RBAC/audit coupling'lerinin tamamını yeniden çözmek demek. |

### Kabul Edilen Topology

```
┌──────────────────────────────┐         ┌──────────────────────────────┐
│ sensor-service (NestJS)      │         │ sensor-ingestion (Rust)      │
│  - GraphQL/REST              │         │  - rumqttc subscribe         │
│  - sensor/calibration CRUD   │  NATS   │  - protocol-codec parse      │
│  - BatchProcessor (kept)     │ ◄────── │  - tokio-postgres COPY       │
│  - hypertable + CAGG mgmt    │   mTLS  │  - async-nats publish event  │
│  - tenant context middleware │         │                              │
│  256 MB / 0.25 vCPU          │         │  256 MB / 0.25 vCPU          │
└──────────────────────────────┘         └──────────────────────────────┘
                  ▲                                       ▲
                  │ event consume (Faz 3)                 │ MQTT/QoS-1
                  ▼                                       │
        ┌─────────────────┐                         ┌────┴────┐
        │ TimescaleDB     │  ◄──── COPY ────────── │ broker  │
        └─────────────────┘                         └─────────┘
```

### Workspace Topolojisi

```
/var/aqua-saas/
├── Cargo.toml                  virtual workspace
├── crates/
│   ├── protocol-codec          drift-zero parser SSoT (ADR-026)
│   ├── tenant-context          compile-time tenant pinning
│   ├── event-contracts-rs      JSON Schema → Rust codegen
│   ├── nats-client             async-nats mTLS-only factory
│   └── observability           tracing + OTLP common
├── apps/
│   ├── sensor-service          NestJS, control plane
│   └── sensor-ingestion        Rust, hot-path sidecar
└── sens-api-gateway            standalone, paralel agent ownership;
                                Faz 4'te crate'leri path-dep ile alır
```

### Korunacak Mimari Özellikler

Aşağıdaki invariant'lar her fazda regression test ile doğrulanır; bozulursa BLOCKER:

1. Schema-per-tenant (ADR-011) — `e2e/tests/integration/schema-invariants.spec.ts`
2. NATS cert-only (ADR-014/015) — `e2e/tests/integration/nats-invariants.spec.ts` + Rust client
3. Event flat pattern (ADR-006) — `event-contracts-rs` codegen + clippy lint
4. Batch processor 500ms / 500-row semantik — `apps/sensor-service/src/ingestion/batch-processor.service.ts` (DOKUNULMAZ)
5. Continuous aggregate 1h/1d/7d — `apps/sensor-service/src/timescale/continuous-aggregate.service.ts`
6. SEC-M16 tenant-scoped cache — `apps/sensor-service/src/cache/sensor-topic-cache.service.ts`
7. JWT-first tenant context middleware
8. `getScopedRepository()` zorunlu (RLS), `getRepository()` yasak
9. `maskPii()` auto-mask (Rust tarafında `secrecy::Secret<T>` + tracing layer karşılığı)
10. Audit logs `shared.audit_logs`

### Faz Planı (özet)

| Faz | Süre | Çıktı | Açıklama |
|---|---|---|---|
| 0 PR-A | 1 hafta | Cargo workspace, Nx executor, rust-ci.yml, ADR draft | Sıfır runtime impact |
| 0 PR-B | 1 hafta | `docs/perf/baseline-2026-04.md` | BLOCKING — Faz 2 için baseline |
| 1 | 3-4 hafta | `protocol-codec` Modbus modülü | Drift-zero, golden fixture, fuzz |
| 2 | 4-6 hafta | `sensor-ingestion` sidecar MVP | Per-tenant feature flag, 50K msg/sn |
| 3 | 3-4 hafta | sensor-service küçültme | Control plane only, 192MB/0.2vCPU |
| 4 | 3 hafta | Konsolidasyon + ST sandbox | Gateway crate paylaşımı, duplicate purge |

---

## Consequences

**Positive:**
- Aynı 512 MB / 0.5 vCPU bütçede 5-10× ingestion kapasitesi.
- Edge↔cloud parser drift sıfır (`protocol-codec` SSoT).
- Compile-time multi-tenant isolation (`tenant-context` GhostCell pattern).
- Rust panic'i NestJS'i etkilemez; deploy + crash bağımsızlığı.
- Strangler fig: per-tenant feature flag, sıfır big-bang riski.

**Negative:**
- İki dil (TS + Rust); ekipte Rust bilgisi şu an tek geliştirici (Okan-Wqm) — bus factor 1.
  - Mitigasyon: gateway pattern reuse, clippy `unwrap_used = "deny"` disipline, pair sessions Faz 0'da.
- İki ayrı CI pipeline (Nx TypeScript + cargo).
  - Mitigasyon: `@aqua/cargo:run` Nx executor sayesinde `nx affected` Rust'ı da kapsar.
- Ek Docker image, ayrı deploy artefact.
  - Mitigasyon: distroless static image (~12-18 MB) — minimal attack surface.
- Faz 4'e kadar TS + Rust adapter parser'lar paralel; geçici duplicate.

**Neutral:**
- ADR-016 deploy resilience'a uyum: ek process ama rollback feature flag flip ile mümkün.
- ADR-014/015 NATS cert-only: yeni `sensor_ingestion` CN `infrastructure/nats/services.yaml`'a eklenir; mevcut CI invariant Rust client'ı da kapsar.
- ADR-006 event flat pattern: `event-contracts-rs` codegen sayesinde structurally enforced.

---

## Open Questions (DEC tracking)

1. **DEC-Rust-001**: COPY pipeline ON CONFLICT semantik — staging table (A) vs append-only (B). Edge'in re-publish davranışına bağımlı; product owner imzası gerekli (Faz 2 gate).
2. **DEC-Rust-002**: Faz 0 baseline 15K msg/sn'i sustained tutarsa Rust ROI yeniden değerlendirilecek. Saha + güvenlik kazanımları (drift-zero parser) tek başına yeterli mi?
3. **DEC-Rust-003**: Allocator A/B — mimalloc vs jemalloc; 0.5 vCPU container'da hangisi RSS fragmentation kazanır? Faz 2 benchmark.

---

## References

- `docs/plans/sensor-rust-migration/PLAN.md` — full migration plan
- `docs/plans/sensor-rust-migration/PROGRESS.md` — implementation log
- `Cargo.toml` (workspace root)
- `tools/executors/cargo/` — Nx custom executor
- `.github/workflows/rust-ci.yml`
