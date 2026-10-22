# npm advisories of 2026-10-07

The required `security-audit` job turned red on main on 2026-10-07. It also
blocks every PR that touches a dependency manifest, because merge-gate requires
the job.

The npm advisory feed added 16 advisories at or above moderate in the
production tree, and more in the dev and e2e trees.

## SUPPLY-CRITICAL-018 — the production dependency tree carried critical and high advisories

Production leg (`npm audit --omit=dev`, moderate and above):

- `proxy-addr` 2.0.7 (critical, GHSA-jqcg-44mw-7w3h): IP spoofing via an
  IPv4-mapped IPv6 trust subnet. It sits under express's `trust proxy`.
- `@graphql-tools/utils` 12.0.0, nested under `@nestjs/graphql` 13.4.5 (high,
  GHSA-7mx3-vvmw-hjmv): prototype pollution in `mergeDeep`.
- `@modelcontextprotocol/sdk` (high, GHSA-6qxp-vccf-f47h).
- `sharp` (high, GHSA-wq5f-xc86-pv6w).
- `source-map-js` (high, GHSA-68fv-2mgg-jv7q).
- Nine `@opentelemetry/instrumentation-*` packages (moderate,
  GHSA-qqmp-wf37-98f9): the database user name lands on every span as
  `db.user`.

### Fix

Every production advisory is fixed. None of them is excepted.

- **Patch releases inside the declared ranges** (`npm audit fix`): sharp,
  source-map-js, the MCP SDK, and the knex, mysql2 and pg instrumentations.
- **Scoped overrides**, the same mechanism the repo already uses for security
  floors:
  - `proxy-addr` `^2.0.8`;
  - `@graphql-tools/utils` `12.0.3` under `@nestjs/graphql` only. This is a
    patch release on the same major that @nestjs/graphql 13 already pins
    (12.0.0). It is not the breaking @nestjs/graphql 14 migration npm
    suggests.
- **`@opentelemetry/auto-instrumentations-node` `^0.81.0`.** It has the same
  peer ranges as 0.78, and the platform passes it a single option (fs
  disabled). It ships the patched instrumentations.

Dev-tree fixes in the same change:

- **nx and every `@nx/*` package pinned to `22.7.12`** (patch). That release
  fixes the daemon-socket exposure (GHSA-w3vv-58gj-gw77) and the
  `nx migrate` path traversal (GHSA-hrvq-x7jp-36xv). nx 22.7.12 still pins
  `smol-toml` 1.6.1, so `smol-toml` is overridden to `1.9.0` under nx
  (GHSA-r4xh-jqrq-34v2).
- **`shell-quote` `1.11.0` under `concurrently`.** concurrently 9.x pins
  1.9.0 exactly (critical GHSA-pqg4-j6r4-53mv).
- **`argparse` `2.0.1` under the `js-yaml` of `@istanbuljs/load-nyc-config`.**
  js-yaml 3 uses argparse only in its own CLI binary, not in the library
  istanbul calls. This removes `sprintf-js`, for which no patched release
  exists (GHSA-hp3w-g68c-fv3c), from the jest and coverage chain in the root
  and e2e trees.

After the change, the gate's verdict per leg:

- root-production: clean.
- aquamobil-production: clean.
- e2e-production: clean.
- e2e-full: clean (existing reviewed exceptions only).
- root-full and aquamobil-full: only the two dev-only groups below.

## SUPPLY-HIGH-019 — vitest 3 and tinypool: critical, no patch on 3.x (open, excepted)

- `tinypool` up to 2.1.1 (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) and
  `vitest`/`@vitest/mocker` below 4.1.11 (GHSA-82fw-gwwq-j7x9). The fixes are
  vitest 4.1.11 and tinypool 2.1.2. vitest 3.2.7 requires tinypool `^1.1.1`,
  so no override inside vitest 3 is possible.
- Why this is an exception, not a fix today:
  - vitest is the unit-test runner of the web modules and is never installed in
    a runtime image.
  - The tinypool gadgets need attacker-controlled worker options; here those
    come from the committed vitest config.
  - The mocker path traversal needs attacker-controlled test code.
- Fix: move the web modules to vitest 4. Owner: claude. Deadline: 2026-11-07.
  The exception expires the same day.

## SUPPLY-CRITICAL-026 — @vitest/mocker 3.2.7: critical code injection, no 3.x patch (2026-10-22)

- GHSA-qxg6-89mg-rqv8, published 2026-10-21T19:54Z: "Vitest: Code injection
  via unauthenticated manual mock registration". Affected `@vitest/mocker`
  ranges: `>=2.1.0-beta.7 <4.1.12` and `>=5.0.0-beta.1 <5.0.3`. Patched:
  4.1.12.
- The repository pinned vitest 3.2.7. No 3.x release is patched, and the gate
  had no exception for it, so the root-full leg of the required
  `security-audit` job turned red. Every push to main has been red on
  `CI - Affected` (and `build-status`) since 2026-10-21 22:47Z.
