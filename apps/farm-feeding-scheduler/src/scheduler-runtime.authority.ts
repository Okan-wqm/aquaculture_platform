import { FEEDING_MUTATION_AUTHORITY_CATALOG_V1 } from '@aquaculture/feeding-contracts';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { ApplicationConfig } from '@nestjs/core/application-config';

import { SystemFeedingClock } from './feeding-clock.port';
import { FeedingOperationTargetCompilerService } from './feeding-operation-target-compiler.service';
import { FeedingScheduleDispatchRepository } from './feeding-schedule-dispatch.repository';
import { FeedingScheduleIngressService } from './feeding-schedule-ingress.service';
import { FeedingSchedulerTelemetryService } from './feeding-scheduler-telemetry.service';
import {
  FEEDING_SCHEDULER_APPLICATION_MODULE_IDS,
  registeredFeedingSchedulerApplicationModules,
} from './scheduler-application-authority';
import { FeedingSchedulerConnectionAuthority } from './scheduler-database.module';

const EXACT_SCHEDULER_COMPONENTS = Object.freeze([
  FeedingSchedulerConnectionAuthority,
  FeedingOperationTargetCompilerService,
  FeedingScheduleDispatchRepository,
  SystemFeedingClock,
  FeedingScheduleIngressService,
  FeedingSchedulerTelemetryService,
]);

/** Executable proof that this process cannot accidentally double-bootstrap the farm API. */
@Injectable()
export class FeedingSchedulerRuntimeAuthority implements OnApplicationBootstrap {
  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    const providers = this.discovery.getProviders();
    for (const component of EXACT_SCHEDULER_COMPONENTS) {
      const matches = providers.filter((provider) => provider.metatype === component);
      if (matches.length !== 1 || !matches[0]?.instance) {
        throw new Error(
          `Scheduler component ${component.name} must have one initialized provider; found ${matches.length}`,
        );
      }
    }
    const registeredModules = registeredFeedingSchedulerApplicationModules();
    const registeredIds = registeredModules.map(({ authority }) => authority.id).sort();
    if (
      registeredIds.length !== new Set(registeredIds).size ||
      registeredIds.join('\0') !== [...FEEDING_SCHEDULER_APPLICATION_MODULE_IDS].sort().join('\0')
    ) {
      throw new Error('Scheduler application module registry differs from its exact authority');
    }
    for (const { moduleType, authority } of registeredModules) {
      const hosted = providers.filter((provider) => provider.host?.metatype === moduleType);
      if (hosted.length === 0) {
        throw new Error(`Scheduler application module ${authority.id} was not initialized`);
      }
      const actualApplicationTokens = hosted
        .map((provider) => provider.token)
        .filter(
          (token) => token !== moduleType && token !== ModuleRef && token !== ApplicationConfig,
        );
      if (
        actualApplicationTokens.length !== authority.providers.size ||
        actualApplicationTokens.some((token) => !authority.providers.has(token))
      ) {
        throw new Error(
          `Scheduler application module ${authority.id} differs from its exact provider authority`,
        );
      }
    }
    const schedulerIngress = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
      (mutation) => mutation.runtimeServiceId === 'farm-feeding-scheduler',
    );
    if (
      schedulerIngress.length !== 1 ||
      schedulerIngress[0]?.ingress.provider !== FeedingScheduleIngressService.name ||
      typeof Reflect.get(
        providers.find((provider) => provider.metatype === FeedingScheduleIngressService)
          ?.instance ?? {},
        schedulerIngress[0]?.ingress.method ?? '',
      ) !== 'function'
    ) {
      throw new Error('Scheduler runtime ingress differs from the mutation catalog authority');
    }
  }
}
