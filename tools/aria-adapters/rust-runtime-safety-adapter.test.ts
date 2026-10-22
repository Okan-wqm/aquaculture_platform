import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { mock } from 'node:test';

import { makeFixtureTree } from '../gates/fixture-tree';

import * as adapterFs from './adapter-fs';
import { analyzeRustRuntimeSafety } from './rust-runtime-safety-adapter';
import { lexRust, type RustTestSpan, testSpans } from './rust-source';

// ARIA-HIGH-010 (plan Task 13). The semantic corpus is the committed
// fixture workspace: a safe and an unsafe twin per claim, plus comment and
// string-literal decoys, plus a harness file nothing in may claim, plus the
// production file's own test items (a `#[cfg(test)] mod`, `#[test]` fns)
// nothing in may claim either. The real-repo half proves the production
// surface (the manifest's roots) is read whole, parses clean, and never
// claims vendored upstream bytes or test code.

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

// Test code inside a production file: the items under `#[cfg(test)]` and the
// `#[test]` / `#[<path>::test]` fns, as the one Rust reader marks them
// (rust-source.ts testSpans; a `macro_rules!` template is not test code).
// The classifier reads the file as production, so the file context alone
// never keeps a claim out of these spans.
const testCodeSpans = new Map<string, readonly RustTestSpan[]>();
const testCodeOf = (path: string): readonly RustTestSpan[] => {
  const known = testCodeSpans.get(path);
  if (known !== undefined) return known;
  const lexed = lexRust(readFileSync(join(REPO_ROOT, path), 'utf8'));
  assert.ok(lexed.ok, `${path} lexes`);
  const spans = testSpans(lexed.tokens).filter((span) => span.kind !== 'macro_rules');
  testCodeSpans.set(path, spans);
  return spans;
};
const inTestCode = (finding: Finding): boolean =>
  testCodeOf(finding.path).some(
    (span) => span.startLine <= finding.line && finding.line <= span.endLine,
  );
const located = (finding: Finding): string => `${finding.rule} ${finding.path}:${finding.line}`;

// ------------------------------------------------ inline test code is never claimed
// src/lib.rs is production, and its own `#[cfg(test)] mod inline_tests`, a
// file-level `#[test]` fn and a `#[tokio::test]` fn carry a would-be finding
// of every rule. A shipped twin after them (dispatch_after_tests) is claimed,
// so a test span ends where its item does.
assert.deepEqual(
  testCodeOf(FIXTURE_LIB).map((span) => [span.kind, span.startLine, span.endLine]),
  [
    ['cfg_test', 336, 360],
    ['test_fn', 362, 368],
    ['test_fn', 370, 376],
    ['cfg_test', 383, 384],
  ],
  'the corpus holds an inline #[cfg(test)] mod, a #[test] fn, a #[tokio::test] fn ' +
    'and the out-of-line #[cfg(test)] mod diagnostics',
);
assert.deepEqual(
  output.findings.filter(inTestCode).map(located).sort(),
  [],
  "nothing inside a production file's own #[cfg(test)] mod or #[test] fn is claimed",
);

// --------------------------------------------- only long-lived loops are claimed
// uncancellable_long_lived_loop is about a loop that waits on the executor
// (an `.await` in its span) with nothing to end it. A loop no `.await`
// drives never parks the task; a loop a timeout or a deadline ends as a
// whole, and a `try_recv` drain in the shutdown arm of a `select!`, end on
// their own. Each pair below is a twin: the same shape, claimed only where
// the loop really can outlive its shutdown.
const LOOP_VERDICTS: readonly (readonly [line: number, claimed: boolean, why: string])[] = [
  [202, false, 'no .await drives the while: a parse over a buffer already in hand'],
  [213, true, 'the await sits in a nested block of the body and nothing ends the loop'],
  [226, false, 'the whole while runs inside tokio::time::timeout'],
  [238, true, 'a timeout on each receive bounds one wait, never the loop'],
  [252, false, 'the while-let ends when its fixed timeout_at deadline passes'],
  [261, true, 'a timeout_at deadline re-armed every round bounds one wait, never the loop'],
  [273, false, 'the loop breaks once its deadline passes'],
  [286, true, 'sleep_until on a deadline the loop keeps moving never ends it'],
  [304, false, 'a try_recv drain in the shutdown arm of a select! never awaits'],
  [321, true, 'it polls with try_recv and a sleep, and nothing ends it'],
  [322, false, 'the try_recv drain inside that poll never awaits'],
];
assert.deepEqual(
  LOOP_VERDICTS.map(([line, , why]) => [
    line,
    at('uncancellable_long_lived_loop', FIXTURE_LIB).some((finding) => finding.line === line),
    why,
  ]),
  LOOP_VERDICTS.map(([line, claimed, why]) => [line, claimed, why]),
  'uncancellable_long_lived_loop claims only loops that wait on the executor with nothing to end them',
);

