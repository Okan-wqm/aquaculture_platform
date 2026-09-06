# shared-ui resolves from source under test — 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `f4b1c50c1`.

Surfaced by PR #1450's `test` job, not by a branch. The same job had passed on the identical
main SHA in an earlier run — that split is the whole finding.

## FE-HIGH-064 — a test suite that passed or failed on whether a build artifact existed

**Severity:** HIGH. **Owner:** frontend-expert. **State:** IN-PROGRESS.

**Evidence.** Nine federation configs alias `@aquaculture/shared-ui`. Two of them —
`farm-module` and `sensor-module` — resolve it as `mode === 'test' ? shared-ui/src :
shared-ui/dist`. The other seven (`tenant-admin`, `admin-panel`, `dashboard`, `hr-module`,
`hydroponics-module`, `messaging-module`, `shell`) pointed unconditionally at
`web/shared-ui/dist`.

`dist/` is a build output. A vitest run that never builds shared-ui therefore resolves the
package to a directory that may not exist, and Vite fails at import resolution rather than on an
assertion: `Failed to resolve import "@aquaculture/shared-ui"`. On PR #1450 that took out seven
of tenant-admin's thirteen spec files before a single test body ran, and `build-status`,
`merge-gate` and `sens-enterprise-summary` went red behind it.

The failure is order-dependent, which is why it reads as a flake and is not one. Run
`34007263328` and run `34018063733` are both `f4b1c50c1`; the first passed, the second failed.
Locally it always passed, because a `web/shared-ui/dist` from an earlier build was sitting on
disk. Reproduced deterministically by moving that directory aside: the same seven files fail with
the same message, and restoring it makes them pass again.

**Rule violated.** A test run resolves its imports from sources present in the checkout, never
from a build artifact another job may or may not have produced.

**Fix.** `web/shared-ui/src/federation/sharedUiAlias.ts` owns the choice —
`resolveSharedUiAlias(sharedUiRoot, mode)` returns `src` under `mode === 'test'` and `dist`
otherwise — and all nine configs call it, including the two that previously spelled the ternary
themselves. Federation keeps the built barrel for dev and build, so the `shared:` singleton
contract (FE-HIGH-004) is untouched.

`tests/invariants/shared-ui-test-alias.spec.ts` keeps the resolver the only owner. It walks
`web/**` for `vite.config.ts` rather than listing the nine, accepts either a direct call or a
local bound to one (both say the value came from the resolver), and fails any config that spells
`shared-ui/dist` for itself. It also asserts the mapping in both directions so the resolver
cannot silently invert.

**Closure criterion.** Verified in both directions. With `web/shared-ui/dist` moved aside, all
seven previously-broken modules pass — tenant-admin 13/13 files and 146/146 tests, admin-panel
7/7, dashboard 1/1, hr-module 1/1, hydroponics-module 1/1, messaging-module 1/1, farm-module
59/59, sensor-module 74/74. Reverting one config's alias to the literal fails two of the
invariant's four cases with the offending file named.
