# ARIA deck: slide-by-slide specification for Claude Design

Prepared 26 September 2026 for the DNB NXT Accelerator (Startuplab). The deck has 12 main slides plus a 5-slide appendix, in English.

**Who reads it.** Non-technical reviewers at DNB and Startuplab, and an AI screening tool. The deck will be uploaded and read **without a presenter**, so every caveat that matters is printed on the slide itself, not only in the notes.

**Rule zero.** Print every number exactly as written here. Do not round, add, invent or "improve" any number, logo, customer, quote or screenshot.

---

## 0. Paste this into Claude Design first

> Build a 16:9 presentation (1920 × 1080) from the specification below. Follow the global style in section 1 exactly: palette, fonts, labels and grid.
>
> For each slide, render only the parts marked **On-slide text**, **Visual** and **Footer source line**. Put **Speaker notes** into the presenter notes. Never render the parts marked **Evidence (do not render)**.
>
> Render `[TO FILL: …]` and `[verify]` as small amber pills; the founder removes them before export.
>
> Do not use stock photos, logos of DNB, Vipps, Startuplab or competitors, fish-farm photos, robot images, or dashboards that suggest customers.

---

## 1. Global style (every slide)

### Grid and density

- 16:9 at 1920 × 1080, on a 12-column grid with 96 px outer margins and 32 px gutters.
- One message per slide, with about 40 words of on-slide text at most (diagram labels excluded). Numbers carry the slide.
- The footer appears on every slide except 1 and 12:
  - left: the **source line** (11 pt, Slate), in plain words with no internal codes;
  - centre: "ARIA · a SUDERRA AS spin-off in formation";
  - right: "n / 12".

### Palette (hex)

| Role             | Name         | Hex       | Use                                                     |
| ---------------- | ------------ | --------- | ------------------------------------------------------- |
| Light background | Paper        | `#F7F5F0` | Default slide background                                |
| Dark background  | Deep sea     | `#0F2233` | Slides 1 and 12 only                                    |
| Primary text     | Ink          | `#0F2233` | Headlines and body on light slides                      |
| Secondary text   | Slate        | `#4A5A6A` | Sub-headlines, captions, sources                        |
| Accent           | Fjord teal   | `#0F766E` | The **one** emphasised number or element per slide      |
| Neutral data     | Mist         | `#C9D3DC` | Other bars, dividers, card borders                      |
| Rejected         | Clay         | `#9F3A2C` | "Thrown out" / "false alarm" segments only              |
| Draft marker     | Signal amber | `#B45309` | `[TO FILL]` and `[verify]` pills; removed before export |

- One accent colour per slide, besides the status labels.
- No gradients, no shadows heavier than 4 px blur, and no stock photos.

### Typography

- Headlines: **Inter SemiBold**, 44–48 pt, sentence case.
- Sub-headlines: Inter Regular, 24–26 pt, Slate.
- Body: Inter Regular, 18–20 pt minimum.
- Big numbers: Inter Bold, 60–72 pt, with tabular figures.
- Evidence text (file paths, versions, fingerprints; appendix A2 only): IBM Plex Mono, 16–18 pt.
- Source lines: Inter, 11 pt, Slate.

### Status labels (exactly three; use them identically everywhere)

Each label is a pill in 12 pt Inter SemiBold, capitals, with 6 × 12 px padding, placed top-right of the block it labels.

| Label text         | Meaning (print this exact meaning in any legend)          | Style                                              |
| ------------------ | --------------------------------------------------------- | -------------------------------------------------- |
| **LIVE**           | Has run for real on our own code, with records.           | Fill `#15803D`, white text                         |
| **BUILT · NOT ON** | The code exists and is tested, but it is not switched on. | Fill `#1D4ED8`, white text                         |
| **NOT BUILT**      | An idea only.                                             | No fill; 1.5 px dashed `#6B7280` border; grey text |

- A "small" or "stopped" caveat is written as a plain one-line footnote, never as an extra symbol.
- Show a legend strip (the three pills plus their meanings, 12 pt) at the bottom of slides 4, 6 and 7.

### Programme fit (a note for the designer; do not render it as tags)

DNB NXT's focus areas are Sustainability and resilience, FinTech, RegTech, PropTech, AI and Loyalty. The deck signals the ones ARIA truly touches through plain words, never as labels or buzzword tags:

- **AI:** everywhere.
- **RegTech:** "auditors", "regulators", "compliance", "who approved it".
- **FinTech:** "banks, payment and insurance companies".
- **Resilience:** "contained and reversed".
- **Sustainability:** only through the fish-welfare and food-production origin, and the greenhouse idea.

Do not add tag chips, programme logos or the words "FinTech", "RegTech", "PropTech" or "Loyalty" to any slide.

### Icons

