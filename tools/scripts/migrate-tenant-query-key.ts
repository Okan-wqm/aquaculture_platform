#!/usr/bin/env node
/**
 * migrate-tenant-query-key — Phase 8.4 mass-migration codemod
 * ============================================================================
 *
 * FE-CRITICAL-001 remediation: transforms a TanStack-Query hooks file
 * from bare `queryKey: [...]` arrays to
 * `queryKey: createTenantQueryKey(tenantId, ...)` to close the
 * cross-tenant cache leak vector.
 *
 * What it does per file (idempotent on any given file):
 *
 *   1. Ensure `useAuth, createTenantQueryKey` are imported from
 *      `@aquaculture/shared-ui`. If the file already imports other
 *      symbols from shared-ui, extends the import list. If it has
 *      no shared-ui import at all, adds a dedicated one after
 *      the @tanstack/react-query import.
 *
 *   2. Inside every `export function use{Name}(...)` body, insert
 *      `const { tenantId } = useAuth();` as the first statement
 *      before the `return use{Query,Mutation}(` call.
 *
 *   3. Replace every `queryKey: [<first>, <rest>...]` with
 *      `queryKey: createTenantQueryKey(tenantId, <first>, <rest>...)`.
 *
 *   4. Ensure `enabled:` includes `!!tenantId` for every useQuery
 *      hook:
 *        - `enabled: !!id,`       → `enabled: !!id && !!tenantId,`
 *        - no `enabled:` present  → inserts `enabled: !!tenantId,`
 *                                    before the closing `});`.
 *
 * # Why this lives as a tracked script
 *
 * The 386-site mass migration lands in focused per-file commits.
 * Having the codemod on disk means every reviewer can replay it
 * against an unmigrated file and verify the diff matches a known
 * shape — eliminates "did the author hand-tweak the output?" as
 * a review concern.
 *
 * The ESLint rule `no-bare-tenant-query-key` (warn-mode until the
 * count hits zero) catches new regressions introduced outside the
 * codemod path.
 *
 * # Usage
 *
 *   ts-node --project tools/gates/tsconfig.json \
 *     tools/scripts/migrate-tenant-query-key.ts \
 *     web/modules/farm-module/src/hooks/useX.ts \
 *     web/modules/sensor-module/src/hooks/useY.ts
 *
 * # Not handled (requires hand-review)
 *
 *   - Nested queryKey arrays (rare; the regex uses negative-bracket
 *     character class which cannot match nested `[...]`).
 *   - Non-hook components that pass queryKey to useQuery via prop
 *     threading.
 *   - Files where tenantId is already destructured under a different
 *     name (the insert duplicates it; manual cleanup needed).
 */

import { readFileSync, writeFileSync } from 'node:fs';

interface MigrationResult {
  path: string;
  bareBefore: number;
  bareAfter: number;
  importAdded: boolean;
}

