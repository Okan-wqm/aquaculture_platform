# Deploy capacity diagnostics review (2026-06-21)

Reviewer: infra-expert
Scope: `scripts/deploy/droplet-capacity.sh`, `tests/invariants/deploy-ssot-contract.spec.ts`, `docs/runbooks/deploy-capacity-and-image-gc.md`

## INFRA-HIGH-021 — Capacity diagnostic pipeline can fail before the capacity gate decides

**Severity:** HIGH
**Status:** RESOLVED
**Owner:** infra-expert

`deploy-production / capacity-preflight` on main run `27898255659` checked out
`142f1331f743a5f6a2ef989bc17b665d262c35a7` and started the canonical capacity
script. The droplet still had only ~29.9 GB free and 18 percent free, so the
release was expected to fail closed unless safe image GC recovered enough space.
Instead, the job exited while printing disk-usage evidence: `du -x -B1 -d1 /
| sort -nr | head -20 | awk ...` ran under `set -euo pipefail`, and `head`
closed the pipe early after twenty rows.

That made diagnostic collection, not the capacity threshold SSoT, the process
exit reason. The same helper also scanned nested paths after `/`, so a large
droplet could spend most of the SSH timeout re-reading the same filesystem
before executing `capacity_failures`.

The fix keeps the deploy threshold model unchanged and makes diagnostics an
auditable, bounded evidence layer:

- gate mode uses one summary top-level filesystem scan by default;
- deep mode is explicit for maintenance reports;
- every `du` scope is timeout-bounded;
- sorted output is formatted with `awk 'NR <= 20'` instead of `head`, so
  `pipefail` cannot turn normal truncation into a failed deploy step;
- diagnostic collection emits `disk_usage_unavailable` evidence when it cannot
  finish, while the canonical filesystem, inode, projected-pull, and safe-GC
  gates still make the deploy pass/fail decision.

## INFRA-MEDIUM-022 — aqua-scripts lint gate was blocked by dead script code and local GraphQL request copies

**Severity:** MEDIUM
**Status:** RESOLVED
**Owner:** infra-expert

The affected lint gate for this deploy fix also executed `aqua-scripts:lint`.
That target failed on main-contained script debt: a hard-counted regex space in
the messaging outbox gate, an unused aggregate counter in the CREATE TYPE
wrapper, unused parse-error catch bindings in feed scripts, and stale
`eslint-disable no-console` directives that no longer correspond to the active
lint contract.

The feed scripts also carried two local copies of the same GraphQL HTTP request
logic. The fix moves endpoint parsing, protocol selection, tenant/auth headers,
JSON parse handling, and GraphQL error normalization into
`scripts/lib/graphql-http-client.mjs`, then makes both scripts consume that
helper. `tests/invariants/script-graphql-client-ssot.spec.ts` pins that contract
so feed maintenance scripts cannot reintroduce local GraphQL clients. The lint
fixes therefore remove dead code and duplicate behavior rather than adding
suppressions.
