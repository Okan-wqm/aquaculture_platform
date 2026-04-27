# ADR-026: `protocol-codec` Crate as Single Source of Truth for Industrial Protocol Parsing

**Status:** Accepted (Faz 1 PR delivered the crate, drift CI, and integration test scaffolding — 2026-04-20)
**Date:** 2026-04-20 (Proposed) → 2026-04-20 (Accepted)
**Deciders:** Okan (platform owner) + sensor-service maintainers + sens-api-gateway maintainer
**Owner:** Okan
**Acceptance evidence:**
- `crates/protocol-codec/` — TCP/RTU/ASCII transports + 5 PDU decoders (FC 0x03/0x04/0x06/0x10 + exception)
- `crates/protocol-codec/tests/golden_fixtures.rs` + 15 fixtures under `tests/golden/`
- `tools/scripts/check-codec-drift.ts` + `drift` job in `.github/workflows/rust-ci.yml`
- 63 unit tests + 15 fixture cases + 1 doc test, all green on rust:1.88-slim
**Related ADRs:** ADR-025 (Rust sidecar architecture — still in `_draft/`, lands with Faz 2)
**Related plans:** `docs/plans/sensor-rust-migration/PLAN.md` (Faz 1)
**Open follow-ons:** (a) expand fixture set toward 50+ across all FCs / error variants, (b) wire nightly-toolchain step into `rust-ci.yml` so cargo-fuzz CI smoke (30 min/target) runs.

---

## Context (WHY)

Aynı endüstriyel protokol şu an iki farklı dilde / kütüphanede parse ediliyor:

| Protokol | Edge (`sens-api-gateway`, Rust) | Cloud (`sensor-service`, TypeScript) |
|---|---|---|
| Modbus TCP/RTU/ASCII | `src/modbus.rs` (rodbus 1.4 + custom CRC) | `src/protocol/adapters/industrial/modbus-{tcp,rtu,ascii}.adapter.ts` (modbus-serial 8.x) |
| LoRaWAN | `src/lora/codec.rs` + `lora/mac.rs` (lorawan 0.9) | `src/protocol/adapters/wireless/lorawan.adapter.ts` (manuel) |
| OPC-UA | `src/plc_programming/opcua.rs` (opcua 0.13) | `src/protocol/adapters/industrial/opcua.adapter.ts` (node-opcua 2.x) |
| S7comm | `src/plc_programming/s7comm.rs` | yok |
| EtherNet/IP | `src/plc_programming/ethernet_ip.rs` | yok |

**Tehlike:**
1. Edge bir Modbus mesajını `value=42.5` olarak yorumluyor; cloud aynı baytları `value=42.7` (byte order, scaling, signed/unsigned drift) — telemetri silently bozuluyor, alarm kuralları farklı triggerlanıyor.
2. Edge'de düzeltilen bir parser bug'ı cloud'da ay sonra tekrar üretiliyor (kod inceleme süreçleri ayrı).
3. Yeni bir cihaz tipi geldiğinde golden fixture iki kez yazılmak zorunda; biri eksik kalırsa drift sessizce büyür.
4. Saha debug'ı: bir operatör Wireshark'ta gördüğü baytı edge log'u ile karşılaştırıyor — log farklı yorumlama gösteriyor → 5 hafta süren root cause analizi.

---

## Decision (WHAT)

Tüm endüstriyel protokol parsing'i tek bir Rust crate'e konsolide edilir: **`crates/protocol-codec`**. Hem `sens-api-gateway` (edge, Faz 4'te path-dep) hem `sensor-ingestion` (cloud, Faz 2'de doğrudan) bu crate'i tüketir. NestJS `sensor-service`'in TS adapter parser'ları Faz 4'te purge edilir; adapter yüzeyi yalnız config validation + UI metadata + `ProtocolCapabilities` sağlar.

### Crate Sınırları

```
crates/protocol-codec/
├── src/
│   ├── lib.rs               public API
│   ├── modbus/              TCP, RTU, ASCII frame decode + CRC-16-Modbus
│   ├── lorawan/             PHY decrypt + FPort routing
│   ├── opcua_node/          node-id binary encoding
│   ├── s7_db/               Siemens S7 DB read/write
│   ├── ethernet_ip_cip/     Allen-Bradley CIP
│   └── error.rs             ParseError enum
└── tests/
    └── golden/              hex dump + beklenen JSON fixture'ları
```

Pure library — I/O yok, async yok, transport yok. Caller (rumqttc, rodbus, MQTT listener) ham byte'ı verir, parser typed `NormalizedReading` döner. Persistence kararı caller'da (COPY/INSERT semantik).

