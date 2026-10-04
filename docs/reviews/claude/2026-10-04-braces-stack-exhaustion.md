# Supply-chain review — 2026-10-04: braces stack exhaustion and two new advisories

- Date: 2026-10-04
- Owner: `claude` (operator `okan`)
- Trigger: the required `CI - Affected / security-audit` check went red on `main`
  at `883917058` (run 37156030133, job 111300446348) on a merge that changed no
  dependency file. The advisories were published against an unchanged lockfile
  (the trigger gap is `SUPPLY-MEDIUM-010`).
- Method: the workflow's own commands, leg by leg, re-measured on `b08685831`:
  `npm audit --json` per leg (root with and without `--omit=dev`,
  `npm --prefix web/apps/aquamobil`, `npm --prefix e2e`), then
  `scripts/ci/npm-audit-gate.mjs` with the leg's `--level` and `--scope`.

## The advisories

| advisory            | package              | vulnerable        | patched                    |
| ------------------- | -------------------- | ----------------- | -------------------------- |
| GHSA-vfj7-8cjw-p6xm | braces               | <= 3.0.3          | none published             |
| GHSA-ch52-4w7c-c8xp | http-cache-semantics | <= 4.2.0          | 4.3.0 is outside the range |
| GHSA-xjh9-v7x6-24jw | @fastify/busboy      | >= 3.1.0, < 3.2.1 | 3.2.1                      |
| GHSA-x8mw-p69m-v3mx | @fastify/busboy      | >= 1.0.0, < 3.2.1 | 3.2.1                      |

GHSA-vfj7-8cjw-p6xm (CWE-674, CVSS 7.5): braces' recursive AST walkers have no
depth guard, so a deeply nested brace pattern under the length limit exhausts
the call stack and the process dies with an uncaught `RangeError`. braces 3.0.3
(published 2024-05-21) is the latest release and the advisory names no patched
version, so no braces upgrade exists. micromatch 4.0.8 (latest) declares
`braces ^3.0.3`, and fast-glob 3.3.3 (latest) declares `micromatch ^4.0.8`;
neither can be moved off it either.

Red legs on `b08685831` before this change:

- `root-production` (moderate, `--omit=dev`): `@nestjs/graphql` → `fast-glob` →
  `micromatch` → `braces`, and `http-cache-semantics`.
- `root-full` (high): 45 packages blocking: the braces graph (jest, graphql
  codegen, tsc-alias, the nx dev-server proxy, lint-staged, tailwindcss) plus
  `@fastify/busboy` and `http-cache-semantics`.
- `aquamobil-full` (high): tailwindcss 3 → chokidar / fast-glob / micromatch →
  braces (5 packages).
- `e2e-full` (high): the jest 29 tree (29 packages).

`aquamobil-production` and `e2e-production` were clean.

## SUPPLY-HIGH-016 — every path with a non-breaking fix, fixed by upgrading

Nothing in this section is excepted.

### root-production: @nestjs/graphql 13.4.2 → 13.4.5, @nestjs/apollo 13.4.2 → 13.4.5

