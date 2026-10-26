/**
 * Source readers for `role-hierarchy-single-owner.spec.ts`: they find, in the syntax tree, the
 * three shapes a copy of the platform role hierarchy has taken in this repository.
 *
 * - `hierarchy map`: an object literal keyed by platform roles whose values are role lists or
 *   ranks — the backend `ROLE_HIERARCHY`, the web copy beside it, auth's `ROLE_LEVELS`, the
 *   invite check's `ranks` and the mobile `ROLE_RANK` all had this shape;
 *   (`{ SUPER_ADMIN: ['TENANT_ADMIN', …] }`, `{ [Role.SUPER_ADMIN]: 4 }`).
 * - `order`: one array literal naming all four platform roles — the user entity's `roleOrder`.
 * - `union`: a type union of two or more platform role literals — the three web `UserRole`s.
 *
 * A role is named by its string literal, by a property access ending in it (`Role.TENANT_ADMIN`,
 * `PLATFORM_ROLE.TENANT_ADMIN`) or, as an object key, by its bare identifier.
 */
import ts from 'typescript';

export interface RoleVocabularyCopy {
  readonly where: string;
  readonly kind: 'hierarchy map' | 'order' | 'union';
  readonly roles: readonly string[];
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

export function roleVocabularyCopies(
  rel: string,
  source: string,
  roles: ReadonlySet<string>,
): RoleVocabularyCopy[] {
  const file = parse(rel, source);
  const copies: RoleVocabularyCopy[] = [];
  const where = (node: ts.Node): string =>
    `${rel}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;

  const roleOf = (node: ts.Node | undefined): string | undefined => {
    if (node === undefined) return undefined;
    if (ts.isStringLiteralLike(node) || ts.isIdentifier(node)) {
      return roles.has(node.text) ? node.text : undefined;
    }
    if (ts.isPropertyAccessExpression(node)) return roleOf(node.name);
    if (ts.isComputedPropertyName(node)) return roleOf(node.expression);
    return undefined;
  };

  const isRankOrRoleList = (node: ts.Expression): boolean =>
    ts.isArrayLiteralExpression(node) ||
    ts.isNumericLiteral(node) ||
    (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand));

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keyed = node.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) || !isRankOrRoleList(property.initializer)) {
          return [];
        }
        const role = roleOf(property.name);
        return role === undefined ? [] : [role];
      });
      if (new Set(keyed).size >= 2) {
        copies.push({ where: where(node), kind: 'hierarchy map', roles: [...new Set(keyed)] });
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      const named = new Set(node.elements.flatMap((element) => roleOf(element) ?? []));
      if (named.size === roles.size) {
        copies.push({ where: where(node), kind: 'order', roles: [...named] });
      }
    } else if (ts.isUnionTypeNode(node)) {
      const named = new Set(
        node.types.flatMap((member) =>
          ts.isLiteralTypeNode(member) ? (roleOf(member.literal) ?? []) : [],
        ),
      );
      if (named.size >= 2) {
        copies.push({ where: where(node), kind: 'union', roles: [...named] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return copies;
}

/** The source with comments removed, so prose naming a role is never read as code. */
export function codeOf(rel: string, source: string): string {
  const file = parse(rel, source);
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printFile(file);
}
