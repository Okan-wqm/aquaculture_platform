#!/usr/bin/env ts-node
/**
 * expand-contract-ast — build-time @ExpandContract validator (plan v3 R35).
 * ============================================================================
 *
 * Parses every migration source under apps/<svc>/src/database/migrations/
 * via the TypeScript compiler API (no import; no runtime side effects)
 * and validates:
 *
 *   1. Contract-phase classes (@ExpandContract({phase: 'contract', ...}))
 *      MUST supply dependsOn: '<expand-name>'.
 *   2. dependsOn's referenced migration MUST exist either in the same
 *      PR's migration set OR in a historical migration file already
 *      present on disk.
 *   3. Migration classes with breaking DDL signatures (parseable heuristics:
 *      `ALTER COLUMN ... DROP`, `DROP COLUMN`, `DROP TABLE`, `DROP TYPE`)
 *      SHOULD carry @ExpandContract — missing decorator emits a warning
 *      (not a blocker) to keep false-positives low.
 *
 * # Why AST over runtime reflection
 *
 * classifyMigrationsForBreaking() (shipped earlier this plan) requires
 * IMPORTING the migration class — which pulls in every transitive
 * dependency, runs module-level side effects, and is slow for a CI
 * gate that only wants to INSPECT the decorator. The AST walker
 * reads the text and calls it done.
 *
 * # Exit codes
 *
 *   0 — every migration passes
 *   1 — one or more violations
 *   2 — input error (tsc API failure, malformed path)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as ts from 'typescript';

const SCRIPT_DIR = __dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

export interface DecoratorInspection {
  readonly className: string;
  readonly filePath: string;
  readonly hasDecorator: boolean;
  readonly phase?: 'expand' | 'contract';
  readonly dependsOn?: string;
  /** Simple heuristic flag — true when the up() body contains a DROP / ALTER-DROP pattern. */
  readonly hasBreakingDdl: boolean;
}

export interface AstViolation {
  readonly kind:
    | 'contract_missing_dependsOn'
    | 'dependsOn_unresolved'
    | 'breaking_ddl_without_decorator';
  readonly filePath: string;
  readonly className: string;
  readonly details: string;
  readonly severity: 'error' | 'warn';
}

export interface AstWalkResult {
  readonly inspections: readonly DecoratorInspection[];
  readonly violations: readonly AstViolation[];
}

/**
 * Find every migration file under apps/<svc>/src/database/migrations/.
 */
export function collectMigrationFiles(root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  const appsDir = resolve(root, 'apps');
  if (!existsSync(appsDir)) return out;
  for (const svc of readdirSync(appsDir, { withFileTypes: true })) {
    if (!svc.isDirectory()) continue;
    const migDir = resolve(appsDir, svc.name, 'src', 'database', 'migrations');
    if (!existsSync(migDir)) continue;
    for (const f of readdirSync(migDir)) {
      if (f.endsWith('.ts') && !f.endsWith('.spec.ts')) {
        out.push(resolve(migDir, f));
      }
    }
  }
  return out.sort();
}

/**
 * Inspect one migration file via TypeScript AST. Finds the top-level
 * class declaration(s) and extracts @ExpandContract metadata.
 */
export function inspectFile(filePath: string): DecoratorInspection[] {
  const src = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    basename(filePath),
    src,
    ts.ScriptTarget.ES2022,
    true,
  );
  const inspections: DecoratorInspection[] = [];
  sourceFile.forEachChild((node) => {
    if (!ts.isClassDeclaration(node)) return;
    if (!node.name) return;
    const className = node.name.text;
    const decorators = ts.getDecorators(node) ?? [];
    let phase: 'expand' | 'contract' | undefined;
    let dependsOn: string | undefined;
    for (const dec of decorators) {
      const expr = dec.expression;
      if (!ts.isCallExpression(expr)) continue;
      if (!ts.isIdentifier(expr.expression)) continue;
      if (expr.expression.text !== 'ExpandContract') continue;
      const arg = expr.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        if (!ts.isIdentifier(prop.name)) continue;
        if (prop.name.text === 'phase' && ts.isStringLiteral(prop.initializer)) {
          const v = prop.initializer.text;
          if (v === 'expand' || v === 'contract') phase = v;
        }
        if (
          prop.name.text === 'dependsOn' &&
          ts.isStringLiteral(prop.initializer)
        ) {
          dependsOn = prop.initializer.text;
        }
      }
    }
    // Scan ONLY the up() method body for breaking-DDL patterns. down()
    // methods legitimately contain DROPs (rollback). Looking for the
    // up() method ensures we only warn on migrations whose FORWARD
    // path is breaking — the class the @ExpandContract marker exists
    // to surface.
    const hasBreakingDdl = classHasBreakingUpMethod(node, src);
    inspections.push({
      className,
      filePath,
      hasDecorator: phase !== undefined,
      ...(phase !== undefined ? { phase } : {}),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
      hasBreakingDdl,
    });
  });
  return inspections;
}