13.4.5 replaced fast-glob with tinyglobby in `GraphQLTypesLoader`
(nestjs/graphql#4078, `lib/utils/glob.util.ts`), so fast-glob, micromatch and
braces leave the production graph. The lockfile marks all three, with their
own dependencies, dev-only.

`@nestjs/apollo` moves with it. It deep-imports `@nestjs/graphql` internals
(`graphql.constants`, `schema-builder/helpers/file-system.helper`,
`type-factories`, `plugin/plugin-constants`), and its 13.4.5 driver reads the
`resolverDecoratorHost` that `@nestjs/graphql` 13.4.3 added to
`AbstractGraphQLDriver`. The two are published from one repository in
lockstep.

What else 13.4.2 → 13.4.5 changes, checked against this repository:

- resolver hooks (`ResolverDecoratorHost`) and an Apollo request-lifecycle
  plugin that returns at once when no hook is registered. Nothing here
  registers one.
- `backfillDefaultValues` before printing a federation 2 subgraph SDL. The
  util is a no-op on graphql 16 (it only fills the v17 `default` property);
  the root resolves graphql 16.14.2.
- TSDoc comments in `GraphQLDefinitionsFactory` output. Nothing here uses the
  definitions factory or `typePaths`; every subgraph is code-first.
- graphql 17 support in type signatures.

Transitive moves npm made for the new exact pins of `@nestjs/graphql` 13.4.5:
`@graphql-tools/schema` 10.0.36 → 10.1.0, `@graphql-tools/merge` 9.1.9 →
9.2.6, `graphql-ws` 6.0.8 → 6.2.1. All are within the declared ranges.

### root-production: http-cache-semantics 4.2.0 → 4.3.0

Reached through `@apollo/gateway` → `make-fetch-happen` (`^4.1.1`): the
gateway's supergraph and subgraph fetches. `npm update http-cache-semantics`
resolves 4.3.0 inside that range.

### root-full: @fastify/busboy 3.2.0 → 3.2.2

Reached through `@graphql-codegen/cli` → `@whatwg-node/fetch` →
`@whatwg-node/node-fetch` (`^3.1.1`). `npm update @fastify/busboy`, dev-only.

### root-full: jest 30.0.5 → 30.5.2, jest-util 30.0.5 → 30.5.1, jest-environment-node ^29.7.0 → 30.5.2

The 30.0.5 releases of `jest-message-util`, `jest-haste-map`, `@jest/core`,
`@jest/transform` and `jest-config` declare micromatch; their 30.5.x releases
declare picomatch or nothing glob-related, so the root jest graph no longer
reaches braces. jest and
jest-util keep their exact pins, inside the 30.x major the root already runs.

`jest-environment-node` was declared at `^29.7.0` while every root project
runs jest 30. `npx jest --config apps/config-service/jest.config.ts
--showConfig` resolved `testEnvironment: 'node'` to the hoisted
`node_modules/jest-environment-node` (29.7.0) under
`@jest/core/node_modules/jest-circus` (30.0.5): root suites ran a jest 29
environment under a jest 30 runner. No file imports the package; the
declaration dates from the workspace's first commit (`702d27a95`), when the
root was on jest 29. 30.5.2 is the release the 30.5.2 runner itself depends
on. The 29.x `jest-message-util` → `micromatch` chain it pulled in goes with
it.

### root-full: lint-staged removed

`lint-staged ^15.2.0` (→ micromatch) is a devDependency that nothing in the
repository invokes: no `lint-staged` key in `package.json`, no
`.lintstagedrc` or `lint-staged.config.*`, no call in `.husky/` or any
workflow. `.husky/pre-commit` listed it as a "Future Phase 2" addition from
`47bea2079` until `a83b62bd3` dropped the note; it was never wired. Removing
the dependency removes the path. `docs/adr/012-schema-drift-prevention.md` still says the entity-schema
ESLint rule "runs on every `git commit` via the project's lint-staged config";
no such config exists, and the rule runs in the lint CI step.

### No other non-breaking fix exists

After these changes `npm audit fix --dry-run --package-lock-only` reports "up
to date" for the root, `e2e/` and `web/apps/aquamobil/`. npm's own fix engine
has nothing left to apply without `--force`. Where the gate prints "a
non-breaking fix is available" for `@graphql-tools/code-file-loader` or
`@jest/reporters`, that is npm's `fixAvailable` flag on an intermediate node.
Every published version of those packages still reaches braces.

### Floors

`tests/invariants/dependency-security-floor.spec.ts` carries the new root
floors in the manifest and in every lock copy: `@nestjs/graphql` ≥ 13.4.5
(declared `^13.4.5`), `http-cache-semantics` ≥ 4.3.0 and `@fastify/busboy` ≥
3.2.1. The last two are lock-only, like `engine.io`.

## SUPPLY-HIGH-017 — braces in dev and build tooling: reviewed exception until 2026-11-03

After SUPPLY-HIGH-016 every remaining path is GHSA-vfj7-8cjw-p6xm in a full
leg: `root-full` 16 packages, `aquamobil-full` 5, `e2e-full` 29. No production
leg reaches braces.

### What an attacker needs

The crash needs a deeply nested brace _pattern_ to reach `braces`: the pattern
argument of micromatch, fast-glob, globby, chokidar/anymatch, or braces itself.
The strings matched against a pattern (file paths, stack frames) are not brace
expanded. So the question for each path is where its patterns come from.

| path (leg)                                                                                                                                                       | where the patterns come from                                                                                                                               | what removes it                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@graphql-codegen/cli` 7.1.2 → micromatch; `@graphql-tools/{code,graphql,json}-file-loader` → globby 11; `git-loader` → micromatch; `graphql-config` (root-full) | `codegen.ts` (`schema`, `documents`), run by `npm run codegen` / `codegen:check` locally and in CI                                                         | no release: `@graphql-codegen/cli` 7.4.3 (latest) declares `micromatch ^4.0.5`; the latest loaders (code-file 8.1.41, graphql-file 8.1.22, json-file 8.0.36) declare `globby ^11.0.3`, git-loader 8.0.44 `micromatch ^4.0.8`. npm's proposal is a downgrade to 3.2.0 |
| `tsc-alias` 1.8.17 → chokidar 3.6.0, globby 11.1.0 (root-full)                                                                                                   | `tools/build/build-service.sh:22`, `-p apps/<svc>/tsconfig.build.json`; image builder stage only, the runtime stage installs `--omit=dev`                  | no release: 1.9.7 (latest) declares `chokidar ^3.5.3`, `globby ^11.0.4`; npm's proposal is a downgrade to 1.0.11                                                                                                                                                     |
| `@nx/react` 22.7.8, `@nx/module-federation` → `http-proxy-middleware` 3.0.7 → micromatch (root-full)                                                             | the proxy options of nx's React and module-federation dev-server executors; no project or `nx.json` plugin references `@nx/react`, so nothing invokes them | no release: http-proxy-middleware 3.0.7 (v3-latest) and 4.2.0 (latest) declare `micromatch ^4.0.8`; npm's proposal is `@nx/react` 19.6.7 (downgrade). Same nx line as SUPPLY-HIGH-011/012                                                                            |
| `tailwindcss` 3.4.19 → chokidar 3, fast-glob, micromatch (root-full through the aquamobil workspace; aquamobil-full)                                             | `web/apps/aquamobil/tailwind.config.js` `content`; Vite build stage, the output is static CSS                                                              | semver-major: tailwindcss 4 (3.4.19 is the `v3-lts` tag)                                                                                                                                                                                                             |
| `jest` 29.7.0 tree, 29 packages (e2e-full)                                                                                                                       | `e2e/jest.config.ts` (`testMatch`) and CLI arguments from `e2e/package.json` scripts                                                                       | semver-major: jest ^30.5.2 with `@types/jest` 30, the release the root runs after SUPPLY-HIGH-016 (`ts-jest ^29.4.12` already accepts jest 30)                                                                                                                       |

Every pattern on these paths is committed configuration or a command line in
a script or workflow. A party that can change one can already run code in the
same job: `codegen.ts`, `jest.config.ts` and `tailwind.config.js` are modules
the tool executes. The worst outcome is a crashed tooling process (a CI job,
a build stage, a dev server), not a service. No path is in a runtime image.

Overrides are no way out. braces has no patched version to override to, and
moving micromatch, fast-glob, globby or chokidar outside the range each parent
declares (globby 12+ is ESM-only, chokidar 4 removed glob support) breaks
those parents and is not taken.

### The exception

`scripts/ci/npm-audit-exceptions.json` → `GHSA-vfj7-8cjw-p6xm`: owner `claude`,
expires 2026-11-03, finding SUPPLY-HIGH-017, scopes `root-full`,
`aquamobil-full` and `e2e-full`, and the 43 packages the three legs report.
No production scope is named. `MAX_EXCEPTIONS` in
`tests/invariants/npm-audit-exception-ssot.spec.ts` goes from 2 to 3 in the
same commit.

Known limit of the schema: `packages` is one list for all of an entry's
scopes. The jest names are excepted in `root-full` too, although the root jest
graph left braces in SUPPLY-HIGH-016. A regression of root jest to a
micromatch-carrying release would not turn `root-full` red while this entry
lives. The root pins jest, jest-util and jest-environment-node exactly, so
such a regression is a reviewed manifest change.

### Plan, owner `claude`, deadline 2026-11-03

1. `e2e/`: jest ^29.7.0 → ^30.5.2 and `@types/jest` ^29 → 30. This removes
   all 29 `e2e-full` packages.
2. `web/apps/aquamobil/`: tailwindcss 3 → 4 (CSS-first config, the Vite
   plugin). This removes the `aquamobil-full` leg's 5 packages and tailwindcss,
   chokidar 3 and fast-glob from `root-full`.
3. Re-check upstream for `@graphql-codegen/cli` and the `@graphql-tools`
   loaders, `tsc-alias` and `http-proxy-middleware`, and for a patched braces,
   which clears every path at once. `@nx/react` is referenced by no project
   or `nx.json` plugin; whether it stays is part of the nx migration that
   SUPPLY-HIGH-011/012 track.
4. Drop each package from the entry as its path goes; delete the entry and
   lower the ratchet when the list is empty. On 2026-11-03 the gate fails
   closed and the argument has to be made again.
