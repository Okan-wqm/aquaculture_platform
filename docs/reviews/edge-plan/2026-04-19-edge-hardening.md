# Edge Plan — Finding Board (2026-04-19)

**Plan referansı:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` (Steel-Grade Consolidation Plan)
**Bağımlı planlar:**
- `/root/.claude/plans/pure-tickling-crescent.md` (Plan A — feature, arşivlenecek Faz 10)
- `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` (Plan B — hardening, arşivlenecek Faz 10)

**Sahip:** Okan (platform owner)
**Board açılış tarihi:** 2026-04-19

---

## State Machine

| State | Anlamı |
|---|---|
| OPEN | Raporlanmış, commit yok |
| IN-PROGRESS | Implementation planner paketi içinde, commit pending |
| RESOLVED | Merged commit matching `Closes:` line taşıyor |
| STALE | 30 gün OPEN, haftalık eskalasyon |
| BLOCKED | Fix attempt fail veya architectural-arbiter eskalasyonu |
| SUPERSEDED | Yeni karar tarafından değiştirildi |

**Commit convention:**
```
{type}({scope}): {subject}

{body — why, not what}

Closes: docs/reviews/edge-plan/2026-04-19-edge-hardening.md#FINDING-ID
```

---

## Bulgular — ARC (Architectural / Wiring)

| ID | Başlık | Severity | State | Owner | Faz | Deadline | Kanıt |
|---|---|---|---|---|---|---|---|
| ARC-001 | FailoverManager dead code; `state.failover_manager` her zaman `None` | HIGH | OPEN | TBD | Faz 1 | 2026-05-17 | `mqtt_failover.rs:1 #![allow(dead_code)]`, `commands.rs:3360` |
| ARC-002 | OfflineQueue publish path'e bağlı değil | HIGH | OPEN | TBD | Faz 1 | 2026-05-17 | `grep OfflineQueue::new` yalnız `offline_queue.rs:1493,1504,1515` |
| ARC-003 | `start_health_server` çağrılmıyor, feature gate arkasında | MEDIUM | OPEN | TBD | Faz 1 | 2026-05-17 | `grep start_health_server` main.rs'te 0 |
| ARC-004 | `pwm.rs`, `spi.rs` actor'lar CommandHandler'a wire edilmedi | MEDIUM | OPEN | TBD | Faz 1 | 2026-05-17 | `pwm.rs:20`, `spi.rs:22` TODO |
| ARC-005 | `st_validator.rs` AST üretiyor ama interpreter yok | HIGH | OPEN | TBD | Faz 3 | 2026-06-07 | Superseded by ADR-017 decision; runtime = bytecode VM |
| ARC-006 | Default build `--features gpio` olmadan I2C simülasyon, sahte `Good` quality publish | HIGH | OPEN | TBD | Faz 1 | 2026-05-17 | `i2c.rs:510-528` |
| ARC-007 | `rodbus = "=1.4.0"` exact pin + empty-path workaround | MEDIUM | OPEN | TBD | Faz 1 | 2026-05-17 | `Cargo.toml:64-70` |
| ARC-008 | `commands.rs` god-file (4392 satır) | MEDIUM | OPEN | TBD | Faz 1 | 2026-05-17 | wc -l |
| ARC-009 | `#![allow(dead_code)]` 12 dosyada (plan 3 sayıyordu — envanter hatası) | MEDIUM | OPEN | TBD | Faz 1 | 2026-05-17 | grep audit |

**12 dead_code dosyası (ARC-009 envanter):**

