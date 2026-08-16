import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import ts from 'typescript';

import {
  isImpersonationModule,
  isImpersonationOperationAuthority,
} from '@aquaculture/shared-contracts';
import { Kind, parse } from 'graphql';

import { AppModule } from '../app.module';
import { FEDERATED_SUBGRAPHS } from '../config/federated-subgraphs.generated';
import {
  IMPERSONATION_GRAPHQL_OPERATION_POLICY,
  IMPERSONATION_GRAPHQL_SCHEMA_DIGESTS,
} from './generated/impersonation-graphql-operation-policy.generated';
import {
  IMPERSONATION_ROUTE_CONSUMER_PROJECTION_COORDINATES,
  IMPERSONATION_ROUTE_CONSUMER_PROJECTION_DIGEST,
} from './generated/impersonation-route-consumers.generated';
import {
  IMPERSONATION_GATEWAY_ROUTE_CONSUMERS,
  resolveImpersonationRestOperationPolicy,
} from './impersonation-route-consumer-catalog';
import { GATEWAY_GRAPHQL_IMPERSONATION_ROUTE } from './impersonation-graphql-route-consumer';

const ROOT_TYPES = new Set(['Query', 'Mutation', 'Subscription']);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function schemaRootCoordinates(schemaText: string): readonly string[] {
  const document = parse(schemaText);
  const coordinates: string[] = [];
  for (const definition of document.definitions) {
    if (
      (definition.kind !== Kind.OBJECT_TYPE_DEFINITION &&
        definition.kind !== Kind.OBJECT_TYPE_EXTENSION) ||
      !ROOT_TYPES.has(definition.name.value)
    ) {
      continue;
    }
    for (const field of definition.fields ?? []) {
      coordinates.push(`${definition.name.value}.${field.name.value}`);
    }
  }
  return coordinates.sort();
}

function nestRouteId(controller: object, handler: object): string | undefined {
  const controllerPath: unknown = Reflect.getMetadata(PATH_METADATA, controller);
  const handlerPath: unknown = Reflect.getMetadata(PATH_METADATA, handler);
  const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
  if (
    typeof controllerPath !== 'string' ||
    typeof handlerPath !== 'string' ||
    (method !== RequestMethod.GET && method !== RequestMethod.POST)
  ) {
    return undefined;
  }
  const methodName = method === RequestMethod.GET ? 'GET' : 'POST';
  return `${methodName} /${controllerPath}/${handlerPath}`;
}

interface DynamicModuleRegistration {
  readonly module?: unknown;
  readonly imports?: readonly unknown[];
  readonly forwardRef?: () => unknown;
}

function registeredNestRouteIds(rootModule: object): readonly string[] {
  const visited = new Set<object>();
  const routes: string[] = [];

  const visit = (registration: unknown): void => {
    if (typeof registration !== 'function' && (typeof registration !== 'object' || !registration)) {
      return;
    }
    const dynamic = registration as DynamicModuleRegistration;
    if (typeof dynamic.forwardRef === 'function') {
      visit(dynamic.forwardRef());
      return;
    }
    const moduleTarget =
      typeof dynamic.module === 'function'
        ? dynamic.module
        : typeof registration === 'function'
          ? registration
          : undefined;
    if (!moduleTarget || visited.has(moduleTarget)) return;
    visited.add(moduleTarget);

    const controllers: unknown = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleTarget);
    if (Array.isArray(controllers)) {
      for (const controller of controllers) {
        if (typeof controller !== 'function' || !controller.prototype) continue;
        for (const handlerName of Object.getOwnPropertyNames(controller.prototype)) {
          const handler: unknown = controller.prototype[handlerName];
          if (typeof handler !== 'function') continue;
          const routeId = nestRouteId(controller, handler);
          if (routeId) routes.push(routeId);
        }
      }
    }

    const moduleImports: unknown = Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleTarget);
    if (Array.isArray(moduleImports)) moduleImports.forEach(visit);
    if (Array.isArray(dynamic.imports)) dynamic.imports.forEach(visit);
  };

  visit(rootModule);
  return Object.freeze(routes.sort());
}

function resolvedSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (!symbol) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function graphqlRouteRegistrationCount(): number {
  const tsconfigPath = resolve(process.cwd(), 'apps/gateway-api/tsconfig.app.json');
  const loaded = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (loaded.error) {
    throw new TypeError(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(tsconfigPath));
  if (parsed.errors.length > 0) {
    throw new TypeError(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const authorityPath = resolve(
    process.cwd(),
    'apps/gateway-api/src/security/impersonation-graphql-route-consumer.ts',
  );
  const authority = program.getSourceFile(authorityPath);
  const appModule = program.getSourceFile(
    resolve(process.cwd(), 'apps/gateway-api/src/app.module.ts'),
  );
  if (!authority || !appModule) throw new TypeError('Gateway registration sources are absent');
  const moduleSymbol = checker.getSymbolAtLocation(authority);
  const routeSymbol = moduleSymbol
    ? checker
        .getExportsOfModule(moduleSymbol)
        .find((symbol) => symbol.name === 'GATEWAY_GRAPHQL_ROUTE_TEMPLATE')
    : undefined;
  if (!routeSymbol) throw new TypeError('GraphQL route authority symbol is absent');

  let registrations = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      resolvedSymbol(checker.getSymbolAtLocation(node), checker) === routeSymbol &&
      ts.isPropertyAssignment(node.parent) &&
      node.parent.initializer === node &&
      ts.isIdentifier(node.parent.name) &&
      node.parent.name.text === 'path'
    ) {
      registrations += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(appModule);
  return registrations;
}

describe('generated impersonation operation policy', () => {
  it('is a bidirectional exact-set projection of every registered live SDL root', () => {
    expect(Object.keys(IMPERSONATION_GRAPHQL_OPERATION_POLICY).sort()).toEqual(
      FEDERATED_SUBGRAPHS.map((subgraph) => subgraph.name).sort(),
    );

    for (const subgraph of FEDERATED_SUBGRAPHS) {
      if (!isImpersonationModule(subgraph.name)) {
        throw new TypeError(`Registered subgraph has no impersonation module: ${subgraph.name}`);
      }
      const schemaText = readFileSync(resolve(process.cwd(), subgraph.schemaArtifactPath), 'utf8');
      const policy = IMPERSONATION_GRAPHQL_OPERATION_POLICY[subgraph.name];
      expect(policy).toBeDefined();
      expect(Object.keys(policy ?? {}).sort()).toEqual(schemaRootCoordinates(schemaText));
      expect(IMPERSONATION_GRAPHQL_SCHEMA_DIGESTS[subgraph.name]).toBe(sha256(schemaText));
      expect(Object.values(policy ?? {}).every(isImpersonationOperationAuthority)).toBe(true);
    }
  });

  it('projects the exact live gateway receipt-consumer routes and outward REST policy', () => {
    expect(IMPERSONATION_ROUTE_CONSUMER_PROJECTION_DIGEST).toBe(
      sha256(
        `impersonation-route-consumer-projection/v1\0${IMPERSONATION_ROUTE_CONSUMER_PROJECTION_COORDINATES.join('\n')}`,
      ),
    );
    expect(graphqlRouteRegistrationCount()).toBe(1);
    expect(
      IMPERSONATION_GATEWAY_ROUTE_CONSUMERS.filter(
        (route) => route.consumer === 'federated-graphql',
      ).map((route) => route.id),
    ).toEqual([
      `${GATEWAY_GRAPHQL_IMPERSONATION_ROUTE.method} ${GATEWAY_GRAPHQL_IMPERSONATION_ROUTE.routeTemplate}`,
    ]);

    const routeCardinality = new Map<string, number>();
    for (const routeId of registeredNestRouteIds(AppModule)) {
      routeCardinality.set(routeId, (routeCardinality.get(routeId) ?? 0) + 1);
    }
    const restConsumers = IMPERSONATION_GATEWAY_ROUTE_CONSUMERS.filter(
      (route) => route.consumer !== 'federated-graphql',
    );
    expect(restConsumers.length).toBeGreaterThan(0);
    for (const route of restConsumers) {
      expect(routeCardinality.get(route.id)).toBe(1);
    }
    expect(
      restConsumers.every((route) => route.outwardRestOperation !== undefined),
    ).toBe(true);
    expect(
      resolveImpersonationRestOperationPolicy({
        serviceName: 'sensor-service',
        method: 'GET',
        path: '/api/sensors/00000000-0000-4000-8000-000000000001/export',
      }),
    ).toEqual({
      authority: 'export',
      module: 'sensor',
      operation: 'GET /api/sensors/:sensorId/export',
    });
    expect(
      resolveImpersonationRestOperationPolicy({
        serviceName: 'auth-service',
        method: 'GET',
        path: '/api/users',
      }),
    ).toBeUndefined();
  });
});
