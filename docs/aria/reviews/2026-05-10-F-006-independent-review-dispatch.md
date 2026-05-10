# Independent Review Dispatch — F-006 Closure

**Created:** 2026-05-10
**Plan:** `docs/plans/2026-05-10-aria-self-audit/plan.md` Phase F
**Subject:** F-006 closure commits (8170a7c1, cd08f99e, 6ed058a2) — operator-self-audit-RESOLVED finding
**Status:** AWAITING DISPATCH (operator action)
**Owner (Accountable):** okan-platform-operator
**Owner (Responsible — once dispatched):** independent agent (recommended: `code-reviewer`)

---

## 1. Why this review

F-006 was opened, fixed, and verified by the same Claude session (2026-05-10). IDENTITY.md §3.7 Rule 9 (codified in commit 1def064f) requires self-implemented + self-verified findings to receive independent review before the closure is considered enterprise-grade complete. This document is the dispatch payload for that review.

Operator-self-judgment was used as a working premise during implementation; this review is the audit trail that turns the working premise into a confirmed closure (or surfaces overlooked issues for re-opening).

## 2. Recommended dispatcher

Per Plan v2 OQ8, the recommended agent is `code-reviewer` (broadest scope). Alternative paths:

| Option | Token cost | Scope | Use when |
|---|---|---|---|
| **`code-reviewer`** (recommended) | ~12k | architectural review of all 3 commits + interaction analysis | Default — covers most failure modes |
| `test-runner` | ~6k | test coverage + invariant verification only | If concern is specifically test quality |
| `security-reviewer` | ~10k | security guarantee preservation | If broad-except daraltma is suspected to weaken security |
| 3-Explore-agent reproducer | ~25k (3 × 8k) | full ARIA spec Tier V discipline | If this is also F-005 Tier V satisfaction |

## 3. Dispatch invocation (operator copy-paste)

To dispatch via Claude Code session:

```
Agent({
  description: "F-006 independent closure review",
  subagent_type: "code-reviewer",
  prompt: `[paste the prompt from §4 below]`
})
```

## 4. Review prompt (verbatim, ~3 pages — copy entirely into agent prompt)

