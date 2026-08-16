import { Injectable, type OnApplicationBootstrap, type Provider, type Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1 } from '@aquaculture/shared-contracts';
import {
  FEEDING_AGGREGATE_MUTATION_WRITER_AUTHORITY_ID,
  FEEDING_MUTATION_AUTHORITY_CATALOG_V1,
  FEEDING_MUTATION_RUNTIME_PROVIDER_AUTHORITIES_V1,
  FEEDING_TENANT_TRANSACTION_MUTATION_IDS_V1,
  assertExactAuthoritySetV1,
  feedingMutationCoordinatesForWriter,
} from '@aquaculture/feeding-contracts';

import { FeedingResolver } from '../feeding/resolvers/feeding.resolver';
import { CreateFeedingRecordHandler } from '../feeding/handlers/create-feeding-record.handler';
import { UpdateFeedingRecordHandler } from '../feeding/handlers/update-feeding-record.handler';
import { ForecastRefreshListener } from './listeners/forecast-refresh.listener';
import { FeedForecastResolver } from './resolvers/feed-forecast.resolver';
import { FeedingProtocolV2Resolver } from './resolvers/feeding-protocol-v2.resolver';
import { MealExecutionResolver } from './resolvers/meal-execution.resolver';
import { FeedingScheduleDispatchConsumerService } from './schedule-dispatch/feeding-schedule-dispatch-consumer.service';
import {
  ArchiveFeedingProtocolV2Handler,
  CreateFeedingProtocolV2Handler,
  UpdateFeedingProtocolV2Handler,
} from './handlers/protocol-crud.handlers';
import {
  AssignProtocolToBatchUnitsHandler,
  AssignProtocolToUnitHandler,
  UnassignProtocolHandler,
  UpdateProtocolAssignmentHandler,
} from './handlers/protocol-assignment.handlers';
import { FeedingAggregateMutationPort } from './feeding-aggregate-mutation.writer';
import { BatchAggregateMutationPort } from '../batch/batch-aggregate-mutation.port';
import { FeedingMutationTransactionAuthority } from './feeding-mutation-transaction.authority';

const FEEDING_MUTATION_RUNTIME_COMPONENTS: readonly Type<unknown>[] = Object.freeze([
  FeedingResolver,
  FeedForecastResolver,
  FeedingProtocolV2Resolver,
  MealExecutionResolver,
  ForecastRefreshListener,
  FeedingScheduleDispatchConsumerService,
]);

const FEEDING_MUTATION_COMMAND_HANDLERS: readonly Type<unknown>[] = Object.freeze([
  CreateFeedingRecordHandler,
  UpdateFeedingRecordHandler,
  CreateFeedingProtocolV2Handler,
  UpdateFeedingProtocolV2Handler,
  ArchiveFeedingProtocolV2Handler,
  AssignProtocolToUnitHandler,
  AssignProtocolToBatchUnitsHandler,
  UpdateProtocolAssignmentHandler,
  UnassignProtocolHandler,
]);

