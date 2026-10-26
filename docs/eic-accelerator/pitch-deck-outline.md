# Pitch deck outline (10 slides, PDF)

Technical slides are drafted. Slides marked COMPANY need the company's facts. The guide asks for two
to four slides on business model, target market and growth forecast (Guide p.37).

| #   | Slide                                | Content                                                                                                                                                                                                              | Owner                    |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | Title                                | Name, one line, the team                                                                                                                                                                                             | COMPANY                  |
| 2   | The problem                          | Critical and regulated software must be maintained continuously, and a change nobody can trace is a risk. AI agents change code without a checkable record.                                                          | Technical, company edits |
| 3   | The solution                         | ARIA: finds possible defects, has independent judges test each against the code, plans and makes the change, records the outcome. Every committed finding cites repository code. Ledgers are hash chained.           | Technical                |
| 4   | How the evidence binding works       | One diagram: finding, cited lines, judges, plan, change, outcome, ledger. State what is proven (110 of 110 cited references resolve, 0 broken ledger chains) and what is not (no tamper drill yet).                  | Technical                |
| 5   | What has been demonstrated           | ARIA ran nightly cycles on the team's production repository with real continuous integration: 90 cycles, one plan reached a merged change that a person merged. Paused since 16 October 2026. n = 1, stated as such. | Technical                |
| 6   | Measured results, with the negatives | 0 of 13 on planted real defects (practice score). Rule path 3 of 36 against 35 of 36 for a plain model on the same synthetic diffs. Part by part test of the role prompts. What we changed because of it.            | Technical                |
| 7   | Technology readiness and the plan    | Component table from `trl-justification.md`; the TRL 5 evidence we will have, and the 24 month plan to TRL 8 with measurable gates.                                                                                  | Technical                |
| 8   | Market and customers                 | Size, share, who adopts and why, pilot candidates.                                                                                                                                                                   | COMPANY                  |
| 9   | Business model and growth            | Who pays, price, contract form, growth forecast.                                                                                                                                                                     | COMPANY                  |
| 10  | Team, funding need and ask           | Team and gaps, investors, financing round, why EIC money, the amount.                                                                                                                                                | COMPANY                  |

Use the claim ledger for every sentence on slides 3 to 7: only sentences labelled PROVEN or PARTIAL
in the present or past tense, the rest as plans with a date.
