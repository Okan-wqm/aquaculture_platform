# Research: Mutation Testing with Stryker — Coverage as Quality Metric

**Topic:** Why coverage % lies, mutation score as real test-quality metric, Stryker for Node.js, where to apply
**Date:** 2026-04-08
**Agent:** test-runner

## Sources

- [Stryker Mutator Documentation - stryker-mutator.io](https://stryker-mutator.io/)
- [Stryker JS / Node - stryker-mutator.io/docs/stryker-js/introduction](https://stryker-mutator.io/docs/stryker-js/introduction/)
- [Stryker Configuration - stryker-mutator.io/docs/stryker-js/configuration](https://stryker-mutator.io/docs/stryker-js/configuration/)
- [Stryker Mutators - stryker-mutator.io/docs/mutation-testing-elements/supported-mutators](https://stryker-mutator.io/docs/mutation-testing-elements/supported-mutators/)
- [Stryker Plugins - stryker-mutator.io/docs/stryker-js/plugins](https://stryker-mutator.io/docs/stryker-js/plugins/)
- [Istanbul Documentation - istanbul.js.org](https://istanbul.js.org/)
- [Istanbul Coverage Reporting - istanbul.js.org/docs/tutorials/cli](https://istanbul.js.org/docs/tutorials/cli/)
- [Martin Fowler: Test Coverage - martinfowler.com/bliki/TestCoverage.html](https://martinfowler.com/bliki/TestCoverage.html)
- [Martin Fowler: Assertion-Free Testing - martinfowler.com/bliki/AssertionFreeTesting.html](https://martinfowler.com/bliki/AssertionFreeTesting.html)
- [Google Testing Blog: Code Coverage Best Practices - testing.googleblog.com/2020/08/code-coverage-best-practices.html](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)
- [Google Testing Blog: Code Coverage Goal: 100% Mutation Score - testing.googleblog.com](https://testing.googleblog.com/)
- [ThoughtWorks Tech Radar: Mutation Testing - thoughtworks.com/radar/techniques/mutation-testing](https://www.thoughtworks.com/radar/techniques/mutation-testing)
- [Mutation Testing Definitions - cs.cmu.edu/~aldrich/courses/654/tools/Strolia-Davis-MutationTesting-2014.pdf](https://stryker-mutator.io/blog/announcing-stryker-1.0-state-of-mutation-testing/)

## Key Findings

### 1. Why coverage percentage lies
- A line is "covered" if any test executes it. The test does NOT need to assert anything about the result. A test that calls `service.processOrder(input)` and immediately exits has "covered" `processOrder` and every line it touches — including silent bugs in the body.
- Branch coverage is better but still lies: a test that takes the `if (x > 0)` branch covers the branch even if the body of that branch is wrong. Branch coverage measures _which paths execute_, not _which paths are correctly verified_.
- Martin Fowler's "AssertionFreeTesting" antipattern: tests that exercise code without asserting anything are coverage liars. They look like passing tests, contribute to the coverage percentage, and provide zero protection against regressions. They are worse than no test because they create false confidence.
- Industry data (Google Testing Blog, 2020): teams that chase 100% line coverage often have lower defect detection rates than teams targeting 70% with strict assertion discipline. Coverage incentives produce assertion-free tests when measured naively.
- Coverage thresholds (`coverageThreshold` in Jest, `coverage.thresholds` in Vitest) are useful as floors, not as quality gates. Setting a threshold of 80% prevents the suite from regressing below 80%, but does not validate that the existing 80% is meaningful.

### 2. Mutation testing — what it actually measures
- Mutation testing introduces small, automated code changes ("mutants") to the source under test, then re-runs the test suite. If the suite passes despite the mutation, the mutant is "survived" — meaning the tests do NOT detect the bug. If any test fails, the mutant is "killed."
- Mutation score = killed mutants / total non-equivalent mutants. A score of 80% means 80% of artificial bugs are detected by your tests. This is the only quantitative measure of test _quality_, not test _quantity_.
- Common mutators (Stryker default set):
  - **ArithmeticOperator**: `+` ↔ `-`, `*` ↔ `/`, `%` ↔ `*`. Catches missing arithmetic assertions.
  - **EqualityOperator**: `==` ↔ `!=`, `===` ↔ `!==`, `<` ↔ `<=`, `>` ↔ `>=`. Catches off-by-one and boundary bugs.
  - **LogicalOperator**: `&&` ↔ `||`, `!a` ↔ `a`. Catches missing condition checks.
  - **ConditionalExpression**: `if (x)` → `if (true)` and `if (false)`. Catches dead-branch tests.
  - **BlockStatement**: replaces function body with `{}`. Catches functions with no behavior assertions.
  - **StringLiteral**: replaces `"foo"` with `""`. Catches missing string equality checks.
  - **BooleanLiteral**: `true` ↔ `false`. Catches polarity bugs.
  - **ObjectLiteral**: `{ x: 1 }` → `{}`. Catches missing field checks.
  - **OptionalChaining**: `a?.b` → `a.b`. Catches missing nil-safety checks.
- A killed mutant proves at least one test detects that specific defect class. A survived mutant proves the test suite does not.

### 3. Stryker for Node.js — practical setup
- `@stryker-mutator/core` + `@stryker-mutator/jest-runner` runs Stryker against a Jest-based test suite. Vitest support is via `@stryker-mutator/vitest-runner` (1.x line) — both work but Jest is the more battle-tested.
- Configuration (`stryker.config.json`):
  ```json
  {
    "mutate": ["src/**/*.ts", "!src/**/*.spec.ts", "!src/**/*.module.ts", "!src/**/main.ts"],
    "testRunner": "jest",
    "coverageAnalysis": "perTest",
    "thresholds": { "high": 80, "low": 60, "break": 60 }
  }
  ```
- `coverageAnalysis: 'perTest'` is critical for performance: Stryker runs only the tests that touched the mutated line, not the entire suite per mutation. On a 1000-test suite this is 50-100x faster than `coverageAnalysis: 'all'`.
- Mutation runs are slow: a 5-minute test suite with 500 mutants becomes a 30-60 minute mutation run. This is acceptable as a nightly job, NOT as a per-PR gate.
- Incremental mode (`--incremental`) caches the last successful mutation report and only re-mutates changed source files. This makes per-PR mutation testing feasible for small changes.
- Sandbox: Stryker creates a temporary directory containing a copy of the project, runs mutations against the copy. The original source is never modified. Sandbox cleanup requires sufficient disk space (~2x project size).

### 4. Where to apply mutation testing
Mutation testing is expensive. Apply it surgically to the code where _correctness matters most and tests are most likely to be assertion-light_:
- **CQRS command handlers**: handlers contain business rules (state transitions, validation, atomicity). A handler with 100% line coverage but 30% mutation score is a known time bomb — the tests do not actually verify the behavior.
- **Authorization guards**: a guard with `if (user.role === 'ADMIN') return true` mutated to `if (true) return true` should be killed by ANY test of the guard. If it survives, the guard has zero protection.
- **Validation utilities**: `class-validator` decorators, custom validators, sanitizers. Mutation score should be 95%+.
- **Pricing / billing math**: arithmetic mutators are most valuable here. A `*` → `/` mutation in a billing calculator must be killed.
- **Tenant isolation predicates**: `where: { tenantId: ctx.tenantId }` mutated to `where: {}` must be killed by an integration test that verifies cross-tenant access fails.
- **Reducer / state-machine logic**: state transitions are pure functions, ideal mutation testing targets.

Where NOT to apply mutation testing (cost > value):
- React component render logic (mutations on JSX produce equivalent or trivially-different UIs).
- DTO mapping code (mutations are mostly equivalent).
- NestJS module wiring code (`*.module.ts`) — mutations there break the entire app, not specific tests.
- Generated code (Prisma, GraphQL codegen output).
- Logging statements (mutations on log strings are noise).

### 5. Equivalent mutants — the inherent limitation
- Some mutations produce code that is functionally identical to the original (e.g., mutating `a + 0` to `a - 0`). These "equivalent mutants" cannot be killed by any test. They artificially lower the mutation score.
- Stryker has heuristics to skip common equivalents but cannot detect all of them. A realistic mutation score ceiling is ~90-95% for well-tested code, not 100%.
- When investigating survived mutants, the question is not "why is this mutant alive?" but "would a real bug of this shape be caught?" If yes (it's an equivalent), ignore. If no, write a test.

### 6. Mutation score as a CI gate
- Recommended thresholds (Stryker defaults): `high: 80, low: 60, break: 60`. Below 60% the build breaks, between 60-80% the build is yellow (warning), above 80% the build is green.
- Per-file thresholds are stricter: critical files (auth guards, billing calculators, tenant scoping) require 95%+, while plumbing code can sit at 70%.
- Treat mutation score regressions like coverage regressions: a PR that lowers mutation score from 85% to 78% is a regression even if line coverage stayed at 90%.
- Reporting: Stryker generates an HTML report showing per-file mutation scores and a "mutation map" of which lines have surviving mutants. The HTML report should be uploaded as a CI artifact.

### 7. Coverage tooling — Istanbul and V8
- Istanbul (`nyc`, `@istanbuljs/*`) instruments source at transform time. Branch-accurate, slow (~5-10x test runtime), supports source maps perfectly.
- V8 coverage (`c8`) uses the Chrome V8 profiler's built-in coverage. Faster (~1.1-1.5x test runtime), less accurate at branch boundaries (V8 reports "block coverage" not "branch coverage").
- For aqua-saas: V8 coverage is the right default. Istanbul only when compliance regimes require strict branch counts (rare).
- Coverage reports must be merged across services and uploaded to a central tool (Codecov, SonarCloud, Coveralls). Per-service coverage reports without merging make it hard to detect cross-service gaps.
- Coverage exclusions: `*.module.ts`, `*.dto.ts`, `*.entity.ts`, `main.ts`, generated files. Exclusion lists must be reviewed periodically — overzealous exclusions hide real gaps.

### 8. Combining coverage + mutation score
- Coverage tells you "which lines were executed by some test."
- Mutation score tells you "which lines were verified by an assertion-bearing test."
- The gap between them reveals assertion-free tests. A file with 95% line coverage and 50% mutation score has many tests that exercise code without asserting on its behavior — those tests must be rewritten.
- The ratio `mutation_score / coverage` is a useful "test honesty metric." Values < 0.7 indicate widespread assertion-light tests. Values > 0.9 indicate solid test discipline.

## Security Concerns

- **Mutation runs as a security audit:** mutation testing on auth guards reveals tests that "cover" the guard without actually verifying it rejects unauthorized requests. A surviving `if (user.role === 'ADMIN') return true` → `return true` mutation is a guard with no test protection.
- **Mutation in CI must use sandbox isolation:** Stryker writes a copy of the project to disk and may execute mutated versions of dangerous code (filesystem deletion, network calls). Mutations on a function that calls `fs.rmSync` or `process.exit` can wedge the CI runner. Run Stryker in a containerized environment with restricted filesystem and network access.
- **Stryker plugin trust:** mutation runners load mutator plugins. Custom mutators or third-party plugins can execute arbitrary code on instrumented source. Pin Stryker plugins to known versions and audit on update.
- **Mutation reports may leak source:** the HTML mutation report contains full source snippets with mutations highlighted. Uploading the report to a public CI artifact storage exposes source code. Treat mutation reports as private build artifacts.

## Performance Concerns

- **Wall-time cost:** typical mutation runs are 10-50x slower than the underlying test suite. Treat mutation as a nightly or weekly job, not a per-PR gate. Use `--incremental` for per-PR runs limited to changed files.
- **`coverageAnalysis: 'perTest'` is critical:** without it, Stryker runs the entire test suite per mutation, multiplying runtime by `mutations × tests`. With it, only relevant tests run per mutation.
- **Sandbox disk usage:** Stryker creates a copy of the project per worker. On a 4-worker run, peak disk is ~5x project size. CI runners with limited disk must use smaller `concurrency`.
- **Surviving mutant analysis is human-intensive:** investigating each surviving mutant takes a developer 1-5 minutes. A mutation run with 200 surviving mutants demands hours of triage. Prioritize by file criticality.
- **Mutation scope creep:** running mutation testing on the entire codebase is wasteful. Limit `mutate` glob to high-value files (handlers, guards, math utilities). Excluding low-value files keeps runtime tractable.
- **Test runner restart cost:** Stryker spawns the test runner per mutation. Jest startup cost (~2-3 seconds) is paid hundreds of times. Use Stryker's persistent test runner mode (`@stryker-mutator/jest-runner` supports this) to amortize startup.

## Architectural Implications for test-runner reviews

When auditing test quality (beyond coverage), verify:

1. **Mutation testing exists** for critical files: CQRS handlers, auth guards, validation utilities, billing math, tenant isolation predicates. Missing = HIGH (coverage % alone is insufficient).
2. **Mutation thresholds set per-file** with stricter values for security-critical code (95%+ on guards/billing). Uniform low threshold = MEDIUM.
3. **Mutation runs as nightly job**, not per-PR. Per-PR mutation = MEDIUM (slow, blocks merges).
4. **`coverageAnalysis: 'perTest'`** in Stryker config. `'all'` = HIGH (intractable runtime).
5. **Surviving mutants triaged**, not ignored. Untriaged surviving mutants in critical files = HIGH (known test gaps).
6. **Coverage uses V8 provider** by default, Istanbul only for compliance. Istanbul without justification = LOW (slow CI).
7. **Coverage thresholds** (`coverageThreshold`) set per-service with critical path floors. Missing thresholds = MEDIUM.
8. **Coverage exclusions reviewed periodically.** Excessive exclusions = MEDIUM (hides gaps).
9. **Coverage + mutation merged** into a unified quality dashboard. Per-service silos = LOW.
10. **Tests with no assertions** detected via lint rule (`jest/expect-expect`) or mutation analysis. Assertion-free tests = HIGH (false coverage).
11. **Mutation reports uploaded as CI artifacts** for review. Missing = MEDIUM.
12. **Mutation incremental mode** enabled for per-PR runs on changed files. Full re-run per PR = MEDIUM.

## Domain Rule Additions for test-runner

- Coverage percentage alone MUST NOT be treated as a quality metric. Coverage is a floor, not a ceiling.
- Mutation testing via Stryker MUST run on critical files: CQRS command handlers, authorization guards, validation utilities, billing/pricing math, tenant isolation predicates. Missing mutation testing on these = HIGH finding.
- Per-file mutation score thresholds: 95%+ for auth guards, billing math, tenant predicates; 80%+ for command handlers; 70%+ for general utility code. Lower thresholds without justification = MEDIUM.
- Mutation runs MUST use `coverageAnalysis: 'perTest'`. `'all'` = HIGH (intractable).
- Mutation testing MUST run as a scheduled nightly job, not as a per-PR gate, EXCEPT in incremental mode for files changed in the PR.
- The `jest/expect-expect` lint rule MUST be enabled to detect assertion-free tests. Missing rule = MEDIUM.
- Surviving mutants in critical files MUST be triaged within one sprint. Untriaged surviving mutants on guards/billing/tenant predicates = HIGH after 14 days.
- Coverage MUST use V8 provider unless compliance requires Istanbul. Justification for Istanbul required in code comments.
- Coverage thresholds MUST be set per-service with explicit floors (`statements: 80, branches: 75, functions: 80, lines: 80` minimum). Missing or zero thresholds = MEDIUM.
- Coverage exclusions MUST be reviewed quarterly. New exclusions require PR review and justification comment.
- Mutation HTML reports MUST be uploaded as CI artifacts and accessible from the PR review page. Missing artifact = MEDIUM.
- The ratio `mutation_score / line_coverage` MUST be tracked over time as a "test honesty" metric. Sustained values < 0.7 = SYSTEMIC test debt requiring architectural intervention.
