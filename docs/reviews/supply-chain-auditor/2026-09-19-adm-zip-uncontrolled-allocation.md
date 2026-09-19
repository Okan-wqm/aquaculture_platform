# Supply-chain review — 2026-09-19: adm-zip 0.6.0 behind an exact transitive pin

- Date: 2026-09-19
- Owner: `okan`
- Trigger: `security-audit` went red on PR #1599 (run 35431475573) whose
  lockfile change was the removal of `konsta`; the advisory was published
  after the PR opened and `main` is exposed identically
- Method: every claim executed against `scripts/ci/npm-audit-gate.mjs`

## SUPPLY-HIGH-013 — adm-zip 0.6.0 reaches the root-full leg through @module-federation/vite

The root-full leg (`--audit-level=high`, dev dependencies included) reported
three entries with no reviewed exception:

| package                 | advisory                                   | npm's remedy                            |
| ----------------------- | ------------------------------------------ | --------------------------------------- |
| adm-zip                 | GHSA-7q85-xj36-vmfc, GHSA-vwc7-r8mq-g2x9   | `@module-federation/vite@1.9.4` (major) |
| @nx/react               | GHSA-7q85-xj36-vmfc                        | `@nx/react@20.1.4` (major)              |
| @nx/module-federation   | GHSA-7q85-xj36-vmfc                        | `@nx/react@20.1.4` (major)              |

Only the first is a root advisory. GHSA-7q85-xj36-vmfc is adm-zip's
uncontrolled memory allocation from the declared uncompressed size (a DoS on
extraction), ranged `<0.6.1`; GHSA-vwc7-r8mq-g2x9 is its extraction following
destination symlinks, ranged `>=0.5.9 <=0.6.0`. The two `@nx/*` rows are
attributions: `@module-federation/enhanced` and `@module-federation/node`
depend on adm-zip, `@nx/module-federation` depends on them, `@nx/react` on it.

adm-zip reaches the tree once:

```text
@aquaculture/admin-panel -> @module-federation/vite@1.20.8
  -> @module-federation/dts-plugin@2.8.2 -> adm-zip@0.6.0
```

`dts-plugin` declares `adm-zip` as an exact `0.6.0`, so no range in the tree
can move it; npm's `fixAvailable` therefore names the only direct dependency it
can express, a SemVer-major downgrade of `@module-federation/vite` (and of
`@nx/react` for the attributions). The patched `0.6.1` sits in the same minor.

### Fix

A root `overrides` entry, `"adm-zip": "^0.6.1"`, is the one mechanism that
reaches an exact transitive pin. The lockfile regenerated with
`npm install --package-lock-only --ignore-scripts` moves exactly one package
(`adm-zip` 0.6.0 → 0.6.1, three lines). After it:

```text
[npm-audit-gate] root-full: clean at --audit-level=high (15 reviewed exception(s))
[npm-audit-gate] root-production: clean at --audit-level=moderate
```

The fifteen remaining exceptions are the nx toolchain rows of
`SUPPLY-HIGH-011` and `SUPPLY-HIGH-012`, unchanged by this review. No exception
was added: the gate's own rule is that an advisory with a non-breaking fix is
fixed, never excepted.

### What did not change

The production legs (`root-production`, `aquamobil-*`, `e2e-*`) were clean
before and after; adm-zip is a build-time dependency of the Module Federation
type-declaration plugin and ships in no bundle.
