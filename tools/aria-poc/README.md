# ARIA Phase-1 PoC

Operator decision tool. Pure-mechanical analysis of this repository — no LLM, no API, no network (except optional `npx nx graph` subprocess).

**Spec:** `docs/aria/CONTRACTS.md` §13.

## Why this exists

`docs/aria/SPEC.md`, `docs/aria/IDENTITY.md`, and `docs/aria/CONTRACTS.md` describe a system that does not yet exist. Building the kernel is months of work.

This PoC answers **"do we even need ARIA?"** in one week of zero-LLM mechanical analysis. If the PoC's decision gate says no, the contracts are archived as research artifacts and no kernel is built.

## What it does

1. Walk filesystem (excluding `agent-workspace/`, `node_modules/`, `.git/`, `dist/`, `build/`, `.aria-poc/`, etc.)
2. Reconcile with `git ls-files`
3. Assign every file a fate (Coverage Invariant: `read_deeply` / `read_skimmed` / `skipped_with_reason`)
4. Compute `REPO_FINGERPRINT.json` (language histogram, manifest detection, service count, ADR count, agent count)
5. Ingest TRUSTED priors (mechanical, no LLM):
   - `CLAUDE.md` → `CLAUDE_MD_PRIORS.md` (heading inventory)
   - `docs/adr/[0-9][0-9][0-9]-*.md` → `ADR_PRIORS.md` (canonical only, title + status)
   - `.claude/agents/*.md` → `AGENT_PRIORS.md` (frontmatter description per agent)
6. Run `npx nx graph` (best-effort, optional)
7. Mechanical drift scan: TypeScript `enum` keyword vs PostgreSQL `CREATE TYPE ... AS ENUM`. Heuristic name match; report any name match where value sets differ.
8. Generate `.aria-poc/aria-poc-report.md` with the operator decision gate.

## Run

```bash
python3 tools/aria-poc/poc.py --workspace-root .
```

Or via Claude Code session:

```
/aria-poc
```

(see `.claude/commands/aria-poc.md`)

Optional flags:

- `--skip-nx-graph` — skip the `npx nx graph` subprocess (faster, useful when nx is broken)
- `--out-dir <path>` — output directory (default: `.aria-poc/`)

## Outputs (in `.aria-poc/`, gitignored)

| File | Content |
|---|---|
| `aria-poc-report.md` | The decision-gate report |
| `REPO_FINGERPRINT.json` | Mechanical repo summary |
| `CLAUDE_MD_PRIORS.md` | CLAUDE.md heading extraction |
| `ADR_PRIORS.md` | Per-ADR title + status |
| `AGENT_PRIORS.md` | Per-agent description |
| `BUILD_GRAPH.json` | Nx project graph (if available) |
| `MECHANICAL_DRIFTS.json` | TS enums, SQL enums, drift candidates |

## Decision gate (per CONTRACTS §13)

After running, answer YES/NO to each:

1. Did the fingerprint reveal anything you did not already know?
2. Did the mechanical drift scan surface real drift not caught by existing 38 specialized agents on PR cycles?
3. Is the value surface of (2) large enough to justify months of kernel work?
4. Is the LLM cost (Claude Code session-based, NOT direct API) within scope?

**3 of 4 NO** → archive contracts as research artifacts.
**3 of 4 YES** → proceed to Phase 0 (kernel skeleton).

## What this PoC does NOT do

- No skill genesis. No adapter birth. No capsule storage. No mastery levels.
- No LLM. No findings. No recommendations.
- No PR creation. No worktree. No baseline capture.
- No persistence beyond `.aria-poc/`.

## Code budget

- 488 lines (427 effective code lines, rest blank + docstring)
- Stdlib + pyyaml only
- Single file: `poc.py`
- Runs in ≈30 seconds on the full repo
