/**
 * GraphQL transport routing for the shared requestMock seam
 * (FARM-MEDIUM-120 test campaign scaffolding).
 *
 * Keep the `match` strings INSIDE spec files (operation names like
 * 'query AvailableTanks') — this module deliberately holds no operation
 * text so the FE↔BE parity and dead-contract scanners never see it as an
 * operation definition site.
 */
import { requestMock } from './sharedUiMock';

export interface GraphqlRoute {
  /** Substring matched against the raw operation text (e.g. 'query AvailableTanks'). */
  match: string;
  result:
    | Record<string, unknown>
    | ((variables: Record<string, unknown> | undefined) => Record<string, unknown>);
}

/**
 * Install a route table on the shared requestMock. Unrouted operations THROW
 * with the operation head — an honest failure instead of silently-undefined
 * data that renders as an empty page.
 */
export function routeGraphql(routes: GraphqlRoute[]): void {
  requestMock.mockImplementation(
    async (query: string, variables?: Record<string, unknown>) => {
      for (const route of routes) {
        if (query.includes(route.match)) {
          return typeof route.result === 'function' ? route.result(variables) : route.result;
        }
      }
      throw new Error(`Unrouted GraphQL operation: ${query.trim().slice(0, 140)}`);
    },
  );
}
