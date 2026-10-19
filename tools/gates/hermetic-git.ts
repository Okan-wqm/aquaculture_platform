/**
 * The environment for running git against a repository other than the one the
 * caller is in: every `GIT_*` variable dropped. This is the ONE place that owns
 * that rule (ARIA-MEDIUM-616).
 *
 * Why this module exists (2026-10-18): a git hook exports its repository to
 * every process it starts. In a linked worktree `git push` hands the pre-push
 * hook an absolute `GIT_DIR`, and `git commit` hands the pre-commit hook
 * `GIT_INDEX_FILE`. A spec that runs `git init`, `commit` or `checkout` in a
 * throwaway fixture with that environment does not touch the fixture. It acts
 * on the developer's repository. aria-doc-runtime-ssot.spec.ts spread
 * `process.env` into its fixture git env, and from the pre-push hook it
 * committed a two-file tree onto the branch being pushed, created a branch
 * `pr` and checked the worktree out to `main`. Eleven other suites had each
 * written their own copy of the filter; the twelfth forgot it.
 *
 * `tests/invariants/hermetic-git-env-ssot.spec.ts` keeps this the only place
 * the filter is spelled. `.husky/pre-push` also drops `GIT_DIR` before it runs
 * anything, so a suite that forgets this module still cannot reach the
 * repository from a push.
 */

/**
 * `base` without any `GIT_*` variable, then `extra` on top. Use `extra` for the
 * settings a fixture wants deliberately (`GIT_CONFIG_GLOBAL`, author
 * identity): they are set on purpose, never inherited.
 */
export function hermeticGitEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('GIT_'))),
    ...extra,
  };
}
