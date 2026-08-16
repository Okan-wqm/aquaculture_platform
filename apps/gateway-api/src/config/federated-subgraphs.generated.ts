/**
 * Generated from infrastructure/apollo-router/subgraphs.json.
 * Registry SHA256: 24bbc226cd517d38a419743bc2b5cee5b70217b746054c0384cedd6158d47379
 * Generator version: 1
 */
export interface FederatedSubgraphConfig {
  name: string;
  nxProject: string;
  urlEnv: string;
  localUrl: string;
  routingUrl: string;
  schemaArtifactPath: string;
}

export const FEDERATED_SUBGRAPHS: FederatedSubgraphConfig[] = [
  { name: 'auth', nxProject: 'auth-service', urlEnv: 'AUTH_SERVICE_URL', localUrl: 'http://localhost:3001/graphql', routingUrl: 'http://auth-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/auth.graphql' },
  { name: 'farm', nxProject: 'farm-service', urlEnv: 'FARM_SERVICE_URL', localUrl: 'http://localhost:3002/graphql', routingUrl: 'http://farm-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/farm.graphql' },
  { name: 'sensor', nxProject: 'sensor-service', urlEnv: 'SENSOR_SERVICE_URL', localUrl: 'http://localhost:3003/graphql', routingUrl: 'http://sensor-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/sensor.graphql' },
  { name: 'hr', nxProject: 'hr-service', urlEnv: 'HR_SERVICE_URL', localUrl: 'http://localhost:3005/graphql', routingUrl: 'http://hr-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/hr.graphql' },
  { name: 'hydroponics', nxProject: 'hydroponics-service', urlEnv: 'HYDROPONICS_SERVICE_URL', localUrl: 'http://localhost:4007/graphql', routingUrl: 'http://hydroponics-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/hydroponics.graphql' },
  { name: 'messaging', nxProject: 'messaging-service', urlEnv: 'MESSAGING_SERVICE_URL', localUrl: 'http://messaging-service:3000/graphql', routingUrl: 'http://messaging-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/messaging.graphql' },
  { name: 'alert', nxProject: 'alert-engine', urlEnv: 'ALERT_SERVICE_URL', localUrl: 'http://localhost:3004/graphql', routingUrl: 'http://alert-engine:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/alert.graphql' },
  { name: 'billing', nxProject: 'billing-service', urlEnv: 'BILLING_SERVICE_URL', localUrl: 'http://localhost:3006/graphql', routingUrl: 'http://billing-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/billing.graphql' },
  { name: 'notification', nxProject: 'notification-service', urlEnv: 'NOTIFICATION_SERVICE_URL', localUrl: 'http://localhost:4008/graphql', routingUrl: 'http://notification-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/notification.graphql' },
  { name: 'config', nxProject: 'config-service', urlEnv: 'CONFIG_SERVICE_URL', localUrl: 'http://localhost:3007/graphql', routingUrl: 'http://config-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/config.graphql' },
  { name: 'ai', nxProject: 'ai-service', urlEnv: 'AI_SERVICE_URL', localUrl: 'http://ai-service:3000/graphql', routingUrl: 'http://ai-service:3000/graphql', schemaArtifactPath: 'dist/graphql/subgraphs/ai.graphql' },
];
