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
| AI code tools market USD 7.37–7.65 bn in 2025, about 24–26% a year (Q7)                 | Search the analyst names "Research and Markets" and "Mordor Intelligence" plus "AI code tools market 2025". If you cannot confirm it, drop the Trend bullet.                           |
| Cursor bought Graphite, December 2025 (Q7)                                              | Search "Cursor acquires Graphite". If you cannot confirm it, drop the Fragmentation bullet.                                                                                            |
| Norway: 99,300 people in IT occupations, Q4 2024 (Q7)                                   | https://www.ssb.no/arbeid-og-lonn/sysselsetting/artikler/mange-flere-har-it-yrker                                                                                                      |

---

## 1. Summarize [company] in 20 words or less \*

ARIA (a SUDERRA AS spin-off in formation) checks AI claims against real evidence. Software first; other fields via plug-ins.

---

## 2. Why did you decide to start [company]? \*

In November 2025 we started building operations software for fish farms: feeding, water quality and fish-welfare records. We built a growing part of it with AI coding agents: in September 2026, at least 73% of our regular code changes carried an agent's mark. We learned that an agent saying "done" is not proof, so we wrote rules and automatic checks around the agents. In May 2026 we started ARIA from what those rules taught us. [TO FILL: your own reason, in your own words.] We believe every field where AI does real work will need the same proof, and software needs it first. That is why ARIA is becoming its own company.

---

## 3. Briefly describe the problem [company] are solving and who you are solving it for. \*

Software teams now let AI agents (programs that write and change code) do real work. But when an agent says "done", the team often cannot show later what it checked, in which version of the code, and who approved it. We solve this first for teams that must answer to auditors: the software teams of banks, payment and insurance companies. That is a hypothesis we will test; so far our only user is ourselves.

The gap is growing. In mid-2026, 90% of professional developers used AI coding agents at work every week and 68% every day [verify]. Yet 96% do not fully trust AI-generated code, and only 48% always check it before committing it [verify].

ARIA is designed as a general core, with one plug-in per field. Software is the first, because that is where AI already works at scale. Other fields, such as law firms' documents or greenhouse records, need their own plug-ins and are not built.

We met the problem while building SUDERRA AS's fish-farm software with AI agents. That software records feeding, water quality and fish deaths by cause. ARIA was born there and will be spun out as its own company.

---

## 4. Describe your value proposition of your solution and why it is better than what exists in the market today? \*

For a team whose code is increasingly written by AI, ARIA keeps a record an auditor can follow. An AI claim about the code counts only if it points to an exact file, checked by its digital fingerprint, in an exact version of the code. Anything else is thrown out.

On our own code, August–September 2026:

- A real gap found. Our own compliance document promised an automatic check that scans every new problem-log entry for personal data, such as e-mail addresses, phone numbers, bank-account (IBAN) and card numbers. ARIA found that the check does not exist in the code, and two AI judges from two companies agreed. The finding is still open.
- Unproven answers rejected. It threw out 24 answers from its own AI agents (judges and planners), because the file or line they quoted did not match the saved code.
- False alarms filtered. Its AI judges gave 157 verdicts on problems its automatic checkers had flagged, and 87 said "false alarm".
- A record that shows edits. It keeps 88,890 records, each sealed to the one before so that a later edit would show, and all of them pass the check.

We have not yet measured time or cost saved. Measuring errors and rework, with and without ARIA, is the first goal of every pilot.

ARIA has not yet changed or approved any code by itself. That next step is limited to documentation changes and new tests, and needs a person's time-limited permission. It is in development.

Code-review tools such as Qodo and CodeRabbit comment on proposed changes. ARIA keeps the proof and the record behind each claim. We have not tested those tools hands-on.

---

## 5. Why is this the right timing for starting [company]?