Use one line-icon set (Lucide style, 2 px stroke, Ink):

- proof check: `file-search`
- AI judges: `scale`
- sealed record: `link`
- memory: `archive`
- lock and undo: `shield` + `undo-2`
- person: `user-check`
- plug-in: `plug`
- AI model: `bot`

---

## Slide 1: Title

**On-slide text**

- Headline: **ARIA**
- Sub-headline: **An audit trail for AI work. Software first; other fields via plug-ins.**
- Line 3: A spin-off of SUDERRA AS, Norway (company in formation). Grown out of building our own fish-farm software with AI agents.
- Line 4 (Slate, 22 pt): For teams that must show auditors how AI-written software was checked.

**Visual**

- Deep-sea background. Text is left-aligned in columns 1–7, and the word ARIA is Paper white at 120 pt.
- Columns 8–12 hold a quiet "sealed record" motif. Five rounded rectangles sit in a row, each joined to the next by a short chain link. Use plain linked blocks: no fingerprints, no padlock (the record is tamper-evident, not tamper-proof). The motif carries no text and no data.
- Place no status labels on this slide.

**Speaker notes**
ARIA checks what AI says about software against the real code, and it keeps a sealed record of every check. We did not plan it. We needed it while building our own fish-farm software with AI coding agents. ARIA will become its own company, spun out of SUDERRA AS; it is not yet incorporated. We think its first customers are teams that must answer to auditors, such as banks. Every capability in this deck carries one of three labels: live, built but not switched on, or not built.

**Footer source line:** none on this slide.

**Evidence (do not render):** E-041, E-031, E-027, FI (spin-off, not incorporated), line 4 is our positioning (hypothesis), not a customer result.

---

## Slide 2: The problem, and why now

**On-slide text**

- Headline: **AI agents now write code every day. Checking their work has not kept up.**
- Definition line (Slate, 20 pt): _AI coding agents: AI programs that write and change software, such as Claude Code and GitHub Copilot._
- Three stat tiles:
  1. **68%**: professional developers who use AI coding agents at work every day (mid-2026) `[verify]`
  2. **96% / 48%**: do not fully trust AI-generated code / always check it before committing (2026) `[verify]`
  3. **9 seconds**: April 2026, an AI coding agent deleted a company's production database and its backups `[verify]`
- Small line under the tiles (18 pt, Slate): "Rules are arriving: in the EU, AI Act duties have applied in stages since February 2025." `[verify]`
- Bottom line (24 pt, Ink): **When an agent says "done": what did it check, in which version of the code, and who approved it?**

**Visual**

- Three equal tiles on white cards with a 1 px Mist border. The big figure is in Ink and the one-line label sits under it.
- Tile 2 (96% / 48%) is in Fjord teal: the gap between distrust and checking is the theme.
- No chart: the three figures measure different things.

**Speaker notes**
In mid-2026 two thirds of professional developers use AI coding agents every day. Almost all of them say they do not fully trust what the AI writes, yet fewer than half always check it before it goes in. In April this year an agent deleted a company's production database and its backups in nine seconds, with an access key it found in an unrelated file. After an incident like that, three questions matter. What did the agent check? In which version of the code? Who approved it? Those three questions are the problem ARIA answers.

**Footer source line:** JetBrains Developer Ecosystem Survey 2026 · Sonar State of Code Developer Survey 2026 · The Register, 27 Apr 2026 · EU AI Act

**Evidence (do not render):** N-01, N-02, N-05 (market_2026.md), M-036 — all [S]: the founder must open each source page.

---

## Slide 3: We lived the problem first

**On-slide text**

- Headline: **We lived the problem first.**
- Sub-headline: AI agents wrote code for us. We built rules and automatic checks around them. Those rules became ARIA.
- Three stat tiles:
  1. **~2.2 million** lines of code: our fish-farm platform, its sensor gateway and ARIA (about 30% tests)
  2. **1,703+** of 6,888 saved changes carry an AI agent's mark (73% in September 2026)
  3. **2,178** problems logged by our AI reviewers, **80%** fixed
- Timeline (five nodes; dates exactly as given):

| #   | Date     | Label on slide                                   |
| --- | -------- | ------------------------------------------------ |
| 1   | Nov 2025 | Fish-farm platform starts                        |
| 2   | Feb 2026 | First AI-agent changes; AI reviewer roles        |
| 3   | Apr 2026 | Problem log; "every fix names its problem" check |
| 4   | May 2026 | ARIA begins, built on what the rules taught us   |
| 5   | Aug 2026 | ARIA starts nightly runs on our own code         |

- Small caption under tile 2 (12 pt Slate): "Lower bound: only changes with a visible AI mark are counted."

**Visual**