```
Bağımsız kapanış denetimi: F-006 (operator-conducted ARIA self-audit, 2026-05-10) closed via three anchor commits + Tier V verification on branch claude/aria-self-audit-F-006 (head of snowball + 4 commits). Sen bu denetimi senin sessionunda yeniden gerçekleştirip, fix'lerin gerçekten doğru olup olmadığını + closure'un eksiksiz olup olmadığını teyit et. Sen bu commit'leri yazan session değilsin; bağımsız bir gözden geçirme yapıyorsun.

Kapsam — incelenecek 3 commit:
  8170a7c1 — fix(aria-kernel): F-006 anchor 1 — pressure._phase2_effective_context narrows broad except to ImportError
  cd08f99e — chore(aria-kernel): F-006 anchor 2 — cycle.pr_lifecycle placeholder gets aria-debt:DEBT-2026-05-10-001 marker + ledger entry
  6ed058a2 — verify(aria-kernel): F-006 closure — Tier V mechanical 1079/1079 green; F-006 OPEN -> RESOLVED

Repo durumu (review zamanı):
  - branch: claude/aria-self-audit-F-006
  - finding: aria-findings/F-006.json status=RESOLVED, closes_in_commit=6ed058a2
  - debt: aria-debts/DEBT-2026-05-10-001.json status=OPEN, due 2026-06-24
  - related: aria-findings/F-007.json status=OPEN (separate scope)
  - test: tests/test_pressure_phase2_import_fallback.py (3 case),
          tests/test_architectural_debt_marker_invariant.py (4 case)
  - plan: docs/plans/2026-05-10-aria-self-audit/plan.md

Senin görevin:

(A) Anchor 1 — pressure._phase2_effective_context broad except → ImportError narrowing

   1. aria-kernel/aria_kernel/pressure.py:481-493 oku
   2. aria-kernel/aria_kernel/trust.py oku, trusted_gap_keys + ref_status_by_feedback_id imzasını çıkar
   3. Sirküler import zincirini (pressure → trust → feedback → pressure) git grep ile teyit et
   4. Aşağıdaki sorulara CEVAP ver (HER BİRİNE):
      a. ImportError dışında trigger eden başka senaryo var mı? (örn. trust modülü yüklü ama yan-import OSError döndürüyor)
      b. patch.dict(sys.modules, {...: None}) ile mock'lanan ImportError gerçek runtime ile aynı semantik mi? (Python doc'a referans)
      c. Trust functions (trusted_gap_keys, ref_status_by_feedback_id) data-error path coverage'ı yeterli mi? Eksik edge case var mı?
      d. _pressure_ref_stale (line 496) downstream'inde "unknown" return olduğunda davranış doğru mu?
      e. Mevcut 7-pass test_pressure_lifecycle.py regresyon kapsayıcı mı?
   5. VERDICT: anchor 1 closure VERIFIED / NEEDS_REWORK / REJECTED + concrete bullet rationale

(B) Anchor 2 — cycle.pr_lifecycle aria-debt marker + DEBT ledger

   1. aria-kernel/aria_kernel/cycle.py:50-61 oku (placeholder note + aria-debt marker)
   2. aria-debts/DEBT-2026-05-10-001.json oku
   3. docs/aria/CONTRACTS.md §6.6 (Architectural Debt Record schema) oku
   4. Aşağıdaki sorulara CEVAP ver:
      a. DEBT JSON CONTRACTS §6.6 required fields'ı tam karşılıyor mu? (originating_finding_id, verification_status=VERIFIED, root_cause_summary, short_term_action_taken.kind, permanent_fix_required, permanent_fix_owner, due_date, severity, current_status)
      b. root_cause_summary banned-phrase gate'i geçiyor mu? ("for now", "interim", "temporary", "good enough", "deferred", "pragmatic" yok mu?)
      c. due_date severity-range içinde mi? (MEDIUM ≤90d; due 2026-06-24 = 45 gün, OK)
      d. permanent_fix_required gerçekten implement edilebilir bir spec mi? Adımlar tek-tek concrete mı?
      e. permanent_fix_owner specific (operator-Okan) mı, yoksa "the team" gibi banned-form mu?
      f. aria-debts/_index.json sıralama + generated_at tutarlı mı?
   5. VERDICT: anchor 2 closure VERIFIED / NEEDS_REWORK / REJECTED + rationale

(C) test_architectural_debt_marker_invariant.py — invariant test correctness

   1. aria-kernel/tests/test_architectural_debt_marker_invariant.py oku
   2. Aşağıdaki sorulara CEVAP ver:
      a. False-positive üretebilir mi?
         - Test fixture içinde "aria-debt:" substring geçen string var mı? (regex _MARKER_RE = aria-debt:DEBT-\d{4}-\d{2}-\d{2}-\d{3})
         - Test docstring veya regression test description'ı marker olarak parse edilir mi?
         - Plan dosyaları (docs/plans/) marker olarak parse ediliyor mu? (_SCAN_ROOTS yalnızca aria-kernel/aria_kernel + tools/aria-poc → docs/ scan dışı, OK)
      b. False-negative üretebilir mi?
         - Glob pattern (.py + .ts + .tsx + .json + .yaml + .yml) yeterli mi?
         - .yml ile .yaml ayrı handle edilmiş mi?
         - Marker'ı multi-line yorumda olduğunda yakalıyor mu?
      c. test_debt_2026_05_10_001_marker_present_at_cycle_placeholder testi gevşek mi sıkı mı? (12-line proximity threshold)
   3. VERDICT: invariant test scope adequate / inadequate + rationale

(D) F-006.json schema + audit trail integrity

   1. aria-findings/F-006.json oku
   2. F-001 ile karşılaştır (schema şablonu)
   3. Aşağıdaki sorulara CEVAP ver:
      a. Tüm zorunlu fields var mı? ($schema, certainty, claim_summary, claim_type, evidence_chain_id, evidences, facts, finding_id, interpretations, originating_skill, recommendation, severity, status)
      b. evidences list yeterli mi? (en az 2-3 distinct sources)
      c. closes_in_commit=6ed058a2 doğru SHA mı? (git log claude/aria-self-audit-F-006 ile teyit)
      d. status=RESOLVED ile evidences uyumlu mu? Closure conditions document edilmiş mi?
      e. _index.json'daki F-006 row F-006.json ile tutarlı mı?
   4. VERDICT: F-006 schema VERIFIED / NEEDS_REWORK + rationale

(E) Genel — closure kompletliği

   1. Plan v2 (docs/plans/2026-05-10-aria-self-audit/plan.md) Phase A acceptance criteria A1-A8 her birini check et
   2. Tier V verification commit (6ed058a2) gerçekten 1079/1079 raporladığını teyit et (commit message + repo state)
   3. CLAUDE.md compliance: 4 commit message'da "for now", "interim", "deferred", "good enough" var mı? Closes line her birinde var mı?

   VERDICT: F-006 enterprise-grade closure: COMPLETE / INCOMPLETE + concrete missing items list

(F) Output format

   Yanıtın bir review report (markdown) olsun. Şu yapı:
     ## Verdict (one line per anchor)
     ## Anchor 1 review (detailed answers to questions a-e)
     ## Anchor 2 review (detailed answers a-f)
     ## Test invariant review (a-c)
     ## F-006 schema review (a-d)
     ## Genel closure review
     ## Recommended action (NONE / REWORK list / REJECT + reason)

   Bu rapor docs/aria/reviews/2026-05-10-F-006-independent-review-result.md olarak kaydedilmeli (operator commit eder).

Süre: ~30-60 dakika real time, ~12k token. Branch off, salt okunur context.
```

