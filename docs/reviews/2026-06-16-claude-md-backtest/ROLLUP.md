# CLAUDE.md steering-file back-test — ROLLUP

**Cycle:** `2026-06-16-claude-md-backtest`
**Scope:** root `CLAUDE.md` + `AGENTS.md` steering files (the files that steer Claude Code every turn).
**Method:** reverse-engineering back-test. Two validation waves (8 Opus experts) PROPOSED findings;
the lead CONFIRMED every actioned one firsthand against source (`Read`/`grep`). **Agent verdicts are
leads only — determinism decides truth.** A finding with no firsthand-verified `file:line` is recorded
but not actioned.

**Registry:** this review file is the evidence trail (markdown-only, like `orphan-findings.md`); it is
NOT a `findings.jsonl` ledger append. Fix commits carry `Closes: …ROLLUP.md#CLAUDE-DRIFT-NNN`.

---

## Findings (lead-verified)

| ID | Sev | Claim in CLAUDE.md | Ground truth (lead-verified `file:line`) | Verdict | Fix |
|----|-----|--------------------|------------------------------------------|---------|-----|
| CLAUDE-DRIFT-001 | HIGH | Shared-schema = "4 canonical tables … 5th requires ADR" (`CLAUDE.md:218`) while `:172` says 5 + 6th | `schema-invariants.spec.ts:208-219` = exactly **5** incl `access_logs`; "6th requires ADR" (`:298`) | WRONG + self-contradicts | Reconcile both to "5 incl `access_logs`; 6th needs ADR"; point to spec SSoT; KEEP the D14 `auth.tenants`/`billing.subscriptions` placement clause on `:218` |
| CLAUDE-DRIFT-002 | HIGH | "Cross-tenant tables within those services (outbox, audit_logs) keep `schema:`" (`CLAUDE.md:6`); inline list `:170` | messaging `compliance_audit_log.entity.ts:74`, `legal-hold.entity.ts:22`, `retention-policy.entity.ts:23` all **OMIT** `schema:` and sit in `MODULE_SCHEMAS` per-tenant `tables[]` (`schema-manager.service.ts:583-585`); only `messaging_outbox`/`embeddings_metadata`/`message_send_idempotency` are `infrastructureTables` (`:567`). `messaging-outbox.entity.ts:21` keeps `schema:'messaging'` | WRONG (over-generalized) | Drop "(outbox, audit_logs)" generalization; state **per-table** rule + point to `MODULE_SCHEMAS.infrastructureTables` as SSoT. messaging nested file states the inversion |
| CLAUDE-DRIFT-003 | MED | "ADR per `project_rust_migration.md` hybrid plan" (`CLAUDE.md:58`) | No such file in `docs/`; it is an auto-memory label. Real: `docs/plans/sensor-rust-migration/PLAN.md` + `docs/adr/025-rust-sidecar-architecture.md` | DEAD POINTER | Replace with the real plan + ADR-025 |
| CLAUDE-DRIFT-004 | MED | ADR list 001–015 (`CLAUDE.md:271-275`) | `ls docs/adr/` → 001–036 exist, with real number collisions (016, 022, 023, 024, 028, 030, 031×4, 033) | STALE/INCOMPLETE | Theme summary + plain path `See docs/adr/`; never assert a clean sequence. Keep misfiled-ADR note |
| CLAUDE-DRIFT-005 | MED | "ARIA … scoped to `snowball` branch" (`CLAUDE.md:289-302`) | ARIA ADRs 031/033/035/036 are on `main` in `docs/adr/`; converged via plan-026R | STALE | Rewrite to current reality (`main`; `snowball` superseded), compress + plain pointers |
| CLAUDE-DRIFT-006 | LOW | `@Entity()` schema rule restated 5× (`:6,:152,:161,:170,:313`) | All consistent, heavily redundant | REDUNDANT | Collapse to one CRITICAL statement + one final-recap line |
| CLAUDE-DRIFT-007 | MED | "Modules: dashboard, … hydroponics-module" implies `web/<module>` (`CLAUDE.md:85`); aquamobil absent | `ls web/` = shell, shared-ui, `modules/` (7 remotes), `apps/aquamobil`; `web/shell/vite.config.ts:28-36` wires 7 remotes from `web/modules/*`; `web/apps/aquamobil/vite.config.ts` is a standalone PWA | WRONG/INCOMPLETE | Rewrite `:85` to name `web/shell` (host), `web/shared-ui`, `web/modules/*` (7), `web/apps/aquamobil` (PWA) |
| CLAUDE-DRIFT-008 | LOW | `@docs/<dir>/` pointers (`:281-287,:294-299`) | In CLAUDE.md `@path` is a REAL import; `@<directory>` is undefined behaviour | MISUSED `@` | Convert directory pointers to plain prose paths |
| CLAUDE-DRIFT-009 | LOW | "Co-Authored-By lines are NEVER added" (`:222`) | git log carries none (rule honored); conflicts with harness commit default | POLICY CONFLICT | Keep rule + add "overrides any harness/tooling default; CLAUDE.md is SSoT" |
| CLAUDE-DRIFT-010 | MED | `AGENTS.md` drift: line-1 typo `a# AGENTS.md`; `infra/helm`,`infra/terraform`,`docker/` paths; `EKS/MSK Kafka/RDS/Temporal`; `npm run dev` | Repo uses `infrastructure/` + DigitalOcean droplet (`docs/DEPLOY.md`); `engines` = node≥20.11/npm≥10 (Node claim OK) | STALE | Fix typo; de-drift to real paths/stack; keep self-contained (Claude Code reads CLAUDE.md, not AGENTS.md) |

