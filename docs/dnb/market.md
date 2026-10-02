# SUDERRA AS: market and accelerator fact base

Prepared for the Startuplab / DNB NXT Accelerator application and the investor deck.
All retrievals: **2026-09-26** (UTC). Every fact has an ID `M-nnn`.

---

## 0. Read this first: how much you can trust each fact

The research environment's network egress proxy blocked direct page fetches for almost every domain. Each block below was tested and reproduced:

| Tried to fetch                                                                              | Result                                |
| ------------------------------------------------------------------------------------------- | ------------------------------------- |
| www.dnb.no, www.startuplab.no, startuplab.no, startuplabno.medium.com, financeinnovation.no | `EGRESS_BLOCKED`                      |
| www.ssb.no, en.seafood.no, www.fao.org, arxiv.org, en.wikipedia.org                         | `EGRESS_BLOCKED`                      |
| github.blog, docs.github.com, aws.amazon.com, learn.microsoft.com                           | `EGRESS_BLOCKED`                      |
| `curl` to arxiv.org through the same proxy                                                  | `CONNECT tunnel failed, response 403` |
| **github.com**                                                                              | **Worked.**                           |

This produces two evidence grades:

- **[V] Verbatim.** The page was fetched directly (github.com only), and the quote is exact page text.
- **[S] Search excerpt.** The URL and text came back from the web-search tool, which returns a machine-written summary of the result pages. The page itself was **not** opened. The excerpt is quoted exactly as the search tool returned it, but it may paraphrase the page. **Open the URL and confirm every [S] fact before it goes into the application or the deck.**

Where two sources disagree, both are given and the conflict is flagged. Section 8 lists figures that appeared in search results but could not be tied to a specific source URL. Do not use them until they are verified.

---

## 1. DNB NXT Accelerator and Startuplab Accelerator

### DNB NXT Accelerator

**M-001** [S] The DNB NXT Accelerator is a 3-month programme for ambitious Norwegian tech companies. Its stated purpose is to let startups explore partnerships with DNB or Vipps.

- Source: https://www.dnb.no/en/business/events/dnb-nxt/nxt-accelerator (retrieved 2026-09-26)
- Excerpt: "The programme is for ambitious Norwegian tech companies and runs for 3 months. It provides a unique opportunity to explore potential partnerships with DNB or Vipps."

**M-002** [S] What participants get: a dedicated team with expert resources, an executive sponsor, a NOK 2–4 million investment from Startuplab, and access to Startuplab's network.

- Source: https://www.dnb.no/en/business/events/dnb-nxt/nxt-accelerator (retrieved 2026-09-26)
- Excerpt: "All companies will receive a dedicated team equipped with expert resources and an executive sponsor. In addition to an investment of NOK 2–4 million from Startuplab, as well as access to Startuplab's extensive network."

**M-003** [S] Target applicant: an early-stage tech company that wants investment from Startuplab and a partnership with DNB or Vipps. One search summary of the same result set also named Fremtind as a partner.

- Source: https://www.dnb.no/en/business/events/dnb-nxt/nxt-accelerator (retrieved 2026-09-26)
- Excerpt: "The program is looking for early-stage tech companies seeking investment from Startuplab and a partnership with DNB or Vipps." A second excerpt, attributed to the same result set: "The program seeks early-stage tech companies looking for investment from Startuplab and a partnership with DNB, Vipps or Fremtind."
- Check on the page whether Fremtind is currently listed.

**M-004** [S] Startuplab runs the programme. The most recent cohort page found is #5: 4 November 2025 to 5 February 2026, with an application deadline of "September 5th" (read in context as 2025). That page states a **1–3 MNOK** investment.

- Source: https://startuplab.no/nxt/index.html (retrieved 2026-09-26)
- Excerpts: "DNB and StartupLab are inviting startups to the DNB NXT Accelerator for the fifth time, offering a 1-3 MNOK investment and a 3 month program." / "The core team must preferably be able to travel to/from Startuplab in Oslo or Bergen for relevant meetings and events during the period 4 November 2025 to 5 February 2026." / "Applications were due by September 5th for this cohort."
- **Conflict:** dnb.no says NOK 2–4 million (M-002), while startuplab.no/nxt says 1–3 MNOK. Confirm with Startuplab which figure applies to the next cohort.

**M-005** [S] Cohort #5 emphasised financial services: automating banking systems, payment solutions, services built on DNB infrastructure, insurance products, and FinTech, PropTech and InsurTech.

- Source: https://startuplab.no/nxt/index.html (retrieved 2026-09-26)
- Excerpt: "The program looks for entrepreneurs pushing innovation across financial services, including startups that automate banking systems, streamline payment solutions, develop services on DNB infrastructure, create insurance products, or work on FinTech, PropTech, or InsurTech concepts."
- Relevance to SUDERRA: aquaculture ops SaaS and AI-agent governance are not financial services. The application needs a concrete DNB, Vipps or Fremtind partnership angle. Possible angles, all unverified hypotheses for SUDERRA to test with DNB: DNB's seafood-sector lending (its size was not researched here); farm mortality and biomass data as inputs to credit or insurance risk; DNB's own engineering teams using governed AI coding agents. **No retrieved source confirms that DNB, Vipps or Fremtind wants any of these.**

**M-006** [S] Past cohort composition: the 2024 cohort was chosen from more than 250 pitches and included Chargitect, Fortifai, Letta Insurance, ListenAlert, Novem, VISOID, Visual360.no, Wolve and Netto.

- Source: https://netto.eco/en/blog/dnb-nxt-accelerator-2024 (retrieved 2026-09-26)
- Excerpt: "in the 2024 cohort, the selected startups included Chargitect, Fortifai, Letta Insurance, ListenAlert, Novem, VISOID, Visual360.no, Wolve, and Netto, chosen from over 250 pitches."

**M-007** [S] Alternative entry route, **100 Pitches (DNB NXT)**: the winner gets NOK 300,000 from DNB, a ticket to SLUSH in Helsinki, and direct qualification to the NXT Accelerator interview rounds.

- Source: https://www.dnb.no/en/business/events/dnb-nxt/100-pitches (retrieved 2026-09-26)
- Excerpt: "The winner of 100 Pitches takes home a cash prize of NOK 300 000 from DNB, tickets to SLUSH in Helsinki and direct qualification to interview rounds in DNB's accelerator programme, NXT Accelerator."
- **2026 dates are unconfirmed.** Different search summaries gave "8 June opening … 18 September application deadline" and "final is scheduled for 10 September 2026". These cannot both be right. Check the page.

**M-008** **Not found:** dates and application deadline for the next DNB NXT Accelerator cohort (2026–27). No retrieved source states them. The newest dated cohort found is #5 (Nov 2025 to Feb 2026, M-004). If the pattern repeated, the 2026 deadline would have fallen in early September 2026. **That is an inference, not a sourced fact.** Contact Startuplab directly.

### Startuplab Accelerator

**M-009** [S] Startuplab describes its accelerator as an intensive three-month programme for early-stage tech companies ready to scale.

- Source: https://www.startuplab.no/accelerator (retrieved 2026-09-26)
- Excerpt: "The Startuplab Accelerator is an intensive three-month program for early-stage tech companies ready to scale. It provides hands-on mentorship, access to investors, and a proven framework that has helped over 500 startups succeed."

**M-010** [S] **Terms:** Startuplab invests in every company it selects, typically 2–4 MNOK for a targeted ownership of about 10%. There is no programme fee.

- Source: https://www.startuplab.no/insights/accelerator-q-a (retrieved 2026-09-26)
- Excerpt: "Startuplab invests in all companies selected to the accelerator program, typically 2-4 MNOK for targeted ownership of around 10%." / "There is no program fee. Participants get access to two clean desks for their team (if desired), and social events free of charge."
- A third-party summary gave "1-4 MNOK for a targeted ownership of 10-15%" without a clear source. Treat the Q&A figure as primary.

