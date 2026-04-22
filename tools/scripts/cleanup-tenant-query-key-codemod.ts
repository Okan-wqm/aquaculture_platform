#!/usr/bin/env node
/**
 * cleanup-tenant-query-key-codemod — architectural repair for
 * Phase 8.4 codemod regressions.
 * ============================================================================
 *
 * The primary codemod (`tools/scripts/migrate-tenant-query-key.ts`)
 * and its follow-on (`fix-tenant-query-key-destructure.ts`) had two
 * over-eager heuristics that produced TypeScript errors on downstream
 * consumers:
 *
 *   1. `const { tenantId } = useAuth();` was inserted into hook
 *      bodies that do not reference tenantId — triggering TS6133
 *      "declared but its value is never read" under strict
 *      noUnusedLocals.
 *
 *   2. `useAuth` was added to the shared-ui import in files that
 *      don't call useAuth() — triggering TS6133 on the import +
 *      TS2300 "Duplicate identifier" when the file had a pre-
 *      existing useAuth import from a different path.
 *
 *   3. Occasionally the `enabled: !!tenantId,` line landed inside a
 *      callback's object literal (when a `.map()` / `.filter()`'s
 *      `});` close was mistaken for the useQuery options close).
 *      These produced TS1109 syntax errors and were fixed manually
 *      per-file; the codemod remediation for that class lives in
 *      fix-tenant-query-key-destructure.ts.
 *
 * ## What this tool does
 *
 * For every `.ts` / `.tsx` file under a given root:
 *
 *   A. Find hook-level `const { tenantId } = useAuth();` (or similar
 *      destructures including tenantId) whose body does NOT reference
 *      `tenantId` outside the destructure itself. Remove the line.
 *
 *   B. If a hook's useAuth destructure becomes empty after (A) —
 *      e.g., `const { tenantId } = useAuth();` → removed — no-op;
 *      the line is gone.
 *
 *   C. If the file's shared-ui import includes `useAuth` but
 *      `useAuth()` never appears in the file body, remove `useAuth`
 *      from the import list.
 *
 *   D. If there are TWO `import ... from '@aquaculture/shared-ui';`
 *      lines (one from the codemod, one pre-existing), merge their
 *      symbol sets into the first and delete the duplicate.
 *
 * ## Usage
 *
 *   npx ts-node --project tools/gates/tsconfig.json \
 *     tools/scripts/cleanup-tenant-query-key-codemod.ts <path...>
 *
 * ## Why architectural, not patch
 *
 * Each of A/B/C/D is a mechanical inverse of a specific codemod
 * insertion rule. The cleanup re-applies the codemod's goal
 * (isolate tenantId destructure to hooks that need it) without
 * the over-eager side effects. Running this tool is idempotent —
 * a second run on the same file produces no further changes.
 */

import { readFileSync, writeFileSync } from 'node:fs';

interface CleanupResult {
  path: string;
  unusedDestructuresRemoved: number;
  unusedUseAuthImportsRemoved: boolean;
  duplicateImportsMerged: boolean;
}

