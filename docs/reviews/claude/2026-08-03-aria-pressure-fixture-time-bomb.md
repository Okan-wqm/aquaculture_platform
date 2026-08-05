# ARIA kernel — pressure fixture calendar bomb (2026-08-03)

Found driving PR #1049 (Wave 0 §0.5) to green: CI's `unittest` check failed
on two tests the branch never touched, and the same two fail at `main`'s
tip on any run after 2026-08-03T00:00Z.

## ORPHAN-HIGH-522 — fixed-date pressure fixtures decay out from under a real-clock read

`DEFAULT_DECAY_THRESHOLDS` marks a pressure `faded` at 90 days of evidence
age, and `list_workspace_pressures` defaults to the `active` filter with
`now = wall clock`. Two tests seeded pressure fixtures with the literal
date `2026-05-05T00:00:00Z` and then read them back through a real-clock
path:

- `test_pressure_lifecycle.test_cli_pressure_list_defaults_to_active_and_explain_shows_history`
  drives the actual `pressure list` CLI, which has no `--now` — the read
  side is always the real clock.
- `test_v13_contracts.test_pressure_list_workspace_base_isolation_and_memory_tools_isolation`
  calls `list_workspace_pressures` without `now=`.

2026-05-05 + 90 days = 2026-08-03: from that midnight (UTC) the fixtures
silently decay to `faded`, the `active` filter drops them, and both
assertions see an empty list. Every CI run on every branch goes red on the
day the calendar catches up — a defect that was invisible for 90 days and
then deterministic everywhere at once.

**Fix (same commit):** the fixtures are anchored to the wall clock
(`datetime.now(timezone.utc)`) wherever the read side is the real clock,
so evidence age is ~0 regardless of the calendar date. Tests that pin both
sides (`now=` passed explicitly on seed AND read) keep their literal
dates — those are self-consistent and never decay unexpectedly.

**Class sweep:** every fixed `detected_at` fixture in the kernel tests was
checked (`test_phase4_1_genesis_hook`, `test_phase4_agent_network_invocations`,
`test_phase4_1_impact_graph_hook`, `test_phase4_1_fitness_staleness`, all
dated 2026-05-06). None of them read back through the decay-filtering
surfaces (`effective_workspace_pressures` / `list_workspace_pressures`)
with a real clock, so none is a member of this class;
`test_phase4_1_fitness_staleness` already seeds its staleness-sensitive
rows clock-relative.

**Validation:** both test files green after the fix
(`test_pressure_lifecycle` + `test_v13_contracts`, 22 tests); full kernel
suite green on the branch.

Owner: aria-acceptance-gap-fixer. Deadline: 2026-08-10 (post-merge close
ceremony).
