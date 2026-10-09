/**
 * AST scan for writes that retire a measurement point (FARM-HIGH-373, plan
 * D12): every such write must be followed, inside the same function, by a
 * closeSourcesAtPoints call — the point row first, then its sources, the lock
 * order a bind relies on.
 *
 * A write is recognised by the property it sets and the TYPE of what it sets
 * it on, never by a variable name:
 * - `x.isActive = <anything but true>`, `x.isDeleted = true` where x is a point
 *   entity (Tank, System, Site, Equipment);
 * - `x.softDelete(…)` on a point entity or a repository of one;
 * - `repo.update(criteria, { isActive: <not true> | isDeleted: true })` on a
 *   repository of a point entity;
 * - `Object.assign(point, source)` where the source carries `isActive` (a
 *   request payload under any name);
 * - raw SQL that updates a point table's isActive or isDeleted.
 */
import * as ts from 'typescript';

const POINT_TYPES = new Set(['Tank', 'System', 'Site', 'Equipment']);
const POINT_TABLE_SQL =
  /\bUPDATE\s+(?:"?\w+"?\.)?"?(?:tanks|systems|sites|equipment)"?\s+SET\b[^;]*"(?:isActive|isDeleted)"/is;
const CLOSE = 'closeSourcesAtPoints';

export interface PointWrite {
  line: number;
  text: string;
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

function enclosingFunction(node: ts.Node): FunctionLike | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      return current;
    }
  }
  return null;
}

/** Whether a type is a point entity, or a repository/array of one (its type arguments). */
function isPointType(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  const named = type.aliasSymbol ?? type.getSymbol();
  if (named !== undefined && POINT_TYPES.has(named.getName())) return true;
  if (depth > 2) return false;
  if (type.isUnion()) return type.types.some((member) => isPointType(checker, member, depth + 1));
  const args =
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
      ? checker.getTypeArguments(type as ts.TypeReference)
      : (type.aliasTypeArguments ?? []);
  return args.some((arg) => isPointType(checker, arg, depth + 1));
}

/**
 * Whether `target` names an object constructed with `new` in its declaration —
 * a view or response built in memory (a tank adapted onto an Equipment), not a
 * stored point row.
 */
function isFreshObject(checker: ts.TypeChecker, target: ts.Expression): boolean {
  if (!ts.isIdentifier(target)) return false;
  const declaration = checker.getSymbolAtLocation(target)?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    ts.isNewExpression(declaration.initializer)
  );
}

function retiringValue(property: string, value: ts.Expression): boolean {
  if (property === 'isActive') return value.kind !== ts.SyntaxKind.TrueKeyword;
  if (property === 'isDeleted') return value.kind === ts.SyntaxKind.TrueKeyword;
  return false;
}

function literalRetires(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      retiringValue(property.name.text, property.initializer),
  );
}

interface Found {
  writes: ts.Node[];
  closes: ts.CallExpression[];
}

function scan(source: ts.SourceFile, checker: ts.TypeChecker): Found {
  const found: Found = { writes: [], closes: [] };
  const typeOf = (node: ts.Node): ts.Type => checker.getTypeAtLocation(node);
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      retiringValue(node.left.name.text, node.right) &&
      isPointType(checker, typeOf(node.left.expression)) &&
      !isFreshObject(checker, node.left.expression)
    ) {
      found.writes.push(node);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === CLOSE) found.closes.push(node);
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const receiver = callee.expression;
        const [first, second] = node.arguments;
        if (method === 'softDelete' && isPointType(checker, typeOf(receiver))) {
          found.writes.push(node);
        }
        if (
          method === 'update' &&
          second !== undefined &&
          ts.isObjectLiteralExpression(second) &&
          literalRetires(second) &&
          isPointType(checker, typeOf(receiver))
        ) {
          found.writes.push(node);
        }
        if (
          method === 'assign' &&
          ts.isIdentifier(receiver) &&
          receiver.text === 'Object' &&
          first !== undefined &&
          second !== undefined &&
          isPointType(checker, typeOf(first)) &&
          typeOf(second).getProperty('isActive') !== undefined
        ) {
          found.writes.push(node);
        }
      }
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      POINT_TABLE_SQL.test(node.getText(source))
    ) {
      found.writes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function describeWrite(source: ts.SourceFile, write: ts.Node): PointWrite {
  return {
    line: source.getLineAndCharacterOfPosition(write.getStart(source)).line + 1,
    text: write.getText(source).split('\n')[0]?.slice(0, 120) ?? '',
  };
}

/** Every point-retiring write in `source`, closed or not. */
export function pointWrites(source: ts.SourceFile, checker: ts.TypeChecker): PointWrite[] {
  return scan(source, checker).writes.map((write) => describeWrite(source, write));
}

/**
 * The point-retiring writes in `source` that no closeSourcesAtPoints call
 * follows inside the same function — a close before the write, or in another
 * function, leaves a bind room to commit a live source at a retired point.
 */
export function unclosedPointWrites(source: ts.SourceFile, checker: ts.TypeChecker): PointWrite[] {
  const { writes, closes } = scan(source, checker);
  return writes
    .filter((write) => {
      const scope = enclosingFunction(write);
      return !closes.some(
        (close) => enclosingFunction(close) === scope && close.getStart(source) > write.getEnd(),
      );
    })
    .map((write) => describeWrite(source, write));
}