function findMatchingBrace(content: string, startIndex: number): number {
  let depth = 0;
  for (let i = startIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingParen(content: string, startIndex: number): number {
  let depth = 0;
  for (let i = startIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Locate every top-level function body — export function, export const
 * React.FC arrow, non-export helpers — that might contain an
 * `tenantId` destructure.
 */
function findFunctionBodies(
  content: string,
): Array<{ bodyStart: number; bodyEnd: number }> {
  const bodies: Array<{ bodyStart: number; bodyEnd: number }> = [];

  // `(export )?(async )?function NAME(...) ... {`
  const fnRx = /^(?:export\s+)?(?:async\s+)?function\s+[A-Z_a-z]\w*\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = fnRx.exec(content)) !== null) {
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = findMatchingParen(content, parenStart);
    if (parenEnd < 0) continue;
    // Walk past return-type annotation (nested generics possible) until `{`.
    let i = parenEnd + 1;
    let angle = 0;
    while (i < content.length) {
      const ch = content[i];
      if (ch === '<') angle += 1;
      else if (ch === '>') angle -= 1;
      else if (ch === '{' && angle === 0) break;
      i += 1;
    }
    if (i >= content.length) continue;
    const bodyEnd = findMatchingBrace(content, i);
    if (bodyEnd < 0) continue;
    bodies.push({ bodyStart: i, bodyEnd });
  }

  // `(export )?const NAME: React.FC<...> = (...) => {`
  const fcRx = /^(?:export\s+)?const\s+[A-Z]\w*\s*(?::\s*React\.FC(?:<[^>]*>)?\s*)?=\s*\(/gm;
  while ((m = fcRx.exec(content)) !== null) {
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = findMatchingParen(content, parenStart);
    if (parenEnd < 0) continue;
    const after = content.slice(parenEnd + 1, parenEnd + 20);
    if (!/^\s*=>\s*\{/.test(after)) continue;
    const braceIdx = content.indexOf('{', parenEnd + 1);
    if (braceIdx < 0) continue;
    const bodyEnd = findMatchingBrace(content, braceIdx);
    if (bodyEnd < 0) continue;
    bodies.push({ bodyStart: braceIdx, bodyEnd });
  }

  bodies.sort((a, b) => a.bodyStart - b.bodyStart);
  return bodies;
}

/**
 * Step A + B: remove `const { ..., tenantId, ... } = useAuth()` lines
 * whose function body does NOT use tenantId outside the destructure.
 */
function removeUnusedTenantIdDestructures(content: string): {
  content: string;
  removed: number;
} {
  const bodies = findFunctionBodies(content);
  let removed = 0;

  // Mutate from the end backward so earlier byte indices stay valid.
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    const { bodyStart, bodyEnd } = bodies[i]!;
    const body = content.slice(bodyStart + 1, bodyEnd);

    // Find a full-line destructure of the shape
    //   const { ..., tenantId, ... } = useAuth(...)   or useTenant(...)
    // anchored to newline so we can compute the line bounds.
    const destructureRx =
      /\n(\s*)(const|let)\s*\{\s*([^}]*\btenantId\b[^}]*)\s*\}\s*=\s*use(Auth|Tenant)\s*\([^)]*\)\s*;?/g;
    // Iterate over matches (use exec loop to get indices).
    destructureRx.lastIndex = 0;
    const matches: Array<{
      offset: number;
      length: number;
      indent: string;
      kind: string;
      names: string;
      hook: string;
    }> = [];
    let dm: RegExpExecArray | null;
    while ((dm = destructureRx.exec(body)) !== null) {
      matches.push({
        offset: dm.index,
        length: dm[0].length,
        indent: dm[1] ?? '  ',
        kind: dm[2] ?? 'const',
        names: dm[3] ?? '',
        hook: dm[4] ?? 'Auth',
      });
    }

    // Inspect the body with each destructure's `tenantId` name elided
    // from the count.
    for (let j = matches.length - 1; j >= 0; j -= 1) {
      const match = matches[j]!;
      const bodyWithoutThisDestructure =
        body.slice(0, match.offset) +
        body.slice(match.offset + match.length);
      const tenantRefs = (
        bodyWithoutThisDestructure.match(/\btenantId\b/g) ?? []
      ).length;
      if (tenantRefs > 0) continue; // tenantId is used somewhere else.

      // Remove tenantId from the destructure. If the destructure becomes
      // empty (e.g. only tenantId was destructured), remove the entire
      // line.
      const names = match.names
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'tenantId');

      const absoluteOffset = bodyStart + 1 + match.offset;
      if (names.length === 0) {
        // Remove the whole line (and its leading newline).
        content =
          content.slice(0, absoluteOffset) +
          content.slice(absoluteOffset + match.length);
      } else {
        const replacement = `\n${match.indent}${match.kind} { ${names.join(
          ', ',
        )} } = use${match.hook}();`;
        content =
          content.slice(0, absoluteOffset) +
          replacement +
          content.slice(absoluteOffset + match.length);
      }
      removed += 1;
    }
  }

  return { content, removed };
}

