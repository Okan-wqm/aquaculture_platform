import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

export const FEEDING_SQL_AUTHORITY_SCAN_ROOTS_V1 = Object.freeze([
  'apps/farm-service/src/feeding-protocol',
  'apps/farm-service/src/feeding',
  'apps/farm-service/src/storage',
] as const);

export type SqlAuthorityViolationKind =
  | 'DYNAMIC_SQL'
  | 'UNKNOWN_RELATION'
  | 'UNKNOWN_RAW_COLUMN'
  | 'UNKNOWN_QUERY_BUILDER'
  | 'UNKNOWN_QUERY_BUILDER_ALIAS'
  | 'UNKNOWN_QUERY_BUILDER_COLUMN'
  | 'UNBOUND_TENANT_RELATION';

export interface SqlAuthorityViolationV1 {
  readonly kind: SqlAuthorityViolationKind;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export interface SqlRelationAuthorityV1 {
  readonly relation: string;
  readonly columns?: readonly string[];
  readonly columnSourceRelation?: string;
  readonly tenantColumn?: string;
  readonly tenantIsolation?: 'FORCED_RLS';
}

export interface FeedingSqlAuthorityReportV1 {
  readonly sourceFiles: number;
  readonly entityRelations: number;
  readonly rawQueryCalls: number;
  readonly rawRelations: number;
  readonly rawColumnReferences: number;
  readonly queryBuilderCalls: number;
  readonly queryBuilderReferences: number;
  readonly tenantBoundRelations: number;
  readonly violations: readonly SqlAuthorityViolationV1[];
}

interface ColumnAuthorityV1 {
  readonly property: string;
  readonly physical: string;
}

interface EntityAuthorityV1 {
  readonly className: string;
  readonly relation: string;
  readonly columnsByProperty: ReadonlyMap<string, ColumnAuthorityV1>;
  readonly columnsByPhysical: ReadonlyMap<string, ColumnAuthorityV1>;
  readonly relations: ReadonlyMap<string, string>;
  readonly tenantColumn?: ColumnAuthorityV1;
  readonly tenantIsolation?: 'FORCED_RLS';
}

interface AuthorityCatalogV1 {
  readonly byRelation: ReadonlyMap<string, EntityAuthorityV1>;
  readonly byClassName: ReadonlyMap<string, EntityAuthorityV1>;
}

interface SqlTextV1 {
  readonly text: string;
  readonly tenantSchemaBound: boolean;
}

interface SqlCallV1 extends SqlTextV1 {
  readonly file: string;
  readonly line: number;
}

interface SqlTokenV1 {
  readonly kind: 'identifier' | 'word' | 'string' | 'number' | 'parameter' | 'symbol';
  readonly value: string;
  readonly quoted: boolean;
  readonly offset: number;
}

interface RawRelationUseV1 {
  readonly relation: string;
  readonly alias: string;
  readonly tenantSchemaBound: boolean;
}

interface RawSqlContractV1 {
  readonly relations: readonly RawRelationUseV1[];
  readonly columnRefs: readonly { relation: string; column: string; context: string }[];
  readonly tenantBoundAliases: ReadonlySet<string>;
}

interface BuilderContextV1 {
  readonly aliases: Map<string, EntityAuthorityV1>;
}

const COLUMN_DECORATORS = new Set([
  'Column',
  'CreateDateColumn',
  'DeleteDateColumn',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'TreeLevelColumn',
  'UpdateDateColumn',
  'VersionColumn',
]);

const RELATION_DECORATORS = new Set([
  'ManyToMany',
  'ManyToOne',
  'OneToMany',
  'OneToOne',
  'TreeChildren',
  'TreeParent',
]);

const QUERY_BUILDER_SQL_METHODS = new Set([
  'addGroupBy',
  'addOrderBy',
  'addSelect',
  'andHaving',
  'andWhere',
  'groupBy',
  'having',
  'leftJoin',
  'leftJoinAndMapMany',
  'leftJoinAndMapOne',
  'leftJoinAndSelect',
  'innerJoin',
  'innerJoinAndMapMany',
  'innerJoinAndMapOne',
  'innerJoinAndSelect',
  'orHaving',
  'orWhere',
  'orderBy',
  'select',
  'where',
]);

const JOIN_METHODS = new Set([
  'leftJoin',
  'leftJoinAndMapMany',
  'leftJoinAndMapOne',
  'leftJoinAndSelect',
  'innerJoin',
  'innerJoinAndMapMany',
  'innerJoinAndMapOne',
  'innerJoinAndSelect',
]);

const SQL_KEYWORDS = new Set(
  `ALL AND ANY AS ASC BETWEEN BY CASE COLLATE CROSS DELETE DESC DISTINCT ELSE END EXISTS FALSE FILTER
   FOR FROM FULL GROUP HAVING ILIKE IN INNER INSERT INTERVAL INTO IS JOIN LATERAL LEFT LIKE LIMIT
   NOT NULL NULLS OFFSET ON OR ORDER OUTER OVER RECURSIVE RETURNING RIGHT SELECT SET SKIP THEN TRUE
   UNION UPDATE USING VALUES WHEN WHERE WINDOW WITH`.split(/\s+/),
);

function listFiles(repoRoot: string, roots: readonly string[], glob = '*.ts'): string[] {
  return execFileSync('rg', ['--files', ...roots, '-g', glob], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .sort();
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoratorCall(node: ts.Node, names?: ReadonlySet<string>): ts.CallExpression | undefined {
  for (const decorator of decoratorsOf(node)) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const callee = decorator.expression.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    if (name && (!names || names.has(name))) return decorator.expression;
  }
  return undefined;
}

function literalProperty(object: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (propertyName !== name) continue;
    return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
  }
  return undefined;
}

function decoratorOption(call: ts.CallExpression, name: string): string | undefined {
  for (const argument of call.arguments) {
    if (ts.isObjectLiteralExpression(argument)) {
      const value = literalProperty(argument, name);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function relationName(call: ts.CallExpression): string | undefined {
  const first = call.arguments[0];
  if (first && ts.isStringLiteralLike(first)) return first.text;
  if (!first || (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first))) return undefined;
  let expression: ts.Expression | undefined;
  if (ts.isBlock(first.body)) {
    const returned = first.body.statements.find(ts.isReturnStatement);
    expression = returned?.expression;
  } else {
    expression = first.body;
  }
  return expression && ts.isIdentifier(expression) ? expression.text : undefined;
}

function classBaseDeclarations(
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
): readonly ts.ClassDeclaration[] {
  const bases: ts.ClassDeclaration[] = [];
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      let symbol = checker.getSymbolAtLocation(type.expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const candidate of symbol?.declarations ?? []) {
        if (ts.isClassDeclaration(candidate)) bases.push(candidate);
      }
    }
  }
  return bases;
}

function collectClassMetadata(
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  visited: Set<ts.ClassDeclaration>,
): { columns: ColumnAuthorityV1[]; relations: Array<readonly [string, string]> } {
  if (visited.has(declaration)) return { columns: [], relations: [] };
  visited.add(declaration);
  const columns: ColumnAuthorityV1[] = [];
  const relations: Array<readonly [string, string]> = [];
  for (const base of classBaseDeclarations(declaration, checker)) {
    const inherited = collectClassMetadata(base, checker, visited);
    columns.push(...inherited.columns);
    relations.push(...inherited.relations);
  }
  for (const member of declaration.members) {
    if (!member.name || (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))) {
      continue;
    }
    const property = member.name.text;
    const column = decoratorCall(member, COLUMN_DECORATORS);
    if (column) {
      columns.push({ property, physical: decoratorOption(column, 'name') ?? property });
    }
    const relation = decoratorCall(member, RELATION_DECORATORS);
    const target = relation && relationName(relation);
    if (target) relations.push([property, target]);
  }
  return { columns, relations };
}

