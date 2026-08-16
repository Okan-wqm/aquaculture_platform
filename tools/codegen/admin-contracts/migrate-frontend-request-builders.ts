import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

type ContractNode =
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ContractNode>> }
  | { readonly kind: string; readonly value?: ContractNode };

interface RouteRequestEvidence {
  readonly path: ContractNode;
  readonly query: ContractNode;
  readonly headers: ContractNode;
  readonly body: ContractNode;
}

interface RouteEvidence {
  readonly id: string;
  readonly path: string;
  readonly request: RouteRequestEvidence;
}

interface Manifest {
  readonly routes: readonly RouteEvidence[];
}

interface Interpolation {
  readonly marker: string;
  readonly expression: ts.Expression;
}

interface InterpolatedExpression {
  readonly text: string;
  readonly interpolations: readonly Interpolation[];
}

const ROOT = resolve(__dirname, '../../..');
const MANIFEST = resolve(
  ROOT,
  'docs/evidence/admin-http-contracts/admin-route-contract-manifest.generated.json',
);
const API_ROOT = resolve(ROOT, 'web/modules/admin-panel/src/services/api');

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) return unwrapExpression(expression.expression);
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'encodeURIComponent' &&
    expression.arguments[0] !== undefined
  ) {
    return expression.arguments[0];
  }
  return expression;
}

function interpolate(expression: ts.Expression): InterpolatedExpression {
  const interpolations: Interpolation[] = [];
  const visit = (node: ts.Expression): string => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return (
        node.head.text +
        node.templateSpans.map((span) => `${visit(span.expression)}${span.literal.text}`).join('')
      );
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return `${visit(node.left)}${visit(node.right)}`;
    }
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    const marker = `__ADMIN_EXPR_${interpolations.length}__`;
    interpolations.push({ marker, expression: unwrapExpression(node) });
    return marker;
  };
  return { text: visit(expression), interpolations };
}

function objectFields(node: ContractNode, context: string): readonly string[] {
  if (node.kind !== 'object' || !('fields' in node)) {
    throw new Error(`${context} is not an object request contract`);
  }
  return Object.keys(node.fields);
}

function routeIdFromArgument(expression: ts.Expression): string | undefined {
  if (!ts.isElementAccessExpression(expression)) return undefined;
  const argument = expression.argumentExpression;
  return argument !== undefined && ts.isStringLiteral(argument) ? argument.text : undefined;
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((candidate) => {
    if (!('name' in candidate) || candidate.name === undefined) return false;
    return (
      (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
      candidate.name.text.toLowerCase() === name.toLowerCase()
    );
  });
}

function propertyValue(
  object: ts.ObjectLiteralExpression | undefined,
  name: string,
): ts.Expression | undefined {
  const candidate = object === undefined ? undefined : property(object, name);
  if (candidate === undefined) return undefined;
  if (ts.isPropertyAssignment(candidate)) return candidate.initializer;
  if (ts.isShorthandPropertyAssignment(candidate)) return candidate.name;
  return undefined;
}

function findCall(expression: ts.Expression, name: string): ts.CallExpression | undefined {
  let match: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (match !== undefined) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      match = node;
      return;
    }
    node.forEachChild(visit);
  };
  visit(expression);
  return match;
}

function expressionForPathField(
  route: RouteEvidence,
  endpoint: InterpolatedExpression,
  field: string,
  source: ts.SourceFile,
): string {
  const routeSegments = route.path.split('/').filter(Boolean);
  const endpointPath = endpoint.text.split('?')[0] ?? endpoint.text;
  const endpointSegments = endpointPath.split('/').filter(Boolean);
  const index = routeSegments.indexOf(`:${field}`);
  const actual = endpointSegments[index];
  if (index < 0 || actual === undefined) {
    throw new Error(`${source.fileName}: cannot align path field ${field} for ${route.id}`);
  }
  const interpolation = endpoint.interpolations.find(({ marker }) => marker === actual);
  if (interpolation === undefined) {
    throw new Error(
      `${source.fileName}: path field ${field} for ${route.id} is not one closed expression`,
    );
  }
  return interpolation.expression.getText(source);
}

