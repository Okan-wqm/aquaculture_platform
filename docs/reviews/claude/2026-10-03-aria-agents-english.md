# ARIA's agents work in English (2026-10-03)

Operator rule (Okan, 2026-10-03): the agents inside ARIA speak English, not Turkish. Reports to the
operator are not covered by this rule.

Owner: claude. Deadline 2026-10-17.

## ARIA-LOW-328 — Operator request text reaches agent envelopes in any language

Measured on `origin/aria/state` (f82569371): 0 of 135 recorded agent transcripts carry Turkish in a
prompt; 4 of 213 agent text blocks contain a Turkish letter, each quoting a Turkish file name inside
English text. The agent definitions (`.claude/agents/**/aria-*.md`) contain none. Turkish in the
kernel sits only in comments that quote the operator.

The one channel that puts operator prose verbatim into an agent envelope is the signed operator
request:

- `aria-kernel/aria_kernel/operator_feedback_signature.py:276-283` — the recorder checked only that
  the text is non-empty and at most 4096 characters, so a Turkish request would reach the planner
  and invite a Turkish answer.

Rule: text that ARIA hands to an agent is English.

Fix: the recorder refuses Turkish letters with `operator_request_text_not_english` before anything
is signed, and `aria-kernel/tests/test_agents_work_in_english.py` pins the agent definitions and the
captured rendered prompts.