## 5. Expected output

After dispatch, the reviewer agent produces `docs/aria/reviews/2026-05-10-F-006-independent-review-result.md` with the structure declared in §4(F). The operator then:

1. Reads the result
2. If verdict = COMPLETE → governance event `operator_sign_off_F006_independent_review` recorded; F-006 closure considered enterprise-grade complete
3. If verdict = INCOMPLETE / REJECT → reopen F-006 (status: OPEN), record reopen reason, plan additional work (likely small ek commit'ler)

## 6. Acceptance criteria for this dispatch

- [ ] Operator dispatched the agent with the prompt above
- [ ] Reviewer agent produced result file at `docs/aria/reviews/2026-05-10-F-006-independent-review-result.md`
- [ ] Result file contains explicit VERDICT per anchor (a-e) + genel
- [ ] Operator recorded sign-off (governance event or commit message reference)
- [ ] If REWORK or REJECT, the rework commits exist on `claude/aria-self-audit-F-006` (or follow-up branch) and were re-reviewed

## 7. Why this is filed even before dispatch

Per IDENTITY.md §3.7 Rule 9 codification (commit 1def064f), the review dispatch surface must be visible in the audit trail BEFORE the F-006 closure ceremony is considered complete. Filing this dispatch document creates that surface. The actual dispatch is operator-only (Claude this session cannot Agent-dispatch with operator authority); but the dispatch payload IS prepared and reviewable.

## 8. Cross-references

- Plan v2 Phase F: `docs/plans/2026-05-10-aria-self-audit/plan.md` Section 5 → Phase F
- IDENTITY.md §3.7 Rule 9 (the rule that mandates this review)
- F-006 closure commits: 8170a7c1, cd08f99e, 6ed058a2
- F-006 finding: `aria-findings/F-006.json`
- DEBT-2026-05-10-001: `aria-debts/DEBT-2026-05-10-001.json`
