import { defineImpersonationRouteConsumer } from './impersonation-route-consumer-declaration';

export const GATEWAY_GRAPHQL_ROUTE_TEMPLATE = '/graphql';

/** The same path is consumed by Apollo registration and the receipt catalog. */
export const GATEWAY_GRAPHQL_IMPERSONATION_ROUTE = defineImpersonationRouteConsumer({
  method: 'POST',
  routeTemplate: GATEWAY_GRAPHQL_ROUTE_TEMPLATE,
  content: 'json-object',
  query: 'forbidden',
  consumer: 'federated-graphql',
});
