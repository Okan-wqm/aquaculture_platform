# Research: Playwright Flake Reduction and Stable Selectors

**Topic:** data-testid vs role/text selectors, auto-wait, retry semantics, parallel execution, trace viewer, accessibility assertions
**Date:** 2026-04-08
**Agent:** test-runner

## Sources

- [Playwright Best Practices - playwright.dev/docs/best-practices](https://playwright.dev/docs/best-practices)
- [Playwright Locators - playwright.dev/docs/locators](https://playwright.dev/docs/locators)
- [Playwright Auto-waiting - playwright.dev/docs/actionability](https://playwright.dev/docs/actionability)
- [Playwright Test Retries - playwright.dev/docs/test-retries](https://playwright.dev/docs/test-retries)
- [Playwright Parallelism - playwright.dev/docs/test-parallel](https://playwright.dev/docs/test-parallel)
- [Playwright Trace Viewer - playwright.dev/docs/trace-viewer](https://playwright.dev/docs/trace-viewer)
- [Playwright Accessibility Testing - playwright.dev/docs/accessibility-testing](https://playwright.dev/docs/accessibility-testing)
- [Playwright Web-First Assertions - playwright.dev/docs/test-assertions](https://playwright.dev/docs/test-assertions)
- [Testing Library Queries Priority - testing-library.com/docs/queries/about#priority](https://testing-library.com/docs/queries/about#priority)
- [Kent C. Dodds: Making Your UI Tests Resilient - kentcdodds.com/blog/making-your-ui-tests-resilient-to-change](https://kentcdodds.com/blog/making-your-ui-tests-resilient-to-change)
- [Google Testing Blog: Just Say No to More End-to-End Tests - testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html)
- [Martin Fowler: Eradicating Non-Determinism in Tests - martinfowler.com/articles/nonDeterminism.html](https://martinfowler.com/articles/nonDeterminism.html)
- [ThoughtWorks Tech Radar: Playwright - thoughtworks.com/radar/tools/playwright](https://www.thoughtworks.com/radar/tools/playwright)

## Key Findings

### 1. Selector priority — the only correct order
The Playwright + Testing Library convention (and Kent C. Dodds' canonical guidance) ranks locators by accessibility-first:
1. `getByRole(role, { name })` — semantic, mirrors how assistive technology sees the page. Always preferred.
2. `getByLabel(text)` — for form fields with associated labels.
3. `getByPlaceholder(text)` — for inputs without labels (anti-pattern but acceptable for legacy UIs).
4. `getByText(text)` — for non-interactive content (paragraphs, headings).
5. `getByTitle(text)` — rare; for elements with `title` attributes.
6. `getByTestId(id)` — last resort, escape hatch when nothing else works.

CSS/XPath selectors (`page.locator('.btn-primary')`, `page.locator('//button[1]')`) are NOT in this list. They are an anti-pattern: they couple tests to implementation details (class names, DOM structure), not behavior. A CSS-only test fails the moment a developer renames a class — even when the user-visible behavior is unchanged.

### 2. Why `data-testid` is the escape hatch, not the default
- `data-testid` exists exclusively in the test build, has no semantic meaning, and is invisible to users. Using it as the primary locator strategy means tests cannot detect accessibility regressions (e.g., a button losing its accessible name).
- Refactoring resilience cuts both ways: `data-testid` survives DOM rearrangement but does not survive component replacement. If a button is replaced with a `<div role="button">`, both `getByRole('button', { name: 'Save' })` and `getByTestId('save-btn')` survive — but only `getByRole` enforces that the new element is actually a button.
- A test suite where >20% of locators are `getByTestId` indicates poor accessibility in the application code. Treat this as a code-quality smell and file accessibility tickets.
- Acceptable use cases for `data-testid`: complex tables (where row identification is genuinely ambiguous), virtualized lists, third-party components without accessible names, internal iframe boundaries.

### 3. Auto-wait — the #1 flake killer
- Playwright's `expect(locator).toBeVisible()` (web-first assertion) auto-retries for the configured timeout (default 5s) until the assertion passes. This eliminates the entire class of `await page.waitForTimeout(500)` flakes that plague Selenium and Cypress tests.
- Actionability checks: `locator.click()` waits for the element to be (a) attached to DOM, (b) visible, (c) stable (not animating), (d) enabled, (e) receives events (not occluded). All five must hold before the click is dispatched. Bypassing actionability with `{ force: true }` is a HIGH finding — it converts a real flake into a silent test failure.
- `page.waitForSelector` is legacy. Use locator + auto-wait. `waitForSelector` does not chain with locators and lacks the actionability checks.
- `page.waitForTimeout(ms)` is forbidden in PR-merged code. It is acceptable only in debugging traces and must be removed before commit.
- For animations, use `page.locator(...).waitFor({ state: 'visible' })` and rely on stability check, not arbitrary sleeps.
- Network idle (`page.goto(url, { waitUntil: 'networkidle' })`) is a flake source on apps with long-poll connections (WebSockets, SSE). Use `domcontentloaded` and assert on the specific element you care about.

### 4. Retry semantics
- Playwright `retries: 2` re-runs failed tests up to 2 times. Pass-on-retry is reported in CI as flaky, not green. This signal is critical: green-on-retry is NOT the same as green.
- Retries should be configured ONLY in CI (`retries: process.env.CI ? 2 : 0`). Local retries hide flakes from developers.
- A test that requires retries to pass is a broken test. Track flaky-test counts as a CI metric and fail the build if the rolling 7-day flake rate exceeds 1% (Google's internal threshold is 0.5%).
- Per-test retry overrides (`test.describe.configure({ retries: 5 })`) are a code smell — they signal acceptance of unreliable tests rather than fixing the root cause.

### 5. Parallel execution
- Playwright runs tests in parallel by default at the file level: each `.spec.ts` runs in a worker. Within a file, tests run sequentially unless `test.describe.parallel(...)` is used.
- Workers are isolated browser contexts, NOT processes. Cross-test state via `page.context().storageState` requires explicit sharing.
- Authentication setup: use `globalSetup` to log in once and save storage state, then have every test load the storage state. This is 10-100x faster than logging in per test. The pattern is documented in Playwright's "auth project" example.
- Sharding for CI: `--shard=1/4` splits tests across 4 CI machines. Combined with parallel workers, an 800-test suite can complete in ~3 minutes on 4 runners with 4 workers each.
- Worker count tuning: Playwright defaults to 50% of CPU cores. On a 4-vCPU CI runner this is 2 workers, which is correct for browser tests (each worker spawns a Chromium instance ~200MB RAM).

### 6. Trace viewer — the debugging weapon
- `trace: 'on-first-retry'` (or `'retain-on-failure'`) records DOM snapshots, network logs, console logs, and screenshots for every action. The trace file is openable in `npx playwright show-trace`.
- Trace viewer is qualitatively better than every other E2E debugging tool (Selenium IDE, Cypress dashboard, WebDriver logs). It shows time-travel snapshots of the page at each action — you can see exactly what the locator saw when it failed.
- Trace files MUST be uploaded as CI artifacts on test failure. PR reviewers should be able to download and inspect traces without re-running the test locally.
- `trace: 'on'` records every test, which bloats CI storage. `'on-first-retry'` is the production setting.
- Screenshots and videos: `screenshot: 'only-on-failure'` and `video: 'retain-on-failure'` are the recommended settings. Always-on screenshot/video recording is a slow-down with negligible debugging value when traces are available.

### 7. Accessibility assertions
- `@axe-core/playwright` is the canonical accessibility audit library. A typical pattern: `const results = await new AxeBuilder({ page }).analyze(); expect(results.violations).toHaveLength(0);`
- AxeBuilder can scope audits (`.include('main')`) and exclude rules (`.disableRules(['color-contrast'])` for known false positives on dynamic theming).
- Accessibility tests should be a separate Playwright project (`projects: [{ name: 'a11y', testMatch: 'a11y.spec.ts' }]`) so they can be run independently and gated separately from functional E2E.
- Beyond axe: assert keyboard navigation explicitly. Tab through a form, assert focus order matches semantic order, assert focus is trapped in modals, assert focus is restored on modal close. These are not detected by axe — they require explicit Playwright assertions.
- ARIA live regions: assert that `[aria-live="polite"]` regions update with the expected announcement after user actions. This catches screen-reader regressions that no other test detects.

### 8. Test isolation, fixtures, and the BAD ANCHOR pattern
- Each test runs in a fresh browser context. Cookies, localStorage, sessionStorage are clean. State sharing is explicit via `storageState` or fixtures.
- Database state: E2E tests should use a dedicated test environment with a known seed, not production. Tests that mutate seed data must clean up in `afterEach` or use per-test tenant scoping (create a tenant per test, drop it in cleanup).
- The "bad anchor" pattern: a test that asserts `expect(page.url()).toContain('/dashboard')` is brittle if the URL contains a query string. Use `expect(page).toHaveURL(/\/dashboard/)` (regex) which auto-waits for the URL to match.
- Tests must NOT depend on test execution order. Each test must be runnable in isolation. `--shuffle` is the canonical detector of order dependence — if `--shuffle` flakes, you have hidden coupling.

### 9. Network mocking
- Playwright `page.route(url, handler)` intercepts and mocks HTTP requests. Useful for testing error states (`route.fulfill({ status: 500 })`), slow responses, and avoiding external API rate limits.
- Mocking the entire backend is an anti-pattern for E2E tests (defeats the purpose). Mock only third-party services that are slow, paid, or rate-limited (Stripe, SendGrid, Sentinel Hub).
- For internal APIs, prefer real backend (against a test environment) — this is the only way to catch frontend-backend contract drift.
- Mocking should be opt-in per test, not global. `test.use({ /* mocks */ })` per describe block.

### 10. Common flake sources and fixes
- **Animation timing**: rely on actionability stability check, not arbitrary waits. Disable animations globally in test environment via CSS (`* { animation-duration: 0s !important }`) for additional stability.
- **Date/time-dependent assertions**: freeze time with `page.addInitScript` injecting a `Date` mock, or use `page.clock.install()` (Playwright 1.45+).
- **Random data in UI**: seed RNG via `page.addInitScript({ content: 'Math.random = () => 0.5' })` for deterministic snapshots.
- **Network latency from CI**: use `route.continue({ throttling: ... })` for slow-network simulation, but NEVER assume CI network speed. Auto-wait covers this.
- **Race condition between page load and test action**: use `await page.waitForLoadState('domcontentloaded')` then locator-based assertions.
- **Stale element references**: never store a `Locator` and reuse it after navigation — re-query. Storing `ElementHandle` is forbidden in modern Playwright (use Locator).

## Security Concerns

- **Credential leakage in traces:** Playwright traces capture every input value, including passwords typed via `fill()`. Mark sensitive fields and strip them from traces, or use `setInputFiles` for credential injection. Never commit traces with credential values.
- **Storage state files contain auth tokens:** `storageState` JSON files (committed for fixture reuse) contain session cookies and auth tokens. These MUST be in `.gitignore` and regenerated per CI run.
- **Cross-tenant test runs:** running E2E tests against a tenant ID that overlaps with production tenants risks data leakage. Use a dedicated `tenant_e2e_<runId>` schema per test run, drop on completion.
- **Network mocking can hide CSRF/CORS bugs:** mocked routes bypass browser security checks. Real backend tests are the only way to verify CORS, CSP, and CSRF token handling end-to-end.
- **Headless browser CVEs:** Chromium ships with Playwright. Pin Playwright versions and update monthly — Chromium security patches arrive via Playwright releases. Out-of-date Playwright = known browser CVEs running in CI.
- **Trace artifact exposure:** uploaded traces in GitHub Actions are accessible to anyone with read access to the run. PII in trace screenshots = compliance violation. Strip or scope traces before upload.
- **`page.route` MITM risk:** route handlers can rewrite real HTTPS responses in tests. A malicious test could be used to test exploits against the staging backend. Limit which engineers can write E2E tests against staging.

## Performance Concerns

- **Browser context pooling:** Playwright supports `test.describe.configure({ mode: 'serial' })` for tests within a file that share state, but the per-file isolation means each file pays browser startup cost. Use the auth project pattern to share login state across files.
- **CDP overhead:** every Playwright action goes over Chrome DevTools Protocol. Batches of 1000+ actions per test pay measurable CDP latency. Keep tests focused on user-meaningful flows, not exhaustive UI sweeps.
- **Trace recording cost:** recording traces adds ~10-30% wall-time overhead per test. With `'on-first-retry'`, only failed tests pay this cost.
- **Video recording cost:** ~50-100% wall-time overhead. Disable for green tests, enable only on retain-on-failure.
- **Sharding overhead:** each shard rebuilds the browser context, runs `globalSetup`, and pays CI runner spin-up cost. Sharding to 8+ shards on a small suite (<100 tests) is net-slower than 2 shards.
- **Worker memory:** each Chromium instance is ~200MB RAM. 4 workers × 200MB = 800MB minimum, plus Node runtime. CI runners with 4GB RAM are tight; 8GB is comfortable.
- **Network idle waits:** `waitUntil: 'networkidle'` is the slowest navigation strategy. Use only when necessary; prefer `domcontentloaded` and explicit element assertions.
- **Slow assertion timeouts:** the default action timeout is 5s, navigation timeout is 30s. Increasing these masks underlying perf bugs. Tighten timeouts to expose slow code paths.

## Architectural Implications for test-runner reviews

When auditing Playwright tests, verify:

1. **Locator priority enforced:** `getByRole` is the dominant locator. Files where >20% of locators are `getByTestId` = MEDIUM (accessibility smell).
2. **No `page.waitForTimeout` in committed code.** Single occurrence = HIGH finding. Replace with web-first assertion.
3. **No `{ force: true }` clicks.** Forces bypass actionability checks and hide real bugs. Each occurrence = HIGH finding.
4. **CSS/XPath selectors flagged.** `page.locator('.class')`, `page.locator('//xpath')` = HIGH finding (couples tests to implementation).
5. **Retries enabled in CI only.** Local retries = MEDIUM finding (hides flakes from developers).
6. **Auth via storageState global setup**, not per-test login. Per-test login = MEDIUM (slow).
7. **Trace recording on first retry**, not on every test. `trace: 'on'` in production CI = LOW (storage waste). No trace at all = HIGH (impossible to debug failures).
8. **`@axe-core/playwright` accessibility audit** runs on critical pages (login, dashboard, modal flows). Missing = MEDIUM.
9. **Tests pass `--shuffle`** runs. Shuffle-flake = HIGH (hidden order dependence).
10. **Per-test tenant isolation** for E2E touching multi-tenant data. Shared tenant across tests = HIGH (data leakage).
11. **Network mocking limited to third-party services.** Mocking own backend in E2E = HIGH (defeats E2E purpose).
12. **Video disabled by default**, enabled only on failure retain. Always-on video = LOW (slow CI).
13. **Trace artifacts uploaded on failure** for PR debugging. Missing artifact upload = MEDIUM.
14. **Animations disabled in test environment** via CSS injection. Missing = LOW (occasional flakes).
15. **`page.clock.install()` for time-dependent UI** instead of real clock. Real clock = MEDIUM (date-dependent flakes).

## Domain Rule Additions for test-runner

- Playwright tests MUST use locator priority: `getByRole` > `getByLabel` > `getByText` > `getByTestId`. CSS/XPath selectors = HIGH finding.
- `page.waitForTimeout` MUST NOT appear in committed code. Each occurrence = HIGH finding.
- `{ force: true }` on click/fill actions = HIGH finding (bypasses actionability).
- Retries MUST be CI-only (`retries: process.env.CI ? 2 : 0`). Local retries = MEDIUM.
- Auth state MUST be shared via `storageState` from `globalSetup`. Per-test login = MEDIUM finding.
- `trace: 'on-first-retry'` is the production setting. `trace: 'on'` = LOW; missing trace = HIGH.
- Accessibility audits via `@axe-core/playwright` MUST run on login, dashboard, and modal flows. Missing = MEDIUM.
- Test suites MUST pass `--shuffle` runs. Shuffle-flake = HIGH (order dependence).
- E2E tests MUST create per-test tenant fixtures and clean up in `afterEach`. Shared tenant = HIGH (cross-test data leak).
- Network mocking is permitted ONLY for third-party services (Stripe, SendGrid, Sentinel Hub). Mocking own backend in E2E = HIGH.
- Test environment MUST disable CSS animations globally. Missing = LOW finding.
- Time-dependent UI MUST use `page.clock.install()`. Real clock = MEDIUM.
- Pass-on-retry rate over rolling 7 days MUST be < 1%. Higher = systemic flake debt requiring architectural fix.
- Trace artifacts MUST be uploaded as CI artifacts on test failure for PR debugging. Missing = MEDIUM.
- Storage state files (`auth.json`) MUST be in `.gitignore` and regenerated per CI run. Committed credentials = CRITICAL.
