# ARIA: DNB NXT Accelerator (Startuplab) application, final text (v3)

Prepared 26 September 2026. Every number comes from one of two places:

- the repository's own records, checked on 26 Sep 2026;
- a public source listed in `market_2026.md` or `founder_checklist.md`.

## How to use this file (for Okan)

- Under each question, paste the text after **Answer:**.
- The grey box (`> Check: …`) is for you only. **Do not paste it.**
- `[TO FILL: …]` means only you can answer. Never guess.
- `[verify]` means a public figure: open its page (URLs in `market_2026.md`) before you submit, then delete the tag.
- Every item in `founder_checklist.md` must be done before you submit. **Items 1 and 2 come first.**

**Words used the same way throughout:**

- **running on our code**: it has run for real on our own code and left records;
- **built**: the code exists and is tested, but it is not switched on;
- **not built**: an idea only.

---

## 1. Summarize [company] in 20 words or less \*

**Answer (recommended, 18 words):**
ARIA (a SUDERRA AS spin-off in formation): an evidence, memory and control layer for AI work. Software first.

**Alternative (19 words):**
ARIA is an evidence and control layer for AI-driven work, starting with software engineering and expanding through domain-specific plugins.

**Alternative (15 words):**
AI agents are becoming workers. ARIA makes their work verifiable, remembered and improvable. Software first.

> Check:
>
> - True today only for software: ARIA's own AI agents, on our code. "Real evidence" means files in a code store with version history.
> - "Other fields via plug-ins" is the plan; no plug-in outside software is built.
> - Every question on the form names the company, so pick one Q1 that matches the name you enter (checklist item 3).

---

## 2. Why did you decide to start [company]? \*

**Answer (DRAFT; Okan adds the personal part):**
We started building SUDERRA AS's fish-farm software with AI coding agents. In September 2026, at least 73% of our regular code changes carried an agent's mark. We soon hit a simple problem: an agent saying "done" is not proof that the work is right. So we built rules and automatic checks around our agents, and in May 2026 those ideas became ARIA. [TO FILL: your own reason, in your own words.]

We then saw that checking alone is not enough. If a system keeps what an agent claimed, the evidence, the version, the decision and what happened afterwards, that history becomes memory for AI work, and memory can improve the next check. We believe AI systems should be able to show what they did, why, on what evidence, under which rules, and what happened next. Software is where that is needed first.

> Check: "73%" is 621 of 855 regular changes, 1–26 Sep 2026, and it is a lower bound. "We learned that…" is your statement; keep it only if it is true for you.

---

## 3. Briefly describe the problem [company] are solving and who you are solving it for. \*

**Answer:**
AI agents are moving from suggesting work to doing it. Organisations often cannot answer basic questions about that work later: what the AI changed, what it claimed, what evidence supports the claim, which version was checked, who decided, and what happened afterwards.

The gap is growing. In mid-2026, 68% of professional developers used AI coding agents every day [verify]. Yet 96% do not fully trust AI-generated code, and only 48% always check it before committing it [verify].

ARIA is an evidence, memory and control layer for AI work. We start with software engineering: agents already work there every day, and code, tests and version history give machine-checkable evidence. Our initial hypothesis is that regulated software teams need this most, starting with banks, payment companies and insurers. We have not yet validated this with external customers; so far our only user is ourselves.

We met the problem while building SUDERRA AS's software with AI agents. ARIA will be spun out of SUDERRA AS as its own company.

> Check: 90% and 68% are from JetBrains 2026 (N-01); 96% and 48% are from Sonar 2026 (N-02). The URLs are in market_2026.md.

---

## 4. Describe your value proposition of your solution and why it is better than what exists in the market today? \*

**Answer:**
ARIA makes AI work verifiable, remembered and, over time, improvable, rather than simply trusted. It is built as a loop:

AI work → evidence → verification → decision → outcome → memory → learning → better controls → next AI work

Where each part stands, on our own code:

