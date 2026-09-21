# ARIA's position among code-verification products, and its detection layer (2026-09-19)

Recorded 2026-09-19 at the operator's request, from the conversation that followed the
typed-judgment plan (`2026-09-19-aria-typed-judgment-plan.md`). It answers four questions the
operator asked in order — is ARIA worth finishing, does anything like it exist, where is
SonarQube better, how does ARIA reach that level — and records the decision taken, the finding
it opened, and the roadmap it implies. The author has a stated bias: the same session built the
judgment layer this document weighs.

## 1. What exists elsewhere, and what does not

The parts exist; the combination does not.

| Capability                                                                                           | Where it exists commercially                                   | In ARIA                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Curated rule detection (thousands of rules, taint, secrets, IaC, 30+ languages)                      | SonarQube, Semgrep, CodeQL, Snyk                               | absent until this document (seven bespoke adapters)                                                               |
| AI triage of findings with a confidence                                                              | Semgrep Assistant, Snyk AI triage                              | two judge models + arbiter, citation required, confidence scored (Brier, ECE) against the repository's own labels |
| Fix generation as a PR                                                                               | Copilot Autofix, Copilot coding agent, Codex, Devin, OpenHands | implementation ring with write containment and the repository's own gates; zero delivered PRs so far              |
| Nightly autonomous loop with a fitness measure                                                       | Meta SapFix / Sapienz (internal)                               | the cycle → judge → consensus → promotion → plan → implement ring; ring 4 onward unproven live                    |
| Hash-chained ledgers, lease/claim, read-contained judges, cost ledger, calibration gate, label queue | none as a product                                              | present                                                                                                           |
| Verdicts bound to the repository's own law (CONTRACTS, ADRs, banned phrases, gates)                  | none                                                           | present                                                                                                           |

The honest measure is output per hour. ARIA's infrastructure is large (a kernel, 376 open
findings, hash pins, gates that bite their own PRs); its output to date is 59 accepted judgments
in August, none since until the chain restart, zero convergences and zero merged PRs of its own.
On the same day interactive Claude Code sessions merged seven product waves and resolved a
production incident. A large share of the finding registry is findings about ARIA, which is the
signal of a system that has fallen into its own gravity.

## 2. SonarQube AI CodeFix against ARIA

SonarQube AI CodeFix is on demand: for an issue Sonar's own analyzers found, a developer asks for
a fix in the UI or IDE and an LLM proposes a diff. It is not autonomous, it does not judge whether
the issue is real, it sees only Sonar's issues, and it does not measure its own decisions.

Where ARIA's design is ahead: unattended operation over a queue; a "is this real" verdict from two
models with a required citation and a calibration measured on this repository's labels; every
detector's findings in one ledger under one law; a reproducible SHA-pinned evidence trail; a fix
that arrives through the repository's own pre-push suite, closure trailer and closure-drift rule;
a label loop that changes weights; the operator's own keys on the operator's own runner;
read-contained judges, leases, breakers, a cost ledger.

Where Sonar is decisively ahead, and this document does not pretend otherwise: detection breadth
and depth (thousands of curated rules, taint analysis) where ARIA detects nothing of its own; it
works today with no maintenance, an IDE, a quality-gate UI and team adoption; a fix scoped to a
known rule with a known pattern, hence a high acceptance rate, where ARIA's implementation ring
has delivered nothing; a predictable subscription against engineering hours.

They are not rivals. ARIA never competed on detection: detectors below, ARIA's judgment, audit
and learning above — that is the architecture, and this document's decision follows from it.

## 3. How ARIA reaches that level

1. **Detection — wrap, do not build.** Sonar's JS/TS rules are open source: the definitions at
   rules.sonarsource.com, the implementations in `SonarJS` and, as an ESLint plugin,
   `eslint-plugin-sonarjs` (about three hundred rules, LGPL, run as a plugin and never copied);
   `eslint-plugin-security`, typescript-eslint's strict set, Semgrep's registry and CodeQL's
   queries are the other public corpora. For this repository's stack the relevant count is in the
   hundreds, not six thousand. **Decision (operator, 2026-09-19): the rules inside ARIA, not the
   Sonar product** — an ARIA adapter with ARIA's own rule configuration, in shadow, no server, no
   subscription, no data leaving the runner. `lint-rules-adapter` (§5) is that decision built.
2. **"Works today, zero maintenance, adoption" — shrink and give it a surface.** Freeze the kernel
   API; a new finding about ARIA only when it blocks the ring; at most one day a week on ARIA
   infrastructure, with the ARIA-PR to product-PR ratio in the weekly report; a merge queue or a
   relaxed up-to-date rule for automation PRs. Two cheap surfaces: the verdict posted as a review
   comment on the PR that introduced the finding, and a label page (tonight's judgments, verdict,
   evidence, one click TP/FP) that is the label queue's UI and therefore the ground truth's. No
   IDE plugin: ARIA's value is nightly, not in the editor.
3. **Fix accuracy — narrow scope.** A "narrow fix" lane before any convergence plan: one finding,
   one file, a known class (lint autofix, deprecated API, banned phrase, missing import, type
   narrowing), the affected tests, a PR with its `Closes:` trailer; the question bank asks "is this
   fix mechanical" before an implementer is spent; acceptance measured, scope widened one step at
   a time above seventy percent.
4. **Predictable cost — a budget gate.** A monthly model-cost ceiling in policy that trips the
   breaker; Sonar CE and Semgrep OSS are free; the engineering hour is capped by item 2.

