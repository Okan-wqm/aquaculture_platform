# ARIA: Startuplab Accelerator (DNB NXT) application: text to enter in the form

## Instructions for the AI assistant filling in the form

You are helping Okan Öztürk fill in the Startuplab Accelerator application form. The company name in the form is **SUDERRA AS**. Follow these rules exactly.

**A. Copy, never rewrite.** Enter each answer into the form field whose question has the same number. Copy the text exactly: do not rephrase, shorten, translate, add or "improve" it. The form fields are plain text.

**B. Parts marked `[TO FILL: …]`.** These are facts only Okan knows.

- Before you fill anything, collect all of them. Ask Okan every [TO FILL] question at once, as one numbered list. He may answer in Turkish.
- Put each answer in place of its bracket, in plain, short English.
- Use only what Okan says. Never invent names, numbers, customers, backgrounds or dates.
- If Okan says there is none, use the fallback in section E where one exists. Otherwise ask him how to phrase it.
- Never ask Okan to type a password into the chat. For question 11, he types the demo login into the form himself.

**C. Figures marked `[verify]`.**

- Open the source page listed for that figure in section G.
- If the page confirms the figure (same number, same meaning), delete only the `[verify]` tag.
- If it does not, or the page will not open, do not enter that sentence. Tell Okan which figure failed and why.

**D. Checkboxes and uploads.**

- For checkbox questions, tick exactly the options listed after "Select".
- For question 28, tick what Okan tells you.
- For question 29, upload only the PDF Okan gives you.
- For question 31, let Okan tick the GDPR consent himself.

**E. Fallbacks when Okan says "none":**

- Q9 "named contacts": delete the bracket and its sentence.
- Q11 "screen recording": delete the bracket.
- Q21, if no conversations have happened: replace the first two sentences with "We have not yet tested ARIA with outside teams; before an interview we will speak with at least three software teams in Norway."

**F. Stop before submitting.** When every field is filled, do not press "Submit". Show Okan the list of what you changed or removed, and let him review and submit.

## G. Sources for the [verify] figures

| Figure (where it appears)                                                               | Source page                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 90% weekly / 68% daily use of AI coding agents, mid-2026 (Q3, Q7)                       | https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/                                                                                                             |
| 96% do not fully trust AI code; only 48% always check it (Q3)                           | https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/                                                                          |
| Google: 75% of new code AI-generated, April 2026 (Q5)                                   | https://www.semafor.com/article/04/24/2026/google-ceo-says-75-of-companys-new-code-is-ai-generated                                                                                     |
| Gartner: more than 70% of enterprise engineers relying on AI coding agents by 2028 (Q5) | https://www.gartner.com/en/newsroom/press-releases/2026-05-20-gartner-says-the-market-for-enterprise-ai-coding-agents-is-entering-a-new-phase-of-expansion-and-competitive-realignment |
| 60% block agents from unapproved system changes (Q5)                                    | https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work/                                                                                   |
| April 2026: agent deleted a production database and backups in about 9 seconds (Q5)     | https://www.theregister.com/2026/04/27/cursoropus_agent_snuffs_out_pocketos/                                                                                                           |
| Forrester: USD 15.8 bn AI governance software by 2030 (Q5)                              | https://www.forrester.com/blogs/ai-governance-software-spend-will-see-30-cagr-from-2024-to-2030                                                                                        |
| EU AI Act dates; Nkom as Norway's supervisor (Q5)                                       | https://artificialintelligenceact.eu/article/4/ and https://cms.law/en/int/expert-guides/ai-regulation-scanner/norway                                                                  |
| 36.5 million professional developers (Q7)                                               | https://www.slashdata.co/post/global-developer-population-trends-2025-how-many-developers-are-there                                                                                    |
| CodeRabbit USD 24 per developer per month, billed annually (Q7)                         | https://www.coderabbit.ai/pricing                                                                                                                                                      |
| Norway: about 126 banks in 2025 (Q7)                                                    | https://thebanks.eu/articles/banks-in-Norway (cross-check with Finanstilsynet's annual report)                                                                                         |
| AI code tools market USD 7.37–7.65 bn in 2025, about 24–26% a year (Q7)                 | Search the analyst names "Research and Markets" and "Mordor Intelligence" plus "AI code tools market 2025". If you cannot confirm it, drop the Trend bullet.                           |
| Cursor bought Graphite, December 2025 (Q7)                                              | Search "Cursor acquires Graphite". If you cannot confirm it, drop the Fragmentation bullet.                                                                                            |
| Norway: 99,300 people in IT occupations, Q4 2024 (Q7)                                   | https://www.ssb.no/arbeid-og-lonn/sysselsetting/artikler/mange-flere-har-it-yrker                                                                                                      |

