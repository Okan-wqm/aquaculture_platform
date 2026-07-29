/**
 * INVARIANT: every route's response shape has a NAME.
 *
 * # The defect this catches
 *
 * A handler that declares `Promise<{ … }>` publishes a contract that nothing can
 * refer to. It cannot be imported by a sibling service, it cannot be pinned by a
 * spec, and — the part that costs — it cannot be GENERATED from, so the admin
 * panel has to re-declare it by hand and the two copies drift with nothing
 * holding them together.
 *
 * The evidence is in the names the panel chose. `services/types/security.ts`
 * carried `BackendSecurityHealthScore`, `BackendSecurityDashboardStats`,
 * `BackendSecurityEvent` and eight more `Backend*` interfaces: the prefix is an
 * admission that "the backend's version" was sitting beside "the panel's
 * version" in one file. Every one of them shadowed either an entity or an
 * anonymous return shape.
 *
 * It is also how a vocabulary gets lost. `getSecurityEventStats` returned
 * `byThreatLevel: Record<string, number>` — the keys ARE `ThreatLevel` values,
 * but an inline shape written in a hurry reaches for `string`, and then no
 * consumer can enumerate the buckets.
 *
 * # What is enforced
 *
 * No controller method may declare an anonymous object literal as its return
 * type. Name it beside the service that produces it, and the panel can generate
 * from it via `tools/codegen/admin-contracts`.
 *
 * There is no allowlist. Every offender in `admin-api-service` was named, so the
 * rule is complete rather than aspirational — and a rule with exceptions is how
 * the next one gets added.
 *
 * # Scope
 *
 * `apps/admin-api-service` only, deliberately. The admin panel is the surface
 * whose contracts this codegen owns; extending the rule to the other services
 * means auditing their consumers too, which is separate work and would have to
 * start by allowlisting what it had not yet reached.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Controller files under admin-api-service, tests excluded. */
function controllerFiles(): string[] {
  const out = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'apps/admin-api-service/src/**/*.controller.ts'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter((rel) => rel.length > 0 && !rel.includes('/__tests__/') && !rel.endsWith('.spec.ts'));
}

