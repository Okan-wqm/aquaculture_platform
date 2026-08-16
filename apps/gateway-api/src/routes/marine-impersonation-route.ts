import { defineImpersonationRouteConsumer } from '../security/impersonation-route-consumer-declaration';

const GATEWAY_MARINE_EXTERNAL_BASE = '/api/marine';
export const GATEWAY_MARINE_CONTROLLER_PATH = GATEWAY_MARINE_EXTERNAL_BASE.slice(1);
export const GATEWAY_MARINE_RENDER_HANDLER_PATH = 'sites/:siteId/render';
export const GATEWAY_MARINE_RENDER_ROUTE_TEMPLATE =
  `${GATEWAY_MARINE_EXTERNAL_BASE}/${GATEWAY_MARINE_RENDER_HANDLER_PATH}`;
export const GATEWAY_MARINE_RENDER_OUTWARD_TEMPLATE =
  '/api/internal/marine/sites/:siteId/render';

export function marineRenderOutwardPath(siteId: string): string {
  return GATEWAY_MARINE_RENDER_OUTWARD_TEMPLATE.replace(
    ':siteId',
    encodeURIComponent(siteId),
  );
}

export const GATEWAY_MARINE_IMPERSONATION_ROUTE = defineImpersonationRouteConsumer({
  method: 'POST',
  routeTemplate: GATEWAY_MARINE_RENDER_ROUTE_TEMPLATE,
  content: 'json-object',
  query: 'forbidden',
  consumer: 'marine-render',
  outwardRestOperation: Object.freeze({
    serviceName: 'farm-service',
    method: 'POST',
    pathTemplate: GATEWAY_MARINE_RENDER_OUTWARD_TEMPLATE,
    authority: 'data.write',
    module: 'farm',
  }),
});