- Top half: the three tiles, with tile 2 in Fjord teal.
- Bottom half: a horizontal timeline. Nodes 1–3 sit on a Slate band labelled "Our rules for AI agents", and nodes 4–5 on a Fjord-teal band labelled "ARIA". A small arrow joins the bands, labelled "lessons carried into its own core".
- No status labels. These are history facts, not ARIA capabilities.

**Speaker notes**
We started in November 2025 by building operations software for fish farms. From February 2026, AI coding agents wrote code for it: at least 1,703 of our 6,888 saved changes carry an agent's mark, and 73 percent did in September. To keep the agents honest, we built rules: AI reviewer roles, a log of every problem found, and a check that every fix names its problem. In May we started ARIA on what those rules taught us, and in August it began running on our own code.

**Footer source line:** SUDERRA's own repository records, 26 Sep 2026

**Evidence (do not render):** E-004, E-005, E-006, E-013, E-014, E-015, E-021, E-023, E-027. Merge wording: fact audit issue 1 plus the founder's input. Do not say "people merged every change".

---

## Slide 4: What ARIA does

**On-slide text**

- Headline: **ARIA checks AI work against the real code. It does not do the work.**
- Four capability blocks, each with an icon, a name, one line and a label:

| Block                      | One line on the slide                                                                                            | Label    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- |
| Proof check                | Throws out AI answers whose quoted file is not in the exact code version (checked by fingerprint).               | **LIVE** |
| Several AI judges          | A judged problem becomes official only after at least two AI judges rule and a clear majority agrees (5 so far). | **LIVE** |
| Sealed record              | Each record is sealed to the one before, so a later edit would show.                                             | **LIVE** |
| Memory with an expiry date | Each fact is tied to a code version and re-checked when its files change.                                        | **LIVE** |

- Bottom line (Ink, 22 pt): **ARIA has not yet changed or approved any code by itself. That is the next step (slide 6).**
- Footnote (12 pt): "Today it checks its own AI judges and planners, on our code only. Memory is small: 8 proven facts."

**Visual**

- A three-layer diagram:
  - **Top band:** "AI models ARIA works with today". Two chips: "Anthropic" and "Z.ai". A third, dashed chip reads "coding agents (ours today: Claude Code, via MCP)".
  - **Middle band:** "ARIA", holding the four blocks side by side, with a Fjord-teal outline.
  - **Bottom band:** two boxes, "The team's code store (git; today, ours)" and "The team's people".
- Four arrows, each labelled:
  1. AI models → ARIA: "answers that cite a file (and line)"
  2. ARIA → AI models (Clay): "thrown out if the file does not match"
  3. ARIA → Code store: "reads the exact saved version; writes sealed records"
  4. ARIA → People: "findings and daily reports"
- Put the legend strip at the bottom.

**Speaker notes**
Think of ARIA as a quality department for AI. The idea: AI does the work, and ARIA checks it. Today ARIA checks its own AI agents, its judges and planners, on our code. When one of them cites a file, ARIA checks it against the exact saved version of the code by its digital fingerprint, and throws the answer out if it does not match. When the judges review a flagged problem, it only becomes official after at least two of them have ruled and a clear majority agrees. Everything goes into a record where each entry is sealed to the one before. Its memory is small today, eight facts, each tied to a code version. ARIA does not yet change or approve code by itself.

**Footer source line:** SUDERRA's own repository records, 26 Sep 2026

**Evidence (do not render):** E-041, E-059, E-062 (consensus ≥2 judges, avg ≥0.80), E-031, E-061, E-032, E-034, E-040, E-053, E-057. The live checks ran on ARIA's own AI agents (judges, arbiter, planners), not on coding agents; the 24 rejections were 17 judge/arbiter and 7 planner answers (e2e audit M1). Consensus: ≥2 judges rule, weighted majority >60%, average ≥0.80; in all 5 promotions both judges agreed.

---

## Slide 5: Seven weeks on our own code

**On-slide text**

- Headline: **Seven weeks of ARIA on our own code.**
- Four big numbers (all **LIVE**):
  1. **43** nightly runs started, 5 Aug–20 Sep 2026 (30 completed)
  2. **24** AI answers thrown out: the quoted file did not match the code
  3. **87 of 157** AI-judge verdicts said "false alarm"
  4. **88,890** sealed records; all pass the check
- Example box: **"Our own compliance document promises an automatic check that scans every new problem-log entry for personal data: e-mail addresses, phone numbers, bank-account (IBAN) and card numbers. ARIA found that the check does not exist in the code, and recorded the exact file, line and version. Two AI judges, from two companies, agreed. The finding is still open."**
- Footnote (12 pt): "Nightly runs paused on 21 Sep 2026; the cause is found and a fix is in review. 157 verdicts cover 75 flagged problems; 148 were single-judge verdicts."

**Visual**

