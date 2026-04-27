#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
//
// check-codec-drift.ts — drift CI invariant for protocol-codec.
//
// WHY this script exists
//   Per ADR-026, the SAME golden fixture set
//   (crates/protocol-codec/tests/golden/*.json) is consumed by both:
//     1. The Rust integration test
//          crates/protocol-codec/tests/golden_fixtures.rs
//     2. The TypeScript-side codec adapter tests
//          apps/sensor-service/src/protocol/adapters/__tests__/codec-drift.spec.ts
//   Any divergence between the two is, by definition, a parser bug in
//   one side. This script is the gate that fails CI when that happens.
//
// WHAT it does (in this stage)
//   - Validates every fixture against the schema (required fields,
//     known decoder names, exactly one of expected_ok / expected_err).
//   - Runs `cargo test --test golden_fixtures` (Rust side).
//   - Detects whether the TS-side spec exists; if it does, runs it via
//     `nx test sensor-service --testPathPattern=codec-drift` and the
//     test itself is responsible for asserting byte-equivalence.
//
// WHAT it does NOT do (yet)
//   - Cross-language byte-equivalence diff. The TS-side spec, when it
//     lands in Faz 4, will read the same fixture files and assert
//     against the same expected_ok / expected_err shape — making the
//     drift check structural rather than diff-based.
//
// USAGE
//   node --experimental-strip-types tools/scripts/check-codec-drift.ts
//
// EXIT CODES
//   0  — every fixture is well-formed and Rust side passed (TS side
//        skipped if not present yet).
//   1  — schema violation OR Rust test failed OR TS test failed.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, stderr, stdout } from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN_DIR = join(
    REPO_ROOT,
    "crates",
    "protocol-codec",
    "tests",
    "golden",
);
const TS_SPEC_REL =
    "apps/sensor-service/src/protocol/adapters/__tests__/codec-drift.spec.ts";

// Single source of truth for which decoder names are routable. Mirror
// of the dispatch table in golden_fixtures.rs; if you add a decoder
// there, add it here.
const KNOWN_DECODERS = new Set<string>([
    "parse_mbap_header",
    "parse_rtu_frame",
    "parse_ascii_frame",
    "decode_read_holding_registers_response",
    "decode_read_input_registers_response",
    "decode_write_single_register",
    "decode_write_multiple_registers_response",
    "decode_exception_response",
]);

interface Fixture {
    name?: unknown;
    description?: unknown;
    decoder?: unknown;
    wire_hex?: unknown;
    expected_ok?: unknown;
    expected_err?: unknown;
}

function info(msg: string): void {
    stdout.write(`[drift] ${msg}\n`);
}

function err(msg: string): void {
    stderr.write(`[drift] ERROR: ${msg}\n`);
}

function fail(msg: string): never {
    err(msg);
    exit(1);
}

function isHex(s: string): boolean {
    const cleaned = s.replace(/\s+/g, "");
    return cleaned.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(cleaned);
}

function validateFixtureFile(path: string): void {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (e) {
        fail(`cannot read ${path}: ${(e as Error).message}`);
    }

    let parsed: Fixture;
    try {
        parsed = JSON.parse(raw) as Fixture;
    } catch (e) {
        fail(`malformed JSON in ${path}: ${(e as Error).message}`);
    }

    if (typeof parsed.name !== "string" || parsed.name.length === 0) {
        fail(`${path}: 'name' must be a non-empty string`);
    }
    if (typeof parsed.description !== "string" || parsed.description.length < 10) {
        fail(`${path}: 'description' must be a non-empty string of at least 10 chars`);
    }
    if (typeof parsed.decoder !== "string" || !KNOWN_DECODERS.has(parsed.decoder)) {
        fail(
            `${path}: 'decoder' must be one of {${[...KNOWN_DECODERS].join(", ")}} (got '${String(
                parsed.decoder,
            )}')`,
        );
    }
    if (typeof parsed.wire_hex !== "string" || !isHex(parsed.wire_hex)) {
        fail(`${path}: 'wire_hex' must be an even-length hex string (whitespace ignored)`);
    }
    const okSet = parsed.expected_ok !== undefined;
    const errSet = parsed.expected_err !== undefined;
    if (okSet === errSet) {
        fail(`${path}: must set EXACTLY one of expected_ok or expected_err`);
    }
    if (errSet) {
        const e = parsed.expected_err as { kind?: unknown };
        const knownErrs = new Set([
            "Truncated",
            "LengthMismatch",
            "BadChecksum",
            "UnsupportedFunctionCode",
            "InvalidProtocolId",
            "TenantMismatch",
            "Malformed",
        ]);
        if (typeof e.kind !== "string" || !knownErrs.has(e.kind)) {
            fail(
                `${path}: expected_err.kind must be one of {${[...knownErrs].join(
                    ", ",
                )}} (got '${String(e.kind)}')`,
            );
        }
    }
}

function listFixtures(): string[] {
    let entries: string[];
    try {
        entries = readdirSync(GOLDEN_DIR);
    } catch (e) {
        fail(`cannot read ${GOLDEN_DIR}: ${(e as Error).message}`);
    }
    return entries
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(GOLDEN_DIR, f))
        .sort();
}

function runRustGoldenTest(): boolean {
    info("running Rust golden_fixtures integration test");
    // Caller must have a Rust toolchain available. CI installs it via
    // dtolnay/rust-toolchain in rust-ci.yml.
    const r = spawnSync(
        "cargo",
        [
            "test",
            "--manifest-path",
            join(REPO_ROOT, "Cargo.toml"),
            "-p",
            "protocol-codec",
            "--test",
            "golden_fixtures",
            "--no-fail-fast",
        ],
        { stdio: "inherit", cwd: REPO_ROOT },
    );
    return r.status === 0;
}

function runTsSpecIfPresent(): boolean | "skipped" {
    const tsSpecAbs = join(REPO_ROOT, TS_SPEC_REL);
    let st;
    try {
        st = statSync(tsSpecAbs);
    } catch {
        info(
            `TS-side codec-drift spec not present yet (${TS_SPEC_REL}). ` +
                "Will be added in Faz 4 (sens-api-gateway crate adoption); " +
                "the rust-side check still ran. Skipping TS leg.",
        );
        return "skipped";
    }
    if (!st.isFile()) {
        fail(`${TS_SPEC_REL} exists but is not a file`);
    }
    info(`running TS-side codec-drift spec via nx`);
    const r = spawnSync(
        "npx",
        [
            "nx",
            "test",
            "sensor-service",
            "--testPathPattern=codec-drift",
            "--watchAll=false",
        ],
        { stdio: "inherit", cwd: REPO_ROOT },
    );
    return r.status === 0;
}

function main(): void {
    const fixtures = listFixtures();
    if (fixtures.length === 0) {
        fail(`no fixtures found in ${GOLDEN_DIR}`);
    }
    info(`validating ${fixtures.length} fixture file(s) under ${GOLDEN_DIR}`);
    for (const f of fixtures) {
        validateFixtureFile(f);
    }
    info(`schema OK for all ${fixtures.length} fixtures`);

    const rustOk = runRustGoldenTest();
    if (!rustOk) {
        fail("Rust golden_fixtures test FAILED");
    }
    info("Rust side ✅");

    const tsResult = runTsSpecIfPresent();
    if (tsResult === false) {
        fail("TS codec-drift spec FAILED");
    }
    if (tsResult === true) {
        info("TS side ✅");
        info("DRIFT CHECK PASSED — Rust + TS both agree");
    } else {
        info("DRIFT CHECK PARTIAL (Rust only) — TS leg skipped, see message above");
    }
}

main();
