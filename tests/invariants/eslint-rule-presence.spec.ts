/**
 * Platform-wide invariant — AUDIT-MEDIUM-005 + historical IDOR findings:
 *
 * The root .eslintrc.json defines load-bearing lint rules that prevent
 * specific regression classes:
 *
 *   - `no-restricted-syntax::getRepository` — blocks the tenant-isolation
 *     bypass that caused the 2026-04 IDOR findings (AUDIT-HIGH-002/003/008).
 *   - `no-restricted-syntax::JWT_SECRET` — blocks reintroduction of the
 *     HS256 shared-secret vector closed in commit 7c076361
 *     (ADR-016 Phase B).
 *   - `no-restricted-imports::@aquaculture/backend-common` — keeps the
 *     root barrel split won by AUDIT-MEDIUM-005 phases 1-3.
 *
 * These rules were each added after a real incident. Losing any one of
 * them silently reopens the corresponding regression class, and in each
 * case the cost is paid at runtime (cross-tenant data leak / JWT
 * algorithm-confusion / wide build invalidation) — caught late or not at
 * all. This invariant runs on every PR in the fast shard so a
 * deletion / weakening of those rules fails CI at the config-diff step
 * rather than months later.
 *
 * What this invariant does NOT check:
 *   - Whether `nx affected -t lint` actually executes in CI (that is
 *     PROC-MEDIUM-006's responsibility — the amnesty flag on
 *     agentic-rust-unified still leaves this invariant live, which is
 *     deliberate).
 *   - Whether the rule fires on a crafted violation (rule-effect
 *     assertion — covered by targeted unit tests in tools/eslint-rules
 *     when rules graduate into that plugin).
 *   - Rule bodies in overrides that target narrower scopes — those are
 *     additive on top of the repo-wide rules validated here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface RestrictedSyntaxEntry {
  selector?: string;
  message?: string;
}

interface RestrictedImportsPath {
  name?: string;
  message?: string;
}

interface RestrictedImportsEntry {
  paths?: RestrictedImportsPath[];
}

interface EslintRule {
  rules?: Record<string, unknown>;
}

interface EslintConfig {
  overrides?: EslintRule[];
  rules?: Record<string, unknown>;
}

const REPO_ROOT = resolve(__dirname, '..', '..');

function loadConfig(): EslintConfig {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, '.eslintrc.json'), 'utf-8')) as EslintConfig;
}

function collectRule(cfg: EslintConfig, ruleName: string): unknown[] {
  const hits: unknown[] = [];
  if (cfg.rules?.[ruleName]) hits.push(cfg.rules[ruleName]);
  for (const o of cfg.overrides ?? []) {
    if (o.rules?.[ruleName]) hits.push(o.rules[ruleName]);
  }
  return hits;
}

function getRestrictedSyntaxSelectors(cfg: EslintConfig): string[] {
  const out: string[] = [];
  for (const hit of collectRule(cfg, 'no-restricted-syntax')) {
    if (!Array.isArray(hit)) continue;
    // hit[0] is severity, hit[1..] are entries
    for (const e of hit.slice(1) as RestrictedSyntaxEntry[]) {
      if (e?.selector) out.push(e.selector);
    }
  }
  return out;
}

function getRestrictedImportsPaths(cfg: EslintConfig): string[] {
  const out: string[] = [];
  for (const hit of collectRule(cfg, 'no-restricted-imports')) {
    if (!Array.isArray(hit)) continue;
    for (const e of hit.slice(1) as RestrictedImportsEntry[]) {
      for (const p of e?.paths ?? []) {
        if (p?.name) out.push(p.name);
      }
    }
  }
  return out;
}

describe('INVARIANT: root .eslintrc.json carries the load-bearing regression-guard rules', () => {
  const cfg = loadConfig();

  describe('no-restricted-syntax', () => {
    const selectors = getRestrictedSyntaxSelectors(cfg);

    it('blocks direct `getRepository()` calls (tenant-isolation bypass)', () => {
      const hit = selectors.find((s) => s.includes("callee.property.name='getRepository'"));
      expect(hit).toBeDefined();
    });

    it('blocks reading `JWT_SECRET` via ConfigService.get()', () => {
      const hit = selectors.find(
        (s) => s.includes("property.name='get'") && s.includes("arguments.0.value='JWT_SECRET'"),
      );
      expect(hit).toBeDefined();
    });

    it('blocks reading `JWT_SECRET` via ConfigService.getOrThrow()', () => {
      const hit = selectors.find(
        (s) =>
          s.includes("property.name='getOrThrow'") && s.includes("arguments.0.value='JWT_SECRET'"),
      );
      expect(hit).toBeDefined();
    });

    it('blocks reading `process.env.JWT_SECRET`', () => {
      const hit = selectors.find(
        (s) =>
          s.includes("object.property.name='env'") &&
          (s.includes("property.name='JWT_SECRET'") ||
            s.includes("property.value='JWT_SECRET'")),
      );
      expect(hit).toBeDefined();
    });
  });

  describe('no-restricted-imports', () => {
    const paths = getRestrictedImportsPaths(cfg);

    it('blocks the `@aquaculture/backend-common` root barrel (AUDIT-MEDIUM-005)', () => {
      expect(paths).toContain('@aquaculture/backend-common');
    });

    it('blocks the `@platform/backend-common` parity alias (AUDIT-MEDIUM-005)', () => {
      expect(paths).toContain('@platform/backend-common');
    });
  });
});
