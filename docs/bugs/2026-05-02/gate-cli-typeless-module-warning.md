# Gate CLI typeless module warning

Date: 2026-05-02

## Problem

Local commit hooks emit Node warnings such as:

`MODULE_TYPELESS_PACKAGE_JSON: Module type of file ... tools/gates/*.ts is not specified and it doesn't parse as CommonJS. Reparsing as ES module because module syntax was detected.`

## Impact

The warning does not currently fail the gate, but it means the gate runtime is
paying an auto-detection/reparse cost and depends on Node's mixed module
heuristics. Quality gates should be deterministic because they protect security,
migration, and architectural invariants.

## Root Cause

The repository root intentionally does not declare `"type": "module"` because
the monorepo contains CommonJS-oriented NestJS/tooling surfaces. At the same
time, `tools/gates/*.ts` use ES module syntax and are executed through
`ts-node` in a way that lets Node observe typeless ESM-like source.

## Architectural Fix Direction

Do not add root `"type": "module"` as a quick fix. That would change module
semantics across the whole monorepo.

The enterprise-grade fix is a bounded gate-runtime modernization:

- Give `tools/gates` an explicit module boundary or dedicated runner package.
- Keep gate dependency pins strict through `tools/gates/check-pin.ts`.
- Make CI and husky invoke the same runner path.
- Add a smoke gate that fails if gate execution emits module auto-detection
  warnings.

## Verification

The current PR records the warning and leaves functional gates fail-closed.
Future gate-runtime work must prove warning-free execution in GitHub Actions and
local hooks without changing application runtime module semantics.

