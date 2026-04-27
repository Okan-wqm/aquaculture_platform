# Nx Library Creation — Verified Command for libs/migration-harness & Similar

**Status**: Canonical reference (Plan v3 R22 CRITICAL)
**Verified against**: Nx 22.3.3 on this repo, 2026-04-21
**Applies to**: Phase 1 `libs/migration-harness/` + any future Nx lib creation in this repo

## TL;DR

Plan v3 specified the command with `--buildable=true`. On Nx 22 the option is renamed to `--bundler=tsc`. Verified command that works today:

```bash
npx nx g @nx/js:lib migration-harness \
  --directory=libs/migration-harness \
  --unitTestRunner=jest \
  --bundler=tsc \
  --publishable=false \
  --importPath=@platform/migration-harness
```

## Dry-run output (what gets created)

Running with `--dry-run` shows Nx will:

**Create**:
- `libs/migration-harness/src/index.ts` — barrel export
- `libs/migration-harness/src/lib/migration-harness.ts` — sample impl
- `libs/migration-harness/src/lib/migration-harness.spec.ts` — sample spec
- `libs/migration-harness/package.json`
- `libs/migration-harness/project.json`
- `libs/migration-harness/tsconfig.json`
- `libs/migration-harness/tsconfig.lib.json`
- `libs/migration-harness/tsconfig.spec.json`
- `libs/migration-harness/jest.config.cts` — note .cts extension
- `libs/migration-harness/.eslintrc.json`
- `libs/migration-harness/README.md`

**Update**:
- `tsconfig.base.json` — adds `"paths": { "@platform/migration-harness": ["libs/migration-harness/src/index.ts"] }`
- `nx.json` — registers the project in `projects`
- `package.json` — adds any transitive dev-deps if missing

## Deviations from Nx defaults (to apply after generation)

### 1. Move tests from `src/lib/*.spec.ts` to `src/__tests__/*.spec.ts`

Repo convention for `libs/backend-common/` uses `src/<domain>/__tests__/*.spec.ts`. For consistency:

```bash
mkdir -p libs/migration-harness/src/__tests__
git mv libs/migration-harness/src/lib/migration-harness.spec.ts \
       libs/migration-harness/src/__tests__/harness-contract.spec.ts
rm -rf libs/migration-harness/src/lib/  # remove the sample impl; we'll add real ones
```

Then update `jest.config.cts` `testMatch` if Nx's default doesn't pick up `__tests__/`:

```ts
// jest.config.cts
module.exports = {
  displayName: 'migration-harness',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/src/**/__tests__/**/*.spec.ts',
  ],
  transform: { '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }] },
  moduleFileExtensions: ['ts', 'js', 'html'],
};
```

Verify by running `npx nx test migration-harness --listTests` after lib creation.

### 2. Strip sample impl + sample spec

Nx's generated `src/lib/migration-harness.ts` is a stub (`export function migrationHarness(): string { return 'migration-harness'; }`). Delete; replace with the real API per `libs/migration-harness/src/index.ts` spec from plan v3 Phase 1.

### 3. devDependencies-only marker

The harness MUST NOT enter the production graph — it ships `testcontainers` which requires Docker socket access. Two safeguards:

1. `libs/migration-harness/package.json` — mark all deps as `devDependencies` (Nx default is `dependencies`; move them):
   ```json
   {
     "name": "@platform/migration-harness",
     "devDependencies": {
       "testcontainers": "x.y.z",
       "@testcontainers/postgresql": "x.y.z"
     }
   }
   ```
2. Add `project.json` tag `scope:devOnly`:
   ```json
   { "tags": ["scope:devOnly"] }
   ```
   Then configure `@nx/enforce-module-boundaries` ESLint rule so no production lib can `import '@platform/migration-harness'`.

## Image + dep pinning (plan v3 R30 supply-chain)

When installing testcontainers, pin to exact version (not caret):

```bash
npm install -D --save-exact testcontainers @testcontainers/postgresql
```

The image digest is specified in test code via `@sha256:...` suffix (see `docs/patterns/jest-testcontainers.md` §"Image pinning for supply-chain").

## Plan v3 correction

Plan v3 §Phase 1 R22 Changes block specified:

```bash
npx nx g @nx/js:lib migration-harness \
  --directory=libs/migration-harness \
  --unitTestRunner=jest \
  --buildable=true \                    # ← deprecated in Nx 22
  --publishable=false \
  --importPath=@platform/migration-harness
```

The `--buildable=true` flag is replaced by `--bundler=tsc` in Nx 22 (or `--bundler=swc` for faster builds). The generator still succeeds with `--buildable=true` (silently ignored + defaults applied), but use `--bundler=tsc` going forward for clarity. The plan v3 document has been/will be amended in a doc-only commit if Phase 1 kick-off is still pending at merge time.

## Verification record

Dry-run executed 2026-04-21 against this repo:

```
 NX  Generating @nx/js:library
UPDATE package.json
CREATE libs/migration-harness-trial/tsconfig.lib.json
CREATE libs/migration-harness-trial/tsconfig.json
CREATE libs/migration-harness-trial/src/index.ts
CREATE libs/migration-harness-trial/src/lib/migration-harness-trial.spec.ts
CREATE libs/migration-harness-trial/src/lib/migration-harness-trial.ts
CREATE libs/migration-harness-trial/README.md
CREATE libs/migration-harness-trial/package.json
UPDATE nx.json
CREATE libs/migration-harness-trial/project.json
CREATE libs/migration-harness-trial/.eslintrc.json
CREATE libs/migration-harness-trial/tsconfig.spec.json
CREATE libs/migration-harness-trial/jest.config.cts
UPDATE tsconfig.base.json
NOTE: The "dryRun" flag means no changes were made.
```

No errors. Phase 1 lib creation is unblocked.

## References

- `docs/patterns/jest-testcontainers.md` — how the harness actually uses the Nx-scaffolded jest config
- `libs/backend-common/jest.config.ts` — reference jest config shape in this repo
- Plan v3 §Phase 1 R22
- Nx 22 docs: https://nx.dev/packages/js/generators/library