- Left 55%: a 2 × 2 grid of number tiles. Tile 2 (24) is in Fjord teal; the others are Ink.
- Under the grid, one horizontal stacked bar titled "AI-judge verdicts (157)":
  - "real problem" 70 in Fjord teal;
  - "false alarm" 87 in Clay.
  - Data labels sit inside the segments, and the x-axis reads "number of verdicts".
- Right 45%: the example box, on white with a 1 px Mist border. Put a small grey outlined pill reading "OPEN" at its top-right; do not make it green.
- No file path or code version on this slide; show them only in appendix A2, and only after checklist item 1 is done.

**Speaker notes**
ARIA has run on our own code since August. It started forty-three nightly runs, and thirty completed. It threw out twenty-four answers from its own AI agents because the file they quoted did not match the code. Its AI judges gave 157 verdicts, and 87 said "false alarm". Here is one real example. Our own compliance document promises a check that scans the problem log for personal data. ARIA found that the check does not exist in the code, and two judges agreed. That finding is still open. The nightly run has been paused since September twenty-first; we found the cause, and the fix is in review.

**Footer source line:** SUDERRA's own repository records (ARIA state branch), 26 Sep 2026

**Evidence (do not render):** E-030, E-041, E-039 (157 = verdict rows; ≤94 distinct findings; 148 single-judge), E-031, E-042 (F-012; ADR-024 line 41 names `tools/gates/findings-pii-scan.ts` as a gate scanning for e-mail, phone, TC kimlik, IBAN and card patterns; the file is missing on `main`, re-checked 26 Sep 2026). 157 verdicts cover 75 distinct finding ids (e2e audit). Nightly-failure cause: each finding was appended one row at a time with a full chain re-verification (57.5 MB ledger), so the tools phase outgrew its 14,959 s budget; the publish then also exceeded the surface cap (unit U).

---

## Slide 6: The trust ladder

**On-slide text**

- Headline: **ARIA must earn each permission.**
- Four rungs, drawn from the bottom up:

| Rung | Text on the slide                                                                                                                                                                                                                           | Label                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1    | Look and report                                                                                                                                                                                                                             | **LIVE**                                                                              |
| 2    | Judge with several AI models (flagged problems)                                                                                                                                                                                             | **LIVE**                                                                              |
| 3    | Write a fix inside a sealed test box                                                                                                                                                                                                        | **BUILT · NOT ON** (never used for a real change)                                     |
| 4    | Approve only documentation changes and new tests (never edits to existing tests), with a person's time-limited permission. If the tests then fail because of that change, it locks itself and starts an undo, so a bad change is contained. | **BUILT · NOT ON** (lock and undo; permission step and new-tests rule in development) |

- Side note beside rung 4 (14 pt): "Before rung 4: fix the problems our own safety reviews found, and complete 30 successful trial runs. The lock and undo are built; the permission step and the new-tests rule are in development."
- Footer line (Ink, 22 pt): **Everything else always needs a person to approve it.**

**Visual**

- A vertical ladder occupies the left 60%. The four rungs are wide rounded bars:
  - rungs 1–2 are solid, with a Fjord-teal border;
  - rungs 3–4 are outlined in Mist, with a blue label.
- A small "you are here" marker in Fjord teal sits between rungs 2 and 3.
- The right 40% holds four stacked lane cards:
  - "Documentation and new tests: ARIA may approve, after a person's permission" (the only card outlined in Fjord teal);
  - "Changes to existing tests: a person approves" (grey);
  - "Product code: a person approves" (grey);
  - "ARIA's own rules: a person approves" (grey).
- Put the legend strip at the bottom.

**Speaker notes**
ARIA has to earn each permission, one rung at a time. Today it looks, reports and judges, on our own code. The next rungs are built but not switched on. First comes writing a fix inside a sealed test box. Then comes approving only documentation changes and new tests, with a person's time-limited permission. It may add tests, never weaken existing ones. If the tests then fail, ARIA locks itself and starts an undo. Before that rung, we must fix the problems our own safety reviews found and complete thirty successful trial runs. Product code and ARIA's own rules always need a person.

**Footer source line:** SUDERRA's own repository records and ARIA design documents, 26 Sep 2026

**Evidence (do not render):**

- E-030, E-039, E-046, E-049, E-050, E-051 (self-revert and freeze on `main`), E-052.
- The merge-lane grant is on a working branch, not on `main`.
- 28 open findings, 3 critical: keep these counts out of the slide and in reserve for Q&A.
- `self_revert.py` triggers on an attributable post-merge CI red or a regression verdict. It freezes first, then opens the revert.

---

## Slide 7: One core, plug-ins per field

**On-slide text**