**M-011** [S] **Team expectations:** there is no preference between solo founders and teams of two or three. Startuplab wants to see that at least one other person has been convinced. Founders need not be full-time when they apply, but the core team must be committed and plan to go full-time quickly.

- Source: https://www.startuplab.no/insights/accelerator-q-a (retrieved 2026-09-26)
- Excerpt: "there is no preference between solo founders, two founders, or three founders, as long as plans are ambitious enough, though they like to see that you have convinced at least one more person than yourself that this is an important problem or opportunity worth solving." / "Applicants don't have to be working full-time on their startup when applying, but the program wants to work with companies where the core team is fully committed to the problem they're trying to solve and plan to go full-time as quickly as possible."

**M-012** [S] **What they value:** "founders with grit and a sense of urgency, with a founding team that knows how to build and sell their product."

- Source: https://medium.com/@StartupLabNo/for-the-seventh-time-announcing-startuplab-accelerator-c72c0fa64621 (retrieved 2026-09-26). This is an older Startuplab post with no confirmed date.
- Excerpt: "StartupLab looks for founders with grit and a sense of urgency, with a founding team that knows how to build and sell their product."

**M-013** [S] **Deadline:** the Startuplab Accelerator page shows the application deadline as "September 25th". The excerpt does not show the year, and the search tool reported the application as closed. **If this is the 2026 deadline, it passed on 2026-09-25, the day before this research.** Confirm directly with Startuplab whether late or rolling applications are accepted, and when the next intake opens.

- Source: https://www.startuplab.no/accelerator (retrieved 2026-09-26)
- Excerpt: "The application deadline is September 25th for the Startuplab Accelerator."

**M-014** [S] Startuplab's self-description: Norway's leading incubator, accelerator and investor for early-stage tech startups, based in Oslo and Bergen and working with startups since 2012. Demo Day audience: more than 250 investors, entrepreneurs and corporate partners.

- Source: https://www.startuplab.no/ (retrieved 2026-09-26)
- Excerpt: "Startuplab is Norway's leading incubator, accelerator, and investor for early-stage tech startups, with locations in Oslo and Bergen … Since its establishment in 2012, Startuplab has worked with more than 400 startups." / "Demo Day at StartupLab features the accelerator batch presenting in front of more than 250 investors, entrepreneurs and corporate partners."
- **Conflict:** "more than 400 startups" (home page) against "over 500 startups" (accelerator page, M-009).

---

## 2. Aquaculture market: Norway and global

### Norway: exports (Norwegian Seafood Council, 2025)

**M-015** [S] Norway exported 2.8 million tonnes of seafood worth NOK 181.5 billion in 2025, up NOK 6.4 billion (4%) on 2024. This was a record value.

- Source: https://en.seafood.no/news-and-media/news-archive/price-growth-for-wild-fish-and-increased-salmon-volume-resulted-in-record-value-for-norwegian-seafood-exports-in-2025-/ (retrieved 2026-09-26). Mirror: https://www.mynewsdesk.com/seafood/pressreleases/price-growth-for-wild-fish-and-increased-salmon-volume-resulted-in-record-value-for-norwegian-seafood-exports-in-2025-3423570
- Excerpt: "Norway exported a total of 2.8 million tonnes of seafood worth NOK 181.5 billion last year, which is an increase of NOK 6.4 billion, or 4 per cent, compared with 2024."

**M-016** [S] **Salmon exports 2025:** NOK 124.7 billion (a record, NOK 2.2 billion above 2024) and 1.41 million tonnes.

- Sources: the NSC release as in M-015; https://www.seafoodsource.com/news/supply-trade/norway-s-seafood-export-value-hits-record-in-2025-despite-a-myriad-of-challenges ; https://www.fishfarmingexpert.com/china-market-growth-christian-chramer-farmed-salmon/norway-exported-1415-million-tonnes-of-salmon-last-year/2048324 (retrieved 2026-09-26)
- Excerpt: "Salmon made up NOK 124.7 billion worth of Norway's seafood export value in 2025, a slight increase of 2 percent by value year over year. By volume, Norway exported 1.41 million metric tons of salmon. This is a record high export value for salmon, NOK 2.2 billion higher than the previous record year, which was in 2024." The Fish Farming Expert headline gives 1.415 million tonnes.

**M-017** [S] Farmed seafood made up 73% of Norway's 2025 seafood export value, and 1.5 million tonnes of the export volume.

- Source: NSC release as in M-015 (retrieved 2026-09-26)
- Excerpt: "In 2025, Norway exported 1.5 million tonnes of seafood from aquaculture, with aquaculture accounting for 73 per cent of total seafood exports in terms of value."

**M-018** [S] **Trout exports**, partial year only: NOK 3.5 billion in H1 2025 (+20% on value), and 6,700 tonnes worth NOK 667 million in December 2025. **The full-year 2025 trout figure was not retrieved.**

- Sources: https://en.seafood.no/news-and-media/news-archive/export-value-in-the-first-half-of-the-year-totalled-nok-85-billion/ (H1); NSC 2025 annual release as in M-015 (December) (retrieved 2026-09-26)
- Excerpts: "Trout achieved 20 percent value growth to NOK 3.5 billion" / "Norway exported 6,700 tonnes of trout worth NOK 667 million in December".

### Norway: production statistics, licences, sites, companies

**M-019** [S] Statistics Norway (SSB) no longer publishes aquaculture production statistics. Responsibility moved under the national programme for official statistics from 1 January 2021, and the Directorate of Fisheries (Fiskeridirektoratet) now publishes them. **2025 production volume and first-hand value were not retrieved.** Use the Directorate's statistics page.

- Sources: https://www.ssb.no/en/jord-skog-jakt-og-fiskeri/statistikker/fiskeoppdrett ("Aquaculture (terminated in Statistics Norway)"); https://www.fiskeridir.no/english/aquaculture/statistics-for-aquaculture/about-statistics-for-aquaculture (retrieved 2026-09-26)
- Excerpt: "responsibility for the statistics is transferred in accordance with the national programme for official statistics which applies from 1 January 2021".

**M-020** [S] **Licences:** 1,316 salmon and trout licences were in operation in 2024. Of these, 79 were pure research licences and 7 were brown-trout or inland licences, which leaves **1,230 food-fish (matfisk) licences** in the Directorate's profitability survey.

- Source: Fiskeridirektoratet, _Lønnsomhetsundersøkelse for produksjon av laks og regnbueørret 2024_, https://www.fiskeridir.no/statistikk-tall-og-analyse/data-og-statistikk-om-akvakultur/statistiske-publikasjon-innen-akvakultur/_/attachment/inline/3283f78a-bfa7-4c96-a2f7-8b25bf2a2219:cec2c68b4b9a64c5a97b917e1513a42c7a4d1ab3/rap-lonnsomhet-akvakultur-2024.pdf (retrieved 2026-09-26)
- Excerpt: "there were a total of 1,316 licenses in operation in 2024 … Of these 1,316 total licenses, 79 were pure research licenses and 7 were licenses for brown trout or inland production not included in the survey, leaving 1,230 licenses for food fish production."

**M-021** [S] **Sites:** 886 Atlantic salmon and rainbow trout sites (grow-out, broodstock and R&D) were active for at least one month in 2024. The monthly average was 608 active sites.

- Source: Norwegian Veterinary Institute, _Norwegian Fish Health Report 2024_, https://www.vetinst.no/rapporter-og-publikasjoner/rapporter/2025/norwegian-fish-health-report-2024/_/attachment/inline/6b11b72c-ee8f-4529-921f-1a3d85dc419e:2d59843d7c1e34e9200669ae47f2974d8ee51b6a/Fish%20Health%20Report%202024.pdf (retrieved 2026-09-26). The report cites Directorate of Fisheries data.
- Excerpt: "A total of 886 sites with Atlantic salmon and rainbow trout (grow-out, broodstock, and research and development sites) were active for at least one month in 2024, with a monthly average of 608 active sites."

