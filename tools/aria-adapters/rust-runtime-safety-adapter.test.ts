import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { analyzeRustRuntimeSafety } from './rust-runtime-safety-adapter';

// ARIA-HIGH-010 (plan Task 13). The semantic corpus is the committed
// fixture workspace: a safe and an unsafe twin per claim, plus comment and
// string-literal decoys, plus a harness file nothing in may claim. The
// real-repo half proves the production surface (the manifest's roots) is
// read whole, parses clean, and never claims vendored upstream bytes.

const REPO_ROOT = resolve(__dirname, '..', '..');
const FIXTURE_ROOT =
  'tools/aria-adapters/fixtures/rust-runtime-safety-adapter/workspaces/semantic-runtime-safety';
const FIXTURE_LIB = `${FIXTURE_ROOT}/src/lib.rs`;
const FIXTURE_DIAGNOSTICS = `${FIXTURE_ROOT}/src/diagnostics.rs`;

const output = analyzeRustRuntimeSafety({ roots: [FIXTURE_ROOT] }, REPO_ROOT);

type Finding = (typeof output.findings)[number];
const byRule = (rule: string): Finding[] =>
  output.findings.filter((finding) => finding.rule === rule).sort((a, b) => a.line - b.line);
const at = (rule: string, path: string): Finding[] =>
  byRule(rule).filter((finding) => finding.path === path);
const observation = (id: string): Record<string, unknown> => {
  const found = output.observations.find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `missing observation ${id}`);
  return found.details ?? {};
};
const summary = (): Record<string, unknown> => observation('rust-runtime-safety-adapter:summary');

// -------------------------------------------------------- the corpus verdicts
// The unsafe twins fire, the safe twins and the decoys never do, and the
// harness file (#[cfg(test)] mod diagnostics) is not production code.
assert.deepEqual(
  byRule('detached_task').map((finding) => [finding.path, finding.line, finding.subject]),
  [
    [FIXTURE_LIB, 44, 'tokio::spawn'],
    [FIXTURE_LIB, 45, 'thread::spawn'],
  ],
  'the two discarded handles only: not the stored handle, the aborted one, ' +
    'the joined thread spawn or the awaited task',
);
assert.deepEqual(
  byRule('uncancellable_long_lived_loop').map((finding) => [
    finding.path,
    finding.line,
    finding.subject,
  ]),
  [
    [FIXTURE_LIB, 66, 'loop'],
    [FIXTURE_LIB, 73, 'while'],
  ],
  'the two cancellation-free async loops only: not the select! loop, the ' +
    'shutdown-conditioned while or the sync busy_collect loop',
);
assert.deepEqual(
  byRule('unsafe_without_safety_contract').map((finding) => [
    finding.path,
    finding.line,
    finding.subject,
  ]),
  [
    [FIXTURE_LIB, 106, 'unsafe block'],
    [FIXTURE_LIB, 119, 'unsafe block'],
    [FIXTURE_LIB, 125, 'unsafe block'],
    [FIXTURE_LIB, 134, 'unsafe impl'],
  ],
  'the uncontracted blocks and impl only: not the SAFETY-commented twins, ' +
    'and a SAFETY string literal or a comment a blank line away is no contract',
);
assert.deepEqual(
  byRule('unbounded_external_io').map((finding) => [finding.path, finding.line, finding.subject]),
  [
    [FIXTURE_LIB, 139, 'TcpStream::connect'],
    [FIXTURE_LIB, 157, 'reqwest::get'],
    [FIXTURE_LIB, 171, 'reqwest::Client::builder'],
  ],
  'the three unwrapped calls only: not with_timeout, tokio::time::timeout ' +
    'or the .timeout() builder chain',
);
assert.equal(output.findings.length, 11, 'exactly the eleven gold true positives of the corpus');
assert.equal(
  at('detached_task', FIXTURE_DIAGNOSTICS).length +
    at('uncancellable_long_lived_loop', FIXTURE_DIAGNOSTICS).length +
    at('unsafe_without_safety_contract', FIXTURE_DIAGNOSTICS).length +
    at('unbounded_external_io', FIXTURE_DIAGNOSTICS).length,
  0,
  'the harness file carries a would-be finding of every rule and is never claimed',
);