function buildAuthorityCatalog(
  program: ts.Program,
  entityFiles: readonly string[],
  extraRelations: readonly SqlRelationAuthorityV1[],
): AuthorityCatalogV1 {
  const checker = program.getTypeChecker();
  const provisional: Array<{
    className: string;
    relation: string;
    columns: ColumnAuthorityV1[];
    relationTargets: Array<readonly [string, string]>;
  }> = [];
  for (const file of entityFiles) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const entity = decoratorCall(statement, new Set(['Entity']));
      if (!entity) continue;
      const first = entity.arguments[0];
      const relation =
        first && ts.isStringLiteralLike(first)
          ? first.text
          : first && ts.isObjectLiteralExpression(first)
            ? literalProperty(first, 'name')
            : undefined;
      if (!relation) continue;
      const metadata = collectClassMetadata(statement, checker, new Set());
      provisional.push({
        className: statement.name.text,
        relation,
        columns: metadata.columns,
        relationTargets: metadata.relations,
      });
    }
  }

  const byClassName = new Map<string, EntityAuthorityV1>();
  const byRelation = new Map<string, EntityAuthorityV1>();
  for (const source of provisional) {
    const columns = new Map(source.columns.map((column) => [column.property, column]));
    const physical = new Map(source.columns.map((column) => [column.physical, column]));
    const authority: EntityAuthorityV1 = {
      className: source.className,
      relation: source.relation,
      columnsByProperty: columns,
      columnsByPhysical: physical,
      relations: new Map(source.relationTargets),
      tenantColumn: columns.get('tenantId'),
    };
    byClassName.set(source.className, authority);
    byRelation.set(source.relation, authority);
  }
  for (const source of extraRelations) {
    if (byRelation.has(source.relation)) {
      throw new Error(`SQL authority relation ${source.relation} duplicates entity metadata`);
    }
    const inheritedColumns = source.columnSourceRelation
      ? byRelation.get(source.columnSourceRelation)?.columnsByPhysical
      : undefined;
    if ((source.columns === undefined) === (inheritedColumns === undefined)) {
      throw new Error(
        `SQL authority relation ${source.relation} must own columns or one entity column source`,
      );
    }
    const columns = source.columns
      ? source.columns.map((physical) => ({ property: physical, physical }))
      : [...inheritedColumns!.values()];
    const byProperty = new Map(columns.map((column) => [column.property, column]));
    byRelation.set(source.relation, {
      className: `CatalogRelation<${source.relation}>`,
      relation: source.relation,
      columnsByProperty: byProperty,
      columnsByPhysical: new Map(columns.map((column) => [column.physical, column])),
      relations: new Map(),
      tenantColumn: source.tenantColumn ? byProperty.get(source.tenantColumn) : undefined,
      tenantIsolation: source.tenantIsolation,
    });
  }
  return { byClassName, byRelation };
}

