#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-8.8 — the RevPi process-image backend gives the agent exactly
//! the access it needs, and no code path widens it.
//!
//! `/dev/piControl0` has no capability check: whoever opens it may reflash a
//! module, reset the driver or stop the I/O (`KB_UPDATE_DEVICE_FIRMWARE`,
//! `PICONTROL_UPLOAD_FIRMWARE`, `KB_RESET`, `KB_STOP_IO`) and may write every
//! byte of the process image. The agent's defence is structural, and these
//! checks keep it so:
//!
//! 1. only the six requests of DEC-8.8 exist: the closed `Request` enum names
//!    them, and none of the four forbidden request numbers appears in code;
//! 2. the device node is named once, and it is the one the contract's
//!    `revpi-connect4` unit drop-in allows (`DeviceAllow=/dev/piControl0 rw`);
//! 3. the process image is written from one file (`backend.rs`), opened for
//!    writing from one place (`handle.rs`), and the actuator writers that
//!    reach it (`set_output`, the SCADA executor, the safe-state pass) are the
//!    only callers of the handle's write methods: there is no second, weaker
//!    route to an output;
//! 4. no helper process (`piTest`, PiCtory) is executed;
//! 5. the `revpi-io` feature needs no dependency and is not a default, so the
//!    release plan can build the `revpi-connect4` row from the contract's
//!    feature list alone.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use std::collections::BTreeSet;

use source_scan_support::{Scanned, crate_root, scan_src};

/// The files of `src/picontrol/` that exist only under `cfg(test)`: the scanner
/// judges a file, not the `#[cfg(test)] mod` line that includes it.
const TEST_ONLY: [&str; 3] = [
    "src/picontrol/fake.rs",
    "src/picontrol/behaviour_tests.rs",
    "src/picontrol/behaviour_table.rs",
];

/// What a release build compiles: every source file but the test-only ones,
/// after checking that `picontrol.rs` really gates them.
fn scan_production() -> Vec<Scanned> {
    let root =
        std::fs::read_to_string(crate_root().join("src/picontrol.rs")).expect("picontrol.rs");
    for gated in ["behaviour_tests", "fake", "behaviour_table"] {
        assert!(
            ["mod", "pub mod", "pub(crate) mod"]
                .iter()
                .any(|decl| root.contains(&format!("#[cfg(test)]\n{decl} {gated};"))),
            "{gated} must be declared under #[cfg(test)]"
        );
    }
    scan_src()
        .into_iter()
        .filter(|f| !TEST_ONLY.contains(&f.rel.as_str()))
        .collect()
}

fn file<'a>(files: &'a [Scanned], rel: &str) -> &'a Scanned {
    files
        .iter()
        .find(|f| f.rel == rel)
        .unwrap_or_else(|| panic!("{rel} is not in src/"))
}

