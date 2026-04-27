//! Fuzz target for IEC 61131-3 Structured Text parser
//! (Batch #327 D-8 — closes UM-008).
//!
//! ## Why this target
//!
//! Plan §5 Faz 2 D-8 + IEC 62443 SL-2 FR3 (Input Validation)
//! mandate fuzz coverage on every parser exposed to operator
//! input. The Structured Text parser (`src/st_validator.rs`,
//! ~2700 lines) is the highest-risk parser in the agent:
//!
//!   - Operators upload .st source files via the
//!     `cmd_deploy_st_source` MQTT command (Batch #299).
//!   - The parser runs BEFORE the bytecode compile pass —
//!     a panic here would crash the agent before the
//!     compile-side gates fire.
//!   - The parser is recursive descent + carries
//!     keyword/operator/literal lexer state — classic
//!     fuzz-discoverable bug surface (stack overflow on
//!     deeply nested expressions, integer overflow in
//!     literal parsing, allocation amplification on
//!     malformed comments).
//!
//! ## Fuzz strategy
//!
//! Two entry points exercised:
//!
//!   - `parse_st(source)` — the AST-producing path.
//!     Catches panics in lexer/parser state machines.
//!   - `validate_st(source)` — the full lex+parse+typecheck
//!     pipeline. Exercises the type checker + the
//!     undefined-reference + duplicate-name + safety-check
//!     passes.
//!
//! The fuzzer feeds arbitrary bytes; UTF-8 decode failures
//! return early (parse_st is documented as taking a `&str`).
//! Within the UTF-8 subset, ALL byte sequences are valid
//! input — the parser MUST return `Result<_, _>` or
//! `ValidationResult`, never panic.
//!
//! ## Architectural include shape
//!
//! `#[path = "../../src/st_validator.rs"]` includes the
//! parser module directly into the fuzz binary. This works
//! because st_validator.rs has NO cross-module dependencies
//! (only `serde`, `std::collections::HashMap`, `std::fmt`,
//! `std::sync::LazyLock` — all available in the fuzz crate's
//! own dependency graph).
//!
//! Why direct include vs. lib-split: sens-api-gateway is a
//! `[[bin]]`-only crate; adding a `[lib]` target to expose
//! parse_st via `suderra-agent::st_validator` would require
//! a substantial structural change (every other module in
//! main.rs would need lib-promotion). Direct module include
//! is the surgical choice that gives the fuzzer access to
//! the ENTRY POINTS without restructuring the bin.
//!
//! ## Failure handling
//!
//! Any panic from the parser surfaces via libfuzzer's
//! standard crash-detection. The fuzz harness intentionally
//! does NOT `unwrap()` the parser result — successful
//! Err(StError) returns are NOT bugs (those are the
//! parser's working-as-intended path); only panics indicate
//! a real bug.

#![no_main]

#[path = "../../src/st_validator.rs"]
mod st_validator;

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Bound input length so the fuzzer doesn't waste cycles
    // on multi-megabyte allocations that would not occur in
    // production (operator-uploaded .st sources are
    // size-capped by the command handler).
    if data.len() > 64 * 1024 {
        return;
    }

    // UTF-8 decode is the parser's expected input. Random
    // byte sequences that aren't valid UTF-8 are filtered
    // out — they're not the parser's threat surface.
    let source = match std::str::from_utf8(data) {
        Ok(s) => s,
        Err(_) => return,
    };

    // Path 1: parse_st — AST builder. Must never panic;
    // Err return on malformed input is the working-as-
    // intended path.
    let _ = st_validator::parse_st(source);

    // Path 2: validate_st — full pipeline (lex + parse +
    // typecheck + safety). Must never panic; ValidationResult
    // with valid=false is the working-as-intended path for
    // malformed input.
    let _ = st_validator::validate_st(source);
});
