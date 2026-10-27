/**
 * Source readers for `module-dictionary-ssot.spec.ts` — every check there reads the repository
 * the way a compiler or a migration runner would, without booting a service or a database.
 *
 * - `moduleLiteralCopies`: type-level copies of the module set (a union, a one-literal alias, an
 *   enum) anywhere, and value-level lists of module codes in the web.
 * - `sqlLiterals`: the SQL a migration can issue, in source order, with `down` left out.
 * - `replayEnumLabels`: the labels a Postgres enum type holds after a service's migrations ran in
 *   order — what a tenant schema replay produces.
 * - `dictionaryBoundColumns`: the TypeORM enum columns whose labels are a dictionary constant.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import ts from 'typescript';

import { resolveEnumTypeName } from '../../../libs/backend-common/src/database/schema-drift/enum-type-name';

export const REPO_ROOT = join(__dirname, '..', '..', '..');

export function readRepoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Tracked files under the pathspecs, repo-relative. */
export function trackedFiles(pathspecs: readonly string[]): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...pathspecs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((file) => file.length > 0);
}

function parse(rel: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

export interface ModuleLiteralCopy {
  readonly where: string;
  readonly kind: 'union' | 'one-literal alias' | 'enum' | 'list';
  readonly codes: readonly string[];
}

/**
 * Module-code copies in one file. `codes` holds both spellings a copy can take: the dictionary's
 * own (`farm`) and the GraphQL enum value name (`FARM`). A union, an enum or (with `lists`) an
 * array literal is a copy when two distinct codes appear in it; a type alias is a copy when it is
 * exactly one code.
 */
export function moduleLiteralCopies(
  rel: string,
  source: string,
  codes: ReadonlySet<string>,
  options: { readonly lists: boolean },
): ModuleLiteralCopy[] {
  const file = parse(rel, source);
  const copies: ModuleLiteralCopy[] = [];
  const codeOf = (node: ts.Node | undefined): string[] =>
    node !== undefined && ts.isStringLiteralLike(node) && codes.has(node.text) ? [node.text] : [];
  const record = (node: ts.Node, kind: ModuleLiteralCopy['kind'], found: string[]): void => {
    const distinct = [...new Set(found)];
    if (distinct.length >= 2 || (kind === 'one-literal alias' && distinct.length === 1)) {
      copies.push({ where: `${rel}:${lineOf(file, node)}`, kind, codes: distinct });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isUnionTypeNode(node)) {
      record(
        node,
        'union',
        node.types.flatMap((member) =>
          ts.isLiteralTypeNode(member) ? codeOf(member.literal) : [],
        ),
      );
    } else if (ts.isTypeAliasDeclaration(node) && ts.isLiteralTypeNode(node.type)) {
      record(node, 'one-literal alias', codeOf(node.type.literal));
    } else if (ts.isEnumDeclaration(node)) {
      record(
        node,
        'enum',
        node.members.flatMap((member) => codeOf(member.initializer)),
      );
    } else if (options.lists && ts.isArrayLiteralExpression(node)) {
      record(
        node,
        'list',
        node.elements.flatMap((element) => codeOf(element)),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return copies;
}

/** A literal a migration hands to the database, at its position in the file. */
export interface SqlLiteral {
  readonly position: number;
  readonly text: string;
}

/**
 * Every string and template literal outside the `down` method, plus each call of the farm
 * precedent's helper `addEnumValueIfTypePresent(queryRunner, '<type>', '<label>')` (1805900000000)
 * rendered as the statement it issues. Comments never reach the result, so prose that names a
 * statement cannot be mistaken for one.
 */
export function sqlLiterals(rel: string, source: string): SqlLiteral[] {
  const file = parse(rel, source);
  const literals: SqlLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'down') {
      return;
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      literals.push({ position: node.getStart(file), text: node.getText(file) });
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addEnumValueIfTypePresent'
    ) {
      const [, typeName, label] = node.arguments;
      if (typeName !== undefined && label !== undefined) {
        if (ts.isStringLiteralLike(typeName) && ts.isStringLiteralLike(label)) {
          literals.push({
            position: node.getStart(file),
            text: `ALTER TYPE "${typeName.text}" ADD VALUE IF NOT EXISTS '${label.text}'`,
          });
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return literals;
}

/** Numbered migration files of one migrations directory, in the order the runner applies them. */
export function migrationFilesIn(directory: string): string[] {
  return trackedFiles([directory])
    .filter(
      (file) => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes('/'),
    )
    .filter((file) => /^\d{13}-.+\.ts$/.test(basename(file)))
    .sort((left, right) => basename(left).localeCompare(basename(right)));
}

/** Numbered migration files of one service app (`apps/<service>`), in apply order. */
export function serviceMigrationFiles(serviceDir: string): string[] {
  return trackedFiles([`${serviceDir}/src`])
    .filter((file) => /\/migrations\/\d{13}-[^/]+\.ts$/.test(file))
    .filter((file) => !file.includes('/__tests__/') && !file.includes('/.archive/'))
    .sort((left, right) => basename(left).localeCompare(basename(right)));
}

/** An optional `schema.` or `"schema".` qualifier, interpolated (`"${schema}".`) or literal. */
const QUALIFIER = '(?:"?[A-Za-z0-9_$\\{\\}]+"?\\s*\\.\\s*)?';
const QUALIFIED = `${QUALIFIER}"?([A-Za-z_][A-Za-z0-9_]*)"?`;

/** Bare names of the types a migration creates (`CREATE TYPE [schema.]name AS …`). */
export function createdTypeNames(rel: string, source: string): string[] {
  const pattern = new RegExp(`CREATE\\s+TYPE\\s+${QUALIFIED}\\s+AS\\b`, 'gi');
  return sqlLiterals(rel, source).flatMap((literal) =>
    [...literal.text.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : [])),
  );
}

function quotedLabels(list: string): string[] {
  return [...list.matchAll(/'([^']*)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * The labels `typeName` holds after `files` ran in order: its first `CREATE TYPE … AS ENUM (…)`,
 * then every `ADD VALUE` and `RENAME VALUE` on it. Undefined when no file creates it.
 */
export function replayEnumLabels(files: readonly string[], typeName: string): string[] | undefined {
  const name = `${QUALIFIER}"?(?<![A-Za-z0-9_])${typeName}"?(?![A-Za-z0-9_])`;
  const create = new RegExp(`CREATE\\s+TYPE\\s+${name}\\s+AS\\s+ENUM\\s*\\(([^)]*)\\)`, 'gi');
  const add = new RegExp(
    `ALTER\\s+TYPE\\s+${name}\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'([^']+)'`,
    'gi',
  );
  const rename = new RegExp(
    `ALTER\\s+TYPE\\s+${name}\\s+RENAME\\s+VALUE\\s+'([^']+)'\\s+TO\\s+'([^']+)'`,
    'gi',
  );
  let labels: string[] | undefined;
  for (const file of files) {
    const statements = sqlLiterals(file, readRepoFile(file)).flatMap((literal) => [
      ...[...literal.text.matchAll(create)].map((match) => ({
        at: literal.position + (match.index ?? 0),
        apply: (current: string[] | undefined) => current ?? quotedLabels(match[1] ?? ''),
      })),
      ...[...literal.text.matchAll(add)].map((match) => ({
        at: literal.position + (match.index ?? 0),
        apply: (current: string[] | undefined) =>
          current === undefined || current.includes(match[1] ?? '')
            ? current
            : [...current, match[1] ?? ''],
      })),
      ...[...literal.text.matchAll(rename)].map((match) => ({
        at: literal.position + (match.index ?? 0),
        apply: (current: string[] | undefined) =>
          current?.map((label) => (label === match[1] ? (match[2] ?? label) : label)),
      })),
    ]);
    for (const statement of statements.sort((left, right) => left.at - right.at)) {
      labels = statement.apply(labels);
    }
  }
  return labels;
}

export interface DictionaryBoundColumn {
  readonly where: string;
  readonly serviceDir: string;
  readonly constant: string;
  readonly typeName: string;
}

function stringOption(options: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === key &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  return undefined;
}

function decoratorCall(node: ts.Node, name: string): ts.CallExpression | undefined {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  for (const decorator of decorators) {
    const call = decorator.expression;
    if (
      ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      call.expression.text === name
    ) {
      return call;
    }
  }
  return undefined;
}

/**
 * TypeORM enum columns of one entity file whose `enum:` is one of `constants` (a dictionary
 * constant), with the Postgres type name TypeORM gives them (`resolveEnumTypeName`, the drift
 * validator's own derivation).
 */
export function dictionaryBoundColumns(
  rel: string,
  source: string,
  constants: ReadonlySet<string>,
): DictionaryBoundColumn[] {
  const file = parse(rel, source);
  const serviceDir = rel.split('/').slice(0, 2).join('/');
  const columns: DictionaryBoundColumn[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      const entity = decoratorCall(node, 'Entity');
      const [first] = entity?.arguments ?? [];
      const table =
        first === undefined
          ? undefined
          : ts.isStringLiteralLike(first)
            ? first.text
            : ts.isObjectLiteralExpression(first)
              ? stringOption(first, 'name')
              : undefined;
      for (const member of node.members) {
        const [options] = decoratorCall(member, 'Column')?.arguments ?? [];
        if (
          table === undefined ||
          options === undefined ||
          !ts.isObjectLiteralExpression(options)
        ) {
          continue;
        }
        const enumOption = options.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'enum',
        );
        if (
          enumOption === undefined ||
          !ts.isIdentifier(enumOption.initializer) ||
          !constants.has(enumOption.initializer.text) ||
          member.name === undefined ||
          !ts.isIdentifier(member.name)
        ) {
          continue;
        }
        columns.push({
          where: `${rel}:${lineOf(file, member)}`,
          serviceDir,
          constant: enumOption.initializer.text,
          typeName: resolveEnumTypeName(
            stringOption(options, 'enumName'),
            table,
            stringOption(options, 'name') ?? member.name.text,
          ),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return columns;
}
