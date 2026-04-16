# `@aquaculture/eslint-rules`

Workspace-local ESLint plugin for the aquaculture platform. Each rule encodes a specific architectural invariant from CLAUDE.md or a canonical ADR — caught at lint time (tier-3 detectable) rather than at CI (tier-3 slower) or runtime (tier-4).

## Progressive rollout policy (plan v4 D.5)

New rules ship at `severity: "warn"` for ≥30 days. Calibration telemetry (override rate per rule) drives promotion to `error`:

- Override rate < 5% sustained over 30d → promote to `error`.
- Override rate > 50% over 2 weeks → auto-demote to `warn` + flag for rule refinement or retirement.

Telemetry source: `rule-telemetry` CI job (W8). Decision committed to `.claude/gates/rules.yaml` (W7).

## Current rules

| Rule | Severity | Since | Promote when | Closes |
|------|----------|-------|---------------|--------|
| `require-entity-schema` | warn | 2026-04-16 | override rate < 5% over 30d | ADR-011 Tier-4 → Tier-3 (plan v4 BLOCKER-8 sweep W2-W3) |

## Planned rules (per plan v4 + anti-pattern top-5)

Scheduled by upcoming week:

| Rule | Week | Purpose |
|------|------|---------|
| `no-inline-event-literal` | W5 (via `add-event` skill authoring) | Bans inline `{ eventType: ..., eventId: ... }` literals; forces `createBaseEvent()` factory. Currently enforced by branded `EventId` compile-time; this rule is a belt-and-braces check for non-typed invocation sites. |
| `no-direct-event-publish` | W7 | Bans raw `eventBus.publish()` outside `@platform/outbox`. Promotes outbox-only publish path from Tier-4 docs to Tier-3 detection. Closes DATA-HIGH-004 (9/12 services currently bypass outbox). |
| `no-raw-redis-on-tenant-data` | W7 | Bans direct Redis `SET`/`GET` on tenant-scoped keys without rate-limiter wrappers. Closes MT-CRITICAL-002 (fail-open-on-outage regression class). |
| `no-bare-tenant-query-key` | W6 (frontend) | Requires `createTenantQueryKey()` wrapper for every React Query `queryKey`. Closes FE-CRITICAL-001 (265 non-conforming sites in farm-module alone). |
| `require-create-base-event` | W5 | Requires events constructed via factory, not inline. |

## Rule file skeleton

Each rule at `rules/<name>.ts` uses `@typescript-eslint/utils` `RuleCreator`:

```ts
import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `<docs-url>/${name}.ts`,
);

export default createRule({
  name: '<kebab-case>',
  meta: {
    type: 'problem' | 'suggestion',
    docs: { description: '...' },
    schema: [ /* JSON schema for options */ ],
    messages: { /* message-id → template */ },
  },
  defaultOptions: [ /* ... */ ],
  create(context) {
    return { /* AST visitor per node type */ };
  },
});
```

See `rules/require-entity-schema.ts` as worked example.

## Wiring into the root config

Root `.eslintrc.json` gains a plugin entry + rule activation (W3 change, paired with the first rule rollout). Path resolution uses `eslint-plugin-aquaculture` convention — the workspace package is linked via root `package.json` devDependency.

```jsonc
{
  "plugins": ["@nx", "@typescript-eslint", "import", "aquaculture"],
  "overrides": [
    {
      "files": ["apps/**/src/**/*.entity.ts"],
      "rules": {
        "aquaculture/require-entity-schema": "warn"
      }
    }
  ]
}
```

## Testing rules

Each rule has a unit test at `tests/<rule>.spec.ts` using `@typescript-eslint/utils/ts-eslint`'s `RuleTester`. Conventions:

- Valid + invalid cases per rule.
- Messages asserted verbatim.
- Edge cases: multiple decorators, non-literal schema, nested object expressions.

See `rules/__tests__/require-entity-schema.spec.ts` (W2-D companion).

## References

- Plan: `/root/.claude/plans/declarative-riding-shamir.md` BLOCKER-20
- Anti-pattern scan: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-anti-patterns.md` — top-5 candidates for tier-1 promotion
- Gate manifest (W7): `.claude/gates/rules.yaml`
- Override protocol: `.claude/agents-enterprise-v2/_shared/tier-claim-syntax.md`