/// Production files (relative paths) whose code contains `needle`.
fn files_with(files: &[Scanned], needle: &str) -> BTreeSet<String> {
    files
        .iter()
        .filter(|f| !f.code_lines_with(needle).is_empty())
        .map(|f| f.rel.clone())
        .collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn only_the_six_requests_of_dec_8_8_exist() {
    let files = scan_production();
    let abi = file(&files, "src/picontrol/abi.rs");

    // The closed enum.
    let start = abi.code.find("pub enum Request {").expect("Request enum");
    let body = &abi.code[start..];
    let body = &body[..body.find("\n}").expect("enum end")];
    let variants: BTreeSet<String> = body
        .lines()
        .skip(1)
        .map(str::trim)
        .filter(|l| l.ends_with(',') && !l.is_empty())
        .map(|l| l.trim_end_matches(',').to_owned())
        .collect();
    assert_eq!(
        variants,
        set(&[
            "GetDeviceInfoList",
            "GetValue",
            "SetValue",
            "FindVariable",
            "SetOutputWatchdog",
            "WaitForEvent",
        ])
    );

    // The numbers: `=> io(N)` in `Request::number`, exactly 13, 15, 16, 17,
    // 26, 50 (KB_GET_DEVICE_INFO_LIST .. KB_WAIT_FOR_EVENT in piControl.h).
    let mut numbers = BTreeSet::new();
    let mut rest = abi.code.as_str();
    while let Some(at) = rest.find("=> io(") {
        rest = &rest[at + "=> io(".len()..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        numbers.insert(digits.parse::<u32>().expect("request number"));
    }
    assert_eq!(numbers, BTreeSet::from([13, 15, 16, 17, 26, 50]));
}

#[test]
fn the_firmware_reset_and_stop_requests_have_no_constant_anywhere() {
    let files = scan_production();
    for f in &files {
        for forbidden in [
            "KB_RESET",
            "KB_STOP_IO",
            "KB_UPDATE_DEVICE_FIRMWARE",
            "PICONTROL_UPLOAD_FIRMWARE",
            "KB_SET_EXPORTED_OUTPUTS",
            "KB_INTERN",
            "KB_AIO_CALIBRATE",
            "KB_DIO_RESET_COUNTER",
        ] {
            assert!(
                f.code_lines_with(forbidden).is_empty(),
                "{}: {forbidden} is not a request the agent may issue",
                f.rel
            );
        }
        // Their request numbers, as hexadecimal or decimal literals.
        for lit in f
            .literals
            .iter()
            .map(|l| l.text.as_str())
            .chain(std::iter::empty())
        {
            let lower = lit.to_ascii_lowercase();
            for n in ["0x4b0c", "0x4b13", "0x4b16", "0x40184bc8"] {
                assert!(!lower.contains(n), "{}: request number {n}", f.rel);
            }
        }
        for n in [
            "0x4b0c",
            "0x4b13",
            "0x4b16",
            "0x40184bc8",
            "19212",
            "19219",
            "19222",
        ] {
            let code = f.code.to_ascii_lowercase();
            assert!(!code.contains(n), "{}: request number {n} in code", f.rel);
        }
    }
}

#[test]
fn the_device_node_is_named_once_and_is_the_one_the_contract_allows() {
    let files = scan_production();
    let naming: BTreeSet<String> = files
        .iter()
        .filter(|f| f.literals.iter().any(|l| l.text.contains("piControl0")))
        .map(|f| f.rel.clone())
        .collect();
    assert_eq!(naming, set(&["src/picontrol/abi.rs"]));

    let abi = file(&files, "src/picontrol/abi.rs");
    let literal = abi
        .literals
        .iter()
        .find(|l| l.text.contains("piControl0"))
        .expect("DEVICE_PATH literal");

    let contract: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            crate_root().join("../contracts/suderra-edge/v1/unit-directives.json"),
        )
        .expect("unit-directives.json"),
    )
    .expect("json");
    let allow = &contract["profiles"]["suderra-os"]["board_dropins"]["boards"]["revpi-connect4"]["DeviceAllow"];
    let allowed: Vec<&str> = allow
        .as_array()
        .expect("DeviceAllow")
        .iter()
        .map(|v| v.as_str().expect("string"))
        .collect();
    assert!(
        allowed.contains(&format!("{} rw", literal.text).as_str()),
        "the revpi-connect4 drop-in allows {allowed:?}, the agent opens {}",
        literal.text
    );
}

#[test]
fn the_process_image_is_written_from_one_file_and_opened_for_writing_from_one_place() {
    let files = scan_production();
    // The typed write operations of a descriptor.
    for method in [
        ".set_bit(",
        ".set_byte(",
        ".write_bytes(",
        ".set_output_watchdog(",
    ] {
        let users = files_with(&files, method);
        let allowed: BTreeSet<String> = match method {
            ".set_bit(" | ".set_byte(" | ".write_bytes(" | ".set_output_watchdog(" => {
                set(&["src/picontrol/backend.rs"])
            }
            _ => unreachable!(),
        };
        assert!(
            users.is_subset(&allowed),
            "{method} is called from {users:?}; only {allowed:?} may write the process image"
        );
    }
    // The device is opened for writing in one place; the hardware scan opens
    // it read-only.
    assert_eq!(
        files_with(&files, "LibcDevice::open("),
        set(&["src/picontrol/handle.rs"])
    );
    for user in files_with(&files, "LibcDevice::open_read_only(") {
        assert!(
            user == "src/hardware_scanner.rs" || user.starts_with("src/picontrol/"),
            "{user} opens the device"
        );
    }
}

