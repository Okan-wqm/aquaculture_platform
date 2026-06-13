# C1 PR-1a — Module Federation plugin migration (@originjs → @module-federation/vite)

**Date:** 2026-06-13
**Agent:** frontend-expert (lead-verified; per-file migration fanned out via workflow)
**Wave:** C1 (S3). Track C — Frontend Modernization.
**Branch:** `remediation/c1-federation-plugin`

---

## FE-MEDIUM-006 — Module Federation runs on the dormant `@originjs/vite-plugin-federation`; migrate to the maintained `@module-federation/vite`

**Problem.** The web shell + 7 remotes federate via `@originjs/vite-plugin-federation@^1.3.5`,
a community plugin in maintenance mode. The official, maintained line is
`@module-federation/vite` (the Module Federation org's first-party Vite plugin),
which the C0 wave (FE-HIGH-005) already scaffolded an invariant flag for
(`ORIGINJS_PLUGIN_EXPECTED`, designed to flip from "require @originjs" to "ban
@originjs" when C1 lands).

## C1 PR-1a (this PR) — plugin swap (PR-1b version alignment is separate)

- **Dependency:** `@originjs/vite-plugin-federation@^1.3.5` → `@module-federation/vite@^1.16.7`
  across all 8 web `package.json` (shell + 7 modules); lockfile regenerated.
- **8 vite.config.ts migrated:**
  - Import: `import federation from '@originjs/vite-plugin-federation'` (default) →
    `import { federation } from '@module-federation/vite'` (named export).
  - HOST (`web/shell`): the `remotes` map changed from string URLs to the object
    form — `dashboard: { type: 'module', name: 'dashboard', entry: '${remoteBase}/dashboard/remoteEntry.js' }`
    — with the `/assets/` path segment **dropped** (the plugin emits `remoteEntry.js`
    to `dist/` root, not `dist/assets/`). `remoteBase` + per-remote path prefixes are
    unchanged, so the nginx path-prefix proxy is untouched.
  - REMOTES (7): only the import line changed; `name`, `filename`, `exposes`, `shared`,
    `build`, `resolve.alias`, `server`, `test` are byte-identical.
- **SSoT untouched:** `federationSharedConfig.ts` uses its own structural
  `SharedDepConfig` (no @originjs type import); its `Record<string, SharedDepConfig>`
  is structurally compatible with the plugin's `shared` field. `strictVersion:true` +
  `singleton:true` on every entry are preserved (FE-HIGH-004).
- **C0 invariant flipped to enforcing:** `ORIGINJS_PLUGIN_EXPECTED = false` in
  `federation-shared-singleton.spec.ts` — every federation vite config must now NOT
  contain `@originjs`; the ban is live.
- Stale `@originjs` doc-comment reference in `remoteIntegrity.ts` (SH-SEC-04) updated.

### Validation
- **C0 `federation-shared-singleton.spec.ts` PASSES locally** (file-grep based, so
  verifiable without the new plugin installed): all 8 configs dropped @originjs +
  the `SHARED_VERSIONS` pins hold + no SSoT-bypassing inline `shared` literal.
- Per-file migration fanned out as a workflow (one agent per config + an independent
  adversarial verify per file) — all 8 reported clean (exact 1-line import swaps for
  remotes; correct `{type,name,entry}` remotes for the host).
- `@module-federation/vite` is not in the worktree's shared node_modules (like
  `@nats-io` / `@nestjs/apollo`) → the Module Federation runtime build + the
  `federation-singleton` Playwright e2e (single-React proof) are delegated to GitHub CI.

## NOT done here (Track C continuation)
- **C1 PR-1b** — version alignment: TS 5.9.3 (exact, 10 web package.json), zustand 4→5
  (`useShallow` for 2nd-arg selectors), lucide-react single pin, aquamobil tailwind-merge
  2→3, remotes' react/router/query ranges pinned to the SSoT exact versions.
- **C2/C3** — React 19 (atomic federation bump) + Tailwind 4 (later waves).
