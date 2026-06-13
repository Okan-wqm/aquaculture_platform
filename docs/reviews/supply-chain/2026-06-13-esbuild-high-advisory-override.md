# esbuild HIGH advisory — surgical override (2026-06-13)

## SEC-HIGH-011 — fresh esbuild HIGH advisory failed security-audit on every PR

**Severity:** HIGH · **Layer:** supply-chain / CI · **Owner:** supply-chain-auditor
**Cycle:** 2026-06-10-round3

### Observation
`npm audit --audit-level=high --omit=dev` (the `security-audit` CI job) began failing on
**every** PR around 2026-06-13. Three HIGH advisories, all rooted in **esbuild** (installed
0.27.2 / 0.27.4) and pulled transitively by `vite@7.3.2` and `tsx@4.21.0`:

- **GHSA-gv7w-rqvm-qjhr** — esbuild: missing binary integrity verification in the Deno module
  enables RCE via `NPM_CONFIG_REGISTRY`.
- **GHSA-g7r4-m6w7-qqqr** — esbuild: arbitrary file read when running the development server.

Time-emergent, NOT code-introduced: PR #411 (B2) passed `security-audit` ~2 hours before the
first failure, and no PR since changed `package.json` / `package-lock.json`. The advisory was
published into the existing dependency graph. `merge-gate` `needs: [security-audit]`, so this
blocked the entire Round-3 merge train.

### Fix (surgical override — operator decision)
Pin esbuild to the patched line via root `package.json` `overrides`:

```json
"esbuild": "^0.28.1"
```

Affected range is `0.17.0 - 0.28.0`; esbuild **0.28.1** is the patched release. The override
forces every transitive esbuild (under vite, tsx, nx, etc.) to `>=0.28.1 <0.29.0`. This is the
surgical alternative to npm's suggested `vite@8.0.16` **major** bump, which would risk breaking
the Module-Federation microfrontends. esbuild 0.27→0.28 is a minor bump; vite 7.3.2 + tsx 4.21.0
resolved against it with no `ERESOLVE` peer conflict.

### Verification
- `npm install --package-lock-only` → lockfile resolves esbuild to **0.28.1** everywhere
  (no version `<=0.28.0` remains).
- `npm audit --audit-level=high --omit=dev` → **exit 0**, HIGH=0 CRITICAL=0 (22 moderate remain,
  below the gate threshold).
- Build compatibility (vite 7.3.2 / nx / tsx ↔ esbuild 0.28.1) is verified by the GitHub CI
  build + frontend + farm-water-chemistry-e2e jobs — the authoritative environment with a full
  `npm ci`. If CI build regresses, root-cause (compatible pin) rather than silence.

### Why override, not vite@8
`vite@8` is a semver-major frontend toolchain change with a wide blast radius across all
Module-Federation MFEs; it warrants its own deliberate upgrade + regression pass, not a
security-hotfix rush. The override closes the HIGH advisory now with a minor esbuild bump and
leaves the vite-major upgrade as separate, planned work.

### Tier
Tier-1 (make-it-impossible): the override structurally pins esbuild out of the vulnerable
range for the whole workspace; `security-audit` re-enforces it on every future PR.
