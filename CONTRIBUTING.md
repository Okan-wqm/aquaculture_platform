# Contributing

This repo follows trunk-based development with strict architectural discipline. Read `CLAUDE.md` first — it is the platform invariant playbook (banned phrases, schema ownership, commit format, layer rules). Everything below complements it.

## Quick Start

```bash
# Infra (Postgres + Redis + NATS + MinIO + Mosquitto)
npm run infra:up

# Backend dev (Nx run-many across all services)
npm run dev:backend

# Web dev (shell + microfrontends via Module Federation)
npm run dev:web

# Build + test (affected only — fast)
nx affected --target=build
nx affected --target=test
nx affected --target=lint

# Type-check platform-wide (`tsc --noEmit`)
npm run type-check
```

## Commit Conventions

We use **Conventional Commits**. Subject prefixes:

- `fix(scope): …` — bug fix; **MUST carry `Closes:` trailer** (see below)
- `security(scope): …` — security-relevant change; **MUST carry `Closes:` trailer**
- `feat(scope): …` — new functionality
- `docs(scope): …` — documentation only
- `test(scope): …` — test-only changes
- `refactor(scope): …` — non-behavioural restructure
- `chore(scope): …` — build / tooling / dep / config

`refactor(agentic,phase-*)` also requires `Closes:`.

### `Closes:` trailer format

```
Closes: docs/reviews/<agent>/<YYYY-MM-DD>-<topic>.md#<FINDING-ID>
```

Or for orphan findings:

```
Closes: docs/reviews/orphan-findings.md#<FINDING-ID>
```

`<FINDING-ID>` matches the regex `[A-Z][A-Z0-9]+-(CRITICAL|HIGH|MEDIUM|LOW)-NNN` and MUST exist in `docs/reviews/_registry/findings.jsonl`. New findings need a registry seed in the same PR (or earlier).

### Body explains *why*

Subject = what; body = why. Diff already shows the what; the body anchors the architectural decision against an ADR or finding ID.

### Banned phrases

`tools/gates/banned-phrase.ts` rejects bare `for now`, `interim`, `temporary`, `pragmatic`, `simpler approach`, `middle ground`, `good enough`, `sufficient for now`, `deferred` (without finding-ID), `out of scope` (without ADR/review/plan reference). The substitution table lives in `.claude/agents/edge-docs/README.md` § Banned-phrase discipline. The hook scans both file content AND commit message body.

## Architectural Discipline (Tier 1-4)

Every fix picks the highest tier that applies (CLAUDE.md § Architectural Approach):

1. **Make it impossible** — type system / compiler / runtime structurally prevents the wrong behaviour
2. **Make it automatic** — the correct behaviour becomes the zero-effort default
3. **Make it detectable** — wrong behaviour caught at build/test time
4. **Document it** — last resort, only when 1-3 are genuinely impossible

Patches, compatibility shims, defensive `?.` chains, `as any`, `// @ts-ignore` are **forbidden**. If the architectural fix cannot land in this PR, open a CRITICAL or HIGH finding with explicit owner + deadline + finding ID.

## Branch + Worktree Hygiene

- Feature branches: `feat/<scope>-<topic>`
- Bug-fix branches: `fix/<scope>-<topic>`
- Audit / orphan-finding closure: `agentic-audit-followup-N`
- Worktrees for parallel shells: under `/var/aqua-saas/.worktrees/` (gitignored) — long-lived worktrees outside that root will be flagged by ORPHAN-EDGE-WORKTREE-001 cleanup tooling.
- **Never** force-push (`--force`, `--force-with-lease`).
- **Never** bypass hooks (`--no-verify`, `--no-gpg-sign`).
- `git push` after every commit on the active branch.

### Parallel-shell hygiene

When multiple shells share the same working tree, the git index is shared. Before each commit:

```bash
git diff --cached --name-only      # confirm staged set is YOURS
git commit -- <explicit-pathspec>  # commit only the paths YOU staged
```

Avoid `git commit -a` and `git add -A` when working alongside parallel sessions. (See ORPHAN-EDGE-HYG-002.)

## Testing

- Unit: `__tests__/*.spec.ts` co-located with the module
- Integration: `apps/{svc}/src/__tests__/integration/` or `e2e/tests/integration/`
- E2E: `e2e/tests/`, `tests/e2e/`
- London School TDD: mock collaborators with `@platform/testing` factories
- New feature → test first, then implement

## Schema + Database

- Every `@Entity()` declares `schema:` (ADR-011)
- Never add tables to `public` (the `shared` schema holds 4 canonical cross-tenant tables; expanding requires an ADR per ADR-011)
- Use `getScopedRepository()`, never `getRepository()`
- Migration: blue-green safe (nullable column → backfill → NOT NULL constraint); never hand-edit; generate a new migration

## Events

- Add interface to `libs/event-contracts/src/*-events.ts`, extending `BaseEvent`
- Export from `index.ts`
- `eventType` is PascalCase (`BatchHarvested`, `SensorCalibrated`)
- Add a JSON Schema validator under `libs/event-contracts/src/schemas/` for trust-boundary crossings (tracked under ORPHAN-EDGE-CONTRACT-002 platform-wide gap)
- Add an upcaster for breaking changes
- Use `createBaseEvent()` factory; inline construction is a compile-time error

## Pull Request Flow

- Base = `main` (CODEOWNERS review required)
- PR title follows the conventional-commit subject of the squashed merge commit
- PR body: summary + test plan + traceability links (ADR / finding / runbook)
- All required CI checks must be green before merge (banned-phrase, gitleaks, validate-closes, build, test, type-check, schema-validation, security-audit)
- Auto-merge is gated by repo settings; if disabled, request a CODEOWNERS reviewer to merge

## Memory + Knowledge SSoT

- ADRs: `docs/adr/` (canonical)
- Runbooks: `docs/runbooks/` (operational)
- Open architectural findings: `docs/reviews/orphan-findings.md`
- Agent definitions: `.claude/agents/`, `.claude/agents/product-audit/`, `.claude/agents/edge-docs/`
- Layer knowledge: `.claude/knowledge/`
- Shared review contract fragments: `.claude/shared/`

## Where to Ask

- Bug or feature: GitHub Issue with reproduction + impact
- Security: see `SECURITY.md`
- Onboarding: ping the relevant domain agent in your PR description (`@farm-expert`, `@edge-expert`, `@compliance-expert`, etc.)
- Customer support: see `SUPPORT.md`