function isReflectable(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * Executable composition-root proof for the source mutation catalog.
 *
 * The TypeScript invariant proves decorator-symbol set equality. This runtime
 * authority independently proves that every catalogued provider is composed
 * exactly once and exposes the catalogued method, and that every CQRS writer
 * handler has exactly one live provider instance.
 */
@Injectable()
class FeedingMutationRuntimeAuthority implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly feedingMutations: FeedingAggregateMutationPort,
    private readonly batchMutations: BatchAggregateMutationPort,
  ) {}

  onApplicationBootstrap(): void {
    const runtimeCatalog = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
      (mutation) => mutation.runtimeServiceId === 'farm-service',
    );
    const runtimeProviderAuthorities = FEEDING_MUTATION_RUNTIME_PROVIDER_AUTHORITIES_V1.filter(
      (authority) => authority.runtimeServiceId === 'farm-service',
    );
    const catalogProviderNames = runtimeProviderAuthorities.map((authority) => authority.provider);
    const catalogHandlerNames = runtimeCatalog.flatMap((mutation) =>
      mutation.commandHandler === null ? [] : [mutation.commandHandler],
    );

    assertExactAuthoritySetV1(
      FEEDING_MUTATION_RUNTIME_COMPONENTS.map((component) => component.name),
      catalogProviderNames,
      'Feeding mutation component',
    );
    assertExactAuthoritySetV1(
      FEEDING_MUTATION_COMMAND_HANDLERS.map((handler) => handler.name),
      catalogHandlerNames,
      'Feeding mutation command-handler',
    );

    const wrappers = this.discovery.getProviders();
    const transactionAuthorityWrappers = wrappers.filter(
      (wrapper) => wrapper.token === FeedingMutationTransactionAuthority,
    );
    if (
      transactionAuthorityWrappers.length !== 1 ||
      !isReflectable(transactionAuthorityWrappers[0]?.instance)
    ) {
      throw new Error(
        `Feeding mutation transaction authority must be one initialized provider; found ${transactionAuthorityWrappers.length}`,
      );
    }
    const transactionIds = Reflect.get(transactionAuthorityWrappers[0].instance, 'mutationIds');
    if (!Array.isArray(transactionIds)) {
      throw new Error('Feeding mutation transaction authority has no closed mutation identity set');
    }
    assertExactAuthoritySetV1(
      transactionIds.filter((value): value is string => typeof value === 'string'),
      FEEDING_TENANT_TRANSACTION_MUTATION_IDS_V1,
      'Feeding tenant transaction mutation',
    );
    const aggregatePortWrappers = wrappers.filter(
      (wrapper) => wrapper.token === FeedingAggregateMutationPort,
    );
    if (
      aggregatePortWrappers.length !== 1 ||
      aggregatePortWrappers[0]?.instance !== this.feedingMutations
    ) {
      throw new Error(
        `Feeding aggregate mutation port must be the exact singleton provider; found ${aggregatePortWrappers.length}`,
      );
    }
    assertExactAuthoritySetV1(
      this.feedingMutations.coordinates,
      feedingMutationCoordinatesForWriter(FEEDING_AGGREGATE_MUTATION_WRITER_AUTHORITY_ID),
      'Feeding aggregate mutation coordinate',
    );
    const batchPortWrappers = wrappers.filter(
      (wrapper) => wrapper.token === BatchAggregateMutationPort,
    );
    if (batchPortWrappers.length !== 1 || batchPortWrappers[0]?.instance !== this.batchMutations) {
      throw new Error(
        `Batch aggregate mutation port must be the exact singleton provider; found ${batchPortWrappers.length}`,
      );
    }
    assertExactAuthoritySetV1(
      this.batchMutations.coordinates,
      feedingMutationCoordinatesForWriter(FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1.BATCH_AGGREGATE),
      'Batch aggregate mutation coordinate',
    );
    for (const component of FEEDING_MUTATION_RUNTIME_COMPONENTS) {
      const matches = wrappers.filter((wrapper) => wrapper.metatype === component);
      if (matches.length !== 1 || !isReflectable(matches[0]?.instance)) {
        throw new Error(
          `Feeding mutation component ${component.name} must have exactly one initialized provider; found ${matches.length}`,
        );
      }
    }
    for (const handler of FEEDING_MUTATION_COMMAND_HANDLERS) {
      const matches = wrappers.filter((wrapper) => wrapper.metatype === handler);
      if (matches.length !== 1 || !isReflectable(matches[0]?.instance)) {
        throw new Error(
          `Feeding mutation command-handler ${handler.name} must have exactly one initialized provider; found ${matches.length}`,
        );
      }
      if (typeof Reflect.get(matches[0].instance, 'execute') !== 'function') {
        throw new Error(`Feeding mutation command-handler ${handler.name} has no execute method`);
      }
    }

    const expectedIngressCoordinates = runtimeProviderAuthorities.flatMap((authority) =>
      authority.methods.map((method) => `${authority.provider}.${method}`),
    );
    const runtimeIngressCoordinates: string[] = [];
    for (const authority of runtimeProviderAuthorities) {
      const component = FEEDING_MUTATION_RUNTIME_COMPONENTS.find(
        (candidate) => candidate.name === authority.provider,
      );
      if (!component) {
        throw new Error(
          `Catalogued feeding mutation provider is not registered: ${authority.provider}`,
        );
      }
      const wrapper = wrappers.find((candidate) => candidate.metatype === component);
      if (!isReflectable(wrapper?.instance)) {
        throw new Error(
          `Catalogued feeding mutation provider is not initialized: ${authority.provider}`,
        );
      }
      for (const method of authority.methods) {
        if (typeof Reflect.get(wrapper.instance, method) === 'function') {
          runtimeIngressCoordinates.push(`${authority.provider}.${method}`);
        }
      }
    }
    assertExactAuthoritySetV1(
      runtimeIngressCoordinates,
      expectedIngressCoordinates,
      'Feeding mutation runtime method',
    );
  }
}

export const FEEDING_MUTATION_RUNTIME_AUTHORITY_PROVIDER: Provider =
  FeedingMutationRuntimeAuthority;
