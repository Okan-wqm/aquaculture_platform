<!-- ARIA-HISTORICAL: evidence of the 2026-06-13 forensic audit. The plan it records was completed
— ARIA is fully integrated on main and the snowball branch is archived. Referenced by CONTRACTS
§12.5 and ADR-036. Restored 2026-08-20 (ORPHAN-MEDIUM-771): the directory was absent while two
normative documents still cited it. -->

# ARIA → `main` Controlled Merge Plan

**Status:** PLAN ONLY — no merge, cherry-pick, or branch mutation has been executed.
**Date:** 2026-06-13
**Author:** Okan Ozturk (operator) · forensic pass by an 8-agent read-only workflow
(`aria-to-main-merge-forensics`, run `wf_7b441062-087`)
**Scope:** ARIA meta-system only (`aria-kernel/`, `aria-tools/`, `.aria-ci/`, `docs/aria/`,
`tools/aria-poc/`, `tools/gates/`, `.claude/**`, ARIA CI workflows). Platform code (`apps/`,
`web/`, `libs/`, `platform/`, `sens-api-gateway/`) is explicitly out of scope.
**Evidence base:** 178 commit/branch units classified across 15 ARIA-related branches, 607K
analysis tokens, every load-bearing claim re-verified firsthand against repository blobs.

---

## Yönetici Özeti (TR)

ARIA dallarını `main` ile commit-commit kıyasladık. **Beklenmedik ama kesin sonuç: ARIA zaten
`main`'e tümüyle entegre olmuş durumda ve `main` ARIA'da daha ileride.**

- `.claude/agents` (90 dosya), `aria-tools` (12 dosya) ve `aria-findings` (20 dosya) `main` ile
  `snowball` arasında **bayt-bayt aynı** — çoktan birleşmiş.
- Tek gerçek ayrışma `aria-kernel/`'de (198 dosya), ve orada `main` **kesin üst-küme**: `main`'in
  yalnız ona ait 17 `plan-026R` modülü var, `snowball`'a özel **sıfır** modül; paylaşılan 85 motor
  dosyasında `main` net **+7.505 satır** önde.
- `snowball` platform kodunda `main`'in **gerisinde** — dal-bazlı bir merge `main`'in 77 platform
  düzeltmesini **geri alır**. Bu yüzden tek güvenli yöntem **ARIA-katkılı cherry-pick**.
- 178 birimin **176'sı için işlem yok** (zaten main'de / geçersiz kalmış / kapsam-dışı / geçici
  durum). Yalnızca **2 küçük belge commit'i** `main`'e taşınmaya değer. Bir de taşınırsa `main`'i
  bozacak **tuzaklar** var (aşağıda "DO-NOT-MERGE").

Kısacası: yapılacak iş bir "büyük merge" değil, **2 belge cherry-pick'i + dal arşivleme + kayıt
güncellemesi**. Asıl kazanım, gereksiz ve tehlikeli bir merge'den korunmak.

---

## 1. Executive Summary (EN)

We compared every ARIA branch against `main`, commit by commit, to design a controlled merge. The
forensics overturned the premise:

> **ARIA is already fully integrated on `main`, and `main` is the _forward_ authority.** `snowball`
> and the `aria/*` branches are the _older_ evolutionary line that `main` re-imported (squash commit
> `ffdef128a`, 2026-05-30, 24,627 insertions) and then advanced beyond on its `plan-026R`
> enterprise-hardening line.

Consequently this is **not a merge** — it is a **reconciliation audit** whose correct output is
_"do almost nothing, and above all do not regress `main`."_

| Outcome                             | Units | Action                                                                   |
| ----------------------------------- | ----: | ------------------------------------------------------------------------ |
| `ALREADY_ON_MAIN`                   |   109 | None — content already present (often byte-identical).                   |
| `SUPERSEDED_ARCHIVE`                |    59 | None — `main` carries a newer generation; archive branch as a tag.       |
| `EXCLUDE_PLATFORM_OUT_OF_SCOPE`     |     5 | None — not ARIA; `main` already ahead.                                   |
| `EXCLUDE_EPHEMERAL_STATE`           |     2 | None — runtime `.jsonl`/discovery state; must never be reintroduced.     |
| `NEEDS_MANUAL_RECONCILE`            |     1 | Resolves to **"main wins"** — a regressive snowball branch-pin (see §6). |
| **`CHERRY_PICK_WITH_CARE`**         | **1** | **Tranche 1** — one 30-line orphan-finding note.                         |
| **`SPLIT_TAKE_ARIA_DROP_PLATFORM`** | **1** | **Tranche 2** — four net-new ARIA doc/contract files (docs only).        |

