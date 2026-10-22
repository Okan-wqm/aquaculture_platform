#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-7.5 / DEC-7.3 — freshness is judged at an instant the clock
//! authority vouches for, and a command the agent does not run is refused out
//! loud.
//!
//! * **EDGE-MEDIUM-077.** The command path read `SystemTime::now()` (with an
//!   `unwrap_or(0)` for a clock before the epoch) and `Utc::now()` for the
//!   envelope's window, the RBAC manifest's window and the replay window. A
//!   device that booted without an RTC, or whose clock was stepped back, judged
//!   an expired command fresh. Now the dispatcher reads "now" once, from the
//!   agent's `ClockAuthority` (`freshness::fresh_now`), BEFORE any signature is
//!   verified, and hands the instant to every gate; the adapter reads no clock.
//!   On Suderra OS the authority is root's `/run/suderra/time-state`.
//! * **EDGE-MEDIUM-135.** Every gate of the commands arm ended in `warn!` and
//!   `return Ok(())`: the platform timed out and the audit chain held nothing.
//!   Now every gate is a `Refusal` that leaves through `CommandHandler::refuse`.
//!
//! The scan reads the source the release build compiles. Local control,
//! safe-state and alarms are not on this path and read no document.

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

/// Every way the standard library or chrono reads the wall (or monotonic) clock.
const CLOCK_READS: [&str; 8] = [
    "SystemTime::now(",
    "Utc::now(",
    "Local::now(",
    "Instant::now(",
    "UNIX_EPOCH",
    "time::now(",
    "OffsetDateTime::now_utc(",
    ".elapsed(",
];

#[test]
fn the_command_path_reads_no_clock_of_its_own() {
    let files = scan_src();
    for rel in [
        "src/commands/mqtt_dispatch.rs",
        "src/commands/envelope_adapter.rs",
        "src/commands/command_acceptance.rs",
        "src/commands/freshness.rs",
    ] {
        let file = files
            .iter()
            .find(|f| f.rel == rel)
            .unwrap_or_else(|| panic!("{rel} is scanned"));
        for needle in CLOCK_READS {
            // freshness.rs is the one file that turns the authority's reading
            // into an epoch count; it names UNIX_EPOCH and nothing else.
            if rel.ends_with("freshness.rs") && needle == "UNIX_EPOCH" {
                continue;
            }
            assert!(
                file.code_lines_with(needle).is_empty(),
                "{rel} reads a clock (`{needle}`): freshness is judged at the instant the clock \
                 authority vouches for (freshness::fresh_now), handed in as a parameter"
            );
        }
    }
}

#[test]
fn the_adapter_takes_the_instant_it_judges_at() {
    let adapter = code_of("src/commands/envelope_adapter.rs");
    // `functions()` cannot read these two: an array type's `;` ends the scan of
    // their signatures. The text checks say the same thing.
    for (signature, what) in [
        ("fn try_parse_and_verify(", "the envelope verification"),
        ("fn authorize_adapted(", "the RBAC authorization"),
    ] {
        assert!(adapter.contains(signature), "envelope_adapter has {what}");
    }
    let verify = adapter
        .find("fn try_parse_and_verify(")
        .expect("try_parse_and_verify");
    let signature_end = verify
        + adapter[verify..]
            .find(") -> AdapterOutcome")
            .expect("its return");
    assert!(
        adapter[verify..signature_end].contains("now_unix_secs: i64"),
        "try_parse_and_verify must take the instant freshness is judged at, not read a clock"
    );
    let authorize = adapter
        .find("fn authorize_adapted(")
        .expect("authorize_adapted");
    let authorize_end = authorize
        + adapter[authorize..]
            .find(") -> Result")
            .expect("its return");
    assert!(
        adapter[authorize..authorize_end].contains("now: SystemTime"),
        "authorize_adapted must take the instant the manifest and role windows are judged at"
    );
    let flat = adapter.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        flat.contains("now_unix_secs, mode,"),
        "the envelope's Gate 4 must be judged at the instant the adapter was given"
    );
}

