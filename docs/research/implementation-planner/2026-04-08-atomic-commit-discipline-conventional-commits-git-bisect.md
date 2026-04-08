---
Topic: Atomic commit discipline — one concern per commit, Conventional Commits spec, git bisect friendliness, and revert/review friendliness.
---

## Sources

- Conventional Commits 1.0.0 specification (conventionalcommits.org)
  https://www.conventionalcommits.org/en/v1.0.0/
- git-scm.com, "Git Basics — Recording Changes to the Repository"
  https://git-scm.com/book/en/v2/Git-Basics-Recording-Changes-to-the-Repository
- git-scm.com, "git bisect" documentation
  https://git-scm.com/docs/git-bisect
- Google Engineering Practices, "Small CLs" (Change List discipline)
  https://google.github.io/eng-practices/review/developer/small-cls.html
- Atlassian Git Tutorials — "Git Commit Best Practices"
  https://www.atlassian.com/git/tutorials/saving-changes/git-commit
- Tim Pope, "A Note About Git Commit Messages" (2008) — canonical subject/body formatting rule
  https://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html
- DORA, "State of DevOps 2023" — commit frequency and MTTR correlation

## Key Findings

### Conventional Commits 1.0.0 Structure

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Type vocabulary** (most relevant for fix-implementation commits):
- `fix`: a bug fix (SEMVER patch-equivalent)
- `feat`: a new feature or capability (SEMVER minor-equivalent)
- `refactor`: code restructuring without behavioral change
- `test`: adding or fixing tests only
- `chore`: maintenance tasks (dependency update, config change)
- `docs`: documentation only
- `perf`: performance improvement
- `security`: security fix (not in the base spec, but widely adopted and recommended for this platform)

**Scope**: the bounded context or service name in parentheses, e.g., `fix(farm-service)` or `feat(event-contracts)`. For the aqua-saas platform, scope maps directly to the service/lib name (`auth`, `farm`, `sensor`, `hr`, `billing`, `gateway`, `event-contracts`, `outbox`, etc.).

**Breaking change footer**: `BREAKING CHANGE: <description>` in the footer makes this commit a SEMVER major bump. Must appear for any event contract breaking change, any entity rename, any migration that drops a column.

**Body format**: 72 characters per line, blank line between subject and body. Body explains the WHY, not the what (the diff shows the what). Body should reference the finding IDs from the review report that motivated the change.

### One-Concern-Per-Commit Rule

- Google's "Small CLs" guide establishes the principle: each commit (or change list) should make exactly one conceptual change. This is not a size rule — a one-line fix and a 500-line fix can each be exactly one commit if each addresses exactly one concern.
- "Concern" in the context of review implementation = one work package. One package, one commit. No mixing packages in a single commit, no splitting a package across multiple commits.
- Justification: when a multi-concern commit causes a regression, `git bisect` halves the search space on every step. A single commit with mixed concerns produces a bisect half-step that is always a broken intermediate state, defeating bisect entirely.

### git bisect Friendliness

- `git bisect` binary searches for the commit that introduced a regression by marking commits as "good" or "bad". For bisect to be useful, every commit in the history must be independently buildable and testable (`npm run build && npm test` must complete without hanging).
- Each work package commit MUST: (a) leave the build passing, (b) leave all pre-existing tests passing, (c) add or update the tests relevant to the fix. A commit that intentionally breaks the build as an intermediate step is bisect-hostile and FORBIDDEN.
- This requirement also applies to the aqua-saas platform's TypeORM migration strategy: a migration commit must be self-contained (up AND down scripts valid) and leave the schema in a consistent state.

### Revert Friendliness

- A one-concern commit can be reverted with `git revert <hash>` and the result is meaningful: the platform returns to the pre-fix state for exactly that concern, with all other concerns intact.
- A multi-concern commit revert undoes multiple unrelated changes simultaneously, making the revert itself a CRITICAL event requiring a second round of review.
- For this platform: a revert of a CRITICAL security fix must never accidentally revert an unrelated migration that happened to be bundled in the same commit.

### Commit Message Finding References

- Body of each work package commit MUST include the finding IDs from the source review report that motivated the change. Format: `Addresses: {agent}/{finding-id}` e.g., `Addresses: farm-expert/F-012, farm-expert/F-013`.
- This creates a bidirectional audit trail: from finding → commit, and from commit → finding. The `git log --grep="farm-expert/F-012"` command then locates the exact commit that resolved a specific finding.
- Footer `Fixes #NNN` is used for GitHub Issues (if the platform tracks issues). For inter-agent plan references: `Plan: docs/plans/{date}-{topic}/packages/NN-{slug}.md`.

### Conventional Commits and CHANGELOG Automation

- Tools like `semantic-release`, `standard-version`, and `git-cliff` parse Conventional Commits to auto-generate CHANGELOGs. When commits are generated by this plan system, the type/scope/description must be authored by the planner with enough precision that CHANGELOG automation produces meaningful output without human editing.

## Security Concerns

- A commit that contains both a security fix and a feature addition obscures the security surface in code review. Reviewers scanning for security changes cannot quickly isolate the security delta from the feature delta. Rule: security-sensitive packages always produce commits that contain ONLY the security fix (plus its tests). Zero co-mingling with feature or refactor changes.
- `BREAKING CHANGE` footer in a commit touching auth-service or gateway-api is automatically a security review trigger — breaking auth changes in the runtime require security-reviewer dispatch.

## Performance Concerns

- Commit message generation overhead is negligible. The value of precise commit messages vastly outweighs any planning time cost.
- Monorepo scenarios: if the platform uses `npm workspaces` / pnpm, a single commit touching multiple services still counts as one commit in git history. The one-concern rule applies to the logical concern, not the number of files.

## Architectural Implications

- The aqua-saas CLAUDE.md already enforces: no `@ts-ignore`, no `as any`, no floating promises. These constraints apply to fix commits just as to new code. A fix commit that introduces a TypeScript hack to avoid a deeper problem violates CLAUDE.md and will be caught by the `test-runner` gate.
- CLAUDE.md also specifies: `getRepository()` YASAK → `getScopedRepository()`. Fix commits touching TypeORM repository calls must use the scoped variant. The atomic commit plan for any package touching data access must include this correction if it is present.
- CQRS event contracts: a commit that adds a handler without a corresponding event publish, or a commit that changes an event shape without updating the `@platform/event-contracts` interface, is architecturally incomplete. The planner must enumerate ALL layers in the atomic commit plan.

## Domain Rule Additions

1. Each work package produces exactly one git commit. One-package-one-commit is invariant — no splitting, no bundling.
2. Commit subject uses Conventional Commits format: `{type}({scope}): {description}` where scope is the service/lib name.
3. Commit body references finding IDs: `Addresses: {agent}/{finding-id}` per finding in the package.
4. Commit footer includes `BREAKING CHANGE:` whenever the package modifies an event contract shape, drops a column, or changes a public API. Security packages in gateway/auth include `Plan: {package-file-path}` in the footer.
5. Every work package commit must leave the build and all pre-existing tests passing — no bisect-hostile intermediate states.
