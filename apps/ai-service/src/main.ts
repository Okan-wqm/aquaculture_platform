// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'ai-service',
  // ADR-0006: reached only over the Docker network (gateway federation / NATS);
  // nginx proxies nothing here, so no CORS and no edge bundle.
  serviceVisibility: 'internal',
  portEnvVar: 'AI_SERVICE_PORT',
  hasGraphQL: true,
  // Connect the NATS microservice transport so the request.ai.chat responder
  // (AiChatResponder) — plus the messaging AI bridge subjects — are served.
  // The queue group load-balances across ai-service replicas.
  natsTransport: { queue: 'ai-service' },
});
