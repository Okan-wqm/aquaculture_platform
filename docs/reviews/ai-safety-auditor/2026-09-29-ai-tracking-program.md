# AI confirmation integrity and cost accounting — ai-safety-auditor, 2026-09-29

Raised in the 2026-09-29 adversarial review of the ai-service program plan (automatic tasks,
tracking agents, AI configuration). Four reviewers (alert-engine, AI safety, farm domain,
architecture) attacked plan rev 2 against origin/main `dae95efb3`; the main session re-verified the
load-bearing claims in code, and ALERT-CRITICAL-004 on the live database. Later entries
(MT-HIGH-064, MT-MEDIUM-065, ALERT-CRITICAL-009, FARM-MEDIUM-355) come from the implementation
lanes. Each finding names the plan PR that closes it.

## AISAFETY-HIGH-027

The manager tier ceiling is blocked, which withholds every confirmation-gated tool from managers.

- **Severity:** HIGH. **Deadline:** 2026-10-31. **Closes in:** plan PR-A1a.
- **Evidence:** `apps/ai-service/src/agent/personas/tiers/manager.tier.ts:15` — actuationCeiling
  blocked.
- **Rule:** AI suggests, human confirms (plan K2).

Closed by plan PR-A1a.

## AISAFETY-HIGH-028

Supervisor tier + general specialty + tenant policy resolve to allowed, letting confirmation-gated
tools run without a human.

- **Severity:** HIGH. **Deadline:** 2026-10-31. **Closes in:** plan PR-A1a.
- **Evidence:** `apps/ai-service/src/agent/personas/tiers/supervisor.tier.ts:14` — actuationCeiling
  allowed.
- **Rule:** AI suggests, human confirms (plan K2).

Closed by plan PR-A1a.

## AISAFETY-HIGH-029

executeAction trusts confirmedBy from the payload: any channel member can confirm and execution runs
with the roles stored at proposal time.

- **Severity:** HIGH. **Deadline:** 2026-10-31. **Closes in:** plan PR-A1a.
- **Evidence:** `apps/ai-service/src/actions/ai-action.responder.ts:47` — confirmedBy taken from the
  request.
- **Rule:** Server-side confirmation integrity.

Closed by plan PR-A1a (recipientUserId + branded HumanConfirmation) and PR-A1b (live
re-authorization).

## AISAFETY-MEDIUM-030

Action proposals have no rejected, expired or cancelled states and the web has no confirm/reject
path.

- **Severity:** MEDIUM. **Deadline:** 2026-11-15. **Closes in:** plan PR-A1b.
- **Evidence:** `apps/ai-service/src/actions/proposed-action.entity.ts:65` — status set lacks
  terminal states.
- **Rule:** Proposal lifecycle.

Closed by plan PR-A1b.

## AISAFETY-MEDIUM-031

Cached prompt tokens are billed twice: input already includes cached tokens and cacheRead is added
again.

- **Severity:** MEDIUM. **Deadline:** 2026-11-15. **Closes in:** plan PR-A3.
- **Evidence:** `apps/ai-service/src/agent/providers/openai.provider.ts:139` — input = prompt_tokens
  incl. cached.
- **Rule:** Correct cost accounting.

Closed by plan PR-A3.

## AISAFETY-MEDIUM-032

The token budget has one fixed key per tenant month and reserves only output tokens, so no separate
budget pool can exist.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C1.
- **Evidence:** `apps/ai-service/src/cost/token-budget.service.ts:53` — fixed key, output-only
  reservation.
- **Rule:** Bounded AI cost.

Closed by plan PR-C1 (typed budgetPool).

## AISAFETY-LOW-033

The ai-events contract family has no producers or consumers and declares executedBy agent,
contradicting human-confirmed actuation.

- **Severity:** LOW. **Deadline:** 2026-11-30. **Closes in:** plan PR-C1.
- **Evidence:** `libs/event-contracts/src/ai-events.ts:1` — dead contracts.
- **Rule:** No dead contracts.

Closed by plan PR-C1.
