//! WebAssembly custom LoRaWAN payload decoders (`wasm-codec` feature).
//!
//! WHY: `CodecType::Custom { decoder_name }` (see `codec.rs`) was a dead slot —
//! per-vendor payload formats had nowhere to run. Vendor decoders are foreign,
//! frequently-changing code; running them as native Rust would be a memory-safety
//! and supply-chain risk on the edge device. A `wasmi` interpreter runs each
//! decoder in a sandboxed linear-memory heap with a cooperative fuel budget and a
//! hard memory cap, so a buggy or hostile module can neither escape nor stall the
//! LoRa actor loop (the decode path is synchronous on that task, so bounding must
//! be cooperative — a tokio timeout cannot preempt it).
//!
//! Decoders are loaded once at LoRa start from `lorawan.wasm_decoder_dir`
//! (`<name>.wasm` → decoder keyed by file stem). This is the same trust level as
//! the device's own YAML config; the SIGNED cloud→edge deploy path (mirroring the
//! ST-bytecode command/registry/store machinery) is tracked separately.
//!
//! ## Decoder ABI (version 1)
//! A decoder module MUST export:
//!   - `memory` — its linear memory.
//!   - `abi_version() -> i32` — MUST return `1`.
//!   - `alloc(len: i32) -> i32` — return a writable offset for `len` input bytes.
//!   - `decode(ptr: i32, len: i32) -> i64` — decode the payload written at `ptr`.
//!     Returns `0` on failure, else a packed `(out_ptr as u32) << 32 | (out_len as u32)`
//!     pointing at a record buffer of repeated `[name_len: u16 LE][name utf8][value: f64 LE]`.
//! The host prepends `tag_prefix` to each name, drops non-finite values, and caps
//! the record count / name length — a module cannot flood the ProcessImage.

use std::collections::HashMap;
use std::sync::OnceLock;

use tracing::{info, warn};
use wasmi::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};

/// Fuel budget per invocation. Payloads are ≤ ~250 B, so a well-behaved decoder
/// consumes a tiny fraction; the budget exists only to bound pathological loops.
const FUEL_BUDGET: u64 = 5_000_000;
/// Hard linear-memory cap for a decoder instance.
const MAX_MEMORY_BYTES: usize = 1024 * 1024;
/// Maximum `(tag, value)` pairs a single decode may emit.
const MAX_RECORDS: usize = 32;
/// Maximum decoded tag-name length (bytes), before the `tag_prefix`.
const MAX_NAME_BYTES: usize = 64;
/// The only ABI version this host speaks.
const ABI_VERSION: i32 = 1;

/// A compiled, reusable decoder module. Cloneable-free: holds the shared
/// `Engine` + `Module` (both `Send + Sync`); a fresh `Store` is created per call
/// so no state survives across invocations.
pub struct Decoder {
    engine: Engine,
    module: Module,
}

/// Per-invocation store state — carries the memory limiter.
struct HostState {
    limits: StoreLimits,
}

impl Decoder {
    /// Compile a decoder from its wasm bytes.
    pub fn from_bytes(wasm: &[u8]) -> Result<Self, String> {
        let mut config = Config::default();
        config.consume_fuel(true);
        let engine = Engine::new(&config);
        let module = Module::new(&engine, wasm).map_err(|e| format!("module compile: {e}"))?;
        Ok(Self { engine, module })
    }

    /// Decode `payload`, prefixing each emitted tag with `tag_prefix`. Fail-soft:
    /// any trap, fuel exhaustion, ABI violation or malformed output yields an
    /// empty result (matching the built-in codecs' contract in `codec.rs`).
    pub fn decode(&self, payload: &[u8], tag_prefix: &str) -> Vec<(String, f64)> {
        match self.try_decode(payload, tag_prefix) {
            Ok(records) => records,
            Err(reason) => {
                warn!("wasm decoder rejected payload: {reason}");
                Vec::new()
            }
        }
    }

