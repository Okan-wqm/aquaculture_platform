#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
//
// check-sensor-contract-parity.ts — cloud↔edge deploy-contract parity gate
// (enterprise plan Faz 4; same shape as check-codec-drift.ts / ADR-026).
//
// WHY this script exists
//   The SAME fixture set (libs/sensor-contracts/fixtures/*.json) is
//   consumed by both:
//     1. The TS spec
//          libs/sensor-contracts/src/__tests__/contract-fixtures.spec.ts
//        — proves each fixture satisfies the canonical AJV schemas the
//        cloud enforces at its MQTT publish boundary.
//     2. The Rust unit-test module
//          sens-api-gateway/src/contract_fixtures_tests.rs
//        — proves the same bytes deserialize into the agent's serde
//        structs (CommandMessage / ScadaProcess / ProgramDefinition /
//        ScadaPackage) with load-bearing fields POPULATED, not
//        silently defaulted.
//   Any divergence between the two is, by definition, a contract drift
//   (the class of bug that shipped camelCase `fbType`/`onError`/
//   `intervalSecs` to an agent expecting snake_case). This script is
//   the gate that fails CI when that happens.
//
// USAGE
//   node --experimental-strip-types tools/scripts/check-sensor-contract-parity.ts
//
// EXIT CODES
//   0 — fixtures well-formed + TS leg passed (+ Rust leg passed, or
//       skipped when no cargo toolchain is installed — the Rust leg
//       also runs in the edge crate's own CI via plain `cargo test`).
//   1 — fixture violation OR either leg failed.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";

// Derive the repo root from the entry-script path (argv[1]) rather than
// `import.meta.url` so the file type-checks under any `module` setting — the
// changed-files gate compiles it under tsconfig.base.json, which forbids
// import.meta (TS1343). This script is always the process entry, so argv[1] is
// its own path: tools/scripts/<this>.ts → ../../ is the repo root.
const entryScript = argv[1];
if (!entryScript) {
    stderr.write("[parity] cannot determine entry-script path (argv[1] missing)\n");
    exit(2);
}
const REPO_ROOT = resolve(dirname(entryScript), "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "libs", "sensor-contracts", "fixtures");
const EDGE_CRATE_DIR = join(REPO_ROOT, "sens-api-gateway");

// Single source of truth for the fixture roster. The TS spec asserts the
// same list (no-orphan-fixtures test); if you add a fixture, add it in
// BOTH places plus a deserialization test in contract_fixtures_tests.rs.
const EXPECTED_FIXTURES = [
    "command-envelope.json",
    "deploy-bundle.json",
    "deploy-process.json",
    "deploy-program.json",
    "deploy-scada-package.json",
];

function info(msg: string): void {
    stdout.write(`[parity] ${msg}\n`);
}

function err(msg: string): void {
    stderr.write(`[parity] ERROR: ${msg}\n`);
}

function fail(msg: string): never {
    err(msg);
    exit(1);
}

function validateEnvelopeShape(path: string): void {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (e) {
        fail(`cannot read ${path}: ${(e as Error).message}`);
    }

    let parsed: {
        commandId?: unknown;
        command?: unknown;
        params?: unknown;
        timestamp?: unknown;
    };
    try {
        parsed = JSON.parse(raw) as typeof parsed;
    } catch (e) {
        fail(`malformed JSON in ${path}: ${(e as Error).message}`);
    }

    if (typeof parsed.commandId !== "string" || parsed.commandId.length === 0) {
        fail(`${path}: 'commandId' must be a non-empty string`);
    }
    if (typeof parsed.command !== "string" || parsed.command.length === 0) {
        fail(`${path}: 'command' must be a non-empty string`);
    }
    if (
        parsed.params === null ||
        typeof parsed.params !== "object" ||
        Array.isArray(parsed.params)
    ) {
        fail(`${path}: 'params' must be a JSON object`);
    }
    if (typeof parsed.timestamp !== "string" || parsed.timestamp.length === 0) {
        fail(`${path}: 'timestamp' must be a non-empty string`);
    }
}

function checkFixtureRoster(): string[] {
    let entries: string[];
    try {
        entries = readdirSync(FIXTURES_DIR);
    } catch (e) {
        fail(`cannot read ${FIXTURES_DIR}: ${(e as Error).message}`);
    }
    const onDisk = entries.filter((f) => f.endsWith(".json")).sort();
    const expected = [...EXPECTED_FIXTURES].sort();
    if (JSON.stringify(onDisk) !== JSON.stringify(expected)) {
        fail(
            `fixture roster drifted.\n  expected: ${expected.join(", ")}\n  on disk:  ${onDisk.join(", ")}`,
        );
    }
    return onDisk.map((f) => join(FIXTURES_DIR, f));
}

function runTsLeg(): boolean {
    info("running TS-side contract-fixtures spec via nx");
    const r = spawnSync(
        "npx",
        [
            "nx",
            "test",
            "sensor-contracts",
            "--testPathPattern=contract-fixtures",
            "--watchAll=false",
        ],
        { stdio: "inherit", cwd: REPO_ROOT },
    );
    return r.status === 0;
}

function runRustLeg(): boolean | "skipped" {
    const probe = spawnSync("cargo", ["--version"], { stdio: "ignore" });
    if (probe.error || probe.status !== 0) {
        info(
            "no cargo toolchain on this runner — Rust leg skipped here. " +
                "It runs unconditionally in the edge crate's own CI " +
                "(`cargo test --features scada-display contract_fixtures` " +
                "inside sens-api-gateway).",
        );
        return "skipped";
    }
    info("running Rust-side contract_fixtures tests (scada-display feature)");
    const r = spawnSync(
        "cargo",
        ["test", "--features", "scada-display", "contract_fixtures"],
        { stdio: "inherit", cwd: EDGE_CRATE_DIR },
    );
    return r.status === 0;
}

function main(): void {
    const fixtures = checkFixtureRoster();
    info(`validating ${fixtures.length} fixture envelope(s) under ${FIXTURES_DIR}`);
    for (const f of fixtures) {
        validateEnvelopeShape(f);
    }
    info(`envelope shape OK for all ${fixtures.length} fixtures`);

    if (!runTsLeg()) {
        fail("TS contract-fixtures spec FAILED");
    }
    info("TS side ✅");

    const rust = runRustLeg();
    if (rust === false) {
        fail("Rust contract_fixtures tests FAILED");
    }
    if (rust === true) {
        info("Rust side ✅");
        info("PARITY CHECK PASSED — cloud + edge agree on the deploy contracts");
    } else {
        info("PARITY CHECK PARTIAL (TS only) — Rust leg skipped, see message above");
    }
}

main();