- Headline: **One core. Plug-ins for each field. Software is the first.**
- Left panel, "The core (designed to be general)", as five short lines:
  - Proof check against an exact version **LIVE**
  - Sealed record **LIVE**
  - Facts that expire **LIVE**
  - Several AI judges **LIVE**
  - Trial period for every new checker **LIVE** (none has passed it yet)
- Middle strip: "A plug-in = a description file + a small checking program. Fields whose records are not kept in git also need a new evidence store in the core."
- Right side: four idea cards, ordered from nearest (top) to farthest (bottom):

| #   | Card title                              | What exists / what is missing                                                                                                 | Label                  |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | **Software teams using AI**             | 11 checkers, all for software; 9 have run on our own code. Needs packaging for other teams.                                   | **LIVE** (on our code) |
| 2   | **Banks' own rules (audit checks)**     | The software checkers that fit a bank's code, plus new checks for the bank's own rules. Those checks are not built.           | **NOT BUILT**          |
| 3   | **Law firms (documents and contracts)** | Documents would need to be stored with version history, plus new checkers.                                                    | **NOT BUILT**          |
| 4   | **Greenhouses (food production)**       | Growing records would need a new evidence store and new checkers. Our platform has a hydroponics calculator (front end only). | **NOT BUILT**          |

- Footer caveat (14 pt, Slate): "Of ARIA's 310 main modules, 19 mention fish farming (mostly in comments) and 70 mention GitHub or pull requests. Its ties are to software, not to fish."

**Visual**

- Left 35%: a rounded "core" panel with a Fjord-teal outline, holding the five lines with their labels.
- Centre: a thin vertical "plug" rail with a `plug` icon and the middle-strip sentence.
- Right 55%: four horizontal cards stacked top to bottom. Card 1 has a solid border; cards 2–4 have dashed borders. A small arrow on the far right runs from "near" (top) to "far" (bottom).
- No hub-and-spoke drawing, no product names, no logos.
- Put the legend strip at the bottom.

**Speaker notes**
ARIA's core is not about fish. The proof check, the sealed record, facts that expire and the AI judges are all designed to be general. A new field plugs in through plug-ins: a description file and a small checking program; a field whose records are not in git also needs a new evidence store. Today all eleven plug-ins check software. The nearest next step is a bank's own rules, because a bank's systems are still software: the software checkers that fit, plus new checks for the bank's rules. Law firms and greenhouses are further away. They would need their records stored with version history and new checkers. None of those is built.

**Footer source line:** SUDERRA's own repository records, 26 Sep 2026

**Evidence (do not render):** E-078, E-079, E-080, E-081 (re-measured on `main`: 70 of 310 GitHub, 19 of 310 farm), E-082, E-035, E-076 (hydroponics UI built, backend a scaffold), E-032, E-034.

---

## Slide 8: First customers, and DNB

**On-slide text**

- Headline: **First: Norwegian software teams that use AI and must show auditors who checked what.**
- Three short blocks:
  1. **Who:** the software teams of banks, payment and insurance companies first (a hypothesis).
  2. **Offer:** a read-only pilot. ARIA looks and reports, and never changes the customer's code. The pilot measures errors and rework.
  3. **Our ask of DNB:** one software team, for a read-only test. We have no collaboration with DNB today.
- Footnote (12 pt): "What a bank will ask first: code is sent to cloud AI models (Anthropic, Z.ai) during checking. A self-hosted model is not built."

**Visual**

- Three horizontal blocks, each with an icon (`users`, `eye`, `handshake`). Block 3 is outlined in Fjord teal.
- No logos. Write "DNB" in plain text.

**Speaker notes**
We will start where audits are routine: the software teams of banks, payment and insurance companies. That is our hypothesis, and this programme is where we want to test it. The offer is a read-only pilot. ARIA looks and reports, never changes the customer's code, and measures errors and rework. Our ask of DNB is one software team for a read-only test. We have no collaboration with DNB today. We will say the hard part up front: during checking, code goes to cloud AI models, and a self-hosted option is not built yet.

**Footer source line:** Our plan; not yet tested with customers

