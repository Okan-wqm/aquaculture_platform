# Dependabot PRs never go green — 2026-09-29

Seventeen Dependabot PRs were open and none had merged in the last hundred
closed PRs. Four (#1447, #1448, #1449, #1674 — GitHub Actions bumps) were
green and only waiting for a merge. The other thirteen were read job by job.

| PRs                                          | Failing jobs                            | Cause                                                     |
| -------------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| npm: #1433–#1435, #1440, #1442, #1444, #1685 | `banned-phrase-gate`, `validate-closes` | format-scope lockfile digest (INFRA-HIGH-192)             |
| cargo: #1438, #1439, #1441, #1686            | sens `lint`, `build`, `test`            | toolchain-manifest lockfile digest (INFRA-HIGH-192)       |
| #1446 (download-artifact)                    | `aria-doc-runtime-ssot`                 | touches `aria-*.yml`; ARIA authority hash moves by design |
| #1436 (@apollo/gateway)                      | `dependency-review`                     | pulls `@opentelemetry/core@1.30.1` (GHSA-8988-4f7v-96qf)  |

The PRs opened on 2026-09-06 also carry `finding-registry-closure-drift` from
main's own state on that day. That red belongs to main at the time, not to
the bumps, and a rebase clears it.

## INFRA-HIGH-192 — derived manifests pin lockfile bytes

`tools/quality/quality.mjs` generates two committed manifests and fails CI
when a fresh build differs from the committed one:

- `format-scope.json` classified every `package-lock.json` as `generated`
  (`source_of_truth: generator`) and still stored its `content_sha256`.
- `rust-toolchain-manifest.json` (`authority: rust-toolchain.toml`) stored
  `cargo_lock_sha256`.

A dependency bot rewrites the lockfile and cannot rerun `quality.mjs`. So
every npm bump failed with `tools/quality/format-scope.json is stale;
regenerate it` (PR #1685), and every cargo bump failed sens lint/build/test
with `tools/quality/rust-toolchain-manifest.json is stale; regenerate it` (in
PR #1686).

Neither digest was a control. Apart from `checkManifest`'s equality test,
nothing reads either one, and the only remedy that test offers is to
regenerate, which recomputes the digest. Each generated file already has an
authority that is gated where it runs: `npm ci`, `cargo --locked`, the
eslint-rules `dist/` rebuild-and-diff, and the admin OpenAPI parity spec.

This had an effect beyond the red PRs. Security bumps could not land, so new
advisories piled up, and `npm-audit-gate` then went red on main itself.

**Fix.**

- `excluded()` keeps `content_sha256` only for `committed_hash` classes
  (archive and runtime evidence). Those bytes are the authority, nothing
  regenerates them, and a changed pin in review is the signal that evidence
  was edited.
- `buildRustManifest()` drops `cargo_lock_sha256`.
- `tools/gates/lockfile-bump-manifest-stability.spec.ts` runs the real
  generator in a throwaway repository. It rewrites every lockfile and
  generated artifact, and it requires both manifests to stay byte-identical.
  It also requires that an archive edit and a toolchain change still move them.
