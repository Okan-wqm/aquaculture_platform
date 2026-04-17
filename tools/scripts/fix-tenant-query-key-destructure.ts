#!/usr/bin/env node
/**
 * fix-tenant-query-key-destructure — remediation for codemod regressions
 * ============================================================================
 *
 * Companion to `tools/scripts/migrate-tenant-query-key.ts`. Two jobs:
 *
 *   1. Insert `const { tenantId } = useAuth();` into hook bodies that
 *      reference `tenantId` but never bind it.
 *
 *   2. Collapse duplicate `enabled:` keys (the primary codemod sometimes
 *      appended `enabled: !!tenantId,` to blocks that already had an
 *      `enabled:` field, producing TS1117 duplicate-property errors).
 *
 * Simple line-based algorithm — no multi-line regexes (catastrophic
 * backtracking hazard on big files).
 *
 * Usage:
 *   npx ts-node --project tools/gates/tsconfig.json \
 *     tools/scripts/fix-tenant-query-key-destructure.ts <path...>
 */

import { readFileSync, writeFileSync } from 'node:fs';

interface FixResult {
  path: string;
  hooksFixed: number;
  duplicatesCollapsed: number;
  importAdded: boolean;
}

function ensureUseAuthImport(content: string): { content: string; added: boolean } {
  if (
    /import\s*\{[^}]*\buseAuth\b[^}]*\}\s*from\s*'@aquaculture\/shared-ui'/.test(content)
  ) {
    return { content, added: false };
  }
  const rx = /import\s*\{([^}]+)\}\s*from\s*'@aquaculture\/shared-ui';/;
  const m = rx.exec(content);
  if (m && m[1] !== undefined) {
    const syms = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!syms.includes('useAuth')) syms.push('useAuth');
    const next = `import { ${syms.join(', ')} } from '@aquaculture/shared-ui';`;
    return { content: content.replace(m[0], next), added: true };
  }
  const anchor = /^(import\s+\{[^}]+\}\s+from\s+'@tanstack\/react-query';)$/m.exec(
    content,
  );
  if (anchor) {
    return {
      content: content.replace(
        anchor[0],
        `${anchor[0]}\nimport { useAuth } from '@aquaculture/shared-ui';`,
      ),
      added: true,
    };
  }
  return { content, added: false };
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

function insertDestructureInHooks(content: string): {
  content: string;
  hooksFixed: number;
} {
  // Match any top-level `export function Name(...)` — hooks (useX) AND
  // React components (CapitalCase). Also matches multi-line parameter
  // lists by using `[\s\S]*?` between `(` and `)`.
  const hookRx = /^export function [A-Z_a-z]\w*\s*\([\s\S]*?\)\s*:?\s*[^{]*\{/gm;
  const matches: Array<{ bodyStart: number; bodyEnd: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = hookRx.exec(content)) !== null) {
    // braceIdx is the `{` that actually closed the header.
    const braceIdx = match.index + match[0].length - 1;
    const end = findMatchingBrace(content, braceIdx);
    if (end < 0) continue;
    matches.push({ bodyStart: braceIdx, bodyEnd: end });
  }

  let hooksFixed = 0;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const { bodyStart, bodyEnd } = matches[i]!;
    const body = content.slice(bodyStart + 1, bodyEnd);
    if (!/\btenantId\b/.test(body)) continue;
    if (/\{[^}]*\btenantId\b[^}]*\}\s*=\s*use(Auth|Tenant)\s*\(/.test(body)) continue;

    const qcRx = /\n(\s*)const\s+queryClient\s*=\s*useQueryClient\(\);/;
    const qc = qcRx.exec(body);
    let insertOffset: number;
    let indent: string;
    if (qc) {
      indent = qc[1] ?? '  ';
      insertOffset = bodyStart + 1 + qc.index + qc[0].length;
    } else {
      const firstRealLine = /\n(\s*)\S/.exec(body);
      indent = firstRealLine?.[1] ?? '  ';
      insertOffset = bodyStart + 1;
    }
    const insertion = `\n${indent}const { tenantId } = useAuth();`;
    content = content.slice(0, insertOffset) + insertion + content.slice(insertOffset);
    hooksFixed += 1;
  }
  return { content, hooksFixed };
}

