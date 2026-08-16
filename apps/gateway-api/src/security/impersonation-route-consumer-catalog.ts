import type { Request } from 'express';
import type {
  ImpersonationModule,
  ImpersonationOperationAuthority,
  ImpersonationOperationDescriptor,
} from '@aquaculture/shared-contracts';
import { IMPERSONATION_ROUTE_CONSUMER_DECLARATIONS } from './generated/impersonation-route-consumers.generated';
import type {
  ImpersonationGatewayConsumer,
  ImpersonationGatewayRouteConsumerDeclaration,
} from './impersonation-route-consumer-declaration';

export const IMPERSONATION_GATEWAY_ROUTE_CONSUMER_CATALOG_VERSION =
  'impersonation-gateway-route-consumers/v2' as const;

export interface ImpersonationGatewayRouteConsumer {
  readonly id: string;
  readonly method: 'GET' | 'POST';
  readonly routeTemplate: string;
  readonly content: 'empty' | 'json-object';
  readonly query: 'forbidden' | 'canonical';
  readonly consumer: ImpersonationGatewayConsumer;
  readonly pathPattern: RegExp;
  readonly outwardRestOperation?: {
    readonly serviceName: string;
    readonly method: 'GET' | 'POST';
    readonly pathTemplate: string;
    readonly pathPattern: RegExp;
    readonly authority: ImpersonationOperationAuthority;
    readonly module: ImpersonationModule;
  };
}

const ROUTE_PARAMETER_SEGMENT = /^:[A-Za-z][A-Za-z0-9_]*$/u;
const REGEXP_META_CHARACTER = /[.*+?^${}()|[\]\\]/gu;

function routeTemplatePattern(template: string): RegExp {
  if (
    !template.startsWith('/') ||
    template.includes('//') ||
    (template.length > 1 && template.endsWith('/'))
  ) {
    throw new TypeError(`Non-canonical impersonation route template: ${template}`);
  }
  const pattern = template
    .split('/')
    .map((segment, index) => {
      if (index === 0) return '';
      if (ROUTE_PARAMETER_SEGMENT.test(segment)) return '[^/]+';
      if (segment.includes(':')) {
        throw new TypeError(`Non-canonical impersonation route parameter: ${segment}`);
      }
      return segment.replace(REGEXP_META_CHARACTER, '\\$&');
    })
    .join('/');
  return new RegExp(`^${pattern}$`, 'u');
}

function compileRouteConsumer(
  declaration: ImpersonationGatewayRouteConsumerDeclaration,
): ImpersonationGatewayRouteConsumer {
  const { outwardRestOperation, ...route } = declaration;
  const compiledRoute = {
    ...route,
    id: `${declaration.method} ${declaration.routeTemplate}`,
    pathPattern: routeTemplatePattern(declaration.routeTemplate),
  } as const;
  if (!outwardRestOperation) return Object.freeze(compiledRoute);
  return Object.freeze({
    ...compiledRoute,
    outwardRestOperation: Object.freeze({
      ...outwardRestOperation,
      pathPattern: routeTemplatePattern(outwardRestOperation.pathTemplate),
    }),
  });
}

/**
 * Closed census of external gateway routes that have an exact-operation
 * receipt consumer. A route absent from this list cannot carry impersonation.
 */
export const IMPERSONATION_GATEWAY_ROUTE_CONSUMERS = Object.freeze(
  [...IMPERSONATION_ROUTE_CONSUMER_DECLARATIONS].map(compileRouteConsumer),
);

export function resolveImpersonationGatewayRouteConsumer(
  method: string,
  normalizedPath: string,
): ImpersonationGatewayRouteConsumer | undefined {
  const matches = IMPERSONATION_GATEWAY_ROUTE_CONSUMERS.filter(
    (entry) => entry.method === method && entry.pathPattern.test(normalizedPath),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveImpersonationRestOperationPolicy(input: {
  readonly serviceName: string;
  readonly method: string;
  readonly path: string;
}): ImpersonationOperationDescriptor | undefined {
  const matches = IMPERSONATION_GATEWAY_ROUTE_CONSUMERS.flatMap((entry) =>
    entry.outwardRestOperation ? [entry.outwardRestOperation] : [],
  ).filter(
    (operation) =>
      operation.serviceName === input.serviceName &&
      operation.method === input.method.toUpperCase() &&
      operation.pathPattern.test(input.path),
  );
  if (matches.length !== 1) return undefined;
  const operation = matches[0];
  return operation
    ? {
        authority: operation.authority,
        module: operation.module,
        operation: `${operation.method} ${operation.pathTemplate}`,
      }
    : undefined;
}

export function assertImpersonationRouteContent(
  req: Request,
  route: ImpersonationGatewayRouteConsumer,
  hasCanonicalQuery: boolean,
): void {
  if (route.query === 'forbidden' && hasCanonicalQuery) {
    throw new TypeError('Impersonation route does not permit a query string');
  }
  if (route.content === 'empty') {
    const contentLength = req.headers['content-length'];
    if (
      req.headers['transfer-encoding'] !== undefined ||
      (contentLength !== undefined && contentLength !== '0') ||
      req.body !== undefined
    ) {
      throw new TypeError('Impersonation route requires an empty request body');
    }
    return;
  }
  const contentType = req.headers['content-type'];
  if (
    typeof contentType !== 'string' ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType) ||
    typeof req.body !== 'object' ||
    req.body === null ||
    Array.isArray(req.body) ||
    Buffer.isBuffer(req.body)
  ) {
    throw new TypeError('Impersonation route requires a parsed JSON object body');
  }
}
