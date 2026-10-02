# ARIA operator request channel — signed, grounded, consumed once (2026-10-02)

Context: the operator wants the next strict nightly cycle to plan one of ARIA's own F findings
(F-007) instead of a failing CI run. The operator-feedback source already ranks at priority 0
(`plan_synthesizer._SOURCE_PRIORITY`), so a signed operator request is the designed way to express
a one-time decision without editing the standing priority. Reading the channel end to end showed it
could not deliver a single request, and that the failing-CI source it has to outrank has no notion
of which red workflows are about `main`. The architectural-arbiter ruled on both on 2026-10-02
(ADR-0018, ADR-0019 proposed, ADR-0020 under `docs/recommendations/architectural-arbiter/`).

Owner: claude (implementation), okan (review, operator steps, ADR-0019 decision).

## ARIA-CRITICAL-255

Context: a request row reached the synthesizer through `ingest_operator_feedback`, which admitted
every row whose `status` was `unaddressed`. Five independent defects sat on the path from that row
to a merged plan, and any one of them was enough to stop delivery.

Evidence:

- `aria-kernel/aria_kernel/operator_feedback_ingestion.py:98` — every `unaddressed` row is a
  candidate on every scan and nothing ever changes the status, so one request holds priority 0
  forever.
- `aria-kernel/aria_kernel/plan_synthesizer.py:1095` — the operator plan's only evidence ref and
  only surface was `aria-tools/operator-feedback.jsonl`, ARIA's own output;
  `aria-kernel/aria_kernel/agent_invocations.py:1315` refuses such an envelope
  (`request_evidence_self_output_only`), so the challenger could never be minted.
- `aria-kernel/aria_kernel/operator_feedback_signature.py:46` — request rows were HMAC-signed under
  `secrets/operator-feedback-hmac.key`, minted on the runner: any runner-uid process could sign.
  `.github/workflows/aria-auto-cycle.yml:204` (and `aria-agent-executor.yml:183`) run
  `git clean -ffdx` at job start, and the store never publishes `secrets/`, so the key died with
  every self-hosted job.
- `aria-kernel/aria_kernel/operator_feedback_ingestion.py:282` — check 12 re-verified consumed rows
  against that key file; `.github/workflows/aria-merge-authority.yml:19` runs on `ubuntu-latest`,
  which never holds it, so an operator-sourced plan could never pass the pre-merge perimeter.
- `aria-kernel/aria_kernel/plan_convergence.py:577` — `_validate_submitted_plan` never compared a
  submitted body's `finding_id` with the started plan's; a challenger or revision could drop it.

Rule: an operator decision reaches the planner only through a channel the operator alone can sign,
that a runner uid cannot forge, that every lane verifies against the same committed anchor, that is
consumed once, whose plan is grounded in tracked repository evidence, and whose plan keeps its
finding from start to merge (ADR-0018, ADR-0020).

Fix:

- Request rows carry `finding_id` and an operator ed25519 signature (`ssh-keygen -Y sign -n
aria-operator-request`), verified against `.github/manifests/aria-operator-signers` read as a git
  object (cycle HEAD at ingestion, the PR's live base on `main` at merge)
  — `aria_kernel/operator_request_signature.py`. The HMAC stays for kernel-written verdict and
  calibration rows only, and the HMAC append path refuses a request-shaped row.
- One admission for F_FINDING and operator candidates (`aria_kernel/finding_grounding.py`): OPEN in
  the event fold, refs that are tracked files of the checkout, at least one writable surface;
  refused surfaces named in the conversion event. An operator plan's summary is fixed text plus the
  operator's sanitized words; no finding-body field reaches the plan.
- Consume-once at ingestion (`aria_kernel/operator_request_spend.py`): spent when a started plan's
  binding consumed it or a `request_refused` row names it; reused ids refused at record time and at
  ingestion.
- `_validate_submitted_plan` refuses a body whose `finding_id` differs from, adds to or drops the
  started plan's (`plan_origin_changed`); the planner bridge carries the started origin onto a body
  that names none.
- Check 12 verifies with the committed anchor only; no key file exists on any lane.

## ARIA-HIGH-256

Context: the failing-CI source ranks above every finding source and supplies a candidate for any
workflow red on `main`, whatever that workflow judges. With eight workflows red on 2026-10-02,
observers and post-deploy probes outranked every F finding ARIA holds.

Evidence:

- `aria-kernel/aria_kernel/plan_synthesizer.py:678` — `scan_failing_ci` keeps any workflow whose
  newest decisive run on `main` failed; no input says what the workflow is a verdict about.
- `aria-kernel/aria_kernel/plan_synthesizer.py:823` — `_SOURCE_PRIORITY` ranks `failing_ci` at 1,
  above ORPHAN (2) and F findings (3).
- `.github/workflows/e2e-tests.yml:12` — runs on `workflow_run` after deploy and judges `main`, so
  an exclusion keyed on `event == workflow_run` would drop a real verdict.

Rule: FAILING_CI means a red workflow whose verdict is about `main` itself (proposed ADR-0019).

Fix (proposed, owner okan, decision by 2026-10-16): a role manifest under `.github/manifests/`
(`main_verdict` | `pr_verdict` | `observer`, undeclared counts as `main_verdict`), an invariant over
each workflow's `on:` triggers, and a per-cycle log of every red workflow the source excludes.
Nothing of it is implemented in the branch that registers this finding; until it is decided, the
signed operator request (ADR-0018) is how a one-time decision outranks failing CI.
