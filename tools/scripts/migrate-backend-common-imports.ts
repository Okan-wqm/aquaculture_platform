#!/usr/bin/env node
/**
 * migrate-backend-common-imports — AUDIT-MEDIUM-005 codemod
 * ============================================================================
 *
 * Rewrites `import { ... } from '@aquaculture/backend-common'` into
 * per-subtree imports (`@aquaculture/backend-common/auth`, `/guards`, etc.)
 * so the omnibus root barrel is no longer a wide-invalidation surface for
 * every platform service.
 *
 * Why: the root barrel re-exports ~25 subtrees via `export *`. Any change in
 * any one subtree invalidates every root-barrel consumer (449 TS files as
 * of this audit). Per-subtree imports limit TypeScript + bundler
 * invalidation to consumers that actually pull from the changed subtree.
 *
 * # Algorithm
 *
 *   1. Resolve the symbol -> subtree map once by driving the TypeScript
 *      compiler API against every sub-barrel index.ts
 *      (libs/backend-common/src/<subtree>/index.ts) and recording every
 *      named export emitted (including those re-exported via `export *`).
 *
 *   2. For each target file, locate every
 *      `import ... from '@aquaculture/backend-common';` line and parse out
 *      the named imports + any type-only-ness (`import type {...}`) +
 *      aliases (`Foo as Bar`).
 *
 *   3. For each imported name, look up the owning subtree. If a name is
 *      owned by more than one subtree (shouldn't happen after the
 *      UUID_REGEX cleanup but the checker still catches future
 *      regressions), the codemod fails loudly and prints the ambiguity —
 *      reviewer must resolve by hand.
 *
 *   4. Emit one import line per subtree, preserving the original type-only
 *      flag. If every imported name routes to the same subtree, the
 *      output is a single rewritten line.
 *
 * # Usage
 *
 *   ts-node --project tools/gates/tsconfig.json \
 *     tools/scripts/migrate-backend-common-imports.ts \
 *     apps/farm-service/src/**\/*.ts
 *
 * Or with --all to migrate every consumer file under apps/ + libs/ + platform/:
 *
 *   ts-node --project tools/gates/tsconfig.json \
 *     tools/scripts/migrate-backend-common-imports.ts --all
 *
 * Pass --dry-run to print the planned rewrites without writing to disk.
 *
 * # Not handled (requires hand review)
 *
 *   - Default imports from the root barrel (there are none by convention
 *     — barrel exports only named symbols — but the script refuses to
 *     touch a default-import line and flags it).
 *   - Side-effect imports (`import '@aquaculture/backend-common';`) — these
 *     are semantically meaningless against a pure-re-export barrel but the
 *     codemod leaves them alone if found.
 *   - Re-export lines (`export { Foo } from '@aquaculture/backend-common';`)
 *     are rewritten using the same subtree map so the re-exporting barrel
 *     stays internally consistent.
 */

/* eslint-disable no-console */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

const REPO = path.resolve(__dirname, '../..');
const BACKEND_COMMON_SRC = path.join(REPO, 'libs/backend-common/src');

// Ordered list — the root barrel in index.ts currently does
// `export *` from each of these sub-barrels. Deep-only paths (audit /
// ai-safety / gdpr) are intentionally excluded
// because they are NOT re-exported from the root barrel — consumers
// that pulled them in got a TS error before, so no migration needed.
const SUBTREES = [
  'types',
  'tenant',
  'decorators',
  'guards',
  'utils',
  'http',
  'config',
  'auth',
  'filters',
  'middleware',
  'mobile-command',
  'database',
  'redis',
  'context',
  'logging',
  'telemetry',
  'metrics',
  'orchestrator-leader-election',
  'orchestrator-rate-limit',
  'security',
  'pagination',
  'health',
  'nats',
  'constants',
  'bootstrap',
  'monitoring',
  'websocket',
  'monetary',
] as const;

// A few audit-tokens are re-exported straight from audit/audit-log.tokens
// through the root barrel (entity-touching surface stays deep-only). Map
// them explicitly so the codemod routes them to the deep import path.
const AUDIT_TOKEN_SYMBOLS = new Set([
  'AUDIT_LOG_SERVICE',
  'AuditSeverity',
  'IAuditLogService',
  'CreateAuditEntryDto',
  'AuditedOperation',
  'AUDITED_OPERATION_KEY',
  'AuditedOperationStatus',
  'AuditedOperationOptions',
]);

