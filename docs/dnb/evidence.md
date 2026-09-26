# SUDERRA AS / ARIA — Verified evidence for the accelerator application and investor deck

Compiled 2026-09-26 by a read-only audit. Nothing in the repository was edited, committed or pushed.

## 0. Snapshot, method, conventions

- **Repository:** `github.com/Okan-wqm/aquaculture_platform`. It is **public** (`"private": false` from the GitHub search API; repository created on GitHub 2026-01-12).
- **Code snapshot:** `origin/main` @ `2f6378c52a93884b64c95f29e518fc7595f1f6d3` (2026-09-26 07:00 +0200, "Merge pull request #1671"). History was unshallowed (`git fetch --unshallow origin main aria/state`), so all counts cover the full history.
- **ARIA live state snapshot:** `origin/aria/state` @ `30a5e5e1344637cc2e95fb46169c1e22df9ec688` (2026-09-26 04:26 +0200, "chore(aria-state): executor-36207002596").
- **Read method:** `git archive origin/main | tar -x -C scratchpad/main` and `git archive origin/aria/state | tar -x -C scratchpad/ariastate`, then counting. GitHub Actions and PR facts come from the GitHub API through the MCP tools. Where these are cited, the run ID or the search query is given.
- **Local-only branches:** plans 036/037 and several fixes exist only on local branches in this checkout (`plan036*`, `plan037-*`). They are **not on `origin/main`**, and every such fact is labelled.
- **Status legend:**
  - `LIVE`: runs today, with recorded runs.
  - `BUILT`: code exists and is tested, but does not run end-to-end in production.
  - `PLANNED`: not built.
  - `HISTORY`: something that happened.
  - Audit verdicts use VERIFIED / UNVERIFIED / FALSE / PARTIAL.
- **Approximate counts:** a count of test cases made by regex over source is marked "approx.".

LOC exclusion rule, used everywhere below. It is applied to `git ls-tree -r --name-only origin/main` (12,788 files):

```
EXCL='(^|/)vendor/|generated|/dist/|\.map$|\.tsbuildinfo$|(^|/)package-lock\.json$|\.lock$|/migrations/'
grep -vE "$EXCL" files.txt > files_src.txt        # 12,182 files remain
grep -E '\.(ts|tsx)$' files_src.txt | (cd main && xargs -d '\n' cat) | wc -l     # etc. per language
```

Excluded:

- vendored code (`sens-api-gateway/vendor/`, `tools/vendor/`);
- generated code (`*generated*`, e.g. GraphQL codegen and WASM bindings);
- the `tools/eslint-rules/dist` build output;
- lockfiles, source maps and `.tsbuildinfo`;
- TypeORM migrations (505 files, 78,121 lines), which CLAUDE.md says are generated ("Never hand-edit migration files — generate a new one").

---

## A. Platform scale

**E-001**

- **Statement:** The backend has 17 application directories under `apps/`: 15 long-running services, one Rust ingestion sidecar (`sensor-ingestion`) and one migration CLI (`db-migrate`).
- **Status:** BUILT
- **Source:** `ls apps` shows admin-api-service, ai-service, alert-engine, auth-service, billing-service, config-service, db-migrate, event-store-service, farm-service, gateway-api, hr-service, hydroponics-service, messaging-service, notification-service, observability-service, sensor-ingestion and sensor-service (`ls apps | wc -l` = 17). The same split is stated in CLAUDE.md:42.
- **Plain-language explanation:** The product is split into 17 separate back-end programs, each with one job, such as farms, sensors, billing or staff.

**E-002**

- **Statement:** The web layer has 11 projects: a host shell, a shared design system, 8 plug-in front-end modules, and a standalone offline-first mobile web app (AquaMobil).
- **Status:** BUILT
- **Source:** `ls web web/modules web/apps` shows `shell`, `shared-ui`, `modules/{admin-panel,dashboard,farm-module,hr-module,hydroponics-module,messaging-module,sensor-module,tenant-admin}` and `apps/aquamobil`.
- **Plain-language explanation:** There is a main web app, 8 feature areas that plug into it, and a phone app that also works offline.

**E-003**

- **Statement:** The repository contains 16 shared libraries in `libs/`, 5 platform libraries in `platform/libs/`, 11 Rust crates in `crates/`, and a separate Rust edge gateway (`sens-api-gateway/`). There are 59 Nx `project.json` projects and 17 `Cargo.toml` manifests.
- **Status:** BUILT
- **Source:** `ls libs` (16), `ls platform/libs` (5), `ls crates` (11), `find . -name project.json | wc -l` = 59, `find . -name Cargo.toml | wc -l` = 17.
- **Plain-language explanation:** Common building blocks are packaged once and reused across the product.

**E-004**

- **Statement:** Lines by language, excluding vendored, generated, lockfile and migration files:

  | Language   | Lines     | Files | Non-test lines | Test lines |
  | ---------- | --------- | ----- | -------------- | ---------- |
  | TypeScript | 1,551,219 | 7,484 | 1,098,797      | 452,422    |
  | Python     | 393,915   | 1,140 | 192,067        | 201,848    |
  | Rust       | 219,893   | 436   | 208,006        | 11,887     |
  | Shell      | 21,972    | —     | —              | —          |
  | JavaScript | 17,560    | —     | —              | —          |
  | SQL        | 6,614     | —     | —              | —          |

  The six languages total **2,211,173 lines**. There are also 43,146 lines of YAML and 442,616 lines of Markdown documentation in 1,872 files.

- **Status:** BUILT
- **Source:** The LOC commands in §0. Test lines are paths matching `(\.spec\.|\.test\.|(^|/)tests?/|/__tests__/|test_*.py|_test\.py|(^|/)e2e/)`. The Rust test count excludes inline `#[cfg(test)]` blocks.
- **Plain-language explanation:** The codebase is about 2.2 million lines of hand-maintained code, roughly a third of it tests.

**E-005**

- **Statement:** Code lines (ts/tsx/py/rs/js/mjs) by area:

  | Area                    | Lines   |
  | ----------------------- | ------- |
  | apps                    | 731,942 |
  | web                     | 503,940 |
  | aria-kernel             | 374,855 |
  | sens-api-gateway (Rust) | 185,964 |
  | libs                    | 132,274 |
  | tests                   | 79,468  |
  | tools                   | 62,828  |
  | e2e                     | 30,101  |
  | crates                  | 25,267  |
  | platform                | 13,719  |
  | scripts                 | 12,856  |

- **Status:** BUILT
- **Source:** `grep -E "^$d/" files_src.txt | grep -E '\.(ts|tsx|py|rs|js|mjs|cjs)$' | xargs cat | wc -l` for each area.
- **Plain-language explanation:** Most code is the product itself. ARIA's own code is about 375 thousand lines, and the sensor gateway is about 186 thousand.

**E-006**

- **Statement:** `main` has 6,888 commits: 5,954 regular commits and 934 merge commits. The first commit is dated 2025-11-23 and the latest 2026-09-26. The largest single commit is a bulk import on 2026-01-20 ("feat: Complete Aquaculture Platform - Full Implementation", 464,749 added lines).
- **Status:** HISTORY
- **Source:**
  - `git rev-list --count origin/main` = 6888; `--no-merges` = 5954; `--merges` = 934.
  - `git log --reverse --format='%h %ad %s' origin/main | head -1` gives `702d27a95 2025-11-23 ... chore: initialize aquaculture platform monorepo workspace`.
  - `git log --numstat` top commit: `1b32c8cb8 464749`.
- **Plain-language explanation:** Ten months of history and close to 7,000 recorded changes.

**E-007**

- **Statement:** Merged pull requests can be counted three ways:
  - `git log --merges --first-parent origin/main` shows 476 "Merge pull request #N" commits.
  - Another 761 first-parent commits are squash-merges titled "(#N)".
  - Together, 1,236–1,237 distinct PR numbers landed on `main`'s first-parent history between 2026-04-16 and 2026-09-26.

  GitHub reports 1,344 PRs merged into `main` (1,361 merged in total, 1,660 PRs opened).

- **Status:** HISTORY
- **Source:**
  - `git log --merges --first-parent --format=%s origin/main | grep -c 'Merge pull request #'` = 476.
  - `git log --first-parent --no-merges --format=%s origin/main | grep -cE '\(#[0-9]+\)$'` = 761.
  - GitHub search `repo:Okan-wqm/aquaculture_platform is:pr is:merged base:main` returns total_count 1344; `is:pr is:merged` returns 1361; `is:pr` returns 1660.
  - The gap between 1,237 and 1,344 is PRs that are not visible on the first-parent path (for example, merges into integration branches). This was not investigated further.
- **Plain-language explanation:** About 1,300 reviewed change packages have been merged into the main product line.

**E-008**

