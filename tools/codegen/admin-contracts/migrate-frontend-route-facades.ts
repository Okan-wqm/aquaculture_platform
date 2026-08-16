/** One-shot mechanical migration from unchecked apiFetch<T> to route authorities. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const API_ROOT = resolve(REPO_ROOT, 'web/modules/admin-panel/src/services/api');
const EVIDENCE = resolve(
  REPO_ROOT,
  'docs/evidence/admin-http-contracts/admin-route-contract-manifest.generated.json',
);

interface ManifestRoute {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly response: { readonly mode: 'contract' | 'bypass' };
}

interface Manifest {
  readonly routes: readonly ManifestRoute[];
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(EVIDENCE, 'utf8')) as Manifest;
}

function sourceFiles(current: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function endpoint(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `:*${span.literal.text}`).join('');
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = endpoint(node.left);
    const right = endpoint(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function normalized(path: string): string {
  const [withoutQuery = path] = path.split('?');
  let result = withoutQuery.replace(/:[^/]+/g, ':*').replace(/\/+$/g, '');
  if (result.endsWith(':*') && !result.endsWith('/:*')) result = result.slice(0, -2);
  return result.length === 0 ? '/' : result;
}

function method(options: ts.Expression | undefined): string {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return 'GET';
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === 'method' &&
      (ts.isStringLiteral(property.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(property.initializer))
    ) {
      return property.initializer.text.toUpperCase();
    }
  }
  return 'GET';
}

function migrateFile(file: string, routesByIdentity: ReadonlyMap<string, ManifestRoute>): number {
  const original = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    original,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const replacements: Array<{
    readonly start: number;
    readonly end: number;
    readonly value: string;
  }> = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'apiFetch' &&
      node.arguments[0] !== undefined
    ) {
      if ((node.typeArguments?.length ?? 0) === 0) {
        node.forEachChild(visit);
        return;
      }
      const path = endpoint(node.arguments[0]);
      if (path === undefined) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        throw new Error(
          `${relative(REPO_ROOT, file)}:${line} endpoint is not statically resolvable`,
        );
      }
      const verb = method(node.arguments[1]);
      const route = routesByIdentity.get(`${verb} ${normalized(path)}`);
      if (route === undefined || route.response.mode !== 'contract') {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        throw new Error(
          `${relative(REPO_ROOT, file)}:${line} has no contracted route for ${verb} ${normalized(path)}`,
        );
      }
      replacements.push({
        start: node.expression.getEnd(),
        end: node.arguments[0].getStart(source),
        value: `(ADMIN_API_ROUTES[${JSON.stringify(route.id)}], `,
      });
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);

  if (replacements.length === 0) return 0;
  let migrated = original;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    migrated =
      migrated.slice(0, replacement.start) + replacement.value + migrated.slice(replacement.end);
  }
  const importLine =
    "import { ADMIN_API_ROUTES } from '../types/generated/admin-route-contracts';\n";
  if (!migrated.includes(importLine.trim())) {
    const lastImport = [...migrated.matchAll(/^import[\s\S]*?;\n/gm)].at(-1);
    if (lastImport === undefined || lastImport.index === undefined) {
      throw new Error(`${relative(REPO_ROOT, file)} has no import boundary`);
    }
    const insertion = lastImport.index + lastImport[0].length;
    migrated = migrated.slice(0, insertion) + importLine + migrated.slice(insertion);
  }
  writeFileSync(file, migrated, 'utf8');
  return replacements.length;
}

function main(): void {
  const routesByIdentity = new Map<string, ManifestRoute>();
  for (const route of manifest().routes) {
    const key = `${route.method} ${normalized(route.path)}`;
    const previous = routesByIdentity.get(key);
    if (previous !== undefined) throw new Error(`ambiguous normalized route ${key}`);
    routesByIdentity.set(key, route);
  }
  let count = 0;
  for (const file of sourceFiles(API_ROOT)) count += migrateFile(file, routesByIdentity);
  process.stdout.write(`migrated ${count} apiFetch calls to generated route authorities\n`);
}

main();
