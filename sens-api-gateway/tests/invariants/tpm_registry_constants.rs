#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-21 — the agent's TPM constants stay inside the agent's blocks of
//! the TPM resource registry.
//!
//! The OS (the LUKS seal, the rollback-floor mirror, the attestation key) and
//! the agent (the keystore's sealed master and its counter, the mTLS key) share
//! one TPM 2.0. Without a register they collide on persistent handles and NV
//! indices, and what one side creates the other can clear. The register is
//! Suderra-OS `docs/security/tpm-resource-registry.md` (registry_version 1,
//! Suderra-OS commit f2b9954); its owner is the OS, and its machine-readable
//! block is held to the OS image by `tests/image-contracts/
//! tpm-registry-contract-test.sh`. This test holds the AGENT to the same
//! register. The two repositories do not share the file (the contract that is
//! vendored flows from this repository to the OS, the register the other way),
//! so the agent's blocks are pinned below, literally, with the register's
//! numbers: a change to the register that moves a block has to change this test
//! in the same review, which is what makes the two sides read one register.
//!
//! * The agent's NV block is `0x01500000..=0x015000FF` (the keystore's master
//!   secret `0x01500016` and counter `0x01500017` are in it). The OS block next
//!   to it (`0x01500100..=0x015001FF`: the lifecycle's provisioned bit and
//!   counter, the rollback-floor mirror) is not the agent's.
//! * The agent's persistent-handle block is `0x817F0100..=0x817F01FF` (P2, the
//!   TPM keystore's objects); the TCG-reserved handles and the OS block
//!   `0x817F0000..=0x817F00FF` are not.
//! * The agent never extends a PCR (`agent_extends: []`) and never names
//!   `/dev/tpm0` (`devices.never`).
//!
//! The scan reads the source the release build compiles.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use source_scan_support::scan_src;

/// `registry.nv_indices` owner `agent`.
const AGENT_NV: std::ops::RangeInclusive<u32> = 0x0150_0000..=0x0150_00FF;
/// `registry.persistent_handles` owner `agent`.
const AGENT_PERSISTENT: std::ops::RangeInclusive<u32> = 0x817F_0100..=0x817F_01FF;
/// `registry.limits.nv`: the user-defined NV space.
const NV_SPACE: std::ops::RangeInclusive<u32> = 0x0100_0000..=0x01FF_FFFF;
/// `registry.limits.persistent_owner` and `persistent_platform` together.
const HANDLE_SPACE: std::ops::RangeInclusive<u32> = 0x8100_0000..=0x81FF_FFFF;

/// The registry's own numbers for the keystore's two indices.
const KEYSTORE_MASTER: u32 = 0x0150_0016;
const KEYSTORE_COUNTER: u32 = 0x0150_0017;

/// The eight-hex-digit literals of production code with their lines: the only
/// shape a TPM handle or NV index is written in.
fn tpm_sized_literals(code: &str) -> Vec<(usize, u32)> {
    let bytes = code.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(pos) = code[at..].find("0x") {
        let start = at + pos + 2;
        at = start;
        if start >= 3 && bytes[start - 3].is_ascii_alphanumeric() {
            continue; // `x0x..` inside an identifier
        }
        let digits: String = code[start..]
            .chars()
            .take_while(|c| c.is_ascii_hexdigit() || *c == '_')
            .filter(|c| *c != '_')
            .collect();
        if digits.len() == 8 {
            if let Ok(value) = u32::from_str_radix(&digits, 16) {
                let line = code[..start].bytes().filter(|b| *b == b'\n').count() + 1;
                found.push((line, value));
            }
        }
    }
    found
}

#[test]
fn the_keystore_defaults_are_the_registry_s_and_inside_the_agent_block() {
    let source = std::fs::read_to_string("src/keystore/tpm_backed.rs").expect("tpm_backed.rs");
    assert!(
        source.contains("0x0150_0016") && source.contains("0x0150_0017"),
        "the keystore's master and counter indices are the registry's"
    );
    assert!(AGENT_NV.contains(&KEYSTORE_MASTER));
    assert!(AGENT_NV.contains(&KEYSTORE_COUNTER));
}