function tokenizeSql(sql: string): SqlTokenV1[] {
  const tokens: SqlTokenV1[] = [];
  let index = 0;
  const push = (token: Omit<SqlTokenV1, 'offset'>, offset: number): void => {
    tokens.push({ ...token, offset });
  };
  while (index < sql.length) {
    const char = sql[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      index = sql.indexOf('\n', index + 2);
      if (index === -1) break;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) throw new Error('Unterminated SQL block comment');
      index = end + 2;
      continue;
    }
    if (char === "'") {
      const start = index++;
      let value = '';
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          value += "'";
          index += 2;
        } else if (sql[index] === "'") {
          index += 1;
          break;
        } else {
          value += sql[index++];
        }
      }
      push({ kind: 'string', value, quoted: true }, start);
      continue;
    }
    if (char === '"') {
      const start = index++;
      let value = '';
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (sql[index] === '"') {
          index += 1;
          break;
        } else {
          value += sql[index++];
        }
      }
      push({ kind: 'identifier', value, quoted: true }, start);
      continue;
    }
    if (char === '$') {
      const parameter = /^\$[0-9]+/.exec(sql.slice(index));
      if (parameter) {
        push({ kind: 'parameter', value: parameter[0], quoted: false }, index);
        index += parameter[0].length;
        continue;
      }
      const dollarTag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index));
      if (dollarTag) {
        const start = index;
        const end = sql.indexOf(dollarTag[0], index + dollarTag[0].length);
        if (end === -1) throw new Error('Unterminated SQL dollar string');
        index = end + dollarTag[0].length;
        push({ kind: 'string', value: '<dollar-string>', quoted: true }, start);
        continue;
      }
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index += 1;
      const value = sql.slice(start, index);
      push({ kind: 'word', value, quoted: false }, start);
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[0-9.]/.test(sql[index]!)) index += 1;
      push({ kind: 'number', value: sql.slice(start, index), quoted: false }, start);
      continue;
    }
    const two = sql.slice(index, index + 2);
    if (['::', '>=', '<=', '<>', '!=', '->', '||'].includes(two)) {
      push({ kind: 'symbol', value: two, quoted: false }, index);
      index += 2;
    } else {
      push({ kind: 'symbol', value: char, quoted: false }, index);
      index += 1;
    }
  }
  return tokens;
}

function isIdentifier(token: SqlTokenV1 | undefined): token is SqlTokenV1 {
  return token?.kind === 'identifier' || token?.kind === 'word';
}

function effectiveIdentifier(token: SqlTokenV1): string {
  return token.quoted ? token.value : token.value.toLowerCase();
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function declarationInitializer(symbol: ts.Symbol | undefined): ts.Expression | undefined {
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return declaration.initializer;
    }
    if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
      return declaration.initializer;
    }
  }
  return undefined;
}

function isTenantSchemaExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol>,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isTenantSchemaExpression(expression.expression, checker, visited);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = resolvedSymbol(checker, expression);
    if (!symbol || visited.has(symbol)) return false;
    visited.add(symbol);
    const initializer = declarationInitializer(symbol);
    return initializer ? isTenantSchemaExpression(initializer, checker, visited) : false;
  }
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  const coordinate = expression.arguments[0];
  return (
    name === 'getTenantSchemaName' &&
    expression.arguments.length === 1 &&
    coordinate !== undefined &&
    ((ts.isIdentifier(coordinate) && coordinate.text === 'tenantId') ||
      (ts.isPropertyAccessExpression(coordinate) && coordinate.name.text === 'tenantId'))
  );
}