// Every verdict names the bounded syntactic evidence that made it unsafe.
for (const finding of output.findings) {
  assert.match(finding.message, /line \d+/);
  assert.ok(finding.evidence.length >= 1);
}
const loopFinding = byRule('uncancellable_long_lived_loop')[0];
assert.ok(loopFinding !== undefined);
assert.match(
  loopFinding.message,
  /no cancellation evidence/,
  'the loop claim states what was searched for and not found',
);

// ------------------------------------------------------- the file observations
assert.deepEqual(observation(`rust-runtime-safety-adapter:file:${FIXTURE_LIB}`), {
  context: 'production',
  crate: FIXTURE_ROOT,
  findings: 11,
  parsed: true,
});
assert.deepEqual(observation(`rust-runtime-safety-adapter:file:${FIXTURE_DIAGNOSTICS}`), {
  context: 'harness',
  crate: FIXTURE_ROOT,
  findings: 0,
  parsed: true,
});

// ---------------------------------------------------------------- the summary
assert.equal(summary().production_files, 1);
assert.equal(summary().harness_files, 1);
assert.equal(summary().parse_failures, 0);
assert.equal(summary().clean, true);
assert.equal(summary().authorities_complete, true);
assert.deepEqual(summary().findings, {
  detached_task: 2,
  uncancellable_long_lived_loop: 2,
  unsafe_without_safety_contract: 4,
  unbounded_external_io: 3,
});

