#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-9.7 — a tag becomes a write to hardware in one place, and a
//! command names its target once.
//!
//! * **EDGE-HIGH-062.** The MQTT `set_output` wrote every Modbus tag as a coil
//!   to the first device with a matching slave id; the HMI executor wrote to
//!   `config.modbus.first()` and saturated an analog value into a `u16`. Both
//!   now call `tag_writer::write_tag`, which resolves the device, the function
//!   and the value (and refuses what does not fit). Neither may call a
//!   hardware handle's write method itself again, and nothing may guess a
//!   device with `modbus.first()`.
//! * **EDGE-HIGH-063.** `write_modbus` was authorized against `slave_id` and
//!   executed against `device`. The dispatcher resolves the target once
//!   (`write_target::canonicalise`) before the permission is derived, and the
//!   handler resolves it again from the configuration.
//!
//! The scan reads the source the release build compiles.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use source_scan_support::{functions, scan_src};

fn code_of(rel: &str) -> String {
    scan_src()
        .into_iter()
        .find(|f| f.rel == rel)
        .unwrap_or_else(|| panic!("{rel} is scanned"))
        .code
}

/// The hardware handles' actuator write methods.
const WRITE_METHODS: [&str; 5] = [
    ".write_coil(",
    ".write_register(",
    ".write_pin(",
    ".write_direct(",
    ".write_output(",
];

#[test]
fn the_tag_routed_paths_do_not_call_a_hardware_write_themselves() {
    for rel in ["src/main.rs", "src/commands/io_config.rs"] {
        let code = code_of(rel);
        for method in WRITE_METHODS {
            assert!(
                !code.contains(method),
                "{rel} calls `{method}` itself: a tag is routed to hardware by \
                 `tag_writer::write_tag` (device, function and value resolved in one place, \
                 EDGE-HIGH-062)"
            );
        }
    }
    assert!(
        code_of("src/main.rs").contains("tag_writer::write_tag("),
        "the HMI executor no longer writes through the tag writer"
    );
    let set_output = functions(&code_of("src/commands/io_config.rs"));
    assert!(
        set_output["cmd_set_output"]
            .iter()
            .any(|b| b.contains("tag_writer::write_tag(")),
        "cmd_set_output no longer writes through the tag writer"
    );
}

#[test]
fn nothing_guesses_a_modbus_device() {
    for file in scan_src() {
        for needle in [".modbus.first()", ".modbus.iter().next()"] {
            assert!(
                file.code_lines_with(needle).is_empty(),
                "{} picks a Modbus device by position (`{needle}`): a write goes to the device \
                 that owns the register",
                file.rel
            );
        }
    }
}

#[test]
fn a_write_modbus_names_its_target_once() {
    let dispatch = code_of("src/commands/mqtt_dispatch.rs");
    let canonicalise = dispatch
        .find("write_target::canonicalise(")
        .expect("the dispatcher resolves a command's Modbus target");
    let authorize = dispatch
        .find("authorize_adapted(")
        .expect("the dispatcher authorizes the command");
    assert!(
        canonicalise < authorize,
        "the target must be resolved BEFORE the permission is derived from the parameters"
    );
    let handler = functions(&code_of("src/commands/write.rs"));
    assert!(
        handler["cmd_write_modbus"]
            .iter()
            .any(|b| b.contains("ModbusWriteTarget::resolve(")),
        "cmd_write_modbus must resolve its device and register through ModbusWriteTarget, not \
         read `device` on its own"
    );
}
