import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
  Type,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import {
  TenantErasureRequestedEvent,
  type TenantErasureTargetService,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { LegalHoldModule, LegalHoldService } from '../legal-hold';

import { TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS } from './tenant-erasure-subscription.options';
import {
  TenantErasureTargetExecutor,
  type TenantErasurePostErasureHook,
  type TenantErasureTargetExecutorOptions,
} from './tenant-erasure-target-executor';
import { getTenantErasureTargetOptions } from './tenant-erasure-target-registry';

export const TENANT_ERASURE_TARGET_OPTIONS = Symbol('TENANT_ERASURE_TARGET_OPTIONS');

/**
 * Array of TenantErasurePostErasureHook instances the executor invokes inside
 * the erasure transaction. Always bound by forService() — an empty array for
 * services without hooks — so the handler needs no optional injection.
 */
export const TENANT_ERASURE_POST_ERASURE_HOOKS = Symbol('TENANT_ERASURE_POST_ERASURE_HOOKS');

/**
 * Per-service extension surface for TenantErasureTargetModule.forService().
 *
 * WHY classes, not instances: the hooks are injectable providers owned by the
 * consuming service (e.g. event-store's crypto-shred module), so they resolve
 * through DI with their own dependencies. `imports` carries the module(s) that
 * provide AND export those hook classes.
 */
export interface TenantErasureTargetExtension {
  readonly imports?: NonNullable<DynamicModule['imports']>;
  readonly postErasureHooks?: ReadonlyArray<Type<TenantErasurePostErasureHook>>;
}

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
    @Inject(TENANT_ERASURE_POST_ERASURE_HOOKS)
    postErasureHooks: readonly TenantErasurePostErasureHook[],
  ) {
    this.logger = new Logger(`TenantErasureRequestedTargetHandler:${options.targetService}`);
    this.executor = new TenantErasureTargetExecutor(
      {
        dataSource,
        outboxPublisher,
        legalHoldService,
        logger: this.logger,
        postErasureHooks,
      },
      options,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard(
      'TenantErasureRequested',
      this,
      TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS,
    );
    this.logger.log('Subscribed to TenantErasureRequested');
  }

  getEventType(): string {
    return 'TenantErasureRequested';
  }

  async handle(event: TenantErasureRequestedEvent): Promise<HandlerOutcome> {
    await this.executor.eraseFromRequest(event);
    return HandlerOutcome.ack();
  }
}

@Module({})
export class TenantErasureTargetModule {
  static forService(
    targetService: TenantErasureTargetService,
    extension?: TenantErasureTargetExtension,
  ): DynamicModule {
    const hookClasses = [...(extension?.postErasureHooks ?? [])];
    return {
      module: TenantErasureTargetModule,
      imports: [LegalHoldModule.forRoot(), ...(extension?.imports ?? [])],
      providers: [
        {
          provide: TENANT_ERASURE_TARGET_OPTIONS,
          useValue: getTenantErasureTargetOptions(targetService),
        },
        {
          // NestJS has no multi-provider binding, so the hook classes named by
          // the consuming service are DI-resolved here and collected into one
          // array token, preserving registration order.
          provide: TENANT_ERASURE_POST_ERASURE_HOOKS,
          useFactory: (
            ...hooks: TenantErasurePostErasureHook[]
          ): readonly TenantErasurePostErasureHook[] => hooks,
          inject: hookClasses,
        },
        TenantErasureRequestedTargetHandler,
      ],
      exports: [TenantErasureRequestedTargetHandler],
    };
  }
}
