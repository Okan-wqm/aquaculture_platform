# A per-request worktree could not run web validation in the sandbox (2026-10-06)

Owner: claude (implementation), okan (review). Deadline 2026-10-13.

## ARIA-HIGH-361

No ARIA plan has ever reached CONVERGED, so the implementer → apply gate → PR path has never run
live. A read-only pre-audit of that path was done for F-015 (hr-module leave filter), the first web
plan. It found that every web/TypeScript plan fails its own validation inside the sandbox, so no PR
can open.

Measured on this host on 2026-10-06. A real `aria-worktrees/req-*` worktree at `origin/main` was
used, with commands run through `implementation_safety.wrap_validation_in_sandbox`, the wrapper the
apply gate uses.

| Step                                                  | Before                                                                                               | After                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `vitest run` (hr-module)                              | `vitest: not found`, then EROFS on `node_modules/.vite-temp`, then `getaddrinfo EAI_AGAIN localhost` | 2 files, 11 tests pass                               |
| `tsc --noEmit -p web/modules/hr-module/tsconfig.json` | the root `tsc` was not at `<worktree>/node_modules/.bin`                                             | clean                                                |
| `npx nx affected --target=test` (LeavesPage edit)     | could not start                                                                                      | `Successfully ran target test for project hr-module` |
| `npx nx affected --target=lint`                       | could not start                                                                                      | `Successfully ran target lint for project hr-module` |

Three defects stacked on top of each other:

1. **The dependency tree was bound at the checkout's path only** (ARIA-HIGH-123). Evidence:
   `aria-kernel/aria_kernel/implementation_safety.py` `_dependency_tree_binds`.
   - The root tree links npm workspaces by relative symlinks (`@aquaculture/testing ->
../../libs/testing`, `eslint-plugin-aquaculture -> ../tools/eslint-rules`). Bound at the
     checkout's path, these resolve into the checkout's `libs/` and `tools/`. Those directories are
     hidden in the sandbox, and outside it they hold another revision.
   - Nested workspace installs (`web/modules/hr-module/node_modules/react-router-dom`, 14 more on
     the runner) did not exist in the worktree.
   - `tools/scripts/type-check-all.mjs:85` runs `<cwd>/node_modules/.bin/tsc`, which did not exist.
2. **Tools write into the tree.** Vite bundles its config into the nearest `node_modules/.vite-temp`
   and crashes with an uncaught EROFS on a read-only tree. The same happens in the shared checkout,
   which ARIA-HIGH-123 bound read-only.
3. **No loopback names without the network.** With `--unshare-net` and no `/etc/hosts`,
   `localhost` does not resolve, and vitest's startup dies.

Rule: a validation command in a per-request worktree sees the same dependency tree, at the same
relative paths, that `npm ci` gives a checkout. Writes to it stay private to the command.

Fix:

- **One layout owner.** `aria_kernel/dependency_tree.py` lists the root tree and each present
  workspace's nested tree in place, under `<worktree>/node_modules` and
  `<worktree>/<package>/node_modules`. A bind mount keeps its path, so the relative workspace links
  resolve to the worktree's own code.
- **Every spawn gets the tree.** The sandbox (`_dependency_tree_binds`) creates the empty
  mountpoints host-side and binds what that module lists. This holds whoever made the worktree:
  request drain, planner dispatch, apply_engine or worker dispatch. The mountpoints are empty
  directories, so git never shows them.
- **Tool caches.** `.vite-temp`, `.vite` and `.cache` inside each mounted tree get a private
  tmpfs. The tree itself stays read-only, so one request's writes cannot reach the next. A tool
  that writes elsewhere fails loudly with EROFS.
- **Loopback names.** With the network off, a kernel-shipped `/etc/hosts` that names only loopback
  is bound, plus an `nsswitch.conf` that consults only that file. External names still do not
  resolve (verified: `getent hosts github.com` fails inside).

Tests:

- `aria-kernel/tests/test_dependency_tree.py`: layout, plus live bwrap resolution of a workspace
  link, a nested install, the cwd-relative binary, read-only, and the write-scoped spawn. 5 of its
  8 tests fail on the ARIA-HIGH-123 binds.
- `test_git_containment.py`: the ancestor-bind test now pins both binds.

Not done here, each with a known shape:

- **Installed tree vs request lock.** The installed tree is the checkout's `npm ci`. A request
  whose `package-lock.json` differs from the checkout's validates against the checkout's
  dependencies, as the shared-checkout path already did. On the runner the lock matched `main` when
  measured.
- **Other path defects.** The pre-audit's other path findings (a CONVERGED plan gets one
  implementation chance; a refused PR-open leaves a pushed branch; F-015 and its duplicates are not
  closed on merge) are tracked separately. They do not stop the apply gate from passing.
