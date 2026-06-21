import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import {
  TenantErasureRequestedEvent,
  type TenantErasureTargetService,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { LegalHoldModule, LegalHoldService } from '../legal-hold';

import {
  TenantErasureTargetExecutor,
  type TenantErasureTargetExecutorOptions,
} from './tenant-erasure-target-executor';
import { getTenantErasureTargetOptions } from './tenant-erasure-target-registry';

export const TENANT_ERASURE_TARGET_OPTIONS = Symbol(
  'TENANT_ERASURE_TARGET_OPTIONS',
);

@Injectable()
export class TenantErasureRequestedTargetHandler
  implements IEventHandler<TenantErasureRequestedEvent>, OnModuleInit
{
  private readonly logger: Logger;
  private readonly executor: TenantErasureTargetExecutor;

  constructor(
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    @InjectDataSource()
    dataSource: DataSource,
    outboxPublisher: OutboxPublisher,
    legalHoldService: LegalHoldService,
    @Inject(TENANT_ERASURE_TARGET_OPTIONS)
    options: TenantErasureTargetExecutorOptions,
  ) {
    this.logger = new Logger(
      `TenantErasureRequestedTargetHandler:${options.targetService}`,
    );
    this.executor = new TenantErasureTargetExecutor(
      { dataSource, outboxPublisher, legalHoldService, logger: this.logger },
      options,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('TenantErasureRequested', this);
    this.logger.log('Subscribed to TenantErasureRequested');
  }

  getEventType(): string {
    return 'TenantErasureRequested';
  }

  async handle(event: TenantErasureRequestedEvent): Promise<void> {
    await this.executor.eraseFromRequest(event);
  }
}

@Module({})
export class TenantErasureTargetModule {
  static forService(targetService: TenantErasureTargetService): DynamicModule {
    return {
      module: TenantErasureTargetModule,
      imports: [LegalHoldModule.forRoot()],
      providers: [
        {
          provide: TENANT_ERASURE_TARGET_OPTIONS,
          useValue: getTenantErasureTargetOptions(targetService),
        },
        TenantErasureRequestedTargetHandler,
      ],
      exports: [TenantErasureRequestedTargetHandler],
    };
  }
}
