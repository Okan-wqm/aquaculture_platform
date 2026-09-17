/**
 * GraphQL transport routing for the shared requestMock seam
 * (mirrors farm-module's FARM-MEDIUM-120 scaffolding).
 *
 * Keep the `match` strings INSIDE spec files (operation names like
 * 'query MyChannels') — this module deliberately holds no operation
 * text so the FE↔BE parity and dead-contract scanners never see it as an
 * operation definition site.
 */
import { requestMock } from './sharedUiMock';

export interface GraphqlRoute {
  /** Substring matched against the raw operation text (e.g. 'query MyChannels'). */
  match: string;
  result:
    | Record<string, unknown>
    | ((variables: Record<string, unknown> | undefined) => Record<string, unknown>)
    /** Deferred-resolution variant: return a promise you settle from the test. */
    | ((variables: Record<string, unknown> | undefined) => Promise<Record<string, unknown>>);
}

/**
 * Install a route table on the shared requestMock. Unrouted operations THROW
 * with the operation head — an honest failure instead of silently-undefined
 * data that renders as an empty page.
 */
export function routeGraphql(routes: GraphqlRoute[]): void {
  requestMock.mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
    for (const route of routes) {
      if (query.includes(route.match)) {
        return typeof route.result === 'function' ? route.result(variables) : route.result;
      }
    }
    throw new Error(`Unrouted GraphQL operation: ${query.trim().slice(0, 140)}`);
  });
}