// -------------------------------------------------------- the corpus verdicts
// The unsafe twins fire, the safe twins and the decoys never do, and neither
// the harness file (#[cfg(test)] mod diagnostics) nor the test items inside
// src/lib.rs is production code.
assert.deepEqual(
  byRule('detached_task').map((finding) => [finding.path, finding.line, finding.subject]),
  [
    [FIXTURE_LIB, 44, 'tokio::spawn'],
    [FIXTURE_LIB, 45, 'thread::spawn'],
    [FIXTURE_LIB, 380, 'tokio::spawn'],
  ],
  'the three discarded handles only: not the stored handle, the aborted one, ' +
    'the joined thread spawn, the awaited task or a spawn inside a test item',
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
    [FIXTURE_LIB, 213, 'loop'],
    [FIXTURE_LIB, 238, 'loop'],
    [FIXTURE_LIB, 261, 'loop'],
    [FIXTURE_LIB, 286, 'loop'],
    [FIXTURE_LIB, 321, 'loop'],
  ],
  'the long-lived async loops only: not the select! loop, the shutdown-conditioned ' +
    'while, the sync busy_collect loop, a loop no .await drives, a loop a timeout or ' +
    'deadline ends, a try_recv drain or a loop inside a test item',
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
  'the uncontracted blocks and impl only: not the SAFETY-commented twins or an ' +
    'unsafe inside a test item, and a SAFETY string literal or a comment a blank ' +
    'line away is no contract',
);
assert.deepEqual(
  byRule('unbounded_external_io').map((finding) => [finding.path, finding.line, finding.subject]),
  [
    [FIXTURE_LIB, 139, 'TcpStream::connect'],
    [FIXTURE_LIB, 157, 'reqwest::get'],
    [FIXTURE_LIB, 171, 'reqwest::Client::builder'],
  ],
  'the three unwrapped calls only: not with_timeout, tokio::time::timeout, ' +
    'the .timeout() builder chain or a call inside a test item',
);
assert.equal(output.findings.length, 17, 'exactly the seventeen gold true positives of the corpus');
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
  findings: 17,
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
  detached_task: 3,
  uncancellable_long_lived_loop: 7,
  unsafe_without_safety_contract: 4,
  unbounded_external_io: 3,
});