    fn try_decode(&self, payload: &[u8], tag_prefix: &str) -> Result<Vec<(String, f64)>, String> {
        let limits = StoreLimitsBuilder::new()
            .memory_size(MAX_MEMORY_BYTES)
            .memories(1)
            .tables(1)
            .build();
        let mut store = Store::new(&self.engine, HostState { limits });
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(FUEL_BUDGET)
            .map_err(|e| format!("set fuel: {e}"))?;

        // No host imports are granted — the decoder is pure compute.
        let linker: Linker<HostState> = Linker::new(&self.engine);
        let instance = linker
            .instantiate(&mut store, &self.module)
            .map_err(|e| format!("instantiate: {e}"))?
            .start(&mut store)
            .map_err(|e| format!("start: {e}"))?;

        let abi_version = instance
            .get_typed_func::<(), i32>(&store, "abi_version")
            .map_err(|e| format!("missing abi_version: {e}"))?;
        let reported = abi_version
            .call(&mut store, ())
            .map_err(|e| format!("abi_version trap: {e}"))?;
        if reported != ABI_VERSION {
            return Err(format!("unsupported ABI version {reported}"));
        }

        let memory = instance
            .get_memory(&store, "memory")
            .ok_or_else(|| "missing memory export".to_string())?;
        let alloc = instance
            .get_typed_func::<i32, i32>(&store, "alloc")
            .map_err(|e| format!("missing alloc: {e}"))?;
        let decode = instance
            .get_typed_func::<(i32, i32), i64>(&store, "decode")
            .map_err(|e| format!("missing decode: {e}"))?;

        let len = i32::try_from(payload.len()).map_err(|_| "payload too large".to_string())?;
        let ptr = alloc
            .call(&mut store, len)
            .map_err(|e| format!("alloc trap: {e}"))?;
        if ptr < 0 {
            return Err("alloc returned a negative offset".to_string());
        }
        memory
            .write(&mut store, ptr as usize, payload)
            .map_err(|e| format!("write payload: {e}"))?;

        let packed = decode
            .call(&mut store, (ptr, len))
            .map_err(|e| format!("decode trap: {e}"))?;
        if packed == 0 {
            return Ok(Vec::new());
        }

        let out_ptr = ((packed >> 32) & 0xFFFF_FFFF) as usize;
        let out_len = (packed & 0xFFFF_FFFF) as usize;
        let data = memory.data(&store);
        let region = data
            .get(out_ptr..out_ptr.saturating_add(out_len))
            .ok_or_else(|| "output region out of bounds".to_string())?;

        parse_records(region, tag_prefix)
    }
}

/// Parse the decoder's output buffer into finite, prefixed, capped records.
fn parse_records(mut buf: &[u8], tag_prefix: &str) -> Result<Vec<(String, f64)>, String> {
    let mut out = Vec::new();
    while !buf.is_empty() {
        if out.len() >= MAX_RECORDS {
            break;
        }
        let (name_len_bytes, rest) = buf
            .split_first_chunk::<2>()
            .ok_or_else(|| "truncated record header".to_string())?;
        let name_len = u16::from_le_bytes(*name_len_bytes) as usize;
        if name_len == 0 || name_len > MAX_NAME_BYTES {
            return Err(format!("invalid name length {name_len}"));
        }
        if rest.len() < name_len + 8 {
            return Err("truncated record body".to_string());
        }
        let (name_bytes, after_name) = rest.split_at(name_len);
        let name = std::str::from_utf8(name_bytes).map_err(|_| "name is not UTF-8".to_string())?;
        let (value_bytes, tail) = after_name.split_at(8);
        let mut value_arr = [0u8; 8];
        value_arr.copy_from_slice(value_bytes);
        let value = f64::from_le_bytes(value_arr);
        if value.is_finite() {
            out.push((format!("{tag_prefix}{name}"), value));
        }
        buf = tail;
    }
    Ok(out)
}

/* ------------------------------------------------------------------ */
/*  Process-global registry                                            */
/* ------------------------------------------------------------------ */

static REGISTRY: OnceLock<HashMap<String, Decoder>> = OnceLock::new();