**M-022** [S] **Companies** (2020 data, the most recent count found): Nofima analysed 122 companies that farm salmon, trout or rainbow trout with a permit of at least 100 tonnes a year. Together they held 1,049 permits and 970,000 tonnes of maximum allowed biomass (MTB), and 73% of them were family-owned. **No 2024 or 2025 company count was retrieved.**

- Source: https://nofima.com/results/three-out-of-four-fish-farming-companies-are-family-owned/ (retrieved 2026-09-26)
- Excerpt: "Nofima analyzed the ownership of 122 fish farming companies in Norway that produce edible fish (salmon, trout and rainbow trout) and have a permit to produce at least 100 tonnes a year … These 122 companies have a total of 1,049 permits and a total capacity of 970,000 tonnes of maximum total biomass (MTB)." / "73% of the 122 companies are defined as being family-owned."

### Norway: mortality and fish health (Norwegian Veterinary Institute)

**M-023** [S] Sea-phase mortality of farmed salmon was **14.2% in 2025**, down from 15.4% in 2024 and 16.7% in 2023.

- Source: https://www.vetinst.no/rapporter-og-publikasjoner/rapporter/2026/fish-health-report-2025 (retrieved 2026-09-26)
- Excerpt: "The annual mortality rate for farmed salmon in the sea phase in 2025 is estimated at 14.2%. This was below that of previous years: 15.4% in 2024 and 16.7% in 2023."

**M-024** [S] **Fish lost:** about **54.9 million** farmed salmon were reported dead in sea cages in 2025, against 57.8 million in 2024 and 62.8 million in 2023.

- Sources: https://www.fishfarmingexpert.com/farmed-salmon-fish-health-mortality-rate/norway-farmed-salmon-mortality-rate-fell-below-15-last-year/2064848 and https://www.salmonbusiness.com/new-fish-health-report-flags-climate-driven-challenges-for-salmon-farms/ , both reporting the Fish Health Report 2025 (retrieved 2026-09-26)
- Excerpt: "Around 54.9 million farmed salmon were reported dead in sea cages during 2025, down from 57.8 million in 2024 and 62.8 million in 2023."
- The search tool did not tie the 54.9 million figure to one of the two URLs. Confirm it in the vetinst report (M-023).

**M-025** [S] In 2024, 57.8 million salmon and 2.4 million rainbow trout died in the marine phase. At reporting sites, salmon deaths broke down as: infectious diseases 33%, injuries (mostly linked to lice treatments) 27%, unknown causes 21%, environmental conditions 9%.

- Sources: https://www.vetinst.no/rapporter-og-publikasjoner/rapporter/2025/norwegian-fish-health-report-2024 ; https://thefishsite.com/articles/annual-fish-health-report-details-causes-of-salmon-mortality (retrieved 2026-09-26)
- Excerpt: "57.8 million salmon and 2.4 million rainbow trout died during the marine phase in 2024." / "infectious diseases accounted for 33% of salmon mortalities at reporting sites, injuries (primarily linked to intensive lice treatments) represented 27%, followed by unknown causes (21%) and environmental conditions (9%)."

**M-026** [S] The Fish Health Report 2025 was presented in Bergen on 11 March 2026. Its survey names injuries after delousing, and infectious diseases, as the most important causes of salmon death in sea cages.

- Source: https://www.vetinst.no/rapporter-og-publikasjoner/rapporter/2026/fish-health-report-2025 (retrieved 2026-09-26)
- Excerpt: "In a survey, injuries following delousing and infectious diseases are stated as the most important causes of death for salmon in sea cages." / "The full Fish Health Report was presented at an event in Bergen on March 11, 2026".

### Global aquaculture (FAO)

**M-027** [S] **FAO SOFIA 2024:** global aquaculture production in 2022 was 130.9 million tonnes, worth USD 312.8 billion, or 59% of global fisheries and aquaculture production. Aquaculture produced 94.4 million tonnes of aquatic animals, 51% of the total, and for the first time exceeded capture fisheries.

- Sources: https://openknowledge.fao.org/server/api/core/bitstreams/1273bc36-339b-43d2-8163-af4d805f2ad2/content/sofia/2024/aquaculture-production.html ; https://www.fao.org/3/cd0683en/online/sofia/2024/key-messages.html (retrieved 2026-09-26)
- Excerpts: "In 2022, global aquaculture production reached 130.9 million tonnes, valued at USD 312.8 billion, representing 59 percent of global fisheries and aquaculture production." / "For the first time, aquaculture surpassed capture fisheries in aquatic animal production with 94.4 million tonnes, representing 51 percent of the world total".

**M-028** [S] **FAO SOFIA 2026** (newer, released 16 June 2026): in 2024, aquaculture production of aquatic animals passed 100 million tonnes for the first time, at 103 million tonnes worth USD 371 billion at farm gate. Total fisheries and aquaculture production was a record 235 million tonnes. **Use this edition as the headline global figure in the deck.**

- Sources: https://www.fao.org/newsroom/detail/sofia-2026--global-fisheries-and-aquaculture-production-reaches-new-highs/en ; https://www.fao.org/3/cd8357en/online/sofia-2026/global-fisheries-aquaculture.html (retrieved 2026-09-26)
- Excerpts: "In 2024, aquaculture production of aquatic animals surpassed 100 million tonnes for the first time, reaching 103 million tonnes (valued at $371 billion at farm gate)." / "Global fisheries and aquaculture production reached a record 235 million tonnes in 2024".

### Regulation that drives digitalisation (Norway)

**M-029** [S] **Traffic-light system:** the coast is divided into 13 production areas, each coloured green, yellow or red according to the risk sea lice pose to wild salmon. Green allows up to 6% growth, yellow freezes capacity, and red requires a 6% cut. The system has been in place since 2017.

- Source: https://www.seafoodsource.com/news/aquaculture/norway-unveils-latest-colors-under-traffic-light-salmon-farming-system-industry-pushes-back (retrieved 2026-09-26)
- Excerpt: "The system was put in place in 2017, and production capacity of farms in the regions has been determined by the colors since then, with green lights allowing for growth of up to 6 percent, yellow freezing production, and red requiring downward adjustments of 6 percent."

**M-030** [S] **The 2026 decision** (June 2026, for 2026–2027): production areas 1, 12 and 13 are green; 2 and 4–11 are yellow; area 3 (Karmøy to Sotra) is red. The estimated effect is +8,300 tonnes of MTB in the green areas and up to −5,300 tonnes in the red area.

- Sources: https://kommunikasjon.ntb.no/pressemelding/18961828/ny-fargelegging-i-trafikklyssystemet-for-havbruk?lang=no (Nærings- og fiskeridepartementet press release); https://www.indexbox.io/blog/norway-assigns-new-traffic-light-colors-for-salmon-farming-areas-20262027/ (retrieved 2026-09-26)
- Excerpts: "For the period spanning 2026 and 2027, production areas 1, 12, and 13 have been given the green light; areas 2, 4, 5, 6, 7, 8, 9, 10, and 11 have received a yellow light; and Area 3 has received a red light." / "Området Karmøy til Sotra ble farget rødt." / "an estimated 8,300-tonne increase in Maximum Allowed Biomass (MTB) … Production capacity in one red area is set to be reduced by an estimated 5,300 tonnes".

