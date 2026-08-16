import { SetMetadata, type InjectionToken } from '@nestjs/common';

export const FEEDING_SCHEDULER_APPLICATION_MODULE_METADATA =
  'aquaculture:feeding-scheduler-application-module/v1';

export const FEEDING_SCHEDULER_APPLICATION_MODULE_IDS = Object.freeze([
  'app-root',
  'database-boundary',
  'scheduler-runtime',
] as const);

export type FeedingSchedulerApplicationModuleId =
  (typeof FEEDING_SCHEDULER_APPLICATION_MODULE_IDS)[number];

export interface FeedingSchedulerApplicationModuleAuthorityV1 {
  readonly schemaVersion: 'feeding-scheduler-application-module-authority/v1';
  readonly id: FeedingSchedulerApplicationModuleId;
  readonly providers: ReadonlySet<InjectionToken>;
}

type FeedingSchedulerApplicationModuleType = abstract new (...args: never[]) => object;

interface RegisteredFeedingSchedulerApplicationModule {
  readonly moduleType: FeedingSchedulerApplicationModuleType;
  readonly authority: FeedingSchedulerApplicationModuleAuthorityV1;
}

const registeredModules = new Map<
  FeedingSchedulerApplicationModuleType,
  FeedingSchedulerApplicationModuleAuthorityV1
>();

export function FeedingSchedulerApplicationModule(
  id: FeedingSchedulerApplicationModuleId,
  providers: readonly InjectionToken[],
): (target: FeedingSchedulerApplicationModuleType) => void {
  const authority: FeedingSchedulerApplicationModuleAuthorityV1 = Object.freeze({
    schemaVersion: 'feeding-scheduler-application-module-authority/v1',
    id,
    providers: new Set(providers),
  });
  return (target): void => {
    if (registeredModules.has(target)) {
      throw new Error('Feeding scheduler application module authority is duplicated');
    }
    registeredModules.set(target, authority);
    SetMetadata(FEEDING_SCHEDULER_APPLICATION_MODULE_METADATA, authority)(target);
  };
}

export function registeredFeedingSchedulerApplicationModules(): readonly RegisteredFeedingSchedulerApplicationModule[] {
  return Object.freeze(
    [...registeredModules].map(([moduleType, authority]) =>
      Object.freeze({ moduleType, authority }),
    ),
  );
}
