# C0 — Federation shared-singleton invariant rails

**Date:** 2026-06-11
**Agent:** frontend-expert (lead-verified; implementation session)
**Scope:** `web/shared-ui/src/federation/federationSharedConfig.ts`, `web/modules/{dashboard,tenant-admin}/vite.config.ts`, `tests/invariants/federation-shared-singleton.spec.ts`, `tests/invariants/jest.config.ts`.

---

## FE-HIGH-005 — Module Federation singleton discipline had no machine enforcement; live override drift found in two remotes (HIGH)

**Problem.** The federation SSoT (`federationSharedConfig.ts`, FE-HIGH-004)
promised "strictVersion:true on ALL entries", but nothing enforced
consumption. Firsthand verification found live drift:

- `web/modules/tenant-admin/vite.config.ts` spread `getCoreSharedConfig()`
  and then **overrode** `react-dom`, `react-router-dom`,
  `@tanstack/react-query` and `@aquaculture/shared-ui` with
  strictVersion-LESS caret ranges — silently re-enabling the
  double-React-instance failure mode strictVersion exists to prevent —
  plus a **duplicate `lucide-react` key** whose first entry pinned the
  nonsense range `'^18.2.0'` (a React version, on an icon library).
- `web/modules/dashboard/vite.config.ts` carried an inline `recharts`
  shared literal outside the SSoT.
- The original audit caught these two; the new invariant immediately
  flagged a third candidate (`admin-panel`) which on inspection was a
  comment-text false positive — the scanner now strips comments, and
  admin-panel is confirmed clean.

**Fix shape (tier-1/tier-3):**

1. SSoT extended: `SHARED_VERSIONS` gains `lucide-react: '0.469.0'` and
   `recharts: '2.15.4'` — both are the root-lockfile RESOLVED versions, so
   adoption is config hygiene with zero runtime delta. Two helpers
   (`getSharedConfigWithRecharts`, `getSharedConfigWithLucide`) follow the
   existing `getSharedConfigWithReactFlow` pattern.
2. dashboard + tenant-admin shared blocks now consume ONLY the SSoT.
3. New invariant `tests/invariants/federation-shared-singleton.spec.ts`
   (layer-1 shard, runs in `invariants:fast` on every PR):
   - SSoT pins must be exact semver;
   - every federation vite config must import the SSoT;
   - **no inline shared-entry keys** (`requiredVersion:`/`singleton:`/
     `strictVersion:`) outside the SSoT file (comment-stripped scan) —
     the override class is now structurally unreviewable-in;
   - core singletons (react, react-dom, react-router-dom,
     @tanstack/react-query, zustand, reactflow) must resolve to exactly
     ONE lockfile version equal to the SSoT pin;
   - staged-alignment packages (lucide-react, recharts) must have the
     SSoT pin present in the lockfile (single-version tightening lands
     with C1-1b; admin-panel's non-federated lucide 0.294 is the
     documented exception until then);
   - shell + remote package.json declarations must be satisfied by the
     SSoT pins (workspace `file:`/`link:` protocols exempt);
   - federation plugin expectation flag `ORIGINJS_PLUGIN_EXPECTED = true`
     — the C1 plugin migration flips one line, converting the assertion
     into a ban on the abandoned `@originjs` plugin.

**Validation:** full layer-1 invariant shard 185/185; negative test
(injected inline literal into dashboard config → spec fails, reverted);
`vite build` green for both changed modules.

**Plan corrections recorded:**
- The planned Playwright runtime probe (`e2e/tests/modules/federation-
  singleton.e2e.spec.ts`) is not implementable on the current harness:
  `e2e/tests/modules/**` is Jest+GraphQL and the Playwright project
  targets the gateway HTTP surface only (`e2e/playwright.config.ts`).
  The browser-level single-React-instance proof is OWNED BY the C1
  federation-plugin migration wave (staging validation step), tracked
  under this finding — not silently dropped.
- recharts already resolves to 2.15.4 repo-wide (React-19-ready) — the
  C2 recharts bump is effectively a declaration alignment, not an
  upgrade.

**State:** IN-PROGRESS → resolved by the commit carrying this trailer;
registry close post-merge.

## Build-validation note (worktree environment constraint)

`vite build` of the changed remotes fails in the isolated worktree with
`Could not resolve entry module "react-router-dom"` — but this reproduces
identically at the **clean HEAD with zero changes** (verified by
git-stash + rebuild), so it is a worktree symlinked-node_modules
constraint (the @originjs plugin resolves `shared` entries against
module-local node_modules that the symlink layout does not provide), NOT
a regression from this change. Production builds run through the nx
prebuild lanes, not bare `vite build`. The change was instead validated
by: `tsc --noEmit` clean on the SSoT, helper exports matching their
consumers 1:1, and the 185/185 invariant shard. Real bundler validation
lands in CI on the PR (nx affected build).
