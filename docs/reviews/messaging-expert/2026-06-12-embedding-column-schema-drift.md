# messaging-service: background query references non-existent m.embedding column (2026-06-12)

## ORPHAN-MEDIUM-055 — `column m.embedding does not exist` every 5 minutes in messaging E2E

**Severity:** MEDIUM · **Layer:** messaging data · **Owner:** messaging-expert
**Discovered:** in the E2E Messaging Postgres logs during B2 (#411) gating —
plan-independent orphan finding.

### Observation

The messaging-service E2E Postgres instance logs, on a fixed 5-minute
cadence (12:50 / 12:55 / 13:00 / 13:05 …):

```
ERROR: column m.embedding does not exist at character 138
        WHERE m."embedding" IS NULL
```

A periodic background worker / projection issues a query filtering on
`m."embedding" IS NULL`, but the column does not exist in the schema the
E2E migrations apply. The 5-minute cadence implies a scheduled job (an
embedding-backfill / semantic-index sweep) running against a schema whose
`embedding` column migration was never applied (or was reverted) in the
E2E environment.

This is independent of B2 (which touches zero messaging/embedding code) and
predates it — it appears on every messaging E2E run.

### Why MEDIUM (not HIGH)

It is a logged error, not a crash, and the sweep no-ops (the rows it would
touch don't exist). But it is a real query↔migration drift: either the
column SHOULD exist (a migration is missing from the E2E path → the feature
is silently dead) or the background sweep SHOULD be gated off when the
column is absent (it is firing blindly). Both are SSOT violations between
the query author and the schema owner.

### Root-cause direction (owner + follow-up)

messaging-expert to determine which side is authoritative:
- If embeddings are a shipped feature → the `embedding` column migration
  must be in the messaging-service migration set the E2E harness runs
  (schema-drift validator should already catch this at boot — check why it
  doesn't fire here).
- If embeddings are not yet shipped → the background sweep must be feature-
  flagged off until the column lands (no blind 5-minute error spew).

Pairs with [[ORPHAN-HIGH-092]] (same E2E log surface). Tracked, not
deferred-without-owner.

### Tier

Tier-1 candidate: if embeddings ship, the SchemaDriftValidator (ADR-012)
should make a missing required column a fail-closed boot error rather than
a runtime query error — investigate why it passes here.
