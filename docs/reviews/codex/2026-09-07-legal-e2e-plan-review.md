# Hukuk ARIA — dört ajanla uçtan uca plan incelemesi

Tarih: 2026-09-07. İncelenen kod: `c6d287a3f`.
İncelenen tasarım: 2026-09-06 konuşmasındaki dört haftalık uçtan uca MVP planı.

Önceki oturumun tamamlanmış MVP ajan raporu kurtarıldı; yarım kalan hafıza ve runtime
incelemeleri yeni ajanlarla tamamlandı; dördüncü ajan UI/avukat yolculuğunu inceledi.
Toplam dört inceleme alanı, 23 bulgu. Ana ajan bütçe, paket kapsamı, karar projeksiyonu,
yayın sürümü, kaynak listesi, yükleme durumu, kimlik ve dağıtım dayanaklarını kodla
karşılaştırdı. Çalışan serviste hata üretimi veya gerçek model/CI kabulü yapılmadı.

Revizyon: [YOL-HARITASI](../../../new-aria/arias/legal/docs/YOL-HARITASI.md).
Aşağıdaki bulguların tasarım karşılıkları plana işlendi. **Uygulama durumu OPEN**;
planı değiştirmek çalışan ürün kusurunu kapatmaz. Mevcut üretim bulgularının yerine
geçmez ve onları RESOLVED yapmaz. Sahipler teslim sorumluluğudur; isimli atamalar
uygulama başlangıcında yapılır. Son tarihler P0–P7 kabul kapılarıdır; haftalar hedeftir.

| Bulgu      | İnceleme                      | Teslim sahibi                          | En geç kabul kapısı         |
| ---------- | ----------------------------- | -------------------------------------- | --------------------------- |
| HIGH-001   | Gerçek model/bütçe            | Runtime sorumlusu                      | P0                          |
| HIGH-002   | Ölçüm sözleşmesi              | Değerlendirme sorumlusu + pilot avukat | P0 tanım, P7 ölçüm          |
| HIGH-003   | Pilot girdileri               | Pilot avukat + ürün sorumlusu          | P0 kayıt, P7 kabul          |
| HIGH-004   | Sorumluluk iş akışı           | Hukuk alanı sorumlusu                  | P5                          |
| HIGH-005   | Paket kapsamı                 | Çekirdek + hukuk alanı sorumlusu       | P0                          |
| MEDIUM-006 | Erken kullanılabilirlik       | UI sorumlusu + pilot avukat            | P3                          |
| HIGH-007   | Onayın anlamı                 | Hukuk alanı sorumlusu                  | P1 sözleşme, P3 kabul       |
| HIGH-008   | Kararların güncel durumu      | Hafıza sorumlusu                       | P1 sözleşme, P3 kabul       |
| HIGH-009   | Tam dava sürümü               | Yayın servisi sorumlusu                | P1                          |
| HIGH-010   | Olaya bağlı kural uygulaması  | Hukuk alanı sorumlusu                  | P1 sözleşme, P5 kabul       |
| HIGH-011   | Silinebilir içerik sınırı     | Veri yaşam döngüsü sorumlusu           | P1 sözleşme, P6 kabul       |
| HIGH-012   | Kaynak soy bağı               | Belge alımı sorumlusu                  | P1 sözleşme, P4 kabul       |
| HIGH-013   | Claude/runner entegrasyonu    | Runtime sorumlusu                      | P0                          |
| HIGH-014   | Kaynak sınırı/kimlik yenileme | Runtime sorumlusu                      | P0                          |
| HIGH-015   | Kalıcı iş/yayın geçişleri     | Yayın servisi sorumlusu                | P1                          |
| HIGH-016   | Canlı geçiş/geri dönüş        | İşletim sorumlusu                      | P6                          |
| HIGH-017   | Yedek ve güncel iptal/silme   | İşletim sorumlusu                      | P6                          |
| HIGH-018   | Yeni adreste giriş            | UI + kimlik sorumlusu                  | P2, P6 tekrarı              |
| HIGH-019   | Arşiv/kural hazırlığı         | UI + hukuk alanı sorumlusu             | P2                          |
| HIGH-020   | Bütün kaynakları açma         | UI + belge alımı sorumlusu             | P3, P4 tam biçimler         |
| HIGH-021   | Tarayıcıda iş kurtarma        | UI + yayın servisi sorumlusu           | P2                          |
| HIGH-022   | Düzeltme editörü              | UI + hafıza sorumlusu                  | P3                          |
| MEDIUM-023 | Somut dava raporu             | UI + hukuk alanı sorumlusu             | P3 küçük akış, P5 tam rapor |

