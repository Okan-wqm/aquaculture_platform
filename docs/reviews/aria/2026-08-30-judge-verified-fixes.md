# Judge-verified fixes — 2026-08-30

Adversarial audit identified two actionable gaps (rest was redundant/premature).

## ARIA-LOW-030 (registered as LOW; ARIA-MEDIUM-030 was a pre-registration alias) — host-bound path + missing past-failure context

1. agent_priors.py hardcoded /var/aqua-saas/ — replaced with generic normalization
2. Past-failed-attempts section added to \_established_knowledge_for_refs