function resolveSqlText(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  visited: Set<ts.Symbol> = new Set(),
): SqlTextV1 | undefined {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return resolveSqlText(expression.expression, checker, visited);
  }
  if (ts.isStringLiteralLike(expression)) {
    return { text: expression.text, tenantSchemaBound: false };
  }
  // Imported authority graphs deliberately expose relation coordinates as
  // readonly literal properties. They are as static as a local string literal,
  // but their AST is a PropertyAccessExpression (and may be wrapped by an
  // immutability compiler), so following variable initializers alone cannot
  // recover them. The TypeScript checker retains the exact string-literal type;
  // accepting only that narrow type keeps dynamic SQL fail-closed while letting
  // runtime and this inventory compiler consume the same authority graph.
  const expressionType = checker.getTypeAtLocation(expression);
  if (expressionType.flags & ts.TypeFlags.StringLiteral) {
    return {
      text: (expressionType as ts.StringLiteralType).value,
      tenantSchemaBound: false,
    };
  }
  if (ts.isTemplateExpression(expression)) {
    let text = expression.head.text;
    let tenantSchemaBound = false;
    for (const span of expression.templateSpans) {
      const isTenantSchema = isTenantSchemaExpression(span.expression, checker, new Set());
      tenantSchemaBound ||= isTenantSchema;
      const staticSpan = isTenantSchema
        ? undefined
        : resolveSqlText(span.expression, checker, new Set(visited));
      text += isTenantSchema ? '__tenant_schema__' : (staticSpan?.text ?? '__dynamic_expression__');
      tenantSchemaBound ||= staticSpan?.tenantSchemaBound ?? false;
      text += span.literal.text;
    }
    return { text, tenantSchemaBound };
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = resolveSqlText(expression.left, checker, new Set(visited));
    const right = resolveSqlText(expression.right, checker, new Set(visited));
    if (!left || !right) return undefined;
    return {
      text: left.text + right.text,
      tenantSchemaBound: left.tenantSchemaBound || right.tenantSchemaBound,
    };
  }
  if (ts.isIdentifier(expression)) {
    const symbol = resolvedSymbol(checker, expression);
    if (!symbol || visited.has(symbol)) return undefined;
    visited.add(symbol);
    const initializer = declarationInitializer(symbol);
    return initializer ? resolveSqlText(initializer, checker, visited) : undefined;
  }
  return undefined;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function discoverRawSqlCalls(
  program: ts.Program,
  sourceFiles: readonly string[],
): {
  calls: SqlCallV1[];
  violations: SqlAuthorityViolationV1[];
} {
  const checker = program.getTypeChecker();
  const calls: SqlCallV1[] = [];
  const violations: SqlAuthorityViolationV1[] = [];
  for (const file of sourceFiles) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'query'
      ) {
        const first = node.arguments[0];
        const resolved = first && resolveSqlText(first, checker);
        const location = lineOf(source, node);
        if (!resolved) {
          violations.push({
            kind: 'DYNAMIC_SQL',
            file,
            line: location,
            detail: 'Raw query text is not a compiler-resolvable literal authority',
          });
        } else {
          calls.push({ ...resolved, file, line: location });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { calls, violations };
}

function cteNames(tokens: readonly SqlTokenV1[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    const candidate = tokens[index];
    if (!isIdentifier(candidate)) continue;
    const asToken = tokens[index + 1];
    const open = tokens[index + 2];
    const previous = tokens[index - 1];
    const startsCte =
      previous?.value.toUpperCase() === 'WITH' ||
      previous?.value.toUpperCase() === 'RECURSIVE' ||
      previous?.value === ',';
    if (startsCte && asToken?.value.toUpperCase() === 'AS' && open?.value === '(') {
      names.add(effectiveIdentifier(candidate));
    }
  }
  return names;
}

function relationAfter(
  tokens: readonly SqlTokenV1[],
  start: number,
  tenantSchemaBound: boolean,
  allowFunctionCall = true,
): { use?: RawRelationUseV1; end: number; functionCall: boolean } {
  let index = start;
  while (['ONLY', 'LATERAL'].includes(tokens[index]?.value.toUpperCase() ?? '')) index += 1;
  const parts: SqlTokenV1[] = [];
  const first = tokens[index];
  if (!isIdentifier(first)) return { end: index, functionCall: false };
  parts.push(first);
  index += 1;
  while (tokens[index]?.value === '.' && isIdentifier(tokens[index + 1])) {
    parts.push(tokens[index + 1]!);
    index += 2;
  }
  if (allowFunctionCall && tokens[index]?.value === '(') {
    return { end: index, functionCall: true };
  }
  const relation = effectiveIdentifier(parts[parts.length - 1]!);
  let alias = relation;
  if (tokens[index]?.value.toUpperCase() === 'AS') index += 1;
  const aliasCandidate = tokens[index];
  if (
    isIdentifier(aliasCandidate) &&
    !SQL_KEYWORDS.has(aliasCandidate.value.toUpperCase()) &&
    aliasCandidate.value !== '__dynamic_expression__'
  ) {
    alias = effectiveIdentifier(aliasCandidate);
    index += 1;
  }
  return {
    use: {
      relation,
      alias,
      tenantSchemaBound:
        tenantSchemaBound && parts.some((part) => part.value === '__tenant_schema__'),
    },
    end: index,
    functionCall: false,
  };
}

function discoverRelations(
  tokens: readonly SqlTokenV1[],
  tenantSchemaBound: boolean,
): RawRelationUseV1[] {
  const ctes = cteNames(tokens);
  const relations: RawRelationUseV1[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const keyword = tokens[index]?.value.toUpperCase();
    let relationStart: number | undefined;
    if (
      keyword === 'FROM' ||
      keyword === 'JOIN' ||
      (keyword === 'USING' && tokens[index + 1]?.value !== '(')
    ) {
      relationStart = index + 1;
    } else if (keyword === 'UPDATE' && tokens[index - 1]?.value.toUpperCase() !== 'FOR') {
      relationStart = index + 1;
    } else if (keyword === 'INSERT' && tokens[index + 1]?.value.toUpperCase() === 'INTO') {
      relationStart = index + 2;
    }
    if (relationStart === undefined) continue;
    const parsed = relationAfter(
      tokens,
      relationStart,
      tenantSchemaBound,
      keyword === 'FROM' || keyword === 'JOIN',
    );
    if (parsed.use && !parsed.functionCall && !ctes.has(parsed.use.relation)) {
      relations.push(parsed.use);
    }
    index = Math.max(index, parsed.end - 1);
  }
  return relations;
}

function qualifiedRefAt(
  tokens: readonly SqlTokenV1[],
  index: number,
  aliases: ReadonlyMap<string, RawRelationUseV1>,
): { use: RawRelationUseV1; column: string; end: number } | undefined {
  const aliasToken = tokens[index];
  const columnToken = tokens[index + 2];
  if (!isIdentifier(aliasToken) || tokens[index + 1]?.value !== '.' || !isIdentifier(columnToken)) {
    return undefined;
  }
  const use = aliases.get(effectiveIdentifier(aliasToken));
  return use ? { use, column: effectiveIdentifier(columnToken), end: index + 3 } : undefined;
}

function mutationColumnRefs(
  tokens: readonly SqlTokenV1[],
  relations: readonly RawRelationUseV1[],
): Array<{ relation: string; column: string; context: string }> {
  const refs: Array<{ relation: string; column: string; context: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const keyword = tokens[index]?.value.toUpperCase();
    if (keyword === 'INSERT' && tokens[index + 1]?.value.toUpperCase() === 'INTO') {
      const parsed = relationAfter(tokens, index + 2, false, false);
      const use =
        parsed.use && relations.find((relation) => relation.relation === parsed.use?.relation);
      let cursor = parsed.end;
      if (!use || tokens[cursor]?.value !== '(') continue;
      cursor += 1;
      let depth = 1;
      while (cursor < tokens.length && depth > 0) {
        const token = tokens[cursor]!;
        if (token.value === '(') depth += 1;
        else if (token.value === ')') depth -= 1;
        else if (depth === 1 && isIdentifier(token)) {
          refs.push({
            relation: use.relation,
            column: effectiveIdentifier(token),
            context: `INSERT ${use.relation}`,
          });
        }
        cursor += 1;
      }
    }
    if (keyword === 'UPDATE') {
      const parsed = relationAfter(tokens, index + 1, false, false);
      const use =
        parsed.use && relations.find((relation) => relation.relation === parsed.use?.relation);
      if (!use) continue;
      let cursor = parsed.end;
      while (cursor < tokens.length && tokens[cursor]?.value.toUpperCase() !== 'SET') cursor += 1;
      cursor += 1;
      let depth = 0;
      while (cursor < tokens.length) {
        const token = tokens[cursor]!;
        if (depth === 0 && ['WHERE', 'RETURNING'].includes(token.value.toUpperCase())) break;
        if (token.value === '(') depth += 1;
        else if (token.value === ')') depth -= 1;
        else if (depth === 0 && isIdentifier(token) && tokens[cursor + 1]?.value === '=') {
          refs.push({
            relation: use.relation,
            column: effectiveIdentifier(token),
            context: `UPDATE ${use.relation} SET`,
          });
        }
        cursor += 1;
      }
    }
  }
  return refs;
}

function unqualifiedQuotedColumnRefs(
  tokens: readonly SqlTokenV1[],
  relations: readonly RawRelationUseV1[],
): Array<{ relation: string; column: string; context: string }> {
  if (relations.length !== 1) return [];
  const use = relations[0]!;
  const refs: Array<{ relation: string; column: string; context: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'identifier' || !token.quoted) continue;
    if (
      tokens[index - 1]?.value === '.' ||
      tokens[index + 1]?.value === '.' ||
      tokens[index - 1]?.value.toUpperCase() === 'AS' ||
      tokens[index - 1]?.value.toUpperCase() === 'COLLATE' ||
      tokens[index - 1]?.value === '::' ||
      token.value === use.relation ||
      token.value === use.alias ||
      token.value === '__tenant_schema__'
    ) {
      continue;
    }
    refs.push({
      relation: use.relation,
      column: token.value,
      context: `unqualified "${token.value}"`,
    });
  }
  return refs;
}