---

## 1. Summarize [company] in 20 words or less \*

ARIA (a SUDERRA AS spin-off in formation): an evidence, memory and control layer for AI work. Software first.

---

## 2. Why did you decide to start [company]? \*

We started building SUDERRA AS's fish-farm software with AI coding agents. In September 2026, at least 73% of our regular code changes carried an agent's mark. We soon hit a simple problem: an agent saying "done" is not proof that the work is right. So we built rules and automatic checks around our agents, and in May 2026 those ideas became ARIA. [TO FILL: your own reason, in your own words.]

We then saw that checking alone is not enough. If a system keeps what an agent claimed, the evidence, the version, the decision and what happened afterwards, that history becomes memory for AI work, and memory can improve the next check. We believe AI systems should be able to show what they did, why, on what evidence, under which rules, and what happened next. Software is where that is needed first.

---

## 3. Briefly describe the problem [company] are solving and who you are solving it for. \*

AI agents are moving from suggesting work to doing it. Organisations often cannot answer basic questions about that work later: what the AI changed, what it claimed, what evidence supports the claim, which version was checked, who decided, and what happened afterwards.

The gap is growing. In mid-2026, 68% of professional developers used AI coding agents every day [verify]. Yet 96% do not fully trust AI-generated code, and only 48% always check it before committing it [verify].

ARIA is an evidence, memory and control layer for AI work. We start with software engineering: agents already work there every day, and code, tests and version history give machine-checkable evidence. Our initial hypothesis is that regulated software teams need this most, starting with banks, payment companies and insurers. We have not yet validated this with external customers; so far our only user is ourselves.

We met the problem while building SUDERRA AS's software with AI agents. ARIA will be spun out of SUDERRA AS as its own company.

---

## 4. Describe your value proposition of your solution and why it is better than what exists in the market today? \*

ARIA makes AI work verifiable, remembered and, over time, improvable, rather than simply trusted. It is built as a loop:

AI work → evidence → verification → decision → outcome → memory → learning → better controls → next AI work

Where each part stands, on our own code:

- Evidence and verification: running. A claim counts only if it points to an exact file, checked by its digital fingerprint, in an exact version of the code. ARIA threw out 24 answers from its own AI agents whose cited file or line did not match. It also found that our own compliance document promised an automatic check for personal data (e-mail, phone, bank-account and card numbers) that does not exist in the code; two AI judges from two companies agreed.
- Judgment: running. ARIA's judges classified 157 automatically flagged cases, 87 as false alarms. We have not yet independently measured the judges' accuracy.
- Memory: running, small. Each fact is tied to a code version and re-checked when its files change; ARIA has corrected its own facts 9 times. All of this is kept in 88,890 sealed records.
- Learning from outcomes: built, no outcome records yet.
- Better controls: built, not yet proven. ARIA records where a new automatic checker is needed (20 requests so far). Every new checker must then pass a trial period with measured precision and a person's approval; 10 are in trial and none has passed.

ARIA has not yet changed or approved any code by itself; its first controlled step will cover only documentation changes and new tests, with a person's time-limited permission. We have not yet measured time or cost saved; that is the first goal of every pilot.

