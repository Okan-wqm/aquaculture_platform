# ADR-0027 — System One (Jev) Is a Classifier ARIA Asks, Under a Fixed Data-Egress Policy

**Status:** accepted (operator, 2026-10-03: "Jev'i de hallet ARIA içine"; "benimkini kullan" for the key)
**Date:** 2026-10-03
**Owner:** okan
**Resolves:** the data-egress half of ARIA-LOW-252 (embedder half stays open)
**Implements with:** ARIA-LOW-318 (core), ARIA-LOW-319 (decision points)
**Plan reference:** `/root/.claude/plans/crystalline-purring-hare.md` rev3.1, section "Jev entegrasyonu"

## Context

TypeSafe's System One (`jev-1.13.0`) answers typed questions about a small JSON state (statement probability,
choice, score) in about 0.2 s for about $0.0001, with no text, reasons or locations in the answer. It was measured on
this repository on 2026-10-03 before any wiring:

- Passed pre-registered gates: finding text ↔ fix diff (J0, AUROC 0.831, n=618), cited code supports the claim (J2,
  0.830, n=600), PR message ↔ diff (R5, 0.995, n=500), file ranking for a finding (R4, right file in the top 3 for 84%
  of 100 findings), tenant-scoping triage against judge consensus (J1, 0.92).
- Failed: bug discovery in raw code (four designs, before/after-fix AUROC ≈ 0.50), change type, severity, domain
  routing. Those uses are excluded.

## Decision

1. **Role.** System One classifies candidates other layers produce; it never finds, closes, merges or writes. It is
   not a `model_fleet` provider (`admits_writes` would be meaningless) and is never dispatched as an agent.
2. **Authority ladder, per question and model version — earned by measured success, not a fixed count**
   (operator, 2026-10-03: "what matters is success and correct calibration"). Success is a person's label or an
   executable outcome (a red test turned green, a merged fix that held), never judge consensus.
   - SHADOW: the answer is recorded; nothing reads it.
   - ORDER (ranks a queue or a candidate list; Claude and the tests still decide): the question passed its
     pre-registered offline gate on this repository (J0 n=618, R5 n=500, J2 n=600, R4 n=100), and at least 5 live
     outcomes agree with it with no confident miss (a wrong answer at p ≥ 0.9 or p ≤ 0.1).
   - SKIP (lets a low-risk family skip Claude): a sequential bound, not a sample-size rule. The offline result is the
     prior (Beta, discounted to n=20 so live data dominates quickly), live outcomes update it, and SKIP opens only in
     the band p ≥ 0.97 or ≤ 0.03 while the posterior 95% lower bound on that band's precision is ≥ 0.95 — about 10–20
     live outcomes when live behaviour matches the offline measurement, never if it does not. Security, migration and
     irreversible classes never reach SKIP.
   - Calibration guard: answers are bucketed by stated probability; a confident miss in a high-risk class, or a rolling
     expected calibration error above 0.10 over the last 20 outcomes, drops the question back to SHADOW, and so does
     any model version change.
3. **Questions are operator data.** They live only in `aria-config/system-one-questions.json` (READONLY to ARIA,
   listed in `AUTHORITY_SURFACES`), in English, each with its decision points, exact state keys, mode and model pin.
   ARIA cannot write or reword a question; a changed question is re-validated on new data before it leaves SHADOW.
4. **Data egress allowlist.** Only public repository code, diffs and finding / PR / commit text leave the host. Never:
   tenant data, production logs, aria/state runtime signals, secrets or `.env` content, operator content. The kernel
   refuses before sending a state with keys other than the question's, an oversized state, a secret-pattern match or
   Turkish text. If the repository becomes private, this decision is re-taken before the next call.
5. **Credential.** The key is read only from the 0600 file `ARIA_JEV_API_KEY_FILE` names, never from an environment
   value, and is dropped from agent child environments. By operator decision the runner uses the operator's own key
   (`/home/gharunner/.config/aria/jev_api_key`): one key, so revoking it stops both the operator's sessions and ARIA.
   No GitHub secret holds it; GitHub-hosted lanes record `credential_not_configured` instead of calling.
6. **Observation, not memory.** Every call writes one row to `system-one/calls.jsonl` (question id and version, pinned
   model, sha256 of the state, probability or choice, confidence, latency); the state itself is never stored and no
   answer becomes lesson text or a `must_satisfy` source.
7. **No hard dependency.** Timeout ≤ 5 s, one retry, an in-process breaker; every failure is a named unavailable
   result and the decision proceeds as if System One were absent.

## Consequences

- First live run: J0, R5 and J1 are asked in SHADOW at PR open, merge authority and judge fan-out; R4 stays SHADOW so
  planner and implementer prompts are byte-identical to the measured baseline.
- ORDER for R4 (ranked candidate files in planner and implementer envelopes) is the first promotion candidate, once
  shadow rows show its ranking on ARIA's own plans.
- The merge lane's J0 runs without a key until the operator decides otherwise; the operator-side merge train keeps
  running J0 with the root copy meanwhile.