## 1. MVP ve kabul incelemesi — önceki oturumdan kurtarılan rapor

Read-only review of `c6d287a3f`; no changes or model/target calls.

1. **HIGH-001 — The first real-model feasibility gate comes too late, and the existing budget path already contradicts it.**

   **Plan defect:** Real Claude extraction, evidence judgment and counterevidence start in week 3 while preserving existing budget caps. Their feasibility is a prerequisite for the claimed four-week product.

   **Failure:** Weeks 1–2 produce excellent ingestion infrastructure; the first actual legal analysis is rejected before dispatch, leaving insufficient time to complete memory, calibration and lawyer acceptance. The executor reserves 400,000 input plus 64,000 output tokens before a non-mock call (`tools/aria-poc/ci_executor.py:1439–1477`). At the repository’s Opus rates, that is $3.60 (`aria-kernel/aria_kernel/budget.py:36–39,70`), versus the legal instance’s $0.50/run cap (`arias/legal/config/budget.json:5`). Unresolved aliases can instead take the unknown-pricing refusal path. This is a concrete dependency, not a claim about current vendor prices.

   **Revision:** Add a first-week acceptance gate for a small representative mixed-document bundle: managed-login Claude → legal extraction → evidence judge → counterevidence → accepted signed-archive result. Define enforceable context/output bounds and reserve against those bounds without weakening cost caps. Measure consumption and elapsed time, then forecast first-case processing, evaluation, correction reruns and second-case processing within the daily/monthly budgets. Reserve budget for those acceptance activities.

   **Test:** An authorized normal request succeeds through the real chain under the retained cap; an oversized request stops before spending. Publish measured end-to-end processing estimates for the representative archive. This preserves the user’s provider, host and budget choices.

2. **HIGH-002 — “100 labelled + 20 negative/uncertain; 95% precision, 90% recall” is not yet an executable acceptance specification.**

   **Plan defect:** “Analysis area,” evaluation unit, matching rules, abstention denominator and whether evaluation follows human correction are undefined. Citation resolution is separable from whether the cited text supports the assertion.

   **Failure:** A system passes by counting easy date mentions while missing responsibility chains, combining several incorrect claims into one “mostly correct” answer, or abstaining on difficult answerable questions. Developer-tuned examples can also become the release test. The current corpus contains only four planted positive findings (`arias/legal/corpus/corpus.json:18–50`); its scorer matches date/amount/missing-reference keys and does not evaluate semantic answers (`packs/legal/adapters/records/precision.test.ts:52–75,86–136`). Product documentation explicitly requires expected answers and thresholds registered before evaluation and warns against generalizing a small-corpus score (`arias/legal/docs/YOL-HARITASI.md:40–47`).

   **Revision:** Freeze separate evaluation tracks for chronology, missing information, contradictions, version changes, responsibilities, procedural issues and source-backed answers. Define atomic expected findings with actor/time/scope/source fields and one-to-one matching. Unsupported additional assertions count as false positives; abstention on an answerable item counts as a false negative. Report automated first-pass scores separately from lawyer-corrected outputs. Separate known-negative and insufficient-evidence strata and require ≥95% correct abstention on the latter. Freeze a lawyer-adjudicated holdout excluded from prompts, retrieval, examples and tuning; retain the stricter existing fixture gate.

   **Test:** The scorer rejects intentionally omitted difficult findings, unsupported extra assertions, correct citations attached to incorrect interpretations, and excessive abstention. Report per-track confusion counts and sample sizes, not only pooled percentages.

