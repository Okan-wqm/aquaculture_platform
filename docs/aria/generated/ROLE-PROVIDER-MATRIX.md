<!-- GENERATED ARTIFACT — see the footer for the regen command. DO NOT EDIT. -->

# Role x provider matrix (WP-P provider continuity)

Operator requirement (HANDOVER 2026-10-18 §7): with any ONE provider alive — Claude, Z.ai or Codex — every role runs; no dispatchable role is served by fewer than two providers unless the operator pins the exception (aria-kernel/tests/fixtures/role_provider_matrix_pins.json). Every cell is computed from the production accessors by `aria-kernel/tests/_helpers/role_provider_matrix.py` and pinned byte-for-byte by `aria-kernel/tests/test_role_provider_matrix_ssot.py`.

Columns are the fleet's providers, in fleet order: anthropic, zai, openai.
Each column is a host the shared WP-P builders present alone (anthropic: `anthropic`, zai: `zai`, openai: `openai`).

## Dispatchable roles

| role | seat | profile | ladder | anthropic | zai | openai | runnable |
|---|---|---|---|---|---|---|---|
| adversarial_judgment | aria-adversarial-judge | judge_glm | glm_first | yes | yes | yes | 3 |
| architecture | architectural-arbiter | frontmatter | glm_first | yes | yes | yes | 3 |
| bug_hunt | aria-bug-hunter | panel_bug_hunter | claude_first | yes | yes | yes | 3 |
| challenger_authoring | aria-challenger-drafter | planner | glm_first | yes | yes | yes | 3 |
| challenger_plan | aria-challenger-planner | planner | glm_first | yes | yes | yes | 3 |
| change_intelligence | aria-change-intelligence | judge_opus | glm_first | yes | yes | yes | 3 |
| completeness_critique | aria-completeness-critic | judge_opus | glm_first | yes | yes | yes | 3 |
| consensus_arbitration | aria-consensus-arbiter | arbiter | claude_first | yes | yes | yes | 3 |
| cross_review | aria-cross-reviewer | judge_opus | glm_first | yes | yes | yes | 3 |
| evidence_judgment | aria-evidence-judge | judge_opus | claude_first | yes | yes | yes | 3 |
| goldset_curation | aria-goldset-curator | judge_opus | glm_first | yes | yes | yes | 3 |
| human_required_adjudication | aria-evidence-judge | judge_opus | claude_first | yes | yes | yes | 3 |
| human_required_adjudication | aria-adversarial-judge | judge_glm | glm_first | yes | yes | yes | 3 |
| human_required_adjudication | aria-consensus-arbiter | arbiter | claude_first | yes | yes | yes | 3 |
| impact_assessment | aria-impact-assessor | panel_impact_assessor | glm_first | yes | yes | yes | 3 |
| implementation | aria-implementer | implementer, write | claude_writer | yes | yes | no | 2 |
| maintenance_utility | aria-autonomy-planner | planner | glm_first | yes | yes | yes | 3 |
| primary_authoring | aria-primary-drafter | planner | claude_first | yes | yes | yes | 3 |
| primary_plan | aria-primary-planner | planner | claude_first | yes | yes | yes | 3 |
| reproduction_test | aria-test-writer | panel_test_writer, write | claude_writer | yes | yes | no | 2 |
| specialist_domain_review | architectural-arbiter | frontmatter | claude_first | yes | yes | yes | 3 |
| specialist_domain_review | auth-security-expert | frontmatter | claude_first | yes | yes | yes | 3 |
| verification | aria-adversarial-judge | judge_glm | glm_first | yes | yes | yes | 3 |

### Refused cells and their owner-named reasons

| role | seat | provider | reason |
|---|---|---|---|
| implementation | aria-implementer | openai | refused: provider_readonly_runtime (admits_writes=False) |
| reproduction_test | aria-test-writer | openai | refused: provider_readonly_runtime (admits_writes=False) |

## Lanes

- worker lane (write targets ride the write seat implementation as aria-implementer): runtimes `claude`, `zai`, ladder `anthropic, zai`.
- spawn lane (`ci_executor._dispatch_attempt`): runtimes `claude`, `zai` — a routing rung on any other runtime is skipped by `routed_models` there.

<!-- Regen: cd aria-kernel && python3 -m tests._helpers.role_provider_matrix
     > ../docs/aria/generated/ROLE-PROVIDER-MATRIX.md
     Pinned by: aria-kernel/tests/test_role_provider_matrix_ssot.py (byte-for-byte),
     aria-kernel/tests/test_provider_matrix_invariant.py (>= runnable floor). -->
