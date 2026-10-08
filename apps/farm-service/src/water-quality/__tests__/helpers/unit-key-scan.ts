/**
 * AST scan for readers that identify a water-quality measurement's unit by one
 * column (FARM-HIGH-367, FARM-HIGH-372).
 *
 * A measurement's unit is COALESCE(tankId, equipmentId) — a tank is filed as
 * `tankId`, any other unit as `equipmentId`, and old batch rows filed a tank as
 * `equipmentId` only. Keying on either column alone drops rows: `tankId` alone
 * lost every non-tank unit (the critical list), `equipmentId` alone made
 * `update()` validate a tank row as unit-less. Readers go through
 * measurement-unit-reader.ts instead.
 *
 * The unit columns and relations are read from the entity itself (the
 * @ManyToOne relations to a tank or equipment and their @JoinColumn names), so
 * a renamed column moves the scan with it.
 */
import * as ts from 'typescript';

export const ENTITY = 'WaterQualityMeasurement';
const UNIT_TARGETS = new Set(['Tank', 'Equipment']);
const FIND_METHODS = new Set([
  'find',
  'findOne',
  'findOneOrFail',
  'findAndCount',
  'count',
  'exists',
  'findBy',
  'findOneBy',
  'findOneByOrFail',
  'findAndCountBy',
  'countBy',
  'existsBy',
]);
const WHERE_METHODS = new Set(['where', 'andWhere', 'orWhere']);

export interface UnitShape {
  /** The measurement columns that name a unit, e.g. tankId, equipmentId. */
  columns: Set<string>;
  /** The relations joined on those columns, e.g. tank, equipment. */
  relations: Set<string>;
}

export interface Violation {
  line: number;
  shape: string;
  text: string;
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoratorCall(decorator: ts.Decorator, name: string): ts.CallExpression | null {
  const call = decorator.expression;
  return ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === name
    ? call
    : null;
}

/** The unit columns/relations declared on the entity class in `source`. */
export function unitShapeOf(source: ts.SourceFile): UnitShape {
  const shape: UnitShape = { columns: new Set(), relations: new Set() };
  const columns = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === ENTITY) {
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const decorators = decoratorsOf(member);
        if (decorators.some((d) => decoratorCall(d, 'Column') !== null))
          columns.add(member.name.text);
        const relation = decorators
          .map((d) => decoratorCall(d, 'ManyToOne'))
          .find((c) => c !== null);
        const join = decorators.map((d) => decoratorCall(d, 'JoinColumn')).find((c) => c !== null);
        if (!relation || !join) continue;
        const target = relation.arguments[0];
        const targetName =
          target && ts.isArrowFunction(target) && ts.isIdentifier(target.body)
            ? target.body.text
            : target && ts.isStringLiteral(target)
              ? target.text
              : '';
        const options = join.arguments[0];
        const nameProp =
          options && ts.isObjectLiteralExpression(options)
            ? options.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name',
              )
            : undefined;
        if (UNIT_TARGETS.has(targetName) && nameProp && ts.isStringLiteral(nameProp.initializer)) {
          shape.relations.add(member.name.text);
          shape.columns.add(nameProp.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const column of shape.columns) {
    if (!columns.has(column)) throw new Error(`${ENTITY}.${column} is not a @Column`);
  }
  return shape;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isIdentifier(callee)) return callee.text;
  return null;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function hasEntityArgument(call: ts.CallExpression): boolean {
  return call.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === ENTITY);
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('${}');
  }
  return null;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every way `source` identifies a measurement's unit by one column. */