// ------------------------------------------------------- evidence contract
for (const finding of output.findings) {
  assert.ok(output.read_paths.includes(finding.path), `${finding.id} cites a read path`);
  for (const ref of finding.evidence) {
    assert.ok(output.read_paths.includes(ref.path), `${finding.id} evidence is a read path`);
    assert.ok(
      ref.line !== undefined && ref.line >= 1,
      `${finding.id} evidence names the line it cites`,
    );
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
) as {
  default_input: { roots: string[] };
  rules: Record<string, unknown>;
};

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
// Nor a production file's own test code: the `#[cfg(test)] mod tests` blocks
// of sens-api-gateway's production files held 31 of the 34 unsafe claims at
// the adapter's landing (`std::env::set_var` / `remove_var` in tests), and
// none of it ships.
assert.deepEqual(
  real.findings.filter(inTestCode).map(located).sort(),
  [],
  "no real finding claims a production file's own #[cfg(test)] mod or #[test] fn",
);
// The real-repo baseline (cases/real-repo-baseline.json) is the fixture
// runner's exact expectation of this scan, so each rule count it pins is a
// count of production claims: the real findings of that rule outside test
// code. A baseline measured while test code was still claimed over-counts
// and fails here.
const baselineCase = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures/rust-runtime-safety-adapter/cases/real-repo-baseline.json'),
    'utf8',
  ),
) as { expected: { required_observation_values: Record<string, unknown>[] } };
const baselineSummary = baselineCase.expected.required_observation_values.find(
  (expectation) => expectation.type === 'rust_runtime_summary',
);
assert.ok(baselineSummary !== undefined, 'the baseline pins the summary observation');
const manifestRules = Object.keys(manifest.rules).sort();
assert.deepEqual(
  manifestRules.map((rule) => [rule, baselineSummary[`details.findings.${rule}`]]),
  manifestRules.map((rule) => [
    rule,
    real.findings.filter((finding) => finding.rule === rule && !inTestCode(finding)).length,
  ]),
  'the real-repo baseline pins every rule at the production claims outside test code',
);
// The fixture judge (aria_kernel fixture_runner) reads each pinned
// `details.findings.<rule>` from the summary itself, so a rule with no finding
// must be a counted zero there, not an absent key: the baseline pins
// `unbounded_external_io: 0`.
assert.deepEqual(
  realSummary.findings,
  Object.fromEntries(
    manifestRules.map((rule) => [rule, baselineSummary[`details.findings.${rule}`]]),
  ),
  'the summary counts every contracted rule, zero included, as the baseline pins it',
);
// The repository carries real uncontracted unsafe code (the FFI boundary of
// sensorprotocols/wasm-decoder-template), detached spawns and long-lived
// async loops with no shutdown path: the observation is not decorative.
// Measured outside test code at the ARIA-HIGH-010 review-round-2 fix: 3
// unsafe, 12 detached, 11 loops (the landing's 34 unsafe and 18 loops
// counted 31 unsafe and 1 loop inside #[cfg(test)] items, and 6 loops that
// are not long-lived). Floors, not exact pins: the baseline case above pins
// the exact counts.
assert.ok(
  real.findings.filter((finding) => finding.rule === 'unsafe_without_safety_contract').length >= 1,
  'the known FFI unsafe sites are observed',
);
assert.ok(real.findings.filter((finding) => finding.rule === 'detached_task').length >= 5);
assert.ok(
  real.findings.filter((finding) => finding.rule === 'uncancellable_long_lived_loop').length >= 5,
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

// ------------------------------------------------------- the per-file byte cap
// A `.rs` file over the per-file cap is skipped with an observation and never
// read: a cap is a refusal, never a hole. The byte count the cap judges is the
// containment owner's answer. adapter-fs.ts owns every filesystem fact an
// adapter acts on (eslint overrides 2b/2c, ARIA-LOW-593), and the executable
// bit already reads through it as `workspaceIsExecutable`; the size is its
// sibling `workspaceFileBytes(workspaceRoot, path)`, not a statSync of the
// adapter's own. On a static tree a walked regular file has one size either
// way, because the walk has already refused every symlink, so the route shows
// only when the owner answers: below it reports a size no file on disk has,
// and the adapter must act on that answer.
{
  const capRoot = realpathSync(makeFixtureTree('aria-rust-runtime-cap-'));
  const CAP_CRATE = 'cap-probe';
  const CAP_LIB = `${CAP_CRATE}/src/lib.rs`;
  const CAP_BIG = `${CAP_CRATE}/src/big.rs`;
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(capRoot, path)), { recursive: true });
    writeFileSync(join(capRoot, path), text, 'utf8');
  };
  /** ASCII text of exactly `bytes` bytes: `head`, then one padded comment line. */
  const sized = (head: string, bytes: number): string =>
    `${head}//${' '.repeat(bytes - head.length - 3)}\n`;
  put(
    `${CAP_CRATE}/Cargo.toml`,
    [
      '[package]',
      'name = "cap-probe"',
      'version = "0.1.0"',
      'edition = "2021"',
      'publish = false',
      '',
      '[lib]',
      'path = "src/lib.rs"',
      '',
    ].join('\n'),
  );
  // big.rs is not declared by any `mod`: the walk alone reaches it.
  put(CAP_LIB, 'pub fn quiet() {}\n');
  put(CAP_BIG, 'pub fn also_quiet() {}\n');
  const scan = (): ReturnType<typeof analyzeRustRuntimeSafety> =>
    analyzeRustRuntimeSafety({ roots: [CAP_CRATE] }, capRoot);
  const refusal = (
    output: ReturnType<typeof analyzeRustRuntimeSafety>,
    path: string,
  ): Record<string, unknown> | undefined =>
    output.observations.find(
      (candidate) => candidate.id === `rust-runtime-safety-adapter:skipped:${path}`,
    )?.details;

  // The owner answers; the adapter acts on the answer.
  const ownerFileBytes = adapterFs.workspaceFileBytes;
  assert.equal(
    typeof ownerFileBytes,
    'function',
    'adapter-fs.ts, the containment owner, answers the byte size of a contained ' +
      'workspace file (workspaceFileBytes), as it answers the executable bit',
  );
  const asked: string[] = [];
  const answered = mock.method(
    adapterFs,
    'workspaceFileBytes',
    (workspaceRoot: string, path: string): number => {
      const askedPath = adapterFs.normalizeWorkspacePath(
        relative(capRoot, resolve(workspaceRoot, path)),
      );
      asked.push(askedPath);
      return askedPath === CAP_BIG ? Number.MAX_SAFE_INTEGER : ownerFileBytes(workspaceRoot, path);
    },
  );
  let routed: ReturnType<typeof analyzeRustRuntimeSafety>;
  try {
    routed = scan();
  } finally {
    answered.mock.restore();
  }
  assert.deepEqual(
    [...new Set(asked.filter((path) => path.endsWith('.rs')))].sort(),
    [CAP_BIG, CAP_LIB],
    'the owner is asked the size of every walked .rs file before it is read',
  );
  const routedRefusal = refusal(routed, CAP_BIG);
  assert.ok(
    routedRefusal !== undefined,
    'the file the owner reports over the cap is refused with an observation',
  );
  assert.equal(routedRefusal.reason, 'file_over_byte_cap');
  assert.equal(
    routedRefusal.bytes,
    Number.MAX_SAFE_INTEGER,
    "the refusal reports the owner's byte count, not a second measurement",
  );
  assert.ok(!routed.read_paths.includes(CAP_BIG), 'a refused file is never read');
  assert.ok(routed.read_paths.includes(CAP_LIB), 'its siblings are still read');
  const cap = routedRefusal.cap;
  assert.ok(typeof cap === 'number' && cap > 64 && cap < Number.MAX_SAFE_INTEGER);

  // The real owner on real bytes: one byte over the cap is refused with the
  // file's true size; exactly the cap is read.
  put(CAP_BIG, sized('', cap + 1));
  const over = scan();
  assert.deepEqual(refusal(over, CAP_BIG), { reason: 'file_over_byte_cap', bytes: cap + 1, cap });
  assert.ok(!over.read_paths.includes(CAP_BIG), 'one byte over the cap is never read');
  put(CAP_BIG, sized('', cap));
  const atCap = scan();
  assert.equal(refusal(atCap, CAP_BIG), undefined, 'a file of exactly the cap is not refused');
  assert.ok(atCap.read_paths.includes(CAP_BIG), 'a file of exactly the cap is read');

  // A refused file stays unread when a `mod` declaration reaches it: the
  // reader follows `mod big;` to the file the walk refused, so the cap must
  // hold on that path too, or the refusal is a hole that reads, classifies
  // and claims the bytes it reports it skipped.
  put(CAP_LIB, 'mod big;\n\npub fn quiet() {}\n');
  put(
    CAP_BIG,
    sized('pub fn dispatch() {\n    tokio::spawn(work());\n}\n\nasync fn work() {}\n', cap + 1),
  );
  const reached = scan();
  assert.deepEqual(refusal(reached, CAP_BIG), {
    reason: 'file_over_byte_cap',
    bytes: cap + 1,
    cap,
  });
  assert.ok(
    !reached.read_paths.includes(CAP_BIG),
    'a refused file reached through `mod big;` is never read',
  );
  assert.deepEqual(
    reached.findings.filter((finding) => finding.path === CAP_BIG).map((finding) => finding.rule),
    [],
    'nothing is claimed in bytes the cap refused',
  );
}

