# Production dependency floor — high npm advisories

**Date:** 2026-07-27
**Scope:** root `package.json` `overrides` + `dependencies`, `package-lock.json`
**Gate under review:** `npm audit --audit-level=high --omit=dev`
(`.github/workflows/ci-affected.yml` job `security-audit`, a required input to `merge-gate`)
**Baseline commit:** `bdaf00bf`

---

## Summary

The `security-audit` job reported four advisory groups. Fixing the tree so it resolves honestly
expanded that to **ten** high findings. **All ten are closed here** and the gate reaches
`exit 0` — nine by dependency floors (`INFRA-HIGH-080`), the tenth by correcting a dependency
_classification_ rather than a version (`INFRA-HIGH-081`).

`INFRA-HIGH-081` was first recorded as blocked upstream until eslint 10. **That was wrong**, and the
correction is documented in its section below rather than silently replaced, because the error was
in the search and not in the arithmetic: one reclassification mechanism was tested, failed, and got
generalised into "reclassification cannot work."

| Advisory                                                    | Vulnerable range                         | Reachable via           | Outcome                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `brace-expansion` DoS                                       | `<=5.0.7`                                | minimatch (all lines)   | closed — floor `^5.0.8` for minimatch@^10; the eslint@9 line left the production graph entirely |
| `fast-uri` host confusion                                   | `3.0.0 - 3.1.3`                          | `ajv`                   | closed — floor `^3.1.4`                                                                         |
| `postcss` sourceMappingURL path traversal                   | `<=8.5.17`                               | `sanitize-html`, `vite` | closed — floor `^8.5.23`                                                                        |
| `sharp` inherited libvips CVEs                              | `<0.35.0`                                | direct dependency       | closed — `^0.35.3`                                                                              |
| `minimatch` / `glob` / `rimraf` / `gaxios` / `gcp-metadata` | (all transitively via `brace-expansion`) | see below               | closed                                                                                          |

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

## INFRA-HIGH-081 — `brace-expansion` reachable through eslint@9 — RESOLVED by reclassification

> **This section's original conclusion was WRONG and is corrected below.** It stated the advisory
> was blocked upstream until eslint 10. The version analysis in it is accurate and still stands —
> `brace-expansion` genuinely cannot be floored under eslint 9. What was wrong was the claim that
> this left no remedy. The remedy is not a version bump at all: eslint had no business being in the
> production graph in the first place. The wrong reasoning is kept visible rather than deleted,
> because the error was in the _search_ — one reclassification mechanism was tested, failed, and
> was generalised into "reclassification cannot work".

### The version analysis (unchanged, still correct)

`brace-expansion@1.1.15` sits under `eslint`, `@eslint/eslintrc` and `@eslint/config-array`.
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

So the eslint 10 route remains genuinely blocked, and is **not** the route taken. It stays recorded
because it is the route a reader will otherwise try. (`eslint-plugin-react-hooks` has since shipped
7.1.1 with an `^10.0.0` peer, so the blocker is now three plugins, not four.)

### What actually resolved it: the graph was misclassified, not the version

The advisory was only ever _in_ the production graph because of two manifest defects, neither of
which is a version:

1. **`tools/eslint-rules` and `tools/executors/cargo` were npm `workspaces`.** npm has no notion of
   a dev workspace — every workspace edge is unconditionally production — so the entire eslint and
   typescript-eslint toolchain was a production dependency of a repo that ships none of it.
2. **`vite-plugin-svgr` sat in `dependencies`**, dragging `vite`, `rollup`, `esbuild` and `terser`
   into the production graph. Its only consumer, `web/modules/sensor-module`, already declares it as
   a devDependency.

Removing the two workspace entries, declaring both packages as `file:` devDependencies, and moving
`vite-plugin-svgr` to `devDependencies` takes the gate to **exit 0**. Also dropped
`@anthropic-ai/claude-agent-sdk`, which has zero importers repo-wide (`@anthropic-ai/sdk` is a
different package, imported at `apps/ai-service/src/agent/providers/anthropic.provider.ts:3`, and is
kept).

