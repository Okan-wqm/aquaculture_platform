# The format scope is committed instead of derived (2026-10-02)

Owner: okan. Deadline: 2026-10-16. Severity: MEDIUM.

## PROC-MEDIUM-040

Context: `tools/quality/format-scope.json` holds one entry per tracked file with a formattable
extension. Every entry is a pure function of `git ls-files --cached` and `classifyFormatFile`, and
`format-scope check` refuses the commit when the committed copy differs from a fresh build. So
every PR that adds or removes a tracked file has to regenerate it, two concurrent PRs conflict on
it whatever files they touch, and automation PRs that add a single file fail CI because they never
regenerate it: the ARIA daily-report PR #1707 (`aria-tools/reports/daily/2026-10-01.md`) and the
rule-health PR #1703 (`docs/reviews/rule-health/...`) both fail with
"tools/quality/format-scope.json is stale".

Measured at b28a5216a:

- 64,395 lines and 10,523 entries: 10,273 prettier-managed, 41 generated, 189 archive_immutable
  (162 under `.archive/` or `archive/`, 27 aria-kernel capture fixtures) and 20 runtime_evidence.
- 41 of the 89 first-parent merge commits on `main` from 2026-09-18 to b28a5216a changed it.
- The 209 `content_sha256` pins duplicate what git already shows in every diff, and they never
  enforced the property that matters, archive immutability: editing an archived file and
  regenerating re-pins the new bytes, and a new archive file stays unpinned until someone
  regenerates.
- The `/archive/` rule also matches `apps/sensor-service/src/archive/`, the live telemetry-archive
  module (7 tracked files, last changed 2026-09-05 in 465ccd7a1). It is classified
  archive_immutable, kept out of Prettier, and an immutability gate would forbid editing it.

Evidence:

- `tools/quality/quality.mjs:329-368` — `buildFormatScope` serialises `git ls-files --cached`
  through `classifyFormatFile` into the committed manifest.
- `tools/quality/quality.mjs:370-382` — `checkManifest` fails "is stale; regenerate it".
- `tools/quality/quality.mjs:404-410` — `getManagedFormatFiles` reads the committed copy, and
  `:413`, `:545`, `:570`, `:638` gate every format lane on its freshness.
- `tools/quality/quality.mjs:315-327` — `excluded` pins a `content_sha256` per excluded file.
- `tools/quality/quality.mjs:238` — `path.includes('/archive/')` catches the live module.
- `package.json:187` — `quality:format-scope:generate`.
- `.husky/pre-commit:62-65` — the hook tells the committer to regenerate the manifest.
- `.github/workflows/quality-gates.yml:174-184` — CI runs the freshness check on every PR.
- `tools/gates/format-scope-derived-scalars.spec.ts:145` — the gate spec re-runs the same check.

Rule: derived data is computed where it is read, not committed beside its source. The gate
enforces the property that matters, archives only grow, instead of a copy of the tree (CLAUDE.md
Architectural Approach: make it impossible, then make it automatic).

Fix direction: compute the scope in memory from `git ls-files --cached` and the classifier; delete
the manifest and its `generate` command; keep `format-scope check` (the ARIA kernel allowlists that
exact argv) as two checks, classifier totality over the tracked tree and archive immutability over
the change range (status A only for archive_immutable paths); narrow the archive rule to the
`.archive/` directory convention so the live sensor-service module is ordinary source.