// ------------------------------------------ loop bounds the corpus does not reach
// The loop rule's remaining premises, as twins in a scratch crate: a `while`
// on a deadline fixed before it against one the loop moves, a deadline break
// against a deadline re-bound each round and a break that leaves only a
// nested `for`, a counter cap against a counter every round advances but a
// success resets and a cap the loop may grow, an async block handed to a call that is not a
// timeout, and an awaiting drain in a select! shutdown arm (with an `, if`
// precondition) against the same drain in a data arm and in a data arm whose
// precondition names shutdown. A bound counts only when every round that goes
// around again passes it: a deadline or error-count check one `match` arm
// holds, or one a `continue` skips, against the same check on every round
// (after the `match`, in the only arm that goes around, or in the `else` of
// an `if let` over `timeout_at`). A `while let Ok(…)` over a timeout ends when
// a wait elapses; a `while let Err(…)` goes on. A `while let` struct pattern's
// braces are not the loop body. Each loop line carries a CLAIM or FREE marker
// comment: the lexer strips comments, so a marker is never evidence. A
// macro_rules! template carries a would-be finding of three rules on its
// TEMPLATE lines: a template is code only once expanded.
{
  const loopRoot = realpathSync(makeFixtureTree('aria-rust-runtime-loops-'));
  const LOOP_CRATE = 'loop-bounds';
  const LOOP_LIB = `${LOOP_CRATE}/src/lib.rs`;
  const source = [
    'use std::time::Duration;',
    'use tokio::sync::{mpsc, watch};',
    'use tokio::time::Instant;',
    '',
    'const MAX_ATTEMPTS: u32 = 5;',
    'const WAIT: Duration = Duration::from_millis(10);',
    '',
    'async fn tick() -> bool {',
    '    true',
    '}',
    '',
    'pub async fn until_fixed_deadline() {',
    '    let deadline = Instant::now() + WAIT;',
    '    while Instant::now() < deadline { // FREE',
    '        tick().await;',
    '    }',
    '}',
    '',
    'pub async fn until_moving_deadline() {',
    '    let mut deadline = Instant::now() + WAIT;',
    '    while Instant::now() < deadline { // CLAIM',
    '        tick().await;',
    '        deadline = Instant::now() + WAIT;',
    '    }',
    '}',
    '',
    'pub async fn break_on_rebound_deadline() {',
    '    loop { // CLAIM',
    '        let deadline = Instant::now() + WAIT;',
    '        tick().await;',
    '        if Instant::now() >= deadline {',
    '            break;',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn deadline_break_leaves_only_the_for() {',
    '    let deadline = Instant::now() + WAIT;',
    '    loop { // CLAIM',
    '        for _ in 0..3 {',
    '            if Instant::now() >= deadline {',
    '                break;',
    '            }',
    '        }',
    '        tick().await;',
    '    }',
    '}',
    '',
    'pub async fn retry_until_cap() {',
    '    let mut attempts = 0u32;',
    '    loop { // FREE',
    '        attempts = attempts.saturating_add(1);',
    '        if attempts >= MAX_ATTEMPTS {',
    '            break;',
    '        }',
    '        tick().await;',
    '    }',
    '}',
    '',
    'pub async fn while_under_cap() {',
    '    let mut attempts = 0;',
    '    while attempts < MAX_ATTEMPTS { // FREE',
    '        tick().await;',
    '        attempts += 1;',
    '    }',
    '}',
    '',
    'pub async fn cap_on_a_counter_success_resets() {',
    '    let mut failures = 0u32;',
    '    loop { // CLAIM',
    '        failures += 1;',
    '        if failures >= MAX_ATTEMPTS {',
    '            break;',
    '        }',
    '        if tick().await {',
    '            failures = 0;',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn cap_on_a_growing_buffer(mut buf: Vec<u8>) {',
    '    let mut read = 0usize;',
    '    loop { // CLAIM',
    '        read += 1;',
    '        if read >= buf.len() {',
    '            break;',
    '        }',
    '        buf.push(0);',
    '        tick().await;',
    '    }',
    '}',
    '',
    'pub async fn forever_in_a_spawned_block() {',
    '    let handle = tokio::spawn(async move {',
    '        loop { // CLAIM',
    '            tick().await;',
    '        }',
    '    });',
    '    let _ = handle.await;',
    '}',
    '',
    'pub async fn drain_in_the_shutdown_arm(',
    '    mut rx: mpsc::Receiver<u32>,',
    '    mut shutdown_rx: watch::Receiver<()>,',
    '    armed: bool,',
    ') {',
    '    loop { // FREE',
    '        tokio::select! {',
    '            biased;',
    '            _ = shutdown_rx.changed(), if armed => {',
    '                while let Some(value) = rx.recv().await { // FREE',
    '                    let _ = value;',
    '                }',
    '                return;',
    '            }',
    '            Some(value) = rx.recv() => {',
    '                let _ = value;',
    '            }',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn drain_in_a_data_arm(',
    '    mut rx: mpsc::Receiver<u32>,',
    '    mut more: mpsc::Receiver<u32>,',
    '    mut shutdown_rx: watch::Receiver<()>,',
    ') {',
    '    loop { // FREE',
    '        tokio::select! {',
    '            _ = shutdown_rx.changed() => return,',
    '            Some(first) = more.recv() => {',
    '                while let Some(value) = rx.recv().await { // CLAIM',
    '                    let _ = (first, value);',
    '                }',
    '            }',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn drain_in_a_guarded_data_arm(',
    '    mut rx: mpsc::Receiver<u32>,',
    '    mut more: mpsc::Receiver<u32>,',
    '    mut shutdown_rx: watch::Receiver<()>,',
    '    shutdown_seen: bool,',
    ') {',
    '    loop { // FREE',
    '        tokio::select! {',
    '            _ = shutdown_rx.changed() => return,',
    '            Some(first) = more.recv(), if !shutdown_seen => {',
    '                while let Some(value) = rx.recv().await { // CLAIM',
    '                    let _ = (first, value);',
    '                }',
    '            }',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn deadline_checked_in_one_arm(mut rx: mpsc::Receiver<u32>) {',
    '    let deadline = Instant::now() + WAIT;',
    '    loop { // CLAIM',
    '        match rx.recv().await {',
    '            Some(value) => {',
    '                let _ = value;',
    '            }',
    '            None => {',
    '                if Instant::now() >= deadline {',
    '                    break;',
    '                }',
    '            }',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn deadline_checked_every_round(mut rx: mpsc::Receiver<u32>) {',
    '    let deadline = Instant::now() + WAIT;',
    '    loop { // FREE',
    '        match rx.recv().await {',
    '            Some(value) => {',
    '                let _ = value;',
    '            }',
    '            None => return,',
    '        }',
    '        if Instant::now() >= deadline {',
    '            break;',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn errors_counted_in_one_arm(mut rx: mpsc::Receiver<u32>) {',
    '    let mut errors = 0u32;',
    '    loop { // CLAIM',
    '        match tokio::time::timeout(WAIT, rx.recv()).await {',
    '            Ok(Some(value)) => {',
    '                let _ = value;',
    '            }',
    '            Ok(None) | Err(_) => {',
    '                errors += 1;',
    '                if errors >= MAX_ATTEMPTS {',
    '                    break;',
    '                }',
    '            }',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn retry_while_the_channel_is_full(tx: mpsc::Sender<u32>) {',
    '    let mut attempts = 0u32;',
    '    loop { // FREE',
    '        match tx.try_send(1) {',
    '            Ok(()) => break,',
    '            Err(mpsc::error::TrySendError::Full(_)) => {',
    '                attempts = attempts.saturating_add(1);',
    '                if attempts >= MAX_ATTEMPTS {',
    '                    break;',
    '                }',
    '                tick().await;',
    '            }',
    '            Err(mpsc::error::TrySendError::Closed(_)) => return,',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn continue_skips_the_deadline(mut rx: mpsc::Receiver<u32>) {',
    '    let deadline = Instant::now() + WAIT;',
    '    loop { // CLAIM',
    '        let Some(value) = rx.recv().await else {',
    '            continue;',
    '        };',
    '        if Instant::now() >= deadline {',
    '            break;',
    '        }',
    '        let _ = value;',
    '    }',
    '}',
    '',
    'pub async fn else_leaves_at_the_deadline(mut rx: mpsc::Receiver<u32>) {',
    '    let deadline = Instant::now() + WAIT;',
    '    loop { // FREE',
    '        if let Ok(Some(value)) = tokio::time::timeout_at(deadline, rx.recv()).await {',
    '            let _ = value;',
    '        } else {',
    '            break;',
    '        }',
    '    }',
    '}',
    '',
    'pub async fn receive_until_idle(mut rx: mpsc::Receiver<u32>) {',
    '    while let Ok(Some(value)) = tokio::time::timeout(WAIT, rx.recv()).await { // FREE',
    '        let _ = value;',
    '    }',
    '}',
    '',
    'pub async fn retry_until_a_receive_completes(mut rx: mpsc::Receiver<u32>) {',
    '    while let Err(_) = tokio::time::timeout(WAIT, rx.recv()).await { // CLAIM',
    '        tick().await;',
    '    }',
    '}',
    '',
    'pub enum Event {',
    '    Frame { id: u32 },',
    '    Stop,',
    '}',
    '',
    'async fn next_event() -> Event {',
    '    Event::Stop',
    '}',
    '',
    'pub async fn frames_until_stop() {',
    '    while let Event::Frame { id } = next_event().await { // CLAIM',
    '        let _ = id;',
    '    }',
    '}',
    '',
    'macro_rules! forever_template {',
    '    ($rx:expr) => {',
    '        tokio::spawn(async move { // TEMPLATE',
    '            loop { // TEMPLATE',
    '                $rx.recv().await;',
    '            }',
    '        });',
    '        let _ = unsafe { core::ptr::read(&0u8) }; // TEMPLATE',
    '    };',
    '}',
    '',
  ].join('\n');
  mkdirSync(join(loopRoot, LOOP_CRATE, 'src'), { recursive: true });
  writeFileSync(
    join(loopRoot, LOOP_CRATE, 'Cargo.toml'),
    '[package]\nname = "loop-bounds"\nversion = "0.1.0"\nedition = "2021"\npublish = false\n\n[lib]\npath = "src/lib.rs"\n',
    'utf8',
  );
  writeFileSync(join(loopRoot, LOOP_LIB), source, 'utf8');
  const loopScan = analyzeRustRuntimeSafety({ roots: [LOOP_CRATE] }, loopRoot);
  const marked = (marker: string): number[] =>
    source.split('\n').flatMap((text, index) => (text.includes(`// ${marker}`) ? [index + 1] : []));
  const loopScanSummary =
    loopScan.observations.find((o) => o.id === 'rust-runtime-safety-adapter:summary')?.details ??
    {};
  assert.equal(loopScanSummary.production_files, 1, 'the scratch crate is production code');
  assert.equal(loopScanSummary.parse_failures, 0, 'the scratch crate lexes');
  assert.deepEqual(
    loopScan.findings
      .filter((finding) => finding.rule === 'uncancellable_long_lived_loop')
      .map((finding) => finding.line)
      .sort((a, b) => a - b),
    marked('CLAIM'),
    'exactly the CLAIM loops are claimed: no FREE loop, and nothing inside the template',
  );
  assert.ok(marked('FREE').length === 11 && marked('TEMPLATE').length === 3);
  assert.deepEqual(
    loopScan.findings
      .filter((finding) => marked('TEMPLATE').includes(finding.line))
      .map((finding) => `${finding.rule}:${finding.line}`),
    [],
    'no rule claims a macro_rules! template',
  );
}

process.stdout.write('rust-runtime-safety-adapter.test.ts OK\n');
