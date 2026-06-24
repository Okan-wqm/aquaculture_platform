/**
 * Farm GraphQL Backend Surface — shared SSoT extractor
 * ============================================================================
 *
 * SINGLE source of truth for "which GraphQL fields does the farm-service
 * subgraph serve, and from which resolver decorator". Both invariants below
 * consume THIS module instead of each re-implementing the decorator scan:
 *
 *   - farm-graphql-fe-be-parity.spec.ts      → every FE root field has a BE owner
 *   - farm-graphql-resolver-field-uniqueness.spec.ts → every BE root field has
 *                                                       exactly ONE owner
 *
 * Why a shared module (2026-06-24): the parity spec collapsed the backend
 * surface into a `Set<string>`, which silently DEDUPED two resolvers declaring
 * the same `@Query(name: 'availableTanks')`. NestJS code-first then built the
 * schema non-deterministically (last-registered-wins), producing intermittent
 * `Unknown argument "siteId"` 400s. Duplicating the extractor regex into a
 * second spec would be a hand-copied catalog (the exact anti-pattern the SSoT
 * audit flags), so the scan lives here once and returns location-rich records
 * the uniqueness gate needs.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Repo root, resolved from this file's location (tests/invariants/helpers). */
export const REPO_ROOT = join(__dirname, '..', '..', '..');

/** farm-service backend source tree (resolver decorators live here). */
export const BE_SOURCE_ROOT = 'apps/farm-service/src';

export type BackendResolverKind = 'Query' | 'Mutation' | 'Subscription' | 'ResolveField';

export interface BackendResolverField {
  /** GraphQL operation kind the decorator declares. */
  kind: BackendResolverKind;
  /** The GraphQL field name (honouring `{ name: '...' }` overrides). */
  field: string;
  /** Repo-relative source file. */
  file: string;
  /** 1-based line of the decorator. */
  line: number;
}

/** git-tracked files under `root` matching `patterns`, filtered to existing. */
export function listFiles(root: string, patterns: string[]): string[] {
  const out = execFileSync('git', ['ls-files', ...patterns.map((p) => `${root}/${p}`)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((file) => existsSync(join(REPO_ROOT, file)));
}

/**
 * Extract every GraphQL field served by farm-service resolver decorators,
 * with source location. This is the SSoT scan; derived views build on it.
 *
 * Decorator args may contain one level of nested parens: `(() => Type, { … })`.
 * Decorators may be interleaved between the field decorator and the method
 * (e.g. `@Query(...) @Roles(...) async foo()`), so they are skipped.
 */
export function extractBackendResolverFields(): BackendResolverField[] {
  const fields: BackendResolverField[] = [];
  const decoratorArgs = String.raw`(?:[^()]|\([^()]*\))*`;
  const interleaved = String.raw`(?:@[A-Za-z]+\s*\((?:[^()]|\([^()]*\))*\)\s*)*`;
  const re = new RegExp(
    String.raw`@(Query|Mutation|Subscription|ResolveField)\s*\((${decoratorArgs})\)\s*${interleaved}(?:async\s+)?([A-Za-z0-9_]+)\s*\(`,
    'g',
  );

  for (const file of listFiles(BE_SOURCE_ROOT, ['**/*.ts'])) {
    if (file.includes('.spec.') || file.includes('__tests__')) continue;
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      const named = match[2]!.match(/name:\s*'([^']+)'/);
      fields.push({
        kind: match[1]! as BackendResolverKind,
        field: named ? named[1]! : match[3]!,
        file,
        line: src.slice(0, match.index).split('\n').length,
      });
    }
  }
  return fields;
}

/**
 * Flat set of every field name the farm subgraph serves (all decorator kinds).
 * Backward-compatible view consumed by the FE↔BE parity gate.
 */
export function extractBackendFieldSet(): Set<string> {
  return new Set(extractBackendResolverFields().map((f) => f.field));
}
