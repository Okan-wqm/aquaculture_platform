/**
 * Type declarations for @nestjs/microservices.
 * The package is not installed in the workspace but is imported
 * by outbox-worker.service.ts and gdpr.service.ts at compile time.
 * At runtime, it resolves to __mocks__/@nestjs/microservices.ts via moduleNameMapper.
 */
declare module '@nestjs/microservices' {
  import { Observable } from 'rxjs';
  import { DynamicModule } from '@nestjs/common';

  export abstract class ClientProxy {
    abstract connect(): Promise<void>;
    abstract close(): Promise<void>;
    emit<TResult = unknown, TInput = unknown>(
      pattern: string,
      data: TInput,
    ): Observable<TResult>;
    send<TResult = unknown, TInput = unknown>(
      pattern: string,
      data: TInput,
    ): Observable<TResult>;
  }

  export const Transport: {
    NATS: string;
    TCP: string;
    REDIS: string;
    MQTT: string;
    GRPC: string;
    RMQ: string;
    KAFKA: string;
  };

  export class ClientsModule {
    static register(options: unknown[]): DynamicModule;
  }

  export interface MicroserviceOptions {
    transport?: unknown;
    options?: unknown;
  }
}
