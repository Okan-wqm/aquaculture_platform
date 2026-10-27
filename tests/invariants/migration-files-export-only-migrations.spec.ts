/**
 * Platform-wide invariant — PKG-03 landing (2026-10-27):
 *
 * A migration FILE exports exactly one class, its migration, and no function.
 *
 * TypeORM builds its migration list by loading every file the glob matches and instantiating
 * everything callable that the module exports (`ConnectionMetadataBuilder.buildMigrations` →
 * `importClassesFromDirectories` → `new exported()`). A helper exported from a migration file —
 * for a unit test to import — is therefore run as a migration: PKG-03's admin migration exported
 * `panelWithoutInert(panel)`, `new panelWithoutInert()` read `Object.entries(undefined)`, and
 * `aqua-db-migrate` aborted on the admin schema (`tenant-clone-parity`). A second exported class
 * would be instantiated the same way, and run if it carries `up`.
 *
 * Helpers live in `migrations/support/` (the glob only matches digit-prefixed files), the way
 * auth-service's `support/concurrent-index.ts` does. Exported data constants and types are not
 * callable, so TypeORM skips them and they stay allowed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..');

function migrationFiles(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '*migrations*'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(
      (f) =>
        f.length > 0 &&
        !f.includes('__tests__') &&
        !f.includes('.archive') &&
        !f.endsWith('.spec.ts') &&
        /^\d{13}-.*\.ts$/.test(f.split('/').pop() ?? ''),
    );
}

/** What a migration file exports that TypeORM would try to instantiate, or that hides it. */
export function offendingExports(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const offences: string[] = [];
  let classes = 0;
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      offences.push(
        `${ts.SyntaxKind[statement.kind]} (cannot be checked; export the class inline)`,
      );
      continue;
    }
    const exported = (
      ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
    ).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isClassDeclaration(statement)) {
      classes += 1;
    } else if (ts.isFunctionDeclaration(statement)) {
      offences.push(`function ${statement.name?.text ?? '(anonymous)'}`);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          offences.push(`function ${declaration.name.getText(file)}`);
        }
      }
    }
  }
  if (classes !== 1) offences.push(`${classes} exported classes (expected exactly 1)`);
  return offences;
}

describe('INVARIANT: a migration file exports its migration class and no function', () => {
  it('no migration file exports a function or more than one class', () => {
    const violations = migrationFiles().flatMap((fileName) =>
      offendingExports(fileName, readFileSync(resolve(REPO_ROOT, fileName), 'utf8')).map(
        (offence) => `${fileName}: ${offence}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it('sees the migration files it is meant to guard', () => {
    expect(migrationFiles().length).toBeGreaterThan(250);
  });

  describe('the detector', () => {
    const migration = 'export class AddThing1800000000000 implements MigrationInterface {}';

    it('accepts one class beside exported types and data constants', () => {
      const source = [
        'export interface Row { id: string }',
        "export type Mode = 'a' | 'b';",
        "export const KEYS: readonly string[] = ['a', 'b'];",
        migration,
      ].join('\n');
      expect(offendingExports('1800000000000-AddThing.ts', source)).toEqual([]);
    });

    it('flags an exported function declaration', () => {
      const source = `export function helper(value: unknown): number { return 1; }\n${migration}`;
      expect(offendingExports('1800000000000-AddThing.ts', source)).toEqual(['function helper']);
    });

    it('flags an exported function-valued constant', () => {
      const source = `export const helper = (value: unknown): number => 1;\n${migration}`;
      expect(offendingExports('1800000000000-AddThing.ts', source)).toEqual(['function helper']);
    });

    it('flags a second exported class', () => {
      const source = `export class Helper {}\n${migration}`;
      expect(offendingExports('1800000000000-AddThing.ts', source)).toEqual([
        '2 exported classes (expected exactly 1)',
      ]);
    });

    it('flags a file that exports no class', () => {
      expect(offendingExports('1800000000000-AddThing.ts', 'class Hidden {}')).toEqual([
        '0 exported classes (expected exactly 1)',
      ]);
    });

    it('flags a re-export or export list it cannot inspect', () => {
      const source = `export { helper } from './support';\n${migration}`;
      expect(offendingExports('1800000000000-AddThing.ts', source)).toEqual([
        'ExportDeclaration (cannot be checked; export the class inline)',
      ]);
    });
  });
});
