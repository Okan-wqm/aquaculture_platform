# The alarm nobody was wired to hear — 2026-08-07

## ORPHAN-MEDIUM-562 — the watchdog reports a stalled memory and freezes nothing

### What was missing

PLAN Wave 2 specifies, for a watchdog anomaly, `breaker MERGE_FROZEN + operator
notification`. The watchdog shipped with the notification half only: it files and
updates an incident issue and fails its own run. Its own body says so —
_"It reports; it does not repair."_ Nothing read that alarm, so a stalled ARIA
memory was **visible and not enforcing**.

### Why the watchdog must not freeze, and never will

Freezing writes the breaker ledger. Writing the breaker ledger requires importing
the ARIA kernel. And every failure the watchdog exists to catch is a failure of
that kernel. **A watchman that dies of the illness it watches for is not a
watchman.**

So the alarm has to be something the _merge side reads_, never something the
watchdog writes. That keeps the dependency pointing the safe way, and it is the
one part of the finding's original analysis that survives unchanged.

## The finding's own recorded fix shape was wrong

`ORPHAN-MEDIUM-562` proposed refusing in the **`aria-merge-authority` workflow**,
noting it is "already a required check". Measured, that is exactly why it cannot
be the place:

|                                                              |                                    |
| ------------------------------------------------------------ | ---------------------------------- |
| `aria-merge-authority` in `main-required-status-checks.json` | **required**                       |
| its trigger                                                  | `on: pull_request`, no path filter |

A required check that runs on every pull request and refuses while an incident is
open **blocks every human pull request in the repository — including the one
repairing the stall.** That is a deadlock, and a freeze that blocks the repair is
a freeze someone disables.

### A second deadlock, avoided by working the consequences through

The obvious reuse is the circuit breaker, and the argument for it is already
written in this repository, in the comment beside `state_integrity_gap`:

> the breaker is already the one thing `_cycle_preflight` consults […] A parallel
> "frozen" flag would be a second answer to "how does ARIA stop", and two answers
> is how they disagree.

That reasoning is right in general and wrong here. **The watchdog fires when the
`aria/state` branch tip stops advancing, and the cycle is what advances it.** A
breaker kind would stop the cycle at preflight, so the branch would never move,
the incident would never close, and the freeze would never lift.

The distinction worth keeping: the breaker is for failures the cycle recovers
from **by not acting**; this is a failure the cycle recovers from **by acting**.

## Where it actually goes

`merge_authority.merge_pr_if_ready` — the single real-merge authority, by its own
docstring. The refusal sits immediately after the profile gate, so:

- **ARIA stops merging** on state nobody can attest to;
- **the cycle keeps running**, and can publish the state that closes the incident;
- **human pull requests are untouched**.

`watchdog_freeze.py` reads the incident signature from
`.github/manifests/aria-state-watchdog.json` — the watchdog's own manifest —
rather than restating the labels. Two copies of one truth, and the copy that
drifts is always the one nobody is reading.

Two details that are load-bearing rather than decorative:

- **Fail-closed on an unreadable answer.** A transient API error must not read as
  "no incident"; that is the single wrong answer this control exists to prevent.
  `readable` is therefore explicit in the adapter's return rather than inferred
  from an empty list, so "no incidents" and "I could not ask" cannot look alike.
- **The title prefix is matched, not just the labels.** The label filter is all
  the API can do; without the prefix any issue a human tagged `aria` and
  `watchdog` would freeze ARIA's merges, and a freeze that fires on the wrong
  issue is a freeze someone turns off.

`get_open_issues` joins the `GitHubAdapter` protocol and all three
implementations, so the read goes through the kernel's one GitHub path instead of
opening a second one. The recording adapter returns `readable: false` — a profile
that never fetched cannot claim there is no incident.

## Verification

Every claim mutation-checked; each applied, run, then reverted.

| mutation                                               | result |
| ------------------------------------------------------ | ------ |
| un-wire the freeze from `merge_pr_if_ready`            | red    |
| treat an unreadable alarm as silence                   | red ×4 |
| stop refusing on an open incident                      | red    |
| drop the title-prefix match                            | red    |
| hardcode the labels instead of reading the manifest    | red ×4 |
| **add the breaker kind that would deadlock the cycle** | red    |
| **make the required check read the incident**          | red    |

The last two matter most: they are assertions of **absence**, which pass for free
unless the thing they forbid is actually introduced. Both were driven with the
deadlock in place, so the guards are known to fire rather than assumed to.

Four existing merge tests broke on the new adapter method and were fixed rather
than worked around — their fake adapter now answers the alarm. That they broke by
**refusing to merge** rather than crashing is the fail-closed path working: an
adapter that cannot answer is treated as an adapter that cannot vouch.

## What this does not do

It does not make ARIA merge safely on a stalled memory — it makes ARIA not merge.
The watchdog still only notices the two signals in its manifest (state-branch tip
age and lane success age); a stall it cannot see is a stall this freeze will not
catch either. And nothing here shortens the incident: closing it still requires
the lanes to publish, which is the operator-visible half that already worked.
