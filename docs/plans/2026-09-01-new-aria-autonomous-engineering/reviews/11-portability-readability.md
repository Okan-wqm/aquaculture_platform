# Specialist 11 — Portability, Architecture, and Readability Review

## Verdict

`CHANGES_REQUIRED`

The D0 diff is documentation-only, leaves the protected legacy ARIA surfaces untouched, and records
the assigned audit titles/dispositions accurately. It does not yet define a self-consistent portable
repository identity contract or an acceptance path that proves the eight-role service can be built,
registered, reached, and bootstrapped on a clean host. Those are load-bearing D0 architecture gaps,
not implementation detail.

## Findings

### PORT-HIGH-001 — The portable repository contract still makes `origin/main` mandatory

- **Evidence:** The design makes `origin/main` reachability a field of every evidence record
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:184-189`), and the
  global sprint protocol requires every sprint to start from an exact `origin/main` SHA
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:276-283`). In direct conflict,
  S09 requires an absent-`origin` negative control
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P02.md:5-15`), S60 promises to
  reject fixed `origin` assumptions
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:41-51`), and the 050 row
  claims remote role and repository identity are separate
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:76`). The frozen
  finding requires distinct typed code-remote, state-remote, and authority-repository identities
  (`/var/aqua-saas/.worktrees/aria-full-system-audit-2026-09-01/docs/reviews/2026-09-01-aria-full-system-audit.md:569-578`); the D0 architecture never defines those three types.
- **Severity:** HIGH.
- **Consequence:** A repository can pass onboarding with no remote named `origin`, then be unable to
  create sprint provenance or admissible evidence. Renaming/remapping remotes can also bind state,
  source, and authority to different repositories while still satisfying the vague “canonical
  remote” language. This leaves ARIA-AUDIT-050 unprevented and weakens 049/053/060.
- **Smallest corrective action:** Define typed `code_repository`, `state_repository`, and
  `authority_repository` identities plus a configured base ref. Make reachability evidence bind the
  canonical authority repository ID and resolved base ref; keep `origin/main` only as this D0
  instance value. Update the branch protocol and S09/S60 tests so no-origin, renamed, multiple-remote,
  and cross-role substitution cases exercise the same contract.

### PORT-HIGH-002 — No sprint can prove a clean host has a deployable, reachable product

- **Evidence:** S02 exits after an inert health-only Nx/NestJS scaffold
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:17-27`); S06 and S07 exit on
  isolated GraphQL and federation contracts
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:65-87`). S41 merely names
  “runtime manifests” (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:5-15`),
  while the first clean-environment/package/config acceptance is deferred to the single S60 card
  after shadow, PR-only, and low-risk merge phases
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:189-232` and
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:41-51`). None of those cards
  names the repository's actual deployment authorities. The current SSoT requires catalog entries
  for image target, schema owner/runtime roles, migrations, required signals/env, and GraphQL
  subgraph (`platform/libs/service-catalog/src/index.ts:446-476`), generates deployment and Apollo
  artifacts (`scripts/service-catalog/generate-artifacts.ts:14-33`), and the shell has an explicit
  remote registry (`web/shell/vite.config.ts:16-37`). No D0 sprint requires `aria-service`, its eight
  role images, or `ariaModule` to be added to and verified through those paths.
- **Severity:** HIGH.
- **Consequence:** S41 can satisfy its written exit predicate with standalone manifests while image
  builds, DB migration ownership, required secrets/signals, Apollo composition, shell loading, nginx
  routing, and readiness deployment remain absent. S60 is also permitted to pass without defining a
  typed config schema, bootstrap order, or a no-NATS deployment test. The program can therefore
  promote through live/merge modes without evidence that a fresh repository/host can reproduce the
  product. This leaves the operational parts of 061/069/072/083 only aspirational.
- **Smallest corrective action:** Add one explicit clean-room acceptance matrix to the design and
  bind its rows to existing S02/S03/S06/S07/S41/S60 exits: build all eight role images from the one
  source root; register service/image/schema/migration/env/signal/subgraph authorities and regenerate
  their artifacts; register and load the shell remote; provision an empty Postgres/object-store and
  run migrations; boot with NATS absent and, separately, with cert-only NATS; then run API/UI
  readiness from a non-repository CWD on a fresh host. Restrict P06/P07 to the one certified initial
  repository/host until S60's multi-repository matrix passes.

### READ-MEDIUM-003 — Complexity and generated-file exceptions are not executable standards