function compileRawSql(sql: SqlTextV1, catalog: AuthorityCatalogV1): RawSqlContractV1 {
  const tokens = tokenizeSql(sql.text);
  const relations = discoverRelations(tokens, sql.tenantSchemaBound);
  const aliases = new Map(relations.map((use) => [use.alias, use]));
  const columnRefs = [
    ...mutationColumnRefs(tokens, relations),
    ...unqualifiedQuotedColumnRefs(tokens, relations),
  ];
  for (let index = 0; index < tokens.length; index += 1) {
    const ref = qualifiedRefAt(tokens, index, aliases);
    if (!ref) continue;
    columnRefs.push({
      relation: ref.use.relation,
      column: ref.column,
      context: `${ref.use.alias}.${ref.column}`,
    });
    index = ref.end - 1;
  }

  const bound = new Set<string>();
  const tenantEdges: Array<readonly [string, string]> = [];
  for (const use of relations) {
    const authority = catalog.byRelation.get(use.relation);
    if (use.tenantSchemaBound || authority?.tenantIsolation === 'FORCED_RLS') bound.add(use.alias);
  }
  for (const ref of columnRefs) {
    if (!ref.context.startsWith('INSERT ')) continue;
    const use = relations.find((relation) => relation.relation === ref.relation);
    const authority = catalog.byRelation.get(ref.relation);
    if (use && authority?.tenantColumn?.physical === ref.column) bound.add(use.alias);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const left = qualifiedRefAt(tokens, index, aliases);
    if (!left) continue;
    const leftAuthority = catalog.byRelation.get(left.use.relation);
    if (left.column !== leftAuthority?.tenantColumn?.physical) continue;
    let operator = left.end;
    if (tokens[operator]?.value === '::') operator += 2;
    if (tokens[operator]?.value !== '=') continue;
    const right = qualifiedRefAt(tokens, operator + 1, aliases);
    if (right) {
      const rightAuthority = catalog.byRelation.get(right.use.relation);
      if (right.column === rightAuthority?.tenantColumn?.physical) {
        tenantEdges.push([left.use.alias, right.use.alias]);
      }
    } else if (
      ['parameter', 'string', 'number'].includes(tokens[operator + 1]?.kind ?? '') ||
      tokens[operator + 1]?.value === '__dynamic_expression__' ||
      tokens[operator + 1]?.value.toLowerCase() === 'current_setting'
    ) {
      bound.add(left.use.alias);
    }
  }

  const tenantRelations = relations.filter(
    (use) => catalog.byRelation.get(use.relation)?.tenantColumn !== undefined,
  );
  if (tenantRelations.length === 1) {
    const use = tenantRelations[0]!;
    const tenantColumn = catalog.byRelation.get(use.relation)?.tenantColumn?.physical;
    for (let index = 0; tenantColumn && index < tokens.length - 1; index += 1) {
      const token = tokens[index]!;
      if (!isIdentifier(token) || effectiveIdentifier(token) !== tenantColumn) continue;
      if (tokens[index - 1]?.value === '.') continue;
      let operator = index + 1;
      if (tokens[operator]?.value === '::') operator += 2;
      if (tokens[operator]?.value === '=') bound.add(use.alias);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of tenantEdges) {
      if (bound.has(left) && !bound.has(right)) {
        bound.add(right);
        changed = true;
      }
      if (bound.has(right) && !bound.has(left)) {
        bound.add(left);
        changed = true;
      }
    }
  }
  return { relations, columnRefs, tenantBoundAliases: bound };
}

