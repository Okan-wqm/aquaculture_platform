# Admin HTTP Contract Authority Review

## ADMIN-HIGH-003

Status: IN-PROGRESS until the closing commit is merged to `main`.

### Finding

Admin list delivery had several independent authorities for the same contract:

- backend services constructed `{data,total,...}`, `{items,total,...}`, and partial
  pagination objects;
- the response interceptor inferred pagination by structural duck typing;
- the admin-panel decoder treated any `meta.page` value as a valid page;
- seven current handlers split one query object between named `@Query('key')`
  parameters and a whole-object `@Query()` DTO, so the global
  `forbidNonWhitelisted` policy rejected valid filters;
- three static GET routes were declared behind parameter routes that matched them
  first.

The review compared the current `main` source with the independently authored admin
audit, pagination-envelope, and contract-codegen branches. The older mixed-query change
repaired two handlers; current source contained five additional support handlers with
the same failure. Generated artifacts from those branches were therefore not copied.

### Root cause

Pagination coordinates, REST projection, frontend decoding, controller query ownership,
and route discovery were encoded independently. No compiler owned the complete
controller surface, so a locally plausible handler or type could disagree with runtime
validation and routing while unit tests remained green.

### Resolution architecture

- `@platform/pagination-contracts` is the versioned, browser/server-neutral authority
  for pagination construction, redundant metadata derivation, and serialized metadata
  validation.
- Backend producers use the canonical factory through the backend-common bridge. The
  interceptor promotes only factory-issued results; structural lookalikes cannot
  silently become pages.
- The admin-panel validates every redundant metadata field, rejects inconsistent or
  non-array pages, and projects the validated result through the same authority.
- The audit, custom-plan, and all five support list handlers each accept one validated
  query DTO. Ticket status, priority, and category use const vocabularies with derived
  union types.
- `tools/codegen/admin-contracts/compiler.ts` parses Nest controller syntax with the
  TypeScript AST, resolves aliased decorators, emits a sorted
  `AdminHttpContractManifestV1`, and reports mixed query authorities, duplicate keys,
  dynamic keys, multiple whole-object binders, and static-route shadowing.
- The canonical manifest contains no timestamps or host-specific paths; two
  compilations of the same source revision are byte-identical.

### Verification gates

- pagination contract tests: 6 cases;
- backend pagination bridge: 2 cases;
- response interceptor and audit fail-closed tests: 9 cases;
- admin-panel HTTP decoder: 8 cases;
- query DTO validation: 5 cases;
- pagination AST invariant: 2 cases;
- HTTP compiler invariant: 4 cases, including known-bad fixtures;
- admin backend and admin-panel TypeScript projects compile with `--noEmit`;
- the compiler reports zero current contract diagnostics and discovers more than 100 operations;
- `git diff --check` is clean.

This finding owns the duplicate pagination/query/routing authority class. Broader
generated request/response schema coverage remains governed by the admin-contracts
program and is not claimed by this closure.