#[test]
fn only_the_actuator_writers_call_the_handles_write_methods() {
    let files = scan_production();
    let writers = files_with(&files, ".write_output(");
    assert!(
        writers.is_subset(&set(&[
            // Every tag-routed write: the MQTT set_output (after the envelope
            // gate) and the SCADA command executor both go through it
            // (ADR-048 DEC-9.7; tests/invariants/tag_writes_route_through_the_writer.rs).
            "src/tag_writer.rs",
            "src/picontrol/handle.rs",
            "src/picontrol/backend.rs",
        ])),
        "{writers:?} write RevPi outputs; the handle's gate, force registry and grant apply \
         to every writer, so a new writer is a decision for this list"
    );
    assert!(writers.contains("src/tag_writer.rs"));

    // The safe-state drive needs the capability only the safe-state pass holds.
    let safe = files_with(&files, ".drive_safe(");
    assert!(
        safe.is_subset(&set(&[
            "src/safe_state.rs",
            "src/picontrol/handle.rs",
            "src/picontrol/backend.rs"
        ])),
        "{safe:?}"
    );
    let handle = file(&files, "src/picontrol/handle.rs");
    assert!(
        !handle
            .code_lines_with("pub fn drive_safe(&self, tag: &str, _: &SafeStateWrite)")
            .is_empty(),
        "drive_safe must take the SafeStateWrite capability"
    );
    // And the public write method checks the gate and the force registry
    // before it reaches the backend.
    let at = handle
        .code
        .find("pub async fn write_output")
        .expect("write_output");
    let body = &handle.code[at..];
    let body = &body[..body.find("\n    }\n").expect("end")];
    let gate = body.find("self.gate").expect("gate");
    let force = body.find("self.force.is_forced").expect("force registry");
    let backend = body.find("self.backend.write_output").expect("backend");
    assert!(gate < force && force < backend);
}

#[test]
fn no_helper_process_is_executed_for_the_revpi() {
    let files = scan_production();
    for f in &files {
        for l in &f.literals {
            let lower = l.text.to_ascii_lowercase();
            assert!(
                !lower.contains("pitest") && !lower.contains("picontory"),
                "{}:{}: PiCtory and piTest are not on the Suderra OS image and are not executed",
                f.rel,
                l.line
            );
        }
    }
}

#[test]
fn the_revpi_io_feature_has_no_dependency_and_is_not_a_default() {
    let cargo = std::fs::read_to_string(crate_root().join("Cargo.toml")).expect("Cargo.toml");
    let features = cargo.split("[features]").nth(1).expect("[features]");
    let features = features.split("\n[").next().expect("features block");
    let line = features
        .lines()
        .find(|l| l.trim_start().starts_with("revpi-io"))
        .expect("revpi-io feature");
    assert_eq!(line.replace(' ', ""), "revpi-io=[]");
    let default = features
        .lines()
        .find(|l| l.trim_start().starts_with("default"))
        .expect("default feature");
    assert!(!default.contains("revpi-io"), "{default}");
    // The contract's revpi-connect4 row names the feature, so the release plan
    // builds it from the board list.
    let boards: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(crate_root().join("../contracts/suderra-edge/v1/boards.json"))
            .expect("boards.json"),
    )
    .expect("json");
    let row = boards["boards"]
        .as_array()
        .expect("boards")
        .iter()
        .find(|b| b["board_profile"] == "revpi-connect4")
        .expect("revpi-connect4");
    let build: Vec<&str> = row["cargo_features"]
        .as_array()
        .expect("features")
        .iter()
        .map(|v| v.as_str().expect("str"))
        .collect();
    assert!(
        build.contains(&"revpi-io") && !build.contains(&"gpio"),
        "{build:?}"
    );
    for f in build {
        assert!(
            features
                .lines()
                .any(|l| l.trim_start().starts_with(&format!("{f} "))
                    || l.trim_start().starts_with(&format!("{f}="))),
            "boards.json names the feature {f}, which Cargo.toml does not define"
        );
    }
}
