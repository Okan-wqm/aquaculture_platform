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
        // `): Promise<{`  — the return-type position of a handler signature.
        // Matching the closing paren rules out `Promise<{` appearing inside a
        // generic argument or a local variable annotation.
        if (/\):\s*Promise<\s*\{/.test(line)) {
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
