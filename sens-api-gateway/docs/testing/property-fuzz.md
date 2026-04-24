# Property Testing and Fuzzing — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.

## 1. Property testing (`proptest`)

`proptest = "1.5"` is declared as a dev-dependency at `Cargo.toml:419`, with the accompanying comment:

> "WHAT: criterion = microbenchmark framework; proptest = property-based testing precursor to cargo-fuzz targets (bytecode, envelope, policy, modbus parsers)."  (`Cargo.toml:416–418`)

### Present status

**0 `proptest!` macro invocations exist in `src/**` today.** The dev-dependency is wired, no generator has been authored. `grep -rn "proptest\|proptest!" src/ tests/` returns no source-level use (confirmed 2026-04-24).

### Plan (Q3 2026, owner: edge-platform)

Property generators planned for each external-input parser with known total-correctness invariants:

| Property | Target parser | Invariant to generate against |
|---|---|---|
| `prop_modbus_roundtrip` | `src/modbus.rs` | For any `(function_code, address, quantity)` in valid domain, encode→decode is identity |
| `prop_command_envelope_canonical` | `src/command_envelope/canonical.rs` | Canonical form is deterministic under field reordering; HMAC stable across re-serialisation |
| `prop_config_validation` | `src/config.rs` | Any YAML rejected by `validate()` cannot panic on `parse()` |
| `prop_audit_chain_append` | `src/audit/chain.rs` | Sequential append preserves chain hash monotonicity |
| `prop_authz_policy_decide` | `src/authz/verify.rs` | Deny-by-default holds over any manifest with missing rules |
| `prop_st_validator_accept_reject` | `src/st_validator.rs` | Parse-then-validate is stable under semantic equivalence rewrites |
| `prop_lora_mac_codec` | `src/lora/codec.rs` + `src/lora/mac.rs` | Encode→decode of any MAC frame is identity |
| `prop_scripting_bytecode` | `src/scripting/engine.rs` | Any bytecode rejected at load time cannot execute |

Acceptance: every parser listed above has one property with a minimum shrinking corpus of 256 cases.

## 2. Fuzzing (`cargo-fuzz` + `libfuzzer-sys`)

### Present targets (3)

Under `sens-api-gateway/fuzz/fuzz_targets/`:

| Target | Purpose | Attack surface |
|---|---|---|
| `config_parse.rs` | YAML config file parser | Pre-auth: bad config file on disk during boot |
| `modbus_response.rs` | Modbus TCP response decoder | Post-auth but wire-exposed: malicious PLC or MITM response. IEC 62443 SL2 FR3. References **FrostyGoop malware** attack vector in the file header. |
| `mqtt_payload.rs` | JSON MQTT payload decoder | Post-auth: compromised broker or upstream. 256 KB cap. IEC 62443 SL2 FR3. |

`fuzz/Cargo.toml:12` pins `libfuzzer-sys = "0.4"`, `fuzz/Cargo.toml:14` declares `arbitrary = { version = "1.3", features = ["derive"] }`.

Each target declares `test = false, doc = false, bench = false` at `fuzz/Cargo.toml:21–38`, so they do not interfere with `cargo test`.

### Missing targets (plan Q3 2026)

Every external-input parser without a fuzz target is a gap. Declared explicitly:

| Parser | File | Fuzz target status |
|---|---|---|
| Modbus TCP response | `src/modbus.rs` | **Covered** (`fuzz/fuzz_targets/modbus_response.rs`) |
| YAML config | `src/config.rs` | **Covered** (`fuzz/fuzz_targets/config_parse.rs`) |
| MQTT JSON payload | `src/mqtt.rs` | **Covered** (`fuzz/fuzz_targets/mqtt_payload.rs`) |
| **S7 ISO-on-TCP** | `src/plc_programming/s7comm.rs` | **MISSING — plan Q3** |
| **EtherNet/IP CIP** | `src/plc_programming/ethernet_ip.rs` | **MISSING — plan Q3** |
| **Atlas EZO response** | `src/atlas_ezo.rs` | **MISSING — plan Q3** |
| **LoRaWAN MAC frame** | `src/lora/mac.rs` + `src/lora/codec.rs` | **MISSING — plan Q3** |
| **Beckhoff ADS** | `src/plc_programming/ads.rs` | **MISSING — plan Q3** |
| **OPC UA response** | `src/plc_programming/opcua.rs` | Covered externally by the `opcua` crate's own fuzzing; internal consumer layer has no fuzz target — **MISSING**, plan Q3 |
| **Command envelope canonical form** | `src/command_envelope/canonical.rs` | **MISSING — plan Q3**; highest priority (signed-command surface) |
| **Signed updater manifest** | `src/updater/manifest.rs` | **MISSING — plan Q3**; highest priority (OTA surface) |
| **Signed authz manifest** | `src/authz/manifest.rs` | **MISSING — plan Q3**; highest priority |
| **Signed config integrity manifest** | `src/config_integrity/manifest.rs` | **MISSING — plan Q3** |
| **ST language validator** | `src/st_validator.rs` | **MISSING — plan Q3** (47 unit tests, no fuzz) |

### Corpus status

- Seed corpora: not yet committed under `fuzz/corpus/<target>/`. Plan Q3: seed with canonical-frame samples from each protocol reference.
- Minimised corpora: not generated.
- Continuous fuzzing: no OSS-Fuzz / ClusterFuzz integration. Plan Q4 for the three existing targets; targets added in Q3 follow once stable.

### Oracles

Each fuzz target uses the default `libfuzzer-sys` crash oracle: any panic, any signal, any ASAN finding is a failure. Additional oracles for post-Q3 targets should include:

- Round-trip oracle: decode → encode → decode equals the second decode (for protocols with canonical forms).
- Invariant oracle: no decoded command exceeds resource limits (`src/scripting/limits.rs`).
- Constant-time oracle: HMAC / signature verification time is independent of input prefix (property test, not fuzz).

## 3. Execution posture

- **PR gate:** none today. Fuzz targets build via `cd fuzz && cargo +nightly fuzz build` locally. Plan Q3: smoke-run each target for 60 s in CI and fail on any crash.
- **Nightly:** plan Q3: 10 min per target on a dedicated fuzz runner.
- **Release-candidate:** plan Q3: 24 h per target on dedicated runner, corpora checked in under `fuzz/corpus/`.

## 4. Evidence links

- `Cargo.toml:418–419` — `criterion` + `proptest` dev-deps.
- `fuzz/Cargo.toml:12` — `libfuzzer-sys = "0.4"`.
- `fuzz/Cargo.toml:14` — `arbitrary = { version = "1.3", features = ["derive"] }`.
- `fuzz/fuzz_targets/config_parse.rs` — YAML fuzz target.
- `fuzz/fuzz_targets/modbus_response.rs` — Modbus fuzz target, references FrostyGoop.
- `fuzz/fuzz_targets/mqtt_payload.rs` — MQTT JSON fuzz target, 256 KB cap.
