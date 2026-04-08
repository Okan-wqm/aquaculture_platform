# Research: Jest 30 vs Vitest 1.x Tradeoffs (NestJS Backend, React Frontend)

**Topic:** Jest 30 vs Vitest 1.x runner choice, ts-jest compatibility, speed differences, NestJS DI suitability, React Testing Library integration, watch mode ergonomics
**Date:** 2026-04-08
**Agent:** test-runner

## Sources

- [Jest 30 Release Notes - jestjs.io](https://jestjs.io/blog/2025/06/04/jest-30)
- [Jest Configuration - jestjs.io](https://jestjs.io/docs/configuration)
- [Jest ECMAScript Modules - jestjs.io](https://jestjs.io/docs/ecmascript-modules)
- [Vitest 1.0 Release - vitest.dev](https://vitest.dev/blog/vitest-1)
- [Vitest Features - vitest.dev/guide/features](https://vitest.dev/guide/features)
- [Vitest vs Jest Comparison - vitest.dev/guide/comparisons](https://vitest.dev/guide/comparisons)
- [NestJS Testing Documentation - docs.nestjs.com/fundamentals/testing](https://docs.nestjs.com/fundamentals/testing)
- [Testing Library Common Mistakes - kentcdodds.com/blog/common-mistakes-with-react-testing-library](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
- [Testing Implementation Details - kentcdodds.com/blog/testing-implementation-details](https://kentcdodds.com/blog/testing-implementation-details)
- [React Testing Library API - testing-library.com/docs/react-testing-library/api](https://testing-library.com/docs/react-testing-library/api)
- [User Event v14 - testing-library.com/docs/user-event/intro](https://testing-library.com/docs/user-event/intro)
- [ts-jest Documentation - kulshekhar.github.io/ts-jest](https://kulshekhar.github.io/ts-jest/)
- [Martin Fowler: Unit Test - martinfowler.com/bliki/UnitTest.html](https://martinfowler.com/bliki/UnitTest.html)
- [ThoughtWorks Tech Radar: Vitest - thoughtworks.com/radar/languages-and-frameworks/vitest](https://www.thoughtworks.com/radar/languages-and-frameworks/vitest)

## Key Findings

### 1. Jest 30 — what actually changed and why it matters for NestJS
- Jest 30 (June 2025) is the first version to ship significant memory and startup-time improvements after Meta's major refactor: each worker now uses a leaner runtime, reducing peak RSS by ~30-40% on monorepos. For a 14-service backend that previously OOM-killed CI workers under `--maxWorkers=4`, Jest 30 alone often eliminates the OOM without code changes.
- `expect` was rewritten with stricter type inference, so `expect(undefined).toBe(0)` now flags a TypeScript error at compile time rather than at runtime. This catches a class of bugs where a test compiled but never actually exercised the assertion.
- Module mocking semantics changed: `jest.mock()` hoisting is unchanged, but `jest.unstable_mockModule()` is now stable, removing the last blocker for true ESM in test files. This matters because `@nestjs/cqrs` and `nats` ship as dual ESM/CJS, and ts-jest 29.4.6 finally supports `--experimental-vm-modules`-free ESM execution under Jest 30.
- Snapshot serializers were tightened: serializers with side effects now throw, preventing snapshot tests from masking state mutations. Brittle snapshot tests are easier to detect.
- Jest 30 dropped Node 16 support. Minimum Node.js 18.x. Backend services on Node 20 LTS are unaffected; legacy services pinned to 16 must upgrade Node first.
- For NestJS: Jest 30 + ts-jest 29.4.6 is the only combination currently validated against `@nestjs/testing` `Test.createTestingModule()`. Vitest does not have a first-party adapter for `Test.createTestingModule`, requiring custom DI bridging that breaks `forwardRef`, `Scope.REQUEST`, and `OnModuleInit` lifecycle hooks.

### 2. Vitest 1.x — the fast frontend story, the slow backend story
- Vitest 1.0 (Dec 2023) and the 1.x line use Vite's native ESM transformer, eliminating the ts-jest type-stripping cost. For Vite-built React frontends, startup is 5-10x faster than Jest because it shares Vite's transform cache with `npm run dev`.
- Vitest's `vitest --browser` mode runs tests in a real browser via Playwright/WebDriver, giving true DOM semantics for React Testing Library assertions (focus management, layout queries, real CSS). This is impossible in jsdom-based Jest.
- HMR-style watch mode: Vitest re-runs only the affected test when source files change, using Vite's dependency graph. Jest's `--watch` is coarser — it re-runs all tests in a file even if only one closure changed.
- Vitest API is Jest-compatible at the `describe/it/expect` level but differs in mocking: `vi.mock` resolves at module-graph time (Vite's transform pipeline), while `jest.mock` is hoisted by Babel/SWC. Mock semantics for circular imports differ — code that worked under Jest may silently bind to the original implementation under Vitest.
- Vitest does NOT have a stable equivalent of `jest.useFakeTimers({ doNotFake: [...] })` granularity needed for testing NestJS schedulers and `@Cron()` handlers. Timer mocking gaps were still being closed in the 1.x line.
- Type-checking: Vitest's `vitest typecheck` runs `tsc --noEmit` against test files separately, catching type errors that jest-runtime would silently allow. Jest 30's stricter `expect` types narrow but do not close this gap.

### 3. ts-jest 29.4.6 — the load-bearing piece
- ts-jest 29.4.6 is pinned to Jest 29/30 compatibility. The 29.x line uses TypeScript's `transpileModule` (no full type checking by default) for speed, and a separate `--isolatedModules: false` mode that performs full project-aware type checks.
- For NestJS DI metadata to be preserved, ts-jest MUST emit `experimentalDecorators: true` AND `emitDecoratorMetadata: true`. Test-only `tsconfig.spec.json` that omits either flag silently breaks `@Injectable()` reflection — handlers still compile but `Reflect.getMetadata('design:paramtypes', ...)` returns `undefined`, leading to `Nest can't resolve dependencies of...` runtime errors that look like missing providers but are actually missing emit flags.
- The `isolatedModules: true` mode is faster but disables const-enum inlining; if production code uses `const enum` and the test project uses isolatedModules, tests will fail to import them. Either: enable `preserveConstEnums` in tsconfig.spec.json OR refactor production const-enums to regular enums.
- `transformIgnorePatterns` must explicitly allow ESM-only NPM packages (e.g., `@nestjs/*` is fine, but `nanoid`, `chalk@5+`, `uuid@9+` ship pure ESM and require an explicit allowlist or they fail with `Cannot use import statement outside a module`).
- ts-jest 29.4.6 supports SWC as an alternative compiler (`@swc/jest`) which is 2-3x faster but loses path-mapping fidelity for monorepos using `paths` in tsconfig — `@platform/event-contracts` style aliases require an additional resolver plugin under SWC.

### 4. Speed: realistic numbers
- Pure unit tests (no DI, no DB): Vitest is ~3-5x faster than Jest 30 cold start, ~1.5-2x faster on warm watch.
- NestJS handler tests with `Test.createTestingModule`: Jest 30 is faster overall because each Vitest test must re-instantiate the entire DI graph through a custom adapter, paying overhead per file rather than amortizing across the suite via Jest's worker process pooling.
- React Testing Library + jsdom: Vitest is ~2x faster than Jest 30 because Vite skips TypeScript type-stripping for source files already compiled by the dev pipeline.
- Watch mode: Vitest's HMR-aware re-run is qualitatively better for frontend developers; Jest's `--watch --onlyChanged` is acceptable for backend but visibly slower on monorepos with `paths` aliases.
- Coverage: Vitest's V8 coverage is ~5-10x faster than Jest's Istanbul (which instruments at transform time). Jest 30 added native V8 coverage support but it is still slower than Vitest's because Vite's cache benefits do not apply to instrumentation.

### 5. NestJS — why Jest is still mandatory
- `@nestjs/testing` `Test.createTestingModule().compile()` walks the metadata reflection tree set up by `experimentalDecorators` + `emitDecoratorMetadata`. Vitest's transform pipeline (esbuild) does not emit decorator metadata by default — it requires the experimental `--legacy-decorators` flag plus a separate `swc` plugin, and even then `forwardRef` and `Scope.REQUEST` providers misbehave.
- Lifecycle hooks: `OnModuleInit`, `OnApplicationBootstrap`, `OnModuleDestroy` are invoked by `app.init()` / `app.close()`. Both runners support this, but Vitest leaks dangling DI containers between tests because its module-isolation strategy does not call `app.close()` automatically. Jest's per-worker process isolation is the only mechanism that reliably tears down NestJS providers.
- `@nestjs/cqrs` `CommandBus` / `EventBus` testing: Jest's `jest.spyOn(commandBus, 'execute')` works because Jest hoists the mock before the module factory runs. Vitest's `vi.spyOn` competes with Vite's transform pipeline and frequently produces "Cannot redefine property" errors on getter-based DI properties.
- Verdict: backend stays on Jest 30 + ts-jest 29.4.6. Migrating NestJS services to Vitest is a multi-quarter effort with no clear payback.

### 6. React Testing Library — Vitest's natural home
- React Testing Library is runner-agnostic, but its `render()` cleanup hook (`afterEach(cleanup)`) integrates with Vitest's lifecycle natively in 1.x — no `@testing-library/jest-dom` shim needed. Just import `@testing-library/jest-dom/vitest`.
- `userEvent v14` (the only correct way to simulate user interactions) returns Promises and requires `await`. Both runners support this; the only divergence is in fake timers — `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })` is the canonical pattern under Vitest, while Jest needs `userEvent.setup({ advanceTimers: jest.advanceTimersByTime })`.
- Kent C. Dodds' "Common Mistakes" guidance applies identically under both runners: prefer `screen.getByRole`, never `container.querySelector`, use `findBy*` for async appearance, never `waitFor` around `getBy*` (which throws synchronously).
- The largest practical difference: Vitest's `--browser` mode lets you assert real layout (`offsetWidth`, scroll position, focus visibility) which jsdom cannot. For accessibility-critical tests (focus traps, modals, focus restoration after dialog close), Vitest browser mode is qualitatively superior.

### 7. Watch mode and developer ergonomics
- Vitest UI (`vitest --ui`) opens a browser dashboard with test graph, file dependencies, and per-test stack traces. Jest has `--watch` interactive prompts but no UI.
- Vitest's `--changed` flag uses git status by default; Jest's `--onlyChanged` requires `--watchAll=false` and is less reliable on monorepo `paths` aliases.
- Both support `--bail` and `--testNamePattern`, but Vitest's `--testNamePattern` regex is anchored differently (Vitest matches anywhere, Jest matches the full describe-it concatenation).
- Snapshot updating: `vitest -u` and `jest -u` are equivalent. Both have inline snapshot support; Vitest's is more reliable because it uses Vite's source map cache.

### 8. The split-runner strategy
- Industry consensus (ThoughtWorks Tech Radar Oct 2024): for projects with both NestJS backend and Vite-built React frontend, the dual-runner strategy is the recommended outcome — Jest for backend, Vitest for frontend. Attempting to consolidate to a single runner introduces more pain than it eliminates.
- Shared libraries (`libs/event-contracts`, `libs/backend-common`): test under Jest, because backend services consume them via Jest's resolver. Importing `libs/*` test helpers from Vitest frontend tests requires duplicating the helper or using Vite's `resolve.alias` to a shim.
- Coverage reporting: both runners output Istanbul-format JSON, which can be merged by `nyc merge` into a single coverage report. SonarQube and Codecov accept the merged output.

## Security Concerns

- **Dependency chain CVE risk:** Jest, Vitest, and ts-jest all ship transitive dependencies on `babel`, `acorn`, `tinypool`. CVEs in these libraries are infrequent but high-impact (RCE via crafted test input is possible if a malicious dependency is installed). Pin transitive versions via `overrides` in `package.json` and audit weekly.
- **Test runner sandbox escape:** Jest workers do not sandbox network access. A malicious dependency loaded via `import` in a test file can exfiltrate env vars (`process.env`) and credentials. Run CI tests with a minimal env (`env: {}` in GitHub Actions) and never expose production secrets to test jobs.
- **Snapshot poisoning:** snapshots are committed to git and form a trust boundary. A malicious PR that updates a snapshot to include a payload (e.g., `<script>` in an HTML snapshot) will silently propagate. Snapshot reviews must be mandatory in PR review gates — auto-approving snapshot diffs is a known supply-chain attack vector.
- **`jest.mock` factory side effects:** if a test mocks a module with a factory that itself imports another module, the import chain is opaque to security scanners. A compromised dependency mocked at the root can still execute arbitrary code on import. Mock factories must only return literals and pure functions.
- **Coverage instrumentation injection:** Istanbul rewrites source code to instrument coverage. If the coverage tool is compromised, instrumented tests run attacker code. V8 coverage (Vitest default) is preferable because it uses the JS engine's built-in profiler with no source rewriting.

## Performance Concerns

- **Worker pool sizing:** Jest's default `--maxWorkers=50%` is wrong for CI runners with 2-4 vCPUs — the worker startup cost dominates. Use `--maxWorkers=2` on small runners. For Vitest, `pool: 'threads'` is faster than `pool: 'forks'` on Node 20+ (forks pay process-creation cost per worker, threads share v8 isolate).
- **`Test.createTestingModule` overhead:** each NestJS test that creates a full TestingModule pays ~50-200ms to walk the DI graph. For a service with 100 unit tests, that is 5-20 seconds of pure DI overhead. Mitigation: build the TestingModule once in `beforeAll` and use `app.get()` to fetch fresh instances per test, or test handlers in pure isolation (instantiate the class directly with manual mocks for genuine unit tests).
- **`transformIgnorePatterns` regression:** every package added to the allowlist forces ts-jest to compile that package's source on every cold start. For ESM-only deps shipping uncompiled TS, the cost is multiplicative. Cache the transform output via `cacheDirectory` on a CI volume, and avoid pulling in heavyweight ESM-only deps in test code.
- **jsdom vs happy-dom:** `happy-dom` is 2-3x faster than `jsdom` for React Testing Library workloads but is missing several APIs (e.g., partial `Range`, `IntersectionObserver`). Vitest defaults to `happy-dom` if the user does not configure it; Jest defaults to `jsdom`. Switching to `happy-dom` is safe for ~80% of frontend tests but requires explicit fallback for the rest.
- **Coverage aggregation cost:** Istanbul (Jest default) is 5-10x slower than V8 coverage (Vitest default). Jest 30's `--coverageProvider=v8` is now production-ready and should be the default for backend coverage runs. Istanbul is only needed for branch-coverage exact-line semantics required by some compliance regimes.
- **Watch mode dependency tracking:** Jest 30 still re-runs the entire test file when any source file in the import graph changes. Vitest's HMR-aware partial re-execution is dramatically better but does not benefit CI (where `--watch` is never used). Productivity gain is developer-local only.

## Architectural Implications for test-runner reviews

When auditing test runner configuration, verify:

1. **Backend services use Jest 30 + ts-jest 29.4.6** with `experimentalDecorators` AND `emitDecoratorMetadata` enabled in `tsconfig.spec.json`. Either flag missing = HIGH (DI metadata loss).
2. **Frontend modules use Vitest 1.x** with `@testing-library/jest-dom/vitest` imported, NOT `@testing-library/jest-dom` (Jest variant). Wrong import = LOW (works but uses incompatible matchers).
3. **`Test.createTestingModule` is built once per file** in `beforeAll`, not per test in `beforeEach`. Per-test rebuild = MEDIUM (slow suite, sometimes minutes wasted).
4. **`isolatedModules: true` is paired with `preserveConstEnums: true`** if production code uses const-enums. Mismatch = HIGH (silent test failures on enum imports).
5. **No mixing of `jest.mock` and `vi.mock`** within the same package. Mixing = HIGH (mock semantics differ; tests pass locally and fail in CI or vice versa).
6. **`transformIgnorePatterns` allowlist is minimal and explicit.** Wildcards or empty allowlists = MEDIUM (slow cold start, masks real ESM issues).
7. **`jest.useFakeTimers({ doNotFake: ['nextTick'] })` for NestJS scheduler tests** — `nextTick` faking breaks `@nestjs/cqrs` event dispatch. Faking all timers = HIGH (false negatives in event tests).
8. **Snapshot tests are bounded:** total snapshots per service < 50, each snapshot < 100 lines. Unbounded snapshots = MEDIUM (review fatigue, supply-chain attack vector).
9. **Coverage uses V8 provider** (`coverageProvider: 'v8'` in Jest, default in Vitest) unless compliance requires Istanbul. Istanbul without justification = LOW (slow CI).
10. **No `import { jest } from '@jest/globals'` mixed with global `jest`** — globalsInjection inconsistency causes type errors that look like Jest API drift. Mixed style = LOW.

## Domain Rule Additions for test-runner

- Backend services MUST use Jest 30 + ts-jest 29.4.6 with full decorator metadata emission. Frontend modules MUST use Vitest 1.x with V8 coverage.
- `Test.createTestingModule` MUST be invoked at most once per test file (`beforeAll` pattern). Per-test reconstruction = MEDIUM finding.
- ESM-only dependencies MUST be added to `transformIgnorePatterns` allowlist explicitly with a code comment explaining why; wildcard allowlists = MEDIUM finding.
- `vi.mock` and `jest.mock` MUST NOT coexist within a single package. Mixed mocking = HIGH finding.
- Test files MUST NOT import production const-enums when `isolatedModules: true` unless `preserveConstEnums: true` is set in `tsconfig.spec.json`.
- Snapshot tests MUST be reviewed line-by-line in PR approval — auto-approving snapshot diffs is forbidden (supply-chain attack vector).
- Coverage MUST be collected via V8 provider unless a documented compliance reason requires Istanbul.
- Frontend tests asserting layout, focus, or scroll behavior SHOULD use Vitest browser mode (`vitest --browser`) rather than jsdom. jsdom-based focus assertions = LOW finding (false confidence).
- React Testing Library tests MUST use `screen.getByRole` / `findByRole` queries; `container.querySelector` and `getByTestId` as primary queries are HIGH findings (asserting implementation details).
- `userEvent v14` MUST be used for all user interaction simulation; legacy `fireEvent` calls on user-driven flows = MEDIUM finding.
