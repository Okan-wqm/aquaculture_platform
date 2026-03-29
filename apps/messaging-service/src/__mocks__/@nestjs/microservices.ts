/**
 * Mock for @nestjs/microservices -- not installed in workspace
 * but imported by outbox-worker.service.ts and gdpr.service.ts.
 */
import { Observable, of } from 'rxjs';

export abstract class ClientProxy {
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  emit<TResult = unknown, TInput = unknown>(
    _pattern: string,
    _data: TInput,
  ): Observable<TResult> {
    return of(undefined as unknown as TResult);
  }
  send<TResult = unknown, TInput = unknown>(
    _pattern: string,
    _data: TInput,
  ): Observable<TResult> {
    return of(undefined as unknown as TResult);
  }
}

export const Transport = {
  NATS: 'NATS',
  TCP: 'TCP',
  REDIS: 'REDIS',
  MQTT: 'MQTT',
  GRPC: 'GRPC',
  RMQ: 'RMQ',
  KAFKA: 'KAFKA',
};

export class ClientsModule {
  static register(_options: unknown[]): { module: typeof ClientsModule } {
    return { module: ClientsModule };
  }
}

export interface MicroserviceOptions {
  transport?: unknown;
  options?: unknown;
}

// Decorator mocks for NATS microservice handlers
export function MessagePattern(_pattern: string): ClassDecorator & MethodDecorator {
  return () => undefined;
}

export function EventPattern(_pattern: string): ClassDecorator & MethodDecorator {
  return () => undefined;
}

export function Payload(): ParameterDecorator {
  return () => undefined;
}