3. **HIGH-003 — The month depends on substantial lawyer-supplied material, but its ownership and delivery gates are missing.**

   **Plan defect:** User-supplied archives/rules and lawyer-labelled goldsets are treated as available inputs rather than scheduled prerequisites. The anonymized second case appears only in final acceptance.

   **Failure:** In week 4 the team discovers that the second case is not anonymized, the supplied rules lack effective-version information, or no lawyer has labelled the hundreds of required examples. Engineering completion then cannot demonstrate the eight outcomes. The existing roadmap already lists archive size/format inventories, source versions, labelled events, known version families, expected answers and a bureau-checked second case as necessary inputs (`arias/legal/docs/YOL-HARITASI.md:26–29`). It explicitly makes the schedule dependent on their availability (`:18–20`).

   **Revision:** Establish a first-week readiness package owned by the designated pilot lawyer, with operator assistance for packaging: archive manifest and exclusions; rule sources/version/effective-time information; agreed tasks and labels; known disputed/unknown cases; and a confirmed second-case custodian. Confirm the second case’s format/volume profile early while keeping its substantive holdout material inaccessible to development. Schedule lawyer adjudication/review sessions in weeks 1–3, with a pre-week-4 holdout freeze. Missing inputs leave the relevant outcome unaccepted and move its acceptance date; they do not trigger synthetic substitution or reduced coverage.

   **Test:** Before freezing the implementation sequence, every MVP outcome maps to an available input, named responsibility, delivery date and acceptance task. Before final evaluation, both cases and the independent labels exist with recorded hashes and scope. No conflict with the user’s choice to supply everything through the UI.

4. **HIGH-004 — M5 can still disappear between “typed events,” “obligations” and “graph.”**

   **Plan defect:** Those building blocks do not specify the lawyer-visible responsibility reconstruction or its completion criterion.

   **Failure:** The application correctly lists a contractor, a notification deadline and two emails, yet cannot answer who had to notify whom, what triggered that obligation, whether the action occurred, or which missing evidence prevents a conclusion. M5 is nevertheless marked complete because the records and graph exist. The current capability register explicitly distinguishes existing roles/events from the missing **party → role → obligation → action → missing-step** chain (`arias/legal/docs/YETENEK-KAYDI.md:255`). Current case tabs are intake/documents/timeline/parties/statements/coverage (`ui/web/src/features/legal/CaseDetailPage.tsx:47–54`).

   **Revision:** Add one explicit M5 workflow to the plan: open a process question, inspect the responsible actor and recipient, obligation source and version, trigger, relevant time, alleged/performed action, supporting and conflicting evidence, and unresolved gaps. Allow the lawyer to correct the actor/relationship and preserve competing accounts. Represent “no performance evidence located” separately from “proved failure to perform.” This can use the planned graph and obligation records; it does not require another product or autonomous liability judgment.

   **Test:** Use a labelled scenario with a responsibility transferred between document versions, disputed notice receipt and a missing performance record. The lawyer reconstructs and corrects the chain, then gets the corrected result after restart and paraphrased questioning.

5. **HIGH-005 — Adapting trust/invocation alone leaves old product restrictions inside the agents being reused.**

   **Plan defect:** The plan adds OCR and supplied-rule applicability but does not explicitly migrate the authoritative pack/agent scope that currently prohibits them.

   **Failure:** The new invocation succeeds technically while the existing legal agent refuses or systematically suppresses the requested analysis. `packs/legal/pack.json:188–195` retains the old OCR/legal-opinion/procedure exclusions. The evidence-judge prompt reads those restrictions, limits its job to whether bytes state a proposition, and has an explicit legal-conclusion refusal protocol (`packs/legal/agents/aria-legal-evidence-judge.md:23,27–29,54,60`). Updated product documentation says its target definition does not itself activate new runtime scope (`arias/legal/docs/TANIM.md:63–65`).

   **Revision:** Include a reviewed scope-contract migration in the legal-pack work: permit actual OCR with extraction provenance and source-backed candidate rule applicability/obligation analysis; retain explicit abstention, lawyer verification, no invented authority and no automatic filing. Update manifests, prompts, schemas and acceptance tasks together. Specify the boundary between an allowed procedural issue candidate and a prohibited unsupported legal conclusion.

   **Test:** The same real-model path accepts a bounded supplied-rule question and scanned evidence, produces source-backed review candidates, and rejects a request requiring absent authority. This implements the user’s changed scope; retaining the old blanket exclusions would conflict with it.

