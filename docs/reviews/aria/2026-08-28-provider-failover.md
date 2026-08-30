# ARIA review — 2026-08-28: no provider failover

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

## ARIA-HIGH-023 — no provider failover: an absent subscription starves lanes

The dispatch layer is provider-static: each role pins a model whose backend
may be unauthenticated, and absence degrades to mock/skip rather than
re-routing to a real, available provider.

## Fix (implemented this pass)

The failover lives where the credential actually fails: the auth branch of
`run_with_model_fallback` (`tools/aria-poc/claude_runtime.py`).

- `MODEL_FALLBACK_TIER` gains cross-provider rungs — `sonnet -> glm-5.3`
  and `glm-5.3 -> opus` — so every Anthropic tier's chain terminates at a
  different vendor, and glm falls back to the strongest authoring tier. The
  map is deliberately cyclic now; credit/refusal paths still walk exactly
  one rung, and the auth walk is visited-set bounded (pinned by test).
- An auth failure walks the ladder SKIPPING same-vendor rungs (they share
  the dead credential) and retries once on the first cross-provider tier at
  the original effort. `provider_redirect_env` already scopes the vendor
  credential per spawn, so the retried dispatch reaches the other provider
  with no other change.
- Both providers failing auth raises `ClaudeAuthFailure` naming both tiers
  — an honest terminal, never a mock verdict. This is the operator's
  requirement: one subscription absent, the other carries the work; none
  present, the failure is loud.
- Tests: `test_credit_fallback.py` pins the new topology (cross-rungs,
  cyclic-with-bounded-walk), the skip-same-vendor retry, the glm→opus
  reverse direction, both-down terminality, and the unchanged single-rung
  credit/refusal semantics; the old leaf-tier pin moves from sonnet
  (now routed) to haiku (still an honest leaf).

## Remaining follow-ups (not blocking)

- A provider-availability probe at dispatch time (claude CLI auth state;
  Z.ai key presence) producing a per-cycle availability record.
- The anchor's distinct-model rule keeps counting only real dispatches;
  single-provider windows are marked degraded in the reflection report
  (SIGNAL STARVED class), not silently green.
