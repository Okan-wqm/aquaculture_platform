#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-13 / EDGE-HIGH-058 — a GPIO output keeps its safe level when
//! the agent lets go of it.
//!
//! rppal's `OutputPin` puts the pin back into its previous mode when it is
//! dropped, and that is the default. The shutdown sequence drives every output
//! to its safe level and then drops the GPIO actor, so a pin built with the
//! default went back to an input a moment after it was made safe and the
//! relay board followed its own pull resistors. Every output pin of the crate
//! is therefore built by one function, `output_at_safe_level`, which switches
//! the pin to output already at its safe level and turns the reset off.
//!
//! The pin type exists only behind the `gpio` feature (Linux), which `cargo
//! test` does not build by default; a scan of the source the feature compiles
//! keeps the construction in that one place.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use source_scan_support::scan_src;

const BUILDER: &str = "fn output_at_safe_level";

/// The body of the builder in `src/gpio.rs` (text between its braces).
fn builder_body(code: &str) -> (usize, usize) {
    let at = code
        .find(BUILDER)
        .unwrap_or_else(|| panic!("src/gpio.rs no longer defines `{BUILDER}`"));
    let open = at + code[at..].find('{').expect("builder body");
    let mut depth = 0usize;
    for (i, b) in code.bytes().enumerate().skip(open) {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return (open, i);
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces in `{BUILDER}`");
}

/// Whether any file other than the module itself names it (`pwm::`).
fn module_is_referenced(files: &[source_scan_support::Scanned], module: &str) -> bool {
    let own = format!("src/{module}.rs");
    let path = format!("{module}::");
    files.iter().filter(|f| f.rel != own).any(|f| {
        f.code.match_indices(&path).any(|(at, _)| {
            // `crate::pwm::`, `super::pwm::`, `pwm::` - not `rtpwm::`.
            at == 0
                || !f.code.as_bytes()[at - 1].is_ascii_alphanumeric()
                    && f.code.as_bytes()[at - 1] != b'_'
        })
    })
}

fn line_range(code: &str, (open, close): (usize, usize)) -> std::ops::RangeInclusive<usize> {
    let line = |at: usize| code[..at].bytes().filter(|b| *b == b'\n').count() + 1;
    line(open)..=line(close)
}

/// Every `into_output*` call of the crate sits in the builder, and the builder
/// turns the reset off.
#[test]
fn every_output_pin_is_built_at_its_safe_level_without_the_reset() {
    let files = scan_src();
    let gpio = files
        .iter()
        .find(|f| f.rel == "src/gpio.rs")
        .expect("src/gpio.rs is scanned");
    let body = builder_body(&gpio.code);
    let inside = line_range(&gpio.code, body);

    let pwm_wired = module_is_referenced(&files, "pwm");
    let mut calls = 0;
    for file in &files {
        for line in file.code_lines_with(".into_output") {
            // `src/pwm.rs` (software PWM) is declared but no code path reaches
            // it: it has no configuration, handle or safe-state owner (the AG2
            // incidental). It may keep its own construction only while nothing
            // references the module; wiring it makes this scan apply to it.
            if file.rel == "src/pwm.rs" && !pwm_wired {
                continue;
            }
            calls += 1;
            assert!(
                file.rel == "src/gpio.rs" && inside.contains(&line),
                "{}:{line} builds an output pin outside `{BUILDER}`: rppal's default puts the \
                 pin back to an input when it is dropped, which undoes the safe state after \
                 shutdown (EDGE-HIGH-058)",
                file.rel
            );
        }
    }
    assert_eq!(
        calls, 2,
        "`{BUILDER}` builds the pin high or low and nothing else does"
    );

    let text = &gpio.code[body.0..=body.1];
    assert!(
        text.contains(".set_reset_on_drop(false)"),
        "`{BUILDER}` must turn the reset on drop off: the safe level has to outlive the agent"
    );
    for file in &files {
        assert!(
            file.code_lines_with("set_reset_on_drop(true)").is_empty(),
            "{} re-enables the reset on drop of an output pin",
            file.rel
        );
    }
}

/// The actor builds its outputs through the builder (the builder is not dead
/// code the actor stopped calling).
#[test]
fn the_gpio_actor_acquires_its_outputs_through_the_builder() {
    let files = scan_src();
    let gpio = files
        .iter()
        .find(|f| f.rel == "src/gpio.rs")
        .expect("src/gpio.rs is scanned");
    let body = builder_body(&gpio.code);
    let inside = line_range(&gpio.code, body);
    let callers: Vec<usize> = gpio
        .code_lines_with("output_at_safe_level(")
        .into_iter()
        .filter(|l| !inside.contains(l))
        .collect();
    // The definition line is inside the range; a call site is outside it.
    assert!(
        !callers.is_empty(),
        "the GPIO actor no longer calls `output_at_safe_level`"
    );
}