function countBareQueryKey(content: string): number {
  const matches = content.match(/queryKey:\s*\[/g);
  return matches ? matches.length : 0;
}

/** Ensure createTenantQueryKey + useAuth are imported.
 *
 * @param content - Source file text.
 * @param importSpec - Module specifier for the helper. Defaults to
 *                     @aquaculture/shared-ui (web/modules). aquamobil
 *                     passes @/utils/tenant-query-keys for the local
 *                     copy (useAuth is already ./useAuth in those
 *                     files so no additional import is added).
 */
function ensureSharedUiImport(
  content: string,
  importSpec = '@aquaculture/shared-ui',
): { content: string; added: boolean } {
  if (content.includes('createTenantQueryKey')) {
    return { content, added: false };
  }

  const sharedUiMode = importSpec === '@aquaculture/shared-ui';
  const wantedSymbols = sharedUiMode
    ? ['useAuth', 'createTenantQueryKey']
    : ['createTenantQueryKey'];

  // Try to extend an existing import from the same module.
  const esc = importSpec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const existingRx = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*'${esc}';`);
  const match = existingRx.exec(content);
  if (match && match[1] !== undefined) {
    const symbols = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sym of wantedSymbols) {
      if (!symbols.includes(sym)) symbols.push(sym);
    }
    const newImport = `import { ${symbols.join(', ')} } from '${importSpec}';`;
    return {
      content: content.replace(match[0], newImport),
      added: true,
    };
  }

  // No existing import — insert a new line after @tanstack/react-query.
  const anchorRx = /^(import\s+\{[^}]+\}\s+from\s+'@tanstack\/react-query';)$/m;
  const anchor = anchorRx.exec(content);
  if (anchor) {
    const insertion = `${anchor[0]}\nimport { ${wantedSymbols.join(', ')} } from '${importSpec}';`;
    return {
      content: content.replace(anchor[0], insertion),
      added: true,
    };
  }
  return { content, added: false };
}

/** Insert `const { tenantId } = useAuth();` inside each hook. */
function insertTenantIdDestructure(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inHook = false;
  let hookHasInsert = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (/^export function use[A-Z]\w*.*\{/.test(line)) {
      inHook = true;
      hookHasInsert = false;
      braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      out.push(line);
      continue;
    }
    if (inHook) {
      braceDepth += (line.match(/\{/g) ?? []).length;
      braceDepth -= (line.match(/\}/g) ?? []).length;
      if (braceDepth === 0) {
        inHook = false;
        out.push(line);
        continue;
      }
    }
    if (inHook && !hookHasInsert && /^\s*return (useQuery|useMutation)\(\{/.test(line)) {
      const indentMatch = /^(\s*)/.exec(line);
      const indent = indentMatch ? indentMatch[1] : '  ';
      // Skip if recent lines already destructured tenantId.
      const recent = out.slice(-25).join('\n');
      if (!/useAuth\(\).*tenantId|tenantId.*useAuth\(\)/s.test(recent)) {
        out.push(`${indent}const { tenantId } = useAuth();`);
      }
      hookHasInsert = true;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Replace bare queryKey arrays with createTenantQueryKey calls. */
function transformQueryKeys(content: string): string {
  return content.replace(/queryKey:\s*\[([^\[\]]*)\]/g, (_, inner: string) => {
    let trimmed = inner.trim();
    if (trimmed.endsWith(',')) trimmed = trimmed.slice(0, -1).trimEnd();
    if (!trimmed) {
      return `queryKey: []`; // preserve unusual empty arrays
    }
    return `queryKey: createTenantQueryKey(tenantId, ${trimmed})`;
  });
}

/** Ensure useQuery blocks guard with `!!tenantId`. */
function ensureEnabledGuard(content: string): string {
  // (a) extend any existing `enabled: !!id,`
  let out = content.replace(/enabled: !!id,/g, 'enabled: !!id && !!tenantId,');

  // (b) add enabled to useQuery blocks that lack it.
  const lines = out.split('\n');
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const keyMatch = /^(\s*)queryKey: createTenantQueryKey/.exec(line);
    if (!keyMatch) {
      result.push(line);
      i += 1;
      continue;
    }

    // Detect whether this is a useQuery block (look backward).
    let prev = i - 1;
    while (prev >= 0 && lines[prev]!.trim() === '') prev -= 1;
    const isUseQuery = prev >= 0 && lines[prev]!.includes('useQuery({');
    if (!isUseQuery) {
      result.push(line);
      i += 1;
      continue;
    }

    // Collect the useQuery block up to `});`.
    const block: string[] = [line];
    let j = i + 1;
    while (j < lines.length) {
      block.push(lines[j]!);
      if (/^\s*\}\);/.test(lines[j]!)) break;
      j += 1;
    }
    const hasEnabled = block.some((bl) => /^\s*enabled:/.test(bl));
    if (hasEnabled) {
      result.push(line);
      i += 1;
      continue;
    }
    const fieldIndent = keyMatch[1] ?? '    ';
    for (let bi = 0; bi < block.length; bi += 1) {
      const bl = block[bi]!;
      if (bi === 0) {
        result.push(bl);
        continue;
      }
      if (/^\s*\}\);/.test(bl)) {
        result.push(`${fieldIndent}enabled: !!tenantId,`);
        result.push(bl);
      } else {
        result.push(bl);
      }
    }
    i += block.length;
  }
  return result.join('\n');
}

function migrate(path: string, importSpec?: string): MigrationResult {
  const original = readFileSync(path, 'utf8');
  const bareBefore = countBareQueryKey(original);

  let content = original;
  const importStep = ensureSharedUiImport(content, importSpec);
  content = importStep.content;
  content = insertTenantIdDestructure(content);
  content = transformQueryKeys(content);
  content = ensureEnabledGuard(content);

  if (content !== original) {
    writeFileSync(path, content, 'utf8');
  }

  return {
    path,
    bareBefore,
    bareAfter: countBareQueryKey(content),
    importAdded: importStep.added,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: ts-node tools/scripts/migrate-tenant-query-key.ts ' +
        '[--import-from <spec>] <path...>',
    );
    process.exit(2);
  }

  let importSpec: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--import-from') {
      i += 1;
      importSpec = argv[i];
      continue;
    }
    if (a !== undefined) {
      files.push(a);
    }
  }

  for (const f of files) {
    const result = migrate(f, importSpec);
    // eslint-disable-next-line no-console
    console.log(
      `${result.path}: ${result.bareBefore} → ${result.bareAfter} bare queryKey${result.importAdded ? ' (import added)' : ''}`,
    );
  }
}

main();

export { migrate };
export type { MigrationResult };
