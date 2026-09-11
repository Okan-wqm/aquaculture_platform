# The model was told to obey a contract it was never shown — and the first accepted native planner result

**Date:** 2026-09-11 · **Agent:** claude · **Cycle:** 2026-09-11 Codex handoff — native planner
**Findings:** ARIA-HIGH-073 — closed by this branch. ARIA-HIGH-068 (live Z.ai) — closed by the evidence in the last section. This document is the evidence for both.

## What the first completed native planner attempt said

Trial five, dispatch one (request `AIR-aria-challenger-planner-bf0c69ea80c0`,
Codex `gpt-6-astra`, effort ultra, 297 s, 69,945 input / 5,615 output
tokens): the run completed, its usage was ledgered, and the pre-submit gate
refused it — `plan_content:absent_or_not_object`. The model's own answer
explained why, in its `evidence_limitations`: "The exposed tools provide no
text-file reader or shell. An independent repository scan and excerpt-hash
verification could not be performed." It returned its plan under `plan`,
`findings`, `preserved_contracts`, `validation` and marked itself `partial`.

The rendered request ends with: "Write your `aria/agent-response/v1` JSON
envelope **per your agent contract**." The contract — the agent's
`.claude/agents/aria-challenger-planner.md` body, which names the seven
canonical `plan_content` keys and says "Read it at the start of each
invocation" about `@.claude/knowledge/layer-2-aria-canonical-envelope.md` —
reached the model on **no route**:

- the Claude route sends the rendered request on stdin and never passed
  `--agent`; the contract arrived only if the model chose to `Read` the file;
- the managed Codex route disables shell/apps in its read-only context and
  has no file reader;
- the Z.ai route is an HTTP transport with no tools at all.

## Fix

`aria_kernel/agent_contract_delivery.render_agent_contract(agent, repo_root)`:
strips the YAML frontmatter, inlines every `@.claude/knowledge/…md`
citation once, in citation order, inside a fence naming its path, within a
byte budget (omissions are listed under a heading, never silently dropped;
a citation that does not resolve under the repository root — missing, or
`../` — is listed the same way), and returns the text with a `sha256:`
hash. The executor delivers it on every route: prefix of the `codex exec`
prompt, the Z.ai system turn, and a prefix of the Claude stdin prompt. The
request bytes stay bound to `prompt_hash`; the contract the model actually
saw is bound to the attempt by `agent_contract_hash` on the sealed envelope
and an `agent_contract` block on `runtime_attempt_finished`.

Two more things the live runs taught the Z.ai transport:

- **Output budget.** GLM-5.3 thinks by default ("forced deep thinking") and
  its reasoning draws on `max_tokens`. Trial five, dispatch two: 8,191 of
  8,192 tokens spent reasoning, `finish_reason=length`, empty content —
  37 KB of reasoning that was actually building the plan. The default is
  now 65,536 (`ARIA_ZAI_MAX_TOKENS` moves it), the route's effort maps onto
  the vendor's `reasoning_effort` vocabulary, and an exhausted budget is the
  named result `output_budget_exhausted`, not `provider_nonzero`.
- **JSON response mode.** Dispatch three: with `response_format=json_object`
  the model produced a complete canonical `plan_content` (14 keys, 23,913
  output tokens) that passed pre-submit — and rewrote every `.json` evidence
  path as `web/shell/package.:13` / `project.:7` (prompt refs intact), so the
  evidence gate refused the submission (`agent_evidence_path_missing`), which
  is the right answer to a reference that does not exist. Trial six, same
  task, JSON mode off: intact references. The mode is now opt-in
  (`ARIA_ZAI_JSON_OBJECT=1`) with the measurement recorded next to it.

## The first accepted native planner result

Trial six (`AIR-aria-challenger-planner-b82f89291809`, target
`43bb3660…`, agent `aria-flow-planner-zai-trial-six`): provider `zai`,
runtime `zai`, model `glm-5.3`, auth `subscription_api_key` from the file
boundary, the contract delivered (31,916 bytes; `layer-1-aria.md` and
`layer-2-aria-canonical-envelope.md` inlined); vendor HTTP 200, `finish_reason
= stop`, 17,228 prompt tokens (6,912 cached), 15,562 completion tokens
(10,569 reasoning), 248 s; `pre_submit_validation_passed`, `submit_step_done
rc=0`, `runtime_attempt_reconciled`. Codex's own reader
(`read_planner_choice.py`) joins it: `native_status =
accepted_and_consumed`, state `CHALLENGER_DRAFTED`, a
`challenger_plan_drafted` event carrying the challenger revision, 13
evidence references checked, native ledger bytes unchanged, `response_hash
== content_hash`. The plan itself proposes consumer-first contract gating of
the notification mark-as-read mutation with surfaces
`web/shell/src/hooks/useNotifications.ts`, its spec, and
`web/shell/project.json`. Its semantic verdict against the trial's private
oracle is deliberately **not** judged here — that is the independent judge
step, and the oracle stays outside every model's scope.

Receipts (outside the repository, no secret material):
`/root/aria-planner-trials/trial-five-zai-20260911/native-dispatch-{one,two,three}/result.json`,
`/root/aria-planner-trials/trial-six-zai-20260911/{native-dispatch-one/result.json,readout}`.

## ARIA-HIGH-068 — live Z.ai evidence

- Key boundary: the runner-provisioned `ARIA_ZAI_API_KEY` from
  `/home/gharunner/actions-runner/.env` was moved, without display, into
  `/root/.aria/secrets/zai.key` (0600, one line) and named through
  `ARIA_ZAI_API_KEY_FILE`; no value, digest or fragment appears anywhere.
- Probe, Coding-Plan route (`/api/coding/paas/v4`, glm-5.3): **HTTP 200**,
  auth available, quota available, 2,823 ms
  (`/root/aria-planner-trials/zai-live-20260911/probe-coding.json`).
- Probe, general route (`/api/paas/v4`): **HTTP 429, vendor code 1113
  "Insufficient balance or no resource package. Please recharge."** — the key
  authenticates and the wallet is empty: the subscription quota does not
  apply there, so `coding` is the right default and the classification
  (code 1113 → quota exhausted) behaved on a real answer
  (`probe-general.json`).
- One native request accepted through `_invoke_native_zai` with the vendor's
  usage block recorded (above).
- Not measured here: the vendor dashboard's view of which quota the calls
  drew — the operator's step.

## Not this finding

Trial four on Codex (`AIR-aria-challenger-planner-1809efa4dcb9`) has not
executed: at admission the wrapped `codex login status` was killed by its
19 s limiter (exit −15, `status_not_confirmed`) while the host was running
the full pre-push suite and two test sets; the request stayed PENDING with
no attempt burned. It is re-dispatched when the host is quiet.
