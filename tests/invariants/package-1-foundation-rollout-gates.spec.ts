import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..');

const EVENT_STORE_BASELINE = 'apps/event-store-service/src/migrations/1800000000000-Baseline.ts';
const EVENT_STORE_FORWARD_MIGRATION =
  'apps/event-store-service/src/migrations/1800000001000-EventStoreTenantPositionContract.ts';
const PACKAGE_1_PLAN =
  'docs/plans/2026-05-30-apps-enterprise-maintenance-e2e-implementation-plan.md';

// Package 1 is explicitly forward-only: the existing day-one baseline must not
// be rewritten to hide repair DDL. Add a new forward migration instead.
const EVENT_STORE_BASELINE_SHA256 =
  '5b4430f7c517833aa649a0b5e0fc02361017497d2aeea1ef4471994ef084f770';

interface Finding {
  file: string;
  line: number;
  detail: string;
}

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function compactSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function lineForOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);

    if (stat.isDirectory()) {
      walkTsFiles(full, acc);
      continue;
    }

    if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }

  return acc;
}

function configRuntimeFiles(): string[] {
  const root = resolve(REPO_ROOT, 'apps/config-service/src');
  return walkTsFiles(root)
    .map((file) => relative(REPO_ROOT, file))
    .filter((file) => !file.includes('/database/migrations/'))
    .filter((file) => !file.includes('/__tests__/'))
    .filter((file) => !file.endsWith('.spec.ts'))
    .filter((file) => !file.endsWith('.test.ts'));
}

function findExactGlobalStringLiterals(relativePath: string): Finding[] {
  const sourceText = read(relativePath);
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === 'global'
    ) {
      findings.push({
        file: relativePath,
        line: lineForOffset(sourceText, node.getStart(sourceFile)),
        detail: "'global' string literal",
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

function matchingLines(
  relativePath: string,
  checks: Array<{ pattern: RegExp; detail: string }>,
): Finding[] {
  const source = read(relativePath);
  const findings: Finding[] = [];

  for (const { pattern, detail } of checks) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      findings.push({
        file: relativePath,
        line: lineForOffset(source, match.index),
        detail,
      });
    }
  }

  return findings;
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map((finding) => `  - ${finding.file}:${finding.line} ${finding.detail}`)
    .join('\n');
}

describe('Package 1 foundation rollout gates', () => {
  it('does not rewrite the event-store day-one baseline migration', () => {
    const baseline = read(EVENT_STORE_BASELINE);

    expect(sha256(baseline)).toBe(EVENT_STORE_BASELINE_SHA256);
    expect(baseline).not.toContain('stored_events_global_position_seq');
  });

  it('adds event-store sequence and tenant-aware aggregate/version uniqueness in a forward migration', () => {
    const forwardPath = resolve(REPO_ROOT, EVENT_STORE_FORWARD_MIGRATION);
    expect(existsSync(forwardPath)).toBe(true);

    const sql = compactSql(read(EVENT_STORE_FORWARD_MIGRATION));

    expect(sql).toMatch(
      /CREATE SEQUENCE IF NOT EXISTS "event_store"\."stored_events_global_position_seq"/,
    );
    expect(sql).toMatch(/setval\(\s*'event_store\.stored_events_global_position_seq'/i);
    expect(sql).toMatch(
      /ALTER SEQUENCE IF EXISTS "event_store"\."stored_events_global_position_seq" OWNED BY "event_store"\."stored_events"\."globalPosition"/,
    );
    expect(sql).toMatch(/DROP INDEX IF EXISTS "event_store"\."IDX_aebc68416a5ae504289cb6893d"/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "UQ_stored_events_tenant_aggregate_version" ON "event_store"\."stored_events" \("tenantId", "aggregateType", "aggregateId", "version"\)/,
    );
  });

  it('uses the canonical tenant projection key for projection registry, locks, and intervals', () => {
    const servicePath = 'apps/event-store-service/src/projections/projections.service.ts';
    const service = read(servicePath);

    expect(service).toMatch(
      /private\s+getProjectionKey\s*\(\s*tenantId:\s*string,\s*name:\s*string\s*\):\s*string/,
    );

    const findings = matchingLines(servicePath, [
      {
        pattern: /registeredProjections\.get\(\s*name\s*\)/g,
        detail: 'registeredProjections lookup by name instead of getProjectionKey(tenantId, name)',
      },
      {
        pattern: /registeredProjections\.set\(\s*name\s*,/g,
        detail: 'registeredProjections set by name instead of getProjectionKey(tenantId, name)',
      },
      {
        pattern: /const\s+lockKey\s*=\s*`[^`]*\$\{name\}[^`]*\$\{tenantId\}[^`]*`/g,
        detail: 'processing lock key is hand-rolled instead of getProjectionKey(tenantId, name)',
      },
      {
        pattern: /const\s+intervalName\s*=\s*`projection-\$\{name\}`/g,
        detail: 'scheduler interval key omits tenantId',
      },
      {
        pattern: /private\s+getProjectionTenantId\s*\(\s*name:\s*string\s*\)/g,
        detail: 'tenant lookup by projection name reintroduces name-only registry semantics',
      },
    ]);

    if (findings.length > 0) {
      throw new Error(
        `Projection tenant-key invariant violated:\n${formatFindings(findings)}\n\n` +
          'Use getProjectionKey(tenantId, name) for registration, lifecycle lookup, ' +
          'processing locks, scheduler interval names, cache invalidation, and loop dispatch.',
      );
    }

    expect(findings).toEqual([]);
  });

  it("does not use string tenant sentinel 'global' in config-service runtime code", () => {
    const findings = configRuntimeFiles().flatMap(findExactGlobalStringLiterals);

    if (findings.length > 0) {
      throw new Error(
        `Config-service runtime still uses the string tenant sentinel 'global':\n` +
          `${formatFindings(findings)}\n\n` +
          'Use the canonical system tenant UUID constant for system/global configuration rows.',
      );
    }

    expect(findings).toEqual([]);
  });

  it('documents platform.release_ledger as the rollout source of truth until observability audit is complete', () => {
    const plan = read(PACKAGE_1_PLAN);

    expect(plan).toContain(
      '`platform.release_ledger` is the current rollout SOT; observability migration',
    );
    expect(plan).toContain(
      'Observability migration audit reads are platform-owned and must not become an',
    );
    expect(plan).toMatch(/until then,\s+release ledger remains\s+canonical/);
    expect(plan).toContain('`platform.release_ledger.expected_heads` equals `applied_heads`');
  });
});
