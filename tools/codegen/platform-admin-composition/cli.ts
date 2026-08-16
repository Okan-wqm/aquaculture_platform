/**
 * Compile the platform-admin browser composition contract.
 *
 * Page coordinates and navigation metadata come from ADMIN_ROUTES, rendered
 * components come from the admin-panel route table, and HTTP coordinates,
 * authorization, status codes, and response kinds come from the generated
 * admin HTTP manifest. The emitted JSON is the only table consumed by the
 * real-browser Playwright journey.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

import { canonicalWireJsonStringifyV1 } from '../../../libs/shared-contracts/src/canonical-json';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PAGE_AUTHORITY_PATH = 'web/shared-ui/src/authz/admin-routes.ts';
const ROUTE_RENDERER_PATH = 'web/modules/admin-panel/src/Module.tsx';
const TENANT_LIST_PAGE_PATH = 'web/modules/admin-panel/src/pages/TenantManagementPage.tsx';
const TENANT_DETAIL_PAGE_PATH = 'web/modules/admin-panel/src/pages/TenantDetailPage.tsx';
const TENANT_API_PATH = 'web/modules/admin-panel/src/services/api/tenants.ts';
const HTTP_MANIFEST_PATH =
  'docs/evidence/admin-http-contracts/admin-route-contract-manifest.generated.json';
const OUTPUT_PATH = 'e2e/tests/platform-admin/platform-admin-composition.generated.json';

const FLAGSHIP_API_METHODS = Object.freeze({
  list: 'list',
  detail: 'getDetail',
  action: 'createNote',
  cleanup: 'deleteNote',
} as const);

const FLAGSHIP_ROUTE_IDS = Object.freeze({
  listPage: 'tenant-list',
  detailPage: 'tenant-detail',
  listApi: 'GET /admin/tenants',
  detailApi: 'GET /admin/tenants/:id/detail',
  actionApi: 'POST /admin/tenants/:id/notes',
  cleanupApi: 'DELETE /admin/tenants/:id/notes/:noteId',
} as const);

interface PageRouteSource {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly remotePath: string;
  readonly section: string;
  readonly visible: boolean;
  readonly reachableVia?: string;
}

interface NavigationSectionSource {
  readonly section: string;
  readonly label: string;
  readonly kind: string;
}

interface RenderedPageSource extends PageRouteSource {
  readonly componentSymbol: string;
  readonly componentSourceFile: string;
}

interface ApiRouteSource {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly networkAliases: readonly string[];
  readonly successStatusCode: number;
  readonly authorization: {
    readonly authentication: string;
    readonly requiredRoles: readonly string[];
    readonly requiredPermissions: readonly string[];
    readonly permissionMode: string;
  };
  readonly responseKind: string;
}

class CompositionGenerationError extends Error {}

function fail(message: string): never {
  throw new CompositionGenerationError(message);
}

function absolute(path: string): string {
  return resolve(REPO_ROOT, path);
}

function normalizedRepoPath(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

function sourceFile(path: string): ts.SourceFile {
  const source = readFileSync(absolute(path), 'utf8');
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sourceDigest(path: string): string {
  return sha256(readFileSync(absolute(path), 'utf8'));
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function variableInitializer(source: ts.SourceFile, name: string): ts.Expression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      ) {
        return unwrap(declaration.initializer);
      }
    }
  }
  return fail(`${source.fileName} has no initialized variable ${name}`);
}

function factoryArgument(expression: ts.Expression, context: string): ts.Expression {
  const unwrapped = unwrap(expression);
  if (!ts.isCallExpression(unwrapped) || unwrapped.arguments.length !== 1) {
    return fail(`${context} must be a one-argument factory call`);
  }
  const argument = unwrapped.arguments[0];
  if (argument === undefined) return fail(`${context} has no factory argument`);
  return unwrap(argument);
}

function arrayInitializer(expression: ts.Expression, context: string): ts.ArrayLiteralExpression {
  const candidate = factoryArgument(expression, context);
  if (!ts.isArrayLiteralExpression(candidate)) return fail(`${context} must wrap an array literal`);
  return candidate;
}

function objectInitializer(expression: ts.Expression, context: string): ts.ObjectLiteralExpression {
  const candidate = factoryArgument(expression, context);
  if (!ts.isObjectLiteralExpression(candidate)) {
    return fail(`${context} must wrap an object literal`);
  }
  return candidate;
}

function propertyName(name: ts.PropertyName, context: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return fail(`${context} has a non-literal property name`);
}

function objectProperties(
  object: ts.ObjectLiteralExpression,
  context: string,
): ReadonlyMap<string, ts.Expression> {
  const properties = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      fail(`${context} contains a non-property assignment`);
    }
    const name = propertyName(property.name, context);
    if (properties.has(name)) fail(`${context} contains duplicate property ${name}`);
    properties.set(name, unwrap(property.initializer));
  }
  return properties;
}

function requiredExpression(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  context: string,
): ts.Expression {
  const expression = properties.get(name);
  if (expression === undefined) return fail(`${context} is missing ${name}`);
  return expression;
}

function stringLiteral(expression: ts.Expression, context: string): string {
  const candidate = unwrap(expression);
  if (!ts.isStringLiteral(candidate) && !ts.isNoSubstitutionTemplateLiteral(candidate)) {
    return fail(`${context} must be a string literal`);
  }
  return candidate.text;
}

function booleanLiteral(expression: ts.Expression, context: string): boolean {
  const candidate = unwrap(expression);
  if (candidate.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (candidate.kind === ts.SyntaxKind.FalseKeyword) return false;
  return fail(`${context} must be a boolean literal`);
}

function pageRoutes(): readonly PageRouteSource[] {
  const source = sourceFile(PAGE_AUTHORITY_PATH);
  const array = arrayInitializer(variableInitializer(source, 'ADMIN_ROUTES'), 'ADMIN_ROUTES');
  const routes = array.elements.map((element, index) => {
    const candidate = unwrap(element);
    if (!ts.isObjectLiteralExpression(candidate)) {
      return fail(`ADMIN_ROUTES[${index}] must be an object literal`);
    }
    const context = `ADMIN_ROUTES[${index}]`;
    const properties = objectProperties(candidate, context);
    const route: PageRouteSource = {
      id: stringLiteral(requiredExpression(properties, 'id', context), `${context}.id`),
      label: stringLiteral(requiredExpression(properties, 'label', context), `${context}.label`),
      path: stringLiteral(requiredExpression(properties, 'path', context), `${context}.path`),
      remotePath: stringLiteral(
        requiredExpression(properties, 'remotePath', context),
        `${context}.remotePath`,
      ),
      section: stringLiteral(
        requiredExpression(properties, 'section', context),
        `${context}.section`,
      ),
      visible: booleanLiteral(
        requiredExpression(properties, 'visible', context),
        `${context}.visible`,
      ),
      ...(properties.get('reachableVia') === undefined
        ? {}
        : {
            reachableVia: stringLiteral(
              requiredExpression(properties, 'reachableVia', context),
              `${context}.reachableVia`,
            ),
          }),
    };
    return Object.freeze(route);
  });
  const ids = new Set(routes.map((route) => route.id));
  if (ids.size !== routes.length) fail('ADMIN_ROUTES contains duplicate ids');
  return Object.freeze(routes);
}

function navigationSections(): readonly NavigationSectionSource[] {
  const source = sourceFile(PAGE_AUTHORITY_PATH);
  const array = arrayInitializer(
    variableInitializer(source, 'ADMIN_NAV_SECTIONS'),
    'ADMIN_NAV_SECTIONS',
  );
  return Object.freeze(
    array.elements.map((element, index) => {
      const candidate = unwrap(element);
      if (!ts.isObjectLiteralExpression(candidate)) {
        return fail(`ADMIN_NAV_SECTIONS[${index}] must be an object literal`);
      }
      const context = `ADMIN_NAV_SECTIONS[${index}]`;
      const properties = objectProperties(candidate, context);
      return Object.freeze({
        section: stringLiteral(
          requiredExpression(properties, 'section', context),
          `${context}.section`,
        ),
        label: stringLiteral(requiredExpression(properties, 'label', context), `${context}.label`),
        kind: stringLiteral(requiredExpression(properties, 'kind', context), `${context}.kind`),
      });
    }),
  );
}

function lazyComponentImports(source: ts.SourceFile): ReadonlyMap<string, string> {
  const imports = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.initializer === undefined ||
        !ts.isCallExpression(unwrap(declaration.initializer))
      ) {
        continue;
      }
      const lazyCall = unwrap(declaration.initializer);
      if (!ts.isCallExpression(lazyCall)) continue;
      if (!ts.isIdentifier(lazyCall.expression) || lazyCall.expression.text !== 'lazy') continue;
      const loader = lazyCall.arguments[0];
      if (loader === undefined || !ts.isArrowFunction(loader) || ts.isBlock(loader.body)) {
        fail(`${source.fileName}#${declaration.name.text} has a non-literal lazy loader`);
      }
      const importCall = unwrap(loader.body);
      if (
        !ts.isCallExpression(importCall) ||
        importCall.expression.kind !== ts.SyntaxKind.ImportKeyword ||
        importCall.arguments.length !== 1
      ) {
        fail(`${source.fileName}#${declaration.name.text} has a non-import lazy loader`);
      }
      const specifier = importCall.arguments[0];
      if (specifier === undefined)
        fail(`${source.fileName}#${declaration.name.text} has no import`);
      imports.set(
        declaration.name.text,
        stringLiteral(specifier, `${source.fileName}#${declaration.name.text} import`),
      );
    }
  }
  return imports;
}

function renderedPages(routes: readonly PageRouteSource[]): readonly RenderedPageSource[] {
  const source = sourceFile(ROUTE_RENDERER_PATH);
  const imports = lazyComponentImports(source);
  const componentObject = objectInitializer(
    variableInitializer(source, 'ADMIN_ROUTE_COMPONENTS'),
    'ADMIN_ROUTE_COMPONENTS',
  );
  const componentProperties = objectProperties(componentObject, 'ADMIN_ROUTE_COMPONENTS');
  const routeIds = new Set(routes.map((route) => route.id));
  if (componentProperties.size !== routes.length) {
    fail(
      `ADMIN_ROUTE_COMPONENTS has ${componentProperties.size} entries for ${routes.length} ADMIN_ROUTES`,
    );
  }
  for (const id of componentProperties.keys()) {
    if (!routeIds.has(id)) fail(`ADMIN_ROUTE_COMPONENTS references unknown page route ${id}`);
  }
  return Object.freeze(
    routes.map((route) => {
      const componentExpression = componentProperties.get(route.id);
      if (componentExpression === undefined || !ts.isIdentifier(componentExpression)) {
        return fail(`ADMIN_ROUTE_COMPONENTS.${route.id} must reference one component identifier`);
      }
      const importPath = imports.get(componentExpression.text);
      if (importPath === undefined) {
        return fail(`component ${componentExpression.text} has no literal lazy import`);
      }
      const componentAbsolute = resolve(
        dirname(absolute(ROUTE_RENDERER_PATH)),
        `${importPath}.tsx`,
      );
      if (!existsSync(componentAbsolute)) {
        return fail(`${route.id} component source does not exist: ${componentAbsolute}`);
      }
      return Object.freeze({
        ...route,
        componentSymbol: componentExpression.text,
        componentSourceFile: normalizedRepoPath(componentAbsolute),
      });
    }),
  );
}

function collectObjectRouteReferences(
  source: ts.SourceFile,
  objectName: string,
): ReadonlyMap<string, readonly string[]> {
  const object = variableInitializer(source, objectName);
  if (!ts.isObjectLiteralExpression(object)) {
    return fail(`${source.fileName}#${objectName} must be an object literal`);
  }
  const result = new Map<string, readonly string[]>();
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) {
      fail(`${source.fileName}#${objectName} has a non-property member`);
    }
    const memberName = propertyName(member.name, `${source.fileName}#${objectName}`);
    const routeIds: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'ADMIN_API_ROUTES' &&
        node.argumentExpression !== undefined
      ) {
        routeIds.push(
          stringLiteral(
            node.argumentExpression,
            `${source.fileName}#${objectName}.${memberName} route authority`,
          ),
        );
      }
      node.forEachChild(visit);
    };
    member.initializer.forEachChild(visit);
    result.set(memberName, Object.freeze(routeIds));
  }
  return result;
}

function calledObjectMethods(source: ts.SourceFile, objectName: string): ReadonlySet<string> {
  const methods = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === objectName
    ) {
      methods.add(node.expression.name.text);
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return methods;
}

function assertPageCalls(sourcePath: string, methods: readonly string[]): void {
  const calls = calledObjectMethods(sourceFile(sourcePath), 'tenantsApi');
  for (const method of methods) {
    if (!calls.has(method)) fail(`${sourcePath} does not call tenantsApi.${method}`);
  }
}

function jsxStrings(sourcePath: string): ReadonlySet<string> {
  const values = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = node.getText().trim();
      if (text.length > 0) values.add(text);
    }
    if (
      ts.isJsxAttribute(node) &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer)
    ) {
      values.add(node.initializer.text);
    }
    node.forEachChild(visit);
  };
  sourceFile(sourcePath).forEachChild(visit);
  return values;
}

function assertJsxStrings(sourcePath: string, values: readonly string[]): void {
  const sourceValues = jsxStrings(sourcePath);
  for (const value of values) {
    if (!sourceValues.has(value)) fail(`${sourcePath} has no JSX string ${JSON.stringify(value)}`);
  }
}

function objectValue(value: unknown, context: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`${context} must be an object`);
  }
  return value;
}

function property(value: object, name: string): unknown {
  const result: unknown = Reflect.get(value, name);
  return result;
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) return fail(`${context} must be a string`);
  return value;
}

function numberValue(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return fail(`${context} must be a safe integer`);
  }
  return value;
}

function arrayValue(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail(`${context} must be an array`);
  return value;
}

function stringValues(value: unknown, context: string): readonly string[] {
  return Object.freeze(
    arrayValue(value, context).map((entry, index) => stringValue(entry, `${context}[${index}]`)),
  );
}

function apiRoutes(): {
  readonly manifestDigest: string;
  readonly routes: ReadonlyMap<string, ApiRouteSource>;
} {
  const parsed: unknown = JSON.parse(readFileSync(absolute(HTTP_MANIFEST_PATH), 'utf8'));
  const manifest = objectValue(parsed, 'admin HTTP manifest');
  const manifestDigest = stringValue(property(manifest, 'manifestDigest'), 'manifestDigest');
  const runtimeProjection = objectValue(
    property(manifest, 'runtimeProjection'),
    'runtimeProjection',
  );
  const schemaKinds = new Map<string, string>();
  for (const [index, entry] of arrayValue(
    property(runtimeProjection, 'schemas'),
    'runtimeProjection.schemas',
  ).entries()) {
    const schema = objectValue(entry, `runtimeProjection.schemas[${index}]`);
    const digest = stringValue(
      property(schema, 'digest'),
      `runtimeProjection.schemas[${index}].digest`,
    );
    const node = objectValue(property(schema, 'node'), `runtimeProjection.schemas[${index}].node`);
    schemaKinds.set(
      digest,
      stringValue(property(node, 'kind'), `runtimeProjection.schemas[${index}].node.kind`),
    );
  }
  const runtimeSchemaByRoute = new Map<string, string>();
  for (const [index, entry] of arrayValue(
    property(runtimeProjection, 'routes'),
    'runtimeProjection.routes',
  ).entries()) {
    const route = objectValue(entry, `runtimeProjection.routes[${index}]`);
    const id = stringValue(property(route, 'id'), `runtimeProjection.routes[${index}].id`);
    const response = objectValue(
      property(route, 'response'),
      `runtimeProjection.routes[${index}].response`,
    );
    if (property(response, 'mode') !== 'contract') continue;
    runtimeSchemaByRoute.set(
      id,
      stringValue(
        property(response, 'schemaDigest'),
        `runtimeProjection.routes[${index}].response.schemaDigest`,
      ),
    );
  }
  const routes = new Map<string, ApiRouteSource>();
  for (const [index, entry] of arrayValue(property(manifest, 'routes'), 'routes').entries()) {
    const route = objectValue(entry, `routes[${index}]`);
    const id = stringValue(property(route, 'id'), `routes[${index}].id`);
    const authorization = objectValue(
      property(route, 'authorization'),
      `routes[${index}].authorization`,
    );
    const schemaDigest = runtimeSchemaByRoute.get(id);
    if (schemaDigest === undefined) continue;
    const responseKind = schemaKinds.get(schemaDigest);
    if (responseKind === undefined)
      fail(`${id} references unknown response schema ${schemaDigest}`);
    if (routes.has(id)) fail(`admin HTTP manifest contains duplicate route ${id}`);
    routes.set(
      id,
      Object.freeze({
        id,
        method: stringValue(property(route, 'method'), `${id}.method`),
        path: stringValue(property(route, 'path'), `${id}.path`),
        networkAliases: stringValues(property(route, 'networkAliases'), `${id}.networkAliases`),
        successStatusCode: numberValue(
          property(route, 'successStatusCode'),
          `${id}.successStatusCode`,
        ),
        authorization: Object.freeze({
          authentication: stringValue(
            property(authorization, 'authentication'),
            `${id}.authorization.authentication`,
          ),
          requiredRoles: stringValues(
            property(authorization, 'requiredRoles'),
            `${id}.authorization.requiredRoles`,
          ),
          requiredPermissions: stringValues(
            property(authorization, 'requiredPermissions'),
            `${id}.authorization.requiredPermissions`,
          ),
          permissionMode: stringValue(
            property(authorization, 'permissionMode'),
            `${id}.authorization.permissionMode`,
          ),
        }),
        responseKind,
      }),
    );
  }
  return Object.freeze({ manifestDigest, routes });
}

function requiredPage(pages: readonly RenderedPageSource[], id: string): RenderedPageSource {
  const page = pages.find((candidate) => candidate.id === id);
  if (page === undefined) return fail(`missing rendered page ${id}`);
  return page;
}

function requiredApi(routes: ReadonlyMap<string, ApiRouteSource>, id: string): ApiRouteSource {
  const route = routes.get(id);
  if (route === undefined) return fail(`missing admin HTTP route ${id}`);
  if (
    route.authorization.authentication !== 'bearer-session' ||
    route.authorization.permissionMode !== 'all' ||
    route.authorization.requiredRoles.length !== 1 ||
    route.authorization.requiredRoles[0] !== 'SUPER_ADMIN' ||
    route.authorization.requiredPermissions.length !== 0
  ) {
    fail(`${id} is not exact SUPER_ADMIN bearer-session authorization`);
  }
  return route;
}

function generatedContent(): string {
  const pages = renderedPages(pageRoutes());
  const sections = navigationSections();
  const http = apiRoutes();
  const tenantApiRoutes = collectObjectRouteReferences(sourceFile(TENANT_API_PATH), 'tenantsApi');
  const requiredMethodRoutes = new Map<string, string>([
    [FLAGSHIP_API_METHODS.list, FLAGSHIP_ROUTE_IDS.listApi],
    [FLAGSHIP_API_METHODS.detail, FLAGSHIP_ROUTE_IDS.detailApi],
    [FLAGSHIP_API_METHODS.action, FLAGSHIP_ROUTE_IDS.actionApi],
    [FLAGSHIP_API_METHODS.cleanup, FLAGSHIP_ROUTE_IDS.cleanupApi],
  ]);
  for (const [method, expectedRouteId] of requiredMethodRoutes) {
    const references = tenantApiRoutes.get(method);
    if (references === undefined || references.length !== 1 || references[0] !== expectedRouteId) {
      fail(
        `${TENANT_API_PATH}#tenantsApi.${method} must consume only ${expectedRouteId}; got ` +
          `${references?.join(', ') ?? '<missing>'}`,
      );
    }
  }
  assertPageCalls(TENANT_LIST_PAGE_PATH, [FLAGSHIP_API_METHODS.list]);
  assertPageCalls(TENANT_DETAIL_PAGE_PATH, [
    FLAGSHIP_API_METHODS.detail,
    FLAGSHIP_API_METHODS.action,
    FLAGSHIP_API_METHODS.cleanup,
  ]);
  assertJsxStrings(TENANT_LIST_PAGE_PATH, ['Details']);
  assertJsxStrings(TENANT_DETAIL_PAGE_PATH, [
    'Notes',
    'Add Note',
    'Note content...',
    'Save',
    'Delete',
  ]);

  const listPage = requiredPage(pages, FLAGSHIP_ROUTE_IDS.listPage);
  const detailPage = requiredPage(pages, FLAGSHIP_ROUTE_IDS.detailPage);
  if (!listPage.visible || detailPage.visible || detailPage.reachableVia === undefined) {
    fail('flagship list/detail page visibility and reachability contract drifted');
  }
  const section = sections.find((candidate) => candidate.section === listPage.section);
  if (section === undefined || section.kind !== 'group') {
    fail(`flagship section ${listPage.section} must be a navigation group`);
  }
  const listApi = requiredApi(http.routes, FLAGSHIP_ROUTE_IDS.listApi);
  const detailApi = requiredApi(http.routes, FLAGSHIP_ROUTE_IDS.detailApi);
  const actionApi = requiredApi(http.routes, FLAGSHIP_ROUTE_IDS.actionApi);
  const cleanupApi = requiredApi(http.routes, FLAGSHIP_ROUTE_IDS.cleanupApi);
  if (
    listApi.responseKind !== 'page' ||
    detailApi.responseKind !== 'object' ||
    actionApi.responseKind !== 'object' ||
    cleanupApi.responseKind !== 'void'
  ) {
    fail('flagship response kinds drifted from page/object/object/void');
  }

  const core = Object.freeze({
    schemaVersion: 'platform-admin-page-composition.v1',
    authority: 'compiled-admin-page-route-auth-http-composition',
    sources: Object.freeze({
      pageAuthority: Object.freeze({
        path: PAGE_AUTHORITY_PATH,
        sha256: sourceDigest(PAGE_AUTHORITY_PATH),
      }),
      routeRenderer: Object.freeze({
        path: ROUTE_RENDERER_PATH,
        sha256: sourceDigest(ROUTE_RENDERER_PATH),
      }),
      tenantListPage: Object.freeze({
        path: TENANT_LIST_PAGE_PATH,
        sha256: sourceDigest(TENANT_LIST_PAGE_PATH),
      }),
      tenantDetailPage: Object.freeze({
        path: TENANT_DETAIL_PAGE_PATH,
        sha256: sourceDigest(TENANT_DETAIL_PAGE_PATH),
      }),
      tenantApi: Object.freeze({ path: TENANT_API_PATH, sha256: sourceDigest(TENANT_API_PATH) }),
      httpManifest: Object.freeze({
        path: HTTP_MANIFEST_PATH,
        manifestDigest: http.manifestDigest,
      }),
    }),
    panelAuthorization: Object.freeze({
      authentication: 'bearer-session',
      requiredRole: 'SUPER_ADMIN',
      insufficientRole: 'TENANT_ADMIN',
    }),
    pages,
    flagshipJourney: Object.freeze({
      id: 'tenant-list-detail-note-lifecycle',
      navigation: Object.freeze({
        groupLabel: section.label,
        leafLabel: listPage.label,
      }),
      list: Object.freeze({ page: listPage, api: listApi, rowActionLabel: 'Details' }),
      detail: Object.freeze({ page: detailPage, api: detailApi, tabLabel: 'Notes' }),
      action: Object.freeze({
        api: actionApi,
        openLabel: 'Add Note',
        inputPlaceholder: 'Note content...',
        submitLabel: 'Save',
      }),
      cleanup: Object.freeze({ api: cleanupApi, actionLabel: 'Delete' }),
      errors: Object.freeze({
        unauthorizedBrowserPath: '/unauthorized',
        unauthorizedHeading: 'Access Denied',
        missingResourceStatus: 404,
        missingResourceCode: 'NOT_FOUND',
        unknownApiPath: '/api/admin/__platform_admin_e2e_unknown__',
        unknownApiStatus: 404,
        unknownApiCode: 'NOT_FOUND',
      }),
      wireContracts: Object.freeze({
        success: 'admin-http.v1',
        error: 'admin-http-error.v1',
      }),
    }),
  });
  const projectionDigest = sha256(
    `platform-admin-page-composition.v1\0${canonicalWireJsonStringifyV1(core)}`,
  );
  return `${canonicalWireJsonStringifyV1({ ...core, projectionDigest })}\n`;
}

function run(): void {
  const check = process.argv.includes('--check');
  let content: string;
  try {
    content = generatedContent();
  } catch (error) {
    if (error instanceof CompositionGenerationError) {
      process.stderr.write(`platform-admin composition codegen: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const output = absolute(OUTPUT_PATH);
  if (check) {
    const current = existsSync(output) ? readFileSync(output, 'utf8') : '';
    if (current !== content) {
      process.stderr.write(`platform-admin composition codegen: ${OUTPUT_PATH} is stale\n`);
      process.exit(1);
    }
    process.stdout.write(`platform-admin composition codegen: ${OUTPUT_PATH} is up to date\n`);
    return;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, content, 'utf8');
  process.stdout.write(`platform-admin composition codegen: wrote ${OUTPUT_PATH}\n`);
}

run();