6. **MEDIUM-006 — Lawyer usability is postponed until the week containing migration, recovery and second-case acceptance.**

   **Plan defect:** “English frontend,” review controls and exports are implementation deliverables; they do not establish that a lawyer can complete the working loop. The first meaningful pilot has no dedicated correction window.

   **Failure:** Technical tests pass, but the lawyer cannot find the relevant source, understand an uncertain result, recover from a rejected correction or produce a useful approved export without developer intervention. The product’s stated M8 acceptance is precisely source opening → review → correction/approval → source-backed output → restart/resume (`arias/legal/docs/YETENEK-KAYDI.md:258`).

   **Revision:** Run a small observed pilot of that complete loop by the end of week 2 using the available vertical slice; keep week 4 for repetition across the full archive and second case. Freeze a task checklist covering the eight outcomes. Require every critical task to complete through the English UI without developer-operated JSON/CLI steps; record completion time, assistance and review burden, with the pilot lawyer owning usefulness acceptance and the operator owning recovery acceptance.

   **Test:** A fresh lawyer session completes the agreed tasks, including one failed upload, one unresolved answer, one correction/undo, an approved export and restart/resume. Repeat after final deployment and restoration. This does not add company/public-sector applications or change the chosen UI language.

## 2. Hafıza ve kaynak doğruluğu

# Memory, provenance and legal applicability review

Read-only review of `/var/aqua-saas/.worktrees/new-aria`; root CLAUDE.md read. No nested CLAUDE.md exists under new-aria. No repository edits, service runs or exploit tests. These are missing executable contracts in the proposed plan, not assertions that already-promised features exist. Six required revisions follow.

## HIGH-007 — An authentic citation is not a verified fact

Evidence: `new-aria/packs/legal/adapters/legal-records.ts:73` puts party/court/counsel and mechanical_extraction/ai_inference in the same AssertionSource enum. `:231` gives a statement one status and one assertedBy. `new-aria/ui/server/src/decisions-overlay.ts:66` changes the entire status to verified and disables humanReviewRequired after a lawyer verification. Thus source identity, extraction method, factual dispute and review completion cannot remain independent in the current projection.

Plan defect: separating source from interpretation and adding hashes does not define what a lawyer has verified. A correct transcription of an opponent's false allegation must not become a verified case fact, and reviewing it must not erase that it is disputed.

Required revision: separate speaker/author, extraction method, proposition stance, evidentiary status and scoped review result. Approval must explicitly identify whether it verifies transcription, attribution, factual proposition, legal applicability or report release. Bind the decision to the exact proposition and evidence revision. Preserve adverse assertions and counterevidence independently of the review badge.

Acceptance: upload an opponent's allegation and contrary contemporary correspondence. Verify that the allegation was transcribed correctly. The timeline, Q&A and report must continue to attribute and dispute it; none may state it as an established fact. Approving only attribution must not approve legal conclusions.

## HIGH-008 — Corrections and withdrawal need a deterministic state machine, not retrieval of signed history

Evidence: `new-aria/ui/shared/legal-contract.ts:628` supports statement verify/withdraw and filed declare/withdraw, but party merges have no withdrawal and no correction/supersession body exists. `new-aria/ui/server/src/decisions-overlay.ts:52` already reduces statement decisions to the latest per target before checking the content fingerprint. `new-aria/ui/server/src/readers/legal.ts:229` instead returns all identity merges as overlays, including potentially contradictory merges.

Plan defect: durable memory plus paraphrased-query acceptance does not specify how conflicting corrections, merges, reversals and changed target identities are resolved. A retrieved subset can omit the withdrawal and resurrect an old signed approval.

Required revision: define typed corrections with stable target identities, explicit supersedes/withdraws decision IDs, expected revision, actor and reason. One deterministic, replayable reducer must govern UI, worker context, search eligibility, Q&A and exports. Resolve all governing decisions before ranking/chunk selection; model retrieval cannot arbitrate current state. Define conflict handling and undo for identity/version-family/rule decisions; do not treat arbitrary reason text as a machine-applied correction.

Acceptance: correct a fact, supersede it, withdraw the superseding decision, and undo a party merge. Rebuild every index and restart. Ask differently worded questions with retrieval limited enough to omit historical entries. Every surface must yield the same explicitly specified current state. Concurrent conflicting edits must conflict or require reconciliation, never silently last-write-win.

## HIGH-009 — CaseRevision needs one immutable read snapshot and atomic compare-and-publish semantics