function queryExpression(
  route: RouteEvidence,
  endpointExpression: ts.Expression,
  endpoint: InterpolatedExpression,
  source: ts.SourceFile,
): string | undefined {
  const fields = objectFields(route.request.query, `${route.id} query`);
  if (fields.length === 0) return undefined;
  const builder = findCall(endpointExpression, 'buildQueryString');
  if (builder?.arguments[0] !== undefined) return builder.arguments[0].getText(source);

  const queryText = endpoint.text.split('?').slice(1).join('?');
  const assignments = fields.map((field) => {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|&)${escaped}=([^&]+)`).exec(queryText);
    const token = match?.[1];
    const interpolation = endpoint.interpolations.find(({ marker }) => marker === token);
    if (interpolation !== undefined) {
      return `${JSON.stringify(field)}: ${interpolation.expression.getText(source)}`;
    }
    if (token !== undefined && token.length > 0 && !token.includes('__ADMIN_EXPR_')) {
      return `${JSON.stringify(field)}: ${JSON.stringify(decodeURIComponent(token))}`;
    }
    return `${JSON.stringify(field)}: ${field}`;
  });
  return `{ ${assignments.join(', ')} }`;
}

function bodyExpression(
  route: RouteEvidence,
  options: ts.ObjectLiteralExpression | undefined,
  source: ts.SourceFile,
): string | undefined {
  const body = propertyValue(options, 'body');
  if (body === undefined) return undefined;
  if (route.request.body.kind === 'void') {
    throw new Error(`${source.fileName}: ${route.id} sends a body to a bodyless backend route`);
  }
  if (
    ts.isCallExpression(body) &&
    ts.isPropertyAccessExpression(body.expression) &&
    ts.isIdentifier(body.expression.expression) &&
    body.expression.expression.text === 'JSON' &&
    body.expression.name.text === 'stringify' &&
    body.arguments[0] !== undefined
  ) {
    return body.arguments[0].getText(source);
  }
  throw new Error(`${source.fileName}: ${route.id} body is not an explicit JSON.stringify value`);
}

function headerExpression(
  route: RouteEvidence,
  field: string,
  options: ts.ObjectLiteralExpression | undefined,
  source: ts.SourceFile,
): string {
  const headers = propertyValue(options, 'headers');
  if (headers !== undefined) {
    const conditional = ts.isConditionalExpression(headers) ? headers.whenTrue : headers;
    if (ts.isObjectLiteralExpression(conditional)) {
      const value = propertyValue(conditional, field);
      if (value !== undefined) return value.getText(source);
    }
  }
  if (field === 'idempotency-key') return 'idempotencyKey';
  if (field === 'x-impersonation-token') return 'token';
  throw new Error(`${source.fileName}: cannot derive governed header ${field} for ${route.id}`);
}

function requestInput(
  route: RouteEvidence,
  endpointExpression: ts.Expression,
  optionsExpression: ts.Expression | undefined,
  source: ts.SourceFile,
): string | undefined {
  const endpoint = interpolate(endpointExpression);
  const options =
    optionsExpression !== undefined && ts.isObjectLiteralExpression(optionsExpression)
      ? optionsExpression
      : undefined;
  const sections: string[] = [];
  const pathFields = objectFields(route.request.path, `${route.id} path`);
  if (pathFields.length > 0) {
    sections.push(
      `path: { ${pathFields
        .map(
          (field) =>
            `${JSON.stringify(field)}: ${expressionForPathField(route, endpoint, field, source)}`,
        )
        .join(', ')} }`,
    );
  }
  const query = queryExpression(route, endpointExpression, endpoint, source);
  if (query !== undefined) sections.push(`query: ${query}`);
  const headerFields = objectFields(route.request.headers, `${route.id} headers`);
  if (headerFields.length > 0) {
    sections.push(
      `headers: { ${headerFields
        .map(
          (field) => `${JSON.stringify(field)}: ${headerExpression(route, field, options, source)}`,
        )
        .join(', ')} }`,
    );
  }
  const body = bodyExpression(route, options, source);
  if (body !== undefined) sections.push(`body: ${body}`);
  const signal = propertyValue(options, 'signal');
  if (signal !== undefined) sections.push(`signal: ${signal.getText(source)}`);
  if (optionsExpression !== undefined && options === undefined) {
    sections.push(`signal: ${optionsExpression.getText(source)}?.signal`);
  }
  return sections.length === 0 ? undefined : `{ ${sections.join(', ')} }`;
}

function migrateFile(fileName: string, routes: ReadonlyMap<string, RouteEvidence>): number {
  const original = readFileSync(fileName, 'utf8');
  const source = ts.createSourceFile(fileName, original, ts.ScriptTarget.Latest, true);
  const replacements: Array<{
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'apiFetch' || node.expression.text === 'apiFetchBlob')
    ) {
      if (
        node.arguments.length < 2 ||
        node.arguments[0] === undefined ||
        node.arguments[1] === undefined
      ) {
        node.forEachChild(visit);
        return;
      }
      if (
        ts.isObjectLiteralExpression(node.arguments[1]) &&
        node.arguments[1].properties.every(
          (candidate) =>
            'name' in candidate &&
            candidate.name !== undefined &&
            (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
            ['body', 'headers', 'path', 'query', 'signal'].includes(candidate.name.text),
        )
      ) {
        return;
      }
      const routeId = routeIdFromArgument(node.arguments[0]);
      const route = routeId === undefined ? undefined : routes.get(routeId);
      if (route === undefined) {
        throw new Error(`${fileName}: unresolved route authority ${routeId ?? '<dynamic>'}`);
      }
      const input = requestInput(route, node.arguments[1], node.arguments[2], source);
      replacements.push({
        start: node.getStart(source),
        end: node.getEnd(),
        text: `${node.expression.text}(${node.arguments[0].getText(source)}${
          input === undefined ? '' : `, ${input}`
        })`,
      });
      return;
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  let migrated = original;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    migrated = `${migrated.slice(0, replacement.start)}${replacement.text}${migrated.slice(
      replacement.end,
    )}`;
  }
  if (migrated !== original) writeFileSync(fileName, migrated);
  return replacements.length;
}

function pruneUnresolvedQueryFields(source: ts.SourceFile, checker: ts.TypeChecker): number {
  const original = readFileSync(source.fileName, 'utf8');
  const replacements: Array<{ readonly start: number; readonly end: number; readonly text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'query') ||
        (ts.isStringLiteral(node.name) && node.name.text === 'query')) &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const kept = node.initializer.properties.filter((candidate) => {
        if (!ts.isPropertyAssignment(candidate) || !ts.isIdentifier(candidate.initializer)) {
          return true;
        }
        return checker.getSymbolAtLocation(candidate.initializer) !== undefined;
      });
      if (kept.length !== node.initializer.properties.length) {
        replacements.push({
          start: node.initializer.getStart(source),
          end: node.initializer.getEnd(),
          text: `{ ${kept.map((candidate) => candidate.getText(source)).join(', ')} }`,
        });
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  let migrated = original;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    migrated = `${migrated.slice(0, replacement.start)}${replacement.text}${migrated.slice(
      replacement.end,
    )}`;
  }
  if (migrated !== original) writeFileSync(source.fileName, migrated);
  return replacements.length;
}

function main(): void {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  const routes = new Map(manifest.routes.map((route) => [route.id, route]));
  const program = ts.createProgram({
    rootNames: [...ts.sys.readDirectory(API_ROOT, ['.ts', '.tsx'])],
    options: { allowJs: false },
  });
  let count = 0;
  for (const source of program
    .getSourceFiles()
    .filter((candidate) => candidate.fileName.startsWith(API_ROOT) && !candidate.isDeclarationFile)
    .sort((left, right) => left.fileName.localeCompare(right.fileName))) {
    count += migrateFile(source.fileName, routes);
  }
  const migratedProgram = ts.createProgram({
    rootNames: [...ts.sys.readDirectory(API_ROOT, ['.ts', '.tsx'])],
    options: { allowJs: false },
  });
  const checker = migratedProgram.getTypeChecker();
  let pruned = 0;
  for (const source of migratedProgram
    .getSourceFiles()
    .filter((candidate) => candidate.fileName.startsWith(API_ROOT) && !candidate.isDeclarationFile)
    .sort((left, right) => left.fileName.localeCompare(right.fileName))) {
    pruned += pruneUnresolvedQueryFields(source, checker);
  }
  process.stdout.write(`migrated ${count} admin request builders; pruned ${pruned} stale fields\n`);
}

main();
