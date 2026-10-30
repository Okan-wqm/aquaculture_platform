# npm lock integrity of 2026-10-29

**Owner agent:** claude · **Cycle:** 2026-10-29-npm-lock-integrity · **Branch:**
`fix/snowball-pilot-findings-registered`

`npm ci` checks every tarball it installs against the `integrity` hash the root
`package-lock.json` records for it. On 2026-10-29 the Snowball pilot's dependency
and profile checks found four root-lock entries with no hash to check.

## SUPPLY-LOW-040 — four workspace-nested lock entries carried neither resolved nor integrity

- **Where:** at origin/main 645c5313 (lockfileVersion 3), four entries had a
  `version` but no `resolved` URL and no `integrity`:
  - `libs/farm-shared/node_modules/typescript` 5.3.3 (`package-lock.json:216`);
  - `libs/node-components/node_modules/typescript` 5.3.3 (`package-lock.json:260`);
  - `mcp/farm-management/node_modules/typescript` 5.4.5 (`package-lock.json:312`);
  - `tools/eslint-rules/node_modules/@types/eslint` 8.56.12
    (`package-lock.json:41438`).
- **Pattern:** the root lock has 2940 registry entries. All four gaps are among
  the 49 workspace-nested copies (`<workspace>/node_modules/...`). None of the
  2891 hoisted `node_modules/...` entries lacks either field.
- **Effect:** `npm ci` installed these four from the registry by version alone,
  with nothing to compare the downloaded bytes against. Every other registry
  tarball in the root lock was verified.
- **Why it stayed:** a lock refresh does not repair it. On a copy of
  645c5313, `npm install --package-lock-only` (npm 10.9.9) left the lock
  byte-identical, the four gaps included. `npm ci` does not fail on a missing
  hash. No check in `tests/invariants`, `tools/gates`, `scripts` or
  `.github/workflows` requires a lock entry to carry `resolved` and
  `integrity`.

### Severity (SUPPLY-LOW-040)

LOW. All four entries are `"dev": true`: TypeScript compilers of three
workspaces and the ESLint type definitions of `tools/eslint-rules`. They run in
CI and on developer machines, and `npm ci --omit=dev` does not install them.
The registry serves the expected bytes for every one of them today: each
registry `dist.integrity` equals the sha512 of the downloaded tarball. The gap
is a missing check, with no sign that any tarball differed.

### Fix (SUPPLY-LOW-040)

- Each of the four entries gets the registry's `resolved` URL and `integrity`
  (8 lines in `package-lock.json`, no other entry changes).
- After the change, all 2940 registry entries of the root lock carry both
  fields.

### Verification (SUPPLY-LOW-040)

- For each entry, the pinned `integrity` equals the registry's
  `dist.integrity` and the sha512 of the downloaded tarball, and `resolved`
  equals the registry's `dist.tarball`.
- A scan of the lock after the change finds 0 of 2940 registry entries without
  `resolved` or `integrity`.
- `npm ci --ignore-scripts` succeeds on the changed lock, so npm now verifies
  these four tarballs too.
- A guard that keeps every lock entry's `resolved` and `integrity` is an
  operator decision outside this change.