**Net: 176 of 178 units require no action; 2 are documentation-only cherry-picks.** The single
highest-value deliverable of this plan is the **DO-NOT-MERGE register (§6)** — it prevents a
well-intentioned merge from reverting `main`'s kernel hardening and 77 platform fixes.

---

## 2. The Reframe — Why This Is a Reconciliation Audit, Not a Merge

Three independently-verified facts collapse the original "merge the ARIA branches in" framing:

1. **`main` already absorbed ARIA.** `git diff --name-only main snowball` reports **0 files** for
   `.claude/agents` (90 files each, byte-identical), **0 files** for `aria-tools` (12 each), and **0
   files** for `aria-findings` (20 each). `main`'s recent history is literally `feat(aria): integrate
snowball autonomy implementation` → `feat(aria): harden enterprise autonomy lifecycle` →
   `chore(train): stabilize enterprise SSOT closure`.

2. **`main` is _ahead_ in the only divergent area.** The sole forward-divergence is `aria-kernel/`
   (198 files). It decomposes as **17 `main`-only modules** (`burn_in`, `enterprise_readiness`,
   `evidence_trust`, `genesis_lifecycle`, `merge_authority`, `workflow_contracts`, `ledger_refs`,
   `docs_ssot`, …), **0 `snowball`-only modules**, and **181 modified-on-both files with 0 net-new
   `snowball` symbols**. Across the 85 shared engine files `main` is net **+7,505 lines**. (Verified:
   `merge_authority` et al. show `main=1 / snowball=0` via `git ls-tree`.)

3. **`snowball` is _behind_ on platform code.** `snowball` never received `main`'s 77 platform
   commits (farm-service, auth-service, gateway-api, `libs/backend-common`). A branch-level merge of
   `snowball` into `main` would therefore **revert** those fixes — `git diff main snowball` (894
   files) is a _symmetric_ diff dominated by `snowball` _lacking_ `main`'s work, not adding value.

**Therefore the only admissible mechanism is ARIA-additive cherry-pick** of genuinely net-new,
forward content — never a branch merge, never the platform or kernel deltas.

> Note on `git cherry`: it reports ~155 snowball commits as "unmerged" (`+`). This is a **false
> positive** caused by `main` re-authoring ARIA via a squash integration (different patch-ids), not by
> missing content. The authoritative signal used throughout this audit is **path-level content
> equality** (`git diff main <ref> -- <path>` / `git cat-file`), not patch-id.

---

## 3. Method

An 8-agent, read-only forensic workflow classified every ARIA commit and branch. Each unit
received a **gain (kazanım)**, **deficiency (eksik)**, **disposition**, **conflict-risk**, and
**file:line evidence**. Buckets were disjoint and deterministic:

| Agent | Bucket                                            | Units | Verdict                                           |
| ----- | ------------------------------------------------- | ----: | ------------------------------------------------- |
| A1    | snowball kernel-engine commits (`aria_kernel/**`) |    61 | 100% already-on-main / superseded                 |
| A2    | snowball ARIA tests + CI/gates + `.claude` + docs |    26 | 100% already-on-main                              |
| A3    | snowball mixed commits, first half                |    28 | already-on-main + 2 excludes                      |
| A4    | snowball mixed commits, second half               |    28 | already-on-main / superseded                      |
| A5    | snowball platform-only + ephemeral-state audit    |    14 | already-on-main / exclude                         |
| A6    | foundation "proof" branches (×4)                  |     4 | superseded → archive                              |
| A7    | foundation-B branches + thin-delta tips           |    10 | **1 cherry-pick + 1 split**; rest already-on-main |
| A8    | `aria-kernel` 198-file reconciliation surface     |     7 | main authoritative; **1 regression trap**         |

Cross-agent consensus was unanimous and convergent: the same three `main` integration commits
(`ffdef128a`, `0b148a96a`, `42695736f`) explain every "already-on-main" call, independently
rediscovered by six agents.

---

## 4. Ground-Truth Topology

| Fact                                  | Value                                                   |
| ------------------------------------- | ------------------------------------------------------- |
| merge-base(`main`, `snowball`)        | `71a449202b…` (2026-05-30, PR#358)                      |
| `main` ahead of merge-base            | 77 commits (platform + ARIA integration)                |
| `snowball` ahead of merge-base        | 156 commits (1 merge + 155 non-merge)                   |
| snowball commit class split           | 83 ARIA-only · 57 mixed · 15 platform-only              |
| `main` ARIA-integration squash        | `ffdef128a` (2026-05-30, 24,627 insertions)             |
| `main` hardening line                 | `0b148a96a` (05-31) → `42695736f` (06-08) — `plan-026R` |
| `snowball` kernel froze at            | import `33a64da5f` (2026-05-30), never advanced         |
| local `snowball` vs `origin/snowball` | local +191 (local is authoritative; origin stale)       |

---

## 5. The Merge Plan — What Actually Lands

> All commands below are **the recommended procedure only**. Per the operator's instruction
> (_"sadece plan yap"_) nothing here has been executed. Run them only after the §10 decisions are
> made. Standard rule: branch off `main`, open a PR, never force-push.

### Tranche 1 — `ORPHAN-MEDIUM-083` orphan-finding note · `CHERRY_PICK_WITH_CARE`

- **Source:** `9f291ba46` (branch `v31-f2-adapter-dry-run-gate`, 2026-05-19).
- **Content:** `docs/reviews/orphan-findings.md` only, **+30 lines**, a single tracked finding:
  _"V3.1-F mock-mode smoke stalls after cycle 1"_ (status OPEN, mock-mode-only).
- **Gain:** preserves a real, still-open defect note on `main`. **Verified absent from both `main`
  and `snowball`** — the _only_ genuinely unique mergeable artifact in the entire audit.
- **Deficiency:** documentation only (documents an unfixed bug); low absolute value.
- **Numbering (APPLIED 2026-06-14):** at apply-time `origin/main`'s registry had advanced to
  `ORPHAN-MEDIUM-103` (parallel-session findings overnight), so the note was renumbered off
  `origin/main` max → **`ORPHAN-MEDIUM-104`** (per the "renumber off `origin/main` max" merge-train
  convention). The raw SHA `9f291ba46` was NOT cherry-picked; the +30-line note was re-applied by
  hand on top of main's current registry with a port-provenance trailer.
- **Procedure (recommended):**

  ```bash
  git switch -c chore/aria-orphan-medium-083-port main
  git show 9f291ba46 -- docs/reviews/orphan-findings.md   # review the +30 hunk
  # apply the note manually under main's current ORPHAN-MEDIUM sequence (→ 064),
  # do NOT cherry-pick the raw SHA (it carries snowball's 083 index + may context-conflict)
  ```

- **Conflict risk:** MEDIUM (numbering only).

### Tranche 2 — ARIA runtime-v2 promotion docs (ADR + contracts) · `SPLIT_TAKE_ARIA_DROP_PLATFORM`

- **Source:** `f8528d7de` _"docs: define aria runtime v2 promotion gates"_ (branch
  `fix/aria-runtime-stabilization-2026-05-29`, 2026-05-29).
- **Bring (net-new on `main`, verified ABSENT):**
- `docs/adr/034-aria-runtime-v2-promotion.md` (+53) → **MUST be renumbered to ADR-035** (see hazard
  below)
  - `docs/aria/runtime-artifact-contract.md` (+15)
  - `docs/aria/runbooks/runtime-retention.md` (+5)
  - `docs/runbooks/aria-codex-runtime-observability.md` (+16)
- **Hand-merge (file already on `main`, diverges):** `docs/aria/CONTRACTS.md` — apply only the
  +16-line promotion-gates section by hand; do not overwrite `main`'s copy.
- **ADR-034 collision hazard:** `main` already owns
  `docs/adr/034-edge-schema-sensor-per-tenant-ownership.md`. Importing
  `034-aria-runtime-v2-promotion.md` verbatim creates a duplicate ADR number (the exact drift
  CLAUDE.md's "Known drift" note warns about). **Renumber to
  `docs/adr/035-aria-runtime-v2-promotion.md`** and fix internal cross-references before commit.
- **EXCLUDE (the rest of this branch):** all code commits `4ef1fa978` / `fc16f93a3` / `73e348d78`
  and the `.py` hunks of `5cc6f7a4c`. They target a **pre-`plan-026R` kernel** — `git diff --stat
main <branch> -- autonomy_orchestrator.py` shows `main` **+1,364 lines ahead**; applying them
  reverts `main`'s expanded orchestrator and `runtime_artifacts.py`.

- **Procedure (recommended):**

  ```bash
  git switch -c chore/aria-runtime-v2-docs main
  git checkout fix/aria-runtime-stabilization-2026-05-29 -- \
    docs/aria/runtime-artifact-contract.md \
    docs/aria/runbooks/runtime-retention.md \
    docs/runbooks/aria-codex-runtime-observability.md
  git show f8528d7de:docs/adr/034-aria-runtime-v2-promotion.md \
    > docs/adr/035-aria-runtime-v2-promotion.md          # renumber 034 → 035
  # hand-apply the +16 CONTRACTS.md promotion-gate section
  # fix ADR cross-refs (034 → 035) inside the new files
  ```

- **Conflict risk:** LOW for the four doc files; MEDIUM for the `CONTRACTS.md` hand-merge + ADR
  renumber.

### Tranche 3 — Archive the superseded branches (no merge)

The foundation branches hold zero unique forward value but are valuable **history**. Per the
operator's standing rule (parked branches are never deleted), pin them as **immutable annotated
tags** before any future pruning:

```bash
# recommended naming: archive/aria-<branch>-<date>
git tag -a archive/aria-context-proof-20260605 aria/context-proof-20260605 -m "ARIA foundation
snapshot, superseded by main plan-026R"
git tag -a archive/aria-ledger-manifest-foundation-20260605
aria/ledger-manifest-foundation-20260605 -m "…"
git tag -a archive/aria-workflow-proof-20260605 aria/workflow-proof-20260605 -m "…"
git tag -a archive/aria-readiness-merge-eval-proof-20260605
aria/readiness-merge-eval-proof-20260605 -m "…"
git tag -a archive/aria-enterprise-ssot-clean-20260605 aria/enterprise-ssot-clean-20260605 -m "…"
git tag -a archive/aria-enterprise-ssot-hardening aria/enterprise-ssot-hardening -m "…"
git tag -a archive/aria-runtime-stabilization-20260529 fix/aria-runtime-stabilization-2026-05-29
-m "docs ported in Tranche 2; code superseded"
git tag -a archive/aria-control-plane-proof-20260606 origin/feat/aria-control-plane-proof-20260606
-m "…"
git tag -a archive/snowball-autonomy-v10.5 snowball -m "ARIA V3.1→V10.5 line; re-imported into
main via ffdef128a"
```

The `aria/f-024..f-027` tips and `v31-f2-adapter-dry-run-gate` need no separate tag — their fixes
are on `main` and (for `v31-f2`) their unique note is captured in Tranche 1; they are covered by
the `snowball` archival tag's lineage.

---

## 6. DO-NOT-MERGE Register (Regression Traps)

These are the highest-value findings of the audit: content that _looks_ mergeable but would
**break `main`** if ported. Each is verified.

| Trap                                                  | Where                                                                                                                                             | Why it must NOT land on `main`                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`auto_merge.py` base-branch pin**                   | `snowball:aria-kernel/aria_kernel/auto_merge.py:17,120` — `"base_branch": "snowball"` + `raise GovernanceError("…only the snowball base branch")` | Re-pins auto-merge to the `snowball` branch and rejects every other base. `main`'s version is generalized + `merge_authority`-armed and has **no `snowball` literal**. Porting it breaks `main`'s auto-merge against `main`.                             |
| **`cross_review_bridge.py --base snowball`**          | snowball kernel dev literal                                                                                                                       | `main` is production-correct with `--base main`; cherry-picking reintroduces the wrong base.                                                                                                                                                             |
| **17 `plan-026R` kernel modules**                     | `main`-only (`merge_authority`, `enterprise_readiness`, `genesis_lifecycle`, …)                                                                   | Any snowball-kernel branch merge **deletes** these.                                                                                                                                                                                                      |
| **`genesis_policy_default.json`**                     | snowball copy                                                                                                                                     | Lacks the `plan-026R` genesis gate (`shadow_min_days=14 / min_precision=0.95 / 0 critical-FP`). Taking it reverts the enterprise gate.                                                                                                                   |
| **`orphan-findings.md` / `_registry/findings.jsonl`** | snowball copies                                                                                                                                   | `main` is a **strict superset** (3,780 > 3,686 lines; 325 > 261 registry rows; 9 `main`-only ORPHAN ids, 0 the other way). Applying reverts `main`'s registry. _(Tranche 1 adds one new note **on top of** `main`'s registry — it does not replace it.)_ |
| **`.gitignore` re-additions**                         | snowball mixed commits                                                                                                                            | Re-add entries `main` deliberately removed (`e2e/test-results/`, `web/shell/src/generated/remoteHashes.json`, `aria-tools/daemons/`).                                                                                                                    |
| **ADR-033 ARIA-LIVE-AUTHORITY banner**                | `docs/adr/033-aria-autonomous-profile.md` snowball hunk                                                                                           | Re-adds a stale banner `main` deliberately removed.                                                                                                                                                                                                      |
| **Ephemeral runtime state**                           | `aria-tools/**/*.jsonl` (31), `aria-tools/discovery/**/*.json` (28), `FATES/SNAPSHOT/SERVICE_MAP/COMPLETION_PROOF.json`                           | Per-run/per-tenant state. Already pruned 97→12 on both sides. **Never reintroduce, even riding inside an otherwise-good commit.**                                                                                                                        |

---

## 7. Verification Gates (before any Tranche lands)

1. **Scope guard:** `git show <sha> --name-only` for each ported file confirms it matches the
   Tranche allow-list and touches **no** `apps/ web/ libs/ platform/ sens-api-gateway/
