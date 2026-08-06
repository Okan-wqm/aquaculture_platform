# A pinned transitive dependency held the whole merge pipeline — 2026-08-06

## INFRA-HIGH-105 — `js-yaml` CVE-2026-59870 blocks every merge

### What failed

`security-scan` on #1110 exited 1 at 23:04:17Z, on the exact command CI runs:

```bash
npm audit --audit-level=high --omit=dev
```

Two HIGH production advisories, one root cause:

| package           | detail                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `js-yaml`         | `GHSA-5p4m-2wfm-xmqj` — quadratic CPU consumption in `!!omap` resolution. Vulnerable `>=4.0.0 <4.3.1`; the CVE-2026-59870 fix was not backported |
| `@nestjs/swagger` | flagged only as the effect of the above                                                                                                          |

### It is not this PR's doing

#1110 changes Python, docs and `tools/` — **no `package.json`, no `package-lock.json`**
(`git diff --name-only origin/main...` confirms it). The advisory was published
against a dependency tree that `main` already carries, so `main` fails the same
gate. This blocks every merge in the repository, exactly as `INFRA-HIGH-104` did
on 2026-08-04.

### Why the obvious fix was not enough

`js-yaml` is a direct production dependency at `^4.3.0`, so bumping it to `^4.3.1`
moves the root copy. That alone leaves the gate red:

```text
node_modules/js-yaml                          -> 4.3.1
node_modules/@nestjs/swagger/node_modules/js-yaml -> 4.3.0   <- still vulnerable
```

`@nestjs/swagger@11.4.5` **pins `js-yaml: 4.3.0` exactly**, not a range, so npm
keeps a nested copy no root bump can reach.

### The fix, and the check that it is not decorative

A scoped override, matching the style the repository already uses for `typeorm`
and `@apollo/*`:

```json
"@nestjs/swagger": { "js-yaml": "^4.3.1" }
```

**The override was tested for load-bearingness rather than assumed.** Removed it,
re-resolved, and npm put `node_modules/@nestjs/swagger/node_modules/js-yaml@4.3.0`
straight back with the audit failing again; restored it, and the nested entry
stays gone with the audit at 0. A line that would have been cargo-cult if the
root bump had sufficed is a line that is doing the work.

Verified with the exact command CI runs (`npm audit --audit-level=high --omit=dev`,
exit 0), re-run after a fresh `npm install --package-lock-only` to confirm the
resolution is durable and not an artifact of one lockfile edit. Total diff: 7
lines of `package.json`, 8 of `package-lock.json`.

`3.14.2` remains under `@istanbuljs/load-nyc-config`; it is a **dev** dependency,
outside `--omit=dev`, and out of this finding's scope.