Code-review tools such as Qodo and CodeRabbit judge one change. ARIA keeps the evidence, decisions and outcomes across changes, so later checks can learn from earlier ones.

---

## 5. Why is this the right timing for starting [company]?

1. AI is becoming a worker. In April 2026 Google said 75% of its new code is AI-generated and approved by engineers [verify]. Gartner expects more than 70% of enterprise software engineers to rely on AI coding agents by 2028 [verify]. On our own code, 73% of regular changes in September 2026 carried an AI agent's mark.
2. The bottleneck is shifting from "can AI produce it?" to "can we trust, verify and remember what AI did?" 60% of developers block agents from making system changes nobody approved [verify]. In April 2026 an AI coding agent deleted a company's production database and its backups in about nine seconds [verify].
3. Rules and budgets are arriving. In the EU, AI Act duties have applied in stages since February 2025 [verify], and Forrester expects AI governance software spending to reach USD 15.8 billion by 2030 [verify].

Between AI agents and traditional governance tools, a new layer is forming: the one that makes AI work accountable and steadily better. ARIA is built for that layer.

---

## 6. Industry

Select: H: Enterprise IT/Security/DevTools; I: FinTech

---

## 7. How do you analyze the size of your target market?

We size the market from the first buyer up. The price is our assumption and has not been tested.

- Beachhead: Norway's financial institutions. Norway has about 126 banks: in 2025, 19 domestic commercial banks, 72 savings banks and 35 foreign-controlled banks [verify]. Insurance and payment companies come on top [TO FILL: count]. Many savings banks share IT through alliances, so there are fewer software organisations than banks; we will map them during the programme.
- Contract size. A software team of 10–100 developers at our assumed USD 20 per developer per month comes to USD 2,400–24,000 a year. An enterprise contract would cover several teams. [TO FILL: your expected first contract size.]
- Share we aim for. [TO FILL: how many of these organisations, and by when.]
- Norway's wider base. Norway had 99,300 people in IT occupations at the end of 2024 (SSB) [verify].
- Global ceiling, for scale only. There are 36.5 million professional developers worldwide [verify], and 68% use AI coding agents every day [verify]. At the same price that is about USD 5.96 billion a year. This multiplies a population by an untested price, so we treat it as a ceiling, not a target.
- Trend. Analysts put the AI code tools market at USD 7.37–7.65 billion in 2025, growing about 24–26% a year [verify].
- Fragmentation. In our view the market is fragmented: many tools, and first acquisitions such as Cursor buying the AI code-review tool Graphite in December 2025 [verify].

Other fields come later, through plug-ins. We do not size them, because nothing is built for them.

---

## 8. What is your customer focus? \*

Select: A: B2B

---

## 9. What is the go-to-market plan for [company]?

Founder-led B2B, in Norway first. The first goal is not volume but real pilots that show whether ARIA creates measurable value.

1. Find organisations already using AI coding agents, starting with banks, payment companies and insurers (a hypothesis). We will reach them through our own network and Startuplab's, and, if DNB agrees, one DNB software team. [TO FILL: named contacts, only if real.]
2. Map their current checking and governance process.
3. Run ARIA read-only for [TO FILL: weeks] ([TO FILL: free or paid]). It never changes their code.
4. Measure: AI changes reviewed, claims that could and could not be verified, false alarms, errors and rework, and time spent checking.
5. Turn successful pilots into paid deployments.

Time to onboard: [TO FILL: set-up X days, then a trial period of Y weeks]. Set-up is partly manual today, because parts of ARIA are still tied to our own setup. The product goal is a version another team can install without us.

---

## 10. What is the business model of [company]?

B2B SaaS. Our working price hypothesis is USD 20 per developer per month, not yet validated with customers.