function entityForClassExpression(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker,
  catalog: AuthorityCatalogV1,
): EntityAuthorityV1 | undefined {
  if (!expression) return undefined;
  if (ts.isParenthesizedExpression(expression)) {
    return entityForClassExpression(expression.expression, checker, catalog);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = resolvedSymbol(checker, expression);
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isClassDeclaration(declaration) && declaration.name) {
        return catalog.byClassName.get(declaration.name.text);
      }
    }
    return catalog.byClassName.get(expression.text);
  }
  return undefined;
}

function entityFromTypeNode(
  type: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  catalog: AuthorityCatalogV1,
): EntityAuthorityV1 | undefined {
  if (!type || !ts.isTypeReferenceNode(type) || type.typeArguments?.length !== 1) return undefined;
  const argument = type.typeArguments[0];
  return argument && ts.isTypeReferenceNode(argument)
    ? entityForClassExpression(argument.typeName as ts.Expression, checker, catalog)
    : argument && ts.isTypeQueryNode(argument)
      ? entityForClassExpression(argument.exprName as ts.Expression, checker, catalog)
      : argument && ts.isTypeNode(argument) && ts.isIdentifier(argument)
        ? entityForClassExpression(argument, checker, catalog)
        : undefined;
}

function entityFromRepositoryExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  catalog: AuthorityCatalogV1,
  visited: Set<ts.Symbol> = new Set(),
): EntityAuthorityV1 | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return entityFromRepositoryExpression(expression.expression, checker, catalog, visited);
  }
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    if (name === 'tenantManagerRepo') {
      return entityForClassExpression(expression.arguments[1], checker, catalog);
    }
    if (name === 'getRepository') {
      return entityForClassExpression(expression.arguments[0], checker, catalog);
    }
  }
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const target = ts.isIdentifier(expression) ? expression : expression.name;
    const symbol = resolvedSymbol(checker, target);
    if (!symbol || visited.has(symbol)) return undefined;
    visited.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (
        ts.isPropertyDeclaration(declaration) ||
        ts.isParameter(declaration) ||
        ts.isVariableDeclaration(declaration)
      ) {
        const fromType = entityFromTypeNode(declaration.type, checker, catalog);
        if (fromType) return fromType;
        if (declaration.initializer) {
          const fromInitializer = entityFromRepositoryExpression(
            declaration.initializer,
            checker,
            catalog,
            visited,
          );
          if (fromInitializer) return fromInitializer;
        }
      }
    }
  }
  return undefined;
}

function createBuilderCall(expression: ts.Expression): ts.CallExpression | undefined {
  if (ts.isParenthesizedExpression(expression)) return createBuilderCall(expression.expression);
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return undefined;
  }
  if (expression.expression.name.text === 'createQueryBuilder') return expression;
  return createBuilderCall(expression.expression.expression);
}

function staticString(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker,
): string | undefined {
  if (!expression) return undefined;
  const resolved = resolveSqlText(expression, checker);
  return resolved && !resolved.text.includes('__dynamic_expression__') ? resolved.text : undefined;
}

function createBuilderContext(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  catalog: AuthorityCatalogV1,
): BuilderContextV1 | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const receiver = call.expression.expression;
  const entity =
    call.arguments.length >= 2
      ? entityForClassExpression(call.arguments[0], checker, catalog)
      : entityFromRepositoryExpression(receiver, checker, catalog);
  const aliasExpression = call.arguments.length >= 2 ? call.arguments[1] : call.arguments[0];
  const alias = staticString(aliasExpression, checker);
  return entity && alias ? { aliases: new Map([[alias, entity]]) } : undefined;
}

function relationJoinTarget(
  target: string,
  context: BuilderContextV1,
  catalog: AuthorityCatalogV1,
): EntityAuthorityV1 | undefined {
  const separator = target.indexOf('.');
  if (separator === -1) return catalog.byRelation.get(target);
  const owner = context.aliases.get(target.slice(0, separator));
  const relationProperty = target.slice(separator + 1);
  const targetClass = owner?.relations.get(relationProperty);
  return targetClass ? catalog.byClassName.get(targetClass) : undefined;
}

function builderContextForReceiver(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
  variableContexts: ReadonlyMap<ts.Symbol, BuilderContextV1>,
  rootContexts: Map<ts.CallExpression, BuilderContextV1>,
  catalog: AuthorityCatalogV1,
): BuilderContextV1 | undefined {
  if (ts.isIdentifier(receiver)) {
    const symbol = resolvedSymbol(checker, receiver);
    return symbol ? variableContexts.get(symbol) : undefined;
  }
  const root = createBuilderCall(receiver);
  if (root) {
    const existing = rootContexts.get(root);
    if (existing) return existing;
    const compiled = createBuilderContext(root, checker, catalog);
    if (compiled) rootContexts.set(root, compiled);
    return compiled;
  }
  return undefined;
}

function builderStringExpressions(
  call: ts.CallExpression,
  method: string,
): readonly ts.Expression[] {
  if (JOIN_METHODS.has(method)) {
    const mapped = method.includes('AndMap');
    const condition = call.arguments[mapped ? 3 : 2];
    return condition ? [condition] : [];
  }
  const first = call.arguments[0];
  return first && ts.isArrayLiteralExpression(first) ? first.elements : first ? [first] : [];
}

