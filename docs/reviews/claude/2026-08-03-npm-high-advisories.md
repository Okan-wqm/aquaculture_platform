# Four HIGH advisories stop every merge, and one of them will not be pinned

Date: 2026-08-03
Branch: `claude/aria-w2-mission-core` (record only — no dependency change ships here)
Scope: `package.json` overrides, `package-lock.json`, `security-scan` in `ci-full.yml`

## The blockage

`security-scan` runs `npm audit --audit-level=high --omit=dev` and feeds the
required `build-status` check. Four HIGH advisories published in transitive
**production** dependencies between 16:39 and 21:48 on 2026-08-03, so the same
branch that passed the check in the afternoon failed it in the evening without
a single dependency file changing. Nothing merges until this clears.

| Package            | Vulnerable       | Advisory                                          |
| ------------------ | ---------------- | ------------------------------------------------- |
| `brace-expansion`  | `>=4.0.0 <5.0.9` | DoS via unbounded intermediate arrays             |
| `fast-uri`         | `>=3.0.0 <3.1.5` | host confusion via backslash authority introducer |
| `ip-address`       | `<=10.3.0`       | SSRF / trust-boundary bypass (3 CVEs)             |
| `socket.io-parser` | `>=4.0.0 <4.2.7` | zero-attachment memory exhaustion                 |

The `ip-address` group is the one that deserves a second look: this platform
carries an `ssrf-safe-fetch-ssot` invariant, and these advisories are precisely
about `Address4` misparsing leading-zero octets, CIDR suffixes suppressing
special-use classification, and IPv4-mapped/NAT64 misclassification — i.e. the
library that SSoT relies on can be talked out of the classification the gate
assumes.

## Three fix cleanly

The overrides block already pins three of the four; the advisories simply moved
past the floors:

- `fast-uri` `^3.1.4` → `^3.1.5`
- `ip-address` `^10.2.0` → `^10.4.0` — note the vulnerable range is `<=10.3.0`,
  so the obvious `^10.3.1` is **not** enough
- new: `socket.io-parser` `^4.2.7`

That combination also clears `nx`'s `brace-expansion` copy. Verified: highs drop
from four to one.

## The fourth will not pin, and the reason is worth recording

`node_modules/minimatch/node_modules/brace-expansion` stays at **5.0.8**.

- `minimatch@10.2.5` requests `^5.0.5`; `5.0.9` is published.
- The existing key `"minimatch@^10": { "brace-expansion": … }` is demonstrably
  the key that produced 5.0.8 from a `^5.0.8` floor — so the mechanism works.
- Raising that floor to `^5.0.9` leaves 5.0.8 in place. So does deleting
  `package-lock.json` and re-resolving from scratch.
- A version-range key (`"brace-expansion@>=4.0.0 <5.0.9"`) does not help
  either: **npm matches override keys against the spec a PARENT REQUESTS, not
  against the resolved version.** `^5.0.5` is not `>=4.0.0 <5.0.9`, so the rule
  never fires.

A blanket `"brace-expansion": "^5.0.9"` is the wrong instrument and was
rejected rather than tried-and-reverted: the tree carries safe `1.1.15`,
`2.1.1` and `2.1.2` copies under `eslint`, `glob`, `filelist` and others, and a
5.x override would major-bump every one of them to fix two.

Most likely real fix: bump `minimatch` itself, since 10.2.5 is what pulls a
vulnerable floor.

## A separate observation, deliberately not folded into the above

Lockfile regeneration is **not idempotent** with the committed state under npm
10.9.7: `--package-lock-only` yields 3076 packages, a full re-resolve 2902,
against 3407 committed.

331 of that delta is the `@turf/*` family — declared in **no** `package.json`
and imported **nowhere** in source, so npm pruning it is correct and the
committed lockfile is carrying dead weight. My first reading called that
pruning "damage"; it is not, and the correction matters because it was the
reason I initially declined to ship the override bump at all.

The remaining delta is unexplained and points at an npm version skew between
whatever generated the committed lockfile and 10.9.7. That is its own
investigation and should not ride a security patch.

## Status

Diagnosed, not fixed. The working tree was reverted clean and nothing was
pushed. This record exists so the blockage is tracked rather than rediscovered
by the next person to hit a red `security-scan`.

## Finding

- **INFRA-HIGH-104** — four HIGH production advisories block every merge; three
  pin cleanly, `brace-expansion` under `minimatch` does not. OPEN.

Owner: okan