/**
 * Step C: remove `useAuth` from the shared-ui import if the file
 * never calls `useAuth(`.
 */
function trimUnusedUseAuthImport(content: string): {
  content: string;
  changed: boolean;
} {
  // useAuth is ONLY safe to remove when the file neither calls
  // `useAuth(` nor references `tenantId` anywhere else — removing
  // the import but leaving a `createTenantQueryKey(tenantId, ...)`
  // call leaves tenantId undefined.
  const callRx = /\buseAuth\s*\(/;
  if (callRx.test(content)) return { content, changed: false };
  const tenantRx = /\btenantId\b/;
  if (tenantRx.test(content)) return { content, changed: false };

  let changed = false;
  const importRx = /import\s*\{([^}]+)\}\s*from\s*'@aquaculture\/shared-ui';/g;
  content = content.replace(importRx, (_whole, inner: string) => {
    const syms = inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const filtered = syms.filter((s) => s !== 'useAuth');
    if (filtered.length === syms.length) return _whole;
    changed = true;
    if (filtered.length === 0) return '';
    return `import { ${filtered.join(', ')} } from '@aquaculture/shared-ui';`;
  });
  // Collapse possibly-empty leading lines.
  content = content.replace(/\n{3,}/g, '\n\n');
  return { content, changed };
}

/**
 * Step D: merge duplicate `import ... from '@aquaculture/shared-ui';`
 * lines into a single statement (dedupe symbols).
 */
function mergeDuplicateSharedUiImports(content: string): {
  content: string;
  changed: boolean;
} {
  const importRx = /import\s*\{([^}]+)\}\s*from\s*'@aquaculture\/shared-ui';/g;
  const matches: Array<{ offset: number; length: number; syms: string[] }> = [];
  let m: RegExpExecArray | null;
  while ((m = importRx.exec(content)) !== null) {
    const syms = (m[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    matches.push({ offset: m.index, length: m[0].length, syms });
  }
  if (matches.length < 2) return { content, changed: false };

  const allSyms = Array.from(new Set(matches.flatMap((x) => x.syms)));
  const merged = `import { ${allSyms.join(', ')} } from '@aquaculture/shared-ui';`;

  // Replace all from the end backward: keep first occurrence replaced
  // with merged; delete the rest.
  for (let i = matches.length - 1; i >= 1; i -= 1) {
    const m2 = matches[i]!;
    content =
      content.slice(0, m2.offset) +
      content.slice(m2.offset + m2.length);
    // Remove the trailing newline left behind if any.
    if (content[m2.offset] === '\n') {
      content =
        content.slice(0, m2.offset) + content.slice(m2.offset + 1);
    }
  }
  const first = matches[0]!;
  content =
    content.slice(0, first.offset) +
    merged +
    content.slice(first.offset + first.length);

  return { content, changed: true };
}

function cleanup(path: string): CleanupResult {
  const original = readFileSync(path, 'utf8');
  let content = original;

  const destr = removeUnusedTenantIdDestructures(content);
  content = destr.content;

  const dup = mergeDuplicateSharedUiImports(content);
  content = dup.content;

  const imp = trimUnusedUseAuthImport(content);
  content = imp.content;

  if (content !== original) {
    writeFileSync(path, content, 'utf8');
  }

  return {
    path,
    unusedDestructuresRemoved: destr.removed,
    unusedUseAuthImportsRemoved: imp.changed,
    duplicateImportsMerged: dup.changed,
  };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  // eslint-disable-next-line no-console
  console.error('Usage: cleanup-tenant-query-key-codemod.ts <path...>');
  process.exit(2);
}
for (const f of files) {
  const r = cleanup(f);
  // eslint-disable-next-line no-console
  console.log(
    `${r.path}: ${r.unusedDestructuresRemoved} destructure(s), ${r.duplicateImportsMerged ? 'dedup import, ' : ''}${r.unusedUseAuthImportsRemoved ? 'trim useAuth' : ''}`,
  );
}