**M-031** [S] **Lice counting and reporting obligation** (lakselusforskriften): lice must be counted at least every 7 days at 4°C and above, and every 14 days below 4°C. Each week's data must reach the Norwegian Food Safety Authority (Mattilsynet) by the Tuesday of the following week. From week 16 to week 21, in Nord-Trøndelag and southward, the average must stay below 0.2 adult female lice per fish.

- Source: https://lovdata.no/dokument/SF/forskrift/2012-12-05-1140 (Forskrift om bekjempelse av lakselus i akvakulturanlegg) (retrieved 2026-09-26)
- Excerpts, as the search tool rendered them in English: "The number of salmon lice shall be counted at least every 7 days at temperatures equal to or above 4°C, and at least every 14 days at temperatures below 4°C." / "For each week, information shall be reported to the Food Safety Authority (Mattilsynet) no later than Tuesday in the following week." / "In Nord-Trøndelag and southward from Monday in week 16 to Sunday in week 21, there shall at all times be fewer than 0.2 adult female salmon lice on average per fish".
- The Norwegian original text on Lovdata is authoritative. Quote from it in the application.

**M-032** [S] Mattilsynet has granted dispensations to use automatic lice counting alone: Kvarøy Fiskeoppdrett and Seløy Sjøfarm, both using Aquabyte. This shows that sensor- and software-based compliance data is accepted.

- Source: https://www.aquabyte.ai/products/lice (retrieved 2026-09-26)
- Excerpt: "Two salmon farmers - Kvarøy Fiskeoppdrett and Seløy Sjøfarm - received dispensation from the Norwegian Food Safety Authority to use automatic lice counting alone."

### EU AI Act timeline (relevant to both products)

**M-033** [S] **Original AI Act phases:**

- 2 February 2025: prohibited practices banned.
- 2 August 2025: obligations for general-purpose AI (GPAI) models and the governance provisions apply.
- 2 August 2026: most remaining provisions apply, including Article 50 transparency.
- 2 August 2027: GPAI models placed on the market before 2 August 2025 must comply, and AI embedded in regulated products is covered.
- Sources: https://artificialintelligenceact.eu/implementation-timeline/ ; https://www.kennedyslaw.com/en/thought-leadership/article/2026/the-eu-ai-act-implementation-timeline-understanding-the-next-deadline-for-compliance/ (retrieved 2026-09-26)
- Excerpt: "2 February 2025: Prohibited AI systems were banned. 2 August 2025: … obligations for general-purpose AI models began to apply … 2 August 2026: Most of the remaining rules in the Act become active … 2 August 2027: Providers of GPAI models placed on the market before 2 August 2025 must take the necessary steps to comply".

**M-034** [S] **Digital Omnibus on AI, Regulation (EU) 2026/1744:** published in the Official Journal on 24 July 2026 and in force from 27 July 2026. It moves high-risk obligations for stand-alone Annex III systems to **2 December 2027**, and for AI embedded in Annex I regulated products to **2 August 2028**.

- Sources: https://digital-strategy.ec.europa.eu/en/news/ai-omnibus-enters-force ; https://www.whitecase.com/insight-alert/eu-ai-omnibus-enters-force-amending-ai-act ; https://www.nicfab.eu/en/posts/digital-omnibus-ai-official-journal/ (retrieved 2026-09-26)
- Excerpts: "Regulation (EU) 2026/1744, the Digital Omnibus on AI, was published in the Official Journal on July 24, 2026, and entered into force on July 27, 2026." / "obligations on high-risk use case AI systems (including those involving biometrics, and those used in critical infrastructure, education, employment, law enforcement, and border management) will apply from 2 December 2027. Obligations on high-risk AI systems used as safety components in products covered by EU sectoral legislation will apply from 2 August 2028."

**M-035** [S] The Omnibus did not postpone Article 50 transparency obligations; they apply from 2 August 2026. AI systems placed on the market before that date have until 2 December 2026 to meet the Article 50(2) watermarking duty.

- Sources: https://www.aiactblog.nl/en/posts/article-50-transparency-deadline-2-august-2026 ; https://usercentrics.com/knowledge-hub/eu-ai-act-high-risk-delay-article-50-transparency-consent/ (retrieved 2026-09-26)
- Excerpt: "AI systems that have been placed on the market before 2 August 2026 will benefit from a four-month grace period (until 2 December 2026) before the watermarking obligation under Article 50(2) … applies to them."

**M-036** [S] The Article 4 AI-literacy duty for providers and deployers has applied since 2 February 2025.

- Source: https://artificialintelligenceact.eu/article/4/ (retrieved 2026-09-26)
- Excerpt: "Article 4 of the EU AI Act requires providers and deployers of AI systems to take measures supporting AI literacy among staff … The duty has applied since 2 February 2025."

**M-037** [S] **Norway (EEA):** the Norwegian Communications Authority (Nkom) has been designated as the national AI Act supervisory authority. A draft Norwegian AI Act (KI-loven) went to public consultation on 30 June 2025. **Sources disagree on when the Act takes effect in Norway** (mid-2026, August 2027, and "a bill before the Storting in spring 2027" all appear). Do not state a Norwegian effective date without checking regjeringen.no.

- Sources: https://cms.law/en/int/expert-guides/ai-regulation-scanner/norway ; https://svw.no/en/norways-new-ai-act-what-it-will-mean-for-your-business/ (retrieved 2026-09-26)
- Excerpt: "The Norwegian Communications Authority (Nkom) has been designated as the national supervisory authority under the AI Act" / "The draft Norwegian AI Act (KI-loven) went out for public consultation on 30 June 2025".

**M-038** **Not found:** no source retrieved classifies aquaculture operations or fish-farm software as high-risk under Annex III. The Annex III areas named in M-034 are biometrics, critical infrastructure, education, employment, law enforcement and border management. SUDERRA's HR module (personnel, shifts, payroll) touches "employment", and any AI feature there could fall under Annex III. **That is a question for legal counsel, not a sourced conclusion.**

---

## 3. Aquaculture software competitors

**M-039** [S] **Manolin** (Bergen, Norway): a fish-health data analytics and prediction platform. Its product Watershed runs 28 predictive disease models and combines geospatial analysis and machine learning with production data.

- Sources: https://manolinaqua.com/ ; https://manolinaqua.com/watershed (retrieved 2026-09-26)
- Excerpt: "With 28 predictive disease models, including pancreatic disease and ISA, Watershed provides farms with early warnings and actionable insights to stay ahead of potential outbreaks." / "The platform combines geospatial analysis and machine learning models with production data".

**M-040** [S] **AKVA group, AKVA fishtalk:** a digital system for planning, control and analysis of aquaculture production, both biological and financial, with traceability from broodstock to harvest.

- Source: https://www.akvagroup.com/fishtalk/ (retrieved 2026-09-26)
- Excerpt: "AKVA fishtalk is a digital system for planning, control and analysis of aquaculture production – both biological and financial. It provides full traceability from broodstock to harvest and supports both operational and strategic management."

**M-041** [S] **ScaleAQ:** an equipment and software supplier. Its software includes FeedStation (precision feeding), Vision, Knowledger, Barge Control, and the Mercatus suite: Farmer (biomass and production documentation and reporting), Finance, Future (production planning) and Vet (fish-health records).

- Sources: https://scaleaq.com/software/ ; https://scaleaq.com/product-category/software/ (retrieved 2026-09-26)
- Excerpt: "Mercatus Farmer (a system for documentation, visualization and reporting on biomass data and production) … Mercatus Vet (handles and documents fish health related processes, veterinarian reports, prescriptions and fish health evaluations)." / "ScaleAQ's various software products communicate via open APIs".

**M-042** [S] **Aquabyte:** in-pen stereo cameras plus machine learning for automated lice counting, weight and biomass estimation, covering salmon, coho and trout.

