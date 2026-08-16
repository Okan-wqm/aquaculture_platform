import { defineImpersonationRouteConsumer } from '../../security/impersonation-route-consumer-declaration';

const GATEWAY_SENSOR_EXTERNAL_BASE = '/api/v1/sensors';
export const GATEWAY_SENSOR_CONTROLLER_PATH = GATEWAY_SENSOR_EXTERNAL_BASE.slice(1);
export const GATEWAY_SENSOR_MQTT_HANDLER_PATH = 'mqtt/status';
export const GATEWAY_SENSOR_EXPORT_HANDLER_PATH = ':sensorId/export';
export const SENSOR_MQTT_OUTWARD_PATH = '/api/mqtt/status';
export const SENSOR_EXPORT_OUTWARD_TEMPLATE = '/api/sensors/:sensorId/export';

export const GATEWAY_SENSOR_MQTT_IMPERSONATION_ROUTE =
  defineImpersonationRouteConsumer({
    method: 'GET',
    routeTemplate: `${GATEWAY_SENSOR_EXTERNAL_BASE}/${GATEWAY_SENSOR_MQTT_HANDLER_PATH}`,
    content: 'empty',
    query: 'forbidden',
    consumer: 'sensor-mqtt-status',
    outwardRestOperation: Object.freeze({
      serviceName: 'sensor-service',
      method: 'GET',
      pathTemplate: SENSOR_MQTT_OUTWARD_PATH,
      authority: 'data.read',
      module: 'sensor',
    }),
  });

export const GATEWAY_SENSOR_EXPORT_IMPERSONATION_ROUTE =
  defineImpersonationRouteConsumer({
    method: 'GET',
    routeTemplate: `${GATEWAY_SENSOR_EXTERNAL_BASE}/${GATEWAY_SENSOR_EXPORT_HANDLER_PATH}`,
    content: 'empty',
    query: 'canonical',
    consumer: 'sensor-export',
    outwardRestOperation: Object.freeze({
      serviceName: 'sensor-service',
      method: 'GET',
      pathTemplate: SENSOR_EXPORT_OUTWARD_TEMPLATE,
      authority: 'export',
      module: 'sensor',
    }),
  });
