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
| ARC-001 | FailoverManager dead code; `state.failover_manager` her zaman `None` | HIGH | OPEN | Okan (temp — PROC-001) | Faz 1 | 2026-05-17 | `mqtt_failover.rs:1 #![allow(dead_code)]`, `commands.rs:3360` |
| ARC-002 | OfflineQueue publish path'e bağlı değil | HIGH | OPEN | Okan (temp — PROC-001) | Faz 1 | 2026-05-17 | `grep OfflineQueue::new` yalnız `offline_queue.rs:1493,1504,1515` |
| ARC-003 | `start_health_server` çağrılmıyor, feature gate arkasında | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 1 | 2026-05-17 | `grep start_health_server` main.rs'te 0 |
| ARC-004 | `pwm.rs`, `spi.rs` actor'lar CommandHandler'a wire edilmedi | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 1 | 2026-05-17 | `pwm.rs:20`, `spi.rs:22` TODO |
| ARC-005 | `st_validator.rs` AST üretiyor ama interpreter yok | HIGH | OPEN | Okan (temp — PROC-001) | Faz 3 | 2026-06-07 | Superseded by ADR-017 decision; runtime = bytecode VM |
| ARC-006 | Default build `--features gpio` olmadan I2C simülasyon, sahte `Good` quality publish | HIGH | OPEN | Okan (temp — PROC-001) | Faz 1 | 2026-05-17 | `i2c.rs:510-528` |
| ARC-007 | `rodbus = "=1.4.0"` exact pin + empty-path workaround | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 1 | 2026-05-17 | `Cargo.toml:64-70` |
| ARC-008 | `commands.rs` god-file (4392 satır) | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 1 | 2026-05-17 | wc -l |
| ARC-009 | `#![allow(dead_code)]` 12 dosyada (plan 3 sayıyordu — envanter hatası) | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 1 | 2026-05-17 | grep audit |

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
| SEC-001 | RBAC yok — `execute()` direkt dispatch | CRITICAL | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | `commands.rs:250-515` — superseded by ADR-018 |
| SEC-002 | Firmware imza doğrulaması yok (sadece SHA-256) | CRITICAL | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | `commands.rs:696-1008` — superseded by ADR-019 |
| SEC-003 | mTLS client cert opsiyonel, silent single-side fallback | HIGH | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | `mqtt.rs:728-741` |
| SEC-004 | SQLCipher key = HMAC(secret, machine-id); machine-id world-readable | HIGH | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | `offline_queue.rs:41-59` — superseded by ADR-019 |
| SEC-005 | Provisioning token base64 (encoding ≠ encryption) | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | `config.rs:36-73` |
| SEC-006 | Command replay dedup VecDeque bounded, TTL değil, reboot'ta kaybolur | HIGH | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | `commands.rs:316-339`, `mqtt.rs:335-348` |
| SEC-007 | Audit log post-execution, persistent sink yok, HMAC chain yok | HIGH | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | `commands.rs:380-388` |
| SEC-008 | Modbus TLS default `false` | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | `config.rs` default |

---

## Bulgular — PRF (Performance)

