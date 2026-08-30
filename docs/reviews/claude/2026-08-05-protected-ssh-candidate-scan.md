# One unreadable host key kills the backup

Date: 2026-08-05
Branch: `claude/protected-ssh-candidate-scan`
Scope: `tools/scripts/ci/run-protected-ssh.sh` (candidate host-key scan),
`tests/invariants/backup-production-secrets.spec.ts`

## How this surfaced

`backup-production-secrets.spec.ts` failed on PR #1085 with **exit 141** — a
diff that touches only the ARIA kernel. 141 is `128 + 13`: SIGPIPE. The
temptation was to call it environmental and re-run. The number was pointing at
something.

## The line

```bash
candidate_fingerprint=$(
  printf '%s\n' "${candidate_key}" | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }'
)
```

One line, inside the loop that walks everything `ssh-keyscan` advertised,
under `set -euo pipefail`. It carries three defects, and the one that matters
is not the one that turned CI red.

## ORPHAN-HIGH-559

**The scan abandons itself on a key it cannot read.** `ssh-keygen -lf -`
exits non-zero on a line it cannot parse. Under `set -e` that ends the
script — mid-loop, before the remaining candidates are examined. Measured
against a host advertising an unreadable algorithm followed by the **pinned**
ed25519 key:

```text
exit 255, no message; the loop never reached the matching key
```

The backup fails, and the key that would have matched is one line below the
one that killed it. This is fail-closed but **mute**: every other failure in
this script announces itself through `die`, and this one — the only path that
can be triggered by what a remote host chooses to advertise — says nothing at
all. An operator sees a backup job that exited 255.

The trigger is foreseeable rather than exotic: the droplet's OpenSSH gets
upgraded, starts advertising an algorithm the runner's older `ssh-keygen`
does not implement, and the nightly backup stops — with a status that names
nothing.

**The semantics were simply wrong.** A candidate this build cannot parse is
**not a match**; it is not a reason to stop looking. The script already owns
the correct refusal for "nothing matched" — `did not match exactly one
advertised host key` — three lines below the loop. The fix lets that refusal
be the one that fires.

**And the pipeline was status-fragile in its own right.** `ssh-keygen -lf -`
need not drain stdin, so under `pipefail` the writer can be signalled
SIGPIPE. Measured: deterministic **141** once the advertised line exceeds the
pipe buffer, and a scheduling race below it — which is how a production-secret
invariant became a flaky red on an unrelated PR. A flaky guard is worse than a
missing one: it teaches the next reader that this file's reds are noise.

## The fix

No pipeline at all. A here-string has no writer process to signal; the status
is read by name instead of inferred by `set -e`; the fingerprint is parsed
with shell parameter expansion, so `awk` leaves both the code and the
required-command preflight (a script must not demand a tool it does not use).
An unparseable candidate is skipped with a named note on stderr.

Measured after, on the same three cases:

| case                                        | before                            | after                              |
| ------------------------------------------- | --------------------------------- | ---------------------------------- |
| unreadable algorithm, then the pinned key   | exit 255, mute, key never reached | scan completes, pinned key matches |
| advertised line larger than the pipe buffer | exit 141 (SIGPIPE)                | parsed, scan completes             |
| ordinary well-formed ed25519 key            | fingerprint parsed                | byte-identical fingerprint         |

The third row is the one that keeps the fix honest: a real `ssh-keygen -t
ed25519` key parses to exactly the same `SHA256:…` string through the new
path.

## The regression test

`skips an advertised host key it cannot parse instead of abandoning the scan`
builds the adversarial shape directly: the first advertised line is **both**
unparseable **and** oversized, so it reproduces both failure modes at once,
and the pinned key sits behind it. The fake `ssh-keygen` is faithful on the
point that matters — it refuses the bad line _without draining stdin_.

Mutation-checked: restoring the original pipeline turns the new test red
(`Expected: 0, Received: 255`). It fails for the reason it claims to.

## ORPHAN-MEDIUM-560 — the same shape, in the tool that gates this document

Verifying the fix meant running `scripts/ci/markdownlint-changed.mjs`, which
exited **1 with no output** on a clean tree. Three times in one session that
reading cost a detour, and the third time it was worth chasing:

```text
markdownlint could not be launched (ENOENT): markdownlint
```

`process.exitCode = result.status ?? 1` folds spawnSync's _launch_ failure
(status `null`, `error.code === 'ENOENT'`) into the same number as a real lint
failure. CI installs `markdownlint-cli` globally so the gate works there; any
checkout without it reports "your documents failed lint" when the truth is "no
document was checked". A gate whose failure names no reason teaches its
readers to discount it — which is how a red gets re-run instead of read.

Now it says which of the two happened, and exits `127` for the one that means
_nothing was verified_.

That this turned up in the very tool gating the review document for 559 is not
a coincidence worth dressing up: it is the same defect, and looking for it once
is what made it visible twice.

## What this is an instance of

The programme's recurring class, seen from a new angle. The usual shape is a
control that was correct while its input did not exist. This one is a control
that was correct while its input stayed _well-formed_ — the loop was written
for the advertised keys a cooperating host sends, and the failure path for
anything else was never chosen, only inherited from `set -e`.

An exit status nobody selected is not a decision. 141 and 255 both arrived
here by default.

## Findings

- **ORPHAN-HIGH-559** — an unparseable advertised host key aborts the scan
  mutely, and the pipeline that parses it can be killed by SIGPIPE. Fixed
  here; close ceremony rides the next PR (PROC-HIGH-001).
- **ORPHAN-MEDIUM-560** — the doc-lint runner reports a missing linter as a
  lint failure. Fixed here; same ceremony.

Both registered with `add-explicit` rather than the next free number: 557 and
558 are allocated to a parallel session's in-flight renumber, and taking them
would collide in the chain.

Owner: okan