- **Evidence and verification: running.** A claim counts only if it points to an exact file, checked by its digital fingerprint, in an exact version of the code. ARIA threw out 24 answers from its own AI agents whose cited file or line did not match. It also found that our own compliance document promised an automatic check for personal data (e-mail, phone, bank-account and card numbers) that does not exist in the code; two AI judges from two companies agreed.
- **Judgment: running.** ARIA's judges classified 157 automatically flagged cases, 87 as false alarms. We have not yet independently measured the judges' accuracy.
- **Memory: running, small.** Each fact is tied to a code version and re-checked when its files change; ARIA has corrected its own facts 9 times. All of this is kept in 88,890 sealed records.
- **Learning from outcomes: built, no outcome records yet.**
- **Better controls: built, not yet proven.** ARIA records where a new automatic checker is needed (20 requests so far). Every new checker must then pass a trial period with measured precision and a person's approval; 10 are in trial and none has passed.

ARIA has not yet changed or approved any code by itself; its first controlled step will cover only documentation changes and new tests, with a person's time-limited permission. We have not yet measured time or cost saved; that is the first goal of every pilot.

Code-review tools such as Qodo and CodeRabbit judge one change. ARIA keeps the evidence, decisions and outcomes across changes, so later checks can learn from earlier ones.

> Check:
>
> - Sources on aria/state (26 Sep 2026): 20 rows in `tools/skill-genesis/requests.jsonl` (all `requested`); `registry.json` has 7 CALIBRATE, 2 SHADOW and 1 QUARANTINED; 9 `belief_corrected` learning events; `change-ledger/outcome.jsonl` has 0 rows.
> - 157 are verdicts, not findings. They cover 75 distinct flagged problems, and 148 were single-judge verdicts.
> - The personal-data example is F-012: `docs/adr/024-compliance-retention-matrix.md` line 41 at version e9fd27bf. Do not give the path or a repository link until checklist item 1 is done.
> - The permission step and the new-tests-only rule are on working branches, not on `main`.

---

## 5. Why is this the right timing for starting [company]?

**Answer:**

1. **AI is becoming a worker.** In April 2026 Google said 75% of its new code is AI-generated and approved by engineers [verify]. Gartner expects more than 70% of enterprise software engineers to rely on AI coding agents by 2028 [verify]. On our own code, 73% of regular changes in September 2026 carried an AI agent's mark.
2. **The bottleneck is shifting from "can AI produce it?" to "can we trust, verify and remember what AI did?"** 60% of developers block agents from making system changes nobody approved [verify]. In April 2026 an AI coding agent deleted a company's production database and its backups in about nine seconds [verify].
3. **Rules and budgets are arriving.** In the EU, AI Act duties have applied in stages since February 2025 [verify], and Forrester expects AI governance software spending to reach USD 15.8 billion by 2030 [verify].

Between AI agents and traditional governance tools, a new layer is forming: the one that makes AI work accountable and steadily better. ARIA is built for that layer.

> Check: Google = N-04; the 60% = N-03 (Stack Overflow, 2026); the April 2026 incident = N-05 (PocketOS); Gartner = M-048; Forrester = M-051; AI Act = M-035/036/037.

---

## 6. Industry

**Answer:** ☑ **H: Enterprise IT/Security/DevTools** and ☑ **I: FinTech**

> Check:
>
> - I: FinTech is ticked: you confirmed banks, payment and insurance companies as the first customers.
> - Do not tick M, B, C (PropTech) or R (Sustainability). The answers signal AI, RegTech (audit, compliance, regulators), FinTech (banks, payments, insurance) and resilience (a bad AI change contained) in plain words, never as labels.

---

## 7. How do you analyze the size of your target market?

**Answer:**
We size the market from the first buyer up. The price is our assumption and has not been tested.