| ID | Başlık | Severity | State | Owner | Faz | Deadline | Kanıt |
|---|---|---|---|---|---|---|---|
| PRF-001 | Atlas EZO 4 probe sequential = 3600ms > 1000ms interval | HIGH | OPEN | Okan (temp — PROC-001) | Faz 3 (Plan'ın Faz uzantısı — Faz 4 sonrası perf sprint) | 2026-07-05 | `io_poll.rs:41`, `atlas_ezo.rs:42-43` |
| PRF-002 | I2C blocking `rppal::i2c::I2c::block_read` async context'te, `spawn_blocking` yok | HIGH | OPEN | Okan (temp — PROC-001) | Perf sprint | 2026-07-05 | `i2c.rs:160-163, 344-406` |
| PRF-003 | ProcessImage tek `Arc<RwLock<Inner>>` | MEDIUM | OPEN | Okan (temp — PROC-001) | Perf sprint | 2026-07-05 | `process_image.rs:149-156` |
| PRF-004 | `io_poll.rs` configs O(N×M) lookup | MEDIUM | OPEN | Okan (temp — PROC-001) | Perf sprint | 2026-07-05 | `io_poll.rs:68-99` |
| PRF-005 | Modbus bulk-read yok; connection pool yok | HIGH | OPEN | Okan (temp — PROC-001) | Perf sprint | 2026-07-05 | `modbus.rs:815-844` |
| PRF-006 | Hot-path `format!`/`clone()`/`serde_json::to_value` allocate per-tick | MEDIUM | OPEN | Okan (temp — PROC-001) | Perf sprint | 2026-07-05 | `io_poll.rs`, `mqtt.rs:562-593` |
| PRF-007 | `MissedTickBehavior::Skip` + overrun sayacı telemetry'de yok | MEDIUM | OPEN | Okan (temp — PROC-001) | Perf sprint | 2026-07-05 | `io_poll.rs:32-50` |
| PRF-008 | `Cargo.toml` release profili `target-cpu` yok | LOW | OPEN | Okan (temp — PROC-001) | Perf sprint | 2026-07-05 | `Cargo.toml [profile.release]` |

---

## Bulgular — TST (Test coverage)

| ID | Başlık | Severity | State | Owner | Faz | Deadline | Kanıt |
|---|---|---|---|---|---|---|---|
| TST-001 | E2E MQTT↔edge↔Modbus roundtrip yok | HIGH | OPEN | Okan (temp — PROC-001) | Faz 9 | 2026-09-15 | `tests/` dizini — 26 senaryo eklenecek |
| TST-002 | `stress_test.rs`, `resource_benchmark.rs` `#[ignore]` ile CI'dan izole | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 9 | 2026-09-15 | `#[ignore]` kaldır + CI nightly |
| TST-003 | Attacker kill-chain senaryoları kod test olarak yok | HIGH | OPEN | Okan (temp — PROC-001) | Faz 9 | 2026-09-15 | 10 kill-chain E2E eklenecek |
| TST-004 | Fault injection (broker down, disk full, cert expired) yok | HIGH | OPEN | Okan (temp — PROC-001) | Faz 9 | 2026-09-15 | Chaos harness + 5 resilience E2E |
| TST-005 | Plan testleri yazılmamış (21 feature testi + 6 perf testi) | HIGH | OPEN | Okan (temp — PROC-001) | Faz 3-9 | 2026-09-15 | Plan A §9 + Plan B §2.7 |
| TST-006 | Invariant test suite yok | HIGH | OPEN | Okan (temp — PROC-001) | Faz 1-9 | 2026-09-15 | 15+ invariant test planda |
| TST-007 | Contract tests platform ↔ edge yok | HIGH | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 | `e2e/tests/contract/` dizini yok |
| TST-008 | Migration tests yok (v1.6.0 → v2.0.0 config/DB) | HIGH | OPEN | Okan (temp — PROC-001) | Faz 9 | 2026-09-15 | `tests/migration/` dizini yok |
| TST-009 | Fuzz targets yok | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 9 | 2026-09-15 | 7 fuzz target planda |
| TST-010 | Kani formal verification harness yok | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 3-9 | 2026-09-15 | 3 harness planda (safe_state_reachable, rbac_non_bypass, gas_budget_saturating) |

---

## Bulgular — DEC (Architectural Decisions)

| ID | Başlık | Severity | State | Owner | Faz | Deadline | Çözüm |
|---|---|---|---|---|---|---|---|
| DEC-001 | ST runtime kararı: AST walker mı bytecode VM mi? | CRITICAL | RESOLVED | Okan | Faz 0 | 2026-05-03 | ADR-017 — Bytecode VM + gas metering |
| DEC-002 | Firmware update stratejisi: atomic_swap vs A/B | CRITICAL | OPEN | Okan (temp — PROC-001) | Faz 0 | 2026-05-03 | ADR-019 pending |
| DEC-003 | Master key: TPM → systemd-creds → file fallback | HIGH | OPEN | Okan (temp — PROC-001) | Faz 0 | 2026-05-03 | ADR-019 pending |
| DEC-004 | RBAC model: 4 sabit rol vs ABAC permission-set | CRITICAL | RESOLVED | Okan | Faz 0 | 2026-05-03 | ADR-018 — ABAC + 3-key segregation + tenant binding |
| DEC-005 | PWM/SPI wire mi, kaldır mı? | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 0 | 2026-05-03 | ADR-020 envanter sonrası |
| DEC-006 | mTLS migration: legacy → warn → strict zamanlama | HIGH | OPEN | Okan (temp — PROC-001) | Faz 0 | 2026-05-03 | ADR-019 (partial) — 150 gün tablosu planda |
| DEC-007 | Clock authority: NTS deployment | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | Plan §3 R-13 |
| DEC-008 | Platform key ceremony: HSM seçimi + rotation | HIGH | OPEN | Okan (temp — PROC-001) | Faz 0 | 2026-05-03 | ADR-021 pending |
| DEC-009 | ST Validator sandbox: FS/syscall erişim kısıtı + fuzz | HIGH | OPEN | Okan (temp — PROC-001) | Faz 3 | 2026-06-07 | Plan §3 R-19 |
| DEC-010 | Reproducible build: SOURCE_DATE_EPOCH + cargo-auditable + SLSA L3 | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 0 | 2026-05-03 | Plan §4.4 |
| DEC-011 | Scan Cycle SLO Standardı: FDA 21 CFR 117.135 + EU Machinery | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 4 | 2026-06-14 | Plan §3 R-12 |
| DEC-012 | Coredump Hardening: LimitCORE + mlock + prctl | HIGH | OPEN | Okan (temp — PROC-001) | Faz 0 (config) + Faz 2 (impl) | 2026-05-31 | Plan §3 R-14 |
| DEC-013 | Config integrity: config.yaml.sig ed25519 | HIGH | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | Plan §3 R-15 |
| DEC-014 | Retained message rejection: broker ACL + edge reject | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | Plan §3 R-16 |
| DEC-015 | Shutdown race: drain-before-safe-state | HIGH | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 | Plan §3 R-17 |
| DEC-016 | Edge schema placement: shared vs per-tenant | MEDIUM | RESOLVED | Okan (temp — PROC-001) | Faz 0 | 2026-05-03 | ADR-022 written + post-audit revised (3 CRITICAL + 6 HIGH + 7 MEDIUM + 3 LOW closed §11); dedicated `edge` schema chosen; ADR-011 W5 gate compliance |
| DEC-017 | SL-3 Upgrade Path (secure boot + dm-verity + remote attestation + WASM re-eval) | MEDIUM | RESOLVED | Okan (temp — PROC-001) | Faz 11 (opsiyonel) | 2026-09-30 | ADR-023 written — 9-component SL-3 package + trigger conditions + hardware matrix + Faz 11 activation workflow; closes ADR-020 §9 within-epoch residual via §4 remote attestation |
| DEC-018 | JSON script runtime deprecation horizon (coexistence → removal) | MEDIUM | OPEN | Okan | Faz 5 freeze / Faz 10 removal | 2026-09-30 | ADR-017 §9 JSON coexistence; silent removal yasak |
| DEC-019 | Audit Log HMAC Chain + Cloud Anchor (ADR-020) | HIGH | RESOLVED | Okan | Faz 2 | 2026-05-31 | ADR-020 written + post-audit revised (4 CRITICAL + 5 HIGH + 4 MEDIUM closed §14); decoupled from ADR-021 via §5a interim ceremony; ADR-018 §12 dependency satisfied |
| DEC-021 | Slot 8 daily_anchor_signing_key — ADR-021 post-unblock adoption | MEDIUM | OPEN | Okan (temp — PROC-001) | After ADR-021 rewrite | 2026-09-30 | ADR-020 §5a interim anchor key retirement path; slot 8 formal ceremony supersedes interim YubiHSM 2 Nano office-safe key when ADR-021 DEC-020 resolves |
| DEC-022 | ADR-024 safety-schema rewrite (post-audit life-safety bugs) | CRITICAL | RESOLVED | Okan (temp — PROC-001) | Faz 0-1 | 2026-06-07 | ADR-024 rewritten — 4 CRITICAL + 8 HIGH + 8 MEDIUM + 4 LOW closed §13: ActuatorClass enum extended (Thermal/Recirculation/WasteRemoval/Degassing/EmergencyContainment) + LifeSupport orthogonal flag; per-tuple signed class-binding log (§2 tamper-proof); explicit FailSafe enum per-subclass invariant; DiversityClass + HardwiredSafetyOverride; const_table! binary per-SKU caps; sealed OperatorId RFID ban compile-time; SIL-2-informed wording; engineer attestation schema + liability. Field-ops Phase B + legal review ops-work continues after architectural Accept |
| DEC-020 | ADR-021 §1-§4+§11 architectural rewrite (post-audit BLOCK verdict) | CRITICAL | RESOLVED | Okan (temp — PROC-001) | Faz 0-2 | 2026-05-17 | ADR-021 rewritten — Option A (single-key HSM + procedural 4-eye + conjunctive HSM+KMS trust); 9-slot canonical map (slot 8 reserved for ADR-020 daily_anchor; slot 9 online_revocation); §5b slot-9-immediate-revocation closes 14-day overlap offline race; 3 factual vendor errors eliminated; ADR-017/018/019 Accepted unblocked |

---

## Bulgular — STL (Steel-Grade Additions)

Plan §4 — iki planda da olmayan endüstriyel ekleme maddeleri.

| ID | Başlık | Severity | State | Owner | Faz | Deadline |
|---|---|---|---|---|---|---|
| STL-001 | Kani formal verification — 3 harness | HIGH | OPEN | Okan (temp — PROC-001) | Faz 3+9 | 2026-09-15 |
| STL-002 | IEC 62443 SL-2 adversarial evidence package | CRITICAL | OPEN | Okan (temp — PROC-001) | Faz 2+9 | 2026-09-15 |
| STL-003 | IEC 61508/61511 SIL-2 alignment for life-safety path | HIGH | OPEN | Okan (temp — PROC-001) | Faz 4+10 | 2026-09-30 |
| STL-004 | SLSA L3 supply chain (reproducible + hermetic + signed) | HIGH | OPEN | Okan (temp — PROC-001) | Faz 0+10 | 2026-09-30 |
| STL-005 | Hardware watchdog (RPi BCM2835 + external IC) | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 0 (systemd) + Faz 1 (code) | 2026-05-17 |
| STL-006 | Chaos engineering in pre-prod (weekly runs) | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 9 | 2026-09-15 |
| STL-007 | STRIDE threat model per-component + attack trees | HIGH | RESOLVED | Okan (temp — PROC-001) | Faz 0 | 2026-05-03 | `docs/security/threat-model.md` written — per-component STRIDE (10 components), 3 attack trees, IEC 62443 SL-2 FR mapping; living document updated per-ADR |
| STL-008 | Cryptographic agility (Ed25519 → Ed448 → ML-DSA path) | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 2 + ADR-021 | 2026-05-31 |
| STL-009 | Zero-trust command model (session-less, per-cmd signed) | HIGH | OPEN | Okan (temp — PROC-001) | Faz 2 | 2026-05-31 |

---

## Bulgular — PROC (Process / Meta)

| ID | Başlık | Severity | State | Owner | Faz | Deadline | Kanıt |
|---|---|---|---|---|---|---|---|
| PROC-001 | Finding board TBD sweep — 69 row named owner assignment | MEDIUM | RESOLVED | Okan | Faz 0 | 2026-05-03 | 2026-04-19 commit: 69 `TBD` rows swept to `Okan (temp — PROC-001)` — temp marker ensures re-assignment when security-lead hire onboards; no silent fallback |
| PROC-002 | ADR-017 + ADR-018 post-audit revision closure | HIGH | RESOLVED | Okan | Faz 0 | 2026-05-03 | 3-agent re-audit sonrası ADR-017 commit 8a953d1c + ADR-018 §7 closure table; her iki ADR audit bulgularını kapatır |

---

## Bulgular — PLA (Platform-side changes)

Plan §5 Faz 8.

| ID | Başlık | Severity | State | Owner | Faz | Deadline |
|---|---|---|---|---|---|---|
| PLA-001 | auth-service `generateEdgeCommandToken` + `generateEdgeLicenseToken` | HIGH | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-002 | auth-service `signEdgeCommand` mutation + rate limit | HIGH | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-003 | billing-service `PlanLimits` edge alanları | HIGH | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-004 | billing-service `edge-license.resolver` | HIGH | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-005 | admin-api-service `EdgePolicyController` + `EdgeLicenseController` + `EdgeAuditController` | HIGH | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-006 | libs/backend-common `sign-edge-command.util.ts` | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-007 | libs/event-contracts `edge-events.ts` (9 event) | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-008 | Provisioning `SelfRegisterResponse` 3-pubkey distribution | HIGH | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-009 | RBAC seed data `edge:*` permissions | MEDIUM | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-010 | tenant-admin UI — 5 yeni sayfa (LiveMonitor, StEditor, PolicyEditor, FaultForensics, AuditLog) | HIGH | OPEN | Okan (temp — PROC-001) | Faz 8 | 2026-08-16 |
| PLA-011 | JWT public key rotation CronJob | HIGH | OPEN | Okan (temp — PROC-001) | Faz 8 + ADR-021 | 2026-08-16 |

---

## Summary

| Kategori | Toplam | OPEN | RESOLVED | BLOCKED |
|---|---|---|---|---|
| ARC | 9 | 9 | 0 | 0 |
| SEC | 8 | 8 | 0 | 0 |
| PRF | 8 | 8 | 0 | 0 |
| TST | 10 | 10 | 0 | 0 |
| DEC | 22 | 16 | 6 | 0 |
| STL | 9 | 8 | 1 | 0 |
| PROC | 2 | 0 | 2 | 0 |
| PLA | 11 | 11 | 0 | 0 |
| **Toplam** | **79** | **69** | **10** | **0 (all BLOCKERs resolved — ADR-017/018/019/020/021/022/023/024 Proposed clean; field-ops Phase B + legal review tracked as ops-work)** |

**Next action:** Faz 0'ın kalan 3 ADR'ını aç (ADR-019 Firmware, ADR-020 Hardware, ADR-021 Key Ceremony, ADR-022 Schema), sonra Faz 1 wiring'e geç.

**Audit validation:** Her commit'in `Closes:` footer'ı bu board'daki finding ID'sini refere eder. Missing `Closes:` → PROCESS MEDIUM finding yazar'a. Security CRITICAL fix'lerde missing `Closes:` → PROCESS HIGH.

---

## Bulgular — ULTRA (2026-04-24 Ultra-Plan Gap Closure)

Ultra-plan `docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` ekseninde açılan 45 finding. Registry IDs `{PREFIX}-{SEVERITY}-{NNN}` commit-msg-validator (`tools/gates/commit-msg-validator.ts`) şemasıyla uyumlu; ultra-plan Gap-ID'leri (A-1a, B-4, G-5a) `notes` alanında korunur.

**Commit footer şablonu:**
```
Closes: docs/reviews/edge-plan/2026-04-19-edge-hardening.md#ULTRA-HIGH-NNN
```

### ULTRA — Dependency Inversion (A-eksen + E-4 seal)

| Registry ID | Ultra-Gap | Başlık | Severity | State | Batch | Hafta | Deadline |
|---|---|---|---|---|---|---|---|
| ULTRA-HIGH-001 | A-1a | CommandHandler + HandlerInput sealed-ctor primitive | HIGH | OPEN | #236 | W2 | 2026-05-08 |
| ULTRA-HIGH-002 | A-1b | Wire all existing command handlers through dispatcher | HIGH | OPEN | #237 | W2 | 2026-05-08 |
| ULTRA-HIGH-003 | A-2a | AuthenticatedUser newtype + SessionActor primitive | HIGH | OPEN | #241 | W3 | 2026-05-15 |
| ULTRA-HIGH-004 | A-2b | Custom SensNodeManager impl capturing RequestContext | HIGH | OPEN | #242 | W3 | 2026-05-15 |
| ULTRA-HIGH-005 | A-2c | Wire SensNodeManager + delete legacy SimpleNodeManager | HIGH | OPEN | #243 | W3 | 2026-05-15 |
| ULTRA-HIGH-006 | A-3a | UserTokenEnrollment from manifest | HIGH | OPEN | #244 | W4 | 2026-05-22 |
| ULTRA-HIGH-007 | A-3b | Wire validator + manifest hot-reload rebuild | HIGH | OPEN | #245 | W4 | 2026-05-22 |
| ULTRA-MEDIUM-001 | E-4 | AuditActorLabel invariant seal | MEDIUM | OPEN | #246 | W4 | 2026-05-22 |

### ULTRA — Faz 5 OPC UA Surface (B-eksen)

| Registry ID | Ultra-Gap | Başlık | Severity | State | Batch | Hafta | Deadline |
|---|---|---|---|---|---|---|---|
| ULTRA-HIGH-008 | B-1 | OPC UA TLS cert lifecycle (PkiStore + rotation + pinning) | HIGH | OPEN | #266-268 | W6 | 2026-06-05 |
| ULTRA-HIGH-009 | B-2 | Brute-force throttle FailedAuthWindow + AuthHandler | HIGH | OPEN | #269-270 | W7 | 2026-06-12 |
| ULTRA-MEDIUM-002 | B-3 | Per-tenant + per-user session quota | MEDIUM | OPEN | #271-272 | W7 | 2026-06-12 |
| ULTRA-HIGH-010 | B-4 | Push-subscription via ProcessImage::subscribe_changes | HIGH | OPEN | #273-275 | W7-8 | 2026-06-19 |
| ULTRA-HIGH-011 | B-5 | Config reload lifecycle | HIGH | OPEN | #276-277 | W8 | 2026-06-19 |
| ULTRA-MEDIUM-003 | B-6 | Real HMI interop E2E (Ignition + UaExpert) | MEDIUM | OPEN | #278-280 | W9 | 2026-06-26 |
| ULTRA-MEDIUM-004 | B-7 | Feature isolation CI gate (no-feature strings) | MEDIUM | OPEN | #281 | W9 | 2026-06-26 |

### ULTRA — Foundation + Faz 1 Wiring (C-eksen; C-1 + C-6 = VERIFIED per ORPHAN-MEDIUM-017)

| Registry ID | Ultra-Gap | Başlık | Severity | State | Batch | Hafta | Deadline |
|---|---|---|---|---|---|---|---|
| ULTRA-HIGH-012 | C-2 | Finding board + Closes trailer linkage (this entry) | HIGH | IN-PROGRESS | #235 | W2 | 2026-05-08 |
| ULTRA-HIGH-013 | C-3-1/2/3 | commands.rs split to ≤500-line ceiling | HIGH | OPEN | #238-240 | W3 | 2026-05-15 |
| ULTRA-MEDIUM-005 | C-4 | STRIDE threat model per component | MEDIUM | OPEN | #247 | W4 | 2026-05-22 |
| ULTRA-HIGH-014 | C-5 | Supply chain: SBOM + cosign + SLSA L3 + Dependabot SHA-pin | HIGH | OPEN | #248 | W4 | 2026-05-22 |
| ULTRA-MEDIUM-006 | C-7 | 5-variant Cargo feature CI matrix | MEDIUM | OPEN | #250 | W4 | 2026-05-22 |

### ULTRA — Faz 2 Security Fundamentals (D-eksen)

| Registry ID | Ultra-Gap | Başlık | Severity | State | Batch | Hafta | Deadline |
|---|---|---|---|---|---|---|---|
| ULTRA-HIGH-015 | D-1a | TPM keystore backend | HIGH | OPEN | #251 | W4 | 2026-05-22 |
| ULTRA-MEDIUM-007 | D-1b | File-backend gate + 180-day rotation playbook | MEDIUM | OPEN | #252 | W4 | 2026-05-22 |
| ULTRA-HIGH-016 | D-2 | mlock + prctl + panic-zeroize + memfd_secret | HIGH | OPEN | #253-254 | W5 | 2026-05-29 |
| ULTRA-HIGH-017 | D-3 | SQLCipher v1→v2 migration binary | HIGH | OPEN | #255-257 | W5 | 2026-05-29 |
| ULTRA-HIGH-018 | D-4 | mTLS rotation state machine + leaf pinning + staged rollout | HIGH | OPEN | #258-259 | W5 | 2026-05-29 |
| ULTRA-HIGH-019 | D-5 | Config integrity sidecar verify wire at boot | HIGH | OPEN | #260 | W5 | 2026-05-29 |
| ULTRA-HIGH-020 | D-6 | mTLS stack unified assembly | HIGH | OPEN | #261 | W5 | 2026-05-29 |
| ULTRA-MEDIUM-008 | D-8 | fuzz_st_parser + 24h nightly schedule | MEDIUM | OPEN | #262-263 | W5 | 2026-05-29 |
| ULTRA-HIGH-021 | D-9 | Clock authority NTS + chrony + CLOCK_MONOTONIC | HIGH | OPEN | #264-265 | W6 | 2026-06-05 |

### ULTRA — Faz 8 Platform-side (G-eksen)

| Registry ID | Ultra-Gap | Başlık | Severity | State | Batch | Hafta | Deadline |
|---|---|---|---|---|---|---|---|
| ULTRA-HIGH-028 | G-1 | auth-service generateEdgeCommandToken + JwtKeyRotationService | HIGH | OPEN | #282 | W9 | 2026-06-26 |
| ULTRA-HIGH-029 | G-2 | billing-service PlanLimits + edgeLicense resolver + REST | HIGH | OPEN | #283 | W10 | 2026-07-03 |
| ULTRA-HIGH-030 | G-3 | admin-api-service Edge{Policy,License,Audit}Controller | HIGH | OPEN | #284 | W10 | 2026-07-03 |
| ULTRA-HIGH-031 | G-4 | libs/event-contracts edge-events + NATS subject + JSON Schema | HIGH | OPEN | #285 | W10 | 2026-07-03 |
| ULTRA-MEDIUM-012 | G-5a | tenant-admin MFE pages 1-2 (LiveMonitor + AuditLog) | MEDIUM | OPEN | #286 | W11 | 2026-07-10 |
| ULTRA-MEDIUM-013 | G-5b | tenant-admin MFE pages 3-5 (StEditor + PolicyEditor + FaultForensics) | MEDIUM | OPEN | #287 | W11 | 2026-07-10 |
| ULTRA-HIGH-032 | G-6 | Contract tests: canonical hash + ed25519 + policy + license | HIGH | OPEN | #288 | W11 | 2026-07-10 |

### ULTRA — Faz 9 E2E + Faz 10 Release (F-eksen)

| Registry ID | Ultra-Gap | Başlık | Severity | State | Batch | Hafta | Deadline |
|---|---|---|---|---|---|---|---|
| ULTRA-MEDIUM-009 | F-1 | 41 E2E scenarios (4 sub-batches) | MEDIUM | OPEN | #289-292 | W11-12 | 2026-07-17 |
| ULTRA-HIGH-022 | F-2-1 | SL-2 adversarial re-audit Faz 2 end | HIGH | OPEN | #293 | W5 | 2026-05-29 |
| ULTRA-HIGH-023 | F-2-2 | SL-2 adversarial re-audit Faz 9 end | HIGH | OPEN | #294 | W12 | 2026-07-17 |
| ULTRA-HIGH-024 | F-2-3 | SL-2 adversarial re-audit Faz 10 end (release gate) | HIGH | OPEN | #295 | W12 | 2026-07-17 |
| ULTRA-MEDIUM-010 | F-3 | Chaos engineering weekly CI schedule | MEDIUM | OPEN | #296 | W8 | 2026-06-19 |
| ULTRA-HIGH-025 | F-4 | Kani formal verification harnesses | HIGH | OPEN | #297 | W8 | 2026-06-19 |
| ULTRA-HIGH-026 | F-5 | Reproducible build SLSA L3 dual-runner sha256 | HIGH | OPEN | #298 | W11 | 2026-07-10 |
| ULTRA-MEDIUM-011 | F-6 | 7 operational runbooks | MEDIUM | OPEN | #299 | W11 | 2026-07-10 |
| ULTRA-HIGH-027 | F-7 | SL-2 evidence package FR1-FR7 per directory | HIGH | OPEN | #300 | W12 | 2026-07-17 |

### ULTRA — Summary

| Bölüm | Toplam | OPEN | IN-PROGRESS | RESOLVED | BLOCKED |
|---|---|---|---|---|---|
| A-eksen + E-4 | 8 | 8 | 0 | 0 | 0 |
| B-eksen | 7 | 7 | 0 | 0 | 0 |
| C-eksen (C-2/3/4/5/7 only) | 5 | 4 | 1 | 0 | 0 |
| D-eksen | 9 | 9 | 0 | 0 | 0 |
| G-eksen | 7 | 7 | 0 | 0 | 0 |
| F-eksen | 9 | 9 | 0 | 0 | 0 |
| **ULTRA toplam** | **45** | **44** | **1 (C-2 this commit)** | **0** | **0** |

**Relation to existing 79-row board:** ULTRA-* entries are strictly additive — they do NOT supersede any of the pre-existing ARC/SEC/PRF/TST/DEC/STL/PROC/PLA rows. The existing rows use documentation-IDs (`ARC-001`, `DEC-001`) that do NOT match the commit-msg-validator regex; they remain as canonical-plan phase-gate traceability. Going forward, any commit that touches a surface covered by both an existing row AND an ULTRA-* row SHOULD cite the ULTRA-* ID in the `Closes:` trailer (registry-validated), with the existing row noted in the commit body for cross-reference.

**Registry JSONL:** `docs/reviews/_registry/findings.jsonl` receives 45 ULTRA-* entries via append-mode seeder `tools/scripts/seed-ultra-finding-registry.ts` (this same commit). Hash chain tip advances from current tail → 45 new SHA-256 links.

**Closure discipline:** State transitions go through `tools/gates/finding-registry.ts` (planned). Until that lands, state changes are direct JSONL edits with `closing_commits` SHA array populated by the closing commit's author. Each closure MUST carry:
1. Commit SHA that implements the fix
2. `closed_at` timestamp
3. Notes field update describing the regression-guard (invariant test ID, e2e test ID, or Kani harness name)
