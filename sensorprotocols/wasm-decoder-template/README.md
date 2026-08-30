# Custom LoRaWAN wasm decoder — template

A custom decoder is a WebAssembly module implementing the gateway's decoder ABI
(version 1). It runs in a fuel- and memory-bounded `wasmi` sandbox inside
sens-api-gateway when the `wasm-codec` feature is built.

## ABI (version 1)

Exports required of the module:

| Export        | Signature                     | Contract                                                          |
| ------------- | ----------------------------- | ----------------------------------------------------------------- |
| `memory`      | linear memory                 | exported so the host can read/write                               |
| `abi_version` | `() -> i32`                   | MUST return `1`                                                   |
| `alloc`       | `(len: i32) -> i32`           | return a writable offset for `len` bytes (or `< 0` on failure)    |
| `decode`      | `(ptr: i32, len: i32) -> i64` | `0` on failure, else `(out_ptr as u32) << 32 \| (out_len as u32)` |

The output buffer at `out_ptr` is a sequence of records:

```
[name_len: u16 little-endian][name: name_len bytes UTF-8][value: f64 little-endian]
```

The host:

- prepends the device's `tag_prefix` to each `name`;
- drops any non-finite `value`;
- stops after 32 records and rejects names longer than 64 bytes;
- bounds execution by a fuel budget and a 1 MiB memory cap — a decoder that
  loops or over-allocates is aborted and yields no tags (fail-soft).

No host functions / imports and no WASI are available: a decoder is pure compute.

## Build & install

```bash
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/wasm_decoder_template.wasm \
   /var/lib/suderra/wasm_decoders/my_vendor.wasm
```

Set `lorawan.wasm_decoder_dir: /var/lib/suderra/wasm_decoders` in the gateway
config, and give the device a `codec: my_vendor` (the file stem). Restart the
agent to load new or changed decoders.