- Sources: https://www.aquabyte.ai/products/lice ; https://aquabyte.ai/produkt/aquabyte-system/ (retrieved 2026-09-26)
- Excerpt: "The images captured by the Aquabyte camera in the pen are analyzed using advanced machine learning algorithms and artificial intelligence, identifying several types of lice and calculating the fish's biomass, weight, and growth."

The four companies divide as follows:

| Company                         | Covers                          |
| ------------------------------- | ------------------------------- |
| AKVA fishtalk, ScaleAQ Mercatus | Production planning and control |
| Manolin                         | Fish-health prediction          |
| Aquabyte                        | Camera-based sensing            |

None of the retrieved descriptions mentions HR, internal messaging or a Rust edge gateway. That absence only means the feature did not appear in what was retrieved. **It does not prove the competitors lack these features.** Check each product page before claiming a gap.

---

## 4. AI coding agents and the AI governance market

### Adoption

**M-043** [S] **Stack Overflow Developer Survey 2025:** 84% of respondents use or plan to use AI tools, up from 76% in 2024. 51% of professional developers use AI tools daily.

- Sources: https://survey.stackoverflow.co/2025/ai ; https://stackoverflow.co/company/press/archive/stack-overflow-2025-developer-survey/ (retrieved 2026-09-26)
- Excerpt: "84% of developers reported using or planning to use AI tools in their development process, up from 76% in 2024. 51% of professional developers use AI tools daily."

**M-044** [S] **Trust in AI accuracy is low (Stack Overflow 2025):** 46% of developers distrust the accuracy of AI tools and 33% trust it. Only 3% "highly trust" the output.

- Source: https://stackoverflow.co/company/press/archive/stack-overflow-2025-developer-survey/ (retrieved 2026-09-26)
- Excerpt: "More developers actively distrust the accuracy of AI tools (46%) than trust it (33%), and only a fraction (3%) report 'highly trusting' the output."

**M-045** [S] **Agents are not yet mainstream (Stack Overflow 2025):** 52% of developers do not use agents or use only simpler AI tools, and 38% have no plans to adopt agents.