- **Statement:** The repository has 1,933 TypeScript/JavaScript test files, 711 Python test files (698 of them in ARIA's kernel) and 325 Rust files that contain tests. By regex, that is about 16,200 TS `it(`/`test(` cases, 7,052 Python `def test_` functions and 3,164 Rust `#[test]` functions (approx.).
- **Status:** BUILT
- **Source:**
  - `grep -E '\.(spec|test)\.(ts|tsx|js|mjs)$' files.txt | wc -l` = 1933.
  - `grep -E '(^|/)test_[^/]*\.py$|_test\.py$' files.txt | wc -l` = 711.
  - Rust: 63 files under `tests/` plus 262 source files containing `#[test]`.
  - Case counts come from `grep -cE` over those files.
- **Plain-language explanation:** Thousands of automatic checks verify that the code does what it should.

**E-009**

- **Statement:** The ARIA kernel's test suite passed in CI on 2026-09-25/26:
  - Main run 36197063143 (commit 9175a06b): "Ran 6931 tests in 5809.126s / OK (skipped=18)", plus "91 passed" in a second pytest partition.
  - PR #1673 run 36213820815 (commit 4da6dfae, now merged): "Ran 6976 tests in 5042.726s / OK (skipped=18)", plus 91 passed.

  The founder's figure of 6,929 was not found in either log.

- **Status:** LIVE
- **Source:**
  - GitHub Actions job 108275206738, log lines 2266–2271: `Ran 6931 tests in 5809.126s` / `OK (skipped=18)` / `91 passed, 6931 deselected in 43.07s`.
  - Job 108325678149, log lines 2270–2275: `Ran 6976 tests ...` / `OK (skipped=18)` / `91 passed`.
  - The aria-kernel workflow has 1,080 runs on `main` (actions API total_count).
- **Plain-language explanation:** ARIA's own code is checked by about 7,000 automatic tests on every change, and they pass.

**E-010**

- **Statement:** Architecture rules are enforced by 314 invariant test files in `tests/invariants/` (about 1,542 test cases, approx.). One of them keeps CLAUDE.md under a 200-line budget.
- **Status:** LIVE
- **Source:**
  - `ls tests/invariants | grep -cE '\.spec\.ts$'` = 314.
  - `grep -rhoE "^\s*(it|test)\(" tests/invariants --include=*.spec.ts | wc -l` = 1542.
  - `tests/invariants/claude-md-accuracy.spec.ts` exists.
  - On aria/state, `tools/auto-merge-decisions.jsonl` records a CI check named `invariants-fast`, which shows the suite runs on PRs.
- **Plain-language explanation:** Hundreds of automatic "house rules" fail the build when someone breaks the architecture.

**E-011**

- **Statement:** The repository has 56 GitHub Actions workflows, 12 of them ARIA-specific.
- **Status:** BUILT
- **Source:** `ls .github/workflows | wc -l` = 56. `ls .github/workflows | grep aria` lists aria-agent-eval, aria-agent-executor, aria-auto-cycle, aria-daily-report, aria-external-watchdog, aria-kernel, aria-merge-authority, aria-merge-runner, aria-operational-proof, aria-readiness-claim, aria-runner-capability-probe and aria-state-maintenance.
- **Plain-language explanation:** 56 automated pipelines build, test and check the product.

---

## B. Evidence that AI coding agents built the platform

**E-012**

- **Statement:** 1,145 commits on `main` are authored by the identity `Claude <noreply@anthropic.com>`, and 1,186 have it as committer.
- **Status:** HISTORY
- **Source:**
  - `git log --format='%H' --author='noreply@anthropic.com' origin/main | wc -l` = 1145.
  - `git log --format='%H %ce' origin/main | grep -c noreply@anthropic.com` = 1186.
- **Plain-language explanation:** Over a thousand code changes were recorded as written by Anthropic's Claude coding agent.

**E-013**

- **Statement:** 762 commits (11.1% of all 6,888) carry an explicit AI-agent trailer:
  - `Claude-Session:` on 401 commits;
  - `Co-Authored-By: Claude` on 513 commits;
  - "Generated with Claude Code" on 0 commits.

  Counting any Claude marker (trailer, session URL, or Claude author or committer), 1,703 commits qualify. That is 24.7% of all commits and 26.3% of the 5,954 regular commits. The first marked commit is dated 2026-02-03 and the last 2026-09-26.

- **Status:** HISTORY
- **Source:**
  - `git log -i --grep='Claude-Session:'` = 401.
  - `--grep='Co-Authored-By: Claude'` = 513.
  - `-E --grep='Generated with \[?Claude Code'` = 0.
  - The union was computed by a Python pass over `git log --format='%x1e%H%x1f%P%x1f%ae%x1f%ce%x1f%aI%x1f%B'`.
- **Plain-language explanation:** At least one in four changes carries the AI agent's signature.

**E-014**

- **Statement:** By month, Claude-marked regular commits make up:
  - 150 of 244 (61%) in February 2026;
  - 17 of 518 (3%) in March;
  - 144 of 1,933 (7%) in April;
  - 9 of 500 in May;
  - 1 of 423 in June;
  - 607 of 983 (62%) in July;
  - 18 of 372 (5%) in August;
  - 621 of 855 (73%) in September 2026.
- **Status:** HISTORY
- **Source:** The same Python pass, bucketed by author date (`%aI[:7]`).
- **Plain-language explanation:** In the most recent month, almost three quarters of changes carry the AI signature.

**E-015**

- **Statement:** The marker counts are a **lower bound**. Since 2026-04-06, the repository's own rulebook has told agents never to add a `Co-Authored-By` line. So agent-written commits made under the founder's git identity carry no marker, and how many of the 4,387 unmarked regular commits were agent-written is **UNVERIFIED**.
- **Status:** HISTORY
- **Source:**
  - `git log --reverse -G'Co-Authored' origin/main -- CLAUDE.md` finds `ed9237758 2026-04-06` adding "Co-Authored-By satırı ASLA commit mesajına eklenmeyecek". The rule is now at CLAUDE.md:151.
  - The low marked shares in March–June and August (E-014) fit this, but they do not prove it.
- **Plain-language explanation:** The true AI share is probably higher, but git history cannot prove it.

**E-016**

- **Statement:** Claude-marked regular commits added 706,037 of the 4,295,852 lines added in regular commits (16.4%), and 530,533 of 2,983,200 lines in code files (17.8%). Lockfiles, vendored, generated, `.jsonl`, migration and binary files are excluded.
- **Status:** HISTORY
- **Source:** `git log --no-merges --numstat origin/main`, summed per commit and matched with the marker set from E-013.
- **Plain-language explanation:** Commits signed by the AI account for at least a sixth of all lines ever written.

**E-017**

- **Statement:** Of 1,236 PRs on `main`'s first-parent history, 203 contain at least one Claude-marked commit or were merged from a `claude/*` branch (170 merge-commit PRs and 33 squash PRs). 138 contain an explicit trailer, and 81 were merged from `claude/*` branches. The first such PR is dated 2026-04-23 and the last 2026-09-26.
- **Status:** HISTORY
- **Source:** Python pass over `git log --first-parent --format='%H %P%x09%s' origin/main`. For each merge commit M, the commits in `rev-list M^1..M^2` were checked. Branch prefixes come from `git log --merges --first-parent --format=%s | sed ... | uniq -c` (claude: 81).
- **Plain-language explanation:** At least 200 of the merged change packages contain AI-written work. A human merged them all.

**E-018**

- **Statement:** A second vendor's coding agent, OpenAI Codex, also contributed. 59 commits are authored by `codex` identities, and at least 28 PRs were merged from `codex/*` branches.
- **Status:** HISTORY
- **Source:** `git log -i -E --author='codex' origin/main | wc -l` = 59. The branch-prefix count above gives codex: 28.
- **Plain-language explanation:** More than one AI vendor's agent has written code for the platform.

**E-019**

- **Statement:** A GitHub App named `aria-implementer-okan[bot]` opened 36 PRs. 35 of them are registry-bookkeeping PRs titled "chore(findings): record closures reachable from main"; the other is a still-open "daily state sweep" (#1335). 32 were merged, and every merge commit is authored by the human operator (OKAN OZTURK). These PRs come from the `finding-closure-reconcile` workflow, which uses ARIA's App credentials. They are **not** code changes produced by ARIA's reasoning runtime.
- **Status:** LIVE
- **Source:**
  - GitHub search `is:pr author:app/aria-implementer-okan` returns total_count 36; with `is:merged` it returns 32.
  - `git log --first-parent --merges --format='%h %an | %s' | grep automation/` shows author OKAN OZTURK.
  - `.github/workflows/finding-closure-reconcile.yml:168-181` reads `ARIA_GH_APP_*`.
- **Plain-language explanation:** A bot under ARIA's name files routine record-keeping updates, and a human approves them. This is not ARIA writing product code.

---

## C. The governance system

**E-020**

- **Statement:** There are 99 AI reviewer and worker agent definitions, split by lane:

  | Lane              | Agents                    | What they do                                      |
  | ----------------- | ------------------------- | ------------------------------------------------- |
  | Lane-A            | 33 (incl. `orchestrator`) | Code, architecture, security and domain review    |
  | ARIA              | 20                        | 18 `aria-*` agents plus 2 ARIA maintenance agents |
  | Lane-B            | 22                        | Product audit                                     |
  | Lane-C            | 13                        | Edge documentation                                |
  | db-audit          | 8                         | Database audit                                    |
  | Other maintenance | 3                         | Maintenance tasks                                 |

- **Status:** BUILT
- **Source:** In `.claude/agents/**/*.md`, a file counts as an agent when `head -5 | grep '^name:'` matches. That gives 51 top-level, 5 `_maintenance`, 8 `db-audit`, 13 `edge-docs` and 22 `product-audit`. The READMEs and `_shared` files have no `name:` line and are not counted. Lanes are defined in `.claude/agents/README.md:5-12`.
- **Plain-language explanation:** About a hundred specialised AI "inspectors" each check one kind of problem.

**E-021**

- **Statement:** The finding registry holds 2,178 findings, created between 2026-04-16 and 2026-09-25 and owned by 60 agent roles. By state and severity:

  | Severity | Total     | RESOLVED  | OPEN    | IN-PROGRESS | BLOCKED |
  | -------- | --------- | --------- | ------- | ----------- | ------- |
  | CRITICAL | 214       | 185       | 16      | 12          | 1       |
  | HIGH     | 1,068     | 933       | 106     | 28          | 1       |
  | MEDIUM   | 701       | 503       | 177     | 21          | 0       |
  | LOW      | 195       | 130       | 63      | 2           | 0       |
  | **All**  | **2,178** | **1,751** | **362** | **63**      | **2**   |

  1,724 RESOLVED rows name their closing commits (1,098 distinct SHAs).

- **Status:** LIVE
- **Source:** Python over `docs/reviews/_registry/findings.jsonl`: `Counter(state)`, `Counter((severity,state))`, min/max of `created_at`. Note: the open sweep PR #1335 (E-019) would move 340 stale or past-deadline rows to STALE/BLOCKED if merged.
- **Plain-language explanation:** Every problem the inspectors find is logged with an ID. 80% of the 2,178 logged problems are fixed, with a pointer to the fix.

**E-022**

- **Statement:** The finding registry is hash-chained, and all 2,178 entries verify: each entry's `prev_hash` equals the previous entry's `content_hash`, which is the sha256 of the entry's canonical JSON.
- **Status:** LIVE
- **Source:** My independent Node script `scratchpad/pitch/verify_registry.js` reimplements `tools/gates/finding-registry.ts:265-275` (`canonicalJson`) and `:478-` (`verify`). Output: `registry entries 2178 all hash-chained OK 2178`.
- **Plain-language explanation:** The problem log is tamper-evident: editing any old entry would break the chain.

**E-023**

- **Statement:** Fixes are tied to findings through `Closes:` commit trailers. 2,437 commits on `main` carry at least one `Closes: docs/reviews/...` trailer, 3,980 trailers in total. The trailers are validated by `tools/gates/commit-msg-validator.ts` in the "Closes Footer Check" workflow, which has run 4,389 times; the latest run, on 2026-09-26, succeeded. A `finding-registry-closure-drift` gate keeps RESOLVED consistent with merged trailers.
- **Status:** LIVE
- **Source:**
  - `git log -E --grep='^Closes: *docs/reviews/' origin/main | wc -l` = 2437.
  - `git log --format=%B | grep -cE '^Closes: *docs/reviews/'` = 3980.
  - `.github/workflows/closes-footer-check.yml:71-72`.
  - The actions API returns total_count 4389 for `closes-footer-check.yml`.
  - `tools/gates/finding-traceability.ts:14-17` defines the trailer regex.
- **Plain-language explanation:** A fix only counts when it names the problem it fixes, and a robot checks that it does.

**E-024**

- **Statement:** The "Quality Gates" workflow runs on every PR and every push to `main`. It has run 5,817 times, most recently with success on 2026-09-26. It enforces:
  - **Banned phrases** (13 rules). These reject excuse language in diffs and commit messages; the exact phrases are listed in `tools/gates/banned-phrase.ts`.
  - **Banned constructs** (10 rules): `as any`, `as unknown as`, `as never`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `.skip(`, `xit/xdescribe/xtest`, `eslint-disable` and bare `getRepository(`.
- **Status:** LIVE
- **Source:**
  - `tools/gates/banned-phrase.ts:194-` (`BANNED_PHRASES` labels).
  - `tools/gates/banned-construct.ts:117-` (`BANNED_CONSTRUCTS` labels).
  - `.github/workflows/quality-gates.yml:1-45`.
  - The actions API returns total_count 5817 for `quality-gates.yml`.
- **Plain-language explanation:** The build refuses code, and even commit messages, that take known shortcuts.

**E-025**

- **Statement:** The repository has 58 Architecture Decision Records in `docs/adr/`: 56 numbered 001–046 (several numbers are used twice) plus 2 date-named records. There are also 12 drafts in `docs/adr/_draft/`.
- **Status:** HISTORY
- **Source:** `ls docs/adr` gives 60 entries, minus `_draft` and `template.md`. 46 distinct numbers; the highest is `046-tenant-auth-security-policy-ssot.md`. `ls docs/adr/_draft | wc -l` = 12.
- **Plain-language explanation:** 58 major design decisions are written down with their reasons.

**E-026**

- **Statement:** The rules and knowledge base for the agents consist of:
  - a 198-line root `CLAUDE.md`;
  - 16 `CLAUDE.md` files in total;
  - 13 knowledge-layer files in `.claude/knowledge/`;
  - 8 skills;
  - 424 review reports in 73 folders under `docs/reviews/`.
- **Status:** LIVE
- **Source:** `wc -l CLAUDE.md` = 198; `find . -name CLAUDE.md | wc -l` = 16; `ls .claude/knowledge | wc -l` = 13; `find docs/reviews -name '*.md' | wc -l` = 424.
- **Plain-language explanation:** The AI agents work from a written rulebook and a library of past reviews.

**E-027**

- **Statement:** Timeline, showing that the governance system existed before ARIA:
  - first commit 2025-11-23;
  - bulk platform import 2026-01-20;
  - first Claude-marked commit 2026-02-03;
  - `.claude/agents` added 2026-02-19;
  - "no Co-Authored-By" rule 2026-04-06;
  - finding registry, `Closes:` gate and invariants 2026-04-16;
  - ARIA spec and proof of concept 2026-05-02;
  - `aria-kernel/` 2026-05-04;
  - first nightly-cycle workflow run 2026-07-02;
  - first live cycle recorded on aria/state 2026-08-05.
- **Status:** HISTORY
- **Source:** `git log --reverse --format='%h %ad %s' --date=short origin/main -- <path> | head -1` for `.claude/agents` (734fd574f 2026-02-19), `docs/reviews/_registry/findings.jsonl` (7090c9509 2026-04-16), `tests/invariants` (ad7ec82d0 2026-04-16), `docs/aria/SPEC.md` (542d54a1b 2026-05-02), `tools/aria-poc` (0eb27dc93 2026-05-02) and `aria-kernel` (b829e9594 2026-05-04). The first aria-auto-cycle run is 28558263318 on 2026-07-02.
- **Plain-language explanation:** The company built rules and inspectors for its AI coders first. ARIA grew out of those rules about five months later.

---

## D. ARIA itself

**E-028**

- **Statement:** The design documents define ARIA as a "repository-shaped intelligence". It has three laws:
  - L1 Grounded Evidence;
  - L2 Repository Preservation;
  - L3 Operational Safety & Data Boundary.

  It has five engines (Discovery, Memory, Pressure, Skill, Reflection) and three "pressure primitives" (Unknown, Repetition, Contradiction). The system states its own honesty floor: "ARIA the system EXISTS and runs", and any behaviour its prose describes is intent until a gate enforces it.

- **Status:** BUILT
- **Source:** `docs/aria/SPEC.md:46-251` (laws §2, pressures §3, engines §4); `docs/aria/IDENTITY.md:29-34` (honesty floor); `docs/aria/CURRENT_STATE.md:27-40` (authority chain: code > CURRENT_STATE > ADRs > SPEC/CONTRACTS/IDENTITY).
- **Plain-language explanation:** ARIA is a rulebound system that watches one codebase, remembers what it has proven about it, and is designed to act only on proof.

**E-029**

- **Statement:** The ARIA kernel is 352 Python source files (174,952 lines) plus 738 test files (199,416 lines). The package has 310 modules. `state_manifest.py` declares 246 state surfaces, of which 216 are append-only ledgers.
- **Status:** BUILT
- **Source:**
  - `grep -E '^aria-kernel/aria_kernel/.*\.py$' files_src.txt | xargs cat | wc -l` = 174952.
  - The same for `aria-kernel/tests/` = 199416.
  - `ls aria-kernel/aria_kernel/*.py | wc -l` = 310.
  - `python -c 'import aria_kernel.state_manifest as sm; len(sm.STATE_SURFACES)'` = 246; `Counter(state_class)` gives ledger 216.
- **Plain-language explanation:** ARIA is a large, heavily tested program with over 200 separate record books.

**E-030**

- **Statement:** ARIA has operated live on this repository:
  - **Nightly cycles:** 43 started, 30 completed and 13 failed. The first was on 2026-08-05 10:23 UTC. The last recorded event is on 2026-09-21 00:04 UTC, for cycle `cyc-20260920T212805Z-auto`.
  - **The nightly workflow** has run 184 times since 2026-07-02. Runs 179–184 (2026-09-21 to 2026-09-25) **failed**, so no cycle has been recorded since 2026-09-21.
  - **The agent-executor workflow** (239 runs) kept working. Its latest run succeeded on 2026-09-26, and the latest aria/state commit is dated 2026-09-26 04:26 +0200.
- **Status:** LIVE (the nightly cycle has been red since 2026-09-21)
- **Source:**
  - `git show origin/aria/state:tools/cycles.jsonl`: 86 rows, `Counter(event)` = started 43, completed 30, failed 13, with min/max `at`.
  - The actions API returns total_count 184 for `aria-auto-cycle.yml`: run 184 (36185992985) is failure, run 178 (35532304435) the last success, and run 1 (28558263318) is dated 2026-07-02.
  - The actions API returns total_count 239 for `aria-agent-executor.yml`; run 36207002596 is success.
- **Plain-language explanation:** ARIA ran on the company's own code almost every night for seven weeks. Its nightly run has been failing since 21 September, and the fix has not yet been proven live.

**E-031**

- **Statement:** ARIA's memory lives in the company's own GitHub repository, on the branch `aria/state`: 159 commits between 2026-08-05 and 2026-09-26, and 1,334 files. All 88,890 rows in its 205 non-empty JSONL ledgers verify as intact hash chains, with 0 mismatches.
- **Status:** LIVE
- **Source:**
  - `git rev-list --count origin/aria/state` = 159.
  - `git ls-tree -r origin/aria/state | wc -l` = 1334.
  - My check imported the kernel's own `aria_kernel.ledger._record_hash` (`ledger.py:1241-1246`) and recomputed every row of every `*.jsonl` file on aria/state. Output: `jsonl files 214 chained files 205 rows 88890 hash_ok 88890 mismatch 0 link_breaks 0`.
- **Plain-language explanation:** Everything ARIA has seen or decided is stored in the customer's own archive as a tamper-evident chain of records.

### D.1 Memory

**E-032**

- **Statement:** ARIA's live belief memory is small. It holds:
  - 8 beliefs, all `supported` (for example "repository uses Nx workspace orchestration", and "alert-service has a recurring TypeORM entity and migration surface");
  - 12 observations;
  - 80 recorded uncertainties;
  - 0 contradictions;
  - 89 learning events between 2026-09-18 and 2026-09-20: 71 `belief_confirmed`, 9 `evidence_invalidated` and 9 `belief_corrected`.
- **Status:** LIVE
- **Source:** `git show origin/aria/state:tools/memory/{beliefs,observations,uncertainties,contradictions,learning-events}.jsonl`; `Counter(event_type)`. Each belief row carries `base_commit_sha` and `repo_state_id`.
- **Plain-language explanation:** ARIA holds a few confirmed facts about the codebase. When the code changed under one of them, it noticed and corrected the fact nine times.

**E-033**

- **Statement:** The richer memory layers are built but empty in live state:
  - conventions: 0 rows;
  - anti-patterns: 0;
  - embeddings: 0;
  - duel ratings: 0;
  - signers: 0;
  - change outcomes: 0.

  Only `context-usage` (711 rows) and `pressure-source-effectiveness` (20) hold data.

- **Status:** BUILT
- **Source:** The state-surface sweep mapped every `state_manifest.STATE_SURFACES` entry to aria/state. It found `knowledge-graph/conventions.jsonl` 0, `anti-patterns.jsonl` 0, `embeddings.jsonl` 0, `change-ledger/outcome.jsonl` 0 and `knowledge-graph/context-usage.jsonl` 711.
- **Plain-language explanation:** The part that would turn outcomes into rules exists in code but has not yet learned anything live.

**E-034**

- **Statement:** Beliefs decay in four ways: when their evidence files change (diff), at a 90-day age limit, when the codebase moves too far from the commit they were proven on (head distance), and when their source is quarantined. A decayed belief moves from `supported` to `needs_revalidation` to `stale`.
- **Status:** BUILT (the diff path is LIVE, see E-032)
- **Source:** `aria-kernel/aria_kernel/memory.py:22` (statuses), `:756` (`BELIEF_AGE_TTL_DAYS = 90`), `:759` (`decay_stale_beliefs_by_age`) and `:882` (`decay_beliefs_by_head_distance`). The docs review confirms "4 yol" (four paths): `docs/aria/reviews/2026-09-25-aria-dokuman-kod-karsilastirmasi.md:161`.
- **Plain-language explanation:** ARIA does not trust an old fact forever. It re-checks facts when the code changes or time passes.

### D.2 Perception

**E-035**

- **Statement:** ARIA perceives the codebase through adapters: small scanner programs that each have a declared scope. `main` ships 11 adapter manifests. The live registry holds 10 tools: 7 CALIBRATE, 2 SHADOW and 1 QUARANTINED. **None is ACTIVE**, and the `lint-rules` adapter is not registered.
- **Status:** LIVE (no adapter has reached ACTIVE)
- **Source:** `ls tools/aria-adapters/*.tool.json | wc -l` = 11. `git show origin/aria/state:tools/registry.json` shows agent-harness-security QUARANTINED; event-contracts, security-boundary, tenant-scoping, test-gap, typeorm-entity-schema, doc-staleness and kernel-dead-wire CALIBRATE; bundle-budget and fe-dto-parity SHADOW.
- **Plain-language explanation:** ARIA has 11 kinds of "eyes" on the code. None has yet earned full trust.

**E-036**

- **Statement:** Adapters ran 108 times (9 adapters × 12 runs) and produced 34,500 raw findings between 2026-09-04 and 2026-09-20. These collapse to 3,253 unique findings. One adapter, doc-staleness, produced 29,939 of the raw findings (87%). The rest: test-gap 3,459, tenant-scoping 724, security-boundary 156, kernel-dead-wire 110, bundle-budget 108 and fe-dto-parity 4.
- **Status:** LIVE
- **Source:** `git show origin/aria/state:tools/raw-findings.jsonl`: `Counter(tool_id)`, `len(set(finding_fingerprint))` = 3253, min/max `recorded_at`. `tools/runs.jsonl` = 108 rows.
- **Plain-language explanation:** ARIA's scanners flagged about 3,250 distinct possible issues, most of them out-of-date references in documentation.

**E-037**

- **Statement:** Doc-staleness noise was cut in two steps:
  1. From 2,766 to 276 findings, by commit `896e1f5c8` (2026-09-25, on `main`), which stops flagging dated records and archives. It found 1,160 documents to be records.
  2. From 276 to 250, by commit `ed848c05b` (2026-09-26), which flags only paths a document claims exist. On 46 human-labelled rows, precision went from 0.41 to 1.00. **This commit is on local branch `plan037-L` and is not on `main`.**
- **Status:** BUILT (the 276 step is on `main`; the 250 step is unmerged)
- **Source:** `git log -1 896e1f5c8`: "Measured on this tree: 2 766 -> 276 findings"; `git merge-base --is-ancestor 896e1f5c8 origin/main` confirms it is on main. `git log -1 ed848c05b`: "Real tree: 276 -> 250 findings"; `--is-ancestor` fails for main.
- **Plain-language explanation:** ARIA's noisiest scanner was made about ten times quieter without losing true problems. The last improvement is still waiting to be merged.

### D.3 Judgment

**E-038**

- **Statement:** ARIA minted 1,171 AI-agent work requests and received 324 results: 294 accepted and 30 rejected, between 2026-08-05 and 2026-09-25. The results by role:

  | Role                             | Results |
  | -------------------------------- | ------- |
  | evidence judgment                | 85      |
  | adversarial judgment             | 82      |
  | human-required adjudication      | 80      |
  | maintenance utility              | 25      |
  | consensus arbitration            | 21      |
  | challenger plan                  | 1       |
  | no role recorded (rejected rows) | 30      |

- **Status:** LIVE
- **Source:** `tools/agent-invocations/requests.jsonl` (1171) and `results.jsonl` (324): `Counter(status)`, `Counter(role)`, min/max `submitted_at`. A mock runtime was in effect only once (1 of 1,024 `claude_mock_mode_resolved` events has `effective_mock: true`).
- **Plain-language explanation:** ARIA has sent real work to AI agents about 1,200 times and accepted about 300 answers.

**E-039**

- **Statement:** The AI judges ruled on 157 findings: 70 true positives and 87 false positives. 148 rulings came from single judges and 9 from multi-judge consensus. By model: Anthropic Opus 88 (`opus` 79, `claude-opus-5` 9), Z.ai GLM-5.3 57, consensus 2, unlabelled 10. 220 judgment samples were drawn, 18 cases were left undecided because the judges disagreed or were not confident enough, and 41 judge-calibration rows exist.
- **Status:** LIVE
- **Source:** `tools/operator-feedback.jsonl` (157): `Counter(source_type)`, `Counter(verdict)`, `Counter(model)`. `tools/judgment-samples.jsonl` = 220. `tools/feedback-consensus-uncertainties.jsonl` = 18. `tools/calibration/judge-calibration.jsonl` = 41.
- **Plain-language explanation:** Independent AI judges from two companies reviewed ARIA's findings and rejected more than half as false alarms.

**E-040**

- **Statement:** Two AI vendors ran live between 2026-09-19 and 2026-09-26. Of 424 runtime attempts, 346 went to Anthropic (Opus, through the Claude Code CLI) and 78 to Z.ai (GLM-5.3, over HTTP). Outcomes:
  - 107 Claude successes (exit 0);
  - 51 Z.ai successes (HTTP 200);
  - 227 Claude failures (exit 1, `provider_nonzero`);
  - 39 transport or control unavailable.

  OpenAI Codex is in the fleet definition, but it is not proven in the live chain.

- **Status:** LIVE (Anthropic and Z.ai); BUILT, not proven (OpenAI)
- **Source:**
  - `tools/governance.jsonl` kind `runtime_attempt_started`: `Counter((provider, model))` gives (anthropic, opus) 346 and (zai, glm-5.3) 78.
  - `runtime_attempt_finished`: `Counter((exit_code, result_admission))`.
  - `aria-kernel/aria_kernel/model_fleet.py:100-125` (`_FLEET`: anthropic, zai, openai).
  - `docs/aria/CURRENT_STATE.md:94` (OpenAI row: "effective managed authentication and native dispatch remain open").
- **Plain-language explanation:** ARIA already uses AI models from two different companies side by side.

**E-041**

- **Statement:** ARIA refuses an answer it cannot verify. 24 of the 30 rejected agent results were refused with `agent_evidence_not_repo_verified`: the agent cited a file or line that did not match the committed code. Other causes: 12 malformed references, 4 compliance hard-fails and 2 self-output citations (one result can have several causes).
- **Status:** LIVE
- **Source:** `tools/agent-invocations/results.jsonl` rows with `status == "rejected"`, scanned for reason codes in `rejection_reasons`.
- **Plain-language explanation:** When an AI agent cites evidence that is not really in the code, ARIA throws the answer away.

**E-042**

- **Statement:** ARIA's findings store holds 13 findings, all OPEN and none resolved:
  - F-001…F-008 are mechanical "enum drift" seeds;
  - F-009…F-013 were promoted by AI-judge consensus.

  Example F-012: "`docs/adr/024-compliance-retention-matrix.md:41` references `tools/gates/findings-pii-scan.ts`, which does not exist". It was verified at commit `e9fd27bf` with `trust_grade: repo_verified` and content hash `sha256:32bd3133ccaf2…`, at consensus confidence 0.825. I re-checked it on 2026-09-26: the file is still missing on `main`, and `git show e9fd27bf:docs/adr/024-compliance-retention-matrix.md | sha256sum` = `32bd3133ccaf25d4…`, which matches the recorded hash.

- **Status:** LIVE
- **Source:** `git show origin/aria/state:findings/aria-findings/_index.json` (13 OPEN; generated 2026-09-20T17:40:34Z) and `findings/aria-findings/F-012.json`. `git cat-file -e origin/main:tools/gates/findings-pii-scan.ts` fails, meaning the file does not exist.
- **Plain-language explanation:** Each ARIA finding records the exact file, line and code version, and anyone can re-check it today.

**E-043**

- **Statement:** The escalation panels ("HUMAN_REQUIRED" adjudication) have not closed a single case. 114 records are open. Of 136 panels opened, 101 hit `reopen_exhausted`, and 968 `panel_incomplete` folds were recorded. The 2026-09-25 review found the cause: the panel could not read the votes, and all seats of a panel shared one "principal", so the panel was not independent.
- **Status:** LIVE (broken; fixes are on `main` but not yet proven live)
- **Source:** `tools/human-required/*.json` (114, all `open`). `tools/governance.jsonl` kinds `human_required_adjudication_opened` 136, `..._reopen_exhausted` 101 and `..._folded` 968. `docs/reviews/claude/2026-09-25-aria-e2e-chain-closure.md` (ARIA-HIGH-193; ARIA-HIGH-097). The fixes landed in PR #1672 (plan 034 status line, `docs/aria/plans/034-e2e-chain-closure.md:5-19`).
- **Plain-language explanation:** The mechanism that should settle hard cases between AI judges has not yet worked live. The known bugs are fixed in code and still need a live run.

**E-044**

- **Statement:** Independence checks exist in code:
  - an "echo-chamber" detector flags judge texts that are more than 85% similar (3-gram Jaccard);
  - principal-disjointness checks that seats are held by different identities;
  - consensus requires an average confidence of at least 0.80 on a weighted majority.
- **Status:** BUILT
- **Source:** `aria-kernel/aria_kernel/independence_check.py:21-24,64`; `feedback_store.py:82` (`CONSENSUS_MIN_CONFIDENCE = 0.80`) and `:825` (`generate_ai_consensus`).
- **Plain-language explanation:** ARIA is designed not to trust judges that merely copy each other.

### D.4 Planning

**E-045**

- **Statement:** Plans are designed to converge through a primary planner, a challenger planner and a cross-reviewer. Live, 15 plans started, 12 were abandoned, 2 were evaluated and 1 challenger draft was written; **0 converged**. A root cause was ARIA-HIGH-194: the challenger's refusal message was cut off at 4,000 characters, so it was lost.
- **Status:** LIVE (no plan has converged)
- **Source:** `git show origin/aria/state:tools/plans/events.jsonl` (30 rows, `Counter(event)`). The agents are `.claude/agents/aria-{primary-planner,challenger-planner,cross-reviewer,primary-drafter,challenger-drafter}.md`. See also `aria-kernel/aria_kernel/plan_convergence.py`.
- **Plain-language explanation:** ARIA's rule that a plan must survive cross-examination before work starts has, so far, stopped every plan.

### D.5 Implementation

**E-046**

- **Statement:** The implementation path exists in code:
  - an implementer agent (`.claude/agents/aria-implementer.md`);
  - a write-containment sandbox (`bwrap`), which is required (`tools/aria-poc/claude_runtime.py:806-812`);
  - an apply engine and baseline validation (`apply_engine.py`, `validation.py`);
  - an 18-check pre-PR hard-fail gate (`implementation_safety.py:2860`);
  - a change ledger (planned → committed → validated → outcome).

  Live, the change ledger has **2 planned, 0 committed, 0 validated and 0 outcome** rows.

- **Status:** BUILT
- **Source:** State-surface sweep: `change-ledger/planned.jsonl` 2 (F-009, F-010), `committed/validated/outcome.jsonl` 0. The `HARD_FAIL_CHECKS` tuple has 18 entries (Python count).
- **Plain-language explanation:** ARIA can write code in a sealed box and test it, but it has not yet done so for real.

**E-047**

- **Statement:** The read-only sandbox is live for judges. 261 judge and arbiter sessions were spawned under read containment, with the `Read` tool only, between 2026-09-21 and 2026-09-26.
- **Status:** LIVE
- **Source:** `tools/governance.jsonl` kind `claude_spawn_read_contained` = 261 (first 2026-09-21T00:57:47Z, last 2026-09-26T01:46:10Z). It is emitted at `tools/aria-poc/ci_executor.py:2068`.
- **Plain-language explanation:** When ARIA's AI judges read the code, they run in a locked room where they can only look, not touch.

**E-048**

- **Statement:** ARIA's commits are designed to be signed with a per-cycle SSH key. The key stays in an ssh-agent outside the sandbox, so the agent can sign but never read the key. No ARIA-signed code commit exists yet.
- **Status:** BUILT
- **Source:** `aria-kernel/aria_kernel/signing_agent.py:1-40`; `gh_token_factory.mint_signing_key`; `change_committed` has 0 rows (E-046).
- **Plain-language explanation:** Every change ARIA makes will carry its own tamper-proof signature. None has been made yet.

### D.6 Merge authority

**E-049**

- **Statement:** Every changed path is classified into a risk lane:
  - **L1 "docs/tests low risk":** `docs/**`, `tests/**`, `*.spec.*`, `test_*.py`, …
  - **L2 "runtime behaviour, supervised":** `apps/**/src/**`, `web/**/src/**`, …
  - **L3 "control plane / policy":** `.github/**`, `aria-kernel/**`, `.claude/**`, …

  Only L1 is a candidate for ARIA's own merge (ADR-041, 2026-07-02, "activation gated on the autonomy-unlock ladder").

- **Status:** BUILT
- **Source:** `docs/aria/policy/risk-policy.json` (`lanes.L1/L2/L3`); `docs/adr/041-aria-narrow-autonomous-merge-lane.md:1-8`.
- **Plain-language explanation:** ARIA would only be allowed to merge the safest kind of change by itself, such as documentation and tests.

**E-050**

- **Statement:** ARIA has never merged anything:
  - its PR and merge ledgers are empty (`pr-actions`, `pr-lifecycle` and `merge-events` all 0 rows);
  - every enterprise readiness, attestation, freeze and self-revert ledger is empty;
  - all 403 autonomy-state rows are in the `standard` profile, with a total merges delta of 0;
  - the 8 auto-merge decisions it recorded are all `blocked`.

  Those 8 decisions were dry-run evaluations of other authors' PRs: #1266, #1273, #1282 and #1335 (the last is the bot's sweep PR), each evaluated twice.

- **Status:** BUILT (not live)
- **Source:** State-surface sweep (`pr-actions.jsonl`, `pr-lifecycle.jsonl`, `merge-events.jsonl`, `enterprise/*.jsonl` all 0). `tools/autonomy_state.jsonl` (`Counter(profile)` = standard 403). `tools/auto-merge-decisions.jsonl` (8, `decision: blocked`, reasons such as "branch protection lookup failed", "review state unreadable").
- **Plain-language explanation:** ARIA's power to merge has never been switched on.

**E-051**

- **Statement:** The final code pieces of the self-merge chain reached `main` on 2026-09-26 through PR #1673 ("change_validated producer, attestable merge lane, self-revert + freeze"):
  - `merge_authority.py::merge_pr_if_ready`;
  - `runner_attestation.py`;
  - `readiness_proofs.py`;
  - `self_revert.py`: ARIA reverts its own bad merge;
  - `self_merge_freeze.py`: after a revert, self-merge freezes until a human unfreezes it;
  - `.github/workflows/aria-merge-runner.yml`.

  The auto-merge master switch now reads an operator-controlled profile gate (`f2911874`).

- **Status:** BUILT
- **Source:** The GitHub search result for PR #1673 has closed_at 2026-09-26T04:36:25Z. The merge commit f152a7c6 is on main. `ls aria-kernel/aria_kernel | grep -E 'self_revert|self_merge_freeze|merge_authority|runner_attestation'` finds all four. `git merge-base --is-ancestor f2911874 origin/main` returns true.
- **Plain-language explanation:** The safety net exists in code: if ARIA ever merged a bad change, it would undo it and lock itself.

**E-052**

- **Statement:** The merge lane still cannot complete. Four read-only reviews on 2026-09-26 filed 28 findings, all OPEN: 9 HIGH (plan 036: ARIA-HIGH-205…213) plus 3 CRITICAL, 7 HIGH and 9 MEDIUM (plan 037: ARIA-CRITICAL-214…216, HIGH-217…223, MEDIUM-224…232). Examples:
  - "a rename is classified by its new path only";
  - "L1 contains the repository's CI gate suites";
  - "operator approval references prove no operator act".

  The review states there are "five independent defects each stop[ping] every merge attempt". Plans 036/037 and these findings exist **only on local branches** (`plan036`, `plan037-G/L/M/O/U`), not on `main`. The operator steps still to do:
  1. add a second CODEOWNERS owner;
  2. bring the self-hosted runner online;
  3. fix the GitHub App permissions;
  4. measure branch protection, then require a merge queue, signed commits and `bypass_actors: []`;
  5. finish 30 observe-mode burn-in successes;
  6. promote an adapter to ACTIVE (at least 5 SHADOW runs and 5 anchor judgments, precision ≥ 0.85);
  7. set the profile;
  8. issue an L1 merge-lane grant with an expiry;
  9. move `ARIA_GH_TOKEN` to a separate machine account.

- **Status:** PLANNED
- **Source:**
  - `git show plan037-U:docs/aria/plans/036-chain-gaps.md` (steps 0–9) and `git show plan037-U:docs/aria/plans/037-merge-lane-review.md` (operator steps).
  - `git show plan037-U:docs/reviews/_registry/findings.jsonl`: 28 rows in those ID ranges, all `OPEN`. The same ID query against the `main` registry returns 0.
  - `git show plan037-U:docs/reviews/claude/2026-09-26-aria-merge-lane-review.md:1-12`.
- **Plain-language explanation:** Before ARIA can merge anything itself, about 30 known defects must be fixed and about 9 manual setup steps completed.

**E-053**

- **Statement:** ARIA plugs into existing AI coding tools through an MCP server with 11 read tools and 2 write tools. It is registered for Claude Code in the repository's `.mcp.json`, and 8 live calls are recorded (2026-09-20/21: `findings_query`, `search`, `progress_tail`).
- **Status:** LIVE (light use)
- **Source:**
  - `aria-kernel/aria_kernel/mcp_server.py:20-28`. The read tools are `aria_status`, `missions_list`, `findings_query`, `pressure_top`, `governance_tail`, `handoff_read`, `daily_report`, `search`, `delivery_status`, `progress_tail` and `plan_verify`; the write tools are `human_required_resolve` and `runtime_signal_ingest`.
  - `.mcp.json` (the `aria` server).
  - `git show origin/aria/state:tools/mcp/tool-calls.jsonl` (8 rows).
- **Plain-language explanation:** A developer's AI assistant can already ask ARIA "what do we know about this?" through a standard plug.

**E-054**

- **Statement:** ARIA's search is keyword-based (SQLite FTS5 with BM25 ranking over its ledgers). An embedding-based "semantic memory" hook exists but does nothing unless an operator configures an embedder (`ARIA_EMBEDDER_CMD`), and none is configured live: 0 embedding rows.
- **Status:** BUILT (lexical search); PLANNED (semantic, needs a model)
- **Source:** `aria-kernel/aria_kernel/search.py:1-14,59,120-121`; `semantic_memory.py:1-22`; `knowledge-graph/embeddings.jsonl` = 0 rows on aria/state.
- **Plain-language explanation:** ARIA finds past decisions by keywords today, not by meaning.

**E-055**

- **Statement:** ARIA published 15 daily reports between 2026-08-05 and 2026-09-21. They cover gate activity, open escalations with SLA breaches, and lapsed finding deadlines.
- **Status:** LIVE (stopped with the nightly cycle on 2026-09-21)
- **Source:** `git ls-tree origin/aria/state tools/reports/daily/` (15 files); `tools/reports/daily/2026-09-21.md:1-30`.
- **Plain-language explanation:** ARIA wrote a daily status note for the operator.

**E-056**

- **Statement:** ARIA's own documents are candid about the gaps. The dated self-assessment (2026-08-20) says that "autonomous merge is structurally unreachable", that "no adapter has ever reached ACTIVE", and that "132 of 205 declared durable state surfaces have never been written once" (a [reported] claim). The full 2026-09-25 read found "0 CONVERGED" plans and "8/8 merge blocked".
- **Status:** HISTORY
- **Source:** `docs/aria/BEHAVIOUR.md:1-10,99-118`; `docs/aria/reviews/2026-09-25-aria-dokuman-kod-karsilastirmasi.md:29-70`.
- **Plain-language explanation:** The project documents what ARIA cannot yet do, and those write-ups are part of the evidence trail.

---

## E. Honest status of "writes code and merges it"

**E-057**

- **Statement:** As of aria/state @ 30a5e5e1 (2026-09-26), **ARIA's own runtime has opened 0 pull requests, committed 0 changes and merged 0**. The nightly cycle has been failing since 2026-09-21. The only PRs under ARIA's GitHub App name are 36 registry-bookkeeping PRs, which a human merged (E-019).
- **Status:** BUILT (the merge path is not live)
- **Source:** E-046, E-050, E-019, E-030.
- **Plain-language explanation:** Today ARIA watches, proves and judges. It does not yet write or merge code by itself.

**E-058**

- **Statement:** Separately, AI coding agents do write and merge code into this platform under the governance system:
  - at least 1,703 commits carry a Claude marker, and 1,145 are authored by Claude (E-012, E-013);
  - at least 203 merged PRs contain such work (E-017);
  - every fix must cite a registered finding through a validated `Closes:` trailer (E-023);
  - banned-phrase and banned-construct gates run on every PR (E-024).

  Merges into `main` are performed by the human operator. For example, plan 034, whose final pieces landed as PR #1673, says of its 14 PRs "hepsi insan incelemeli ve insan merge'lüdür", meaning "all human-reviewed and human-merged" (`docs/aria/plans/034-e2e-chain-closure.md:47`).

- **Status:** HISTORY
- **Source:** E-012 through E-024.
- **Plain-language explanation:** AI agents write most of the recent code, a rulebook plus automatic gates police them, and a human presses "merge".

**What remains before "ARIA writes and merges code" is true:**

- the 28 OPEN plan 036/037 findings, 3 of them CRITICAL (E-052);
- the operator steps listed in E-052;
- a green nightly cycle;
- 30 observe-mode burn-in successes;
- one adapter promoted to ACTIVE;
- the first plan to converge;
- the first entries in `change_committed`, `change_validated` and `merge_events`.

**Suggested phrasings that are strong but true:**

1. "Our 2.2-million-line aquaculture platform was built with AI coding agents working under a governance system we designed. At least 1,700 commits and 200 merged pull requests carry the agent's signature, and every fix is tied to a logged, tamper-evident finding before a human merges it."
2. "ARIA is the kernel that grew out of that system. It has run on our own codebase since August 2026, with AI judges from two vendors, and it has recorded 88,890 hash-chained entries that anyone can re-verify. The path to writing and merging code itself is built and tested (about 7,000 tests) and is being switched on in a narrow, reversible lane for docs and tests."
3. "ARIA doesn't trust an AI's 'done'. It rejects any agent answer whose file-and-line evidence doesn't match the committed code, and it has done so on real runs."

**Do NOT say:**

- "ARIA writes code and merges it". This is false today (E-057).
- "ARIA learns from outcomes". The outcome ledger is empty (E-033).
- "ARIA runs with a local model". No local runtime exists (J-3).

---

## F. What ARIA does that a plain retrieval pipeline (embed → retrieve → generate) does not do by itself

**E-059**

- **Statement:** ARIA grades every evidence reference against the committed git tree at a pinned commit. It hashes the blob from `git show <sha>:<path>` and compares it with the recorded `content_hash`. A reference that does not match is `missing` or `worktree_candidate`, never `repo_verified`. A retrieval pipeline alone returns text and does not check it against a versioned source of truth.
- **Status:** LIVE
- **Source:** `aria-kernel/aria_kernel/evidence_trust.py:96-233` (`classify_evidence_ref`) and `:306-332` (`_git_blob_matches`). In use: E-041, where 24 results were rejected, and E-042.
- **Plain-language explanation:** ARIA checks that a quoted line really exists, in exactly that version of the code.

**E-060**

- **Statement:** ARIA never lets its own output count as evidence. References under prefixes such as `aria-findings/`, `aria-tools/` or `agent-workspace/` are classified as self-output. A retrieval pipeline alone can re-index and re-retrieve what its own model wrote.
- **Status:** LIVE
- **Source:** `evidence_trust.py:15-25` (`SELF_OUTPUT_PREFIXES`). Live: 2 rejected results cited self-output (E-041). Also `docs/aria/SPEC.md` L1, "self-output never enters as evidence".
- **Plain-language explanation:** ARIA cannot convince itself by quoting itself.

**E-061**

- **Statement:** ARIA stores knowledge in hash-chained, append-only ledgers, where each row's hash covers the previous row's hash, and every live ledger verifies (E-031). A vector index alone is mutable and is not tamper-evident.
- **Status:** LIVE
- **Source:** `aria-kernel/aria_kernel/ledger.py:1241-1246` (`_record_hash`) and `:1280-1299` (append); my verification in E-031.
- **Plain-language explanation:** You can prove that nobody quietly edited ARIA's memory.

**E-062**

- **Statement:** ARIA requires independent multi-judge consensus before a finding becomes canonical: a weighted majority with average confidence ≥ 0.80, a check against copy-cat judges, and escalation when judges disagree. A retrieval pipeline alone has one generator and no adjudication step.
- **Status:** LIVE (consensus promoted F-009…F-013; the hard-case panels are broken, E-043)
- **Source:** `feedback_store.py:82,825`; `independence_check.py:21-24`; E-039, E-042.
- **Plain-language explanation:** Several AI judges have to agree before ARIA accepts a finding.

**E-063**

- **Statement:** ARIA's beliefs are stateful and can decay: `supported` → `needs_revalidation` → `stale`, triggered by evidence diffs, a 90-day age limit or head distance. A retrieval pipeline alone silently returns stale chunks.
- **Status:** LIVE (small scale, E-032); the decay logic is BUILT (E-034)
- **Source:** `memory.py:22,756-990`.
- **Plain-language explanation:** ARIA forgets or re-checks what might be out of date.

**E-064**

- **Statement:** ARIA refuses to act without evidence. Mission rule M-6.4 says "No evidence, no claim: an unverifiable assertion MUST NOT enter the evidence channel". In the orchestrator, requests are minted against the workspace HEAD SHA so that evidence can be graded.
- **Status:** LIVE
- **Source:** `docs/aria/MISSION_SPEC.md:223-225`; `aria-kernel/aria_kernel/autonomy_orchestrator.py:201-219`; E-041.
- **Plain-language explanation:** "Show me the line or it didn't happen" is a hard rule.

**E-065**

- **Statement:** ARIA scopes memory to the code's commit. Each belief records `base_commit_sha` and `repo_state_id`, and discovery reads a committed snapshot rather than the working files. A retrieval pipeline alone has no notion of which code version a chunk describes.
- **Status:** LIVE
- **Source:** `memory.py:65,104-105,562`; `docs/aria/CURRENT_STATE.md` "Committed Snapshot Increment"; the belief rows on aria/state carry `base_commit_sha` (E-032).
- **Plain-language explanation:** ARIA knows which version of the code each fact was about.

**E-066**

- **Statement:** A retrieval pipeline is better at semantic search over large or unstructured corpora. ARIA's search is lexical today (FTS5/BM25), and embedding ranking needs an operator-supplied model that is not configured live (E-054). ARIA's evidence grammar also assumes files under git version control with `path:line` references. Plain-text corpora outside git, such as email or scanned documents, are not in reach today. And ARIA's own mechanical seed path turned Jaccard-similar enum names into findings without an LLM judge (F-001…F-008), a "similarity instead of evidence" risk that its own review names.
- **Status:** BUILT
- **Source:** `search.py:1-14`; `semantic_memory.py:1-22`; `docs/aria/reviews/2026-09-25-aria-dokuman-kod-karsilastirmasi.md` §7 (the row on similarity measures and the closing sentence).
- **Plain-language explanation:** A retrieval pipeline is better at finding "things that mean the same"; ARIA is better at proving "this exact thing is true".

---

## G. Existing investor documents: claim audit

### G.1 The old investor-pitch document in `docs/pitch/` (Turkish; last touched 2026-08-01)

| #   | Claim (translated)                                                                                                                    | Verdict              | Evidence                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | IoT-in-agriculture market $17.8B (2025) → $37.4B (2030); vertical farming $9.6B → $107B; RAS $5.4B → $11.6B; agri SaaS $2.6B → $12.3B | UNVERIFIED           | External figures with sources listed at lines 616-627; not checkable from the repo                                                                                                                                                      |
| 2   | ">52% of new RAS installations use IoT water-quality monitoring (2023)"                                                               | UNVERIFIED           | External                                                                                                                                                                                                                                |
| 3   | Microservice, modular, sector-agnostic architecture                                                                                   | VERIFIED             | E-001, E-002                                                                                                                                                                                                                            |
| 4   | Multi-tenancy through PostgreSQL schema isolation                                                                                     | VERIFIED             | CLAUDE.md:6 (per-tenant `tenant_<uuid>` search_path); `libs/backend-common/src/database/schema-manager.service.ts`                                                                                                                      |
| 5   | IoT: VFD, PLC, edge device, MQTT, OPC-UA, Modbus                                                                                      | VERIFIED             | `apps/sensor-service/src/protocol/adapters/protocol-implementation-status.ts:49-60`: MODBUS_TCP/RTU/ASCII, OPC_UA, SIEMENS_S7 and MQTT are `CLOUD_REAL`. 39 adapters in total: 12 cloud-real, 3 edge-delegated, 24 unsupported (hidden) |
| 6   | Offline-first PWA with an IndexedDB queue                                                                                             | VERIFIED             | `web/apps/aquamobil/src/pwa/offline-queue.ts` (IDB); `idb-keyval` dependency                                                                                                                                                            |
| 7   | Visual workflow editor                                                                                                                | VERIFIED (BUILT)     | `web/modules/sensor-module/src/components/process-editor/**`; `web/modules/sensor-module/src/pages/automation`                                                                                                                          |
| 8   | Stack: React 18                                                                                                                       | FALSE (outdated)     | Root `package.json` has react 19.2.7                                                                                                                                                                                                    |
| 9   | NestJS + GraphQL Federation; Apollo Server 4                                                                                          | PARTIAL              | NestJS 11 and Apollo Federation are verified; `@apollo/server` is ^5.5.1, not 4                                                                                                                                                         |
| 10  | CQRS/Event Sourcing                                                                                                                   | VERIFIED (BUILT)     | `platform/libs/cqrs`; `apps/event-store-service`                                                                                                                                                                                        |
| 11  | PostgreSQL 16, TimescaleDB, Redis 7, NATS JetStream, MinIO                                                                            | VERIFIED             | Compose images `timescale/timescaledb-ha:pg16`, `redis:7-alpine`, `nats:2.10-alpine`, `minio/minio`; JetStream referenced in `platform/libs/event-bus/src/interfaces/*`                                                                 |
| 12  | Docker + K8s                                                                                                                          | PARTIAL              | Helm charts exist (`infrastructure/helm/aquaculture/Chart.yaml`, `infra/helm/charts/*`); the production target per CLAUDE.md is `docker-compose.droplet.yml`                                                                            |
| 13  | shadcn/ui + Tailwind, TanStack Query + Zustand, Recharts + Leaflet, OpenTelemetry                                                     | VERIFIED             | `tailwindcss`, `@tanstack/react-query`, `zustand`, `recharts` and `react-leaflet` in web `package.json` files; 63 imports from `@/components/ui`; `@opentelemetry/sdk-node`                                                             |
| 14  | "13 independent services"                                                                                                             | FALSE (outdated)     | There are now 17 (E-001)                                                                                                                                                                                                                |
| 15  | `public` schema holds users, tenants, sessions                                                                                        | FALSE                | CLAUDE.md:109 says "Never add new tables to `public`" and CLAUDE.md:147 puts the tenant record in `auth.tenants`                                                                                                                        |
| 16  | Tenant data is "cryptographically separated"                                                                                          | FALSE (wording)      | Isolation is by schema plus RLS, not cryptography (CLAUDE.md:6; ADR-011). Some columns are encrypted (ADR-023), but the separation itself is not cryptographic                                                                          |
| 17  | 8 VFD brands (ABB, Danfoss, Delta, Mitsubishi, Rockwell, Schneider, Siemens, Yaskawa)                                                 | VERIFIED (BUILT)     | `apps/sensor-service/src/vfd/brand-configs/{abb,danfoss,delta,mitsubishi,rockwell,schneider,siemens,yaskawa}.config.ts`                                                                                                                 |
| 18  | PLC: Siemens S7, Modbus, OPC-UA; alarm monitoring                                                                                     | VERIFIED (BUILT)     | Row 5; `apps/sensor-service/src/plc-control`                                                                                                                                                                                            |
| 19  | Edge self-registration and tenant provisioning keys                                                                                   | VERIFIED (BUILT)     | `apps/sensor-service/src/registration`; `apps/sensor-service/src/edge-device/tenant-key.service.ts`, `dto/provisioning.dto.ts`                                                                                                          |
| 20  | Sensor types: temperature, pH, DO, conductivity, ammonia, …                                                                           | VERIFIED (BUILT)     | `apps/sensor-service/src/sensor-type`                                                                                                                                                                                                   |
| 21  | Edge deploy; programs keep running offline                                                                                            | PARTIAL              | `apps/sensor-service/src/{deploy-artifact,release-bundle,scada-runtime}`; `sens-api-gateway` runtime (ADR-017). The offline behaviour itself is not verified here                                                                       |
| 22  | TimescaleDB hypertables; continuous aggregates at 1 min, 5 min, 1 h and 1 day; retention                                              | PARTIAL              | 4 migrations call `create_hypertable`, there are 7 retention policies and 6 continuous views. The views are readings 15 min/1 h/1 d and metrics 1 min/1 h/1 d; there is **no 5 min** view                                               |
| 23  | Sensor entities are industry-neutral                                                                                                  | VERIFIED (design)    | The listed entity names exist in `apps/sensor-service/src/**/entities`                                                                                                                                                                  |
| 24  | Batch lifecycle, tank/cage management, mortality cause analysis, growth, FCR                                                          | VERIFIED (BUILT)     | farm-service domains `batch`, `tank`, `growth`, `harvest`; `MortalityCause` enum with 13 values at `apps/farm-service/src/batch/entities/mortality-record.entity.ts:44`                                                                 |
| 25  | Automatic daily feeding plans; planned vs actual                                                                                      | VERIFIED (BUILT)     | `apps/farm-service/src/feeding-protocol/services/{meal-plan-generator,day-plan-recalc}.service.ts`; `feeding.resolver.ts:757-758,950` (variancePercent)                                                                                 |
| 26  | Colour bands ±5% / ±15% / >15%                                                                                                        | UNVERIFIED           | No threshold constants found by grep                                                                                                                                                                                                    |
| 27  | Feed stock forecast and reorder point                                                                                                 | PARTIAL              | Reorder and days-of-stock terms appear in 29 farm-service files; the behaviour was not traced                                                                                                                                           |
| 28  | Equipment hierarchy, feeder calibration, maintenance work orders, planned maintenance                                                 | VERIFIED (BUILT)     | farm-service `equipment`, `maintenance` (`create-maintenance-schedule.dto.ts`, `create-work-order.dto.ts`)                                                                                                                              |
| 29  | Water chemistry with Millero equations and Deffeyes diagram; dosing recipes                                                           | VERIFIED (BUILT)     | `libs/aquaculture-engines/src/water-chemistry/{ammonia-calc,co2-calc,water-quality,deffeyes-data,reagents}.ts`; `web/shared-ui/src/water-chemistry/components/DeffeyesChart.tsx`                                                        |
| 30  | MET Norway weather, Copernicus Marine, CDSE Sentinel-2                                                                                | VERIFIED (BUILT)     | 8 / 17 / 26 matching files; `apps/farm-service/src/{weather,marine-data,sentinel-hub}`                                                                                                                                                  |
| 31  | Maskinporten integration                                                                                                              | VERIFIED (BUILT)     | 16 files match `maskinporten` in apps                                                                                                                                                                                                   |
| 32  | Production reports (biomass, disease, mortality, sea lice, welfare), audit trail                                                      | PARTIAL              | `apps/farm-service/src/regulatory`; aquamobil pages `lice`, `welfare`; audit-log service. The report contents were not checked                                                                                                          |
| 33  | Inventory locations, purchase orders, consumables                                                                                     | VERIFIED (BUILT)     | farm-service `storage`, `supplier`, `consumable`                                                                                                                                                                                        |
| 34  | Hydroponics: 8-tab calculator, 9 species, 24+ profiles, 3 seasons                                                                     | PARTIAL              | 8 `*Tab.tsx` files and 9 species names in `web/modules/hydroponics-module`. "24+ profiles" was not counted. The **backend is a scaffold**: `apps/hydroponics-service` has 16 TS files, 2 entities and 3 queries / 3 mutations           |
| 35  | Hydroponics is a separate service on the same auth and tenancy                                                                        | VERIFIED             | `apps/hydroponics-service`; web module federated                                                                                                                                                                                        |
| 36  | AquaMobil operations: feeding, mortality, cull, harvest, shift calendar, sync status                                                  | VERIFIED (BUILT)     | `web/apps/aquamobil/src/pages/{feeding,mortality,cull,harvest,schedule,sync,...}`                                                                                                                                                       |
| 37  | Mobile retry "max 3 attempts"                                                                                                         | FALSE (detail)       | `offline-queue.ts:856` has `MAX_RETRY_COUNT = 5`                                                                                                                                                                                        |
| 38  | Mortality "8 categories"                                                                                                              | FALSE (outdated)     | The enum has 13 values (`mortality-record.entity.ts:44`)                                                                                                                                                                                |
| 39  | Feature gating per user by the tenant admin                                                                                           | UNVERIFIED           | Not traced                                                                                                                                                                                                                              |
| 40  | Billing: module-based subscriptions                                                                                                   | VERIFIED (BUILT)     | `apps/billing-service` (21 entities; Stripe SDK, ADR-016)                                                                                                                                                                               |
| 41  | Price points $99 / $299 / $799                                                                                                        | UNVERIFIED           | Marked as "example price" in the document                                                                                                                                                                                               |
| 42  | "Production ready" for multi-tenant, federation, sensors, automation, alerts, PWA, HR, billing, GDPR and CI/CD                        | UNVERIFIED           | The code exists (BUILT). There is no evidence in the repository of production customers or load. "Scales to thousands of tenants" is unmeasured                                                                                         |
| 43  | GDPR: deletion, anonymisation, export                                                                                                 | PARTIAL              | GDPR code in messaging-service (21 files) and admin-api (20); coverage across services was not verified                                                                                                                                 |
| 44  | Code stats: 13 backend services / 7 front-end modules + shell / 8 shared libraries                                                    | FALSE (outdated)     | 17 / 8 + shell (+ AquaMobil) / 21 (E-001–E-003)                                                                                                                                                                                         |
| 45  | Farm tables 160+                                                                                                                      | FALSE                | 109 `@Entity` declarations and 110 distinct `CREATE TABLE` names in farm migrations (Python count)                                                                                                                                      |
| 46  | Sensor tables 50+, HR tables 30+                                                                                                      | VERIFIED             | Sensor: 53 entities / 62 tables. HR: 31 entities / 39 tables                                                                                                                                                                            |
| 47  | GraphQL types 1,000+                                                                                                                  | VERIFIED             | 771 `ObjectType` + 641 `InputType` + 324 `registerEnumType` = 1,736 (regex count over non-test `apps/` and `libs/`)                                                                                                                     |
| 48  | Roadmap: H1 2026 production launch; later poultry, CEA, dairy and beekeeping modules                                                  | UNVERIFIED / PLANNED | No poultry, dairy or beekeeping code exists. Launch status is unverified                                                                                                                                                                |
| 49  | "Each new sector reuses 70% of existing code"; "2+ year lead over competitors"                                                        | UNVERIFIED           | Opinion; not measurable from the repo                                                                                                                                                                                                   |
| 50  | Competitors (AKVA, InnovaSea, ThingsBoard, …) lack X                                                                                  | UNVERIFIED           | External                                                                                                                                                                                                                                |

**E-067**

- **Statement:** SECURITY: withheld from this public copy (security item 1 in the founders' private checklist).
- **Status:** HISTORY

### G.2 `docs/investor/mortality-prevention.{md,en.md,no.md}` (same content in 3 languages; 2026-05-04)

| #   | Claim                                                                                                                                               | Verdict           | Evidence                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Industry mortality 15–40% per year                                                                                                                  | UNVERIFIED        | External                                                                                                                                                                                                                                                                |
| 2   | Dosing engine computes NH₃, CO₂ and H₂S from temperature, pH, alkalinity, salinity and TAN                                                          | VERIFIED (BUILT)  | `libs/aquaculture-engines/src/water-chemistry/{ammonia-calc,co2-calc,water-quality}.ts` (H₂S present)                                                                                                                                                                   |
| 3   | Output is a concrete recipe ("12.4 kg sodium bicarbonate…")                                                                                         | VERIFIED (BUILT)  | `reagents.ts`; AI tools `apps/ai-service/src/tools/water-chemistry/get-reagent-list.tool.ts`                                                                                                                                                                            |
| 4   | Combined phase diagram on alkalinity–DIC axes with zones, target point and reagent vectors                                                          | VERIFIED (BUILT)  | `DeffeyesChart.tsx` (61 DIC and 42 vector/target references)                                                                                                                                                                                                            |
| 5   | Multiple reagent options with a risk score each                                                                                                     | PARTIAL           | `reagents.ts` has 0 matches for `risk`                                                                                                                                                                                                                                  |
| 6   | Step-wise recipe with re-measurement and recalculation                                                                                              | PARTIAL           | `reagents.ts` has 49 `step` references; the re-measurement loop was not traced                                                                                                                                                                                          |
| 7   | Equipment list per recipe; attribution of the equipment causing a deviation                                                                         | UNVERIFIED        | No `equipment` in `reagents.ts`; no attribution code found                                                                                                                                                                                                              |
| 8   | Sentinel-2/CDSE optical imagery with chlorophyll and algal indicators; CMEMS SST, salinity and currents                                             | VERIFIED (BUILT)  | `apps/farm-service/src/sentinel-hub/sentinel-product-registry.ts`; `marine-data/marine-layer-catalog.ts`                                                                                                                                                                |
| 9   | Algal bloom or temperature anomaly flagged 48–72 h ahead                                                                                            | UNVERIFIED        | No forecasting logic found                                                                                                                                                                                                                                              |
| 10  | Lot traceability; silo mixing marked "MIX-LOT1-LOT2"; two-hour trace-back                                                                           | PARTIAL           | `apps/farm-service/src/storage/entities/storage-lot-mix.entity.ts` exists; the two-hour trace was not verified                                                                                                                                                          |
| 11  | "In production": disease event log, treatment record, withdrawal-period tracking, harvest/transfer block for diseased tanks, environmental tracking | PARTIAL           | BUILT: `fish-health` domain; treatment-applications migration; harvest blocked by withdrawal at `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts:199`. The transfer block was not found. "In production" (deployed for customers) is UNVERIFIED |
| 12  | "In production": cross-domain correlation engine                                                                                                    | UNVERIFIED        | No correlation-engine code found (only `correlationId` in audit logs)                                                                                                                                                                                                   |
| 13  | Planned items (disease library, predictive warnings, …)                                                                                             | PLANNED           | Labelled as planned in the document                                                                                                                                                                                                                                     |
| 14  | Multi-site under one organisation with isolated data; consolidated dashboard; template propagation                                                  | PARTIAL           | Isolation is verified (G.1 #4). Consolidation and propagation were not traced                                                                                                                                                                                           |
| 15  | AI never computes numbers itself; deterministic tools (bisection, Millero)                                                                          | VERIFIED (design) | Bisection in `ammonia-calc.ts`, `deffeyes-data.ts` and `water-quality.ts`; 60 AI tool files in `apps/ai-service/src/tools/**`                                                                                                                                           |
| 16  | Push alerts within seconds                                                                                                                          | PARTIAL           | `apps/notification-service/src/notification/services/push.service.ts`. `firebase-admin` is an optional dependency that is not installed (`push.service.ts:7-11`); SMS appears only in migrations; e-mail exists (`email.service.ts`)                                    |
| 17  | 13 predefined mortality categories                                                                                                                  | VERIFIED          | `mortality-record.entity.ts:44` (13 values)                                                                                                                                                                                                                             |
| 18  | ±20% feeding deviation triggers an alert                                                                                                            | UNVERIFIED        | Variance is computed (G.1 #25); the ±20% alert was not found                                                                                                                                                                                                            |
| 19  | AI assistant in the field                                                                                                                           | PARTIAL           | `web/modules/messaging-module/src/pages/NewAiChatPage.tsx`; ai-service chat. Liveness was claimed in commit `43da9c22` ("Verified live E2E"), not verified independently                                                                                                |
| 20  | Work orders closed with photographic evidence                                                                                                       | PARTIAL           | `create-work-order.dto.ts:218` has `attachments?: string[]`                                                                                                                                                                                                             |
| 21  | Expired certifications block critical task assignment                                                                                               | UNVERIFIED        | Not found in `apps/farm-service/src/task`                                                                                                                                                                                                                               |
| 22  | Shift and escalation ladder                                                                                                                         | VERIFIED (BUILT)  | `apps/alert-engine/src/database/entities/escalation-policy.entity.ts:134`; hr `scheduling`                                                                                                                                                                              |
| 23  | Mechanism 12: stocking above biomass capacity is blocked                                                                                            | UNVERIFIED        | Capacity fields exist; the blocking rule was not found                                                                                                                                                                                                                  |
| 24  | Mechanism 13: aerators can be switched remotely                                                                                                     | PARTIAL           | Manual VFD commands exist (`vfd/dto/index.ts:37-43`). Automatic aerator actuation is "future work": `apps/sensor-service/src/feeding-window/feeding-window.handler.ts:13`                                                                                               |
| 25  | Mechanism 14: durable alert queue                                                                                                                   | VERIFIED (BUILT)  | `AlertOutboxModule` (`apps/alert-engine/src/app.module.ts:67`)                                                                                                                                                                                                          |
| 26  | Mechanism 34: 48-hour risk score for every tank                                                                                                     | PARTIAL           | A per-tank risk assessment exists (`apps/farm-service/src/ai-insights/services/ai-insights.service.ts:69-84`); the 48 h horizon was not found                                                                                                                           |
| 27  | Mechanism 33: anomaly detection                                                                                                                     | VERIFIED (BUILT)  | `ai-insights.types.ts:58-61` ("Detected anomaly")                                                                                                                                                                                                                       |
| 28  | Mechanism 21: morning farm-wide report                                                                                                              | UNVERIFIED        | Not found in ai-service. `FARM-AI-PROGRAM-2026-09-18.md` plans a "routine orchestrator"                                                                                                                                                                                 |
| 29  | Mechanisms 1–11 and 15–20 (continuous measurement, toxicity, reagent grams, safest option, …)                                                       | PARTIAL           | Covered by rows 2–6, 11 and 16–19 above; individual runtime behaviour was not traced                                                                                                                                                                                    |
| 30  | "Modules listed as 'In production' are operational today"                                                                                           | UNVERIFIED        | The repository shows the code, not customer operation                                                                                                                                                                                                                   |

---

## H. Aquaculture platform features: product surface or scaffold

Counts are from a Python pass over non-test `apps/<svc>/src/**/*.ts`: `@Entity(`, `@Resolver(`, `@Query((…`, `@Mutation(`, and `@Controller` + HTTP verbs.

**E-068**

- **Statement:** **Farm** is a real product surface:
  - backend: 109 entities, 51 GraphQL resolvers, 218 queries, 247 mutations and 46 domain folders (batch, tank, feeding, feeding-protocol, growth, harvest, fish-health, water-quality, storage, maintenance, equipment, finance, regulatory, species, weather, marine-data, sentinel-hub, supplier, task, …);
  - web: the farm-module has 16 page groups, 158 TSX files and 98,226 lines.
- **Status:** BUILT
- **Source:** `ls apps/farm-service/src`; per-service count (farm-service: ts_files 1302, entities 109, resolvers 51, gql_q 218, gql_m 247); `ls web/modules/farm-module/src/pages`.
- **Plain-language explanation:** The farm-management part is large and complete in code.

**E-069**

- **Statement:** **Sensors and edge** are a real product surface:
  - sensor-service: 53 entities, 19 resolvers, 123 queries and 165 mutations;
  - 12 protocols with real cloud-side I/O, 3 delegated to the edge, and 24 unsupported protocols honestly hidden;
  - 8 VFD brands;
  - web: the sensor-module has 406 TSX files and 158,442 lines (SCADA, process editor, VFD programming, calibration, …);
  - the Rust edge gateway is 185,945 lines.
- **Status:** BUILT
- **Source:** Per-service count; `protocol-implementation-status.ts` (12/3/24); `ls web/modules/sensor-module/src/pages`; Rust LOC for `sens-api-gateway`.
- **Plain-language explanation:** Connecting real farm equipment is the platform's deepest area.

**E-070**

- **Statement:** **Feeding** is a real surface: day plans, a meal-plan generator, recalculation, planned-vs-actual variance, a feeding ledger, and an oxygen-gated "feeding window" readiness event. Automatic actuation of aerators or VFDs from that event is explicitly future work.
- **Status:** BUILT
- **Source:** `apps/farm-service/src/feeding-protocol/services/*`; `feeding/services/feeding-ledger.service.ts:185`; `apps/sensor-service/src/feeding-window/feeding-window.handler.ts:8-14`.
- **Plain-language explanation:** The system plans and tracks feeding. It warns but does not yet switch equipment on its own.

**E-071**

- **Statement:** **Water quality and chemistry** is a real surface:
  - a deterministic chemistry engine (Millero constants, bisection, NH₃/CO₂/H₂S, Deffeyes data, reagents);
  - a Deffeyes chart UI;
  - water-quality measurement entities;
  - AquaMobil water-quality pages.
- **Status:** BUILT
- **Source:** `libs/aquaculture-engines/src/water-chemistry/*`; `web/shared-ui/src/water-chemistry/components/DeffeyesChart.tsx`; `apps/farm-service/src/water-quality/entities/water-quality-measurement.entity.ts`; `web/apps/aquamobil/src/pages/water-quality`.
- **Plain-language explanation:** The water-chemistry calculator is real, scientific code, not a chatbot guess.

**E-072**

- **Statement:** **Mortality** is a real surface: a mortality record with a 13-value cause enum, the mobile mortality, cull, escape, welfare and lice pages, and fish-health events that block harvest during a withdrawal period.
- **Status:** BUILT
- **Source:** `apps/farm-service/src/batch/entities/mortality-record.entity.ts:44`; `web/apps/aquamobil/src/pages/{mortality,cull,escape,welfare,lice}`; `create-harvest-record.handler.ts:199`.
- **Plain-language explanation:** Fish deaths are recorded in a structured way, and fish under medication cannot be harvested.

**E-073**

- **Statement:** **HR** is a real surface: 31 entities, 8 resolvers, 87 queries and 82 mutations (attendance, leave, payroll/finance, performance, scheduling, training); web hr-module with 16 page groups and 23,863 lines.
- **Status:** BUILT
- **Source:** Per-service count; `ls apps/hr-service/src`; `ls web/modules/hr-module/src/pages`.
- **Plain-language explanation:** Staff, shifts, leave and training are managed in the same product.

**E-074**

- **Statement:** **Messaging** is a smaller real surface: 17 entities, 5 resolvers, 19 queries and 24 mutations (channels, messages, GDPR, presence, AI bridge); web messaging-module with 3 pages and 2,935 lines.
- **Status:** BUILT
- **Source:** Per-service count; `ls apps/messaging-service/src`; `ls web/modules/messaging-module/src/pages`.
- **Plain-language explanation:** Farm teams can chat, including with the AI assistant.

**E-075**

- **Statement:** The **AI assistant** has a thin API (6 entities, 2 queries, 1 mutation) and 60 tool files: farm data, production, water-health, water chemistry and aquaculture math. It runs chat over NATS on Z.ai GLM-5.3. The repository's own program document says the assistant is live ("Canlıda çalışan: Z.ai glm-5.3 … gerçek araç çağrıları", meaning: running live, Z.ai GLM-5.3, real tool calls), and commit `43da9c22` says "Verified live E2E". Neither claim was independently verified here.
- **Status:** BUILT (the live claim is UNVERIFIED)
- **Source:** `find apps/ai-service/src/tools -name '*.tool.ts' | wc -l` = 60; `FARM-AI-PROGRAM-2026-09-18.md:8`; `git log -1 43da9c22`.
- **Plain-language explanation:** An AI assistant that answers from real farm data and calculators exists, and the team reports it working live.

**E-076**

- **Statement:** **Hydroponics** is mostly a front-end calculator on a **backend scaffold**. The UI has 8 calculator tabs, 9 crops and a PID simulator. The service has only `setup`, `health` and `outbox` modules: 2 entities, 3 queries and 3 mutations.
- **Status:** BUILT (UI); scaffold (backend)
- **Source:** `ls apps/hydroponics-service/src`; the per-service count; `find web/modules/hydroponics-module/src -name '*Tab.tsx'` (8).
- **Plain-language explanation:** Hydroponics is a proof that the platform can extend to another sector, not yet a full product.

**E-077**

- **Statement:** No evidence in the repository shows a paying customer, a named pilot farm, or production traffic. There is a production-droplet deployment definition and commit messages that report live verification.
- **Status:** UNVERIFIED
- **Source:** `grep -rliE 'pilot (customer|farm|site)|first customer|paying customer' docs` returns only planning and investor docs. `docker-compose.droplet.yml` exists. See E-075.
- **Plain-language explanation:** Whether a real farm uses it today cannot be proven from the code. Ask the founder for a customer reference.

---

## I. Sector plug-in potential

**E-078**

- **Statement:** The domain-agnostic kernel pieces are the hash-chained ledger, evidence grading against a git commit, beliefs with decay, multi-judge consensus and independence checks, plan convergence, the tool lifecycle (DRAFT → SANDBOX → SHADOW → ACTIVE / CALIBRATE → QUARANTINED / ARCHIVED, where promotion requires precision, valid evidence chains and operator approval), agent roles, MCP and search.
- **Status:** BUILT
- **Source:** `ledger.py`, `evidence_trust.py`, `memory.py`, `feedback_store.py`, `independence_check.py`, `plan_convergence.py`, `tool_registry.py:31-47` (lifecycle; "only path to ACTIVE is transition_tool() which enforces precision + evidence_chains_valid + operator_approval"), `agent_surface.py`, `mcp_server.py`, `search.py`.
- **Plain-language explanation:** ARIA's core (memory, proof, judging, planning) is not about fish.

**E-079**

- **Statement:** The plug-in point is the adapter. An adapter is a manifest (`*.tool.json`) plus a program started as a subprocess, which reads JSON on stdin and writes observations and findings on stdout. The manifest declares `declared_scope`, `allowed_read_globs`, `forbidden_read_globs`, `claim_types`, a fixture set and health thresholds. A new domain means new adapters, not a new kernel.
- **Status:** BUILT
- **Source:** `tools/aria-adapters/doc-staleness-adapter.tool.json` (full manifest); `tool_registry.py:47-48` (`RUNNER_TYPES = ("subprocess",)`).
- **Plain-language explanation:** New industries plug in as new "eyes" for ARIA.

**E-080**

- **Statement:** Today's adapters are all code- and repository-specific: tenant-scoping, typeorm-entity-schema, event-contracts, fe-dto-parity, bundle-budget, kernel-dead-wire, security-boundary, test-gap, doc-staleness, lint-rules and agent-harness-security. No adapter reads aquaculture operating data or non-code business documents.
- **Status:** BUILT
- **Source:** `ls tools/aria-adapters/*.tool.json` (11 manifests).
- **Plain-language explanation:** Every current plug-in inspects software, not farms or legal files.

**E-081**

- **Statement:** The kernel is mostly free of aquaculture specifics. 19 of its 310 modules mention farm or aquaculture terms, mostly in comments and examples. There is some hard coding, such as the service list at `cycle.py:2226` (`"auth-service", "billing-service", "farm-service", "sensor-service"`). Coupling to software delivery is stronger: 71 modules mention GitHub or pull requests, 8 mention `nx`, and 6 mention TypeORM.
- **Status:** BUILT
- **Source:** `grep -liE 'aquacultur|farm-service|\bfish\b|feeding|mortality' aria-kernel/aria_kernel/*.py | wc -l` = 19 of 310; `grep -liE 'github|pull request|pull_request'` = 71; `aria-kernel/aria_kernel/cycle.py:2226-2227`.
- **Plain-language explanation:** ARIA is tied to git and GitHub, not to fish. A sector plug-in outside software would still need its documents under version control.

**E-082**

- **Statement:** The evidence format assumes git-tracked files cited as `path:line` at a commit, plus GitHub PRs, CODEOWNERS and branch protection for acting. Using ARIA on legal, finance or operations documents would require putting them in git (or writing a new evidence backend) and writing adapters for them. None of this exists.
- **Status:** PLANNED
- **Source:** `evidence_trust.py:96-233` (the grading needs `target_sha` and `git show`); `docs/aria/policy/risk-policy.json`; E-080.
- **Plain-language explanation:** A "law-office" version is plausible, but it is a project, not a setting.

---

## J. Old deck audit (Larvik innovation forum, Norwegian, 8 slides)

Source: `scratchpad/pitch/old_deck.txt`. The English translation is in brackets.

| #    | Slide | Claim (English)                                                                                                                                                                                       | Verdict                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J-1  | 1     | "ARIA is not an AI agent. It is the layer under the agents: remembers what happened, proves what was done, and learns from the outcome, in your own company."                                         | PARTIAL                          | Remembers: TRUE (LIVE, E-031). Proves: TRUE (LIVE, E-041, E-042). Learns from outcome: BUILT, not live (E-033: 0 outcome, convention or anti-pattern rows). "In your own company": the memory is in the company's repository (E-031)                                                                                                                                                                      |
| J-2  | 1     | "Works with several AI vendors at the same time"                                                                                                                                                      | TRUE (LIVE)                      | Anthropic Opus (346 attempts) and Z.ai GLM-5.3 (78 attempts) used side by side between 2026-09-19 and 09-26; judge verdicts from both (E-039, E-040). The OpenAI/Codex route is built, not live (`model_fleet.py:117-123`; CURRENT_STATE.md:94)                                                                                                                                                           |
| J-3  | 1     | "Runs with a local agent if you want"                                                                                                                                                                 | FALSE (not built)                | No local-model runtime exists (grep for ollama, vllm or llama found nothing in `aria-kernel/` or `tools/aria-poc/`). The only hook is Z.ai's "custom" OpenAI-compatible base URL (`tools/aria-poc/zai_runtime.py:205-216`), which could point at a self-hosted server. That is untested with a local model and read-only: `admits_writes=False` at `model_fleet.py:113`, so it cannot run the implementer |
| J-4  | 1     | "The evidence can be used to train a model"                                                                                                                                                           | UNVERIFIABLE (not built)         | Labelled data exists: 157 hash-chained TP/FP judge verdicts with rationale and evidence references (`tools/operator-feedback.jsonl`), plus `goldset.py` and `label_queue.py`. There is no export or training pipeline, and no model has been trained                                                                                                                                                      |
| J-5  | 1     | "As at home in a codebase as in a law office"                                                                                                                                                         | FALSE (today)                    | Everything is git-, code- and PR-shaped (E-080–E-082). No adapter exists for non-code documents                                                                                                                                                                                                                                                                                                           |
| J-6  | 1     | "In operation on a living aquaculture platform"                                                                                                                                                       | TRUE with caveat (LIVE)          | 43 nightly cycles from 2026-08-05 to 2026-09-20 on this repository. Nightly runs have failed since 2026-09-21; the executor still runs (E-030). "Living" means actively developed; no customer is evidenced (E-077)                                                                                                                                                                                       |
| J-7  | 1     | "Bound to no vendor"                                                                                                                                                                                  | PARTIAL                          | Judging is multi-vendor (J-2). Code writing is bound to Anthropic: only `anthropic` has `admits_writes=True` (`model_fleet.py:102-106`), and CURRENT_STATE.md:78 says "ARIA live autonomous execution is Claude Code CLI based"                                                                                                                                                                           |
| J-8  | 1     | Example card: claim "fôrberegning driver" (feed calculation drifts) / evidence `feeding/plan.ts:214` / version `2150ab6` / checked by independent judge / outcome fixed · learned / "BEVIST" (proven) | FALSE as a record (illustrative) | `feeding/plan.ts` does not exist (`git ls-tree -r origin/main` returns no match). `2150ab6` exists but is "feat(sensor-service): actually read VFD telemetry…" (2026-09-09), unrelated to feeding. aria/state has no row mentioning `feeding/plan` or `2150ab6`. No ARIA finding has ever been fixed (13 OPEN / 0 RESOLVED). A **real** replacement card: ARIA finding F-012 (E-042)                      |
| J-9  | 2     | "We built AI services for an aquaculture facility: feed dosing, record-keeping and close daily follow-up"                                                                                             | PARTIAL                          | The AI assistant with farm and water-chemistry tools, the feeding plans and the records are BUILT (E-070, E-071, E-075). "For an aquaculture facility" (a specific site) is UNVERIFIABLE (E-077). The slide says "Havbruk · egen drift" (own operation)                                                                                                                                                   |
| J-10 | 2     | "Every decision had to build on what was actually recorded, not on what someone remembered"; "traceable end to end, in the right order, near zero errors"                                             | PARTIAL                          | Design intent. Traceability is real for the software process (E-021–E-023). "Near zero errors" is unmeasured                                                                                                                                                                                                                                                                                              |
| J-11 | 2     | "The memory in the AI tools we tried was too weak and behaved differently each time"                                                                                                                  | UNVERIFIABLE                     | Founder experience                                                                                                                                                                                                                                                                                                                                                                                        |
| J-12 | 2     | "What solved our own problem became the kernel" / "built from necessity, not from an idea"                                                                                                            | TRUE (HISTORY)                   | The governance system (Feb–Apr 2026) came before ARIA (May 2026) (E-027)                                                                                                                                                                                                                                                                                                                                  |
| J-13 | 2     | "Now being adapted to other industries"                                                                                                                                                               | FALSE (today) / PLANNED          | No non-software adapter exists (E-080, E-082)                                                                                                                                                                                                                                                                                                                                                             |
| J-14 | 3     | Today's agents forget, claim "Done!" without proof, and lock memory in with the vendor ("switch model, lose everything")                                                                              | Opinion                          | Market framing, not an ARIA claim. It is overbroad: Claude Code, for example, has project memory files (`CLAUDE.md`) and git history                                                                                                                                                                                                                                                                      |
| J-15 | 4     | "Codex, Claude Code and Hermes do the job and tell you it's done. No evidence. No sender. No memory tomorrow."                                                                                        | Opinion / risky                  | This repository's own non-ARIA process (agents plus gates plus registry) already produces evidence and senders for Claude Code work (E-012, E-023). Name competitors carefully                                                                                                                                                                                                                            |
| J-16 | 4, 5  | "ARIA does it in a closed room (sandbox)"                                                                                                                                                             | PARTIAL                          | Read sandbox LIVE (261 contained judge spawns, E-047). Write sandbox BUILT, never used for a real change (E-046)                                                                                                                                                                                                                                                                                          |
| J-17 | 4, 5  | "under its own signature" / "every change has a sender, signed"                                                                                                                                       | PARTIAL                          | Signing is BUILT (E-048). A GitHub App identity is LIVE, but only for bookkeeping PRs (E-019). There are 0 ARIA-signed code commits                                                                                                                                                                                                                                                                       |
| J-18 | 4, 5  | "with evidence for every claim"; "file, line, version"; "a finding without something you can open does not exist"                                                                                     | TRUE (LIVE)                      | E-041, E-042, E-059, E-064                                                                                                                                                                                                                                                                                                                                                                                |
| J-19 | 4, 6  | "an independent judge before anything is let in"                                                                                                                                                      | PARTIAL                          | LIVE for findings: judge consensus gates canonical findings (E-039, E-042). BUILT for code, where no merge has happened (E-050). The independence of hard-case panels was defective (E-043)                                                                                                                                                                                                               |
| J-20 | 4, 5  | "remembers what it learned in the company's own archive, not with the vendor"; "memory is yours; one model today, another tomorrow"                                                                   | TRUE with caveat (LIVE)          | The memory is the `aria/state` branch in the company's own GitHub repository: 88,890 verified rows (E-031). Caveat: code and context are sent to Anthropic and Z.ai during judging, and the repository is hosted on GitHub                                                                                                                                                                                |
| J-21 | 4     | "memory is re-checked every time the code changes"                                                                                                                                                    | PARTIAL (LIVE, small)            | Beliefs are pinned to a commit and decay on diff, age or head distance (E-034). Live: 9 invalidations and corrections plus 71 confirmations for 8 beliefs (E-032). It runs per nightly cycle, not per commit, and cycles have been paused since 2026-09-21                                                                                                                                                |
| J-22 | 5     | "It learns from outcomes, not from claims. What went wrong becomes a rule. What went well becomes a pattern."                                                                                         | FALSE (as live) / BUILT          | change_outcome, conventions and anti-patterns all have 0 rows (E-033). Live learning is limited to judge calibration (41 rows) and belief corrections (E-032, E-039)                                                                                                                                                                                                                                      |
| J-23 | 6     | "Every finding comes with evidence"                                                                                                                                                                   | TRUE (LIVE)                      | E-042                                                                                                                                                                                                                                                                                                                                                                                                     |
| J-24 | 6     | "The plan is cross-examined before work starts"                                                                                                                                                       | PARTIAL                          | BUILT; live, 15 plans started and 0 converged (E-045)                                                                                                                                                                                                                                                                                                                                                     |
| J-25 | 6     | "Work is done in a closed room and judged by an independent judge"                                                                                                                                    | BUILT                            | E-046. There has been no live implementation                                                                                                                                                                                                                                                                                                                                                              |
| J-26 | 6     | "The gate says yes: a human, or a rule the human has set"                                                                                                                                             | BUILT                            | E-049–E-051. The operator grant model lives in unmerged plan 036/037 (E-052). All 8 merge decisions were blocked                                                                                                                                                                                                                                                                                          |
| J-27 | 6     | "The outcome is written back to memory"                                                                                                                                                               | BUILT                            | `change_outcome.py`; 0 live rows (E-033)                                                                                                                                                                                                                                                                                                                                                                  |
| J-28 | 6     | "Runs on a living platform with 17 services"                                                                                                                                                          | TRUE                             | 17 app directories, of which 15 are long-running services (E-001). ARIA ran on it (E-030)                                                                                                                                                                                                                                                                                                                 |
| J-29 | 6     | "Continuously, or when you want"                                                                                                                                                                      | TRUE (LIVE)                      | aria-auto-cycle ran on `schedule` and on `workflow_dispatch` (actions API: run 184 is schedule, run 179 is dispatch)                                                                                                                                                                                                                                                                                      |
| J-30 | 7     | "The kernel: BUILT"                                                                                                                                                                                   | TRUE (BUILT)                     | E-029, E-009. The value chain has not yet closed (E-057)                                                                                                                                                                                                                                                                                                                                                  |
| J-31 | 7     | Product 1, "Plug in: memory for the tools you already use"                                                                                                                                            | PARTIAL (LIVE, light)            | MCP server registered for Claude Code; 8 live calls (E-053)                                                                                                                                                                                                                                                                                                                                               |
| J-32 | 7     | Product 2, "Regulated industries: audit trail for AI-written code"                                                                                                                                    | TRUE (LIVE, for this repo)       | The finding registry (hash-chain verified), `Closes:` gate and ARIA ledgers (E-021–E-023, E-031). It is not packaged as a product                                                                                                                                                                                                                                                                         |
| J-33 | 7     | Product 3, "Same core, other fields: document-heavy case work (law, operations, finance)"                                                                                                             | PLANNED                          | E-082                                                                                                                                                                                                                                                                                                                                                                                                     |
| J-34 | 7     | Product 4, "On-prem: your own model, on your own machines; data never leaves the house"                                                                                                               | FALSE (today) / PLANNED          | No local model runtime (J-3). The live runtime uses cloud Anthropic and Z.ai. A self-hosted runner exists (`[self-hosted, linux, claude]`, plan 036 step 2), but the models do not run locally                                                                                                                                                                                                            |
| J-35 | 7     | "The kernel is built. The products are options."                                                                                                                                                      | TRUE (framing)                   | Consistent with J-30 to J-34                                                                                                                                                                                                                                                                                                                                                                              |
| J-36 | 8     | "Does evidence-bound memory give measurably better AI work: fewer errors, less rework, faster delivery?"                                                                                              | Open research question           | Nothing in the repository measures this. CURRENT_STATE.md repeatedly says measured learning utility remains open (e.g. :239, :309, :326)                                                                                                                                                                                                                                                                  |

---

## K. How each ARIA mechanism works, explained for a non-technical reader

Each paragraph says what the mechanism does in code, not what it might become.

1. **Ledgers (the notebook that cannot be quietly edited). LIVE.** Every event ARIA sees or causes is appended as a line to a record book. Each line contains a fingerprint of the line before it, so changing any old line breaks every fingerprint after it. All 88,890 lines on `aria/state` check out. Source: `ledger.py:1241-1299`; E-031.

2. **Discovery (reading the codebase). LIVE.** ARIA reads the exact committed version of the code, not unsaved files, and tracks which files it examined. Source: SPEC.md:196-200; CURRENT_STATE.md "Committed Snapshot Increment"; 215 discovery artifacts on aria/state.

3. **Adapters (specialised scanners). LIVE, none trusted yet.** Small programs each look for one kind of problem in a declared part of the code, for example "documents that point to files that no longer exist". A new adapter starts in a probation state and only reaches ACTIVE after measured precision and operator approval. So far none has. Source: `tool_registry.py:31-47`; E-035, E-036.

4. **Evidence grading (checking that a quote is real). LIVE.** Whenever an AI agent cites "file X, line Y", ARIA looks up that file in the exact code version, compares a digital fingerprint of the file, and discards the answer if it does not match. ARIA's own earlier output is never accepted as proof. Source: `evidence_trust.py`; E-041, E-059, E-060.

5. **Judges and consensus (a panel instead of one opinion). LIVE for findings.** A sample of scanner findings goes to several AI judges, including an "adversarial" judge whose job is to argue against the finding. Findings are accepted only on a weighted majority with enough confidence; disagreements go to an arbiter or are left undecided. The judges come from two AI vendors. Source: `feedback_store.py:82,825`; E-038, E-039.

6. **Escalation panels ("HUMAN_REQUIRED"). LIVE but not yet working.** Cases the judges cannot settle are meant to go to a second AI panel, and to the human if that panel refuses. In live use no case has been settled yet, because of bugs that are now fixed in code. Source: E-043.

7. **Beliefs and decay (facts with an expiry date). LIVE, small.** When ARIA has proven something about the codebase, it stores it as a belief tied to a code version. If the underlying files change, too many commits pass, or 90 days go by, the belief is marked for re-checking and then stale. Source: `memory.py`; E-032, E-034.

8. **Pressure (deciding what to look at next). LIVE.** ARIA counts three signals: things it cannot understand, patterns that repeat in three or more places, and contradictions. It uses those counts, without any AI model, to decide where to focus. Source: SPEC.md:173-190, 231-238; 41 pressure artifacts on aria/state.

9. **Planning with a challenger (cross-examined plans). BUILT; no plan has succeeded live.** A primary AI planner drafts a fix plan, a challenger drafts a competing one, and a cross-reviewer merges them. Work may only start once the plan converges. Live, 15 plans started and none converged. Source: E-045.

10. **Implementation in a sealed box. BUILT; never used for a real change.** An implementer agent would edit a separate copy of the code inside an operating-system sandbox. It must pass the same tests as before (a baseline comparison) and 18 hard checks before a pull request may open, and it signs commits with a key it cannot read. Source: E-046, E-048; read-only sandbox LIVE for judges (E-047).

11. **Change ledger (planned → committed → validated → outcome). BUILT; 2 planned, 0 beyond.** Every change is meant to be recorded through its life, including whether it later caused a problem. That "outcome" is the raw material for learning. Source: E-033, E-046.

12. **Risk lanes and merge authority. BUILT; never switched on.** Every file a change touches is sorted into a risk lane. Only the lowest lane (documentation and tests) could ever be merged by ARIA itself, and only after a human grants it for a limited time, the runner proves what it is, and a trial period has succeeded. Source: E-049–E-052.

13. **Self-revert and freeze (the safety net). BUILT on 2026-09-26.** If a change ARIA merged turns the build red, ARIA opens and merges its own undo, then freezes its merge rights until a human unfreezes them. Source: `self_revert.py`, `self_merge_freeze.py`; E-051.

14. **Kill switch and budgets. BUILT; no activation recorded.** A stop file or flag is checked at every step. Model-usage budgets are designed as hard stops, although the live review found that the cost gate rejects nothing in subscription mode. Source: SPEC.md:155-170; `docs/aria/reviews/2026-09-25-aria-dokuman-kod-karsilastirmasi.md` §0 item 5.

15. **Runtime profiles (how much ARIA may do). LIVE, "standard" only.** The profiles run from observe, through standard and strict, to frozen and autonomous. All 403 recorded states are "standard", which is not allowed to merge. Source: `runtime_profile.py`; E-050.

16. **Daily report and MCP plug-in (talking to people and tools). LIVE, light.** ARIA writes a daily status page and exposes read-only queries to AI coding assistants through the standard MCP protocol. Source: E-053, E-055.

17. **Search. BUILT (keyword); semantic search needs a model.** ARIA looks up past decisions by keyword. Meaning-based search activates only if an operator supplies an embedding model, and none is configured. Source: E-054.

18. **Multi-vendor fleet. LIVE for 2 vendors.** Roles are deliberately spread across different AI vendors when more than one is available, so the judges are not all the same model. Only the Anthropic runtime may write code. Source: `model_fleet.py:1-20,100-125`; E-040.

---

## Top 12 strongest TRUE facts for a non-technical investor

1. **E-004 / E-001:** The platform is about 2.2 million lines of maintained code across 17 back-end programs, 11 web apps and a Rust gateway for farm sensors.
2. **E-013 / E-012:** At least 1,703 of the platform's commits (25%) carry an AI coding agent's signature. 1,145 were authored by Claude itself, and in September 2026, 73% of changes were AI-signed.
3. **E-007 / E-017:** Over 1,300 reviewed change packages were merged into the product, and at least 203 contain AI-written work. A human approved every merge.
4. **E-021 / E-022:** Every problem the AI reviewers find is logged. 2,178 are logged, 80% are fixed, and the log is tamper-evident (all 2,178 entries verified).
5. **E-023 / E-024:** A fix only counts if it names the problem it fixes, and automatic gates reject shortcut code and excuse language. These checks have run 4,389 and 5,817 times.
6. **E-020:** 99 specialised AI reviewer roles police the codebase.
7. **E-027:** ARIA was not planned. It grew out of rules built to keep AI coders honest (February–April 2026), then became its own kernel (May 2026).
8. **E-030 / E-038:** ARIA ran on the company's own code almost nightly for seven weeks (August 5 to September 20, 2026) and dispatched about 1,200 tasks to AI agents.
9. **E-040 / E-039:** ARIA already uses AI models from two different vendors (Anthropic and Z.ai) side by side as independent judges, and the judges rejected 87 of 157 findings as false alarms.
10. **E-041 / E-042:** ARIA throws away AI answers whose quoted evidence is not in the real code, and has done so 24 times. Every accepted finding names the exact file, line and code version, and can be re-checked today.
11. **E-031:** All 88,890 records in ARIA's memory live in the company's own repository, and every one passes a tamper check.
12. **E-009:** ARIA's own code is protected by about 7,000 automatic tests, which passed in CI on 26 September 2026.

**Must accompany any of the above:** as of 2026-09-26, ARIA itself has written and merged **zero** code changes. That capability is built, not yet switched on (E-057, E-052). Also see security item E-067 (withheld in this public copy).
