/**
 * INVARIANT: a value computed by an accessor never leaves through a route.
 *
 * # The defect this catches
 *
 * `JSON.stringify` serializes OWN ENUMERABLE properties. A TypeScript `get x()`
 * on a class lives on the prototype, so it is neither own nor enumerable — it is
 * simply absent from the JSON. The type system says nothing: `Promise<Tenant>`
 * type-checks perfectly while the response ships without `tier`.
 *
 * `admin-api`'s `Tenant` entity aliases `plan` as a `tier` getter and computes
 * `limits` from PLAN_CATALOG in another. Five routes returned that entity —
 * `GET /admin/tenants/:id`, `/slug/:slug`, `/search`, `/expiring-trials` and the
 * four lifecycle mutations. Every one of those responses was missing both. The
 * impersonation target picker rendered `{tenant.name} ({tenant.tier})` over the
 * search route and printed `Acme ()` for every row; `useTenantSearch` fed the
 * same undefined into `.toLowerCase()`.
 *
 * Nothing detected it, because the failure is invisible on both sides: the
 * backend's type is satisfied, and the frontend's hand-written `Tenant` declared
 * the field too.
 *
 * # What is enforced
 *
 * A controller route may not declare an `@Entity()` class that has a getter as
 * its return type — directly, as an array, or wrapped in `Partial`/`Promise`.
 *
 * Scoped to entities WITH accessors on purpose. That is exactly the set whose
 * fields disappear, so the rule is complete for the defect and needs no
 * allowlist. The broader principle — a persistence object is never a response —
 * is real but is a wider migration: ~41 routes across reports, audit, security
 * and support still return entities that happen to serialize correctly today.
 * That breadth is tracked separately rather than allowlisted here, because an
 * allowlist would turn a complete rule into a list of exceptions.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Every tracked TypeScript file under a service's src tree. */
function trackedFiles(pattern: string): string[] {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', pattern], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter((line) => line.length > 0);
}

/**
 * Class bodies of `@Entity()`-decorated classes, keyed by class name.
 *
 * A body runs to the next top-level `export` declaration, which is enough to
 * scope accessor detection without parsing TypeScript.
 */
function entityBodies(files: string[]): Map<string, { file: string; body: string }> {
  const found = new Map<string, { file: string; body: string }>();
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    if (!src.includes('@Entity(')) continue;

    const decl = /@Entity\([^)]*\)[\s\S]{0,400}?export class (\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = decl.exec(src)) !== null) {
      const name = match[1];
      if (name == null) continue;
      const rest = src.slice(match.index + match[0].length);
      const next = /\nexport (class|interface|enum|type|const|function) /.exec(rest);
      found.set(name, { file: rel, body: next ? rest.slice(0, next.index) : rest });
    }
  }
  return found;
}

/** Class names among `entities` that declare a `get`/`set` accessor. */
function withAccessors(entities: Map<string, { file: string; body: string }>): Set<string> {
  const names = new Set<string>();
  for (const [name, { body }] of entities) {
    if (/^\s{2}(?:public\s+|protected\s+)?(?:get|set) \w+\s*\(/m.test(body)) {
      names.add(name);
    }
  }
  return names;
}

const SERVICE_SRC = 'apps/admin-api-service/src/**/*.ts';

describe('INVARIANT: an entity with accessors is not a response type', () => {
  const files = trackedFiles(SERVICE_SRC);
  const entities = entityBodies(files);
  const accessorEntities = withAccessors(entities);

  it('finds the entities whose fields would vanish on serialize', () => {
    // A sanity anchor, not a pin: if admin-api ever has zero accessor entities
    // the rule below is vacuous and this test says so out loud rather than
    // passing silently.
    expect(entities.size).toBeGreaterThan(0);
    expect(accessorEntities.size).toBeGreaterThan(0);
  });

  it('no controller route returns one', () => {
    const controllers = files.filter(
      (rel) => rel.endsWith('.controller.ts') && !rel.includes('/__tests__/'),
    );
    expect(controllers.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const rel of controllers) {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, index) => {
        // `Promise<X>`, `Promise<X[]>`, `Promise<Partial<X>>`, `Promise<Omit<X, …>>`
        const returns = /:\s*Promise<\s*(?:Partial<|Omit<|Pick<)?\s*(\w+)/.exec(line);
        const name = returns?.[1];
        if (name != null && accessorEntities.has(name)) {
          offenders.push(`${rel}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} route(s) return an entity whose accessors do NOT survive JSON.stringify.\n` +
          `Those fields are silently absent from the response. Return a projection DTO\n` +
          `built by a mapper (see apps/admin-api-service/src/tenant/dto/tenant-summary.dto.ts).\n\n` +
          `Entities with accessors: ${[...accessorEntities].sort().join(', ')}\n\n` +
          offenders.join('\n'),
      );
    }
  });

  it('the tenant read contract materializes every accessor it replaces', () => {
    // The specific cure, pinned: `toTenantSummary` reads the COLUMN (`plan`),
    // not the getter, so the value is an own property of a plain object.
    const dto = readFileSync(
      resolve(REPO_ROOT, 'apps/admin-api-service/src/tenant/dto/tenant-summary.dto.ts'),
      'utf8',
    );
    expect(dto).toMatch(/export function toTenantSummary\(tenant: Tenant\): TenantSummaryDto/);
    expect(dto).toMatch(/tier: tenant\.plan,/);
    expect(dto).not.toMatch(/tier: tenant\.tier,/);
  });

  it('every tenant read route goes through that mapper', () => {
    const handlers = readFileSync(
      resolve(REPO_ROOT, 'apps/admin-api-service/src/tenant/query-handlers/tenant-query.handlers.ts'),
      'utf8',
    );
    // by-id, by-slug, search, expiring-trials — plus the list, via toTenantListItem.
    expect(handlers.match(/toTenantSummary/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(handlers).toContain('toTenantListItem(');
    // No handler may hand a repository row straight back.
    expect(handlers).not.toMatch(/return this\.tenantRepository\.find\(/);
  });
});
