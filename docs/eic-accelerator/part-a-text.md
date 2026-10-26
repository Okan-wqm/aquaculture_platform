# Part A text (draft for the portal fields)

The company edits and confirms every field. Character limits are from the template (p.4).

## Title (at most 200 characters, understandable to non-specialists)

Auditable autonomous maintenance of critical software: an AI agent that ties each claim to cited
evidence

## Abstract (at most 2000 characters)

Software that runs critical and regulated systems has to be maintained continuously, and the
people who must trust the changes need to see why each change was made. Current AI coding agents
produce changes without a checkable record of the evidence behind them. ARIA is an autonomous
maintenance agent for such code bases. It finds possible defects, has independent judges test
each one against the code, plans and makes the change, and records the outcome. Every finding it
commits cites repository code, and its ledgers are hash chained, so that a reviewer or an auditor
can check what the agent knew and why it acted.

ARIA has run on the team's own production code base with real continuous integration. One of its
plans reached a merged change (a single example, which a person merged); it has not yet merged
anything by itself. We state the measured results with their limits, including negative ones: on
planted real defects its discovery rate was 0 of 13, which is why the next phase moves discovery to
a language model reading each change, with the same evidence rules. The project funds the step from
validated prototype to a demonstrated system: measured discovery against a plain model arm,
operation outside our own repository at pilot customers, and an independent examination board
that will have to approve any change ARIA makes to itself. The aim is maintenance of critical
software with evidence an auditor can verify.

## Keywords

Select up to three from the taxonomy in the portal (software engineering and AI are the closest
fields). Free keywords (200 characters): autonomous software maintenance, evidence-bound AI,
auditable AI agents, regulated software.