function compileBuilderReference(
  text: string,
  context: BuilderContextV1,
): Array<{ alias: string; column: string; quoted: boolean }> {
  const tokens = tokenizeSql(text);
  const refs: Array<{ alias: string; column: string; quoted: boolean }> = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    const alias = tokens[index];
    const column = tokens[index + 2];
    if (!isIdentifier(alias) || tokens[index + 1]?.value !== '.' || !isIdentifier(column)) continue;
    const aliasName = alias.value;
    if (!context.aliases.has(aliasName)) continue;
    refs.push({ alias: aliasName, column: column.value, quoted: column.quoted });
    index += 2;
  }
  return refs;
}

function discoverQueryBuilderContracts(
  program: ts.Program,
  sourceFiles: readonly string[],
  catalog: AuthorityCatalogV1,
): {
  calls: number;
  references: number;
  violations: SqlAuthorityViolationV1[];
} {
  const checker = program.getTypeChecker();
  const variableContexts = new Map<ts.Symbol, BuilderContextV1>();
  const rootContexts = new Map<ts.CallExpression, BuilderContextV1>();
  const roots: Array<{ file: string; source: ts.SourceFile; call: ts.CallExpression }> = [];

  for (const file of sourceFiles) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const visitRoots = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'createQueryBuilder'
      ) {
        roots.push({ file, source, call: node });
        const context = createBuilderContext(node, checker, catalog);
        if (context) rootContexts.set(node, context);
      }
      ts.forEachChild(node, visitRoots);
    };
    visitRoots(source);
  }

  for (const file of sourceFiles) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const visitVariables = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const root = createBuilderCall(node.initializer);
        const symbol = resolvedSymbol(checker, node.name);
        const context = root && rootContexts.get(root);
        if (symbol && context) variableContexts.set(symbol, context);
      }
      ts.forEachChild(node, visitVariables);
    };
    visitVariables(source);
  }

  const operations: Array<{
    file: string;
    source: ts.SourceFile;
    call: ts.CallExpression;
    method: string;
    position: number;
  }> = [];
  for (const file of sourceFiles) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const visitOperations = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (QUERY_BUILDER_SQL_METHODS.has(method)) {
          operations.push({
            file,
            source,
            call: node,
            method,
            position: node.expression.name.getStart(source),
          });
        }
      }
      ts.forEachChild(node, visitOperations);
    };
    visitOperations(source);
  }
  operations.sort((left, right) => left.position - right.position);

  const violations: SqlAuthorityViolationV1[] = roots
    .filter(({ call }) => !rootContexts.has(call))
    .map(({ file, source, call }) => ({
      kind: 'UNKNOWN_QUERY_BUILDER' as const,
      file,
      line: lineOf(source, call),
      detail: 'createQueryBuilder root cannot be bound to TypeORM entity metadata',
    }));
  let references = 0;
  for (const operation of operations) {
    if (!ts.isPropertyAccessExpression(operation.call.expression)) continue;
    const context = builderContextForReceiver(
      operation.call.expression.expression,
      checker,
      variableContexts,
      rootContexts,
      catalog,
    );
    if (!context) continue;
    if (JOIN_METHODS.has(operation.method)) {
      const mapped = operation.method.includes('AndMap');
      const targetExpression = operation.call.arguments[mapped ? 1 : 0];
      const aliasExpression = operation.call.arguments[mapped ? 2 : 1];
      const target = staticString(targetExpression, checker);
      const alias = staticString(aliasExpression, checker);
      const entity =
        entityForClassExpression(targetExpression, checker, catalog) ??
        (target ? relationJoinTarget(target, context, catalog) : undefined);
      if (alias && entity) context.aliases.set(alias, entity);
      else if (alias) {
        violations.push({
          kind: 'UNKNOWN_QUERY_BUILDER_ALIAS',
          file: operation.file,
          line: lineOf(operation.source, operation.call),
          detail: `Join alias ${alias} cannot be bound to entity/relation metadata`,
        });
      }
    }
    for (const expression of builderStringExpressions(operation.call, operation.method)) {
      const text = staticString(expression, checker);
      if (!text) continue;
      for (const ref of compileBuilderReference(text, context)) {
        references += 1;
        const authority = context.aliases.get(ref.alias);
        const supported = ref.quoted
          ? authority?.columnsByPhysical.has(ref.column)
          : authority?.columnsByProperty.has(ref.column);
        if (!supported) {
          violations.push({
            kind: 'UNKNOWN_QUERY_BUILDER_COLUMN',
            file: operation.file,
            line: lineOf(operation.source, expression),
            detail: `${ref.alias}.${ref.column} is absent from ${authority?.className ?? 'unknown alias'} ${
              ref.quoted ? 'physical' : 'property'
            } metadata`,
          });
        }
      }
    }
  }
  return { calls: roots.length, references, violations };
}