// ------------------------------------------------------- evidence contract
for (const finding of output.findings) {
  assert.ok(output.read_paths.includes(finding.path), `${finding.id} cites a read path`);
  for (const ref of finding.evidence) {
    assert.ok(output.read_paths.includes(ref.path), `${finding.id} evidence is a read path`);
    assert.ok(ref.line >= 1);
  }
  assert.match(finding.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(finding.owner, 'tools/aria-adapters/rust-runtime-safety-adapter.ts');
}
assert.equal(new Set(output.findings.map((finding) => finding.id)).size, output.findings.length);
assert.ok(output.read_paths.includes(`${FIXTURE_ROOT}/Cargo.toml`));
assert.ok(output.read_paths.includes(FIXTURE_LIB));
assert.ok(output.evidence_sources.every((source) => output.read_paths.includes(source)));
assert.ok(output.cost_units > 0);

// The same tree twice gives the same answer; a line shift keeps fingerprints.
assert.deepEqual(analyzeRustRuntimeSafety({ roots: [FIXTURE_ROOT] }, REPO_ROOT), output);
const originalLib = readFileSync(join(REPO_ROOT, FIXTURE_LIB), 'utf8');
try {
  writeFileSync(
    join(REPO_ROOT, FIXTURE_LIB),
    originalLib.replace(
      '//! the comment and string-literal decoys',
      '//! the comment and string-literal decoys\n//! (shifted by one line on purpose)\n//! and one more',
    ),
    'utf8',
  );
  const shifted = analyzeRustRuntimeSafety({ roots: [FIXTURE_ROOT] }, REPO_ROOT);
  assert.deepEqual(
    shifted.findings.map((finding) => finding.fingerprint),
    output.findings.map((finding) => finding.fingerprint),
    'fingerprints survive a line shift',
  );
  assert.deepEqual(
    shifted.findings.map((finding) => finding.line),
    output.findings.map((finding) => finding.line + 2),
    'lines move with the shift',
  );
} finally {
  writeFileSync(join(REPO_ROOT, FIXTURE_LIB), originalLib, 'utf8');
}

// ---------------------------------------------------------- input contract
assert.throws(() => analyzeRustRuntimeSafety({}, REPO_ROOT), /roots is required/);
assert.throws(
  () => analyzeRustRuntimeSafety({ roots: ['../escape'] }, REPO_ROOT),
  /not a contained workspace-relative path/,
);
const snapshot = analyzeRustRuntimeSafety(
  { roots: [FIXTURE_ROOT], repo_snapshot: { allowed_paths: [FIXTURE_LIB] } },
  REPO_ROOT,
);
assert.deepEqual(
  snapshot.read_paths.filter((path) => !path.startsWith('tools/aria-adapters/')),
  [],
  'a snapshot pins every read to its allowed set',
);
assert.equal(
  (snapshot.observations.find((o) => o.id === 'rust-runtime-safety-adapter:summary')?.details ?? {})
    .authorities_complete,
  false,
  'the reader modules are outside the snapshot, so the authorities say so',
);

// ---------------------------------------------------------------- real repo
// The production scan surface (the manifest's roots) over this checkout:
// every file parses, the vendored fork is read but never claimed, and the
// claims stay inside the production context.
const manifest = JSON.parse(
  readFileSync(join(__dirname, 'rust-runtime-safety-adapter.tool.json'), 'utf8'),
) as { declared_scope: string[]; default_input: { roots: string[] } };

// The manifest claims only what the production input walks: each glob's
// literal prefix must sit under one of the roots (the observation map
// counts a declared_scope match as seen).
for (const glob of manifest.declared_scope) {
  const wildcard = glob.search(/[*?[{]/);
  const literal = wildcard < 0 ? glob : glob.slice(0, wildcard);
  assert.ok(
    manifest.default_input.roots.some((root) => literal.startsWith(`${root}/`)),
    `declared_scope ${glob} reaches outside the scan roots ${manifest.default_input.roots.join(', ')}`,
  );
}

const real = analyzeRustRuntimeSafety({ roots: manifest.default_input.roots }, REPO_ROOT);
const realSummary =
  real.observations.find((o) => o.id === 'rust-runtime-safety-adapter:summary')?.details ?? {};
assert.equal(realSummary.parse_failures, 0, 'every tracked Rust file on the surface lexes');
assert.equal(realSummary.clean, true);
assert.equal(realSummary.authorities_complete, true);
assert.ok((realSummary.production_files as number) >= 250, 'every production file is classified');
assert.ok((realSummary.harness_files as number) >= 50, 'test/bench/fuzz files are classified');
assert.ok((realSummary.upstream_files as number) >= 1, 'the vendored fork is read as upstream');

// Upstream bytes are the vendored crate's, not ours: never claimed.
const upstreamPaths = real.observations
  .filter((o) => o.type === 'rust_runtime_file' && o.details?.context === 'upstream')
  .map((o) => o.path as string);
assert.ok(upstreamPaths.length >= 1);
for (const finding of real.findings) {
  assert.ok(
    !upstreamPaths.includes(finding.path),
    `${finding.id} claims upstream bytes (${finding.path})`,
  );
}
// And no finding cites a harness file.
const harnessPaths = new Set(
  real.observations
    .filter((o) => o.type === 'rust_runtime_file' && o.details?.context === 'harness')
    .map((o) => o.path as string),
);
for (const finding of real.findings) {
  assert.ok(!harnessPaths.has(finding.path), `${finding.id} claims harness code (${finding.path})`);
}
// The repository carries real uncontracted unsafe code (the FFI boundary),
// detached spawns and cancellation-free async loops: the observation is not
// decorative. Measured at the corpus landing: 34 unsafe, 12 detached, 18
// loops — floors, not exact pins, so a Rust PR that fixes sites moves them
// without touching this test.
assert.ok(
  real.findings.filter((finding) => finding.rule === 'unsafe_without_safety_contract').length >= 20,
  'the known FFI unsafe sites are observed',
);
assert.ok(real.findings.filter((finding) => finding.rule === 'detached_task').length >= 5);
assert.ok(
  real.findings.filter((finding) => finding.rule === 'uncancellable_long_lived_loop').length >= 10,
);
// Every path-form external I/O entry point on this tree is bounded
// (`with_timeout`, `tokio::time::timeout`, a builder `.timeout(…)`): the
// repo's convention holds, so the projection holds it too.
assert.deepEqual(
  real.findings.filter((finding) => finding.rule === 'unbounded_external_io'),
  [],
  'every path-form connect/get/builder on this tree carries a timeout bound',
);
// The bounded vocabulary stays bounded: a scan of this tree stays well under
// the manifest's cost ceiling.
assert.ok(
  real.cost_units <=
    (
      JSON.parse(
        readFileSync(join(__dirname, 'rust-runtime-safety-adapter.tool.json'), 'utf8'),
      ) as { health_thresholds: { max_cost_units: number } }
    ).health_thresholds.max_cost_units,
  `cost_units ${real.cost_units} exceeds the manifest ceiling`,
);

process.stdout.write('rust-runtime-safety-adapter.test.ts OK\n');
