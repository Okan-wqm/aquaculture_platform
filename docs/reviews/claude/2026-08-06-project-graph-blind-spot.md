# The project graph stopped describing the repository — 2026-08-06

## ORPHAN-HIGH-569 — discovery by hardcoded directory list

### What was measured

`impact_graph._discover_projects` enumerated six parent directories: `apps`,
`libs`, `platform/libs`, `web/modules`, and the two `web` singletons. Every
project in the graph came from that list.

The list was accurate for the repository it was written against. The repository
then grew `crates/` (6 nx projects), `mcp/`, `tests/`, `tools/executors/`,
`e2e/`, `scripts/`, a Rust edge gateway, a standalone PWA under `web/apps/`,
and ARIA's own Python kernel. The list did not grow with it.

Measured on `main` at `36d5bf70`, over the distinct files touched by the last
200 commits:

|                                | files     | share   |
| ------------------------------ | --------- | ------- |
| touched, distinct              | 11,041    |         |
| **unplaceable by the graph**   | **4,282** | **38%** |
| …of those, `aria-kernel/`      | 655       |         |
| …of those, `sens-api-gateway/` | 449       |         |
| …of those, `crates/`           | 153       |         |

### Why it matters — a withheld capability, not a wrong answer

The graph is honest about not knowing. A path it cannot place lands in
`unknown_files`; `unknown_files` makes `validation_scope`
`blocked_unknown_graph` (`impact_graph.py:46`); that makes `plan_impact` return
`blocked_by: ['impact_graph_unknown']` (`impact.py:35`).

So the failure is not a false claim of safety. It is that ARIA is structurally
blocked from planning a change to 38% of its own repository — including the
kernel it edits most. Measured directly, before the fix:

```
plan_impact(changed_files=['aria-kernel/aria_kernel/ledger.py'], …)
  blocked_by       : ['impact_graph_unknown', 'operator_scope_decision_required']
  direct_projects  : []
  downstream       : []
  graph_confidence : 0.65
```

`ledger.py` is the most depended-on module in the kernel. The graph could say
nothing about it at all.

This is the programme's signature defect in its quietest form: **a control that
stayed correct only while its input stopped changing.** Nothing decayed; the
list is exactly as right as the day it was written. The repository moved.

### The fix — discover by marker, not by list

A directory is a project when it carries one of a closed set of markers:
`project.json` (nx's own SSoT), plus `package.json`, `Cargo.toml` and
`pyproject.toml` for the deliverable roots nx does not model. A project now
enters the graph the moment it acquires a marker, with no list to remember to
edit — tier 2 of the hierarchy, _make it automatic_, rather than tier 4,
document that the list needs maintaining.

Three structural rules keep the sweep honest, each pinned by a test:

1. **The workspace root is never a project.** This repository has a root
   `Cargo.toml`. A project rooted at `""` is a prefix of every path, so
   `_project_for_path` would return it for everything and the graph would claim
   total knowledge while holding none. The walk only ever considers
   `directory != root`, so the case is impossible rather than guarded.
2. **The shallower marker wins.** The walk is breadth-first and never descends
   into a directory it has already placed, so `sens-api-gateway` is a project
   and `sens-api-gateway/fuzz` is part of it rather than a sibling of it.
3. **Discovery is additive.** The conventional layout runs first and a name
   already taken is never reassigned, so no project that agent routing, the
   validation matrix or the twin already keys on can be renamed or re-rooted by
   a marker appearing beside it.

Naming: `project.json`'s declared `name` wins, because nx owns that identity and
enforces its uniqueness — filing one project under two identities in two
consumers is the failure this avoids. The other markers declare _publish_
identities (this repository's root crate publishes as `suderra-agent`), which
are not the repository's name for the directory, so those fall back to the
repo-relative path.

### Result

|                                      | before               | after                    |
| ------------------------------------ | -------------------- | ------------------------ |
| projects discovered                  | 50                   | 69                       |
| unplaceable files (last 200 commits) | 4,282 / 11,041 (38%) | 2,202 / 11,034 (**19%**) |

`aria-kernel`, `sens-api-gateway`, all six `crates/*`, `e2e`, `mcp/*`,
`scripts`, `tests/invariants`, `tests/admin-route-contract`,
`tools/executors/cargo` and `web/apps/aquamobil` are now on the map.

### What is still unplaceable, and why that is correct

The 19% that remains is `docs/` (1,332), `tools/` scripts (221),
`infrastructure/` (150), `.claude/` (147), `infra/` (122), `.github/` (81),
`database/` (25). None of these is a project — they are documentation,
configuration and CI. The graph says "I cannot place this", which is true.

That honesty still costs something: a docs-only change plans as
`impact_graph_unknown` and needs an operator scope decision. Whether the risk
classifier should short-circuit non-code paths before the graph is consulted is
a separate question about `impact._risk_class`, not about discovery, and it is
not answered here.

### Known limit, stated rather than implied

The graph's granularity is the project. `aria-kernel` is now one project, so a
change to `ledger.py` reports `direct_projects: ['aria-kernel']` and
`downstream_projects: []` — and that is _true at project granularity_, because
no other project imports the kernel. It is emphatically **not** a claim that
nothing depends on `ledger.py`; roughly sixty kernel modules do. Within-project
module edges are a different graph (PLAN Wave 10, Deep Twin) and this change
does not pretend to supply them. Nobody should read an empty `downstream` for a
kernel file as "safe to change in isolation".

### Verification

- New suite `aria-kernel/tests/test_project_discovery.py`, 14 tests: red
  before the fix (12 failures, 2 errors), green after.
- Mutation checks — each mutation applied, suite re-run, mutation reverted:
  - allow the workspace root to become a project → 11 failures, including both
    root tests;
  - drop `pyproject.toml` from the marker set → 3 failures, including
    `test_arias_own_kernel_is_on_the_map` and the end-to-end unblocking test;
  - overwrite on name collision instead of keeping the first → 1 failure,
    `test_a_name_collision_keeps_the_first_and_does_not_overwrite`;
  - drop the `NOT_THE_REPOSITORY` exclusions → 2 failures, including
    `test_vendored_and_build_output_is_not_the_repository`.

  Containment took three attempts and the first two are worth recording,
  because they corrected a claim rather than the code. Removing the "already
  inside a known project" prune left the suite **green**; so did removing the
  `continue` that stops the walk descending into a project it just placed.
  Containment turns out to have two independent enforcers, and either one alone
  is sufficient: the prune catches a nested marker reached by another route,
  the `continue` means it is never reached at all. Only with **both** removed do
  `test_the_shallower_marker_wins` and
  `test_a_nested_marker_belongs_to_its_parent_project` go red — which is the
  check that the property is genuinely pinned. The `continue` is kept for the
  ~69 directory listings it saves, not because containment depends on it.

- `aria:test:unit`: 3,356 passed (34 skipped).
- `invariants:fast`: 2,324 passed after the authority-hash regeneration that any
  kernel source change requires.