- First product: a read-only evidence and verification layer. This part runs on our own code today.
- Later value, as it is built and proven: team memory, reusable checks, agent evaluation, domain-specific controls and, only with a person's time-limited permission, controlled low-risk actions.

Pricing will be set through the first pilots. Revenue to date: none.

---

## 11. If your product is live or if you have a demo of your product, please provide the URL below

https://app.suderra.com is the demo of SUDERRA AS's fish-farm platform, where ARIA was developed. Demo account: [TO FILL: user / password]. ARIA has no public website yet. It has run on our own development environment since August 2026, and we can show it live in an interview: an AI agent's claim, the evidence ARIA checked, the judgment, the decision and the sealed record. [TO FILL: optional link to a short screen recording.]

---

## 12. In this program, do you see opportunities for working with one or more of these? \*

Select: A: DNB

---

## 13. Please elaborate on opportunities for collaboration between [company] and DNB

We would like to test ARIA with one DNB software team that uses AI coding agents, read-only, for [TO FILL: weeks]. ARIA would not change any code. The test would ask:

- Can ARIA reconstruct what the AI changed and claimed?
- Can it tie each claim to evidence and the exact version checked?
- Can it keep an auditable decision history?
- Can it spot recurring failure patterns that make later checks better?

Banks are used to showing auditors how their software changes and who approved it; AI-written code adds a new actor to that process. Today ARIA's judges run on cloud AI models from Anthropic and Z.ai. ARIA needs at least two judges, not two companies, so a bank could limit judging to the providers it approves; this has not been tested, and a self-hosted option is not built.

We have no collaboration with DNB or Vipps today.

---

## 14. Please list the team members, their respective roles in [company], and include links to their LinkedIn profiles: \*

Okan Öztürk: [TO FILL: role]. [TO FILL: one line of background.]
https://www.linkedin.com/in/okanozturk-suderra/

Duygu Öztürk: [TO FILL: role]. [TO FILL: one line of background.]
https://www.linkedin.com/in/duygukayaozturk

---

## 15. Why will this team succeed with building this business in this market?

We did not start from a theory. We met the problem while building real software with AI agents, and we built the answer on ourselves first.

- Okan Öztürk: [TO FILL: role]. [TO FILL: background — e.g. years in aquaculture engineering, RAS design and operations, founder of SUDERRA AS; only what is true.]
- Duygu Öztürk: [TO FILL: role and background]. [TO FILL: who owns sales, and any prior selling.]
- Since November 2025 our codebase has grown to about 2.2 million lines (the fish-farm platform, its sensor gateway and ARIA), about 30% of them tests. At least 1,703 of our 6,888 saved changes carry an AI agent's mark, a lower bound.
- Our rules came first: 2,178 problems logged by our AI reviewers, 80% of them fixed. ARIA grew out of them, and about 7,000 automatic tests check its core.

Our gap is commercial: we have no external customers yet. Turning this internal system into an externally validated product is why we are applying.

---

## 16. How is the current Cap Table? Please list current owners and what percentage they own.

SUDERRA AS today: [TO FILL: owners and percentages].

ARIA will be spun out of SUDERRA AS into its own company, to be incorporated by [TO FILL: date, ideally before the programme starts]. Planned ownership of the new company:

- Okan Öztürk: [TO FILL: 49% or 51%]
- Duygu Öztürk: [TO FILL: 51% or 49%]

ARIA's code and rights will be transferred from SUDERRA AS to the new company. [TO FILL: whether SUDERRA AS will hold shares in the new company.]

---

## 17. Is the core team working full time on [company]? \*

Yes. Both co-founders work full time.

---

## 18. Does [company] have any female co-founders? \*

Yes. Duygu Öztürk is a co-founder.

---

## 19. Does [company] have any customers, pilots, or beta-testers? \*

Not yet. We have no external customers, pilots or beta-testers. ARIA is used only on SUDERRA AS's own code, as internal use. It started 43 nightly runs between 5 August and 20 September 2026, and 30 of them completed. The nightly run has been paused since 21 September. We found the cause, which was the way it wrote its records, and a fix is in the code under review. SUDERRA's fish-farm platform has a demo at app.suderra.com, with no external customers.