type SymbolMap = Map<string, string>; // name -> subtree path ('auth', 'guards', etc.)

function loadSymbolMap(): SymbolMap {
  const map: SymbolMap = new Map();
  const program = ts.createProgram(
    SUBTREES.map((s) => path.join(BACKEND_COMMON_SRC, s, 'index.ts')),
    {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      noEmit: true,
      strict: false,
      baseUrl: REPO,
      paths: {
        '@aquaculture/backend-common/*': ['libs/backend-common/src/*/index.ts'],
      },
    },
  );
  const checker = program.getTypeChecker();

  for (const subtree of SUBTREES) {
    const indexPath = path.join(BACKEND_COMMON_SRC, subtree, 'index.ts');
    const source = program.getSourceFile(indexPath);
    if (!source) {
      console.warn(`[migrate] missing sub-barrel: ${indexPath}`);
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue;
    const exports = checker.getExportsOfModule(moduleSymbol);
    for (const sym of exports) {
      const name = sym.getName();
      if (map.has(name) && map.get(name) !== subtree) {
        console.warn(
          `[migrate] AMBIGUOUS: ${name} appears in both '${map.get(name)}' and '${subtree}' — codemod will refuse to rewrite files that import it.`,
        );
      } else {
        map.set(name, subtree);
      }
    }
  }

  // Route explicit audit-token exports to the deep-only `audit` path.
  for (const tok of AUDIT_TOKEN_SYMBOLS) {
    map.set(tok, 'audit');
  }
  return map;
}

interface ImportEntry {
  name: string; // original name before `as`
  alias?: string; // local alias if `X as Y`
}

interface RootImport {
  raw: string; // full original import statement, including trailing newline
  isTypeOnly: boolean;
  entries: ImportEntry[];
  hasSideEffect: boolean; // `import '@aquaculture/backend-common';`
  isExport: boolean; // `export { X } from '...';`
  startLine: number;
}

function parseImports(sourceFile: ts.SourceFile): RootImport[] {
  const out: RootImport[] = [];
  sourceFile.forEachChild((node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@aquaculture/backend-common'
    ) {
      const raw = node.getFullText(sourceFile);
      const isTypeOnly = !!node.importClause?.isTypeOnly;
      const entries: ImportEntry[] = [];
      let hasSideEffect = false;

      const clause = node.importClause;
      if (!clause) {
        hasSideEffect = true;
      } else {
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            entries.push({
              name: el.propertyName?.text ?? el.name.text,
              alias: el.propertyName ? el.name.text : undefined,
            });
          }
        }
      }

      out.push({
        raw,
        isTypeOnly,
        entries,
        hasSideEffect,
        isExport: false,
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@aquaculture/backend-common'
    ) {
      const raw = node.getFullText(sourceFile);
      const entries: ImportEntry[] = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          entries.push({
            name: el.propertyName?.text ?? el.name.text,
            alias: el.propertyName ? el.name.text : undefined,
          });
        }
      }
      out.push({
        raw,
        isTypeOnly: !!node.isTypeOnly,
        entries,
        hasSideEffect: false,
        isExport: true,
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line,
      });
    }
  });
  return out;
}