Evidence: `new-aria/ui/server/src/readers/legal.ts:159` resolves a run before separately reading live decisions at `:167` and building a summary at `:169`. `new-aria/ui/server/src/legal-runs.ts:110` computes sourceVersion from metadata/intake/decision heads; it has no rule/applicability/extraction manifest components. Existing source checks are useful but do not provide the proposed complete revision contract.

Plan defect: naming CaseRevision and returning 409 for stale approval leaves ambiguous how a multi-page UI/Q&A/report stays consistent while rules, decisions or extraction change. A new rule could be served with an old analysis, or an old cursor with new decisions.

Required revision: specify a signed manifest linking source occurrences, extraction versions, analysis, rule corpus/applicability decisions, governing decision head and schema/producer versions. Every read, search cursor, worker context and export pins that manifest. Publication must compare expected head and authorization and atomically advance it. Define whether an old pinned snapshot is still viewable as historical, and when removal prevents access. Model result publication must not silently refresh its dependencies to current values.

Acceptance: while paging and generating a report, change a rule and withdraw a fact approval. Existing pinned reads remain internally consistent and explicitly historical, while current outputs use the new revision; stale approval/publication returns 409. Include a new extraction of unchanged source bytes and ensure its locator/version invalidates old approvals where required.

## HIGH-010 — Rule applicability is issue-and-time specific, not a case-wide selected subset

Evidence: `new-aria/packs/legal/adapters/legal-records.ts:87` defines evidence as document/hash plus optional version/locator; `:231` has statement sources but no rule application relation. `new-aria/ui/shared/legal-contract.ts:628` has no applicability decision. These are new domain contracts, not an extension of a document picker.

Plan defect: storing jurisdiction, effective period and lawyer-selected applicability is insufficient when one case includes several events, contract regimes or amendments. Restricting retrieval to applicable rules can also hide a contested or newly uploaded rule before anyone has assessed it.

Required revision: bind a rule application to issue/claim, relevant event date, jurisdiction, authority type, provision/version, supporting facts, lawyer decision and assumptions. Represent proposed, accepted, disputed, rejected and unresolved applicability separately. Let issue-appropriate retrieval present candidate/contrary uploaded rules as such; only accepted applications support definitive calculations. Define conflict/transition handling and dependency invalidation when a rule or applicability choice changes. Missing temporal or calendar facts block a definitive deadline, with the missing input shown. No product web lookup.

Acceptance: upload two versions of a rule with a transition provision and events on both sides of the change. Results must cite the correct selected version per issue; unresolved transition facts must remain unresolved. Introduce an adverse candidate rule and ensure it is surfaced without being silently declared applicable. Change a relevant event date and require fresh applicability review and recomputation.

## HIGH-011 — Deletion conflicts with substantive immutable ledgers and currently blocks all future runs

Evidence: `new-aria/ui/shared/legal-contract.ts:556` retains relativePath/fileName and `:562` sourceNote in signed intake rows. Decision bodies include displayName/relativePath at `:631`; every decision has free-text reason at `:647`. `new-aria/ui/server/src/decisions.ts:60` hashes the reason into the chain. `new-aria/ui/server/src/legal-runs.ts:334` and `:388` reject analysis if any document_removal exists, without a completion state.

Plan defect: promising content-free minimum audit retention at week four cannot be implemented by simply deleting blobs. Filenames, source notes, reasons and prior model outputs can contain the substance being removed. Keeping a permanent removal row also currently makes the case permanently unanalyzable.

Required revision: choose the deletable-content/immutable-audit boundary before adding correction and Q&A persistence. Keep substantive text in separately erasable payloads; immutable rows retain only explicitly approved minimal identifiers/commitments. Add a durable removal operation state and completion proof, enforce immediate retrieval exclusion, cancel/drain in-flight work, purge derivatives and resumable Claude context, then allow a new source-consistent run. Specify treatment of legacy substantive ledgers without silently rewriting signatures and restoration replay of deletion records.

Acceptance: remove a source containing a unique synthetic phrase present in its filename, note, lawyer reason, extraction, answer and report while a job is active. After completion and restart/index rebuild/backup restore, the phrase cannot be read or retrieved from system-managed stores or runner context; its old citation opens a content-free removed-source record. A new run on remaining documents succeeds, and old work cannot republish removed content.

## HIGH-012 — Source hashes need occurrence and derivation identity to avoid false corroboration