- Not excepted: a fixed release exists.
- Fix: vitest and every `@vitest/*` package to 4.1.12 in every workspace
  manifest and in the root lockfile. This is the vitest 4 move SUPPLY-HIGH-019
  was waiting for, so its three exceptions are removed in the same change
  (vitest 4 no longer depends on tinypool).
- Vitest 4 adaptations:
  - The shared policy (`libs/testing/src/vitest-test-policy.js`) names
    `coverage.include` (`src`), because `coverage.all` is gone and LCOV would
    otherwise drop every untested module.
  - Two sensor-module specs stood in for `new IntersectionObserver` and
    `new FileReader` with `vi.fn` arrow factories, which Vitest 4 refuses to
    construct. They now use real classes via `vi.stubGlobal`.
  - Vitest 3 put `@types/node` into every program that imported it; Vitest 4
    does not. The AquaMobil, farm-module and messaging-module programs
    type-check specs that read files with `node:fs` and use `Array#at`, so
    their tsconfigs now name `node` in `types` instead of inheriting it.
  - Two AquaMobil specs typed their mocks as `ReturnType<typeof vi.fn>`, which
    Vitest 4 widens to `Procedure | Constructable`. They now declare the mocked
    signature (`Mock<() => Promise<boolean>>`, `Mock<(message: unknown) => void>`).

## SUPPLY-CRITICAL-027 — dompurify 3.4.14: five advisories, one critical (2026-10-22)

- The sensor-module SCADA builder sanitizes uploaded SVG with DOMPurify
  (`CustomSvgConfig.tsx`, `CustomSvgRenderer.tsx`), and it ships to the
  browser, so the root production leg reaches it.
- Advisories against 3.4.14:
  - GHSA-cg2g-xh64-v4q7 (critical): `SAFE_FOR_TEMPLATES` bypass. Split
    template expressions survive in attached shadow-root content on DOM
    output modes. Affected `>=3.4.4 <=3.4.16`, patched 3.4.17.
  - GHSA-mrv2-3pqr-j5jr (high): an `IN_PLACE` hook that removes a parent or
    sibling leaves the detached subtree's event handlers armed. It is the
    incomplete fix for GHSA-p98j-92pf-mc4p. Affected `<=3.4.16`, patched
    3.4.17.
  - GHSA-c6gr-qvv4-5v3f (low): the SMIL `attributeName=href` guard is skipped
    under `application/xhtml+xml`. Affected `<=3.4.16`, patched 3.4.17.
  - GHSA-p98j-92pf-mc4p and GHSA-6688-9rhm-gjv2 (low): `IN_PLACE` variants.
    Affected `<=3.4.15`, patched 3.4.16.
- The gate had no exception for any of them, so the `root-production` and
  `root-full` legs of the required `security-audit` job were red.
- Not excepted: a fixed release exists.
- Fix: 3.4.17, the first release outside all five ranges. It goes into the
  sensor-module dependency, the root `overrides` entry, the
  dependency-security-floor pin and the root lockfile. npm now places it under
  `web/modules/sensor-module/node_modules`, its only dependent.

## SUPPLY-MEDIUM-028 — ip-address 10.7.2: quadratic zone-id match (2026-10-22)

- GHSA-rxp7-6hxx-x8q5 (moderate, published 2026-10-22): `Address6` matches a
  zone identifier in quadratic time ahead of its length limit, so one long
  string stalls the process. Affected `<=10.7.3`, patched 10.7.4.
- Reached in production through `express-rate-limit` and `socks`. The root
  override `^10.5.1` resolved 10.7.2. The gate reported "a non-breaking fix is
  available — take it rather than an exception".
- Fix: the root override and the dependency-security-floor pin move to
  10.7.4, and the root lockfile resolves 10.7.4.

## SUPPLY-MEDIUM-020 — tailwind 3 postcss-selector-parser is quadratic (open, excepted)

- `postcss-selector-parser` below 7.1.6 (GHSA-rj75-hqrm-r3gf), reached through
  `tailwindcss` 3.4.19 in the root and AquaMobil trees.
- The other web modules are already on tailwind 4. tailwind 3 depends on
  postcss-selector-parser 6.x, and v7 is a different API.
- It parses only committed CSS at build time and is never installed in a
  runtime image.
- Fix: move AquaMobil and the root tailwind to 4. Owner: claude. Deadline:
  2026-11-07. The exception expires the same day.

## SUPPLY-HIGH-011 — nx toolchain exposed to GHSA-7w5x-hrqm-74c2 (fixed)

nx and every `@nx/*` package are pinned to 22.7.12, and smol-toml is
overridden to 1.9.0 under nx. With that, `npm audit` no longer reaches
GHSA-7w5x-hrqm-74c2 in any leg. The 2026-09-16 exception is removed.

## SUPPLY-HIGH-012 — @nx/react and @nx/module-federation exposed to GHSA-vwc7-r8mq-g2x9 (fixed)

The same nx 22.7.12 pin clears it. GHSA-vwc7-r8mq-g2x9 is no longer reached in
any leg, and its exception is removed.