- **Beachhead: Norway's financial institutions.** Norway has about 126 banks: in 2025, 19 domestic commercial banks, 72 savings banks and 35 foreign-controlled banks [verify]. Insurance and payment companies come on top [TO FILL: count]. Many savings banks share IT through alliances, so there are fewer software organisations than banks; we will map them during the programme.
- **Contract size.** A software team of 10–100 developers at our assumed USD 20 per developer per month comes to USD 2,400–24,000 a year. An enterprise contract would cover several teams. [TO FILL: your expected first contract size.]
- **Share we aim for.** [TO FILL: how many of these organisations, and by when.]
- **Norway's wider base.** Norway had 99,300 people in IT occupations at the end of 2024 (SSB) [verify].
- **Global ceiling, for scale only.** There are 36.5 million professional developers worldwide [verify], and 68% use AI coding agents every day [verify]. At the same price that is about USD 5.96 billion a year. This multiplies a population by an untested price, so we treat it as a ceiling, not a target.
- **Trend.** Analysts put the AI code tools market at USD 7.37–7.65 billion in 2025, growing about 24–26% a year [verify].
- **Fragmentation.** In our view the market is fragmented: many tools, and first acquisitions such as Cursor buying the AI code-review tool Graphite in December 2025 [verify].

Other fields come later, through plug-ins. We do not size them, because nothing is built for them.

> Check:
>
> - 10 × 20 × 12 = 2,400; 100 × 20 × 12 = 24,000. 36,500,000 × 0.68 × 240 = 5,956,800,000.
> - Bank count (126 = 19 + 72 + 35): https://thebanks.eu/articles/banks-in-Norway; cross-check with Finanstilsynet's annual report.
> - Sources: N-06, N-01, N-07, N-09, N-10, M-050, M-062.
> - Norway: 99,300 × 0.68 = 67,524; × 20 × 12 = 16,205,760. SSB article of 30 May 2025: https://www.ssb.no/arbeid-og-lonn/sysselsetting/artikler/mange-flere-har-it-yrker. "IT occupations" includes more than developers, so this is an upper bound.

---

## 8. What is your customer focus? \*

**Answer:** ☑ **A: B2B**

---

## 9. What is the go-to-market plan for [company]?

**Answer:**
Founder-led B2B, in Norway first. The first goal is not volume but real pilots that show whether ARIA creates measurable value.

1. Find organisations already using AI coding agents, starting with banks, payment companies and insurers (a hypothesis). We will reach them through our own network and Startuplab's, and, if DNB agrees, one DNB software team. [TO FILL: named contacts, only if real.]
2. Map their current checking and governance process.
3. Run ARIA read-only for [TO FILL: weeks] ([TO FILL: free or paid]). It never changes their code.
4. Measure: AI changes reviewed, claims that could and could not be verified, false alarms, errors and rework, and time spent checking.
5. Turn successful pilots into paid deployments.

**Time to onboard:** [TO FILL: set-up X days, then a trial period of Y weeks]. Set-up is partly manual today, because parts of ARIA are still tied to our own setup. The product goal is a version another team can install without us.

> Check:
>
> - The form asks "how long … until fully onboarded". Fill it with a real estimate.
> - Old Larvik deck: "we are _seeking_ two pilot companies". If you keep that, write it that way; they are not pilots.

---

## 10. What is the business model of [company]?

**Answer:**
B2B SaaS. Our working price hypothesis is USD 20 per developer per month, not yet validated with customers.

- **First product:** a read-only evidence and verification layer. This part runs on our own code today.
- **Later value, as it is built and proven:** team memory, reusable checks, agent evaluation, domain-specific controls and, only with a person's time-limited permission, controlled low-risk actions.

Pricing will be set through the first pilots. Revenue to date: none.

---

## 11. If your product is live or if you have a demo of your product, please provide the URL below

**Answer:**
https://app.suderra.com is the demo of SUDERRA AS's fish-farm platform, where ARIA was developed. Demo account: [TO FILL: user / password]. ARIA has no public website yet. It has run on our own development environment since August 2026, and we can show it live in an interview: an AI agent's claim, the evidence ARIA checked, the judgment, the decision and the sealed record. [TO FILL: optional link to a short screen recording.]

> Check: before you submit, log in with the demo account and confirm the site opens (checklist item 5).

---

## 12. In this program, do you see opportunities for working with one or more of these? \*

**Answer:** ☑ **A: DNB**

> Check: or tick **C: None at the moment** if you prefer to claim nothing. Do not tick B (Vipps).

---

## 13. Please elaborate on opportunities for collaboration between [company] and DNB

**Answer:**
We would like to test ARIA with one DNB software team that uses AI coding agents, read-only, for [TO FILL: weeks]. ARIA would not change any code. The test would ask:

