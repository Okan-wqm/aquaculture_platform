# A required check that a stranger's load balancer can fail

Date: 2026-08-03
Branch: `claude/aria-ci-helm-dependency`
Scope: `.github/actions/helm-dependency-update/`, `ci-affected.yml`,
`infra-helm-lint.yml`

## What happened

PR #1056 — a change to ARIA's belief-confidence arithmetic, touching no
infrastructure whatsoever — could not merge. `aria-kernel`, `unittest`,
`invariants-fast`, `validate-closes`, `banned-phrase-gate`,
`security-scan`, `license-check` and `dependency-review` were all green on
the same SHA. `pre-flight` was red, and `build-status` — which branch
protection requires — depends on it, so it never ran at all.

The red came from one line:

```
Save error occurred:  could not find : chart postgresql not found in
https://charts.bitnami.com/bitnami: ... Get ".../index.yaml":
read tcp 10.1.0.247:41804->13.225.47.67:443: read: connection reset by peer
```

A TCP reset from a third-party CDN, mid-fetch, roughly two seconds into a
chart download. Nothing in the repository was wrong. Every pull request in
flight at that moment was blocked by an outage nobody involved could see
or influence.

## Why it could happen at all

`charts/` is not committed — Chart.yaml is the SSoT for the postgresql /
redis / nats subchart versions, and Helm treats `charts/` as build output.
So every renderer has to fetch. Two workflows do:

- `ci-affected.yml` Phase A4, feeding `helm template`, on the job path
  `build-status` requires;
- `infra-helm-lint.yml`, feeding the `helm lint` matrix.

Both spelled it as their own hand-written `run:` line, once, with no
tolerance for the registry being briefly unreachable. **A single-shot
network fetch inside a merge gate is a coin flip the gate has to win every
time.**

And recovery was not what it looks like. The obvious answer — re-run the
failed job — is unavailable: this token cannot `POST
/actions/runs/{id}/rerun-failed-jobs` (403). The only way to make CI try
again was to push an unrelated commit to the pull request, which is what
#1056 has in its history.

## The fix, and the one that was not taken

One composite action, used by both callsites, that retries with backoff:
three attempts, 5s then 10s. A transient survives; a real failure does
not — a missing chart, a bad version pin or a removed repository fails
identically on all three and the step still fails, with the resolver's own
stderr intact above the final error.

**Bounded, on purpose.** An unbounded retry against a registry that is
genuinely down does not turn red; it burns the job's timeout and then says
the same thing much later. Retry buys time against transience; it must not
become a way to never fail.

**Never silent.** Each retry emits a `::warning::`, and so does an eventual
success ("succeeded on attempt 2/3"). A retry that leaves no trace turns a
degrading dependency into one that looks healthy, and the first anyone
would hear of it is the day it exhausts the attempts. Counting warnings is
how "flaky" becomes a number.

**Why one file.** The two callsites were two hand-written copies of one
command, so a property added to one would not reach the other. That is
precisely the drift `aria-single-restore-path.spec.ts` exists to prevent
for the state artifact, where ORPHAN-CRITICAL-484's fix landed on the
consumer lane and never reached the producer — the lane that mints the
whole queue.

**Not taken, and worth naming rather than leaving implied:** vendoring the
resolved `.tgz` archives into the repository would remove the network from
CI entirely, which is structurally stronger than retrying. It is not done
here because it inverts a convention this chart states explicitly
(Chart.yaml is the SSoT; `charts/` is build output, not source), and
committed archives that no longer match their pinned versions are a drift
surface whose only detector is fetching from the network. That trade is an
infrastructure-ownership decision with an ADR's weight, not a side effect
of unblocking a merge queue.

## The test runs the script; it does not read it

The retry lives in `resolve.sh` rather than inline in the action's `run:`
block for one reason: inline, the only available assertion is that the
words "attempt" and "sleep" appear in the YAML — which a loop that never
increments its counter also satisfies.

As a script it runs against a stub `helm` that fails a configured number
of times and then succeeds, and the tests count invocations:

- one failure then success → exit 0, **2** calls, both warnings present;
- first attempt succeeds → exit 0, **1** call, no warning;
- always fails → exit 1, exactly **3** calls;
- `ATTEMPTS=5` → exactly **5** calls (the bound is configuration, not a
  constant in disguise);
- `ATTEMPTS=0` → refuses, **0** calls — succeeding by never asking is the
  one outcome worse than either failing or retrying;
- missing Chart.yaml → refuses, **0** calls.

### Two things the first draft got wrong

Both recorded because a test suite's value is in what it _cannot_ pass.

**The gate matched documentation instead of behaviour, twice.** Its first
run reported three implementations where there is one — the callsites'
comments and the action's header all quote the command they describe. With
comments stripped it still reported two: the survivor was the step's own
`name:`, `Phase A4 — helm dependency update (…)`, a label GitHub renders
and never executes. A gate that fails on accurate documentation gets the
documentation deleted or the step renamed to something less true, which is
worse than the drift it was built to catch. Comments _and_ labels are now
stripped before matching.

**A mutation survived, and the test was the thing at fault.** Deleting the
success notice left the tests green, because the assertion was
`output).toContain('::warning::')` — satisfied by the _retry_ notice, which
is a different message carrying different information. The test's name
claimed more than its body checked. Both messages are now pinned by
content, and the mutation fails.

## Mutation results

Six mutations, each reverted individually:

| Mutation                                         | Result       |
| ------------------------------------------------ | ------------ |
| single-shot (retry loop removed)                 | 3 tests fail |
| off-by-one bound (`-ge` → `-gt`)                 | 2 tests fail |
| success notice deleted                           | 1 test fails |
| retry notice deleted                             | 1 test fails |
| zero-attempt guard removed                       | 1 test fails |
| `ci-affected.yml` reverts to its own `run:` line | 2 tests fail |

## Finding

- **ORPHAN-HIGH-538** — a required merge gate whose success depended on a
  live third-party chart registry being reachable at that instant, in two
  hand-copied callsites, with job re-run unavailable to the token.
  CLOSED here.

Owner: okan