/// Load every `<name>.wasm` decoder under `dir` (once, at LoRa start). Invalid
/// or unreadable modules are skipped with a warning — one bad decoder never
/// blocks the others or the gateway. A later call is a no-op (the registry is
/// immutable for the process lifetime; reloading a decoder needs an agent
/// restart, the same as a firmware/config change).
pub fn init(dir: Option<&str>) {
    if REGISTRY.get().is_some() {
        return;
    }
    let _ = REGISTRY.set(load_dir(dir));
}

/// Decode with the named registered decoder. Returns empty (with a warning) when
/// the decoder is not loaded — the caller's fail-soft contract is preserved.
pub fn decode(decoder_name: &str, payload: &[u8], tag_prefix: &str) -> Vec<(String, f64)> {
    match REGISTRY.get().and_then(|reg| reg.get(decoder_name)) {
        Some(decoder) => decoder.decode(payload, tag_prefix),
        None => {
            warn!("custom LoRa decoder '{decoder_name}' is not loaded — returning empty");
            Vec::new()
        }
    }
}

fn load_dir(dir: Option<&str>) -> HashMap<String, Decoder> {
    let mut map = HashMap::new();
    let Some(dir) = dir else {
        return map;
    };
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            warn!("wasm decoder dir '{dir}' unreadable: {e}");
            return map;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("wasm") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        match std::fs::read(&path) {
            Ok(bytes) => match Decoder::from_bytes(&bytes) {
                Ok(decoder) => {
                    map.insert(name.to_string(), decoder);
                    info!("loaded wasm LoRa decoder '{name}'");
                }
                Err(e) => warn!("skipping invalid wasm decoder '{name}': {e}"),
            },
            Err(e) => warn!("cannot read decoder '{}': {e}", path.display()),
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    // A well-formed decoder: emits one record name="temp",
    // value = (payload[0] << 8 | payload[1]) / 10.
    const GOOD_DECODER: &str = r#"
    (module
      (memory (export "memory") 1)
      (global $bump (mut i32) (i32.const 1024))
      (func (export "abi_version") (result i32) (i32.const 1))
      (func (export "alloc") (param $len i32) (result i32)
        (local $p i32)
        (local.set $p (global.get $bump))
        (global.set $bump (i32.add (global.get $bump) (local.get $len)))
        (local.get $p))
      (func (export "decode") (param $ptr i32) (param $len i32) (result i64)
        (local $out i32)
        (local.set $out (i32.const 4096))
        (if (i32.lt_s (local.get $len) (i32.const 2)) (then (return (i64.const 0))))
        (i32.store16 (local.get $out) (i32.const 4))
        (i32.store8 (i32.add (local.get $out) (i32.const 2)) (i32.const 116))
        (i32.store8 (i32.add (local.get $out) (i32.const 3)) (i32.const 101))
        (i32.store8 (i32.add (local.get $out) (i32.const 4)) (i32.const 109))
        (i32.store8 (i32.add (local.get $out) (i32.const 5)) (i32.const 112))
        (f64.store (i32.add (local.get $out) (i32.const 6))
          (f64.div
            (f64.convert_i32_u
              (i32.add
                (i32.mul (i32.load8_u (local.get $ptr)) (i32.const 256))
                (i32.load8_u (i32.add (local.get $ptr) (i32.const 1)))))
            (f64.const 10)))
        (i64.or
          (i64.shl (i64.extend_i32_u (local.get $out)) (i64.const 32))
          (i64.const 14))))
    "#;

    fn compile(wat: &str) -> Decoder {
        Decoder::from_bytes(&wat::parse_str(wat).expect("wat")).expect("compile")
    }

    #[test]
    fn decodes_a_temperature_record_with_prefix() {
        let d = compile(GOOD_DECODER);
        let out = d.decode(&[0x01, 0x10], "lora_dev1_");
        assert_eq!(out, vec![("lora_dev1_temp".to_string(), 27.2)]);
    }

    #[test]
    fn short_payload_returns_empty() {
        let d = compile(GOOD_DECODER);
        assert!(d.decode(&[0x01], "p_").is_empty());
    }

    #[test]
    fn infinite_loop_is_fuel_bounded_not_hung() {
        let d = compile(
            r#"(module
              (memory (export "memory") 1)
              (func (export "abi_version") (result i32) (i32.const 1))
              (func (export "alloc") (param i32) (result i32) (i32.const 1024))
              (func (export "decode") (param i32 i32) (result i64)
                (loop $l (br $l)) (i64.const 0)))"#,
        );
        assert!(d.decode(&[0x00, 0x00], "p_").is_empty());
    }

    #[test]
    fn wrong_abi_version_is_rejected() {
        let d = compile(
            r#"(module
              (memory (export "memory") 1)
              (func (export "abi_version") (result i32) (i32.const 99))
              (func (export "alloc") (param i32) (result i32) (i32.const 1024))
              (func (export "decode") (param i32 i32) (result i64) (i64.const 0)))"#,
        );
        assert!(d.decode(&[0x00, 0x00], "p_").is_empty());
    }

    #[test]
    fn missing_export_is_rejected() {
        // No `decode` export.
        let d = compile(
            r#"(module
              (memory (export "memory") 1)
              (func (export "abi_version") (result i32) (i32.const 1))
              (func (export "alloc") (param i32) (result i32) (i32.const 1024)))"#,
        );
        assert!(d.decode(&[0x00, 0x00], "p_").is_empty());
    }

    #[test]
    fn non_finite_values_are_filtered() {
        // Emits name="x" value = +inf (0x7FF0000000000000 LE).
        let d = compile(
            r#"(module
              (memory (export "memory") 1)
              (func (export "abi_version") (result i32) (i32.const 1))
              (func (export "alloc") (param i32) (result i32) (i32.const 1024))
              (func (export "decode") (param i32 i32) (result i64)
                (local $out i32)
                (local.set $out (i32.const 4096))
                (i32.store16 (local.get $out) (i32.const 1))
                (i32.store8 (i32.add (local.get $out) (i32.const 2)) (i32.const 120))
                (f64.store (i32.add (local.get $out) (i32.const 3))
                  (f64.const inf))
                (i64.or
                  (i64.shl (i64.extend_i32_u (local.get $out)) (i64.const 32))
                  (i64.const 11))))"#,
        );
        assert!(d.decode(&[0x00, 0x00], "p_").is_empty());
    }

    #[test]
    fn record_count_is_capped() {
        // A record buffer declaring far more than MAX_RECORDS one-byte-named
        // records; the host must stop at the cap.
        let mut wat = String::from(
            r#"(module
              (memory (export "memory") 1)
              (func (export "abi_version") (result i32) (i32.const 1))
              (func (export "alloc") (param i32) (result i32) (i32.const 1024))
              (func (export "decode") (param i32 i32) (result i64)
                (local $out i32)
                (local.set $out (i32.const 4096))
"#,
        );
        // 64 records of [len=1]["a"][value=1.0] = 11 bytes each.
        let record_bytes = 11u64;
        let count = 64u64;
        let mut off = 0u64;
        for _ in 0..count {
            wat.push_str(&format!(
                "(i32.store16 (i32.add (local.get $out) (i32.const {})) (i32.const 1))\n",
                off
            ));
            wat.push_str(&format!(
                "(i32.store8 (i32.add (local.get $out) (i32.const {})) (i32.const 97))\n",
                off + 2
            ));
            wat.push_str(&format!(
                "(f64.store (i32.add (local.get $out) (i32.const {})) (f64.const 1))\n",
                off + 3
            ));
            off += record_bytes;
        }
        wat.push_str(&format!(
            "(i64.or (i64.shl (i64.extend_i32_u (local.get $out)) (i64.const 32)) (i64.const {}))))",
            count * record_bytes
        ));
        let d = compile(&wat);
        let out = d.decode(&[0x00, 0x00], "p_");
        assert_eq!(out.len(), MAX_RECORDS);
    }

    #[test]
    fn unloaded_decoder_name_returns_empty() {
        // The registry is empty in a fresh test process unless init() loaded a dir.
        assert!(decode("does-not-exist", &[0x00], "p_").is_empty());
    }
}
