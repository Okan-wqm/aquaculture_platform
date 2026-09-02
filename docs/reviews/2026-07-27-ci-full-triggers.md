# CI Full trigger and summary contract

**Date:** 2026-07-27
**Baseline:** `99afcff0`

## INFRA-HIGH-084 — full CI did not protect PR or main SHAs

`CI - Full` ran weekly, manually and for release tags. A pull request could therefore merge
without the full project matrix, and the merge commit itself had no full-CI evidence.

The workflow also grouped concurrency by `github.ref` and set `cancel-in-progress: true`.
Every main push shares `refs/heads/main`, so a later merge could cancel the exact-main SHA run
that was supposed to serve as protected release evidence.

The repair:

- triggers CI Full for pull requests targeting `main` and pushes to `main`;
- groups PR runs by PR number and all other runs by immutable SHA;
- cancels only superseded PR runs, never main/tag/scheduled SHA runs;
- gives the existing summary job the explicit stable context `build-status`;
- adds `build-status` to the required-status manifest and contracts it to every CI Full job;
- adds an invariant that parses the workflow and locks all trigger, concurrency and summary
  relationships.

No existing release-tag, schedule or manual trigger is removed.

## INFRA-HIGH-085 — concurrent capacity fixture writes split one logical record

The deploy capacity invariant launches four `du` workers concurrently. Its fake `du` executable
appended each base64 scope and its newline with two separate writes to one shared log. Under CI
load, another worker could append between those writes, so a real hostile scope invocation was
present but no longer occupied one complete line. The assertion then reported zero invocations
even though the production script behaved correctly.

The fixture now builds the encoded record first and appends the complete line with one `printf`.
This preserves the concurrency exercised by the test while making its observation boundary
atomic for records well below `PIPE_BUF`.

## INFRA-HIGH-086 — full-surface jobs raced while installing the Rust toolchain

CI Full launched all Nx lint, test, and build targets in parallel without first installing the
repository's pinned Rust toolchain. Multiple cargo-backed targets therefore invoked rustup
concurrently. Observed failures included a partial toolchain without cargo, failed component
directory replacement, and a partial toolchain without rustc.

The first repair copied Rust 1.88.0, its components, and two native targets into each workflow.
It omitted the repository's `wasm32-unknown-unknown` target, so parallel cargo processes still
raced to complete the shared toolchain when Lighthouse built the affected graph.

Every root-workspace fan-out now uses one repository-owned setup action. The action derives all
inputs from the generated Rust manifest, installs them once with the pinned upstream action, then
fails closed unless the manifest matches `rust-toolchain.toml` and every declared component and
target is installed. Invariants lock the action SHA, generated-manifest derivation, trigger
coverage, and setup ordering before every broad Nx command.

## INFRA-HIGH-087 — full CI promoted historical format debt into a blocking gate

After lint, type-check, and the spec ratchet passed, CI Full ran the repository-wide legacy
`format:check` command. Main already contains thousands of files that predate the current
Prettier contract, so enabling CI Full on pull requests made unrelated historical debt block
every merge candidate.

CI Full now checks only Prettier-managed files changed by the PR or push. New files and files
that were clean at the comparison base must remain clean; an already non-conforming base file is
reported as quarantined debt instead of forcing an unrelated bulk rewrite. The comparison base
is the pull request base SHA or push `before` SHA; scheduled and manual runs fall back to the
parent of `HEAD`. The committed format-scope manifest remains authoritative, and an invariant
prevents the full-tree legacy command from returning to the required workflow.

## INFRA-HIGH-088 — full coverage omitted the shared Vitest provider

CI Full reached the complete test matrix with coverage enabled and exposed three workspaces that
invoke Vitest but cannot start coverage collection: `messaging-module`, `tenant-admin`, and
`@platform/mcp-farm-management`. All three stopped before test discovery because the reproducible
root installation did not contain `@vitest/coverage-v8`.

The root development contract now installs the V8 coverage provider at the exact version of the
root Vitest runner. This keeps one lockfile-governed provider for every npm workspace and makes
the same `test:all -- --coverage` command usable across the full matrix.

## PERF-HIGH-011 — MCP coverage repeated invariant chemistry calculations

After the missing provider was installed, the MCP risk report scenario reached test execution
and exceeded Vitest's five-second budget under coverage. Its TAN threshold search recalculated
the same pH-only H₂S, CO₂, and ammonia-fraction inputs for every TAN candidate—roughly 700,000
instrumented chemistry calls for one report.

The scenario now precomputes the fixed pH risk grid once, then varies only TAN in the inner
search. Search resolution, threshold selection, and report output remain unchanged; the fix
removes repeated work instead of weakening the test timeout.

## INFRA-HIGH-089 — full coverage inherited impossible dormant floors and excluded sources