1. AI is becoming the normal way to write code. In April 2026 Google said 75% of its new code is AI-generated and approved by engineers [verify]. Gartner expects that by 2028 more than 70% of enterprise software engineers will rely on AI coding agents [verify]. On our own code, 73% of regular changes in September 2026 carried an AI agent's mark.
2. Trust and control have not kept up. 60% of developers block agents from making system changes nobody approved [verify]. In April 2026 an AI coding agent deleted a company's production database and its backups in about nine seconds, using an access token it found in an unrelated file [verify].
3. Budgets are forming. Forrester expects spending on AI governance software to reach USD 15.8 billion by 2030 [verify].
4. Rules are arriving. In the EU, AI Act duties have applied in stages since February 2025, and its transparency duties since August 2026. Norway has named Nkom as its supervisor; the Norwegian start date is not yet settled [verify]. We expect more pressure on companies to show how they use AI.

---

## 6. Industry

Select: H: Enterprise IT/Security/DevTools; I: FinTech

---

## 7. How do you analyze the size of your target market?

We size one market: software teams that use AI coding agents. The counts come from public sources; the price is our assumption and has not been tested.

- Count. There are 36.5 million professional developers worldwide (SlashData, latest count) [verify], and 68% use AI coding agents every day (JetBrains, 2026) [verify]. That is about 24.8 million developers. The two figures come from different sources, so this is an estimate.
- Price and total. We assume USD 20 per developer per month, just under CodeRabbit's USD 24 (billed annually) [verify]. That gives about USD 5.96 billion a year.
- Trend. Analysts put the AI code tools market at USD 7.37–7.65 billion in 2025, growing about 24–26% a year [verify]. That is a different category, so the check is loose.
- Fragmentation. In our view the market is fragmented: many tools, and the first acquisitions, such as Cursor buying the AI code-review tool Graphite in December 2025 [verify].
- Share we aim for. [TO FILL: reachable share, where, by when, and why.] As an illustration, not a forecast: 40 organisations × 50 developers × USD 20 × 12 = USD 480,000 a year, about 0.008% of the total.
- Norway first. Norway had 99,300 people in IT occupations at the end of 2024 (SSB) [verify]. At the same 68% share and price, that is at most about 67,500 developers and USD 16.2 million a year. We will measure the share in banks, payment and insurance companies during the programme.

Other fields will come later, through plug-ins. We do not size them, because nothing is built for them.

---

## 8. What is your customer focus? \*

Select: A: B2B

---

## 9. What is the go-to-market plan for [company]?

We sell founder-led, B2B, in Norway first. First targets: software teams at banks, payment and insurance companies that use AI coding agents and must show auditors who changed what and who checked it. This is a hypothesis we want to test in the programme.

How we reach them: our own network and Startuplab's and, if DNB agrees, one DNB software team as a first test. [TO FILL: named contacts, only if real.]

Offer: a read-only pilot of [TO FILL: weeks], [TO FILL: free or paid, and price]. ARIA looks and reports, and never changes the customer's code. This is the part that has run on our own code. The pilot measures whether errors and rework go down with ARIA.

Time to onboard: [TO FILL: set-up X days, then a trial period of Y weeks]. Set-up is manual today, because parts of ARIA are still tied to our own setup and several of its automatic checkers are specific to our software. Each new checker runs on trial until we have measured how often it is right and a person has approved it.

Later (not built): plug-ins for a bank's own rules, then law firms' documents and greenhouse records.

---

## 10. What is the business model of [company]?

We will sell subscriptions, priced per developer whose AI work ARIA checks. The price is an assumption: USD 20 per developer per month, just under the list price of a known code-review tool.

- Watch-only plan: proof checks, AI judges and a sealed record. ARIA looks and reports, and never changes code. This part runs on our own code today.
- Approval plan (later): ARIA may approve the lowest-risk changes by itself, meaning documentation changes and new tests, never edits to existing tests, and only with a person's time-limited permission. If the tests then fail because of that change, ARIA locks itself and starts an undo, so a bad AI change is contained. The lock and the undo are built; the permission step and the new-tests rule are in development.

Revenue to date: none.

---

## 11. If your product is live or if you have a demo of your product, please provide the URL below

https://app.suderra.com is the demo of SUDERRA AS's fish-farm platform. Demo account: [TO FILL: user / password]. ARIA was born while we built this platform; ARIA checks the platform's code, not the website. ARIA itself has no public web address yet. We can walk you through its live records on our own code in a meeting. [TO FILL: optional link to a short screen recording of ARIA's records.]

---

## 12. In this program, do you see opportunities for working with one or more of these? \*

Select: A: DNB

