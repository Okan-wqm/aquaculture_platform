# Build tooling and OPC UA dependency alignment

Date: 2026-04-30

## Problem

The root workspace still had high/critical dependency risk families after the
first dependency modernization checkpoint. Two important sources were:

- Fragmented frontend build tooling: root/workspace packages used different
  Vite, Vitest, React plugin, and Nx lines.
- Industrial integration packages: `node-opcua` and `minio` pulled XML/protocol
  parser chains that must stay on maintained package lines.

## Root Cause

Several workspace package manifests still declared Vite 5 / Vitest 1 while the
root had moved to newer tooling. npm therefore had to keep multiple build-tool
graphs in the lockfile. Separately, OPC UA and MinIO dependencies were behind
their latest compatible patch/minor releases.

## Fix

- Aligned Nx packages and `nx` to `22.7.1`.
- Aligned root Vite to `7.3.2` and root Vitest to `3.2.4`.
- Added root Vitest as an explicit dev dependency because strict peer resolution
  correctly rejected npm's attempt to satisfy `@nx/vite` with a newer optional
  Vitest line.
- Aligned workspace Vite manifests to `^7.3.2`, Vitest manifests to `^3.2.4`,
  and `@vitejs/plugin-react` manifests to `^5.2.0`.
- Updated `node-opcua` to `^2.169.0`.
- Updated `minio` to `^8.0.7`.

## Verification

Server/local build and test execution was not run. Those gates must run in
GitHub Actions.

Lightweight checks performed:

- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`
  completed under `strict-peer-deps=true`.
- Lockfile inspection confirmed a single hoisted Vite/Vitest/React plugin line:
  `vite@7.3.2`, `vitest@3.2.4`, `@vitejs/plugin-react@5.2.0`.
- Lockfile inspection confirmed `node-opcua@2.169.0` and `minio@8.0.7`.

## Remaining Work

GitHub Actions must run the full affected/full CI gates. Any remaining audit
findings should be closed by the next dependency family, not by broad overrides:

- Apollo Server / Nest Apollo Playground dependency.
- OpenTelemetry/gRPC/protobuf chain.
- Residual TypeORM, UUID, Nodemailer, Socket.IO, Axios, tar/cacache findings.