- Can ARIA reconstruct what the AI changed and claimed?
- Can it tie each claim to evidence and the exact version checked?
- Can it keep an auditable decision history?
- Can it spot recurring failure patterns that make later checks better?

Banks are used to showing auditors how their software changes and who approved it; AI-written code adds a new actor to that process. Today ARIA's judges run on cloud AI models from Anthropic and Z.ai. ARIA needs at least two judges, not two companies, so a bank could limit judging to the providers it approves; this has not been tested, and a self-hosted option is not built.

We have no collaboration with DNB or Vipps today.

> Check: verify what Z.ai is, and where it is based. The reviewer believes it is China's Zhipu AI; the files do not say. Decide whether a bank pilot would run on Anthropic judges only (checklist item 14).

---

## 14. Please list the team members, their respective roles in [company], and include links to their LinkedIn profiles: \*

**Answer:**
Okan Öztürk: [TO FILL: role]. [TO FILL: one line of background.]
https://www.linkedin.com/in/okanozturk-suderra/

Duygu Öztürk: [TO FILL: role]. [TO FILL: one line of background.]
https://www.linkedin.com/in/duygukayaozturk

---

## 15. Why will this team succeed with building this business in this market?

**Answer:**
We did not start from a theory. We met the problem while building real software with AI agents, and we built the answer on ourselves first.

- Okan Öztürk: [TO FILL: role]. [TO FILL: background — e.g. years in aquaculture engineering, RAS design and operations, founder of SUDERRA AS; only what is true.]
- Duygu Öztürk: [TO FILL: role and background]. [TO FILL: who owns sales, and any prior selling.]
- Since November 2025 our codebase has grown to about 2.2 million lines (the fish-farm platform, its sensor gateway and ARIA), about 30% of them tests. At least 1,703 of our 6,888 saved changes carry an AI agent's mark, a lower bound.
- Our rules came first: 2,178 problems logged by our AI reviewers, 80% of them fixed. ARIA grew out of them, and about 7,000 automatic tests check its core.

Our gap is commercial: we have no external customers yet. Turning this internal system into an externally validated product is why we are applying.

> Check:
>
> - Counts are as of 26 Sep 2026.
> - Be ready for the 464,749-line import of 20 Jan 2026 (checklist item 12).
> - Never say "a person merged every change".

---

## 16. How is the current Cap Table? Please list current owners and what percentage they own.

**Answer:**
SUDERRA AS today: [TO FILL: owners and percentages].

ARIA will be spun out of SUDERRA AS into its own company, to be incorporated by [TO FILL: date, ideally before the programme starts]. Planned ownership of the new company:

- Okan Öztürk: [TO FILL: 49% or 51%]
- Duygu Öztürk: [TO FILL: 51% or 49%]

ARIA's code and rights will be transferred from SUDERRA AS to the new company. [TO FILL: whether SUDERRA AS will hold shares in the new company.]

> Check: an investor cannot invest in a company that does not own its product, so the code-ownership line matters.

---

## 17. Is the core team working full time on [company]? \*

**Answer:** Yes. Both co-founders work full time.

---

## 18. Does [company] have any female co-founders? \*

**Answer:** Yes. Duygu Öztürk is a co-founder.

---

## 19. Does [company] have any customers, pilots, or beta-testers? \*

**Answer:**
Not yet. We have no external customers, pilots or beta-testers. ARIA is used only on SUDERRA AS's own code, as internal use. It started 43 nightly runs between 5 August and 20 September 2026, and 30 of them completed. The nightly run has been paused since 21 September. We found the cause, which was the way it wrote its records, and a fix is in the code under review. SUDERRA's fish-farm platform has a demo at app.suderra.com, with no external customers.

> Check: if the nightly run works again before you submit, change the sentence to "…has run again since [date]".

---

## 20. Has [company] made any revenue to date? \*

**Answer:** No.

---

## 21. What kind of validation have you received from your target market?

**Answer:**
We have no signed customers, pilots, beta users or letters of intent yet. Our strongest validation so far is technical: ARIA found a personal-data check that our own compliance document promised but the code never had, and it threw out AI answers whose cited evidence did not match the code.

