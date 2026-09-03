<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 003 - Validation and Test Harness

## Goal

Define how to prove ARIA has become a real repository-shaped system rather than a pile of documents and optimistic claims.

The validation harness must test memory, discovery, evidence discipline, exclusion rules, kill switch behavior, budget gate behavior, self-renewal feedback, and skill genesis refusal paths before ARIA can move beyond Phase 0.

## Non-goals

- No full production CI rollout in this plan.
- No kernel implementation details beyond testable interfaces.
- No application-code fixtures mixed into live services.
- No LLM-scored acceptance tests.
- No snapshot that blesses private workspace data into the repository.
- No requirement to run the full Nx suite for every ARIA harness test.

## Physical artefacts

The validation harness is allowed to introduce these artefacts when implementation begins:

| Artefact | Location | Purpose |
|---|---|---|
| Harness package | `aria-kernel/tests/` | Unit and integration tests for Phase 0 kernel behavior. |
| Repo fixtures | `aria-kernel/tests/fixtures/repos/` | Tiny synthetic repositories for discovery and drift behavior. |
| Golden artefacts | `aria-kernel/tests/fixtures/golden/` | Expected fates, ledgers, evidence validation errors, and reports. |
| Exclusion fixture | `aria-kernel/tests/fixtures/repos/exclusion-surface/` | Contains `agent-workspace/`, `.aria-poc/`, generated output, and secret-like files. |
| Drift fixture | `aria-kernel/tests/fixtures/repos/enum-ui-drift/` | Minimal DB/backend/frontend value-set drift case. |
| False-positive fixture | `aria-kernel/tests/fixtures/repos/false-positive-suppression/` | Framework convention and documented-intent cases that must not create skill birth. |
| Kill switch fixture | `aria-kernel/tests/fixtures/runtime/kill-switch/` | Sentinel file and slow scanner stub. |
| Budget fixture | `aria-kernel/tests/fixtures/runtime/budget/` | Tiny hard limit config that forces mid-cycle stop. |
| Missed-signal fixture | `aria-kernel/tests/fixtures/repos/missed-signal-feedback/` | Dynamic UI option or scanner-disagreement examples that become pressure only after repetition. |
| Harness command | `python3 -m aria_kernel.harness` | Deterministic local test runner wrapper. |

Existing PoC tests remain in `tools/aria-poc/test_poc.py`. They validate the PoC, not the Phase 0 kernel.

## Decision gates

### Gate 1 - Harness before expansion

No Phase 1 skill genesis work can start until Phase 0 has tests for:

- external workspace creation and reuse;
- observation memory across repeated runs;
- fate assignment for every tracked file;
- exclusion policy;
- evidence chain validation;
- kill switch halt;
- budget gate halt.
- missed-signal feedback recording and pressure derivation.

### Gate 2 - Memory continuity

The harness must run the same fixture repo twice and assert:

- the second run loads the first run's workspace;
- prior observations remain addressable;
- append-only ledgers keep their previous hashes;
- cycle state links to the previous cycle.

This is the minimum proof that ARIA remembers rather than rescans into amnesia.

### Gate 3 - New signal separation

The enum/UI drift fixture must prove ARIA separates:

- a known prior observation;
- a new value-set drift signal;
- a related but non-identical UI option mismatch;
- a dismissed framework convention.

The test must fail if ARIA collapses all value overlap into one generic drift bucket.

### Gate 4 - Skill birth refusal

False-positive fixtures must prove that skill genesis refuses:

- one-time drift;
- framework convention differences;
- versioned API differences;
- documented-intent differences backed by trusted ADR or test demand;
- generated-output differences.

This gate is required before any `SHADOW` skill can be trusted.

### Gate 5 - Exclusion discipline

The exclusion fixture must prove ARIA does not read these as application code:

- `agent-workspace/`;
- `.aria-poc/`;
- generated output with a generated marker;
- secret-like files;
- dependency and build output directories.

The coverage report must still account for each skipped path with a reason.

### Gate 6 - Runtime interruption

Kill switch and budget gate tests must interrupt an in-progress cycle, not only block startup.

The harness must include a scanner stub that yields between files so the kill switch can activate mid-cycle. The budget fixture must set a hard limit low enough to stop after the first measurable unit.

### Gate 7 - Self-renewal feedback

The harness must prove:

- one missed signal is recorded without pressure;
- three independent missed signals emit `REPETITION` pressure;
- external scanner disagreement emits `CONTRADICTION` pressure;
- repeated false-positive feedback emits calibration pressure, not skill-birth pressure;
- feedback remains untrusted until evidence validation.

## Acceptance tests

The validation plan is accepted when these checks are represented as runnable tests:

- ARIA remembers prior observations when run twice against the same fixture repo.
- ARIA assigns a fate to every tracked file and records skip reasons.
- ARIA separates a new enum/UI drift fixture from prior observations.
- ARIA rejects false-positive examples without birthing a skill.
- ARIA ignores `agent-workspace/`, `.aria-poc/`, secrets, and generated output as application code.
- ARIA records excluded files in coverage instead of silently dropping them.
- ARIA kill switch halts a cycle after startup.
- ARIA budget gate halts a cycle after startup.
- ARIA records missed-signal feedback without immediately birthing a skill.
- ARIA turns repeated missed-signal feedback into pressure.
- ARIA evidence validator rejects self-output evidence.
- ARIA creates no application-code diff during harness runs.
- Existing PoC command still passes: `python3 tools/aria-poc/poc.py --workspace-root . --skip-nx-graph --fail-on-drifts 100`.
- Existing PoC unit tests still pass: `python3 -m unittest discover tools/aria-poc -p '*test*.py'`.