/**
 * Line-by-line duplicate-enabled collapse.
 *
 * Walks the file recording the depth-tracked `{...}` blocks that
 * contain `queryKey: createTenantQueryKey`. Within each such block
 * (the useQuery options object), if there are 2+ `enabled:` lines,
 * merge expressions into the first occurrence and delete the rest.
 */
function collapseDuplicateEnabled(content: string): {
  content: string;
  duplicatesCollapsed: number;
} {
  const lines = content.split('\n');
  interface Block {
    openLine: number;
    closeLine: number;
    enabledLines: number[];
  }
  const blocks: Block[] = [];
  const stack: Array<{ openLine: number; hasQueryKey: boolean; enabledLines: number[] }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    // Process opens first so a self-balanced line `foo({bar})` doesn't
    // pop the outer context.
    for (let o = 0; o < opens; o += 1) {
      stack.push({ openLine: i, hasQueryKey: false, enabledLines: [] });
    }
    if (/queryKey:\s*createTenantQueryKey/.test(line) && stack.length > 0) {
      stack[stack.length - 1]!.hasQueryKey = true;
    }
    // Match both `enabled: <expr>,` and shorthand `enabled,` / `enabled`.
    if (
      /^\s*enabled\s*[:,]/.test(line) &&
      stack.length > 0 &&
      !/queryKey|queryFn|queryClient/.test(line)
    ) {
      stack[stack.length - 1]!.enabledLines.push(i);
    }
    for (let c = 0; c < closes; c += 1) {
      const top = stack.pop();
      if (!top) continue;
      if (top.hasQueryKey && top.enabledLines.length >= 2) {
        blocks.push({
          openLine: top.openLine,
          closeLine: i,
          enabledLines: top.enabledLines,
        });
      }
    }
  }

  // Mutate from the END backward so earlier line numbers stay valid.
  blocks.sort((a, b) => b.openLine - a.openLine);
  let duplicatesCollapsed = 0;
  for (const block of blocks) {
    const enabledExprs: string[] = [];
    let firstLineIdx = -1;
    let firstIndent = '  ';
    // Match either `enabled: <expr>,` OR shorthand `enabled,`.
    const enabledLineRx = /^(\s*)enabled(?::\s*(.*?))?,?\s*$/;
    for (const ln of block.enabledLines) {
      const m = enabledLineRx.exec(lines[ln]!);
      if (!m) continue;
      if (firstLineIdx < 0) {
        firstLineIdx = ln;
        firstIndent = m[1] ?? '  ';
      }
      // Shorthand → expression is just `enabled` (the bound identifier).
      const expr = (m[2] ?? '').trim() || 'enabled';
      if (expr) enabledExprs.push(expr);
    }
    if (enabledExprs.length < 2 || firstLineIdx < 0) continue;

    const uniqExprs: string[] = [];
    for (const e of enabledExprs) {
      if (!uniqExprs.includes(e)) uniqExprs.push(e);
    }
    const merged = uniqExprs
      .map((e) => (/[&|]|\?\?/.test(e) ? `(${e})` : e))
      .join(' && ');
    lines[firstLineIdx] = `${firstIndent}enabled: ${merged},`;

    // Delete the other enabled lines — work backward to preserve indices.
    const toDelete = block.enabledLines
      .filter((ln) => ln !== firstLineIdx)
      .sort((a, b) => b - a);
    for (const ln of toDelete) {
      lines.splice(ln, 1);
    }
    duplicatesCollapsed += toDelete.length;
  }

  return { content: lines.join('\n'), duplicatesCollapsed };
}

function fix(path: string): FixResult {
  const original = readFileSync(path, 'utf8');
  let content = original;
  const imp = ensureUseAuthImport(content);
  content = imp.content;
  const hooks = insertDestructureInHooks(content);
  content = hooks.content;
  const dup = collapseDuplicateEnabled(content);
  content = dup.content;
  if (content !== original) writeFileSync(path, content, 'utf8');
  return {
    path,
    hooksFixed: hooks.hooksFixed,
    duplicatesCollapsed: dup.duplicatesCollapsed,
    importAdded: imp.added,
  };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  // eslint-disable-next-line no-console
  console.error('Usage: fix-tenant-query-key-destructure.ts <path...>');
  process.exit(2);
}
for (const f of files) {
  const r = fix(f);
  // eslint-disable-next-line no-console
  console.log(
    `${r.path}: ${r.hooksFixed} hook(s), ${r.duplicatesCollapsed} dup enabled${r.importAdded ? ', import' : ''}`,
  );
}
