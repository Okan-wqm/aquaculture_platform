# ADR: TypeORM uuid remediation via governed fork

Date: 2026-04-30

## Decision

Use a governed internal TypeORM fork if the organization requires the remaining
moderate `uuid <14` advisory to be eliminated before upstream TypeORM publishes
an official compatible fix.

The fork must be treated as a company-owned package, not as a patch:

- package name: `@aquaculture/typeorm`
- upstream source: pinned TypeORM commit SHA
- release evidence: SBOM, provenance, changelog, and owner
- validation: upstream TypeORM tests plus Aqua Testcontainers DB platform suite
- rollback: restore official `typeorm` lockfile and remove alias/fork package

## Rationale

TypeORM 0.3.28 declares `uuid@^11.1.0` and its runtime code calls
`require("uuid")`. Forcing `uuid@14` through npm overrides changes a transitive
runtime import contract that TypeORM does not declare support for.

## Rejected Options

- `uuid@14` override: rejected because it masks audit output without proving
  TypeORM's CommonJS runtime path, query builder, cache, migrations, Jest, and
  bundled services.
- `patch-package`: rejected because it mutates installed artifacts after package
  resolution, weakens provenance, and is now blocked by the dependency-policy
  gate.
- Runtime wrapper injection: rejected because TypeORM imports `uuid` inside its
  own package internals; wrapping our repositories does not replace every
  TypeORM `require("uuid")` call or remove the vulnerable package from the SBOM.
- Full ORM migration: rejected as the immediate security fix because tenant
  schema routing, migrations, QueryRunner transactions, outbox/audit behavior,
  and repositories are deeply TypeORM-coupled.

## Required Controls

- No `patch-package`, `--force`, `legacy-peer-deps`, or transitive `uuid@14`
  override.
- `npm ls typeorm uuid` must be captured in CI artifacts.
- Testcontainers must cover generated UUID insert, query-result cache UUID path,
  tenant `search_path`, source+tenant migration fan-out, failed migration
  rollback, advisory-lock concurrency, and tenant A/B isolation.