---

## 20. Has [company] made any revenue to date? \*

No.

---

## 21. What kind of validation have you received from your target market?

We have no signed customers, pilots, beta users or letters of intent yet. Our strongest validation so far is technical: ARIA found a personal-data check that our own compliance document promised but the code never had, and it threw out AI answers whose cited evidence did not match the code.

External conversations so far: [TO FILL: number; how many in banking, payment or insurance; the main findings; quotes only with permission].

In the programme we want to test: whether teams feel this problem strongly enough to pay, who owns it (engineering, security, risk or compliance), which metrics prove value, whether a memory of past AI work is valuable to them, and what data and model controls they need.

---

## 22. If applicable, please state [company]'s projection for customers and revenue in 12 months.

[TO FILL: pilots → paying teams × developers × USD 20 × 12.] These are goals, not a forecast: we have no sales pipeline yet.

---

## 23. Who is [company]'s 2 main competitors?

1. Qodo: an AI code-quality platform that reviews code changes and builds a persistent understanding of a team's repositories. https://www.qodo.ai/
2. CodeRabbit: AI review of proposed code changes on GitHub and GitLab, in the editor and on the command line, priced per developer. https://www.coderabbit.ai/

---

## 24. How are you different to these competitors?

Code-review tools help judge one proposed change. ARIA is built to connect the whole chain, and to keep it:

AI action → evidence → judgment → outcome → memory → learning → better control

1. Proof, not claims (running on our code). Citations are checked against the exact saved version by the file's fingerprint; 24 answers were thrown out.
2. More than one AI judge (running on our code). A flagged problem becomes official only after at least two judges rule and a clear majority agrees; in all five cases so far, both agreed.
3. A decision history that shows edits (running on our code). 88,890 records, each sealed to the one before.
4. Memory and learning (memory running, small; learning from outcomes built, no records yet).
5. Controls that grow (built, not yet proven). New checkers are requested where ARIA sees a gap, and each must pass a trial with measured precision and a person's approval before it counts.

What could become hard to copy (early, not yet proven): the evidence history, decision history, outcome data and validated checks each organisation builds over time. All of these grow with use, so a later entrant starts without them.

Where others are stronger: ARIA searches by exact words (search by meaning is built but not switched on), and it works only on files kept with version history (git). We have not tested competitors hands-on.

---

## 25. How much capital are you planning to raise now? \*

NOK 5 million in total. From Startuplab we ask NOK [TO FILL: an amount within Startuplab's current range]; the rest comes from [TO FILL]. It pays for [TO FILL: people × months, AI-model costs, first pilots, sales] over [TO FILL] months.

Our goals for the first 12 months:

- [TO FILL: N] read-only pilots with software teams outside SUDERRA;
- a measured pilot result: errors and rework, with and without ARIA;
- ARIA's first approval of a documentation change or a new test on our own code, with a person's time-limited permission;
- a version another team can install without our own set-up.

---

## 26. At what targeted valuation (pre money) will you raise the capital?

[TO FILL: pre-money valuation, consistent with Q25.]

---

## 27. What runway will you get with this capital?

[TO FILL: number of months.]

---

## 28. How did you hear about the Startuplab Accelerator?

Select: [TO FILL: ask Okan which of A–G apply: LinkedIn ads, Facebook ads, media ads, news, recommended to apply, through another participating company, other]

---

## 29. If you have a short pitch deck or something else you want to share with us, please upload it here.

Upload the PDF of the deck built from `deck.final.md`, and only once checklist items 1–9 are done.

---

## 30. Can we share your application with a few selected people at DNB and Vipps under strict confidentiality? \*

Select: Y: Yes

---

## 31. GDPR

(Okan ticks the GDPR consent himself.)

---