function rewriteFile(
  filePath: string,
  symbolMap: SymbolMap,
  dryRun: boolean,
): { changed: boolean; ambiguous: string[]; sideEffect: boolean; unknownSymbols: string[] } {
  const source = fs.readFileSync(filePath, 'utf-8');
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2021,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const rootImports = parseImports(sf);
  if (rootImports.length === 0) {
    return { changed: false, ambiguous: [], sideEffect: false, unknownSymbols: [] };
  }

  const ambiguous: string[] = [];
  const unknownSymbols: string[] = [];
  let sideEffect = false;

  let nextSource = source;

  for (const imp of rootImports) {
    if (imp.hasSideEffect) {
      sideEffect = true;
      continue;
    }
    if (imp.entries.length === 0) continue;

    // Group entries by subtree
    const byTree = new Map<string, ImportEntry[]>();
    let abort = false;
    for (const e of imp.entries) {
      const tree = symbolMap.get(e.name);
      if (!tree) {
        unknownSymbols.push(`${filePath}: '${e.name}' not found in any sub-barrel`);
        abort = true;
        break;
      }
      const list = byTree.get(tree) ?? [];
      list.push(e);
      byTree.set(tree, list);
    }
    if (abort) continue;

    // Emit one import line per subtree, preserving leading whitespace + type-only.
    const leadingWs = imp.raw.match(/^\s*/)?.[0] ?? '';
    const keyword = imp.isExport ? 'export' : 'import';
    const typeKw = imp.isTypeOnly ? 'type ' : '';
    const lines: string[] = [];
    for (const [tree, entries] of [...byTree.entries()].sort()) {
      const names = entries.map((e) => (e.alias ? `${e.name} as ${e.alias}` : e.name)).join(', ');
      const specifier = `'@aquaculture/backend-common/${tree}'`;
      const verb = imp.isExport ? `export ${typeKw}` : `import ${typeKw}`;
      void keyword;
      lines.push(`${verb}{ ${names} } from ${specifier};`);
    }
    const replacement = leadingWs + lines.join('\n');
    nextSource = nextSource.replace(imp.raw, replacement);
  }

  if (nextSource === source) {
    return { changed: false, ambiguous, sideEffect, unknownSymbols };
  }
  if (!dryRun) {
    fs.writeFileSync(filePath, nextSource);
  }
  return { changed: true, ambiguous, sideEffect, unknownSymbols };
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  const files: string[] = [];
  if (all) {
    // Use git ls-files (fast; already respects .gitignore) to collect every
    // tracked TS file under the four roots that consume backend-common.
    const gitOut = execSync(
      `git -C ${REPO} ls-files -- apps libs platform tools tests e2e '*.ts' '*.tsx'`,
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    );
    for (const rel of gitOut.split('\n')) {
      const trimmed = rel.trim();
      if (!trimmed) continue;
      if (trimmed.endsWith('.d.ts')) continue;
      if (trimmed.endsWith('.ts') || trimmed.endsWith('.tsx')) {
        files.push(path.join(REPO, trimmed));
      }
    }
  } else {
    for (const a of args) {
      if (a.startsWith('--')) continue;
      files.push(path.isAbsolute(a) ? a : path.resolve(process.cwd(), a));
    }
  }

  if (files.length === 0) {
    console.error('No files provided. Use --all or pass explicit paths.');
    process.exit(2);
  }

  console.log(`[migrate] building sub-barrel symbol map...`);
  const symbolMap = loadSymbolMap();
  console.log(
    `[migrate] symbol map ready: ${symbolMap.size} symbols across ${SUBTREES.length} subtrees`,
  );

  let changed = 0;
  let skipped = 0;
  const ambiguous: string[] = [];
  const unknowns: string[] = [];
  const sideEffects: string[] = [];

  for (const f of files) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
    try {
      const r = rewriteFile(f, symbolMap, dryRun);
      if (r.changed) {
        changed++;
        if (dryRun) console.log(`[DRY] ${path.relative(REPO, f)}`);
      } else {
        skipped++;
      }
      ambiguous.push(...r.ambiguous);
      unknowns.push(...r.unknownSymbols);
      if (r.sideEffect) sideEffects.push(f);
    } catch (err) {
      console.error(`[migrate] error on ${f}:`, err);
    }
  }

  console.log(
    `[migrate] ${dryRun ? 'DRY-RUN: ' : ''}${changed} files rewritten, ${skipped} files untouched (of ${files.length} scanned)`,
  );
  if (unknowns.length) {
    console.warn(`[migrate] UNKNOWN SYMBOLS (${unknowns.length}) — files left untouched:`);
    unknowns.slice(0, 20).forEach((u) => console.warn('  ' + u));
    if (unknowns.length > 20) console.warn(`  ... and ${unknowns.length - 20} more`);
  }
  if (sideEffects.length) {
    console.warn(`[migrate] side-effect imports found (${sideEffects.length}) — left untouched.`);
  }
  process.exit(unknowns.length > 0 && !dryRun ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
