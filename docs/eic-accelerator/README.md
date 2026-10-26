# EIC Accelerator: short application source pack (technical parts)

Prepared 2026-10-26, from the official documents read that day (see `official-requirements.md`).
This folder holds what the repository and ARIA's own measurements can support. Market, team,
revenue model, IP ownership, investors and finance are the company's facts and are listed in
`company-supplied.md`.

**Read `decisions.md` first.** The most important finding: three unsuccessful submissions close the
Accelerator for the legal entity for the rest of Horizon Europe, the independent TRL assessment
reads the maintenance pipeline as TRL 4 today, and the short proposal has no deadline (3 November is
one of the monthly batching dates).

## Files

| File                                        | What it is                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decisions.md`                              | The decisions the company takes before submitting, with the recommendation on timing.                                                                                                        |
| `official-requirements.md`                  | Digest of the guide, the 2026 work programme and the Part B template, with page references.                                                                                                  |
| `part-b-section1-technology.md`             | Paste-ready text for Part B section 1 (Technology) in the official question order, with a verification table and the verifier's log. Numbers re-derived from the live records on 2026-10-26. |
| `criteria-map.md`                           | The official questions, with where the technical answer is and what is missing.                                                                                                              |
| `claim-ledger.md`                           | Sentences we may write, with evidence, strength and tense; a table of sentences we must not write.                                                                                           |
| `trl-justification.md`                      | Technology readiness of each component, with the evidence and the weakest point.                                                                                                             |
| `work-packages-24m.md`                      | A 24 month plan from TRL 5 to TRL 8 with measurable gates. Costs and headcount are not filled in.                                                                                            |
| `part-a-text.md`                            | Draft title, abstract and keywords for the portal.                                                                                                                                           |
| `pitch-deck-outline.md`, `video-outline.md` | Outlines for the annexes; technical parts drafted.                                                                                                                                           |
| `ai-use-disclosure.md`                      | Draft of the AI tool disclosure the template requires.                                                                                                                                       |
| `company-supplied.md`                       | The facts only the company can provide, and notes on IP.                                                                                                                                     |

## Rules used to write these files

1. Every factual sentence has an evidence pointer and a strength label: PROVEN, PARTIAL,
   BUILT_NOT_MEASURED, NOT_YET or FORBIDDEN.
2. Present tense only for PROVEN. Built and tested but not measured is said exactly so. The rest is
   future tense with a date and a measurable criterion.
3. ARIA's own runtime results are kept apart from engineering by people and sessions. ARIA's
   runtime has been paused since 2026-10-16.
4. Measured negative results are stated, with n and the limits.
5. Positioning: autonomous maintenance of regulated and critical software is the first domain; the
   evidence bound memory and judgment core is the difference; a second domain is a work package,
   not a present claim.

## Verification

An independent reader checked the three source files against the evidence and corrected 26 problems
in place (for example the overclaim "tamper-evident", partition-like counts that overlap, and an
inverted test count). Items left open for the company are listed at the end of each file:
bracketed dates are proposals, not commitments, and numbers that move daily (program counts) must
be re-read before submission. These files were prepared with an AI assistant; see
`ai-use-disclosure.md`.