Evidence: `new-aria/ui/shared/legal-contract.ts:553` identifies intake by case/path/hash and arrival metadata. `new-aria/packs/legal/adapters/legal-records.ts:87` evidence references carry document/hash/optional locator, but no explicit parent occurrence or derivation relation. Mechanical extraction and document provenance alone do not establish independent corroboration.

Plan defect: preserving repeat deliveries, attachments and separate records is promised, but the plan does not say how citations resolve through a chain of original message, archive member, attachment, OCR and extraction, or how duplicates affect evidence strength. Ten copies of one allegation can look like ten supporting sources.

Required revision: define immutable content identity separately from delivery/occurrence identity and parent-child extraction lineage. Keep original archive member name and occurrence receipt, extractor/version, exact text-span or page-coordinate mapping and normalization used for quote verification. Represent unknown authorship or delivery times as unknown. Evidence aggregation must recognize shared origins and never count duplicate submissions as independent corroboration.

Acceptance: deliver the same attachment directly, through two emails and inside a ZIP; then deliver different bytes with the same filename. All occurrences remain accessible and cite the correct parent/source location, while identical-origin evidence is counted once for corroboration. An OCR quote must open the correct original page and visibly retain any transcription uncertainty.

## 3. Çalıştırma, yayın ve işletim

# Runtime / publication / deployment review

Read-only review of the supplied plan against `/var/aqua-saas/.worktrees/new-aria`. Root CLAUDE.md read; no nested CLAUDE.md found under new-aria, tools or aria-kernel. No live runtime verification, network/service changes, or repository edits. Findings describe missing plan contracts, not reproduced defects.

1. **HIGH-013 — OCI isolation is not yet integrated with the actual Claude spawn path.** Evidence: `new-aria/tools/aria-poc/claude_runtime.py:1159` still applies the inner write-containment wrapper, and `:1182` still applies the inner limiter. `:654` delegates to bwrap. Merely moving the console's launch into rootless Podman does not remove this nested dependency. Required revision: define a first-class confinement backend contract in the existing runtime, select OCI only from trusted runner configuration, and retain fail-closed behavior; do not use an unconfined acknowledgement as the integration. Move the real Claude feasibility gate to the first milestone, before queue/UI commitments. Acceptance: the production image on the actual host completes one actual Claude task through the kernel, writes only the assigned result area, and returns a validated result to the publisher. Missing confinement/auth is an explicit unavailable state.

2. **HIGH-014 — The effective resource and credential contracts are missing.** Evidence: `new-aria/aria-kernel/aria_kernel/implementation_safety.py:907` selects 2 cores/2 GiB/50 tasks when systemd works, but `:916` accepts a wall-clock-only timeout otherwise; the plan promises 1 CPU/2 GiB/128 processes. `new-aria/tools/aria-poc/claude_runtime.py:1165` binds the managed Claude config read-only, and `new-aria/Dockerfile:77` explicitly requires a mounted login session. Required revision: specify one effective resource authority, total host/disk headroom, the actual Claude login provisioning/refresh lifecycle, and how provider authentication works within restricted egress. Acceptance: report measured cgroup limits and runtime identity for the real task; verify expiry, refresh, provider throttling, timeout and restart handling without mock or alternate-provider fallback. Store explicit wait/retry outcomes and reserved/charged usage so a retry cannot silently exceed the budget.

3. **HIGH-015 — “Reconcile by transaction ID” does not define exactly-once visible publication.** Evidence: intake already commits a signed row and head before publishing bytes at `new-aria/ui/server/src/legal-intake.ts:503`–`:512`, with independent recovery at `:517`; the proposed SQLite queue introduces another durability domain. Required revision: spell out intake-to-enqueue and result-to-publication state transitions, durable source of truth at each crash boundary, stable operation/result IDs, unique visible publication constraint, lease fencing and recovery ownership. Bind every attempt to its source/rule/decision revision and authorization epoch. Define cancellation/revocation versus publication ordering and require stale attempts to be rejected after a replacement worker starts. Acceptance: deterministic interruption tests around each durable transition prove one accepted upload queues once, one result becomes visible once, published jobs recover to completed, and a late worker cannot publish after cancellation, deletion or replacement. Model invocation itself may be retried and billed; do not call that exactly-once execution.

