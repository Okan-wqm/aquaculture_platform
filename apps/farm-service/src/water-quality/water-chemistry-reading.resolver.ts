/**
 * Water-chemistry reading — GraphQL adapter (plan rev2 PR-4, D2, D3, D12).
 *
 * What a parameter reads at a measurement point now — from its primary or
 * backup channel, a manual sample, or (loop-homogeneous quantities only) the
 * system or site it belongs to — and whether a dosing or toxicity calculation
 * can run at a point, with each input resolved. Reads for MODULE_USER at an
 * assigned site and above; every operation goes through the query bus.
 *
 * @module WaterQuality
 */
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { QueryBus } from '@platform/cqrs';

import {
  WATER_CHEMISTRY_INPUT_SET,
  type WaterChemistryInputSet,
} from './data/water-chemistry-input-sets';
import {
  MeasurementPointInput,
  measurementPointOf,
  sourceLocationOf,
} from './dto/parameter-channel-binding.input';
import { ResolvedParameterValueInput } from './dto/water-chemistry-reading.input';
import {
  ParameterReading,
  WaterChemistryInputsResult,
} from './dto/water-chemistry-reading.response';
import type { SourceReader } from './queries/parameter-source-queries';
import {
  ResolveParameterValueQuery,
  ResolveWaterChemistryInputsQuery,
} from './queries/reading-queries';

@Resolver()
@UseGuards(TenantGuard)
export class WaterChemistryReadingResolver {
  constructor(private readonly queryBus: QueryBus) {}

  /** The value of a parameter at a point now, where it came from, and every source passed over. */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => ParameterReading, { name: 'resolvedParameterValue' })
  async resolvedParameterValue(
    @Args('input') input: ResolvedParameterValueInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: SourceReader,
  ): Promise<ParameterReading> {
    return this.queryBus.execute(
      new ResolveParameterValueQuery(
        tenantId,
        input.parameterConfigId,
        sourceLocationOf(input),
        input.maxAgeSeconds === undefined || input.maxAgeSeconds === null
          ? null
          : input.maxAgeSeconds * 1000,
        user,
      ),
    );
  }

  /**
   * The inputs of a water-chemistry calculation at a point — DOSING at a
   * system, TOXICITY at a tank — each resolved within its coherence window,
   * and whether the calculation is READY, INCOMPLETE or REFUSED there.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WaterChemistryInputsResult, { name: 'waterChemistryInputs' })
  async waterChemistryInputs(
    @Args('point') point: MeasurementPointInput,
    @Args('set', { type: () => WATER_CHEMISTRY_INPUT_SET }) set: WaterChemistryInputSet,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: SourceReader,
  ): Promise<WaterChemistryInputsResult> {
    return this.queryBus.execute(
      new ResolveWaterChemistryInputsQuery(tenantId, measurementPointOf(point), set, user),
    );
  }
}