Once the required full-CI workflow could execute coverage, six passing Jest service suites
failed against hard-coded 60 percent global floors that had never been enforced. Their observed
coverage ranged from 14.18 to 53.34 percent by metric, so the inherited gate could not describe
the current repository truth or ratchet it.

Coverage collection also compiled sources outside the selected unit-test surface: archived HR
migration history, farm E2E suites, and a gateway mock whose intentionally narrower response
methods conflicted with Express `Partial<Response>`. These collection-only errors occurred after
the associated unit suites had passed.

The repair:

- records each service's first enforceable observed coverage floor in one typed baseline;
- makes all six Jest configs consume that baseline and locks the exact initial values with an
  invariant, so lowering a floor requires an explicit governed change;
- excludes only archived HR history and farm E2E sources from coverage collection, without
  suppressing their independently selected test targets;
- models gateway mock overrides with `Omit<Partial<Response>, ...>` before declaring their
  narrower Jest method types.

Future coverage improvements raise the centralized values; the baseline must never be lowered
to make a regression pass.

## INFRA-HIGH-090 — Codecov upload was fail-closed without upload authority

The first exact-head run whose complete test command passed produced 23 coverage reports, then
failed only in the Codecov step. The workflow required `fail_ci_if_error: true` but supplied
neither a repository token nor OIDC authority, so Codecov rejected the attempted tokenless upload
for this repository.

The first repair proved that GitHub OIDC itself was healthy: the next exact-head run issued a
1,972-byte short-lived identity, discovered 23 reports, and queued the upload. Codecov then
returned `Repository not found`. The repository had never been provisioned in Codecov's control
plane, so OIDC could authenticate the caller but could not create the missing vendor-side
repository. INFRA-HIGH-094 replaces that unsupported dependency with the repository-owned
coverage control plane described below.

## PERF-HIGH-012 — alert trend regression performed four passes plus allocation

The next exact-head full-coverage run exposed one remaining real test failure before the Codecov
step: calculating a trend over 1,000 samples averaged 5.26466047 ms against the existing 5 ms
service-level assertion.

The production implementation created a second 1,000-element index array, reduced that array
three times, and reduced the values once. It now uses an allocation-free online covariance
algorithm that reads each sample exactly once and avoids subtracting large uncentered sums.
The absolute 5 ms assertion remains unchanged. A deterministic complexity test instruments array
access and requires exactly one indexed read per sample, so scheduler noise cannot hide a future
multi-pass regression even when the wall-clock assertion passes.

## INFRA-HIGH-094 — unprovisioned Codecov omitted non-root coverage evidence

The OIDC-authenticated exact-head upload proved two architectural defects:

- required CI depended on a Codecov repository that had never been set up;
- `directory: ./coverage` found only 23 root reports and omitted Vitest reports emitted beneath
  `web/**/coverage` and `libs/aquaculture-engines/coverage`.

The repair removes the unsupported vendor control plane rather than making its failure optional.
`coverage-report-inventory.json` is the canonical identity list for 34 JS/TS report producers.
`coverage-evidence.js` fails closed when any declared report is missing, empty, malformed, or
below an existing service ratchet; computes SHA-256 per report; and emits one commit-bound evidence
manifest. CI retains that manifest and every LCOV file in a SHA-named GitHub artifact with
`if-no-files-found: error`. The test job drops `id-token: write` and returns to `contents: read`
only.

Every Jest/Vitest report remains locally enforceable. The six service percentage floors continue
to come from `service-coverage-baselines.json`; the evidence verifier consumes the same values,
so storage, validation, and per-project Jest execution do not own competing baselines.

## PERF-HIGH-014 — nested test worker pools oversubscribed CI runners

Nx schedules test projects concurrently, while each Vitest project previously sized another
worker pool independently from the host CPU count. Under full source instrumentation, concurrent
Recharts/jsdom suites contended on a two-core runner and crossed unchanged five-second test
boundaries.

All ten Vitest producers now consume the `@aquaculture/testing/vitest` workspace package, whose
single policy caps each nested pool at two workers and owns the common V8/LCOV contract. No timeout
or assertion changed. With the bound in place, shared-ui passed 23 suites and 368 tests in 30.60
seconds; farm passed 54 suites and 171 tests; tenant-admin passed 6 suites and 86 tests.

## INFRA-HIGH-095 — typed coverage adapter had no compiler owner

The baseline JSON has two loader-specific adapters: Jest consumes the CommonJS sibling while
TypeScript resolves those `.js` imports through the typed sibling. The TypeScript adapter was
required but had no owning tools tsconfig, and its manual project-name union could drift from the
JSON identities.

`tools/quality/tsconfig.json` now gives the adapter an explicit compiler owner. Its project type is
derived with `keyof typeof coverageBaselinesJson`; both loader adapters expose the same JSON data
SSoT without repeating project identities.