/**
 * Returns true when the class's `up` method body contains a DROP
 * pattern that would be breaking on a forward deploy.
 *
 * Textual inside an AST-scoped body — we take the exact source
 * text between `up(` and its matching close-brace via Node.pos / end,
 * which isolates the up() method from down() and any sibling helper
 * methods that might contain DROP SQL.
 */
function classHasBreakingUpMethod(
  classNode: ts.ClassDeclaration,
  src: string,
): boolean {
  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!ts.isIdentifier(member.name)) continue;
    if (member.name.text !== 'up') continue;
    if (!member.body) return false;
    const body = src.slice(member.body.pos, member.body.end);
    return hasBreakingDdlPattern(body);
  }
  return false;
}

function hasBreakingDdlPattern(src: string): boolean {
  const patterns = [
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+COLUMN\b/i,
    /\bDROP\s+TYPE\b/i,
    /\bALTER\s+COLUMN\s+[^\s]+\s+DROP\b/i,
  ];
  return patterns.some((p) => p.test(src));
}

/**
 * Validate the combined inspection set. Emits one violation per issue.
 */
export function validateInspections(
  inspections: readonly DecoratorInspection[],
): AstViolation[] {
  const violations: AstViolation[] = [];
  const knownNames = new Set(inspections.map((i) => i.className));
  // Migration file names follow `<Timestamp>-<ClassName>.ts` — extract
  // the ClassName segment so dependsOn can resolve against on-disk
  // historical migrations.
  for (const i of inspections) {
    const m = basename(i.filePath).match(/^\d+-(.+)\.ts$/);
    if (m && m[1]) knownNames.add(m[1]);
  }
  for (const i of inspections) {
    if (i.phase === 'contract' && !i.dependsOn) {
      violations.push({
        kind: 'contract_missing_dependsOn',
        filePath: i.filePath,
        className: i.className,
        severity: 'error',
        details:
          '@ExpandContract(phase: contract) requires dependsOn: \'<expand-migration-name>\'',
      });
    }
    if (i.phase === 'contract' && i.dependsOn && !knownNames.has(i.dependsOn)) {
      violations.push({
        kind: 'dependsOn_unresolved',
        filePath: i.filePath,
        className: i.className,
        severity: 'error',
        details: `dependsOn '${i.dependsOn}' does not match any class or file in this repository`,
      });
    }
    if (i.hasBreakingDdl && !i.hasDecorator) {
      violations.push({
        kind: 'breaking_ddl_without_decorator',
        filePath: i.filePath,
        className: i.className,
        severity: 'warn',
        details:
          'Migration contains breaking DDL (DROP / ALTER-DROP) but has no @ExpandContract marker. ' +
          'Consider annotating phase=contract with dependsOn for reviewer visibility.',
      });
    }
  }
  return violations;
}

export function runAstWalk(root: string = REPO_ROOT): AstWalkResult {
  const files = collectMigrationFiles(root);
  const inspections = files.flatMap((f) => inspectFile(f));
  const violations = validateInspections(inspections);
  return { inspections, violations };
}

export function main(argv: readonly string[]): number {
  const jsonMode = argv.includes('--json');
  const warningsAreErrors = argv.includes('--strict');
  let result: AstWalkResult;
  try {
    result = runAstWalk();
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const errors = result.violations.filter((v) => v.severity === 'error');
  const warns = result.violations.filter((v) => v.severity === 'warn');
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          filesScanned: result.inspections.length,
          errorCount: errors.length,
          warnCount: warns.length,
          violations: result.violations,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(
      `expand-contract-ast: ${result.inspections.length} migration class(es) scanned — ` +
        `${errors.length} error(s), ${warns.length} warning(s)\n`,
    );
    for (const v of result.violations) {
      process.stdout.write(
        `  [${v.severity}] ${v.kind}: ${v.filePath}::${v.className} — ${v.details}\n`,
      );
    }
    if (errors.length === 0 && warns.length === 0) {
      process.stdout.write('✓ All migrations pass @ExpandContract invariants.\n');
    }
  }
  if (errors.length > 0) return 1;
  if (warningsAreErrors && warns.length > 0) return 1;
  return 0;
}

if (process.argv[1]?.endsWith('expand-contract-ast.ts')) {
  process.exit(main(process.argv.slice(2)));
}
