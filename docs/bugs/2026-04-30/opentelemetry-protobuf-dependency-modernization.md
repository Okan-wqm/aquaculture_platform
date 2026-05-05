# OpenTelemetry protobuf dependency modernization

Date: 2026-04-30

## Problem

The root dependency graph still carried OpenTelemetry/gRPC/protobuf-related
audit surface after the first modernization pass. The application telemetry
bootstrap also used the older OpenTelemetry `Resource` constructor and semantic
constant import style.

## Root Cause

OpenTelemetry packages were pinned to the older 0.48/1.x line while newer
instrumentation packages use the 0.216/2.x API family. Keeping the old line
forces older transitive protocol packages and makes future security upgrades
harder. The application only needed stable resource attributes, so a direct
`@opentelemetry/semantic-conventions` dependency was unnecessary.

## Fix Applied

- Aligned OpenTelemetry runtime packages to the supported line:
  `@opentelemetry/api@^1.9.1`, `@opentelemetry/core@^2.7.1`,
  `@opentelemetry/auto-instrumentations-node@^0.74.0`,
  `@opentelemetry/exporter-trace-otlp-http@^0.216.0`,
  `@opentelemetry/resources@^2.7.1`, and
  `@opentelemetry/sdk-node@^0.216.0`.
- Updated telemetry bootstrap to use `resourceFromAttributes`.
- Removed the direct `@opentelemetry/semantic-conventions` dependency because
  application source no longer imports it directly.

## Verification

Server/local build and test execution was not run. Those gates must run in
GitHub Actions.

Lightweight checks performed:

- `npm install ... --package-lock-only --ignore-scripts --no-audit --no-fund`
  completed under `strict-peer-deps=true`.
- Lockfile inspection confirmed the expected OpenTelemetry package versions.
- Source search confirmed no direct application import of
  `@opentelemetry/semantic-conventions` remains.

## Remaining Work

GitHub Actions must run backend typecheck/build because OpenTelemetry v2 API
compatibility must be compiler-verified against the installed package graph.
Any remaining protobuf audit finding after CI artifact generation should be
mapped to its actual parent package before further changes.