1. `mqtt_failover.rs` — WIRE (Faz 1.2)
2. `offline_queue.rs` — WIRE (Faz 1.3)
3. `health.rs` — WIRE (Faz 1.4)
4. `pwm.rs` — ADR-020 envanter sonrası karar
5. `spi.rs` — ADR-020 envanter sonrası karar
6. `alarms.rs` — WIRE (Faz 1, alarm class hiyerarşi Faz 10 opsiyonel)
7. `backup.rs` — WIRE (config backup/restore; GDPR Art 20 edge portability)
8. `interning.rs` — WIRE (PRF-006 hot-path allocation, Faz 3)
9. `bounded.rs` — WHITELIST (utility; new code user)
10. `error.rs` — WHITELIST (utility; new code user)
11. `security.rs` — WIRE + expand (Faz 2'de signature/policy/audit modülleri)
12. `shutdown.rs` — ACTIVE (no marker; no action)

---

## Bulgular — SEC (Security)

| ID | Başlık | Severity | State | Owner | Faz | Deadline | Kanıt |
|---|---|---|---|---|---|---|---|
| SEC-001 | RBAC yok — `execute()` direkt dispatch | CRITICAL | OPEN | TBD | Faz 2 | 2026-05-31 | `commands.rs:250-515` — superseded by ADR-018 |
| SEC-002 | Firmware imza doğrulaması yok (sadece SHA-256) | CRITICAL | OPEN | TBD | Faz 2 | 2026-05-31 | `commands.rs:696-1008` — superseded by ADR-019 |
| SEC-003 | mTLS client cert opsiyonel, silent single-side fallback | HIGH | OPEN | TBD | Faz 2 | 2026-05-31 | `mqtt.rs:728-741` |
| SEC-004 | SQLCipher key = HMAC(secret, machine-id); machine-id world-readable | HIGH | OPEN | TBD | Faz 2 | 2026-05-31 | `offline_queue.rs:41-59` — superseded by ADR-019 |
| SEC-005 | Provisioning token base64 (encoding ≠ encryption) | MEDIUM | OPEN | TBD | Faz 2 | 2026-05-31 | `config.rs:36-73` |
| SEC-006 | Command replay dedup VecDeque bounded, TTL değil, reboot'ta kaybolur | HIGH | OPEN | TBD | Faz 2 | 2026-05-31 | `commands.rs:316-339`, `mqtt.rs:335-348` |
| SEC-007 | Audit log post-execution, persistent sink yok, HMAC chain yok | HIGH | OPEN | TBD | Faz 2 | 2026-05-31 | `commands.rs:380-388` |
| SEC-008 | Modbus TLS default `false` | MEDIUM | OPEN | TBD | Faz 2 | 2026-05-31 | `config.rs` default |

---

## Bulgular — PRF (Performance)

| ID | Başlık | Severity | State | Owner | Faz | Deadline | Kanıt |
|---|---|---|---|---|---|---|---|
| PRF-001 | Atlas EZO 4 probe sequential = 3600ms > 1000ms interval | HIGH | OPEN | TBD | Faz 3 (Plan'ın Faz uzantısı — Faz 4 sonrası perf sprint) | 2026-07-05 | `io_poll.rs:41`, `atlas_ezo.rs:42-43` |
| PRF-002 | I2C blocking `rppal::i2c::I2c::block_read` async context'te, `spawn_blocking` yok | HIGH | OPEN | TBD | Perf sprint | 2026-07-05 | `i2c.rs:160-163, 344-406` |
| PRF-003 | ProcessImage tek `Arc<RwLock<Inner>>` | MEDIUM | OPEN | TBD | Perf sprint | 2026-07-05 | `process_image.rs:149-156` |
| PRF-004 | `io_poll.rs` configs O(N×M) lookup | MEDIUM | OPEN | TBD | Perf sprint | 2026-07-05 | `io_poll.rs:68-99` |
| PRF-005 | Modbus bulk-read yok; connection pool yok | HIGH | OPEN | TBD | Perf sprint | 2026-07-05 | `modbus.rs:815-844` |
| PRF-006 | Hot-path `format!`/`clone()`/`serde_json::to_value` allocate per-tick | MEDIUM | OPEN | TBD | Perf sprint | 2026-07-05 | `io_poll.rs`, `mqtt.rs:562-593` |
| PRF-007 | `MissedTickBehavior::Skip` + overrun sayacı telemetry'de yok | MEDIUM | OPEN | TBD | Perf sprint | 2026-07-05 | `io_poll.rs:32-50` |
| PRF-008 | `Cargo.toml` release profili `target-cpu` yok | LOW | OPEN | TBD | Perf sprint | 2026-07-05 | `Cargo.toml [profile.release]` |

---

## Bulgular — TST (Test coverage)

| ID | Başlık | Severity | State | Owner | Faz | Deadline | Kanıt |
|---|---|---|---|---|---|---|---|
| TST-001 | E2E MQTT↔edge↔Modbus roundtrip yok | HIGH | OPEN | TBD | Faz 9 | 2026-09-15 | `tests/` dizini — 26 senaryo eklenecek |
| TST-002 | `stress_test.rs`, `resource_benchmark.rs` `#[ignore]` ile CI'dan izole | MEDIUM | OPEN | TBD | Faz 9 | 2026-09-15 | `#[ignore]` kaldır + CI nightly |
| TST-003 | Attacker kill-chain senaryoları kod test olarak yok | HIGH | OPEN | TBD | Faz 9 | 2026-09-15 | 10 kill-chain E2E eklenecek |
| TST-004 | Fault injection (broker down, disk full, cert expired) yok | HIGH | OPEN | TBD | Faz 9 | 2026-09-15 | Chaos harness + 5 resilience E2E |
| TST-005 | Plan testleri yazılmamış (21 feature testi + 6 perf testi) | HIGH | OPEN | TBD | Faz 3-9 | 2026-09-15 | Plan A §9 + Plan B §2.7 |
| TST-006 | Invariant test suite yok | HIGH | OPEN | TBD | Faz 1-9 | 2026-09-15 | 15+ invariant test planda |
| TST-007 | Contract tests platform ↔ edge yok | HIGH | OPEN | TBD | Faz 8 | 2026-08-16 | `e2e/tests/contract/` dizini yok |
| TST-008 | Migration tests yok (v1.6.0 → v2.0.0 config/DB) | HIGH | OPEN | TBD | Faz 9 | 2026-09-15 | `tests/migration/` dizini yok |
| TST-009 | Fuzz targets yok | MEDIUM | OPEN | TBD | Faz 9 | 2026-09-15 | 7 fuzz target planda |
| TST-010 | Kani formal verification harness yok | MEDIUM | OPEN | TBD | Faz 3-9 | 2026-09-15 | 3 harness planda (safe_state_reachable, rbac_non_bypass, gas_budget_saturating) |

---

## Bulgular — DEC (Architectural Decisions)

| ID | Başlık | Severity | State | Owner | Faz | Deadline | Çözüm |
|---|---|---|---|---|---|---|---|
| DEC-001 | ST runtime kararı: AST walker mı bytecode VM mi? | CRITICAL | RESOLVED | Okan | Faz 0 | 2026-05-03 | ADR-017 — Bytecode VM + gas metering |
| DEC-002 | Firmware update stratejisi: atomic_swap vs A/B | CRITICAL | OPEN | TBD | Faz 0 | 2026-05-03 | ADR-019 pending |
| DEC-003 | Master key: TPM → systemd-creds → file fallback | HIGH | OPEN | TBD | Faz 0 | 2026-05-03 | ADR-019 pending |
| DEC-004 | RBAC model: 4 sabit rol vs ABAC permission-set | CRITICAL | RESOLVED | Okan | Faz 0 | 2026-05-03 | ADR-018 — ABAC + 3-key segregation + tenant binding |
| DEC-005 | PWM/SPI wire mi, kaldır mı? | MEDIUM | OPEN | TBD | Faz 0 | 2026-05-03 | ADR-020 envanter sonrası |
| DEC-006 | mTLS migration: legacy → warn → strict zamanlama | HIGH | OPEN | TBD | Faz 0 | 2026-05-03 | ADR-019 (partial) — 150 gün tablosu planda |
| DEC-007 | Clock authority: NTS deployment | MEDIUM | OPEN | TBD | Faz 2 | 2026-05-31 | Plan §3 R-13 |
| DEC-008 | Platform key ceremony: HSM seçimi + rotation | HIGH | OPEN | TBD | Faz 0 | 2026-05-03 | ADR-021 pending |
| DEC-009 | ST Validator sandbox: FS/syscall erişim kısıtı + fuzz | HIGH | OPEN | TBD | Faz 3 | 2026-06-07 | Plan §3 R-19 |
| DEC-010 | Reproducible build: SOURCE_DATE_EPOCH + cargo-auditable + SLSA L3 | MEDIUM | OPEN | TBD | Faz 0 | 2026-05-03 | Plan §4.4 |
| DEC-011 | Scan Cycle SLO Standardı: FDA 21 CFR 117.135 + EU Machinery | MEDIUM | OPEN | TBD | Faz 4 | 2026-06-14 | Plan §3 R-12 |
| DEC-012 | Coredump Hardening: LimitCORE + mlock + prctl | HIGH | OPEN | TBD | Faz 0 (config) + Faz 2 (impl) | 2026-05-31 | Plan §3 R-14 |
| DEC-013 | Config integrity: config.yaml.sig ed25519 | HIGH | OPEN | TBD | Faz 2 | 2026-05-31 | Plan §3 R-15 |
| DEC-014 | Retained message rejection: broker ACL + edge reject | MEDIUM | OPEN | TBD | Faz 2 | 2026-05-31 | Plan §3 R-16 |
| DEC-015 | Shutdown race: drain-before-safe-state | HIGH | OPEN | TBD | Faz 2 | 2026-05-31 | Plan §3 R-17 |
| DEC-016 | Edge schema placement: shared vs per-tenant | MEDIUM | OPEN | TBD | Faz 0 | 2026-05-03 | ADR-022 pending |

---

## Bulgular — STL (Steel-Grade Additions)

Plan §4 — iki planda da olmayan endüstriyel ekleme maddeleri.

| ID | Başlık | Severity | State | Owner | Faz | Deadline |
|---|---|---|---|---|---|---|
| STL-001 | Kani formal verification — 3 harness | HIGH | OPEN | TBD | Faz 3+9 | 2026-09-15 |
| STL-002 | IEC 62443 SL-2 adversarial evidence package | CRITICAL | OPEN | TBD | Faz 2+9 | 2026-09-15 |
| STL-003 | IEC 61508/61511 SIL-2 alignment for life-safety path | HIGH | OPEN | TBD | Faz 4+10 | 2026-09-30 |
| STL-004 | SLSA L3 supply chain (reproducible + hermetic + signed) | HIGH | OPEN | TBD | Faz 0+10 | 2026-09-30 |
| STL-005 | Hardware watchdog (RPi BCM2835 + external IC) | MEDIUM | OPEN | TBD | Faz 0 (systemd) + Faz 1 (code) | 2026-05-17 |
| STL-006 | Chaos engineering in pre-prod (weekly runs) | MEDIUM | OPEN | TBD | Faz 9 | 2026-09-15 |
| STL-007 | STRIDE threat model per-component + attack trees | HIGH | OPEN | TBD | Faz 0 | 2026-05-03 |
| STL-008 | Cryptographic agility (Ed25519 → Ed448 → ML-DSA path) | MEDIUM | OPEN | TBD | Faz 2 + ADR-021 | 2026-05-31 |
| STL-009 | Zero-trust command model (session-less, per-cmd signed) | HIGH | OPEN | TBD | Faz 2 | 2026-05-31 |

---

## Bulgular — PLA (Platform-side changes)

Plan §5 Faz 8.

| ID | Başlık | Severity | State | Owner | Faz | Deadline |
|---|---|---|---|---|---|---|
| PLA-001 | auth-service `generateEdgeCommandToken` + `generateEdgeLicenseToken` | HIGH | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-002 | auth-service `signEdgeCommand` mutation + rate limit | HIGH | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-003 | billing-service `PlanLimits` edge alanları | HIGH | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-004 | billing-service `edge-license.resolver` | HIGH | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-005 | admin-api-service `EdgePolicyController` + `EdgeLicenseController` + `EdgeAuditController` | HIGH | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-006 | libs/backend-common `sign-edge-command.util.ts` | MEDIUM | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-007 | libs/event-contracts `edge-events.ts` (9 event) | MEDIUM | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-008 | Provisioning `SelfRegisterResponse` 3-pubkey distribution | HIGH | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-009 | RBAC seed data `edge:*` permissions | MEDIUM | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-010 | tenant-admin UI — 5 yeni sayfa (LiveMonitor, StEditor, PolicyEditor, FaultForensics, AuditLog) | HIGH | OPEN | TBD | Faz 8 | 2026-08-16 |
| PLA-011 | JWT public key rotation CronJob | HIGH | OPEN | TBD | Faz 8 + ADR-021 | 2026-08-16 |

---

## Summary

| Kategori | Toplam | OPEN | RESOLVED | BLOCKED |
|---|---|---|---|---|
| ARC | 9 | 9 | 0 | 0 |
| SEC | 8 | 8 | 0 | 0 |
| PRF | 8 | 8 | 0 | 0 |
| TST | 10 | 10 | 0 | 0 |
| DEC | 16 | 14 | 2 | 0 |
| STL | 9 | 9 | 0 | 0 |
| PLA | 11 | 11 | 0 | 0 |
| **Toplam** | **71** | **69** | **2** | **0** |

**Next action:** Faz 0'ın kalan 3 ADR'ını aç (ADR-019 Firmware, ADR-020 Hardware, ADR-021 Key Ceremony, ADR-022 Schema), sonra Faz 1 wiring'e geç.

**Audit validation:** Her commit'in `Closes:` footer'ı bu board'daki finding ID'sini refere eder. Missing `Closes:` → PROCESS MEDIUM finding yazar'a. Security CRITICAL fix'lerde missing `Closes:` → PROCESS HIGH.