---

## 13. Please elaborate on opportunities for collaboration between [company] and DNB

What we ask of DNB: one software team that uses AI coding agents, for a read-only test of [TO FILL: weeks]. The test would show whether ARIA's record answers the questions an audit asks about AI-written code: who changed what, why, and who checked. We have no collaboration with DNB or Vipps today.

Why it could matter: banks are used to showing auditors how their software is changed and who approved it, and we think AI-written code will face the same questions. On our own code, every fix sent as a proposed change must name the problem it fixes; the check that enforces this has run 4,389 times. ARIA keeps a sealed record of what its AI agents claimed and whether each claim held up against the code.

What a bank will ask first: which AI companies see the code. Today ARIA's judges run on cloud models from Anthropic and Z.ai. ARIA's rule needs at least two judges, not two companies, so a bank could limit judging to the providers it approves. Running that way has not been tested yet, and a self-hosted model is not built.

Later (not built): plug-ins for a bank's own rules.

---

## 14. Please list the team members, their respective roles in [company], and include links to their LinkedIn profiles: \*

Okan Öztürk: [TO FILL: role]. [TO FILL: one line of background.]
https://www.linkedin.com/in/okanozturk-suderra/

Duygu Öztürk: [TO FILL: role]. [TO FILL: one line of background.]
https://www.linkedin.com/in/duygukayaozturk

---

## 15. Why will this team succeed with building this business in this market?

We have already done on ourselves what ARIA offers others: building real software with AI agents under rules that demand proof.

- Okan Öztürk, [TO FILL: role]: [TO FILL: background; what he built].
- Duygu Öztürk, [TO FILL: role]: [TO FILL: background]. [TO FILL: who owns sales, and any prior selling.]
- Since November 2025 we have built a codebase of about 2.2 million lines (the fish-farm platform, its sensor gateway and ARIA), about 30% of it tests. At least 1,703 of our 6,888 saved changes carry an AI agent's mark, and that is a lower bound.
- Our rules came first: 2,178 problems logged by our AI reviewers, 80% of them fixed. ARIA grew out of those rules, and about 7,000 automatic tests check its core.

We have no customers yet. Selling is what we are here to build with Startuplab.

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

We have spoken with [TO FILL: N] software teams in Norway, [TO FILL: how many in banking, payment or insurance]. [TO FILL: what they said; quote only with permission.] We have no letters of intent, pilots or paying customers yet. Our other evidence is our own use: ARIA found that one of our own compliance documents promised a personal-data check that does not exist in the code.

---

## 22. If applicable, please state [company]'s projection for customers and revenue in 12 months.

[TO FILL: pilots → paying teams × developers × USD 20 × 12.] These are goals, not a forecast: we have no sales pipeline yet.

---

## 23. Who is [company]'s 2 main competitors?

1. Qodo: an AI code-quality platform that reviews code changes and builds a persistent understanding of a team's repositories. https://www.qodo.ai/
2. CodeRabbit: AI review of proposed code changes on GitHub and GitLab, in the editor and on the command line, priced per developer. https://www.coderabbit.ai/

---

## 24. How are you different to these competitors?

Code-review tools comment on each proposed change. ARIA is built around proof and a record.

1. Proof, not claims (running on our code). When one of ARIA's AI agents cites a file, and where it matters a line, ARIA checks it against the exact saved version of the code using the file's digital fingerprint. If they do not match, the answer is thrown out. This has happened 24 times.
2. A record that shows edits (running on our code). ARIA's records sit in the team's own code store (today, ours), each sealed to the one before, and all 88,890 pass the check.
3. More than one AI judge (running on our code). A flagged problem becomes an official finding only after at least two AI judges have ruled and a clear majority agrees, with an average confidence of at least 0.80. In all five cases so far, both judges agreed: one from Anthropic, one from Z.ai.
4. A core with plug-ins (a design; only software plug-ins exist). The core is designed to be general, and each field gets its own automatic checkers.

Hard to copy: [TO FILL: depends on the repository licence and whether the code stays public (checklist item 15).]

Where others are stronger: ARIA searches by exact words; its search by meaning is built but not switched on. It works only on files kept in a code store with version history (git). We have not tested competitors hands-on.

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