## INFRA-HIGH-096 — test fixtures hid incomplete contracts behind double casts

The range gate found AlertRule performance fixtures built as `Partial<AlertRule>` and repeatedly
forced into service APIs, plus GraphQL mock metadata attached through casts.

The alert fixture now constructs a real `AlertRule`, including every required entity field.
GraphQL metadata is attached through a structurally typed `Object.assign` result. The production
interfaces, banned-construct policy, and test expectations remain unchanged.

## INFRA-HIGH-097 — test-utils were routed through production compilers

The changed-file type guard recognized `test/`, `__tests__/`, and filename suffixes, but omitted
the repository's `test-utils/` convention. It therefore assigned the gateway Jest helper to
`tsconfig.app.json`, whose intentional lack of Jest globals produced false production errors.

The classifier now routes `test-utils/` through the owning project's test compiler. A CI
invariant locks this convention, so the fix improves ownership without adding test globals to a
production tsconfig.

## INFRA-HIGH-098 — workspace package inference exposed unowned factory lint debt

Publishing the shared Vitest policy through `@aquaculture/testing` made the existing testing
library a first-class inferred Nx project. Its newly active lint target then exposed two factory
helpers that bypassed structural typing, plus a CommonJS policy file whose runtime global was not
declared to ESLint.

The data-source factory now returns its repository stub without a redundant double assertion, and
the event-bus filter narrows unknown events structurally before reading `eventType`. The policy
file declares its actual CommonJS runtime rather than disabling `no-undef`. The complete
`@aquaculture/testing` lint target passes with zero warnings.

## INFRA-HIGH-099 — mock response accessors used a non-narrowing length guard

The gateway helper checked a Jest mock-call array's length before indexing its last tuple. With
`noUncheckedIndexedAccess`, the compiler correctly rejected that independent indexing operation:
the array could have changed between the guard and access.

Both accessors now use optional element access on the selected last tuple. Empty call histories
return `undefined` by contract, while populated histories preserve their exact response value.
The gateway test compiler passes without a non-null assertion or widened type.

## PERF-HIGH-015 — alert cache test compared two single wall-clock samples

The cache performance test compared one cold call with one warm call using `performance.now()`.
On the shared runner, scheduler noise made the valid cache hit measure 6.84 ms after a 0.86 ms
miss, so the test asserted scheduling order rather than cache behavior.

The replacement contract calls the public rule-loading boundary twice and proves the second load
returns the cached object while query-builder construction and repository I/O each occur exactly
once. No timeout, threshold, retry, or production cache behavior changed; the focused alert
coverage target passes deterministically.

## INFRA-HIGH-100 — frozen policy declaration was not assignable to Vitest config

The first policy declaration exposed its frozen reporter tuple as `readonly`. That accurately
described the shared runtime object but made the object incompatible with Vitest's `InlineConfig`,
which owns a mutable reporter array. The changed-file compiler therefore rejected the
aquaculture-engines config even though the runtime test target passed.

The policy export is now a factory. Each config receives a fresh reporter array, while the policy
object and coverage envelope remain frozen and centrally defined. An invariant proves two
consumers cannot share the mutable array. All 40 project compiler configurations and the
aquaculture-engines runtime target pass with the same single policy source.

## INFRA-HIGH-101 — coverage-mode test run produced no coverage at eight of ten Vitest producers

The ci-full test job runs `npm run test:all -- --coverage`, which becomes
`nx run-many --target=test --all --coverage`. Eight Vitest producers defined `test` as an
`nx:run-commands` target wrapping `npm run test`. That executor appends forwarded arguments to
its command string, so the task ran as `npm run test --coverage` — npm reads the flag as one of
its own config options and never hands it to Vitest. Those eight ran with coverage off and wrote
no report, and the coverage-evidence gate failed on a run in which every test had passed. The two
producers that did emit reports declared no `test` target at all and used the target Nx infers
from the package.json script, whose executor forwards options correctly.

A second half of the same failure was latent behind the first. `test` is a cached target and
ci-full restores `.nx/cache` between runs, but no test target declared its coverage directory
among `outputs`. Nx restores only declared outputs, so a replayed test task left no report behind
— the gate would have failed intermittently even once the flag reached the runner, and the one
project that did declare outputs pointed them at the other convention's path, caching nothing.

Both halves are now structural. The eight wrappers are deleted, so every Vitest producer uses the
same inferred `nx:run-script` target as the two that already worked, and each package's `test`
script is the run-once form with the watch form named separately. The cached-outputs default in
`nx.json` covers both layouts the inventory contains. Two invariants hold the line: one rejects a
Vitest producer that replaces the inferred target with any explicit executor or command, whether
declared in `project.json`, `package.json`, or the workspace target defaults, and the other requires
the cached-outputs default and refuses an override that misses where its own report lands. Both
were confirmed to fail when the old shapes are reintroduced.

