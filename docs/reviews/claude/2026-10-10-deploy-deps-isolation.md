# Deploy depended on the interactive sessions' node_modules (2026-10-10)

Owner: claude (implementation), okan (review). Deadline 2026-10-17.

## INFRA-HIGH-218

### Incident

The development deploy of main `1b64b69cb` failed at `critical_health`, and its rollback
ended in `rollback_failed`. Both health gates died the same way:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml' imported from
/var/lib/aqua/deploy/checkout/scripts/deploy/check-service-health.ts
```

`materialize_deploy_checkout` (`scripts/deploy/deploy-paths.sh`) linked
`/var/lib/aqua/deploy/checkout/node_modules` to `/var/aqua-saas/node_modules`. That link
was the ORPHAN-HIGH-250 fix for the same symptom in June. `/var/aqua-saas/node_modules`
belongs to interactive and agent sessions. A session ran `npm ci` in a worktree whose
`node_modules` was itself a symlink to that tree, so npm emptied the shared target. The
deploy's health gate then lost `js-yaml`. `rollback_and_record` runs the same gate through
the same link, so the rollback failed too. About ten other worktrees on the host still link
to `/var/aqua-saas/node_modules`, so the next session `npm ci` in any of them could have
repeated it.

Root cause: a production deploy depended on mutable state that another actor owns.

A second instance of the same class turned up while tracing the first. `droplet-up.sh` and
`post-deploy-verify.sh` sourced `deploy-paths.sh` from `${DEPLOY_SOURCE_REPO}/scripts/deploy/`.
`/var/aqua-saas` is `core.bare=true`, so the files in that directory are leftovers that git
never updates. The workflow first sources a fresh copy taken from the git object store and
materializes the checkout. `droplet-up.sh` then re-sourced the stale copy and ran the stale
materializer a second time. Changing `deploy-paths.sh` alone would therefore have been
undone on the host by its own old version, which re-creates the link.

### Fix

The deploy now owns its dependencies.

- `scripts/deploy/deploy-deps.ts` uses Node builtins only, because it runs before any
  `node_modules` exists. It installs the deploy SHA's `package-lock.json` with
  `npm ci --ignore-scripts --omit=dev --no-audit --no-fund` into
  `/var/lib/aqua/deploy/deps/<sha256(recipe + lockfile)>/node_modules`.
  - The key also covers the npm major version and the project `.npmrc`. The install input is
    read once, and the same bytes are hashed and installed.
  - The install is built in a staging directory with a deploy-owned npm cache, an empty user
    and global config, and a minimal environment (no `GHCR_TOKEN`). Every bare import of `scripts/deploy/**` must load from that directory.
    Only then is it renamed into place, and the checkout link is swapped with one
    `rename(2)`.
  - A deploy with an unchanged lockfile reuses the tree after verifying it, without npm.
  - Retention keeps the current key and the previous one, so a rollback redeploy of the
    prior SHA resolves offline. A new install first prunes down to the live key, which
    bounds the peak to two trees.
  - `--ignore-scripts` keeps the root `prepare` script (husky plus git merge-driver install)
    out of the git config that the deploy worktree shares with the source repo.
  - `--omit=dev` keeps the tree at about 1.2 GiB instead of about 1.8 GiB.
  - The deploy scripts' only third-party import is `js-yaml`, a pure-JS package with no
    install script.
- `deploy-paths.sh` defines `DEPLOY_DEPS_ROOT` once.
  - `materialize_deploy_checkout` removes any `node_modules` in the checkout that does not
    resolve into that root. On the live host this removes the old link at the first deploy
    after this change.
  - `provision_deploy_dependencies` runs the tool under an exclusive `flock`.
    `verify_deploy_dependencies` runs read-only under a shared one.
  - There is no fallback to `${DEPLOY_SOURCE_REPO}/node_modules`.
- `droplet-up.sh` sources `deploy-paths.sh` from its own pinned tree. It provisions
  dependencies after the capacity gate and before certificates, pulls and migrations. A
  failed install is recorded as `deploy_dependencies_unavailable` with
  `no_state_changed`. The rollback path runs in the same checkout, so it finds the same
  verified tree.
- `post-deploy-verify.sh` reads `deploy-paths.sh` for `TARGET_SHA` with `git show` from the
  object store, as the workflows already do (ORPHAN-211). It checks the dependency tree
  before its health gate and never installs.
- `droplet-capacity.sh` projects the install bytes on the filesystem that holds
  `DEPLOY_DEPS_ROOT`. The projection is 0 when the tree already exists. Otherwise it is
  1.5 times the last measured install, or 2 GiB on a fresh host. An unknown projection fails
  the gate (`deps_projection_unavailable`).

### Detection

- `tests/invariants/deploy-owned-dependencies.spec.ts` fails when any of these happen:
  - a deploy script or workflow links, or names, the source repo's `node_modules`;
  - a deploy script sources `deploy-paths.sh` from the source repo directory;
  - `droplet-up.sh` stops provisioning before its health gate;
  - the verifier stops checking dependencies;
  - the capacity gate stops projecting the install;
  - a deploy-script import is not a root `dependencies` entry, so `--omit=dev` would drop it;
  - a package in an import's dependency closure has an install script, which
    `--ignore-scripts` would skip.
- `tools/gates/deploy-deps.spec.ts` runs the real tool, and the real `deploy-paths.sh`
  functions over a fixture git repo, against a fake `npm`. It covers install, reuse, two-key
  retention, staging cleanup, failed and incomplete installs (the live link stays
  untouched), verify rejecting a foreign tree, and the capacity plan. It also replays the
  incident: the session tree is emptied after provisioning and the gate still loads its
  dependency.

### infra-expert review (approve-with-changes) and what was done

The review found these problems in the first version. All are fixed in this PR:

- **MEDIUM-001, staging left behind by a failed install:** the install now cleans up its
  staging directory in `finally`, and a test checks that no `.staging-*` is left after a
  failure.
- **MEDIUM-002, pre-install prune could delete the live tree:** the live key now comes from
  the checkout link itself and is always kept. History is written before the link swap.
  `slice(-0)` is no longer used. A test covers history that disagrees with the link.
- **MEDIUM-003, key not computed from the installed bytes:** the lockfile, `.npmrc` and
  `package.json` are read once. The same bytes are hashed and written to staging. Reuse
  re-hashes the key directory's own lockfile, and a test covers a tampered key directory.
- **MEDIUM-004, gates relying on a provision from much earlier:** `droplet-up.sh` provisions
  again before the main health gate and before the rollback's health gate. That run is a
  sub-second reuse when the tree is intact. `DEPLOY.md` says never to delete the linked key
  or point another tree's `node_modules` at `deps/`.
- **MEDIUM-005, imports outside `scripts/deploy` not seen:** import discovery follows
  relative imports through the checkout, and a fixture test covers a helper outside
  `scripts/deploy`. Invariants forbid computed `import()` and `createRequire` in deploy
  scripts, `node` targets outside `scripts/deploy`, and `npx` in deploy shell.
- **LOW-001, npm environment not isolated:** npm and the import check run with only PATH,
  HOME (set to staging) and proxy variables, and with empty user and global config. A test
  checks that `GHCR_TOKEN` does not reach npm.
- **LOW-002, key ignores `.npmrc` and npm version:** both are in the key now.
- **LOW-003, capacity projection not fail-closed:** a non-zero install on a filesystem that
  was not measured fails the gate (`deps_filesystem_unmeasured`), and the tool's stderr is
  kept.
- **LOW-004, lock released before the health gate:** the verifier holds a shared lock from
  the dependency check through its health gate.
- **LOW-005, lock timeout indistinguishable from failure:** a lock timeout exits 75 with its
  own message. The import check times out after 60 s. A missing root is a clean error.
- **LOW-006, verifying an older SHA:** that now fails with a clear message, not exit 127.
- **LOW-007, capacity projection untested:** the capacity harness runs the gate with the
  dependency projection pushing free space below the reserve, and with an unavailable
  projection. The du-timeout gate tests pin `DEPLOY_PROJECTED_DEPS_BYTES`.

The review also found problems that this PR does not fix. Each is tracked:

- **INFRA-HIGH-220** (owner okan, deadline 2026-10-24): three workflow lanes re-pin the
  shared deploy checkout without a host lock, and they share
  `/var/lib/aqua/deploy/deploy-paths.sh`. This predates this PR and needs a host-wide lock
  across workflows. Wiring the control plane (INFRA-HIGH-152) also fixes it. The
  `deploy-paths.sh` part of LOW-006 is included there.
- **INFRA-MEDIUM-219** (owner okan, deadline 2026-10-31): `.env` and `certs/` still default
  to `/var/aqua-saas`. This predates this PR. Moving them requires a migration of the
  secrets.
- **MEDIUM-006, size of the install:** the deploy installs the monorepo's whole production
  dependency set, about 1.2 GiB, to get js-yaml. This PR does that on purpose: it makes the
  deploy own its dependencies without changing how the gates are built. The leaner way is a
  CI-built, hash-pinned `.mjs` bundle of the gates. `production-host-control-plane.sh`
  already ships such bundles, and it becomes the authority when INFRA-HIGH-152 wires it in.
  When that happens, this tree, its retention and its capacity projection should be
  removed in that same change.

### Not changed

- `production-host-control-plane.sh` ships esbuild-bundled `runtime/*.mjs` health gates. That
  path is not wired into the deploy lane (INFRA-HIGH-152), and this change does not touch it.
- Existing worktrees that link to `/var/aqua-saas/node_modules` are interactive-session
  hygiene and are outside the deploy's dependency path now. Nothing here removes them.
