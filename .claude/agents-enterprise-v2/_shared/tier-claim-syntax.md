# Tier-Claim Syntax + Override Grammar

**Audience:** every enterprise-v2 agent (CATCHER verifies, TEACHER explains, WRITER emits). Also consumed by `tools/gates/tier-claim-lint.ts` (W7) and `root-cause-auditor` (W9).

## The 4-tier hierarchy (from CLAUDE.md)

| Tier | Name | Example |
|------|------|---------|
| 1 | Make it impossible | Branded type, DB constraint, exhaustive `switch (state: never)` |
| 2 | Make it automatic | Runtime guard, generated code, default-safe API shape |
| 3 | Make it detectable | ESLint rule, CI invariant test, schema-drift validator |
| 4 | Documented only | Comment, runbook, ADR — REVIEWER attention required |

**Rule:** always pick the highest tier that applies. Tier-4 is a last resort, acceptable only when Tiers 1-3 are genuinely impossible or when the change is a narrowly-scoped boundary.

## Inline tier claim (author annotation)

Place above a statement or a small block. Grammar:

### Single-statement claim

```ts
// tier-1: branded TenantId type enforced at every repository boundary
const t: TenantId = parseTenantId(raw);
```

- Single line, within 3 lines above the claimed statement.
- Content MUST reference a specific mechanism (branded type name, ESLint rule ID, invariant test, etc.) — vague claims fail `tier-claim-lint.ts`.

### Block claim

```ts
// tier-2-begin: migration runner auto-syncs this schema change on boot
@Column('uuid', { nullable: false, default: 'gen_random_uuid()' })
tenantId: TenantId;
// tier-2-end
```

- Multi-statement claims use `-begin` / `-end` sentinels.
- Claims span contiguous lines only — nested claims forbidden.

### Validation

- `tools/gates/tier-claim-lint.ts` runs in the Tier-1 pre-commit gate (W7):
  - Rejects syntax errors (missing `-end`, malformed tier number, empty justification).
  - Rejects tier-4 claims on `apps/**/src/**` domain-code paths unless the file is in `.claude/allowlists/boundary-files.yaml`.
- `root-cause-auditor` agent (W9) re-classifies independently; flags `OVER_CLAIMED` where author claimed Tier-1 but auditor assesses Tier-3 (e.g., "claimed branded type but no branded type exists in repo").

## Banned phrases (CLAUDE.md, enforced by W7 pre-commit)

These phrases are forbidden in code comments AND commit bodies:

```
"for now" / "interim solution" / "temporary"
"pragmatic" / "simpler approach" / "middle ground"
"for momentum" / "just this commit"
"deferred" (unless followed by an explicit owner + deadline + finding ID)
"out of scope" (unless paired with an ADR or review reference)
"good enough" / "sufficient for now"
```

Exception — docs (`docs/adr/**`, `CHANGELOG.md`, `docs/reviews/**`) may legitimately discuss rejected alternatives using these phrases as historical record. `banned-phrase.ts` (W7) excludes these paths.

## Override protocol (tier-4 escape hatch)

When a tier-4 pattern is genuinely required (MQTT wire type, Stripe webhook shape, generated protobuf), use the inline override comment:

```ts
// auditor-override: AUDIT-042 | owner:@okan | deadline:2026-10-01 | tracked:docs/reviews/root-cause-auditor/2026-04-16-mqtt-boundary.md
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- OVERRIDE:AUDIT-042
const parsed = rawMqttPayload as any;
```

### Grammar

```
// auditor-override: <FINDING-ID> | owner:<@user> | deadline:<YYYY-MM-DD> | tracked:<docs-path>
```

- `FINDING-ID` — stable ID in the finding state registry (`docs/reviews/_registry/findings.jsonl`, W10). Format: `AUDIT-{NNN}` for auditor-raised findings; slice prefixes (`DATA-*`, `SEC-*`, etc.) for domain-specific.
- `owner` — GitHub handle of the person accountable for closing. CODEOWNERS-gated on `.claude/allowlists/**` routes to `@okan` by default.
- `deadline` — ISO date. After deadline, sweep workflow auto-transitions the finding to STALE (+1 severity next review cycle).
- `tracked` — markdown file capturing the full justification, architecture discussion, and acceptance criteria for lifting the override.

### Lifecycle

1. Author writes override inline + creates registry entry in `docs/reviews/_registry/findings.jsonl` (hash-chained; W10).
2. `commit-msg-validator.ts` (W7) verifies the finding ID exists in the registry AND the registry entry is in `BLOCKED` state AND the commit that registered the finding was signed.
3. CI `closes-footer` job cross-references override IDs in commits to ensure registry reflects reality.
4. Scheduled `finding-state-sweep.yml` (W10) runs daily: past-deadline overrides escalate.
5. Rate limit: max 3 active overrides per author per week (keyed by registry entry creator, not commit author, to defeat squash/rebase bypass).

### Boundary allowlist

Legitimate boundary patterns (MQTT deserializer, Stripe webhook, generated proto, zod validators) are declared in `.claude/allowlists/boundary-files.yaml` with:
- `path` — glob
- `reason` — one-line
- `owner` — `@okan`
- `expires` — ISO date (max 12 months) OR `never` (requires ADR reference)

Entries with `expires: never` bypass the override-per-commit requirement. The allowlist is CODEOWNERS-gated (BLOCKER-9) so a PR cannot add an entry without @okan review.

## References

- CLAUDE.md — 4-tier hierarchy + banned phrases + commit format
- `.claude/allowlists/boundary-files.yaml` — 19 seeded legitimate boundaries (W1 AMENDMENT-B)
- `/root/.claude/plans/declarative-riding-shamir.md` D.4 (override protocol) + BLOCKER-10 (trust chain hardening)
- `tools/gates/tier-claim-lint.ts` + `banned-phrase.ts` — W7 deliverables
- `tools/gates/commit-msg-validator.ts` + `finding-registry.ts` — W7 + W10
