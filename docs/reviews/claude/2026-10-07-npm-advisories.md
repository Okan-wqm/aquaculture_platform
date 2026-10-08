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