A later farm branch reintroduced the wrapper with npm's `npm test` shorthand. The original
invariant recognized only the longer `npm run test` spelling, so the same flag-swallowing path
returned and farm-module emitted no LCOV after all of its tests passed. The strengthened contract
now rejects any Vitest producer that replaces Nx's inferred test executor or uses Nx's equivalent
top-level `command` shorthand, independent of package-manager spelling; metadata-only target
extensions remain valid.

The same audit found an eleventh Vitest producer, `mcp/farm-management`, outside the shared policy,
LCOV inventory, and retained CI artifact. Producer discovery is now filesystem-derived from every
workspace package whose test script invokes Vitest, so adding another producer without its shared
configuration and inventory report fails the invariant. The MCP target now uses the inferred
runner, emits repository-owned LCOV, and is retained with the other coverage evidence.

## HR-HIGH-006 — attendance clock-in test controlled a clock the handler never reads

`ClockInHandler` reads the instant with `new Date()`. The test established its clock with
`jest.spyOn(Date, 'now')`, and `new Date()` never calls `Date.now()` — so the spy changed nothing
and the handler saw the real wall clock. The handler rejects a clock-in outside the fixture
shift's 07:00-22:00 window, so the assertion passed whenever CI happened to run inside those hours
and failed on every run outside them: red at 06:31 UTC, green at 21:11 UTC the evening before on
the same code.

Faking the system clock is what actually moves `new Date()`. Only `Date` is faked — every timer API
is left real, because a clock-window test needs the instant pinned, not the event loop stopped, and
faking timers too would leave the awaited handler's promises unsettled. The restore moved into
`afterEach`, since a failing expectation returns early and a leaked fake clock would corrupt every
test after it.

Reproduced deterministically by moving the runner's timezone rather than waiting for the hour:
under `TZ=Etc/GMT+6` (local 01:00) the failure is byte-identical to CI's. After the fix the suite is
30/30 under `Etc/GMT+6`, `Etc/GMT-9` and `UTC` alike, and the full hr-service suite is 364/364 under
UTC, the timezone CI actually runs in.

## HR-HIGH-007 — payroll and leave date arithmetic shifts a calendar unit off UTC

Surfaced while reproducing HR-HIGH-006 by shifting the runner timezone. Under `TZ=Etc/GMT+6` a
January pay period is numbered `PAY-202512` instead of `PAY-202601`, and the leave half-day path
returns 2 days where it should return 1.5. Both are UTC-versus-local calendar-boundary errors — the
same family as HR-HIGH-006, in different code.

They were invisible to CI because the runner is UTC, and invisible to the platform only for as long
as every deployment stays on UTC. A pay period attributed to the wrong month is a finance-visible
error, not a test artifact.

The production paths mixed UTC parsing of date-only strings with host-local calendar accessors.
HR now owns one UTC calendar-date SSoT for normalization, ISO formatting, weekday evaluation,
integer day increments and payroll year-month formatting. Payroll and leave calculations consume
that authority, as do the four existing HR query handlers that previously carried private ISO-date
formatters. A timezone-matrix contract locks identical results under UTC, UTC−6 and UTC+9; the
payroll and leave regression scenarios pass in all three environments.

## INFRA-HIGH-139 — verified development images silently skipped deployment

Two consecutive main runs (`33632417597` and `33640253692`) built and digest-verified all 28
selected images, then reported overall success while `deploy-development` was skipped. The
`deployed/development` baseline consequently remained at `eeb401131`, so each later merge rebuilt
the same cumulative range without updating the shared environment.

The caller made deployment conditional on a base64 digest manifest crossing a reusable-workflow
output boundary. An absent output was indistinguishable from an intentional no-op, and GitHub
classifies a skipped dependent job as successful workflow completion. The manifest is now resolved
from the immutable SHA tags inside the deploy job, immediately before SSH, and retained in that
job's environment for digest-pinned rollout and channel promotion. A separate output-contract job
rejects missing low-entropy selection outputs, while a final delivery-status job turns every
unexpected build, contract, or deploy skip into a visible failure. Documentation-only and other
catalog-proven no-image changes remain legitimate no-ops before this delivery lane is entered.

Main run `33652901659` then proved a second boundary in the same finding: the output-contract job
passed, but the reusable deploy call was still skipped because GitHub propagates an implicit
success check across the full dependency chain, including intentionally skipped specialist jobs.
The deploy condition now uses `always()` to force evaluation after every ancestor settles and
then explicitly requires both the image workflow and output contract to be successful. A workflow
invariant pins that combination so a skipped ancestor cannot silently suppress deployment again.