aria-kernel/aria_kernel/` path.
2. **Absence re-confirm:** `git cat-file -e main:<path>` returns absent for every "net-new" file
   at apply-time (guards against a concurrent session landing it first — see the parallel-sessions
   memory).
3. **No ephemeral ride-along:** `git diff --cached --name-only | grep -E '\.(jsonl)$|/discovery/'`
   is empty.
4. **ADR/finding numbering:** re-derive next-free ADR (`035`) and ORPHAN-MEDIUM (`064`) off
   `origin/main` **at apply-time**, not from this document (numbers may move).
5. **Repo gates:** `nx affected --target=test && nx affected --target=lint` green; ARIA invariant
   specs (`tests/invariants/*`) green. (Docs-only tranches should be no-ops here, which is itself the
   confirmation.)
6. **Traceability:** each fix commit carries `Closes:
docs/plans/2026-06-13-aria-to-main-controlled-merge/README.md#tranche-N`.

---

## 8. Open Questions for the Operator (decisions needed)

| #   | Question                                                                                                                                                                                                                               | Recommendation                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Q1  | **Is the convergence intentional?** `main` re-authored F-024…F-027 + the V10.5 line under `plan-026R` rather than cherry-picking snowball SHAs. Confirm this double-authoring is accepted convergence, not an accident to deduplicate. | Accept as convergence; `main` is authoritative. |
| Q2  | **Preserve per-commit ARIA provenance?** `main`'s `ffdef128a` squashed 130 snowball commits into one. If audit needs phase-by-phase history, the `archive/snowball-autonomy-v10.5` tag (§5 Tranche 3) preserves it.                    | Cut the tag before any snowball pruning.        |
| Q3  | **ADR-034 renumber → 035 acceptable?** Tranche 2 collides with `034-edge-schema-sensor-per-tenant-ownership.md`.                                                                                                                       | Yes — renumber to ADR-035.                      |
| Q4  | **`origin/snowball` is 191 behind local.** Should local `snowball` be pushed (to checkpoint the authoritative tip) before tagging/pruning?                                                                                             | Push to a checkpoint ref first; do not delete.  |
| Q5  | **Stale `origin/*` foundation refs** — leave as-is or also tag-pin?                                                                                                                                                                    | Tag-pin per §5, then they may be pruned safely. |

---

## 9. Bottom Line

The controlled, branch-by-branch comparison the operator asked for produced a clear and defensible
result: **there is no ARIA merge to perform — `main` is already the forward authority.** The
actionable surface is **two documentation-only cherry-picks** (one orphan-finding note, one ADR +
contract doc set, both renumbered) plus **archival tagging** of the superseded line. The audit's
principal value is the **DO-NOT-MERGE register (§6)**, which protects `main` from a naive merge
that would have reverted its `plan-026R` kernel hardening and 77 platform fixes.

---

## Appendix A — Per-Agent Evidence Ledger (condensed)

| Agent                             | Headline finding                                                                                                                                                               | Key evidence                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **A1** kernel-engine              | All 61 engine commits already-on-main/superseded; `main` net **+7,505 lines** on 85 shared files; 8 `main`-only modules; 0 snowball-only.                                      | `git diff main snowball -- aria_kernel/*` (main ahead); `ls-tree` module set difference. |
| **A2** tests/CI                   | All 26 already-on-main; `.claude/agents` byte-identical; divergent files are `main`-newer (cost-cap, `write_sanitized_json`, shared diff-ranges SSoT).                         | per-file content equality; `Plan ARIA-V8.x` docstrings on main.                          |
| **A3** mixed-1                    | All 28 already-on-main; platform halves are no-ops or `main`-ahead (ci-full.yml +103, ORPHAN-HIGH-080..083 main-only).                                                         | named-symbol + byte-identity checks; ReDoS regex present on main.                        |
| **A4** mixed-2                    | Entire V9/V3.1/V10.4/V10.5 autonomy lineage absorbed by `ffdef128a`; `git diff main..snowball` = 2,193 ins / 18,720 del (main +16.5K).                                         | three integration commits; per-path stat.                                                |
| **A5** platform/ephemeral         | 15 "platform" commits are ARIA bookkeeping, all already-on-main or `main`-superset; the 1 merge `e1a1e30c` is a sync; 31 `.jsonl` + 28 discovery JSON are ephemeral.           | `aria-findings/` 0-diff; registry 325>261 rows.                                          |
| **A6** foundation-proof           | 4 branches superseded ~70 commits ago; absent-on-main files are 3 superseded intermediates only.                                                                               | merge-base `ffdef128a` reachable from main; `workflow_contract_registry` consolidated.   |
| **A7** foundation-B + thin-deltas | F-024…F-027 + V3.1-F2 **on main line-for-line**; **only** `9f291ba46` is unique → Tranche 1; `f8528d7de` docs → Tranche 2.                                                     | `convergence_drainer.py:837/330/861`, `cli.py:3943`, `github_adapters.py:172`.           |
| **A8** kernel reconciliation      | `main` kernel is a **strict superset** (17 main-only files, 0 snowball-only, 0 net-new snowball symbols); surviving snowball diff is refactor-noise + the regressive base-pin. | `ls-tree` set diff; symbol scan; `auto_merge.py:17,120`.                                 |

## Appendix B — Commands Reference (read-only, reproduce the audit)

```bash
MB=$(git merge-base main snowball)                 # 71a449202b…
git diff --name-only main snowball -- .claude/agents   # → 0 (already reconciled)
git diff --name-only main snowball -- aria-tools       # → 0
git diff --name-only main snowball -- aria-kernel      # → 198 (the only divergence)
comm -13 <(git ls-tree -r --name-only main -- aria-kernel|sort) \
         <(git ls-tree -r --name-only snowball -- aria-kernel|sort) # snowball-only kernel files →
         empty
git log --oneline main -- aria-kernel | head # ffdef128a / 0b148a96a / 42695736f integration line
git cat-file -e main:docs/adr/034-aria-runtime-v2-promotion.md # ABSENT → renumber target free at
035
```
