# Plan 020 Phase 0.4 fixture — banned-phrase-positive.md

This fixture is used by Plan 020 verification commands to confirm
that `tools/gates/banned-phrase.ts --mode=file --ignore-exemptions`
correctly surfaces a banned-phrase violation.

The body below intentionally contains a banned token from
`aria_kernel.agent_genesis.BANNED_PHRASES`:

> The team plans to ship the patch but the cleanup work will be
> deferred — there is no owner, deadline, or finding ID attached.

Expected scanner behaviour:
- default `--mode=file <this-file>` → exit 0 (path under `tests/invariants/`
  exempted by EXEMPT_PATHS).
- `--mode=file --ignore-exemptions <this-file>` → exit 1 + violation
  pointing at the line above ("deferred").
