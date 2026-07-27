# Production dependency floor — high npm advisories

**Date:** 2026-07-27
**Scope:** root `package.json` `overrides` + `dependencies`, `package-lock.json`
**Gate under review:** `npm audit --audit-level=high --omit=dev`
(`.github/workflows/ci-affected.yml` job `security-audit`, a required input to `merge-gate`)
**Baseline commit:** `bdaf00bf`

---

## Summary

The `security-audit` job reported four advisory groups. Fixing the tree so it resolves
honestly expanded that to **ten** high findings, of which **nine are closed here**. The tenth
is blocked upstream and is registered separately as `INFRA-HIGH-081`.

| Advisory                                                    | Vulnerable range                         | Reachable via           | Outcome                               |
| ----------------------------------------------------------- | ---------------------------------------- | ----------------------- | ------------------------------------- |
| `brace-expansion` DoS                                       | `<=5.0.7`                                | minimatch (all lines)   | closed for every line except eslint@9 |
| `fast-uri` host confusion                                   | `3.0.0 - 3.1.3`                          | `ajv`                   | closed — floor `^3.1.4`               |
| `postcss` sourceMappingURL path traversal                   | `<=8.5.17`                               | `sanitize-html`, `vite` | closed — floor `^8.5.23`              |
| `sharp` inherited libvips CVEs                              | `<0.35.0`                                | direct dependency       | closed — `^0.35.3`                    |
| `minimatch` / `glob` / `rimraf` / `gaxios` / `gcp-metadata` | (all transitively via `brace-expansion`) | see below               | closed                                |

---

## INFRA-HIGH-080 — four `minimatch` overrides both masked and mis-resolved the glob chain

### Evidence

`package.json` carried, at `bdaf00bf`:

```json
"@eslint/eslintrc":            { "minimatch": "3.1.5" },
"@humanwhocodes/config-array": { "minimatch": "3.1.5" },
"eslint":                      { "minimatch": "3.1.5" },
"glob":                        { "minimatch": "3.1.5" },
"typeorm":                     { "minimatch": "9.0.9", "uuid": "^11.1.1" }
```

Three of these pinned exactly the version their consumer already declares — `eslint@9.39.4`,
`@eslint/eslintrc@3.3.5` and `@eslint/config-array@0.21.2` all declare `minimatch ^3.1.5` — so
they changed nothing. `@humanwhocodes/config-array` is not in the tree at all any more
(`npm ls` returns empty); it was superseded by `@eslint/config-array`. `typeorm` has no direct
`minimatch` dependency; it declares `glob ^10.5.0`.

The fourth was actively wrong. `glob: { "minimatch": "3.1.5" }` applied to **every** `glob` in
the tree, including:

- `@apollo/gateway → make-fetch-happen → cacache → glob@13.0.6`, which declares `minimatch ^10.2.2`
- `typeorm → glob@10.5.0`, which declares `minimatch ^9.0.4`

`glob` v10 and v13 construct `new Minimatch(pattern, { optimizationLevel, windowsPathsNoEscape, … })`
— options that do not exist in minimatch@3. `npm ls` reported the resulting node as
`minimatch@3.1.5 invalid: "^10" from node_modules/cacache/node_modules/glob`. This is a
correctness defect in its own right; the advisory only made it visible.

### Why the obvious fix does not work

`brace-expansion`'s advisory range is `<=5.0.7` with **no lower bound**, so `1.1.16` and `2.1.2`
— the newest releases of the v1 and v2 lines — do not clear it either. Measured directly:

```
1.1.15 -> 1 vuln   export: function
1.1.16 -> 1 vuln   export: function
2.1.2  -> 1 vuln   export: function
5.0.7  -> 1 vuln   export: object {EXPANSION_MAX, expand}
5.0.8  -> 0 vulns  export: object {EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand}
```

`5.0.8` is the only unaffected version, and its export is an **object**, not a callable.
minimatch@3 does `var expand = require('brace-expansion')` and calls it. A repo-wide
`"brace-expansion"` override therefore breaks every minimatch@3 consumer — which is precisely
what happened in the earlier attempt at this change (`e4bcb6cf7`, reverted in `ea6c6f496`):
the Nx project graph died with `expand is not a function`.

### Fix

Remove the four overrides and let each consumer resolve the `minimatch` it declares, then floor
`brace-expansion` **only for the line that already expects the v5 shape**:

```json
"minimatch@^10": { "brace-expansion": "^5.0.8" }
```

and move the two remaining old-glob consumers forward:

- `typeorm: { "glob": "^13.0.6" }` — glob@13 declares `minimatch ^10.2.2`. glob@11 also works
  but is deprecated upstream.
- `gaxios: "^7.3.0"` — 7.3.0 dropped its `rimraf` dependency, which deletes the
  `gcp-metadata → gaxios → rimraf@5 → glob@10 → minimatch@9` chain outright rather than pinning it.

Plus three ordinary floors:

- `fast-uri: "^3.1.2"` → `"^3.1.4"`. The old override _permitted_ the vulnerable `3.0.0–3.1.3`
  range and the lockfile had settled on `3.1.2` inside it, so the floor was aspirational rather
  than enforced. `ajv@8.20.0` declares `^3.0.1`, so `3.1.4` satisfies it.
- `postcss: "^8.5.23"`. Both consumers already admit it (`sanitize-html@2.17.5` declares
  `^8.3.11`, `vite@7.3.5` declares `^8.5.6`).
