# Twin-lite gets a keeper and a reader — 2026-08-06

## ORPHAN-MEDIUM-571 — a map nothing refreshed and nothing read

### What shipped, and what was missing

PR #1104 landed `twin.py` plus four CLI verbs: `twin build`, `twin refresh`,
`twin status`, `twin context`. Nothing else. So:

- **No cycle phase refreshed the map.** It was as fresh as the last time a
  human ran a command. A map consulted about a tree it no longer describes
  does not fail — it answers confidently about the past.
- **No caller read `twin_context_for_files`.** The compact per-file slice the
  module exists to produce reached nobody.

The operator's request was literal: ARIA should work from a map of the
repository, for token saving and for understanding. A CLI a person has to
remember to run is not that.

### Why the refresh could not land alone

Wiring only the producer would have been **worse than leaving it alone**: a
phase paying `git log` and parse cost every cycle to maintain a projection no
consumer reads is this programme's signature defect, inverted — not "written
but never called" but _"called and never read"_. So producer and reader land
together, and the suite tests that they meet.

### The plan's three named consumers, checked

PLAN Wave 3 says to port `plan_coverage`, `validation_matrix_gate` and
`pressure` onto the twin. Two do not survive inspection:

| consumer                                    | verdict                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| service examination / plan coverage         | **Duplicates an existing cache.** `cached_service_analysis_order` (`impact_graph.py:196`) already caches the project graph by fingerprint and rescans only when layout or tsconfig aliases change. A twin-backed second path is a parallel system, not a saving. |
| regression anchor (`has_regression_anchor`) | **Would change a gate's meaning.** It asks _"did this diff leave a test/fixture path"_. TESTED*BY answers *"is this code covered at all"\_. Both are legitimate; silently swapping them weakens a Gate A check.                                                  |
| `pressure` churn / co-change                | Genuinely twin-only data, and genuinely **Wave 5**. Not pulled forward.                                                                                                                                                                                          |

The consumer that holds up is the one matching the original request: the agent
envelope. It needs no gate's semantics altered and uses exactly what the map
uniquely has.

### The trust boundary, which is the load-bearing part

The invocation prompt already separates two classes:

```text
## Evidence refs (file:line entries; the ONLY admissible evidence)
## Impact graph refs
```

The twin map is **derived** data — every byte recomputable from the repo at
`indexed_sha`. It is orientation, never proof. So it renders in its own
section beside the impact graph, labelled _"a projection, **not evidence**.
Use it to orient; cite only evidence_refs"_, and it never enters `evidence_refs`.
A model told to cite only evidence, and handed a projection in the same
prompt, has to be told which is which.

### What landed

| piece                       | where                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `twin_refresh` phase        | `cycle.py` — discovery stage, `standard` + `burn_in`, `record_and_continue`                     |
| `_repository_map_for_refs`  | `agent_invocations.py` — the producer; slices the map for the files an `evidence_ref` points at |
| `## Repository map` section | `agent_invocations.py` — the reader                                                             |
| `repository_map` type check | `agent_contract.py`                                                                             |

Three choices worth stating:

1. **`record_and_continue`, not `propagate`.** A refresh that crashed leaves a
   stale map — a degraded read for one consumer, not a reason to end a cycle
   whose real work succeeded. The failure is still an outcome row and
   `twin_status` reports `fresh: false`, so "the map is old" and "the map is
   current" stay distinguishable.
2. **`burn_in` too.** The map is a declared _observation_ surface touching no
   claim, tool or PR surface, so it does not weaken the observe lane's
   no-action claim; and the observe lane's output is the acceptance evidence
   the ladder counts, which must not be judged against a map frozen at some
   past commit.
3. **Absent, not empty.** `_repository_map_for_refs` returns `None` rather
   than an empty projection, and the renderer emits nothing for a map with no
   files. An empty section asserts _"the map knows nothing about these
   files"_, which is a stronger and different claim from _"no map was
   attached"_.

### Verification

New suite `aria-kernel/tests/test_twin_cycle_wiring.py`, 16 tests, red before
(the phase did not exist), green after. Mutation checks, each applied then
reverted:

| mutation                                                | result                       |
| ------------------------------------------------------- | ---------------------------- |
| drop the `twin_refresh` row from `CYCLE_PHASES`         | 3 red                        |
| full rebuild every cycle instead of incremental refresh | 3 red                        |
| drop `burn_in` from the phase modes                     | red                          |
| drop the "not evidence" label from the map header       | red                          |
| map file paths leak into the evidence bullet list       | red                          |
| minting never attaches the map (the loop breaks)        | red                          |
| drop the `repository_map` type check                    | red                          |
| emit the section for a map with no files                | red _(after the test below)_ |

**Two tests passed for the wrong reason and were corrected:**

- _"no map means no section"_ covered only the **absent** case, which the
  `isinstance` guard catches first. A map dict with an empty file list still
  printed a heading over nothing, and the mutation stayed green until a test
  for that case existed.
- _"the map never enters the evidence section"_ sliced the prompt at the next
  `##` heading, so **relocating the map block changed nothing** — the test
  never tested its own name. Re-run with the mutation that actually matters
  (map paths appended into the evidence bullets) it goes red, so the property
  is pinned. The relocation mutation staying green is correct rather than a
  gap: with its own heading the map is a labelled section wherever it sits.

Suites: `aria:test:unit` and `invariants:fast`, sequentially, on the merged
tree.

---

## ORPHAN-MEDIUM-572 — a contract vocabulary nothing reads, and that no longer matches

Adding `repository_map` to `REQUEST_OPTIONAL_FIELDS` would have been the
appearance of a contract without one. Measured:

- A repo-wide search for `REQUEST_OPTIONAL_FIELDS` returns **exactly one hit**
  — its own definition at `agent_contract.py:57`. `validate_request` checks
  only `REQUEST_REQUIRED_FIELDS` for absence; unknown fields pass silently.
- The tuple is also **inaccurate**, which is what makes it misleading rather
  than merely inert. It declares 18 fields;
  `create_agent_invocation_request` accepts and persists at least
  `finding_id`, `convergence_id`, `tool_id`, `run_id`, `eval_harness_id`,
  `fixture_run_id`, `judgment_group_id`, `transcript_hash`,
  `operator_provenance_ref`, `plan_revision_hash`, `pressure_source_type`,
  `shadow_eval`, `target_sha` — none of them declared.

So the naive fix (reject anything outside required ∪ optional) would **refuse
real envelopes the live minter produces**. The root-cause fix is two-part:
enumerate the true field set from the minter, complete the tuple, and only
then make `validate_request` enforce it. That can break the live path and
needs its own blast-radius check, so it is tracked with an owner and a
deadline rather than bolted onto this change.

`repository_map` therefore got an explicit type check in `validate_request` —
the same treatment `impact_graph_refs` actually receives, which is itself
evidence the tuple has been decorative for some time.
