#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-13 / EDGE-HIGH-131 — safe-state is a life-safety path that no
//! operator-write guard may throttle or refuse.
//!
//! An operator Modbus write passes four guards before it reaches the wire:
//! `allow_writes`, the address policy, the function-code whitelist and a
//! write rate limiter (burst 4, 2 ops/s) that exists to stop a runaway
//! script. The safe-state pass used to send the same command, so on a relay
//! board with eight coils outputs 1-4 were driven and 5-8 failed at once with
//! "Write rate limit exceeded": the agent booted degraded, and a graceful
//! shutdown left them ON.
//!
//! The safe-state writer has its own command and its own client methods; this
//! test keeps the guards out of that call chain (and in the operator one),
//! reading the source the release build compiles.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use std::collections::{BTreeMap, BTreeSet};

use source_scan_support::{functions, scan_src};

/// The guards of an operator write.
const WRITE_GUARDS: [&str; 4] = [
    "acquire_write_rate_limit",
    "validate_write_allowed",
    "validate_write_address",
    "validate_function_code",
];

/// The write guards and the read limiter: none may sit on the safe-state
/// chain.
const GUARDS: [&str; 5] = [
    "acquire_write_rate_limit",
    "acquire_rate_limit",
    "validate_write_allowed",
    "validate_write_address",
    "validate_function_code",
];

/// The production code of `src/modbus.rs`.
fn modbus_code() -> String {
    scan_src()
        .into_iter()
        .find(|f| f.rel == "src/modbus.rs")
        .expect("src/modbus.rs is scanned")
        .code
}

/// The calls of `body` that stay inside the type or the file: `self.name(`
/// and a bare `name(`. A path call (`RequestParam::new(`) or a call on another
/// value (`channel.write_single_coil(`) is a different function that merely
/// shares a name, so it is not an edge of this graph.
fn calls(body: &str) -> BTreeSet<String> {
    let bytes = body.as_bytes();
    let mut out = BTreeSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let mut j = i;
            while j < bytes.len() && bytes[j] == b' ' {
                j += 1;
            }
            if bytes.get(j) != Some(&b'(') {
                continue;
            }
            let before = &body[..start];
            let own = if before.ends_with("::") {
                false
            } else if let Some(receiver) = before.strip_suffix('.') {
                receiver.ends_with("self") && !receiver.ends_with("_self")
            } else {
                true
            };
            if own {
                out.insert(body[start..i].to_string());
            }
        } else {
            i += 1;
        }
    }
    out
}

/// Every function name reachable by name from `roots` inside this file.
fn reachable(fns: &BTreeMap<String, Vec<String>>, roots: &[&str]) -> BTreeSet<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut todo: Vec<String> = roots.iter().map(|r| (*r).to_string()).collect();
    while let Some(name) = todo.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        for body in fns.get(&name).into_iter().flatten() {
            todo.extend(calls(body).into_iter().filter(|c| fns.contains_key(c)));
        }
    }
    seen
}

/// The text of the actor's match arm for `ModbusCommand::<variant> {`.
fn actor_arm(code: &str, variant: &str) -> String {
    let marker = format!("ModbusCommand::{variant} {{\n                    device_name");
    let at = code
        .find(&marker)
        .unwrap_or_else(|| panic!("the actor has no arm for {variant}"));
    let rest = &code[at + marker.len()..];
    let end = rest.find("ModbusCommand::").unwrap_or(rest.len());
    rest[..end].to_string()
}

#[test]
fn no_safe_state_call_chain_reaches_an_operator_write_guard() {
    let code = modbus_code();
    let fns = functions(&code);
    let roots = ["write_register_safe_state", "write_coil_safe_state"];
    for root in roots {
        assert!(
            fns.get(root).is_some_and(|b| b.len() == 2),
            "`{root}` must exist on the handle and on the client"
        );
    }
    let chain = reachable(&fns, &roots);
    for guard in GUARDS {
        assert!(
            !chain.contains(guard),
            "the safe-state chain {chain:?} reaches `{guard}`: safe-state must not be throttled \
             or refused by an operator-write guard (EDGE-HIGH-131)"
        );
    }
    // The chain really is the wire path, not an empty one.
    for wire in ["transmit_register", "transmit_coil"] {
        assert!(chain.contains(wire), "{wire} is not on the chain {chain:?}");
    }
}

#[test]
fn the_actor_routes_safe_state_commands_to_the_safe_state_methods_only() {
    let code = modbus_code();
    for (variant, safe, operator) in [
        (
            "SafeStateWriteRegister",
            "write_register_safe_state",
            "write_register",
        ),
        ("SafeStateWriteCoil", "write_coil_safe_state", "write_coil"),
    ] {
        let arm = actor_arm(&code, variant);
        assert!(
            arm.contains(&format!(".{safe}(")),
            "{variant} must call {safe}"
        );
        assert!(
            !arm.contains(&format!(".{operator}(")),
            "{variant} must not call the operator write {operator}"
        );
        for guard in GUARDS {
            assert!(!arm.contains(guard), "{variant} reaches {guard}");
        }
    }
}

/// The other direction: the operator path keeps every write guard.
#[test]
fn the_operator_write_keeps_all_its_guards() {
    let code = modbus_code();
    let fns = functions(&code);
    for name in ["write_register", "write_coil"] {
        // The client's method calls the guards; the handle's forwards to
        // the actor.
        let client = fns[name]
            .iter()
            .find(|b| b.contains("validate_write_allowed"))
            .unwrap_or_else(|| panic!("the client's {name} lost validate_write_allowed"));
        for guard in WRITE_GUARDS {
            assert!(client.contains(guard), "{name} lost `{guard}`");
        }
    }
}

/// Only the operator writes take a write-rate token.
#[test]
fn only_the_operator_writes_take_a_write_rate_token() {
    let code = modbus_code();
    let fns = functions(&code);
    let users: Vec<&String> = fns
        .iter()
        .filter(|(name, _)| *name != "acquire_write_rate_limit")
        .filter(|(_, bodies)| {
            bodies
                .iter()
                .any(|b| calls(b).contains("acquire_write_rate_limit"))
        })
        .map(|(name, _)| name)
        .collect();
    assert_eq!(
        users,
        ["write_coil", "write_register"],
        "the write limiter is a runaway-script guard for operator writes only"
    );
}
