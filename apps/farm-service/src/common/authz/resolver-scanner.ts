/**
 * Resolver Scanner
 *
 * Walks every `*.resolver.ts` under `apps/farm-service/src/` and
 * extracts each root @Mutation / @Query's authorisation intent:
 *
 *   { operation: string, kind: 'Mutation'|'Query', roles: string[] }
 *
 * The scanner is regex-driven (not a full TypeScript AST) because
 * the @Roles / @Mutation / @Query decorator pattern in this codebase
 * is stylised: the decorator is always on its own line, the method
 * declaration that follows is always `async <name>(` or `<name>(`,
 * and role names are always `Role.XYZ`. The regex is anchored on
 * those conventions, and the invariant test fails loudly if the
 * pattern ever drifts — which is the safest way to catch a bad
 * decorator stack that might silently open up a mutation.
 *
 * Used by:
 *   - `permission-matrix.ts` at design time to snapshot the intent
 *     of the codebase into a single source of truth.
 *   - `permission-matrix.spec.ts` invariant test to guarantee the
 *     matrix stays in sync with the resolvers on every PR.
 *
 * Phase 6.1 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 15-C2.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

export interface ResolverOperation {
  /** Top-level GraphQL operation name (method name by default). */
  operation: string;
  kind: 'Mutation' | 'Query';
  /** Bare role tokens as written in the decorator (without the Role. prefix). */
  roles: string[];
  /** Absolute file path so test output can cite the offending line. */
  filePath: string;
  /** Class member line number (1-based). */
  line: number;
}

const DEFAULT_FARM_SERVICE_ROOT = resolve(
  __dirname,
  '..',
  '..',
  '..',
);

/**
 * Produce the sorted list of every root-level @Mutation / @Query in
 * the given farm-service source tree. When `rootDir` is omitted we
 * walk the tree relative to this file's compiled location, which
 * resolves to `apps/farm-service/src` in both dev and Jest runs.
 */
export function scanResolvers(rootDir: string = DEFAULT_FARM_SERVICE_ROOT): ResolverOperation[] {
  const resolverFiles = collectResolverFiles(rootDir);
  const ops: ResolverOperation[] = [];
  for (const file of resolverFiles) {
    ops.push(...extractOperationsFromFile(file));
  }
  ops.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'Mutation' ? -1 : 1;
    return a.operation.localeCompare(b.operation);
  });
  return ops;
}

function collectResolverFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') {
        continue;
      }
      collectResolverFiles(full, acc);
      continue;
    }
    if (stat.isFile() && entry.endsWith('.resolver.ts') && !entry.endsWith('.spec.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const ROLES_LINE_RE =
  /^\s*@Roles\(\s*([^)]*)\)\s*$/;
const MUTATION_OR_QUERY_LINE_RE =
  /^\s*@(Mutation|Query)\(/;
const METHOD_SIG_RE =
  /^\s*(?:public\s+|protected\s+|private\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*[(<]/;
const ROLE_TOKEN_RE = /Role\.([A-Z_]+)/g;
const NAME_OPTION_RE =
  /name\s*:\s*['"]([^'"]+)['"]/;

function extractOperationsFromFile(file: string): ResolverOperation[] {
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  const operations: ResolverOperation[] = [];

  let pendingRoles: string[] | null = null;
  let pendingKind: 'Mutation' | 'Query' | null = null;
  let pendingDecoratorLine = 0;
  let pendingNameOverride: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    // Track @Roles — only counts when it sits immediately above a
    // @Mutation/@Query. A @Roles above another decorator like
    // @Field simply lapses before it matches.
    const rolesMatch = ROLES_LINE_RE.exec(line);
    if (rolesMatch) {
      const raw = rolesMatch[1] ?? '';
      pendingRoles = Array.from(raw.matchAll(ROLE_TOKEN_RE)).map(
        (m) => m[1] ?? '',
      );
      continue;
    }

    const kindMatch = MUTATION_OR_QUERY_LINE_RE.exec(line);
    if (kindMatch) {
      pendingKind = kindMatch[1] as 'Mutation' | 'Query';
      pendingDecoratorLine = i + 1;
      // The whole decorator call may span multiple lines. Scan
      // forward for the closing `)` so we can read the `name:` option.
      let joined = line;
      let j = i;
      while (!joined.includes(')') && j < lines.length - 1) {
        j += 1;
        joined += '\n' + (lines[j] ?? '');
      }
      const nameMatch = NAME_OPTION_RE.exec(joined);
      pendingNameOverride = nameMatch?.[1] ?? null;
      continue;
    }

    const sigMatch = METHOD_SIG_RE.exec(line);
    if (sigMatch && pendingKind) {
      const methodName = sigMatch[1] ?? '';
      if (!methodName || methodName === 'constructor') {
        pendingRoles = null;
        pendingKind = null;
        pendingNameOverride = null;
        continue;
      }
      const operation = pendingNameOverride ?? methodName;
      operations.push({
        operation,
        kind: pendingKind,
        roles: pendingRoles ? [...pendingRoles].sort() : [],
        filePath: file,
        line: pendingDecoratorLine,
      });
      pendingRoles = null;
      pendingKind = null;
      pendingNameOverride = null;
    }
  }

  return operations;
}