/** HTTP-method decorators that mark a controller method as a route. */
const ROUTE_DECORATOR = /^\s*@(Get|Post|Put|Patch|Delete)\(/;

/**
 * Routes in `source` whose handler declares NO return type.
 *
 * Walks from each route decorator to the method signature, then to the line
 * that opens the body — a signature can span many lines when the parameters are
 * decorated, so the whole span is what gets checked for a `):` annotation.
 */
function undeclaredRouteCount(source: string): number {
  const lines = source.split('\n');
  let count = 0;

  lines.forEach((line, index) => {
    if (!ROUTE_DECORATOR.test(line)) return;

    let start = index;
    while (start < lines.length && !/^\s+(?:async\s+)?\w+\(/.test(lines[start]!)) {
      start++;
    }
    if (start >= lines.length) return;

    const signature: string[] = [];
    for (let cursor = start; cursor < lines.length && cursor < start + 25; cursor++) {
      signature.push(lines[cursor]!);
      if (/\)\s*(:\s*[^{]+)?\{\s*$/.test(lines[cursor]!)) break;
    }

    if (!/\):\s*(Promise<|[A-Z])/.test(signature.join('\n'))) count++;
  });

  return count;
}

describe('INVARIANT: a route response shape is a named type', () => {
  const files = controllerFiles();

  it('finds the controllers to check', () => {
    // Guards against the glob silently matching nothing, which would make every
    // assertion below vacuously true.
    expect(files.length).toBeGreaterThan(20);
  });

  it('no controller method returns an anonymous object literal', () => {
    const offenders: string[] = [];

    for (const rel of files) {
      const lines = readFileSync(resolve(REPO_ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, index) => {
        // An object literal ANYWHERE in the return type, not just immediately
        // inside `Promise<`. `Promise<Array<{ query: string; … }>>` is the same
        // defect one layer down, and the first version of this rule missed it —
        // four performance-monitoring methods were shipping anonymous array
        // elements while passing.
        //
        // Matching the closing paren of the parameter list rules out a
        // `Promise<{` that appears inside a local annotation or a generic
        // argument elsewhere on the line.
        if (/\):\s*(?:Promise<)?[^{]*\{/.test(line) && !/\):\s*[A-Za-z_$][\w$.<>[\]|\s,'"-]*\{\s*$/.test(line)) {
          offenders.push(`${rel}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} route(s) declare an anonymous response shape.\n` +
          `An unnamed contract cannot be imported, pinned, or generated from, so the\n` +
          `admin panel has to re-declare it by hand. Name the interface beside the\n` +
          `service that produces it and add a manifest line if the panel consumes it.\n\n` +
          offenders.join('\n'),
      );
    }
  });

  it('the count of routes with NO declared return type only ever falls', () => {
    // A weaker form of the same defect, and a far larger one: 309 of 555 admin
    // routes declared no return type at all. Their contract is not merely
    // unnamed — it is unstated, inferred from whatever the service happens to
    // return, so a change inside the service silently changes the wire and the
    // panel's type is pure invention.
    //
    // 186 of those remain, and naming them means settling 19 controllers'
    // contracts against their consumers. That is real work, not a rename, so it
    // cannot land in one reviewable change.
    //
    // This is a RATCHET, not an allowlist. An allowlist says "these files are
    // exempt" and rots. This asserts the EXACT count per file: a file absent
    // from the budget must be at zero and can never regress, and a file in the
    // budget fails the moment its count changes in EITHER direction — so fixing
    // a route forces the number down, and adding one is caught immediately.
    // The debt is published here rather than hidden, and it can only shrink.
    //
    // Tracked as ADMIN-HIGH-093. When a file reaches zero, delete its line.
    const BUDGET: Readonly<Record<string, number>> = {
      'apps/admin-api-service/src/billing/billing.controller.ts': 4,
      'apps/admin-api-service/src/database-management/controllers/backup.controller.ts': 10,
      'apps/admin-api-service/src/database-management/controllers/explorer.controller.ts': 5,
      'apps/admin-api-service/src/database-management/controllers/migration.controller.ts': 9,
      'apps/admin-api-service/src/database-management/controllers/monitoring.controller.ts': 9,
      'apps/admin-api-service/src/database-management/controllers/schema.controller.ts': 12,
      'apps/admin-api-service/src/health/health.controller.ts': 4,
      'apps/admin-api-service/src/metrics/system-metrics.controller.ts': 4,
      'apps/admin-api-service/src/modules/modules.controller.ts': 12,
      'apps/admin-api-service/src/security/controllers/activity-log.controller.ts': 3,
      'apps/admin-api-service/src/security/controllers/audit-trail.controller.ts': 1,
      'apps/admin-api-service/src/security/controllers/compliance.controller.ts': 2,
      'apps/admin-api-service/src/settings/controllers/email-template.controller.ts': 13,
      'apps/admin-api-service/src/settings/controllers/ip-access.controller.ts': 12,
      // `tenant-configuration.controller.ts` was the largest entry here at 39.
      // It is gone: config-service owns tenant configuration, so the routes were
      // deleted rather than annotated. Declaring return types on 39 handlers
      // whose service threw 410 Gone would have documented a contract nothing
      // could honour.
      'apps/admin-api-service/src/settings/settings.controller.ts': 9,
      'apps/admin-api-service/src/support/controllers/onboarding.controller.ts': 16,
      'apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts': 18,
      'apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts': 27,
      'apps/admin-api-service/src/users/users.controller.ts': 15,
    };

    const actual: Record<string, number> = {};
    for (const rel of files) {
      const count = undeclaredRouteCount(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
      if (count > 0) actual[rel] = count;
    }

    // Compared as whole objects so the diff names every file that moved, in
    // both directions, rather than failing on the first.
    expect(actual).toEqual(BUDGET);
  });

  it('the debug-tools controller is at zero, and stays there', () => {
    // The domain closed with the cache inspector rewrite: 21 routes annotated
    // and 8 deleted outright — the three that captured into tables nothing
    // wrote, and the pair that could not be reached because a parameterized
    // route was declared before its literal sibling.
    const rel = 'apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts';
    expect(undeclaredRouteCount(readFileSync(resolve(REPO_ROOT, rel), 'utf8'))).toBe(0);
  });

  it('the impersonation controller is at zero, and stays there', () => {
    // The domain closed in this slice: 17 routes annotated, three inline shapes
    // named (`ImpersonationEligibility`, `ImpersonationValidation`,
    // `ActiveSessionCount`). It is absent from the budget above, so the
    // whole-object comparison already forbids a regression — this asserts it by
    // name so the intent survives a careless budget edit.
    const rel = 'apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts';
    expect(undeclaredRouteCount(readFileSync(resolve(REPO_ROOT, rel), 'utf8'))).toBe(0);
  });

  it('the security histograms are keyed by their vocabularies, not by string', () => {
    // The specific loss this rule prevents: an inline shape reaches for
    // `Record<string, number>` and the bucket vocabulary stops being expressible.
    const service = readFileSync(
      resolve(
        REPO_ROOT,
        'apps/admin-api-service/src/security/services/security-monitoring.service.ts',
      ),
      'utf8',
    );

    for (const [shape, key] of [
      ['SecurityEventStats', 'ThreatLevel'],
      ['IncidentStats', 'IncidentStatus'],
      ['ThreatIntelStats', 'ThreatIndicatorType'],
    ] as const) {
      const body = new RegExp(`export interface ${shape} \\{([\\s\\S]*?)\\n\\}`, 'm').exec(
        service,
      )?.[1];
      if (body == null) throw new Error(`interface ${shape} not found`);
      expect(body).toContain(key);
      expect(body).not.toMatch(/Record<string, number>/);
    }
  });
});