/// Production code that deals with the TPM names a handle or NV index only
/// inside the agent's blocks: a stray one is a resource the OS would not know to
/// avoid. "Deals with the TPM" is a file whose code mentions it (`Tpm...`,
/// `tpm_...`, `tss_esapi`): an eight-digit constant of the LoRa MAC or a hash is
/// not a TPM handle just because its value falls in the handle space.
#[test]
fn no_production_code_names_a_tpm_resource_outside_the_agent_blocks() {
    let mut tpm_files = 0;
    for file in scan_src() {
        if !file.code.to_ascii_lowercase().contains("tpm") {
            continue;
        }
        tpm_files += 1;
        for (line, value) in tpm_sized_literals(&file.code) {
            if NV_SPACE.contains(&value) {
                assert!(
                    AGENT_NV.contains(&value),
                    "{}:{line}: 0x{value:08x} is in the TPM NV space but not in the agent's block \
                     0x01500000..=0x015000FF (ADR-048 DEC-21 registry)",
                    file.rel
                );
            }
            if HANDLE_SPACE.contains(&value) {
                assert!(
                    AGENT_PERSISTENT.contains(&value),
                    "{}:{line}: 0x{value:08x} is a TPM persistent handle outside the agent's block \
                     0x817F0100..=0x817F01FF (ADR-048 DEC-21 registry)",
                    file.rel
                );
            }
        }
    }
    assert!(
        tpm_files >= 2,
        "the scan found only {tpm_files} file(s) that deal with the TPM: its selector is lost"
    );
}

#[test]
fn the_scanner_sees_the_literals_it_is_there_to_hold() {
    let found = tpm_sized_literals("let a = 0x0150_0016; let b = 0x817F0000u32; let c = 0x12;");
    assert_eq!(found, [(1, 0x0150_0016), (1, 0x817F_0000)]);
    assert!(
        tpm_sized_literals("let a = 0x1500016;").is_empty(),
        "seven digits is no handle"
    );
}

/// The agent's side of the registry's `pcrs.agent_extends: []`.
#[test]
fn the_agent_never_extends_a_pcr_and_never_names_the_raw_tpm_device() {
    for file in scan_src() {
        let lowered = file.code.to_ascii_lowercase();
        for forbidden in [
            "pcr_extend",
            "pcrextend",
            "esys_pcr",
            "tpm2_pcr_extend",
            "evictcontrol",
            "tpm2_clear",
            "hierarchychangeauth",
            "dictionarylockout",
            "nv_undefinespace",
            "changeeps",
            "changepps",
        ] {
            assert!(
                !lowered.contains(forbidden),
                "{} uses `{forbidden}`: the agent extends no PCR and clears or re-owns no \
                 hierarchy (ADR-048 DEC-21)",
                file.rel
            );
        }
        for literal in &file.literals {
            assert!(
                !literal.text.contains("/dev/tpm0") && !literal.text.contains("tpm0\""),
                "{}:{}: `/dev/tpm0` is never given to the agent (the resource manager \
                 /dev/tpmrm0 is the only TPM device, and only from P2): {}",
                file.rel,
                literal.line,
                literal.text
            );
        }
    }
}

/// The keystore's validation enforces the block, not just the user space: an
/// operator override that lands in the OS block is refused before it opens a
/// TPM.
#[test]
fn the_keystore_validation_names_the_agent_block() {
    let source = std::fs::read_to_string("src/keystore/tpm_backed.rs").expect("tpm_backed.rs");
    for needed in [
        "AGENT_NV_FIRST",
        "AGENT_NV_LAST",
        "0x0150_0000",
        "0x0150_00FF",
    ] {
        assert!(
            source.contains(needed),
            "tpm_backed.rs no longer pins the agent's NV block (`{needed}`)"
        );
    }
}