- `sharp: ^0.34.5` → `^0.35.3` (direct dependency).

### Collateral: sharp 0.35 type resolution

Under `moduleResolution: node` (`tsconfig.base.json`), TypeScript reads sharp's `types` field,
which now points at the ESM `dist/index.d.mts`. That declaration uses named exports
(`export interface FormatEnum`) instead of the CJS `declare namespace sharp`, so
`keyof sharp.FormatEnum` in `apps/messaging-service/src/message/services/thumbnail.service.ts`
stops resolving. Fixed with a named type import — `import sharp, { type FormatEnum } from 'sharp'`
— not a cast.

### Verification

| Check                                                                                                          | Result                                                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `npm audit --audit-level=high --omit=dev`                                                                      | 10 high → 1 high                                               |
| `npm run type-check`                                                                                           | 40/40 projects green                                           |
| `npx nx graph`                                                                                                 | resolves (the earlier attempt's failure mode)                  |
| `npm ls typeorm uuid @nestjs/apollo @apollo/server @apollo/gateway @opentelemetry/api @opentelemetry/sdk-node` | exit 0 — the same CI job's other step                          |
| typeorm glob@13 entity discovery                                                                               | 94 / 18 / 22 files for farm, messaging, auth — equal to `find` |
| `sharp` native runtime under `--ignore-scripts`                                                                | loads (libvips 8.18.3), encodes a PNG                          |
| `nx run dashboard:build`                                                                                       | green (vite + postcss path)                                    |
| `event-contracts:test`                                                                                         | 279 tests green (ajv / fast-uri path)                          |
| `messaging-service:test` / `:lint`                                                                             | 285 tests green, lint clean                                    |
| `gates:lint-baseline:test`                                                                                     | 11/11 flat-config parity green                                 |

`tests/invariants/backup-production-secrets.spec.ts` fails 2 tests in this container; both
reproduce at `bdaf00bf` with the diff stashed, so they are pre-existing and unrelated.

---

## INFRA-HIGH-081 — `brace-expansion` stays reachable through eslint@9; blocked on eslint 10

`brace-expansion@1.1.15` remains under `eslint`, `@eslint/eslintrc` and `@eslint/config-array`.
It cannot be floored there:

- the only unaffected release is `5.0.8`, whose export is an object;
- `eslint/lib/eslint/eslint-helpers.js` does `const minimatch = require("minimatch")` and calls
  it; `@eslint/eslintrc` and `@eslint/config-array` use `import minimatch from "minimatch"`;
- minimatch@10 exports an object with **no** default export — verified directly: `require()`
  yields `{minimatch, sep, GLOBSTAR, …}` and a default ESM import throws.

So the version cannot be raised underneath eslint 9. npm names the fix itself:
`fixAvailable: {name: "eslint", version: "10.8.0", isSemVerMajor: true}` — eslint@10.8.0 depends
on `minimatch ^10.2.5`.

**That is blocked upstream, not by scope.** The repo already runs flat config
(`eslint.config.mjs`, no `.eslintrc*` files remain) and `@typescript-eslint` v8 already declares
`^10.0.0` in its eslint peer range — but three of the six plugins in use have no
eslint-10-compatible release at all:

| Plugin                      | Latest | eslint peer range  |
| --------------------------- | ------ | ------------------ |
| `eslint-plugin-import`      | 2.32.0 | `… \|\| ^9`        |
| `eslint-plugin-jsx-a11y`    | 6.10.2 | `… \|\| ^9`        |
| `eslint-plugin-react`       | 7.37.5 | `… \|\| ^9.7`      |
| `eslint-plugin-react-hooks` | 7.1.1  | `… \|\| ^10.0.0` ✓ |
| `@nx/eslint`                | 22.7.1 | `… \|\| ^10.0.0` ✓ |
| `eslint-config-prettier`    | 10.1.8 | `>=7.0.0` ✓        |

Forcing eslint 10 past three unsatisfied peers is the "override that breaks the build" this work
exists to avoid.

**Unblock condition:** `eslint-plugin-import`, `eslint-plugin-jsx-a11y` and `eslint-plugin-react`
ship releases declaring an eslint-10 peer. The migration must also re-baseline
`tools/lint-gates/eslintrc-flat-parity.spec.ts`, which pins a golden ESLint-8 resolved rule map.

### Options considered and rejected

- **Lower `--audit-level`.** Rejected — that removes the gate rather than the advisory.
- **Add an audit allowlist.** `tools/gates/npm-audit.ts` documents a
  `docs/security/npm-audit-allowlist.yaml` with justification + expiry, but neither the file nor
  the cross-check exists, and the CI job runs raw `npm audit` rather than that gate. Building an
  allowlist mechanism and re-pointing a security gate at it, inside a dependency PR, is a change
  to a control's authority and is not made here.
- **Reclassify the lint plugin's dependencies** so eslint leaves the `--omit=dev` graph.
  `tools/eslint-rules` is genuinely build-time tooling — its only import is
  `@typescript-eslint/utils` and its only consumer is the repo's own `eslint.config.mjs` — so the
  classification argument is real. It was tested: marking the eslint peer optional is not
  sufficient (`@typescript-eslint/utils` declares eslint as a required peer of its own), and npm
  links an optional peer that is present anyway. Making it work needs the plugin's runtime
  dependency moved to an optional peer too, at which point the change is shaping a manifest to
  move an advisory out of a report rather than to describe the software. Not done.