/// The instant is read first, and the gates use it: `fresh_now` comes before the
/// first verification, which gets `now.unix_secs`, and the RBAC gate and the
/// replay window get the same instant.
#[test]
fn the_dispatcher_reads_the_instant_once_before_it_verifies_anything() {
    let dispatch = code_of("src/commands/mqtt_dispatch.rs");
    let fresh = dispatch
        .find("freshness::fresh_now(")
        .expect("the dispatcher reads its instant from the clock authority");
    let verify = dispatch
        .find("try_parse_and_verify(")
        .expect("the dispatcher verifies the envelope");
    assert!(
        fresh < verify,
        "the clock must be consulted before a signature is verified: an unsynced clock refuses \
         the command and spends nothing"
    );
    assert_eq!(
        dispatch.matches("freshness::fresh_now(").count(),
        1,
        "one instant per command: every gate judges at the same one"
    );
    for use_of_the_instant in [
        "now.unix_secs,",
        "now.system_time,",
        "now.utc(),",
        "now.system_time +",
    ] {
        assert!(
            dispatch.contains(use_of_the_instant),
            "the dispatcher no longer hands `{use_of_the_instant}` to its gate"
        );
    }
}

/// EDGE-MEDIUM-135: no gate of the commands arm drops a command silently.
#[test]
fn every_gate_of_the_commands_arm_refuses_out_loud() {
    let dispatch = code_of("src/commands/mqtt_dispatch.rs");
    let arm = &dispatch[dispatch
        .find("fn handle_command_message(")
        .expect("the commands arm is its own function")..];
    assert!(
        !arm.contains("return Ok(())"),
        "a gate of the commands arm returns without refusing: the sender is not answered and \
         the audit chain holds nothing (EDGE-MEDIUM-135)"
    );
    for refusal in [
        "Refusal::Retained",
        "Refusal::from_clock_error(",
        "Refusal::NotAnEnvelope",
        "Refusal::Unparseable",
        "Refusal::UnsignedForbidden(",
        "Refusal::EnvelopeInvalid(",
        "Refusal::NoTenantBinding",
        "Refusal::TargetUnresolved(",
        "Refusal::NotAuthorized(",
        "Refusal::Timestamp(",
        "Refusal::Duplicate",
    ] {
        assert!(
            arm.contains(refusal),
            "the commands arm never refuses with `{refusal}`"
        );
    }
}

/// Only the two refusals whose sender needs no answer are silent, and the audit
/// entry is written for every one.
#[test]
fn a_refusal_is_audited_and_answered_in_one_place() {
    let refusal = code_of("src/commands/refusal.rs");
    let record = functions(&refusal);
    let body = record
        .get("record_refusal")
        .and_then(|bodies| bodies.first())
        .expect("record_refusal");
    assert!(
        body.contains("emit_refusal_event("),
        "a refusal must reach the audit chain"
    );
    assert!(
        body.contains("publish_response("),
        "an answered refusal must be published like every other response"
    );
    assert!(
        body.contains("is_answered()"),
        "the unanswered refusals (duplicate, retained) are decided by the refusal itself"
    );
}

/// On Suderra OS the clock authority is root's time document, and the generic
/// profile's chrony and trusting authorities are not compiled.
#[test]
fn suderra_os_takes_its_clock_from_roots_time_document() {
    let main = std::fs::read_to_string("src/main.rs").expect("read main.rs");
    assert!(
        main.contains("TimeStateClockAuthority::new("),
        "init_clock_authority must build the time-state authority on Suderra OS"
    );
    let generic = main
        .find("fn init_generic_clock_authority")
        .expect("the generic profile's clock authority has its own function");
    let attribute = &main[..generic];
    assert!(
        attribute
            .trim_end()
            .ends_with("#[cfg(not(feature = \"suderra-os\"))]"),
        "init_generic_clock_authority (chrony, trusting baseline) must not compile on Suderra OS"
    );
    let runtime_safety =
        std::fs::read_to_string("src/runtime_safety/mod.rs").expect("read runtime_safety/mod.rs");
    assert!(
        runtime_safety.contains("#[cfg(feature = \"suderra-os\")]\npub mod time_state_clock;"),
        "the time-state authority belongs to the suderra-os profile"
    );
}