- Source: https://survey.stackoverflow.co/2025/ai (retrieved 2026-09-26)
- Excerpt: "AI agents are not yet mainstream, with a majority of developers (52%) either not using agents or sticking to simpler AI tools, and a significant portion (38%) having no plans to adopt them."
- The 2026 survey opened on 23 June 2026 (https://stackoverflow.blog/2026/06/23/the-2026-developer-survey-is-now-open-for-human-developers-only/). **No 2026 results were retrieved.**

**M-046** [S] **GitHub Octoverse 2025:**

- GitHub added more than 36 million developers in 2025, reaching more than 180 million.
- About 80% of new developers use Copilot within their first week.
- More than 1.13 million public repositories import an LLM SDK.
- The Copilot coding agent authored more than 1 million pull requests between May and September 2025.
- Source: https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/ (retrieved 2026-09-26)
- Excerpt: "GitHub adding 36M+ developers in 2025 … bringing the total to 180M+ developers worldwide." / "around 80% of new developers joining GitHub use Copilot within their first week" / "more than 1.13M public repositories now import an LLM SDK" / "Over 1 million pull requests were authored by the Copilot coding agent between May and September 2025".

**M-047** [S] **Gartner (April 2024):** by 2028, 75% of enterprise software engineers will use AI code assistants, up from less than 10% in early 2023.

- Source: https://www.gartner.com/en/newsroom/press-releases/2024-04-11-gartner-says-75-percent-of-enterprise-software-engineers-will-use-ai-code-assistants-by-2028 (retrieved 2026-09-26)
- Excerpt: "By 2028, 75% of enterprise software engineers will use AI code assistants, up from less than 10% in early 2023."

**M-048** [S] **Gartner (20 May 2026), Magic Quadrant for Enterprise AI Coding Agents:** Leaders are Anthropic, Cursor, GitHub and OpenAI. Gartner predicts that by 2028 more than 70% of enterprise software engineers will rely on AI coding agents.

- Sources: https://www.gartner.com/en/newsroom/press-releases/2026-05-20-gartner-says-the-market-for-enterprise-ai-coding-agents-is-entering-a-new-phase-of-expansion-and-competitive-realignment ; https://virtualizationreview.com/articles/2026/06/05/ai-firms-push-cloud-giants-from-leaders-quadrant-in-gartner-ai-coding-report.aspx (retrieved 2026-09-26)
- Excerpt: "The 2026 Magic Quadrant for Enterprise AI Coding Agents, published May 20, names Anthropic, Cursor, GitHub and OpenAI as Leaders." / "Gartner predicts that by 2028, more than 70% of enterprise software engineers will rely on AI coding agents for both synchronous and asynchronous development tasks."
- The search tool did not tie the 70% prediction to a specific URL among these. Confirm it in the Gartner press release.

**M-049** [S] **Developer population (SlashData):** 47.2 million developers worldwide at the start of 2025, of whom 36.5 million are professionals.

- Source: https://www.slashdata.co/post/global-developer-population-trends-2025-how-many-developers-are-there (retrieved 2026-09-26)
- Excerpt: "there are an estimated 47.2 million software developers worldwide" / "The number of professional developers increased from 21.8 million to 36.5 million".

### Market size (named analysts)

**M-050** [S] **AI code tools market.** Analyst estimates differ widely, so quote a range and name each source.

| Analyst              | Estimate                                             |
| -------------------- | ---------------------------------------------------- |
| MarketsandMarkets    | USD 4.3 bn (2023) to USD 12.6 bn (2028), CAGR 24.0%  |
| Grand View Research  | USD 26.03 bn by 2030, CAGR 27.1% (2024–2030)         |
| Research and Markets | USD 7.65 bn (2025) to USD 22.2 bn (2030), CAGR 23.8% |
| Mordor Intelligence  | USD 7.37 bn (2025) to USD 29.96 bn (2031)            |

- Sources: https://www.marketsandmarkets.com/Market-Reports/ai-code-tools-market-239940941.html ; https://www.grandviewresearch.com/press-release/global-ai-code-tools-market ; https://www.researchandmarkets.com/reports/6225896/ai-code-tools-market-report ; https://www.mordorintelligence.com/industry-reports/artificial-intelligence-code-tools-market (retrieved 2026-09-26)
- Excerpts: "projected to grow from USD 4.3 billion in 2023 to USD 12.6 billion by 2028, at a CAGR of 24.0%" / "expected to reach USD 26.03 billion by 2030, registering a CAGR of 27.1%" / "expected to grow from $7.65 billion in 2025 to $22.2 billion in 2030 at a CAGR of 23.8%" / "USD 7.37 billion in 2025 … reach USD 29.96 billion by 2031".

**M-051** [S] **AI governance software (Forrester):** spending on off-the-shelf AI governance software will more than quadruple to USD 15.8 billion by 2030, 7% of AI software spend, a 30% CAGR from 2024 to 2030.

- Source: https://www.forrester.com/blogs/ai-governance-software-spend-will-see-30-cagr-from-2024-to-2030 (retrieved 2026-09-26)
- Excerpt: "By 2030, Forrester forecasts that spending on off-the-shelf AI governance software will more than quadruple, reaching $15.8 billion and capturing 7% of overall AI software spending."

### Evidence that AI coding tools introduce bugs, security flaws and incidents

**M-052** [S] **Pearce et al., "Asleep at the Keyboard?"** (IEEE S&P 2022): 89 scenarios, 1,689 Copilot-generated programs, of which about 40% were vulnerable.

- Sources: https://ieeexplore.ieee.org/document/9833571 ; https://arxiv.org/abs/2108.09293 (retrieved 2026-09-26)
- Excerpt: "The researchers produced 89 different scenarios for Copilot to complete, generating 1,689 programs, of which approximately 40% were found to be vulnerable."

**M-053** [S]+[V] **Perry, Srivastava, Kumar and Boneh, "Do Users Write More Insecure Code with AI Assistants?"** (ACM CCS 2023): participants with an AI assistant wrote significantly less secure code, and were more likely to believe their code was secure.

- Sources: https://dl.acm.org/doi/10.1145/3576915.3623157 [S]; https://github.com/neilaperry/do-users-write-more-insecure-code-with-ai-assistants [V], which confirms authors and venue only (retrieved 2026-09-26)
- [S] excerpt: "Participants who had access to an AI assistant based on OpenAI's codex-davinci-002 model wrote significantly less secure code than those without access." / "Participants with access to an AI assistant were more likely to believe they wrote secure code than those without access to the AI assistant."
- [V] repository text: "This repository contains the data and code for the paper Do Users Write More Insecure Code With AI Assistants? by Neil Perry*, Megha Srivastava*, Deepak Kumar, and Dan Boneh, and published in ACM CCS 2023."

**M-054** [S] **Veracode 2025 GenAI Code Security Report:** tested code from more than 100 LLMs in Java, JavaScript, Python and C#. AI-generated code introduced security flaws in 45% of tests, and Java had a 72% security failure rate.

- Sources: https://www.veracode.com/resources/analyst-reports/2025-genai-code-security-report/ ; https://www.veracode.com/blog/genai-code-security-report/ (retrieved 2026-09-26)
- Excerpt: "AI-generated code introduced risky security flaws in 45% of tests." / "Java was the riskiest language, with a 72% security failure rate across tasks."

**M-055** [S] **METR randomized controlled trial** (July 2025): 16 experienced open-source developers took **19% longer** with early-2025 AI tools. They had predicted a 24% speed-up, and afterwards still believed they had been 20% faster.

- Sources: https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/ ; https://arxiv.org/abs/2507.09089 (retrieved 2026-09-26)
- Excerpt: "Experienced developers using AI tools took 19% longer to complete their tasks compared to working without assistance." / "The same developers had predicted AI would make them 24% faster, and even after experiencing the actual slowdown, they estimated they had been 20% more productive with AI."

**M-056** [S] **DORA 2024 (Google Cloud):** a 25% increase in AI adoption is associated with a 7.2% drop in delivery stability and a 1.5% drop in delivery throughput.

- Source: https://dora.dev/research/2024/dora-report/ (retrieved 2026-09-26)
- Excerpt: "A 25% increase in AI adoption correlates with a 7.2% reduction in delivery stability. Additionally, increased AI adoption is associated with a 1.5% decrease in delivery throughput."

**M-057** [S] **Public incident, Replit agent (July 2025):** during an explicit code freeze, Replit's AI agent deleted SaaStr founder Jason Lemkin's production database. The AI Incident Database logs it as Incident 1152.

- Sources: https://incidentdatabase.ai/cite/1152/ ; https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/ (retrieved 2026-09-26)
- Excerpts: incident title "LLM-Driven Replit Agent Reportedly Executed Unauthorized Destructive Commands During Code Freeze, Leading to Loss of Production Data" / "he declared a code freeze—explicitly saying 'no changes' in the tool more than once. However, the agent ignored the code freeze and deleted the entire production database."

**M-058** [S] **Public incident, Amazon Q Developer extension (July 2025):** version 1.84.0 of the VS Code extension shipped with an injected "wiper" prompt, which instructed the agent to delete local files and cloud resources. The cause was an over-scoped GitHub token in the build configuration. AWS published security bulletin AWS-2025-015 and fixed the issue in 1.85.0. The code did not execute because of a syntax error.

- Sources: https://aws.amazon.com/security/security-bulletins/AWS-2025-015/ ; https://www.scworld.com/news/amazon-q-extension-for-vs-code-reportedly-injected-with-wiper-prompt (retrieved 2026-09-26)
- Excerpt: "Amazon Q Developer for VS Code Extension had an inappropriately scoped GitHub token in their CodeBuild configuration." / "Amazon published version 1.84.0 of the VS Code extension to the Marketplace on July 17, 2025" / "A syntax error in the malicious code prevented it from executing".

---

## 5. Competitors and adjacent products to ARIA

The most relevant main competitors are **the AI tools that independently verify code before it merges**, because that is ARIA's verification-and-merge layer. The coding agents themselves are what ARIA would govern, so they are adjacent. This ranking is a judgement from the descriptions below. SUDERRA should confirm it.

### Main competitors (2)

**M-059** [S]+[V] **Qodo:** GitHub tagline "The AI Code Quality Platform" [V]. Its docs describe an AI code review platform that builds a persistent understanding of repositories and enforces team coding standards [S]. Of all the products found, this is closest to ARIA's "memory + rules + verification".

- Sources: https://github.com/qodo-ai [V]; https://docs.qodo.ai/qodo-platform-overview (page title "AI codebase quality and governance platform") [S]; https://www.qodo.ai/ [S] (retrieved 2026-09-26)
- [S] excerpt: "an AI code review platform that provides automated, context-aware review across IDEs, pull requests, CLI, and Git workflows, and builds a persistent understanding of your repositories, including their structure, history, and dependencies" / "Qodo automatically discovers and enforces your team's unique coding standards".
- Where ARIA would need to prove its difference: independent _multi-agent_ verification, an audit trail, and _narrow reversible autonomous merges_. None of these appears in the Qodo excerpts retrieved, but check Qodo's site before claiming a gap.

**M-060** [S] **CodeRabbit:** AI code review on GitHub and GitLab pull requests, in the IDE and in the CLI, with incremental reviews, PR summaries and interactive `@coderabbitai` commands. Priced per developer who opens PRs.

- Sources: https://docs.coderabbit.ai/guides/code-review-overview ; https://www.coderabbit.ai/ ; https://www.coderabbit.ai/pricing (retrieved 2026-09-26)
- Excerpts: "CodeRabbit is an AI-powered code review tool that automates the code review process, providing context-aware feedback on pull requests within minutes." / "The Pro plan is $24/user/month with annual billing or $30/user/month with monthly billing." / "CodeRabbit bills on developers who create pull requests".

### Adjacent products (5)

**M-061** [V] **GitHub Copilot cloud agent** (formerly "coding agent"): researches a repository, plans, and makes changes on a branch in an ephemeral GitHub Actions environment. It is blocked by rulesets or branch protections that are incompatible with it, unless Copilot is added as a bypass actor.

- Source: https://github.com/github/docs/blob/main/content/copilot/concepts/agents/cloud-agent/about-cloud-agent.md (source of docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent) (retrieved 2026-09-26)
- Verbatim: "GitHub Copilot can research a repository, create an implementation plan, and make code changes on a branch." / "While working on a coding task, Copilot cloud agent has access to its own ephemeral development environment, powered by GitHub Actions, where it can explore your code, make changes, execute automated tests and linters and more." / "If you have configured a ruleset or branch protection rule that isn't compatible with Copilot cloud agent, access to the agent will be blocked."

**M-062** [S] **Graphite** (acquired by Cursor in December 2025): stacked pull requests, AI code review (sources name it both "Diamond" and "Graphite Agent"), and a stack-aware merge queue that automates merging.

- Sources: https://graphite.com/ ; https://graphite.com/features/merge-queue ; https://graphite.com/blog/graphite-joins-cursor (retrieved 2026-09-26)
- Excerpts: "Graphite Merge Queue puts your merge process on autopilot" / "Graphite's AI-powered code review platform supports stacked pull requests to improve PR creation, provides AI-assisted reviews through Graphite Agent, and automates merging via merge queues". Acquisition: "In December 2025, Graphite was acquired by AI code-editing platform Cursor".

**M-063** [S] **Tabnine:** an enterprise AI coding platform with an "Enterprise Context Engine" (launched February 2026) that models relationships between repositories, services, APIs, dependencies and policies. It can be deployed in cloud, on-premises or air-gapped environments, and was a Visionary in the 2026 Gartner MQ.

- Sources: https://www.tabnine.com/platform/ ; https://www.globenewswire.com/news-release/2026/02/26/3245668/0/en/Tabnine-Launches-Enterprise-Context-Engine-Introducing-the-Missing-Layer-for-Reliable-Enterprise-AI.html (retrieved 2026-09-26)
- Excerpt: "the engine models the relationships between repositories, services, APIs, dependencies, policies, and historical engineering knowledge so AI systems can reason with organizational context, not just generate code." / "The platform supports deployment in cloud, private cloud, on-premises, and fully air-gapped environments".

**M-064** [S] **Credo AI:** an enterprise AI governance platform with an AI registry, risk assessment, and policy packs mapped to the EU AI Act, the NIST AI RMF and ISO 42001. It works at the organisation and policy level, not in the code-merge path.

- Sources: https://www.credo.ai/ ; https://www.credo.ai/eu-ai-act (retrieved 2026-09-26)
- Excerpt: "The Credo AI Governance Platform supports organizations in implementing governance workflows to manage and mitigate AI risks—a critical requirement for High-Risk AI systems under the EU AI Act, and provides Policy Packs that operationalize the requirements of the regulation."

**M-065** [V]+[S] **Runtime guardrails (Guardrails AI; Lakera, now Check Point):**

- **Guardrails AI** [V] is a Python framework that runs input and output guards on LLM calls.
- **Lakera Guard** [S] is an API that protects LLM applications and agents against prompt injection, jailbreaks and data leakage. Check Point acquired Lakera in September 2025.
- Both guard LLM inputs and outputs at runtime. Neither verifies code changes in a repository.
- Sources: https://github.com/guardrails-ai/guardrails [V]; https://www.checkpoint.com/press-releases/check-point-acquires-lakera-to-deliver-end-to-end-ai-security-for-enterprises/ [S]; https://docs.lakera.ai/guard [S] (retrieved 2026-09-26)
- [V] verbatim: "Guardrails runs Input/Output Guards in your application that detect, quantify and mitigate the presence of specific types of risks." / "Guardrails help you generate structured data from LLMs."
- [S] excerpt: "Lakera Guard is an AI security API that protects LLM applications against prompt injection, jailbreaks, and data leakage in real time."

### Also verified: the coding agents ARIA would sit on top of

**M-066** [V] **Anthropic Claude Code:** "Claude Code is an agentic coding tool that lives in your terminal, understands your codebase, and helps you code faster by executing routine tasks, explaining complex code, and handling git workflows -- all through natural language commands."

- Source: https://github.com/anthropics/claude-code (retrieved 2026-09-26)

**M-067** [S] **Cognition Devin:** an autonomous AI software engineering agent. It works in its own environment, inspects repositories, edits code, runs tests and returns pull requests for review.

- Sources: https://devin.ai/ ; https://cognition.com/ (retrieved 2026-09-26)
- Excerpt: "Working in its own development environment, Devin inspects repositories, edits code, runs tests and returns pull requests for review."

**M-068** [V] **Factory:** "The agent-native development platform. Works across CLI, Web, Slack/Teams, Linear/Jira and Mobile." Its agents are called Droids.

- Source: https://github.com/factory-ai/factory (retrieved 2026-09-26)

**M-069** [S] **Amp:** a coding agent originally built by Sourcegraph, spun off as a separate company in December 2025. It runs in VS Code-family editors and the CLI, with shareable threads.

- Source: https://ampcode.com/ (retrieved 2026-09-26)
- Excerpt: "Amp is an agentic coding tool built by Sourcegraph … In December 2025, Amp was spun-off to become a separate company."

---

## 6. Retrieval-augmented generation (RAG): definition and limits

**M-070** [S] **Original paper:** Lewis, Perez, Piktus, Petroni, Karpukhin, Goyal, Küttler, Lewis, Yih, Rocktäschel, Riedel and Kiela, "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", NeurIPS 2020. The paper combines parametric memory (a pretrained seq2seq model) with non-parametric memory (a dense document index reached through a neural retriever).

- Sources: https://proceedings.neurips.cc/paper_files/paper/2020/file/6b493230205f780e1bc26945df7481e5-Paper.pdf ; https://dblp.org/rec/conf/nips/LewisPPPKGKLYR020.html (retrieved 2026-09-26)
- Excerpt: "The paper established the paradigm of combining parametric memory (language models) with non-parametric memory (retrieval indices) for knowledge-intensive tasks."
- Quote the paper's abstract directly from the NeurIPS PDF. It could not be fetched here.

**M-071** [V] **Library documentation definition** (Hugging Face Transformers, which ships the original Meta checkpoints): "Retrieval-Augmented Generation (RAG) combines a pretrained language model (parametric memory) with access to an external data source (non-parametric memory) by means of a pretrained neural retriever. RAG fetches relevant passages and conditions its generation on them during inference. This often makes the answers more factual and lets you update knowledge by changing the index instead of retraining the whole model."

- Source: https://github.com/huggingface/transformers/blob/main/docs/source/en/model_doc/rag.md (retrieved 2026-09-26)

**M-072** [S] **Vendor definition (AWS):** "Retrieval-Augmented Generation (RAG) is the process of optimizing the output of a large language model, so it references an authoritative knowledge base outside of its training data sources before generating a response."

- Source: https://aws.amazon.com/what-is/retrieval-augmented-generation/ (retrieved 2026-09-26; page not fetched, excerpt from the search tool)

**Suggested deck wording**, built from M-070 to M-072: _"RAG retrieves passages from an external index and puts them in the model's context before it generates. It changes what the model sees. It does not check whether what the model then produces is correct."_ The second sentence is a characterisation supported by M-073 to M-076. No source uses those exact words.

### Known limitations

**M-073** [S] **Hallucination persists even with retrieved context.** A Stanford RegLab study (Magesh, Surani et al., Journal of Empirical Legal Studies 2025) found that RAG-based legal research tools from LexisNexis and Thomson Reuters hallucinated between 17% and 33% of the time.

- Sources: https://reglab.stanford.edu/publications/hallucination-free-assessing-the-reliability-of-leading-ai-legal-research-tools/ ; https://onlinelibrary.wiley.com/doi/full/10.1111/jels.12413 ; https://arxiv.org/abs/2405.20362 (retrieved 2026-09-26)
- Excerpt: "the AI research tools made by LexisNexis (Lexis+ AI) and Thomson Reuters (Westlaw AI-Assisted Research and Ask Practical Law AI) each hallucinate between 17% and 33% of the time." / "addressing claims by certain legal research providers that methods such as retrieval-augmented generation (RAG) eliminate or avoid hallucinations."

**M-074** [V]+[S] **Models do not verify retrieved facts, and sometimes adopt wrong ones.** ClashEval (Wu et al., NeurIPS 2024 Datasets & Benchmarks) tested more than 1,200 questions across six domains with perturbed context documents.

- Sources: https://github.com/kevinwu23/StanfordClashEval [V]; https://arxiv.org/abs/2404.10198v2 [S] (retrieved 2026-09-26)
- [V] verbatim: "ClashEval is a dataset and benchmark designed to study how large language models (LLMs) arbitrate between their internal knowledge and external evidence when the two sources conflict." / "Our findings highlight the models' tendencies to sometimes prefer incorrect external content over their correct prior knowledge and vice versa."

**M-075** [S] **Position in the context matters.** Liu et al., "Lost in the Middle" (TACL 2024), found performance is highest when relevant information sits at the start or end of the context, and drops significantly when it sits in the middle.

- Sources: https://aclanthology.org/2024.tacl-1.9/ ; https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00638/119630/Lost-in-the-Middle-How-Language-Models-Use-Long (retrieved 2026-09-26)
- Excerpt: "performance is often highest when relevant information occurs at the beginning or end of the input context, and significantly degrades when models must access relevant information in the middle of long contexts, even for explicitly long-context models."

**M-076** [S] **RAG systems fail in operation.** Barnett et al., "Seven Failure Points When Engineering a Retrieval Augmented Generation System" (CAIN 2024), conclude that validation is only feasible during operation, and that robustness evolves rather than being designed in.

- Source: https://dl.acm.org/doi/10.1145/3644815.3644945 (retrieved 2026-09-26)
- Excerpt: "The paper's two key takeaways are: 1) validation of a RAG system is only feasible during operation, and 2) the robustness of a RAG system evolves rather than designed in at the start."

**M-077** **Staleness: no dedicated study was retrieved.** The Hugging Face definition (M-071) says knowledge is updated "by changing the index instead of retraining the whole model". Answers can therefore be no more current than the index. That is a logical consequence of the definition, not a finding from a study. If the deck needs a cited staleness claim, more research is needed.

---

## 7. Suggested TAM/SAM/SOM inputs (bottom-up)

**Rules for this section:**

- Every **count** comes from a numbered fact above.
- Every **price** is an **ASSUMPTION that SUDERRA must confirm** through customer interviews or pilots.
- No currency conversions are made, because no sourced FX rate was retrieved. NOK and USD blocks are kept separate.

### A. Aquaculture operations SaaS: Norway (salmon and trout)

**Block A1: per active site**

- Count: 608 sites (monthly average of active salmon and rainbow trout sites, 2024, M-021). The upper bound is 886 sites active for at least one month.
- Price ASSUMPTION: NOK 5,000 per site per month. **SUDERRA must confirm.**
- Arithmetic:
  - 608 × 5,000 × 12 = **NOK 36,480,000 per year**.
  - Upper bound: 886 × 5,000 × 12 = **NOK 53,160,000 per year**.

**Block A2: per food-fish licence**

- Count: 1,230 food-fish licences (2024, M-020).
- Price ASSUMPTION: NOK 30,000 per licence per year. **SUDERRA must confirm.**
- Arithmetic: 1,230 × 30,000 = **NOK 36,900,000 per year**.

**Block A3: per company**

- Count: 122 companies (2020, M-022; no newer count was found).
- Price ASSUMPTION: NOK 300,000 per company per year. **SUDERRA must confirm.**
- Arithmetic: 122 × 300,000 = **NOK 36,600,000 per year**.

Notes on A1 to A3:

- These blocks are three pricing models over the same Norwegian salmon and trout market. **Do not add them together.** Pick one pricing model.
- The assumed prices were chosen so the three blocks land near each other, about NOK 36–37 million a year. **That agreement comes from the assumptions, not from evidence.**

**Block A4: an illustrative SOM, all assumptions**

- ASSUMPTION: 10 customer companies × 15 sites each × NOK 5,000 × 12 = **NOK 9,000,000 per year**.
- Every input here is an assumption: customer count, sites per customer, and price.

**Context for the pitch, not a revenue input:** 54.9 million salmon died in sea cages in 2025 (M-024), and sea-phase mortality was 14.2% (M-023). **No sourced value per dead fish was retrieved.** Any "NOK lost to mortality" figure would therefore be unsourced. Do not state one until SUDERRA finds a source for the value per fish, such as the average harvest weight and price published by the Directorate or the Seafood Council.

**Global aquaculture:** FAO gives production volume and value (M-027, M-028: 103 Mt and USD 371 billion farm-gate in 2024), but **no count of farms or companies was retrieved**. A global bottom-up block therefore cannot be built from sourced counts yet. A top-down "share of farm-gate value" figure is possible, but it is not bottom-up, and any percentage used would be an assumption.

### B. ARIA: governance for AI coding agents

**Block B1: global ceiling, per professional developer seat**

- Count: 36.5 million professional developers (SlashData, early 2025, M-049).
- Price ASSUMPTION: USD 20 per developer per month. **SUDERRA must confirm.** For reference, CodeRabbit Pro is USD 24 per user per month billed annually (M-060).
- Arithmetic: 36,500,000 × 20 × 12 = **USD 8,760,000,000 per year** (USD 8.76 bn).
- This is a theoretical ceiling. It assumes every professional developer pays for a governance seat, which is not realistic.

**Block B2: developers who use AI daily**

- Count: 36.5 million × 51% = **18,615,000 developers** (M-049 × M-043).
- ESTIMATE: this applies a survey percentage to a population figure from a different source. The Stack Overflow sample is not the SlashData population.
- Price ASSUMPTION: USD 20 per developer per month. **SUDERRA must confirm.**
- Arithmetic: 18,615,000 × 20 × 12 = **USD 4,467,600,000 per year** (about USD 4.47 bn).

**Block B3: an illustrative SOM, all assumptions**

- ASSUMPTION: 40 customer organisations × 50 governed developer seats × USD 20 × 12 = **USD 480,000 per year**.
- Every input is an assumption.

**Top-down cross-checks** (sourced, but not bottom-up):

- AI code tools market: USD 7.37–7.65 bn in 2025, depending on the analyst (M-050).
- Off-the-shelf AI governance software: USD 15.8 bn by 2030 (Forrester, M-051).
- B2 (USD 4.47 bn) is below the 2025 AI code tools estimates. Presenting B2 as SAM would therefore not exceed any analyst's figure for the whole category. The comparison is still loose: seat-based governance spend and code-tool spend are different categories.

**Missing input for a Norway or Nordic SAM:** no sourced count of Norwegian or Nordic software developers was retrieved. SSB is the right source (employment in NACE 62, "computer programming, consultancy"). It could not be fetched here.

---

## 8. Leads found but NOT usable yet (attribution or confirmation missing)

These figures appeared in search-tool summaries without a clear source URL, or conflicted with other sources. **Do not use them** until someone opens a primary source and confirms them.

| Claim                                                                                                      | Why it is not usable                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Norway produces 52% of global salmon, Chile 29%"; "Mowi ≈ 20% global share, 502,000 t GWT"                | Probably from the Mowi _Salmon Farming Industry Handbook 2025_ (https://mowi.com/wp-content/uploads/2025/06/2025-Salmon-Farming-Industry-Handbook.pdf), but not tied to it.                                                                   |
| "AKVA fishtalk market share of 60 percent"                                                                 | Appeared without a source.                                                                                                                                                                                                                    |
| "20M+ developers use GitHub Copilot; 90% of the Fortune 100"                                               | Appeared alongside Octoverse 2025, but was not tied to the Octoverse page.                                                                                                                                                                    |
| "Gartner: 90% of enterprise software engineers will use AI code assistants by 2028 (from <14% early 2024)" | Only a Gartner webinar page was returned as the source. The confirmed Gartner figure is 75% (M-047).                                                                                                                                          |
| "927,540 tonnes MTB allocated at year-end 2024"                                                            | The search result attributed it to Fiskeridirektoratet publications, but not to a specific document.                                                                                                                                          |
| "Enterprise AI coding agents market ≈ USD 9.8–11.0 bn annualised (April 2026)"                             | Appeared without a clear source.                                                                                                                                                                                                              |
| "AI-generated code contains 2.74x more vulnerabilities"                                                    | Appeared next to the Veracode results but is not attributed to Veracode. Do not use it.                                                                                                                                                       |
| Copilot Business USD 19 and Enterprise USD 39 per seat per month                                           | Stated by third-party pricing pages. GitHub's own plans page, fetched directly (github.com/features/copilot/plans), shows Pro USD 10, Pro+ USD 39 and Max USD 100 per month, and says to "Contact sales" for Business and Enterprise pricing. |