- **Evidence:** The design names cyclomatic complexity and function-size checks, but supplies a
  number only for physical file length; generated/declarative migrations receive an undefined
  exception (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:108-125`).
  The plan repeats only `<=250`/`>400` and “uncontrolled complexity”
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:26-28`), while S02's test names
  only the `>400` source fixture
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:17-27`).
- **Severity:** MEDIUM.
- **Consequence:** A 399-line god function can pass the documented gate, and any oversized hand-made
  file can self-label as generated/migration. `ACC-READ-001` is not deterministic, so module
  dependency direction and readability can drift while every named test remains green.
- **Smallest corrective action:** Put deterministic function-length and complexity limits, dependency
  tags/directions, and the generated/declarative exception schema (provenance, owner, reason, reviewed
  expiry) into `ACC-READ-001`; add rejection fixtures for a god function, reverse import, and forged
  generated classification to S02.

### READ-MEDIUM-004 — The 88-row matrix is mechanically compact but not practically readable

- **Evidence:** `FINDING-COVERAGE.md:25-114` is one nine-column table. All 90 table lines are 833
  characters after formatting, and the file is 77,629 bytes despite being only 114 lines. The plan
  links only to that monolith (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:300-306`);
  there is no per-range/domain index or vertical reading view.
- **Severity:** MEDIUM.
- **Consequence:** Source review requires horizontal scanning across nine semantically important
  cells, and ordinary rendered views collapse the evidence into a wide scroll area. Reviewers can
  easily misassociate a test, owner, acceptance ID, or closure rule with the adjacent finding. This
  fails the review brief's practical-readability requirement even though line-count gates pass.
- **Smallest corrective action:** Preserve the canonical 88 rows and exact-field invariant, but add
  generated indexed vertical reading pages (for example, fixed ID ranges) linked from every row and
  back to the authority. Add a parity/link check so the readable projection cannot drift or omit a
  field.

## Assigned finding verification

| Finding | Result  | Evidence-based assessment                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `049`   | PARTIAL | Canonical-root control and nested-CWD/symlink/worktree tests are faithful (`FINDING-COVERAGE.md:75`, `P02.md:5-27`), but the global `origin/main` protocol prevents a single portable resolver contract.                                                                                                                                                                                                  |
| `050`   | FAIL    | The matrix does not define the source finding's three typed repository roles, and `PLAN.md:279` still fixes the authority ref to `origin/main`.                                                                                                                                                                                                                                                           |
| `053`   | PASS    | Explicit workspace/repository IDs, server-owned roots, foreign-CWD tests, and S41 deployment negative control match the frozen failure mode (`FINDING-COVERAGE.md:79`, `P02.md:5-15`, `P06.md:5-15`).                                                                                                                                                                                                     |
| `060`   | PASS    | Provider repository identity, path-as-ephemeral metadata, cross-host/path stability, and public-evidence path exclusion are explicitly covered (`FINDING-COVERAGE.md:86`, `P02.md:5-15`, `P08.md:29-51`).                                                                                                                                                                                                 |
| `061`   | PARTIAL | Job-scoped roots, `/tmp` denial, escape checks, and write audit are specified (`FINDING-COVERAGE.md:87`, `P03.md:17-39`), but clean-host packaging/boot proof is not bound to repository deployment authorities (PORT-HIGH-002).                                                                                                                                                                          |
| `069`   | PARTIAL | Language-neutral graph ports and alternate-repository fixtures are named (`FINDING-COVERAGE.md:95`, `P02.md:41-51`, `P08.md:41-51`), but the adapter/package/config boundary is not defined sufficiently to prove the eight deployed roles are independent of Nx/TS/Rust target assumptions.                                                                                                              |
| `072`   | PARTIAL | Independent Postgres current state, CAS, restore, and no legacy runtime dependency are correctly chosen (`FINDING-COVERAGE.md:98`, design `:127-164`), but the clean database/object-store/bootstrap and deployment-registration path has no executable D0 acceptance contract. The deliberate no-legacy-import decision is clear; export/import of the new system's own portable state is not specified. |
| `083`   | PASS    | CAS URI/digest identity and a same-artifact/different-host negative test faithfully remove producer host paths (`FINDING-COVERAGE.md:109`, `P01.md:29-39`, `P08.md:41-51`).                                                                                                                                                                                                                               |

## Checks performed

- Read root `CLAUDE.md`, the common adversarial brief, task contract, implementer report, the complete
  design/plan/progress/evidence/event artifacts, all nine phase cards, all 88 matrix rows, and the
  supplied diff package.
- `git diff --name-status eeb401131..c6065d6da` contains only the 15 D0 documents plus mechanically
  generated `tools/quality/format-scope.json`; protected legacy-path diff is empty.
- `git diff --check eeb401131..c6065d6da` exited 0.
- Frozen audit worktree HEAD is exactly `85787e610e26c192c898ffebd4e51ded856cd880`; titles and source
  meanings for 049/050/053/060/061/069/072/083 were compared against the complete relevant report
  sections.
- Readability measurement: `FINDING-COVERAGE.md` is 114 lines / 77,629 bytes; 90 lines exceed 400
  characters and all table lines are 833 characters.
