# P1 CI Rust Jest Evidence

Date: 2026-06-01
Worktree: `/var/aqua-saas/.worktrees/turnrust`

## Supported Commands

### Rust

CI must run the workspace Rust suite with Cargo on `PATH`:

```bash
cargo test --workspace --all-features --no-fail-fast
```

In this worktree shell, `cargo` is installed under `/root/.cargo/bin` but is not on `PATH`. The equivalent local command used for evidence was:

```bash
/root/.cargo/bin/cargo test --workspace --all-features --no-fail-fast
```

### Direct Root Jest

Use direct root Jest with exact file paths for focused invariant evidence:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/auth-token-issuer-ssot.spec.ts --runInBand
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-3 --runTestsByPath tests/invariants/generated-subgraph-verified-user-assertion.spec.ts --runInBand
```

For pattern selection, Jest 30 requires the plural CLI option:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --testPathPatterns auth-token-issuer-ssot --runInBand
```

Do not use the Jest 29 singular form:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --testPathPattern auth-token-issuer-ssot --runInBand
```

Jest 30 rejects that command before tests run with:

```text
Option "testPathPattern" was replaced by "--testPathPatterns".
```

### P1 Invariants And Gates

Identity SSoT:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/auth-token-issuer-ssot.spec.ts --runInBand
```

Generated subgraph assertion coverage, including `ai-service`:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-3 --runTestsByPath tests/invariants/generated-subgraph-verified-user-assertion.spec.ts --runInBand
```

Redis token revocation SSoT:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/token-blacklist-ssot.spec.ts --runInBand
./node_modules/.bin/jest --config apps/gateway-api/jest.config.ts --runTestsByPath apps/gateway-api/src/guards/__tests__/gateway-token-verifier.service.spec.ts apps/gateway-api/src/guards/__tests__/auth.guard.gateway-verifier.spec.ts --runInBand
```

Messaging partition ownership:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/messaging-partition-parent-ssot.spec.ts tests/invariants/single-partition-creator.spec.ts --runInBand
```

Auth DB ownership:

```bash
npm run gates:auth-db-ownership
```

## Evidence From This Worktree

### Rust

Toolchain:

```text
cargo 1.88.0 (873a06493 2025-05-10)
rustc 1.88.0 (6b00bc388 2025-06-23)
```

`cargo test --workspace --all-features --no-fail-fast` could not be run literally because `cargo` is not on `PATH` in this shell. `/root/.cargo/bin/cargo test --workspace --all-features --no-fail-fast` requires a runner with enough memory for the `sensor-ingestion` test link. If this local executor kills the linker, rerun the exact CI command on the Rust CI runner before release signoff:

```text
error: linking with cc failed: exit status: 1
collect2: fatal error: ld terminated with signal 9 [Killed]
could not compile sensor-ingestion (lib test)
could not compile sensor-ingestion (test "policy_integration")
```

The remaining Rust evidence action is to rerun the exact CI command on a runner with Cargo on `PATH` and enough memory for the `sensor-ingestion` test link.

### Jest

Direct root Jest package evidence:

```text
jest 30.0.5
yargs 17.7.2
```

Passed:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/auth-token-issuer-ssot.spec.ts --runInBand
```

Result:

```text
PASS layer-1 tests/invariants/auth-token-issuer-ssot.spec.ts
Test Suites: 1 passed, 1 total
Tests: 2 passed, 2 total
```

Passed:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --testPathPatterns auth-token-issuer-ssot --runInBand
```

Result:

```text
PASS layer-1 tests/invariants/auth-token-issuer-ssot.spec.ts
Test Suites: 1 passed, 1 total
Tests: 2 passed, 2 total
```

Rejected as expected:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --testPathPattern auth-token-issuer-ssot --runInBand
```

Result:

```text
Option "testPathPattern" was replaced by "--testPathPatterns".
```

Passed after rerunning outside the sandbox so the spec could spawn its internal `git grep`:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/token-blacklist-ssot.spec.ts tests/invariants/messaging-partition-parent-ssot.spec.ts tests/invariants/single-partition-creator.spec.ts --runInBand
```

Result:

```text
PASS layer-1 tests/invariants/single-partition-creator.spec.ts
PASS layer-1 tests/invariants/messaging-partition-parent-ssot.spec.ts
PASS layer-1 tests/invariants/token-blacklist-ssot.spec.ts
Test Suites: 3 passed, 3 total
Tests: 10 passed, 10 total
```

Passed:

```bash
./node_modules/.bin/jest --config apps/gateway-api/jest.config.ts --runTestsByPath apps/gateway-api/src/guards/__tests__/gateway-token-verifier.service.spec.ts apps/gateway-api/src/guards/__tests__/auth.guard.gateway-verifier.spec.ts --runInBand
```

Result:

```text
PASS gateway-api apps/gateway-api/src/guards/__tests__/gateway-token-verifier.service.spec.ts
PASS gateway-api apps/gateway-api/src/guards/__tests__/auth.guard.gateway-verifier.spec.ts
Test Suites: 2 passed, 2 total
Tests: 8 passed, 8 total
```

Passed after rerunning outside the sandbox so the spec could spawn its internal `git ls-files` scan:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-3 --runTestsByPath tests/invariants/generated-subgraph-verified-user-assertion.spec.ts --runInBand
```

Result:

```text
PASS layer-3 tests/invariants/generated-subgraph-verified-user-assertion.spec.ts
Test Suites: 1 passed, 1 total
Tests: 14 passed, 14 total
```

The generated subgraph invariant reported coverage for active subgraphs and the router-excluded but federation-capable `ai-service`.

### Auth DB Ownership Gate

Passed with DML and auth-schema DDL ownership scanning enabled:

```bash
npm run gates:auth-db-ownership
```

Result:

```text
Auth DB ownership gate passed.
```

## Documentation Coverage Added

- `docs/security/auth-gateway-ssot.md` documents auth-gateway identity SSoT, Redis token revocation migration, and auth DB ownership command evidence.
- `docs/architecture/messaging-enterprise-tenant-isolation.md` documents messaging partition ownership and the supporting invariants.