4. **HIGH-016 — Clean cutover needs a data/identity freeze and rollback contract.** Evidence: the base UI publishes `0.0.0.0:8480` by default at `new-aria/docker-compose.yml:59`, its seed service forces mock at `:71`, and the separate legal profile defaults to port 8481 at `new-aria/arias/legal/docker/compose.profile.yml:63`. Legal mock is also the default at `:61`. Principals bootstrap from an operator token on a fresh store at `new-aria/ui/server/src/principals.ts:192`, while missing initialized stores deliberately fail closed at `:191`. Required revision: inventory actual listeners/volumes/image/config first; name which store is authoritative; freeze old writes before final identity migration; preserve principal IDs, revocations and initialization markers while explicitly mapping case grants to the new empty store. Define old GET redirect versus old mutation rejection, session reauthentication, proxy/domain validation, rollback trigger and rollback behavior after new writes. Acceptance: a clean environment starts with no cases/results; old mutation endpoints cannot accept writes after cutover; revoked identities remain denied; rollback preserves new accepted data and does not restart the seeded store as authority.

5. **HIGH-017 — A daily backup cannot guarantee replay of current deletion/revocation state without another durable source.** Evidence: cases and service identity/key material live in distinct volumes (`new-aria/arias/legal/docker/compose.profile.yml:65` and `:69`); the signing key is at `:36`, principals at `:45`, and signed head publication is independently fsynced at `new-aria/ui/server/src/legal-intake.ts:505`. Required revision: define a consistent backup generation covering source bytes, receipts/heads, decisions, principals/markers, signing-key versions, job DB including WAL handling, and publication manifests. Specify an independently durable revocation/deletion journal with a recovery watermark; block serving restored content if its freshness cannot be established. Distinguish reconstruction of disposable indexes from preservation of authoritative records. Explicitly address deleted bytes retained in backup generations and their retention/key lifecycle. Acceptance: isolated restore from an older backup plus newer deletion/revocation journal verifies signatures and sources, keeps revoked users and deleted content inaccessible, recovers jobs without duplicate publications, rebuilds indexes, and measures RPO/RTO. RPO 24h remains a possible loss window for ordinary new uploads; it is not a guarantee of zero accepted-file loss after host failure.

## 4. Arayüz ve avukat yolculuğu

# Fourth independent UI/journey review

Read-only inspection of `/var/aqua-saas/.worktrees/new-aria`; root CLAUDE.md read, no nested CLAUDE.md found under new-aria. No services, network, repository edits or tests. The plan already identifies most missing features; the six defects below concern specifications that remain insufficient to make its promised journey acceptably testable. Paths are relative to this worktree.

1. **HIGH-018 — Domain redirect does not define the old-token sign-in transition.** Evidence: `new-aria/ui/web/src/api/token-store.ts:15` reads origin-scoped sessionStorage; `new-aria/ui/web/src/app/LoginPage.tsx:61` tells users to check ARIA_UI_TOKEN, and `:83` calls the surface Operator console; `new-aria/ui/server/src/auth.ts:58` still supports a shared token mapped to a token-holder principal. A redirect cannot transfer sessionStorage to legal.suderra.com, and migrating “authorized users” does not specify whether an existing shared credential becomes a named person. **Revision:** explicitly define fresh sign-in on the new origin, migration of named principal IDs and case assignments, and replacement/retirement of shared operator credentials through an approved provisioning route; provide English lawyer sign-in/error/recovery text and land in Cases. **Acceptance:** from an authenticated old :8480 tab, follow the redirect and sign in on the new domain as the same named lawyer; see only assigned cases; old revoked credentials remain rejected; no credential is carried in URL; no CLI/env-variable instructions appear in the lawyer flow.

2. **HIGH-019 — Archive completion and legal-rule applicability need separate visible readiness states.** Evidence: `new-aria/ui/web/src/features/legal/IntakeTab.tsx:141` sends every upload through one generic document API; `new-aria/ui/web/src/api/legal-client.ts:153` exposes no source-role field; case tabs are only intake/documents/timeline/parties/statements/coverage (`CaseDetailPage.tsx:47`). Product boundary explicitly requires user-supplied rules with scope/version/time (`new-aria/arias/legal/docs/TANIM.md:46`). W1 automatically queues analysis when an upload group finishes, but applicability selection arrives W3 and its UI W4: it is unspecified what an archive-only completion means. **Revision:** define UI flows and stored roles for Case documents and Legal rules, independent group completion, applicability confirmation, and distinct “Documents ready / Rules needed / Ready for legal analysis” states. Rules must be addable/replaced after initial setup; no model-generated or seeded rule fills a missing input. **Acceptance:** in a clean installation upload archive only: factual organization may run, legal conclusions remain explicitly unavailable; upload a rule through UI and select applicability: grounded legal analysis becomes available; replacing it marks dependent answers for review.