**Evidence (do not render):** FI (no customers, no DNB collaboration), J-20, J-3, J-36, M-005 [verify: cohort #5 financial-services focus].

---

## Slide 9: Market

**On-slide text**

- Headline: **One market, sized bottom-up. The price is our assumption.**
- Equation stack:
  - 36.5M professional developers worldwide `[verify]`
  - × 68% use AI coding agents every day (2026) `[verify]`
  - = 24.8M developers
  - × USD 20 per developer per month (assumption) × 12
  - = **≈ USD 5.96 bn a year**
- Three small lines under the stack:
  - "Cross-check: analysts put AI code tools at USD 7.37–7.65 bn in 2025, growing about 24–26% a year `[verify]`. Different category, so a loose check."
  - "Two sources, two dates: an estimate, not a measurement."
  - "Norway: [TO FILL]"
- Illustration box: "Illustration, not a forecast: 40 organisations × 50 developers × USD 20 × 12 = USD 480,000 a year (about 0.008%)."

**Visual**

- A vertical equation stack in the left 60%, with the operators in a narrow gutter. The total is Inter Bold 56 pt in Fjord teal.
- Put the word "assumption" as small grey text beside the price, not as a pill.
- The illustration box sits in the right 40%, on a Mist fill.
- No pie charts and no TAM/SAM/SOM circles.

**Speaker notes**
We size one market bottom-up. There are thirty-six and a half million professional developers, and in 2026 about two thirds of them use AI coding agents every day. At an assumed twenty dollars per developer per month, that is about six billion dollars a year. The price is our assumption; a known code-review tool lists twenty-four dollars. Analysts put the AI code tools market above seven billion dollars and growing about a quarter a year. We will measure Norway first.

**Footer source line:** SlashData · JetBrains Developer Ecosystem Survey 2026 · Research and Markets / Mordor Intelligence 2025 · CodeRabbit pricing page

**Evidence (do not render):** N-06, N-01, N-07 (market_2026.md), M-050. The arithmetic: 36,500,000 × 0.68 = 24,820,000; × 20 × 12 = 5,956,800,000; 480,000 / 5,956,800,000 ≈ 0.008%.

---

## Slide 10: Business model and competition

**On-slide text**

- Headline: **A subscription per developer. Others review code; ARIA keeps the proof.**
- Left column, "How we charge":
  - USD 20 per developer per month (assumption)
  - Watch-only plan: proof checks, AI judges, sealed record **LIVE** (on our own code)
  - Approval plan: documentation and new tests only, with a person's permission **BUILT · NOT ON** (lock and undo only; permission step and new-tests rule in development)
  - Revenue to date: none
- Right column, "Closest tools":
  - **Qodo, CodeRabbit:** AI review of proposed code changes `[verify]`
  - **ARIA:** proof against the exact code version, several AI judges, and a sealed record
- Footnote: "Based on public descriptions; not tested hands-on."

**Visual**

- Two columns with a thin vertical divider. The price line is Inter Bold 36 pt.
- In the right column, "ARIA" carries a teal left border.

**Speaker notes**
We will charge a subscription per developer whose AI work ARIA checks. The twenty-dollar price is an assumption we will test. The watch-only plan is what runs on our own code today. An approval plan comes later, for documentation and new tests only, and always with a person's permission. We have no revenue yet. The closest tools, such as Qodo and CodeRabbit, review proposed code changes. ARIA is built around proof: nothing counts unless it points to an exact file, checked by its fingerprint, in an exact version of the code. We have not tested those tools ourselves.

**Footer source line:** Qodo and CodeRabbit public websites · our plan

**Evidence (do not render):** M-059, M-060, E-031, E-039, E-041, E-049, E-051, FI (no revenue). Plug-in add-on pricing is a founder decision.

---

## Slide 11: Team

**On-slide text**

- Headline: **Two full-time founders. We can show the build. Sales is what we are here to learn.**
- Two founder cards:
  - **Okan Öztürk**: [TO FILL: role] · [TO FILL: one-line background] · linkedin.com/in/okanozturk-suderra
  - **Duygu Öztürk**: [TO FILL: role] · [TO FILL: one-line background] · linkedin.com/in/duygukayaozturk
- "What we have built" (three short lines):
  - A 2.2-million-line codebase with AI agents (platform, sensor gateway, ARIA)
  - The rules and checks we built around those agents
  - ARIA: about 175,000 lines of core code, checked by about 7,000 automatic tests
- "What we need" (Fjord teal): **First customers, pilots and a sales process.**

**Visual**

- Two portrait circles in Mist. Use real photos only if the founders supply them; never stock photos.
- The "What we need" line sits bottom-right in Fjord teal.

**Speaker notes**
We are two full-time co-founders, Okan and Duygu Öztürk. [TO FILL: roles and one line each on background.] We built a codebase of about two point two million lines with AI agents. We built rules and checks around those agents, and ARIA grew out of those rules. Its core is checked by about seven thousand automatic tests. What we need most is commercial: first customers, pilots and a sales process. That is why we are applying.

**Footer source line:** SUDERRA's own repository records, 26 Sep 2026

**Evidence (do not render):** FI, E-004, E-005, E-009 (6,931 and 6,976 tests in two CI runs), E-029, M-012 [verify].

---

## Slide 12: The ask

**On-slide text**

- Headline: **We are raising NOK 5 million.**
- Three lines:
  - From Startuplab: NOK [TO FILL]; the rest from [TO FILL]
  - Runway: [TO FILL] months
  - Company: ARIA, a SUDERRA AS spin-off in formation (not yet incorporated)
- "In 12 months" (goals, not promises):
  - [TO FILL: N] read-only pilots with software teams outside SUDERRA
  - A measured pilot result: errors and rework, with and without ARIA
  - ARIA's first approval of a documentation change or a new test, with a person's permission
  - A version other teams can install
- Contact block:
  - **Okan Öztürk** · okan@suderra.com `[verify: founder confirms the contact address]`
  - Walk-through of ARIA's live records on request
  - Where ARIA was born: app.suderra.com (demo account on request)
- Closing line (Fjord teal): **Ask us for a demo. Bring a real problem.**

**Visual**

- Deep-sea background. "NOK 5 million" is in Paper white, Inter Bold 72 pt.
- The contact block sits bottom-left, and the closing line bottom-right.
- No partner logos.

**Speaker notes**
We are raising five million kroner. [TO FILL: how much from Startuplab, and where the rest comes from.] The money turns ARIA from something that runs on our own code into something another team can run. In twelve months we aim for our first read-only pilots, a measured result, and ARIA's first approval of a low-risk change with a person's permission. We would like to test this with one DNB software team. That is a hypothesis, not an agreement. Ask us for a demo, and bring a real problem.

**Footer source line:** none on this slide.

**Evidence (do not render):** FI (NOK 5M, contact, spin-off), M-002, M-004 and M-010 [verify: the range conflicts]. Closing line from the old deck, slide 8.

---

# Appendix (backup slides; label each "Appendix" in the top-left corner)

## A1: Is this just RAG?

**On-slide text**

- Headline: **A retrieval pipeline finds relevant text. ARIA checks it against the code.**
- Definition line (Slate): _RAG (retrieval-augmented generation) looks up passages in an index and gives them to the AI model before it answers._
- Table:

| Question                                               | A retrieval pipeline on its own                                                                 | ARIA                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Is the quoted file really in that version of the code? | Returns text from its index. It does not, by itself, check the text against a versioned source. | Checks the file's fingerprint at an exact code version and throws out mismatches: 24 so far. **LIVE**                                |
| Can the system quote itself as proof?                  | Can re-index and retrieve what its own model wrote.                                             | Its own output never counts as evidence: 2 answers thrown out for trying. **LIVE**                                                   |
| Is the memory tamper-evident?                          | A vector index on its own is not.                                                               | 88,890 sealed records, all pass the check. **LIVE**                                                                                  |
| Who decides a problem is real?                         | One generator; no judging step.                                                                 | For judged problems, at least two AI judges rule and a clear majority must agree (average ≥ 0.80): 5 so far, all unanimous. **LIVE** |
| Which code version is a fact about?                    | Does not track this by default.                                                                 | Each fact is tied to a version and re-checked when its files change. **LIVE** (8 facts)                                              |
| **Finding things by meaning**                          | **Better.** Semantic search over large text collections.                                        | Searches by exact words today. Search by meaning: **BUILT · NOT ON** (no model configured).                                          |
| **E-mail, scans, documents outside git**               | **Better.** Works on unstructured collections.                                                  | Needs material in git with file-and-line references. Other sources: **NOT BUILT**.                                                   |

- Bottom line: **They can work together.**

**Visual**

- A full-width table with alternating Paper and white rows.
- A thin teal divider sits above the last two rows, labelled "Where a retrieval pipeline is better". The word "Better." is in Fjord teal.

**Speaker notes**
People ask whether this is just RAG. RAG looks up relevant text and hands it to the AI, and it is good at that. On its own, though, it does not check the quoted text against the current code, it does not stop the model quoting itself, and its index is not tamper-evident. ARIA does those three things. Retrieval is better at search by meaning and at e-mail or scanned documents. ARIA searches by exact words today and needs its material in git. The two can work together.

**Footer source line:** SUDERRA's own repository records, 26 Sep 2026 · Lewis et al. 2020 (RAG)

**Evidence (do not render):** E-059, E-060, E-061, E-062, E-063, E-065, E-066, E-054, E-041, M-071. Never write "RAG can't".

## A2: The F-012 evidence card in full

**Include only after checklist item 1 is done.**

**On-slide text**

- Headline: **One real ARIA finding, with its evidence.**
- Evidence card (IBM Plex Mono):

```
FINDING F-012                                        status: OPEN
Claim        A design document names a check that does not exist
Evidence     docs/adr/024-compliance-retention-matrix.md, line 41
Names        tools/gates/findings-pii-scan.ts  →  not in the code
Code version e9fd27bf
Fingerprint  sha256:32bd3133ccaf25d4…
Trust grade  repo_verified
Judged by    2 AI judges (Anthropic, Z.ai) agreed; average above ARIA's 0.80 bar
Re-checked   by us, 26 Sep 2026: file still missing; fingerprint matches
```

- Four plain callouts:
  1. "The exact file and line."
  2. "The exact saved version it was checked against."
  3. "A digital fingerprint. If the file had changed, it would not match."
  4. "Two AI judges from two companies agreed."
- Bottom line: "ARIA holds 13 findings: 5 confirmed by AI judges, like this one, and 8 from a simpler automatic rule. All 13 are open."

**Visual**

- The card is on white with a 1 px Mist border, and "OPEN" is a grey outlined pill.
- The only teal text is "fingerprint matches".

**Speaker notes**
This is a real finding. Line forty-one of our compliance document says a check scans the problem log for e-mail addresses and phone numbers. That check does not exist in the code. ARIA recorded the file, the line, the code version and a fingerprint, and two AI judges agreed. It is still open.

**Footer source line:** SUDERRA's own repository records (ARIA state branch), 26 Sep 2026

**Evidence (do not render):** E-042. Do not add "anyone can re-check it", and give no repository link until checklist item 1 is done.

## A3: AI-agent share of our changes, by month

**On-slide text**

- Headline: **Share of our saved changes carrying an AI agent's mark, by month (2026). Lower bound.**
- A vertical bar chart:

| Month         | Value | Label above the bar |
| ------------- | ----- | ------------------- |
| Feb           | 61%   | 150/244             |
| Mar           | 3%    | 17/518              |
| Apr           | 7%    | 144/1,933           |
| May           | 2%    | 9/500               |
| Jun           | 0.2%  | 1/423               |
| Jul           | 62%   | 607/983             |
| Aug           | 5%    | 18/372              |
| Sep (to 26th) | 73%   | 621/855             |

- Axes:
  - x: "Month (2026)";
  - y: "% of regular saved changes with an AI mark", 0–100, with gridlines at 25, 50 and 75.
- All bars are Mist except Sep, which is Fjord teal.
- Caption: "Marks are an AI author, a session link or a co-author line. From 6 April our own rulebook told agents not to add co-author lines, so later months undercount. March came before that rule, and git cannot tell us why its share is low."

**Speaker notes**
The share of changes with an AI mark swings by month, and it is a lower bound. After April, our rulebook told agents not to sign as co-authors, so many AI changes carry no visible mark. In September, 73 percent carried one.

**Footer source line:** SUDERRA's own repository records, 26 Sep 2026

**Evidence (do not render):** E-014, E-015, fact audit issue 20.

## A4: Where ARIA was born: SUDERRA's fish-farm platform

**On-slide text**

- Headline: **Where ARIA was born: SUDERRA's fish-farm platform.**
- Six short lines, each marked in plain text "Built; demo only, no customers" (no status pill):
  - Farm, pond and fish-batch management
  - Feeding plans, planned versus actual
  - Water chemistry and sensors, including industrial protocols (Modbus, OPC UA, Siemens S7)
  - Deaths recorded by cause (13 categories)
  - Staff, shifts and messaging
  - Hydroponics calculator (front end only)
- Footer line: "Demo: app.suderra.com (demo account on request). No customers yet."

**Visual**

- A two-column list. Add a real screenshot of app.suderra.com **only** if the founder supplies one, with the caption "Demo. No customers yet."
- No fish photos.

**Speaker notes**
This is the platform where ARIA was born. It is built and has a demo, but no customers yet. ARIA checks this platform's code, not its farm data.

**Footer source line:** SUDERRA's own repository records, 26 Sep 2026

**Evidence (do not render):** E-068 to E-076, E-077, FI.

## A5: Where ARIA sits among other tools

**On-slide text**

- Headline: **Coding agents write. Review tools comment. ARIA keeps the proof.**
- Table:

| Group                   | Examples                                      | What they do (from public descriptions)           |
| ----------------------- | --------------------------------------------- | ------------------------------------------------- |
| AI coding agents        | Claude Code, GitHub Copilot, Devin `[verify]` | Write code, run tests, propose changes            |
| AI code review          | **Qodo**, **CodeRabbit** `[verify]`           | Review proposed changes (our closest competitors) |
| AI governance platforms | Credo AI `[verify]`                           | AI policy and risk at company level               |
| Runtime guardrails      | Guardrails AI, Lakera `[verify]`              | Guard what goes into and out of an AI model       |

- Footnote: "From public descriptions only. We have not tested these tools, and we make no claim about what they lack."

**Speaker notes**
Coding agents write the code, and review tools comment on it. Governance platforms work at policy level, and guardrails watch model inputs and outputs. ARIA's place is the proof: exact file, exact version, several judges, and a sealed record.

**Footer source line:** Public product websites, retrieved 26 Sep 2026

**Evidence (do not render):** M-059, M-060, M-061, M-064, M-065, M-066, M-067.