export function unitKeyViolations(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  unit: UnitShape,
): Violation[] {
  const violations: Violation[] = [];
  const report = (node: ts.Node, shape: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({ line: line + 1, shape, text: node.getText(source).slice(0, 140) });
  };
  const unitKeys = new Set([...unit.columns, ...unit.relations]);
  const columnGroup = [...unit.columns].map(escape).join('|');

  // Repositories of the entity: injected, or assigned from a repo accessor.
  // Keyed by symbol (a local or parameter, so shadowing cannot alias two
  // builders) or by `this.<member>` text for injected members.
  const repositories = new Set<ts.Symbol | string>();
  const builders = new Set<ts.Symbol | string>();
  const bindingOf = (e: ts.Node): ts.Symbol | string | undefined =>
    ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword
      ? `this.${e.name.text}`
      : ts.isIdentifier(e)
        ? checker.getSymbolAtLocation(e)
        : undefined;
  const bound = (set: Set<ts.Symbol | string>, e: ts.Node): boolean => {
    const binding = bindingOf(e);
    return binding !== undefined && set.has(binding);
  };
  const aliases = new Set<string>();

  const isRepository = (expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    if (ts.isCallExpression(e)) {
      const name = calleeName(e) ?? '';
      return /repo/i.test(name) && hasEntityArgument(e);
    }
    return bound(repositories, e);
  };
  const builderAlias = (call: ts.CallExpression): string | null => {
    if (
      calleeName(call) !== 'createQueryBuilder' ||
      !ts.isPropertyAccessExpression(call.expression)
    ) {
      return null;
    }
    const [first, second] = call.arguments;
    if (first && ts.isIdentifier(first) && first.text === ENTITY) {
      return second && ts.isStringLiteralLike(second) ? second.text : '';
    }
    if (isRepository(call.expression.expression)) {
      return first && ts.isStringLiteralLike(first) ? first.text : '';
    }
    return null;
  };
  const rootsInBuilder = (expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    if (ts.isCallExpression(e)) {
      if (builderAlias(e) !== null) return true;
      return rootsInBuilder(e.expression);
    }
    if (ts.isPropertyAccessExpression(e)) {
      return bound(builders, e) || rootsInBuilder(e.expression);
    }
    return bound(builders, e);
  };

  // Pass 1: repositories, builder variables, aliases.
  const collect = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const injected = decoratorsOf(node)
        .map((d) => decoratorCall(d, 'InjectRepository'))
        .some((call) => call !== null && hasEntityArgument(call));
      const symbol = checker.getSymbolAtLocation(node.name);
      if (injected) {
        if (symbol) repositories.add(symbol);
        repositories.add(`this.${node.name.text}`);
      }
    }
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      const injected = decoratorsOf(node)
        .map((d) => decoratorCall(d, 'InjectRepository'))
        .some((call) => call !== null && hasEntityArgument(call));
      if (injected) repositories.add(`this.${node.name.text}`);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol && isRepository(node.initializer)) repositories.add(symbol);
      else if (symbol && rootsInBuilder(node.initializer)) builders.add(symbol);
    }
    if (ts.isCallExpression(node)) {
      const alias = builderAlias(node);
      if (alias) aliases.add(alias);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const namesUnitKey = (where: ts.Node | undefined): boolean => {
    if (!where) return false;
    const e = ts.isExpression(where) ? unwrap(where) : where;
    if (ts.isArrayLiteralExpression(e)) return e.elements.some((element) => namesUnitKey(element));
    if (!ts.isObjectLiteralExpression(e)) return false;
    return e.properties.some((p) => p.name !== undefined && unitKeys.has(p.name.getText(source)));
  };
  const whereOf = (options: ts.Expression | undefined): ts.Node | undefined => {
    const e = options ? unwrap(options) : undefined;
    if (!e || !ts.isObjectLiteralExpression(e)) return undefined;
    const where = e.properties.find((p) => p.name?.getText(source) === 'where');
    return where && ts.isPropertyAssignment(where) ? where.initializer : undefined;
  };
  const isUnitColumnOfEntity = (node: ts.PropertyAccessExpression): boolean => {
    if (!unit.columns.has(node.name.text)) return false;
    const symbol = checker.getSymbolAtLocation(node.name);
    return (symbol?.declarations ?? []).some((declaration) => {
      const owner = declaration.parent;
      return ts.isClassDeclaration(owner) && owner.name?.text === ENTITY;
    });
  };
  const isColumnCopy = (node: ts.PropertyAccessExpression): boolean => {
    let current: ts.Node = node;
    while (
      ts.isParenthesizedExpression(current.parent) ||
      (ts.isBinaryExpression(current.parent) &&
        current.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        current.parent.left === current &&
        !ts.isPropertyAccessExpression(unwrap(current.parent.right)))
    ) {
      current = current.parent;
    }
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && parent.left === node) {
      return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    }
    return ts.isPropertyAssignment(parent) && parent.name.getText(source) === node.name.text;
  };

  // Pass 2: the shapes.
  const check = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== null) {
      for (const alias of aliases) {
        const reference = new RegExp(
          `(^|[^\\w."])${escape(alias)}\\.(${columnGroup})\\b|"${escape(alias)}"\\."(${columnGroup})"`,
        );
        if (!reference.test(text)) continue;
        const selected =
          ts.isStringLiteralLike(node) &&
          ts.isArrayLiteralExpression(node.parent) &&
          new RegExp(`^${escape(alias)}\\.(${columnGroup})$`).test(text);
        if (!selected) report(node, `query builder '${alias}' keyed on one unit column`);
      }
      if (/water_quality_measurements/.test(text) && new RegExp(`"(${columnGroup})"`).test(text)) {
        report(node, 'raw SQL keyed on one unit column');
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node) ?? '';
      if (
        WHERE_METHODS.has(name) &&
        ts.isPropertyAccessExpression(node.expression) &&
        rootsInBuilder(node.expression.expression) &&
        // Object form only: where({ tankId }). A second argument is the
        // parameter map of a string predicate, not a where.
        namesUnitKey(node.arguments[0])
      ) {
        report(node, 'query-builder object where on one unit column');
      }
      if (FIND_METHODS.has(name) && ts.isPropertyAccessExpression(node.expression)) {
        const [first, second] = node.arguments;
        const managerForm = first !== undefined && ts.isIdentifier(first) && first.text === ENTITY;
        const repositoryForm = !managerForm && isRepository(node.expression.expression);
        const options = managerForm ? second : repositoryForm ? first : undefined;
        if (options !== undefined) {
          const where = name.endsWith('By') ? options : whereOf(options);
          if (namesUnitKey(where)) report(node, `${name}() where on one unit column or relation`);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && isUnitColumnOfEntity(node) && !isColumnCopy(node)) {
      report(node, 'row read of one unit column');
    }
    ts.forEachChild(node, check);
  };
  check(source);
  return violations;
}