function entitySourceFiles(repoRoot: string): string[] {
  return execFileSync('rg', ['-l', '@Entity\\(', 'apps/farm-service/src', '-g', '*.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .sort();
}

function createCompilerProgram(repoRoot: string, rootFiles: readonly string[]): ts.Program {
  const configPath = join(repoRoot, 'apps/farm-service/tsconfig.spec.json');
  const config = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'));
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot, {}, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  }
  return ts.createProgram({
    rootNames: [...new Set(rootFiles.map((file) => join(repoRoot, file)))],
    options: { ...parsed.options, noEmit: true },
  });
}

function displayViolation(
  repoRoot: string,
  violation: SqlAuthorityViolationV1,
): SqlAuthorityViolationV1 {
  return {
    ...violation,
    file: violation.file.startsWith(repoRoot) ? relative(repoRoot, violation.file) : violation.file,
  };
}

export function compileFeedingSqlAuthorityV1(options: {
  readonly repoRoot: string;
  readonly extraRelations?: readonly SqlRelationAuthorityV1[];
}): FeedingSqlAuthorityReportV1 {
  const sourceFiles = listFiles(options.repoRoot, FEEDING_SQL_AUTHORITY_SCAN_ROOTS_V1).filter(
    (file) => !file.includes('/__tests__/') && !file.endsWith('.spec.ts'),
  );
  const entities = entitySourceFiles(options.repoRoot);
  const program = createCompilerProgram(options.repoRoot, [...sourceFiles, ...entities]);
  const absoluteSources = sourceFiles.map((file) => join(options.repoRoot, file));
  const absoluteEntities = entities.map((file) => join(options.repoRoot, file));
  const catalog = buildAuthorityCatalog(program, absoluteEntities, options.extraRelations ?? []);
  const raw = discoverRawSqlCalls(program, absoluteSources);
  const violations: SqlAuthorityViolationV1[] = [...raw.violations];
  let rawRelations = 0;
  let rawColumnReferences = 0;
  let tenantBoundRelations = 0;
  for (const call of raw.calls) {
    const contract = compileRawSql(call, catalog);
    rawRelations += contract.relations.length;
    rawColumnReferences += contract.columnRefs.length;
    for (const use of contract.relations) {
      const authority = catalog.byRelation.get(use.relation);
      if (!authority) {
        violations.push({
          kind: 'UNKNOWN_RELATION',
          file: call.file,
          line: call.line,
          detail: `${use.relation} is absent from entity/catalog relation metadata`,
        });
        continue;
      }
      if (authority.tenantColumn) {
        if (contract.tenantBoundAliases.has(use.alias)) {
          tenantBoundRelations += 1;
        } else {
          violations.push({
            kind: 'UNBOUND_TENANT_RELATION',
            file: call.file,
            line: call.line,
            detail:
              `${use.relation} alias ${use.alias} has no tenant predicate, tenant-equality edge, ` +
              'verified tenant schema, or forced-RLS authority',
          });
        }
      }
    }
    for (const ref of contract.columnRefs) {
      const authority = catalog.byRelation.get(ref.relation);
      if (authority && !authority.columnsByPhysical.has(ref.column)) {
        violations.push({
          kind: 'UNKNOWN_RAW_COLUMN',
          file: call.file,
          line: call.line,
          detail: `${ref.relation}.${ref.column} (${ref.context}) is absent from physical metadata`,
        });
      }
    }
  }
  const builders = discoverQueryBuilderContracts(program, absoluteSources, catalog);
  violations.push(...builders.violations);
  return {
    sourceFiles: sourceFiles.length,
    entityRelations: catalog.byRelation.size,
    rawQueryCalls: raw.calls.length,
    rawRelations,
    rawColumnReferences,
    queryBuilderCalls: builders.calls,
    queryBuilderReferences: builders.references,
    tenantBoundRelations,
    violations: violations
      .map((violation) => displayViolation(options.repoRoot, violation))
      .sort(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.kind.localeCompare(right.kind) ||
          left.detail.localeCompare(right.detail),
      ),
  };
}

function fixtureCatalog(relations: readonly SqlRelationAuthorityV1[]): AuthorityCatalogV1 {
  return buildAuthorityCatalog(ts.createProgram({ rootNames: [], options: {} }), [], relations);
}

export function auditRawSqlFixtureV1(
  sql: string,
  relation: SqlRelationAuthorityV1,
): readonly SqlAuthorityViolationKind[] {
  const catalog = fixtureCatalog([relation]);
  const contract = compileRawSql({ text: sql, tenantSchemaBound: false }, catalog);
  const violations: SqlAuthorityViolationKind[] = [];
  for (const use of contract.relations) {
    const authority = catalog.byRelation.get(use.relation);
    if (!authority) violations.push('UNKNOWN_RELATION');
    else if (authority.tenantColumn && !contract.tenantBoundAliases.has(use.alias)) {
      violations.push('UNBOUND_TENANT_RELATION');
    }
  }
  for (const ref of contract.columnRefs) {
    const authority = catalog.byRelation.get(ref.relation);
    if (authority && !authority.columnsByPhysical.has(ref.column)) {
      violations.push('UNKNOWN_RAW_COLUMN');
    }
  }
  return violations;
}

export function auditQueryBuilderFixtureV1(options: {
  readonly alias: string;
  readonly properties: readonly string[];
  readonly physicalColumns: readonly string[];
  readonly expression: string;
}): readonly SqlAuthorityViolationKind[] {
  const columns = options.properties.map((property, index) => ({
    property,
    physical: options.physicalColumns[index] ?? property,
  }));
  const authority: EntityAuthorityV1 = {
    className: 'FixtureEntity',
    relation: 'fixture',
    columnsByProperty: new Map(columns.map((column) => [column.property, column])),
    columnsByPhysical: new Map(columns.map((column) => [column.physical, column])),
    relations: new Map(),
  };
  const context: BuilderContextV1 = { aliases: new Map([[options.alias, authority]]) };
  return compileBuilderReference(options.expression, context)
    .filter((ref) =>
      ref.quoted
        ? !authority.columnsByPhysical.has(ref.column)
        : !authority.columnsByProperty.has(ref.column),
    )
    .map(() => 'UNKNOWN_QUERY_BUILDER_COLUMN');
}
