# Package 13: structured-json-logging

## Metadata
Status: DONE (commit TBD)
Estimated Tokens: 3K
Priority: LOW
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Closing-Findings: [LOW-001]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md (2026-04-14 gap scan #13)

## Context
`StructuredLoggerService` is already wired as the default NestJS logger in `createServiceApp` (`NestFactory.create(..., { logger: new StructuredLoggerService(serviceName) })`). Every log line is emitted as single-JSON-object stdout — what Loki/Promtail expects. The gap is not implementation but **enforcement against regression**: `.eslintrc.json` had `no-console` as a *warning* with `warn`/`error` allowed, so `console.warn` calls compiled. If a contributor adds a `console.*` call by habit, it bypasses the structured logger and produces unstructured lines.

This package hardens enforcement so the existing implementation cannot be silently regressed.

## Findings
**LOW-001** (2026-04-14 gap scan #13): No enforcement of JSON format / structured logging.

## Affected Files
- /var/aqua-saas/.eslintrc.json (no-console → error; allow in test overrides)

## Atomic Commit Plan

```
feat(logging): enforce structured JSON logging via ESLint

StructuredLoggerService is already the platform default via
createServiceApp's NestFactory.create logger option. This commit
hardens the enforcement layer so a regression to console.* cannot
ship silently:

- no-console: "warn" with warn/error allowed → "error" with no
  exceptions. Every log must flow through the NestJS Logger
  (and thus StructuredLoggerService).
- New no-restricted-syntax rule against JSON.stringify with an
  indent argument — multi-line JSON breaks structured log parsing.
- Test files keep no-console: off via an override so debug output
  during test runs is not blocked.

Closes: docs/security/2026-04-12-hardening-gap-report.md#LOW-001
```

## Test Plan
- `npm run lint` passes on current main (verified — only 3 console calls exist, all in test files which are now excluded)
- Adding a `console.log` to any src/*.ts file now fails lint

## Verification Command
`npx eslint libs/backend-common/src/**/*.ts` (spot-check)

## Rollback Plan
`git revert {commit_hash} --no-edit`

## Failure Notes
_(empty)_