### Drift-Zero Garantisi (Mimari Tier 1: Make it impossible)

CI invariant: `tools/scripts/check-codec-drift.sh`

1. Aynı golden fixture set'i hem Rust hem TS testleri okur.
2. Rust side: `cargo test -p protocol-codec --test golden_fixtures` → her fixture için decode → JSON output.
3. TS side (Faz 1+2 paralel runtime'da): `nx test sensor-service --testPathPattern=codec-drift` → mevcut `ModbusTcpAdapter` aynı fixture'ı decode → JSON output.
4. CI script iki çıktıyı diff'ler. **Sapma = exit 1 = PR bloklanır.**
5. Faz 4'te TS parser'lar silinince TS side fixture sadece smoke test (Rust crate'i NAPI/sidecar üzerinden çağırır).

Bu sayede yeni device tipi geldiğinde fixture eklemek **tek hareket**: hem edge hem cloud aynı anda doğrulanır.

### Kalite Kapıları (Faz 1 zorunlu)

- `nom` parser'lar; `bytes::Buf` checked indexing; `#![forbid(unsafe_code)]`
- `cargo fuzz`: her protokol için fuzz target, 24 saat AFL run hedef = 0 crash
- `proptest`: encode→decode roundtrip, 1M random byte → no panic, only `Err(...)` veya valid frame
- Function code whitelist (Modbus): `[0x01,0x02,0x03,0x04,0x05,0x06,0x0F,0x10]`
- Property-based: CRC-16-Modbus implementation pyrotechnic — gateway `sens-api-gateway/src/modbus.rs` referans (kopyalanmaz; paralel agent ownership)
- `clippy::pedantic` + `clippy::nursery` (workspace-wide lint set)

### Threat Coverage (Faz 1)

| CVE/Class | Status post-Faz 1 |
|---|---|
| CVE-2024-10918 (libmodbus stack-based buffer overflow) | Compile-time elimine — `#![forbid(unsafe_code)]` + checked indexing |
| Modbus length-confusion (length field > frame size) | `nom::take` checked length parser |
| LoRaWAN MIC bypass | `lorawan-encoding` crate + `secrecy::Secret<AppSKey>` |
| OPC-UA chunk reassembly DoS | bounded buffer + `nom::Err::Incomplete` propagation |
| TS-side prototype pollution via JSON.parse | N/A — bu crate JSON parse etmez |

---

## Consequences

**Positive:**
- Edge ve cloud aynı semantiği paylaşır → silent telemetri bozulması imkansız.
- CVE class'ları (binary parser buffer overflow) Rust memory safety ile elimine edilir.
- Saha debug 5 dakika: log + Wireshark + crate version eşleşir.
- Yeni cihaz tipi onboarding: tek fixture, tek test koşusu hem edge hem cloud doğrular.
- Clippy `unwrap_used = "deny"` + `#![forbid(unsafe_code)]` — defansif kod yasaklı, panic yasaklı.

**Negative:**
- Faz 1-3 boyunca paralel kod (Rust crate + TS adapter) — kabul edilebilir, drift CI ile bloklanır.
- Faz 4 koordinasyonu: gateway ekibi (paralel agent) ile path-dep PR'ı senkron atılmalı. ADR-025 §Faz 4'de plan var.
- Cargo workspace ↔ Cargo standalone (gateway) geçici inconsistency — Faz 4'te birleşir.

**Neutral:**
- TypeORM adapter dosyaları silinmez — `parse()` `@deprecated`, geri kalan validation/UI/metadata yüzeyi korunur (~100 satır kalır, ~800 satır kalkar).

---

## Implementation Phases

| Faz | Çıktı | Drift CI |
|---|---|---|
| 1 | `modbus` modülü + 50+ golden fixture | Aktif (ilk modül) |
| 1.x | `lorawan`, `opcua_node`, `s7_db`, `ethernet_ip_cip` modülleri | Modül başına eklenir |
| 2 | `sensor-ingestion` Rust sidecar `protocol-codec`'i tüketir | Drift CI çalışır |
| 4 | `sens-api-gateway` `protocol-codec` path-dep alır; gateway'in iç parser kodu silinir; TS adapter parser kodları silinir | Drift CI smoke test |

---

## References

- `docs/plans/sensor-rust-migration/PLAN.md` (Faz 1, Faz 4)
- ADR-025 (Rust sidecar architecture)
- `crates/protocol-codec/` (skeleton bu PR'da)
- `sens-api-gateway/src/modbus.rs` (referans; paralel agent ownership)
- CVE-2024-10918 (libmodbus) — Nozomi Networks vulnerability advisory