External conversations so far: [TO FILL: number; how many in banking, payment or insurance; the main findings; quotes only with permission].

In the programme we want to test: whether teams feel this problem strongly enough to pay, who owns it (engineering, security, risk or compliance), which metrics prove value, whether a memory of past AI work is valuable to them, and what data and model controls they need.

> Check: if there have been no conversations, open instead with "We have not yet tested ARIA with outside teams; before the interview we will speak with [N]." Then hold 3–5 real conversations.

---

## 22. If applicable, please state [company]'s projection for customers and revenue in 12 months.

**Answer:**
[TO FILL: pilots → paying teams × developers × USD 20 × 12.] These are goals, not a forecast: we have no sales pipeline yet.

> Check: the USD 480,000 in Q7 is a long-run illustration. Do not reuse it here.

---

## 23. Who is [company]'s 2 main competitors?

**Answer:**

1. **Qodo**: an AI code-quality platform that reviews code changes and builds a persistent understanding of a team's repositories. https://www.qodo.ai/
2. **CodeRabbit**: AI review of proposed code changes on GitHub and GitLab, in the editor and on the command line, priced per developer. https://www.coderabbit.ai/

> Check: open both sites and confirm the descriptions. Do not write what they "lack".

---

## 24. How are you different to these competitors?

**Answer:**
Code-review tools help judge one proposed change. ARIA is built to connect the whole chain, and to keep it:

AI action → evidence → judgment → outcome → memory → learning → better control

1. **Proof, not claims (running on our code).** Citations are checked against the exact saved version by the file's fingerprint; 24 answers were thrown out.
2. **More than one AI judge (running on our code).** A flagged problem becomes official only after at least two judges rule and a clear majority agrees; in all five cases so far, both agreed.
3. **A decision history that shows edits (running on our code).** 88,890 records, each sealed to the one before.
4. **Memory and learning (memory running, small; learning from outcomes built, no records yet).**
5. **Controls that grow (built, not yet proven).** New checkers are requested where ARIA sees a gap, and each must pass a trial with measured precision and a person's approval before it counts.

**What could become hard to copy (early, not yet proven):** the evidence history, decision history, outcome data and validated checks each organisation builds over time. All of these grow with use, so a later entrant starts without them.

**Where others are stronger:** ARIA searches by exact words (search by meaning is built but not switched on), and it works only on files kept with version history (git). We have not tested competitors hands-on.

---

## 25. How much capital are you planning to raise now? \*

**Answer:**
NOK 5 million in total. From Startuplab we ask NOK [TO FILL: an amount within Startuplab's current range]; the rest comes from [TO FILL]. It pays for [TO FILL: people × months, AI-model costs, first pilots, sales] over [TO FILL] months.

Our goals for the first 12 months:

- [TO FILL: N] read-only pilots with software teams outside SUDERRA;
- a measured pilot result: errors and rework, with and without ARIA;
- ARIA's first approval of a documentation change or a new test on our own code, with a person's time-limited permission;
- a version another team can install without our own set-up.

> Check: the Startuplab range is 1–3 / 2–4 MNOK, "typically 2–4 MNOK" for about 10%. A NOK 5M ticket at 10% implies NOK 50M post-money.

---

## 26. At what targeted valuation (pre money) will you raise the capital?

**Answer:** [TO FILL: pre-money valuation, consistent with Q25.]

---

## 27. What runway will you get with this capital?

**Answer:** [TO FILL: number of months.]

---

## 28. How did you hear about the Startuplab Accelerator?

**Answer:** [TO FILL: tick A–G.]

---

## 29. If you have a short pitch deck or something else you want to share with us, please upload it here.

**Answer:** Upload the PDF of the deck built from `deck.final.md`, and only once checklist items 1–9 are done.

> Check: do not upload the old Larvik deck or the old investor-pitch document, and give no repository link.

---

## 30. Can we share your application with a few selected people at DNB and Vipps under strict confidentiality? \*

**Answer:** ☑ **Y: Yes**

---

## 31. GDPR

**Answer:** [TO FILL: read and accept. Startuplab stores the application during selection and uses AI in screening.]
