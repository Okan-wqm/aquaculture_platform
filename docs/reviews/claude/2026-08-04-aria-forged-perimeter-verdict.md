# The perimeter's verdict could be forged in one line

Date: 2026-08-04
Branch: `claude/aria-forged-perimeter-verdict`
Scope: `aria_kernel/implementation_safety.py`

## What was wrong

`HardFailReport` is the verdict of the 17-check `GATE_PRE_PR_OPEN` /
`GATE_PRE_MERGE` perimeter. ORPHAN-CRITICAL-428 gave it an opaque construction
token so only the registry that ran the checks could produce one, and its
docstring states the property as settled:

> constructed only by `run_hard_fail_checks`, so a caller cannot assemble a
> passing report by hand

and calls hand-assembly _"impossible rather than merely discouraged"_.

**Nothing ever read the token back.** Both producers pass `_REPORT_TOKEN`; the
field defaults to `None`; no code compares it. Verified by running it rather
than by reading it:

```python
forged = HardFailReport(results=(HardFailResult("no_force_push", True, "ok"),))
forged.passed            # True
forged.raise_if_blocked()  # returns silently
```

One line, and the whole perimeter is bypassed — not by defeating a check, but
by never running one. `PerimeterObservation` had the identical hole.

The severity is in the claim, not just the code. A comment asserting a
structural guarantee is load-bearing here: reviewers of every later change to
this file have been reading "impossible" and reasoning from it.

## The fix

`_require_registry_token` in `__post_init__` on both types. The token is
compared by **identity**, not equality — an `object()` sentinel compared with
`==` is identity anyway today, but writing `!=` invites a later `__eq__` on
some wrapper type to make the guard true by accident.

`ForgedVerdict` is its own exception class rather than a `ValueError` so an
audit can grep for it: a forged verdict is not a programming slip, it is the
perimeter being bypassed without a check being defeated. The message names the
producer that should have built it, so the refusal tells the next caller what
to do instead.

`PerimeterObservation` gets the same guard even though it authorises nothing.
It cannot bypass a gate, but it CAN feed a fabricated telemetry record into the
governance ledger the autonomy ladder counts. Evidence has to be produced by
the thing that observed, for the same reason a verdict does.

Blast radius is nil: `grep` finds exactly two construction sites in the repo,
both the legitimate producers.

## The math-doc rule, pinned while I was here

The "ARIA Matematiksel Karar" document proposed an invariant that no score may
bypass a hard gate, noting it was _probably already true and unpinned_. It is
true — `HardFailReport.passed` is `bool(self.results) and not self.failures`, a
plain conjunction — and unpinned is the state in which properties quietly stop
being true. Three tests now hold it: the verdict property contains no
comparison and no numeric constant, the failure set is selected by the boolean
rather than by a rank, and no registered check's source reads a
confidence/score/probability/likelihood/weight name to decide. The wrong
version of this is one `if score > threshold` away and reads as reasonable.

## What the same document got wrong, checked rather than assumed

Two of its other three "cheap adoptions" are already implemented, better than
its framing:

- **Evidence independence** — `independence_check.py` runs three layers
  (agent-id disjointness via `claims.jsonl`, `revision_id` distinctness,
  Jaccard 3-gram diversity at a 0.85 ceiling), and ORPHAN-HIGH-421 already took
  them from non-functional to live. `human_required_adjudication` calls it and
  fails closed with `panel_not_independent`. Building a second independence
  system would be the parallel-machinery mistake this programme exists to undo.
- **INCONCLUSIVE as a first-class verdict** — implemented in two places
  already: `insufficient_evidence` blocks a panel rather than abstaining, and
  `PerimeterVerdict.evaluable=False` (`NOT_EVALUABLE_AT_THIS_STAGE`)
  distinguishes "the stage could not supply the inputs" from "the inputs were
  there and the check refused".

**Correction — there is no residue, and the first version of this section said
there was.** An earlier draft (and ORPHAN-CRITICAL-546's registry note, which
is hash-chained and therefore carries the mistaken formulation permanently)
claimed belief `support_count` counts two refs from the same file or the same
tool run as two supports. Reading `memory.py` rather than asserting from the
math doc's framing:

- `_evidence_hashes` returns a **set** of file content hashes, so N refs into
  one file — and two different tools reporting the same file — collapse to one
  hash. That IS the independence rule, applied at content identity rather than
  at ref count, which is the level where it means something.
- `support_count` increments **at most once per cycle**, and only when that set
  changes. The number of refs never enters the arithmetic.
- `support_term` is `min(0.05, support_count * 0.005)` — repetition's entire
  possible contribution is **+0.05**, reached at ten observations and bounded
  there forever.

So the math document's evidence-independence item is fully covered, not
partially. Recording this correction rather than leaving the earlier claim
standing matters because the wrong version sends the next reader to build a
deduplication layer the set already provides.

## Verification

`aria-kernel/tests/test_hard_fail_report_unforgeable.py` — 12 tests, written
before the fix, and the first of them reproduced the forgery against unmodified
code.

**Mutation-checked seven ways, all killed:**

| Mutation                                          | Result   |
| ------------------------------------------------- | -------- |
| the report token guard is removed                 | 5 fail   |
| the observation token guard is removed            | 1 fail   |
| the token check accepts any non-None token        | 6 fail   |
| the token check compares by equality not identity | 5 fail   |
| `ForgedVerdict` becomes a differently-named error | 6 errors |
| the refusal stops naming the producer             | 1 fail   |
| the gate verdict becomes a threshold              | 1 fail   |

Kernel suite 3242 OK; `invariants:fast` green; run **sequentially**.

## Findings

- **ORPHAN-CRITICAL-546** (new) — the perimeter's verdict type could be
  constructed by hand, so a passing report was forgeable and
  ORPHAN-CRITICAL-428's stated closure was not enforced. CLOSED here. Its
  registry note ends with a claim about belief `support_count` that the
  correction above retracts; the note is hash-chained and cannot be edited, so
  this document is the authority on that point.

Owner: okan