Measured on this checkout — the point being that **nothing was upgraded**:

| Measure                                   | Before | After                                                            |
| ----------------------------------------- | ------ | ---------------------------------------------------------------- |
| `npm audit --audit-level=high --omit=dev` | exit 1 | **exit 0**                                                       |
| production high/critical advisories       | 1      | **0**                                                            |
| production dependency count               | 1627   | **1477**                                                         |
| resolved version changes                  | —      | **0**                                                            |
| lock nodes added                          | —      | **0**                                                            |
| lock nodes removed                        | —      | 9 (all `@anthropic-ai/claude-agent-sdk` + its platform binaries) |
| `dev` flag flips                          | —      | 210                                                              |

This is strictly _more_ truthful, not less. eslint is build-time-only; the reclassified graph says
so, and `--omit=dev` now answers the question it was written to answer.

**Why the earlier rejection was not evidence.** The rejected experiment set
`peerDependenciesMeta.eslint.optional` on `tools/eslint-rules`. That fails because
`@typescript-eslint/utils` declares eslint as a required peer of its own, and npm links a present
optional peer anyway. Removing the **workspace edge** is a different mechanism entirely, and it does
not touch a single peer range. One failed mechanism was generalised into a whole rejected category —
that is the actual defect in the earlier analysis.

**Locked in, not just fixed** (tier 3): `tests/invariants/production-graph-purity.spec.ts` reads the
`dev` flags in `package-lock.json` — the artifact `npm ci --omit=dev` actually obeys — and asserts
no node resolving to eslint / typescript-eslint / vite / rollup / esbuild / terser / jest / nx / tsx
/ prettier is production-flagged, that neither tooling path is a workspace, and that both remain
installed as dev `file:` deps. It reads the lockfile rather than shelling out to `npm ls` so it is
hermetic, deterministic and runnable before any install. Verified to fail against the pre-fix
manifests (12 failures) and pass after (20/20).

Note `npm ci --omit=dev --dry-run` is unusable as an exit criterion: on npm 10.9.7 it ignores
`--omit=dev` in its reported diff.

### Also closed here: `security-audit` could be dropped from the merge contract unnoticed

`.github/manifests/main-required-status-checks.json` listed 9 `requires_jobs` for `merge-gate` and
omitted `security-audit`, while `tools/gates/required-status-checks.ts` only verifies that _listed_
jobs are present in the workflow's `needs:`. There is no reverse check, so the only PR-blocking
dependency audit could be deleted from `merge-gate` and the contract gate would still pass. Adding
the entry closes it. Verified both directions: the gate prints `static contract ok` on the committed
tree, and `missing needs entry security-audit` (exit 1) when the `needs:` line is removed — which
passed silently before.

### Options considered and rejected

- **Lower `--audit-level`.** Rejected — that removes the gate rather than the advisory.
- **Add an audit allowlist.** `tools/gates/npm-audit.ts` documents a
  `docs/security/npm-audit-allowlist.yaml` with justification + expiry, but neither the file nor
  the cross-check exists, and the CI job runs raw `npm audit` rather than that gate. Building an
  allowlist mechanism and re-pointing a security gate at it, inside a dependency PR, is a change
  to a control's authority and is not made here.
- **`peerDependenciesMeta.optional` on the eslint peer.** Rejected on evidence and still rejected:
  `@typescript-eslint/utils` declares eslint as a required peer of its own, and npm links a present
  optional peer regardless. Superseded by removing the workspace edge, which is a different
  mechanism — see above. Recorded so it is not retried.
- **Migrating eslint 9 → 10.** Not done, and no longer needed for this advisory. Three of the six
  lint plugins in use still have no eslint-10-compatible release, and the migration would additionally
  have to re-baseline `tools/lint-gates/eslintrc-flat-parity.spec.ts`, which pins a golden ESLint-8
  resolved rule map. Worth doing on its own merits, on its own schedule.
