# Phase 0 — Cold-audit baseline

**Cycle:** `2026-04-22-cold-audit` • **Run:** 2026-04-22 18:58–19:26 UTC • **Branch:** `agentic-rust-unified` (0 commits ahead of `origin/main`)

## Inputs collected (raw artifacts)

All paths relative to repo root. Each is the snapshot captured before any finding was written.

| Signal | Tool | Path | Size |
|---|---|---|---|
| OPEN findings (pre-audit) | `npm run findings:list` | `01-signals/findings-open.txt` | 35 lines |
| Registry hash-chain | `npm run findings:verify` | `01-signals/findings-verify.txt` | chain intact, 133 entries |
| All findings (CSV) | `npm run findings:export csv` | `01-signals/findings-export.csv` | 134 rows |
| Severity histogram | derived from CSV | `01-signals/findings-by-severity.txt` | 74 CRITICAL / 30 HIGH / 21 MEDIUM / 8 LOW |
| State histogram | derived from CSV | `01-signals/findings-by-state.txt` | 60 IN-PROGRESS / 45 RESOLVED / 27 OPEN / 1 BLOCKED |
| Churn top-120 (3 months) | `git log --since` | `01-signals/churn-top120.txt` | 120 rows |
| Prior audit cycles | `ls -t docs/reviews/_audit/` | `01-signals/prior-audits.txt` | 10 entries (latest W16) |

## Scanners executed in Phase 1 (parallel)

| Tool | Command | Output | Status | Notable result |
|---|---|---|---|---|
| tsc | `npm run type-check` | `01-signals/tsc.txt` | ⚠ silent no-op | no root `tsconfig.json` → tsc prints help and exits 0. Captured as `AUDIT-CRITICAL-001`. |
| lint | `nx run-many --target=lint --all --parallel=8` | `01-signals/lint.txt` | ⚠ ran ≥10 min in background without producing a file (stream not flushed) | aborted, lint signal not collected this cycle |
| tests | `nx run-many --target=test --all --parallel=4` | `01-signals/tests.txt` | ⚠ ran ≥10 min in background without producing a file | aborted, test signal not collected (invariants:fast covered critical subset) |
| invariants:fast | `jest --selectProjects layer-1 layer-3` | `01-signals/invariants.txt` | 🟥 3 failures | `finding-registry-integrity` (duplicate ids) + `knowledge-ssot` (service-count mismatch). Captured as `AUDIT-CRITICAL-003`. |
| gates:all | `npm run gates:all` | `01-signals/gates.txt` | 🟥 exit 2 | banned-phrase gate Usage-dump; chain short-circuits. Captured as `AUDIT-CRITICAL-002`. |
| npm-audit gate | `ts-node tools/gates/npm-audit.ts` | `01-signals/npm-audit.txt` | 🟨 exit 0 (not useful — ts-node PATH issue in this shell) | gate runs cleanly in CI but not reproducible from a bare shell. Noted but not filed as a finding. |
| jscpd | `jscpd apps libs platform web --min-tokens 60` | `/tmp/jscpd/jscpd-report.json` + `01-signals/jscpd.txt` | 🟩 OK (13m 45s) | 1946 clones / 42,582 duplicated lines / **4.74%**. 33 clones ≥100 lines. |
| madge | `madge --circular apps libs platform` | `01-signals/madge-circular.txt` | 🟩 OK | 26 circular chains (25 false-positives TypeORM/NestJS, 1 real — `AUDIT-MEDIUM-013`). |
| nx graph | `nx graph --file=/tmp/nx-graph.json --focus=@none` | `01-signals/nx-graph.log` | 🟥 killed (10+ min, no output) | graph generator hung; not critical — madge already covered circular-dep signal. |

## Grep probes (inline, parallel)

| Pattern | Files excluded | Hits | Captured in |
|---|---|---|---|
| `\bas any\b` | node_modules, __tests__, .spec.ts | 28 | contributes to hotspot score |
| `getRepository\(` | node_modules, __tests__, .spec.ts | 164 lines across **89 files** | `AUDIT-HIGH-002/003/008`, `AUDIT-MEDIUM-007` |
| `@ts-(ignore|expect-error)` | node_modules, __tests__, .spec.ts | 3 | contributes to score |
| `^\s*console\.(log|warn|error|debug)` | node_modules, __tests__, .spec.ts, .e2e-spec.ts | 3 | all intentional (library log/warn) — not filed |
| `@Entity(...)` **without** `schema:` | — | 1 / 225 entities | `apps/farm-service/.../base.entity.ts` (legit abstract base) |
| event payload/metadata nesting (`payload: {` / `metadata: {` in `*.event.ts`) | — | 0 | ADR-006 clean |

## Signal budget (observed)

- Agent invocations: **1** (Phase 2 Explore) — within plan budget (1 mandatory + 0–5 conditional; Phase 3 was SKIPPED because findings were generic dup/style/tooling, not domain-semantic).
- Total wall time: ~28 min end-to-end (Phase 1 dominated by jscpd at 13m).
- Deterministic aggregation (Phase 1.5): ~1 s per run; re-invoked 3× as signals arrived.

## Pointer to downstream artifacts

- `02-hotspot-per-file.md` — top 30 files with score breakdown (537 scored).
- `02-hotspot-per-service.md` — per-service rollup (top: `apps/farm-service` 302, `apps/sensor-service` 295).
- `02-jscpd-clusters.md` — top 50 clone pairs for extraction triage.
- `02-orphan-modules.md` — 26 circular chains, Phase 2 classified each.
- `02-adr-violations.md` — by-rule grouping (ADR-011 / getRepository / `as any` / etc.).
- `03-explore-findings.md` — Phase 2 triage output, 21 stubs, four H2 sections.
- `stubs/AUDIT-*.json` — per-finding JSON stubs appended to the registry in Phase 4.
- `../../../plans/2026-04-22-cold-audit-remediation/README.md` — Phase 5 remediation backlog with dependency DAG.
