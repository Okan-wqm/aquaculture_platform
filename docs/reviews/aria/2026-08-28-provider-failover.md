# ARIA review — 2026-08-28: no provider failover — one absent subscription starves the lane instead of handing work to the other provider

Operator requirement (2026-08-28): subscriptions (Claude, Z.ai/GLM) may be
absent at any time; when one is absent the OTHER must carry the agent work.
There must be no substitute judges — a judgment either comes from a real
provider dispatch or is honestly absent.

## Measured facts

- The judge fleet spans three models since #1303 (`feedback_store.py:99`):
  evidence-judge `opus` (Claude), adversarial-judge `glm-5.3` (Z.ai API),
  arbiter `fable`. `VALID_MODELS` (`agent_runtime_profile.py:38`):
  `opus, sonnet, haiku, fable, glm-5.3`.
- With no Claude subscription the executor resolves a mock-mode kill-switch
  (`aria-agent-executor.yml` "Pre-flight - Claude Code auth + mock-mode
  kill-switch resolution"): opus-side spawns produce MOCK output. The mock
  state is audited (`claude_mock_mode_resolved`, AUDITTRAIL-HIGH-009) and the
  anchor counts models from real dispatch records only — so no FAKE verdict
  enters evidence — but the WORK does not fail over: the opus half of the
  judgment simply goes missing while glm-5.3 could have carried it, and the
  ≥2-distinct-model anchor (`ANCHOR_MIN_DISTINCT_MODELS`) starves.
- `judge_fanout.py`/`judge_calibration.py` contain no provider-availability
  probe and no fallback model assignment.

## ARIA-HIGH-023 — agent dispatch has no provider failover; an absent subscription starves lanes instead of routing to the available provider

The dispatch layer is provider-static: each role pins a model whose backend
may be unauthenticated, and absence degrades to mock/skip rather than
re-routing to a real, available provider.

## Fix direction

- A provider-availability probe at dispatch time (claude CLI auth state;
  Z.ai key presence) producing a per-cycle availability record.
- Role→model assignment resolved from availability: e.g. evidence-judge
  runs on glm-5.3 when Claude is absent, adversarial-judge on opus when
  Z.ai is absent; both-absent is an honest, loud skip — never a mock
  verdict in production lanes.
- The anchor's distinct-model rule keeps counting only real dispatches;
  single-provider windows are marked degraded in the reflection report
  (SIGNAL STARVED class), not silently green.