3. **HIGH-020 — PDF.js alone does not close the mixed-format source-review contract, and hidden references need explicit expansion.** Evidence: `new-aria/ui/web/src/features/legal/legal-badges.tsx:151` truncates references to a maximum and renders remaining count as an inert list item at `:165`; StatementsTab uses `max={2}` at `:82` and `:94`. `DocumentsTab.tsx:215` only renders an excerpt. The plan says every citation opens but only specifies a PDF implementation despite DOCX/XLSX/PPTX/EML/CSV scope. **Revision:** require one navigable citation component with expandable full supporting/contradicting lists and define format-specific locators/viewing: worksheet/cell, slide, mail body/attachment, DOCX paragraph/table/change, text line; original bytes remain accessible, renderings have explicit provenance. **Acceptance:** open the fifth contradicting citation and verify its exact source location for each promised format, including tracked DOCX deletions, non-first spreadsheet sheet, and email attachment; return to the same question/review context without losing work.

4. **HIGH-021 — Service durability does not imply browser recovery or usable large-upload progress.** Evidence: `new-aria/ui/web/src/features/legal/IntakeTab.tsx:127` stores upload reports solely in component state; `:130` initializes tracked work to idle; `:139` uploads files serially and `:157` publishes the results only after the whole loop; polling at `:181` depends on that volatile state. The plan proves a service restart but does not explicitly require discovering accepted work after page refresh/tab navigation, interrupted transfer recovery, or per-file feedback. **Revision:** make persisted upload group/job state the UI source of truth, reattach on opening the case, show per-file progress/failure and resume/retry controls, and distinguish accepted bytes from unfinished transfers. **Acceptance:** during the 3,000-file upload navigate away, refresh, lose connection and restart the service; reopening the case shows accurate accepted/pending/failed counts and active work; retry completes remaining files without duplicate submissions or restarting completed analysis.

5. **HIGH-022 — Correction acceptance is scheduled before its required UI and existing decision types cannot represent corrected content.** Evidence: `new-aria/ui/shared/legal-contract.ts:628` supports statement verify/withdraw and other declarations, but no factual correction body; `StatementsTab.tsx:126` shows a review marker and `:137` displays reviewer metadata, without a correction action. W3 exit requires corrections surviving restart/rephrasing, but correction/on-source review controls are scheduled W4. **Revision:** move the minimum source-backed factual correction editor and reason/history UI into W3 alongside a versioned correction contract, including withdrawal/supersession semantics. Specify that factual corrections, interpretation disagreements, and OCR transcription fixes are distinct; regeneration must preserve the intended decision without silently changing original evidence. **Acceptance:** lawyer corrects a wrongly assigned event date through UI, reloads/restarts, asks a materially rephrased and negated question, and exports a report: all use the correction with its provenance; withdrawal restores the appropriate unresolved state and invalidates dependent outputs.

6. **MEDIUM-023 — “Readable report” leaves the last user-visible deliverable undefined.** Evidence: current Reports is a kernel-only route (`new-aria/ui/web/src/app/router.tsx:66`, `:79`), while `new-aria/ui/web/src/features/core/ReportReaderPage.tsx:30` loads a daily report by date and `:60` offers Copy markdown source. The plan promises reports but neither specifies a case-scoped output format nor prevents the existing daily kernel report from being used to claim completion. **Revision:** name an English case-scoped working-report page and concrete downloadable format (e.g. PDF), showing case/source revision, author/review status, unresolved issues and supporting/counter evidence; define citation behavior inside the exported file and how stale approval is shown after source/correction changes. **Acceptance:** a lawyer-only account creates, previews and downloads a report entirely in UI; it has no YAML/JSON/host paths or kernel report content, preserves source-language quotations, identifies every citation with filename/location, and requires a new approval after a material change to its source revision.
