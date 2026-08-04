# npm override keys match the requested spec, not the resolved version

Date: 2026-08-04
Branch: `claude/aria-dep-audit-highs`
Scope: `package.json` overrides, `package-lock.json`
Closes: INFRA-HIGH-104 (registered 2026-08-03 with the diagnosis, fixed here)

## The blockage

`security-scan` runs `npm audit --audit-level=high --omit=dev` and feeds the
required `build-status` check, so four HIGH advisories published in transitive
**production** dependencies on 2026-08-03 stopped every merge in the
repository — not one PR, all of them.

| Package            | Vulnerable       | Advisory                                          |
| ------------------ | ---------------- | ------------------------------------------------- |
| `brace-expansion`  | `>=4.0.0 <5.0.9` | DoS via unbounded intermediate arrays             |
| `fast-uri`         | `>=3.0.0 <3.1.5` | host confusion via backslash authority introducer |
| `ip-address`       | `<=10.3.0`       | SSRF / trust-boundary bypass (3 CVEs)             |
| `socket.io-parser` | `>=4.0.0 <4.2.7` | zero-attachment memory exhaustion                 |

The `ip-address` group deserved the closest look: this platform carries an
`ssrf-safe-fetch-ssot` invariant, and those three CVEs are about `Address4`
misparsing leading-zero octets, CIDR suffixes suppressing special-use
classification, and IPv4-mapped/NAT64 misclassification. The library that SSoT
leans on could be talked out of the classification the gate assumes. Note the
floor: the vulnerable range is `<=10.3.0`, so the obvious `^10.3.1` is **not**
enough — `^10.4.0` is.

## Why the first attempt failed, and what it taught

Three of the four lifted cleanly by raising floors already present in the
`overrides` block. `brace-expansion` under `minimatch` refused to move: 5.0.8
stayed put though 5.0.9 was published, including after deleting
`package-lock.json` and re-resolving from scratch.

Two override shapes were tried and both silently did nothing:

- `"minimatch@^10": { "brace-expansion": "^5.0.9" }` — the parent-scoped form,
  and demonstrably the key that had produced 5.0.8 from a `^5.0.8` floor.
- `"brace-expansion@>=4.0.0 <5.0.9": "^5.0.9"` — the version-scoped form,
  written to cover every vulnerable copy at once.

**The second failure is the one that explains everything.** npm matches an
override key against the range a parent _requests_, and it does so as a
range-to-range comparison rather than by testing the resolved version.
`minimatch` requests `^5.0.5`, which permits 5.9.9 — outside `<5.0.9` — so
`^5.0.5` is not a subset of the key and the rule never fires. The key looked
like it described the vulnerable versions; it actually described _which
requests to intercept_, and no parent makes a request in that shape.

The fix is to use the requested spec verbatim as the key:

```json
"brace-expansion@^5.0.5": "^5.0.9",
"brace-expansion@^5.0.1": "^5.0.9",
```

`^5.0.5` is `minimatch@10`'s request and `^5.0.1` is `nx`'s. Both now match
exactly, and both resolve to 5.0.9.

This is also why a blanket `"brace-expansion": "^5.0.9"` was rejected rather
than tried: the tree carries safe `1.1.15`, `2.1.1` and `2.1.2` copies under
`eslint`, `glob`, `filelist`, `test-exclude` and others, and a blanket rule
would major-bump every one of them to fix two.

## The lockfile shrank, and that is correct

`package-lock.json` goes from 3407 to 3079 package entries. 331 of that delta
is the `@turf/*` family, which is declared in **no** `package.json` and
imported **nowhere** in source — dead weight the committed lockfile had been
carrying. `npm ci` installs 2877 packages and succeeds.

Recorded because I got this wrong the first time: I read the shrinkage as npm
damaging the lockfile and declined to ship the override bump at all on that
basis. Checking whether `@turf` was actually a dependency — it is not — is what
turned a blocked judgement call into a two-line change.

## Verification

- `npm audit --audit-level=high --omit=dev` — exit 0, the exact command CI runs.
- `npm ci` — clean install from the regenerated lockfile.
- `npm run type-check` — 40/40 projects green.
- `npm run invariants:fast` — 2269 tests green.

## Finding

- **INFRA-HIGH-104** — four HIGH production advisories block every merge.
  CLOSED here.

Owner: okan
