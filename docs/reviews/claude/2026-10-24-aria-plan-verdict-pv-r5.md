# ARIA plan verdict, PV-R5: plan path admission cost (2026-10-24)

The PV-R4 appellate final (`appellate-final.json`, roots R22 and R23) accepted two roots against
the R19-R21 round of the plan-verdict branch (`feat/aria-plan-verdict-p1-p3-p5`). PV-R5 fixed R23
(`workspace_view.commit_blob_paths`, one `ls-tree` per commit path set, a git failure raises).
Under the lean bar R22 is not fixed in that package. It is registered here with its required fix
as the close condition.

## ARIA-MEDIUM-905

Plan path admission cost is bounded per glob only by alternative count. R19 caps the
alternatives of one pattern. The record law (`_plan_path_reading` through `require_repo_glob`)
and the freshness reader (`plan_verdict_paths`, `plan_path_covers`) still do work linear in the
number of untrusted texts per record, times alternatives, times alternative length. Every compiled
alternative stays in the unbounded `_GLOB_REGEX_CACHE`. Evidence refs name one literal file each
(R21), yet they are still brace-expanded and glob-compiled.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20. Source: PV-R4 appellate final R22
  (SEC-R4R2-B1, EV-R4R2-B1).
- Evidence:
  - `aria-kernel/aria_kernel/canonical_path.py:247-256`: the R19 bound counts the alternatives of
    one pattern, then builds every alternative at full length.
  - `aria-kernel/aria_kernel/canonical_path.py:385`, `:483`: `_GLOB_REGEX_CACHE` has no bound.
  - `aria-kernel/aria_kernel/plan_convergence.py:3719-3720`, `:3734-3735`: risk `affected_files`
    and `evidence_refs`, body paths and refs, each text through the law with no count cap.
  - `aria-kernel/aria_kernel/plan_convergence.py:1699-1706`, `:1802`: the freshness reader does the
    same work again on every cold read.
  - `aria-kernel/aria_kernel/plan_convergence.py:4921`, `:4950`: `_plan_ref_reading` sends a ref's
    path through `require_repo_glob`.
  - Measured by the PV-R4 reviewers and the appellate: 269 KB of reviewer refs cost 525 s / 2.2 GB;
    one 50 KB ref cost 98 s / 508 MB; 512 `affected_files` (32 KB) were recorded after 55 s;
    256 key-change globs cost 24 s at record and on each cold freshness read; 16 ten-group patterns
    left 17,408 cache entries; a 2 KB tail on a 10-group pattern took 3.6 s.
  - Until this is fixed, a single cited path over Linux's `MAX_ARG_STRLEN` (128 KiB) also makes
    `workspace_view.commit_blob_paths` refuse (`workspace_head_unreadable:OSError`). That refusal
    fails closed.
- Rule violated: untrusted plan and reviewer text reaches the kernel's path law under a bound on
  the whole record's cost. The bound is set in the owner (`canonical_path`) from a measured
  legitimate maximum. An evidence ref names one literal file and never meets the glob expander.
- Close condition (the appellate's required fix):
  1. Evidence refs are literal. `_plan_ref_reading` admits the path through `resolve_repo_relpath`
     plus the existing `..` refusal. It never calls `require_repo_glob`, `expand_repo_glob` or the
     matcher. `plan_verdict_paths` keeps cited files apart from globbed body paths. A cited file
     covers a changed path by equality only. `plan_path_covers` applies only to surfaces and
     key-change paths.
  2. `canonical_path` gains one cost measure and one per-record budget:
     - The measure is the exact expanded size of a pattern: the sum of its alternatives' lengths,
       or the length of a brace-free text. It is read in the `_brace_alternative_count` scan,
       before anything is built, and it saturates.
     - One entry point (for example `require_repo_globs(patterns)`) sums the measure over all of a
       record's glob texts before compiling any. Above `MAX_REPO_GLOB_RECORD_CHARS` it raises
       `GovernanceError('repo_glob_record_too_large')`. The constant is set from a measured
       largest legitimate plan record, and its comment cites that number.
     - The plan record law calls it once per record: body surfaces plus key-change paths, and the
       cross-review envelope's `affected_files` across risks.
     - `plan_verdict_paths` reads each recorded record through the same call. A record over the
       budget gives `PLAN_VERDICT_PATH_REFUSED` (parked).
     - R19's per-pattern count bound stays.
     - No call-site try/except, no second grammar, no second expander.
  3. `_GLOB_REGEX_CACHE` is bounded (an lru on the compile).
- Tests that close it:
  - 4096 ten-group refs in one risk compile no glob and finish in under 5 s, with an RSS delta
    under 50 MB. The event count is unchanged on refusal.
  - 512 ten-group `affected_files` are refused at record with `repo_glob_record_too_large` in
    under 5 s.
  - A body with 256 such `key_changes` globs is refused by `start_plan` in under 5 s.
  - A 10-group pattern with a 20 KB tail is refused in under 1 s, and `_expand_braces` is never
    called.
  - The cache size never exceeds its bound.
  - The B1 stdlib glob and every `kernel_authority_set()` member still match.
  - All R16-R23 tests stay green.
- Plan item: P1 and P3, the plan-path record law and the freshness gate of the plan verdict.
- Slot: Wave B with P3.
