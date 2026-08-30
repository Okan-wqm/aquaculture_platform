//! Reference custom LoRaWAN payload decoder for the sens-api-gateway wasm-codec
//! sandbox. Implements ABI version 1:
//!
//!   abi_version() -> i32          MUST return 1
//!   alloc(len: i32) -> i32        return an offset with room for `len` bytes
//!   decode(ptr, len) -> i64       0 on failure, else (out_ptr<<32 | out_len)
//!
//! Output at `out_ptr` is repeated records: [name_len: u16 LE][name utf8][value: f64 LE].
//! The host prepends the device `tag_prefix`, drops non-finite values, and caps
//! record count (32) and name length (64 bytes). No host imports are available.
#![no_std]

// no_std cdylib needs an explicit panic handler; a decoder must never unwind,
// so we abort the instance (the host treats the trap as a decode failure).
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// A tiny bump allocator over a fixed static arena. Single-shot per instance Single-shot per instance
// (the host creates a fresh instance per decode), so no free is needed.
const ARENA_SIZE: usize = 8 * 1024;
static mut ARENA: [u8; ARENA_SIZE] = [0; ARENA_SIZE];
static mut BUMP: usize = 0;

/// The only ABI version the host speaks.
#[no_mangle]
pub extern "C" fn abi_version() -> i32 {
    1
}

/// Reserve `len` bytes in the arena and return the offset.
#[no_mangle]
pub extern "C" fn alloc(len: i32) -> i32 {
    let len = len.max(0) as usize;
    unsafe {
        let start = BUMP;
        let end = start.saturating_add(len);
        if end > ARENA_SIZE {
            return -1;
        }
        BUMP = end;
        let base = &raw const ARENA as usize;
        (base + start) as i32
    }
}

/// Decode `len` bytes at `ptr`. This example reads a big-endian u16 at offset 0
/// as `temperature = raw / 10.0` and emits one record named "temperature".
#[no_mangle]
pub extern "C" fn decode(ptr: i32, len: i32) -> i64 {
    let len = len.max(0) as usize;
    if len < 2 {
        return 0;
    }
    let input = unsafe { core::slice::from_raw_parts(ptr as usize as *const u8, len) };
    let raw = u16::from_be_bytes([input[0], input[1]]);
    let value = f64::from(raw) / 10.0;

    // Serialize one record into the arena after the input.
    let name = b"temperature";
    let mut out = [0u8; 2 + 11 + 8];
    out[0..2].copy_from_slice(&(name.len() as u16).to_le_bytes());
    out[2..2 + name.len()].copy_from_slice(name);
    out[2 + name.len()..].copy_from_slice(&value.to_le_bytes());

    let out_len = out.len();
    let out_ptr = alloc(out_len as i32);
    if out_ptr < 0 {
        return 0;
    }
    unsafe {
        let dst = core::slice::from_raw_parts_mut(out_ptr as usize as *mut u8, out_len);
        dst.copy_from_slice(&out);
    }
    ((out_ptr as i64) << 32) | (out_len as i64)
}
