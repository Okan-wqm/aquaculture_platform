# Root dependency modernization checkpoint

Date: 2026-04-30

## Problem

The root workspace had production dependency vulnerabilities and a CI install
path that could mask dependency graph issues. The goal is not to silence audit
output; the goal is to converge the platform onto supported dependency families
without force upgrades, peer bypasses, or ignored advisories.

## Root Cause

Several dependency families were old enough that their transitive dependencies
carried known advisories. Some type-only packages were also installed as runtime
dependencies, causing production audit noise from packages that do not belong in
the runtime graph.

## Implemented Fix

- Updated Apollo federation packages inside the existing Node/Nest architecture:
  `@apollo/gateway`, `@apollo/server`, and `@apollo/subgraph`.
- Aligned Nest GraphQL/Apollo integration to a peer-clean Nest 11 compatible
  graph instead of keeping a CI bypass.
- Updated AWS S3 packages so the production graph uses a non-vulnerable
  `@aws-sdk/xml-builder` range.
- Updated Nest framework packages, Swagger, TypeORM integration, and
  `sanitize-html` to supported patch/minor versions.
- Moved root `@types/*` packages that are only compile-time inputs from
  `dependencies` to `devDependencies`.

## Verification Policy

No local build/typecheck/test was run as final verification for this checkpoint.
Those checks must run in GitHub Actions for this repository because the current
machine is the Docker-running server and should not carry full CI workload.

The CI workflow changes in this checkpoint make GitHub Actions the enforcement
point:

- `npm ci` proves lockfile determinism.
- `strict-peer-deps=true` proves peer-dependency integrity.
- `npm audit --audit-level=high --omit=dev` blocks high/critical production
  vulnerabilities instead of hiding them.
- Full build/test/typecheck remain in GitHub Actions workflows.

## Remaining Work

Do not use `npm audit fix --force`. The remaining audit families need targeted
modernization and compatibility review:

- Apollo Server 4 deprecation path: either complete a supported Apollo Server 5
  integration plan or retain current Node gateway with documented security
  controls until migration is safe.
- Node OPC UA chain: identify whether affected XML/protobuf packages are runtime
  reachable and upgrade or isolate the OPC UA adapter behind a maintained
  integration package.
- Build tooling chain: converge Vite/Vitest/Rollup versions across root and
  workspace packages so frontend CI uses one supported toolchain.
- Residual runtime libraries: review TypeORM, UUID, Nodemailer, Socket.IO, and
  Axios advisories as separate package-family changes with targeted CI evidence.
