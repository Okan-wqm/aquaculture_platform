# CI peer-clean deterministic install gate

Date: 2026-04-30

## Problem

CI workflows were using `--legacy-peer-deps` and, in some paths, `npm install`
for workspace dependency resolution. That lowered the quality bar in two ways:

- `--legacy-peer-deps` can hide incompatible package graphs that should block a
  merge before build or runtime.
- `npm install` can tolerate or rewrite dependency state instead of proving that
  `package-lock.json` is the exact install source of truth.

## Root Cause

The repository previously carried a Nest/Apollo peer-dependency mismatch. CI
worked around that mismatch instead of making the package graph peer-clean. Once
that workaround existed, new workflow jobs copied it and dependency conflicts
became easier to miss.

## Enterprise Fix

- Moved CI workspace installs to deterministic `npm ci`.
- Removed every workflow use of `--legacy-peer-deps`.
- Added repo-level `.npmrc` with `strict-peer-deps=true`, so local and CI
  installs fail on peer drift without relying on every workflow author to
  remember a flag.
- Removed the `npm audit ... || true` bypass in CI so high/critical production
  vulnerabilities are blocking signals.
- Added `.npmrc` to the affected-CI path filter because changing install policy
  changes the build graph and must trigger CI.

## Verification

Server/local build and test execution was intentionally not run for this item.
The current operating rule is that build/typecheck/test verification runs in
GitHub Actions because this server is the Docker-running host and has limited
CPU headroom.

Lightweight server-side checks only:

- Confirmed no workflow still contains `legacy-peer-deps`.
- Confirmed no workflow still contains `npm audit ... || true`.
- Confirmed CI workspace installs now use deterministic `npm ci` instead of
  `npm install`.

## Remaining Work

The remaining dependency vulnerabilities must be resolved by package-family
modernization, not `npm audit fix --force`. The next families are:

- Apollo Server 4 / deprecated Playground integration.
- Node OPC UA / XML / protobuf transitive chain.
- Vite / Rollup / Vitest build-tooling chain.
- TypeORM / UUID / Nodemailer / Socket.IO / Axios residual advisories.