**Decision gate, 2026-10-05:** at least three merged ARIA-originated PRs (narrow fixes), at most
thirty human minutes each, and a false-positive share of promoted findings at or below twenty
percent on the labelled sample. If the gate is missed, ARIA is frozen as "nightly triage and
calibrated false-positive filter over the detectors" and fixes stay with interactive agents.

Not pursued: an IDE plugin, multi-language depth, UI polish, a rule engine of ARIA's own.

## 4. ARIA-native detection, three tiers

The operator's requirement is detection inside ARIA. Its honest cost, by tier:

1. **Rule packs under ARIA's configuration** (this document, days): the curated open-source packs
   run by ARIA's own adapter and pruned rule by rule from the label queue's false-positive share —
   retire above the floor, promote to `error` below the ceiling. Taint analysis is not in this
   tier; the security gap that leaves is named, not hidden.
2. **Model-based detection with typed questions** (weeks; the Phase 7 question bank applied to
   diffs): "does this diff swallow an error path", "does it add a resource that is never
   released", "which category" — calibrated confidence, a citation required, a suggestion until
   the stratum is calibrated. Sonar has no equivalent; this is ARIA's own ground.
3. **Learned detectors** (after labels): from the true positives in the label history, the
   deliberation layer proposes a rule draft, it runs in shadow, and it enters tier 1 only when it
   discriminates on held-out labels — a rule set that grows itself, which a vendor cannot do for
   one customer.

## 5. ARIA-MEDIUM-178 — no general-purpose rule detection reaches ARIA's ledger

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-03
- **Evidence:** `origin/aria/state` `tools/raw-findings.jsonl` carries seven `tool_id`s, all
  bespoke checkers (`doc-staleness-adapter` 21903 rows, `test-gap-adapter` 2512,
  `tenant-scoping-adapter` 559, `security-boundary-adapter` 117, `kernel-dead-wire-adapter` 83,
  `bundle-budget-adapter` 81, `fe-dto-parity-adapter` 4). The repository's developer lint
  (`eslint.config.mjs`) never reaches the ledger, and it does not carry the curated packs. The
  class of finding every code-quality product starts from — a curated language rule — has never
  been seen by ARIA's judges, consensus, calibration or label queue.
- **Rule:** the industry baseline is a detector below ARIA's judgment, not a product beside it;
  its findings enter the one ledger under the one law, in shadow, and the repository's labels
  decide rule by rule what stays.
- **Fix (this lane):** `tools/aria-adapters/lint-rules-adapter.ts` with ARIA's own configuration
  `lint-rules.eslint.config.mjs` (`eslint-plugin-sonarjs` recommended, `eslint-plugin-security`
  recommended, TypeScript parser without type information), manifest `lint-rules-adapter.tool.json`
  in SHADOW over `apps`, `libs`, `platform/libs`, `web` (sources only; specs, declarations and
  archives excluded), one finding per rule message with the file and line as evidence and the
  pack's own classification as severity (security high, problem medium, suggestion low),
  confidence 0.6 below every closing threshold, a parse failure an observation and never a finding,
  a summary observation with the rule histogram; fixture case `rule-packs` (one file each pack
  fires on, one clean file) and `real-repo-baseline`; the two packs as devDependencies. First
  measurement on the checkout of 2026-09-19: 5592 files in 174 s, 5575 findings from 56 rules;
  `security/detect-object-injection` alone 2169 (a computed-member heuristic its own
  documentation calls prone to false positives — it enters at `low` so it cannot crowd the
  judges' sample), then `sonarjs/unused-import` 722, `no-nested-conditional` 685,
  `cognitive-complexity` 461. The label queue's rule-by-rule share decides what stays.
- **Proof:** `tools/aria-adapters/lint-rules-adapter.test.ts` (selection, snapshot narrowing,
  severity map, both packs firing through the real engine, evidence inside `read_paths`, parse
  error as observation, empty surface starts no engine) and the shipped-manifest evidence contract
  (`tests/test_adapter_fixture_evidence_contract.py`) over the two cases.

## 6. A second opinion, weighed

A proposal from another model (a "verification engine" with quality gates, a finding taxonomy,
intent verification, failure classification, a remediation loop, and "do not rewrite Sonar")
was read against the code. About seventy percent of it already exists under other names: the
independent verification plane is the gates, the pre-push suite, the merge authority, the evidence
validator and the write containment; the pass/fail gate is `gates:*` and the invariant lanes;
intent verification is `allowed_scope` enforced at write time plus the `satisfaction_matrix` per
`must_satisfy` in the judge contract; "orchestrate tools, do not rewrite Sonar" is this document's
decision. A directory restructure is churn without value. Three items are worth taking, in order,
and the operator made them binding on 2026-09-19 (**must-do**; each opens its own finding when its
prerequisite lands: 1 and 2 with the first live implementation attempt, 3 with the first delivered
implementation):

1. **A failure taxonomy for agent attempts** (code, test, environment, dependency, flaky test,
   agent mistake) on top of the release-reason codes, as the input of learning from ARIA's own
   attempts — the half of "ARIA learns from its mistakes" that is not yet a data structure (the
   judges' half is: label queue → calibration → weights).
2. **AI-specific finding categories** (hallucinated API, requirement drift, excessive change) so
   what containment prevents is also recorded as a finding the learning ring can see.
3. **A repair loop** (verify → fail → repair task → re-verify), after the first implementation
   has landed and there is something to repair.

## 7. Where System 1 sits

Below and beside the judges, never inside their authority: triage before fan-out, a signal beside
consensus, and — new with §4 — detection questions over diffs. One question bank, one calibration
measurement, the layer table in the typed-judgment plan's Phase 7.
