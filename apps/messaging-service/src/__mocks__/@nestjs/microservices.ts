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
  /**
   * WHY: The real ClientsModule.register() creates a provider for each client
   * config using the `name` field as the injection token. Without these
   * providers, NestJS DI fails with "can't resolve NATS_SERVICE". This mock
   * extracts each client name and provides a no-op ClientProxy instance.
   */
  static register(options: Array<{ name?: string }>): {
    module: typeof ClientsModule;
    providers: Array<{ provide: string; useValue: ClientProxy }>;
    exports: string[];
  } {
    const mockClient: ClientProxy = {
      connect: async () => undefined,
      close: async () => undefined,
      emit: (_p: string, _d: unknown) => of(undefined),
      send: (_p: string, _d: unknown) => of(undefined),
    } as unknown as ClientProxy;

    const names = (options || [])
      .filter((o) => o && typeof o.name === 'string')
      .map((o) => o.name as string);

    return {
      module: ClientsModule,
      providers: names.map((name) => ({ provide: name, useValue: mockClient })),
      exports: names,
    };
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