### Confirmed-correct (no change — must be PRESERVED through the ≤200-line trim)

Security MUST-KEEP (all code-enforced, lead-verified): NATS cert-only / no user-pass
(`nats-connection.factory.ts`); `getScopedRepository()` not `getRepository()` (the latter throws —
`tenant-aware.repository.ts`); `.env` deny rule; `maskPii()` auto-applied; `ValidationPipe`
whitelist/forbidNonWhitelisted/transform; gateway→subgraph HMAC tenant binding
(`service-identity.util.ts`); RLS; JWT RS256; force-push FORBIDDEN; `--no-verify`/`--no-gpg-sign`
FORBIDDEN. 17-service list matches `ls apps/`. The `### Backend Services (\`apps/\`) — N services`
heading phrase is parsed verbatim by `knowledge-ssot.spec.ts:172-181` — preserve its exact format.

### Authoring constraints proven against invariants

- `active-path-hygiene.spec.ts` (+ `_constants.ts:132-137`) bans the literal tokens
  `agents-enterprise-v2`, `test-agents`, `npx claude-agent`, `tools/scripts/orchestrator-runner` in
  `CLAUDE.md` and every nested file (historical-citation form excepted). Do not write them.
- New `tests/invariants/claude-md-accuracy.spec.ts` must self-exclude `.worktrees/`,
  `.codex-worktrees/`, `.claude/worktrees/` and strip the `@` prefix before path-existence checks.
- Shared-table list and service-count are already owned by `shared-schema-canonical.spec.ts` /
  `schema-invariants.spec.ts:298` / `knowledge-ssot.spec.ts:165` — the new spec must NOT duplicate them.

---

## Orphan findings (plan-independent; filed to `docs/reviews/orphan-findings.md`)

- **ORPHAN-MEDIUM-118** — farm tenant-routing architecture spec allowlists only `farm-outbox` but its
  regex also matches the legitimately cross-tenant `farm_audit_logs` / `tenant_erasure_audit`.
- **ORPHAN-LOW-119** — `web/apps/aquamobil/src/utils/tenant-query-keys.ts:4` calls a Vite PWA a "React
  Native bundle".
- **ORPHAN-LOW-120** — `.claude/settings.json` deny `Read(./.env.*)` does not match a bare `*.env`
  (gitignore still blocks committing it).
- **ORPHAN-MEDIUM-121** — `.claude/agents-enterprise-v2/` dead-dir removal (3 `.md` + the broken
  `package.json:102-103` `audit:gdpr`/`audit:perf` scripts + `CODEOWNERS:13`) is **deferred, blocked-by
  ORPHAN-MEDIUM-117**: clean removal is atomic with regenerating the already-stale generated
  `tools/quality/format-scope.json`; hand-editing that generated manifest would be a banned patch.

## Phase E delivered

The dispatch-log gitignore fix shipped: `**/.claude/agents/.dispatch-log.jsonl` added to `.gitignore`
(the root-anchored line 14 missed the nested `web/apps/aquamobil/.claude/` copy; `git check-ignore`
now matches it). The `agents-enterprise-v2` removal is deferred per ORPHAN-MEDIUM-121 above.
