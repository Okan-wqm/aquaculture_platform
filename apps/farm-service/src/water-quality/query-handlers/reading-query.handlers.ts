/**
 * Reading side of the water-chemistry channel binding (plan rev2 PR-4).
 *
 * Both reads authorize the point first (live, and a MODULE_USER only at an
 * assigned site — assertPointReadable, as parameterSourcesAtPoint does), then
 * ask the one reading resolver. The sensor service is asked outside any
 * database connection; when it cannot answer the read is a 503, never a
 * guess.
 *
 * @module WaterQuality/QueryHandlers
 */
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { DataSource, type EntityManager, In } from 'typeorm';

import { System } from '../../system/entities/system.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { engineUnit, WATER_CHEMISTRY_INPUT_SETS } from '../data/water-chemistry-input-sets';
import {
  type ParameterReading,
  parameterReadingOf,
  type WaterChemistryInputsResult,
  waterChemistryInputsOf,
} from '../dto/water-chemistry-reading.response';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import {
  ResolveParameterValueQuery,
  ResolveWaterChemistryInputsQuery,
} from '../queries/reading-queries';
import { assertPointReadable } from '../services/measurement-point-lookup';
import { ParameterReadingResolver } from '../services/parameter-reading-resolver.service';
import { representativeLocation } from '../services/parameter-sources';
import {
  evaluateInputSet,
  type InputFacts,
  inputWindowMs,
  type LoopFacts,
} from '../services/water-chemistry-input-set';

@Injectable()
@QueryHandler(ResolveParameterValueQuery)
export class ResolveParameterValueHandler
  implements IQueryHandler<ResolveParameterValueQuery, ParameterReading>
{
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly siteAuth: SiteAuthorizationService,
    private readonly resolver: ParameterReadingResolver,
  ) {}

  async execute(query: ResolveParameterValueQuery): Promise<ParameterReading> {
    const { tenantId, parameterConfigId, location, maxAgeMs, caller } = query;
    const asOf = new Date();
    const parameter = await runInTenantRead(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        const { manager } = queryRunner;
        await assertPointReadable(manager, this.siteAuth, tenantId, location.point, caller);
        const found = await tenantManagerRepo(
          manager,
          WaterQualityParameterConfig,
          tenantId,
        ).findOne({ where: { id: parameterConfigId, isActive: true } });
        if (found === null) {
          throw new NotFoundException(`No active parameter '${parameterConfigId}' in this tenant`);
        }
        return found;
      },
    );
    const reading = await this.resolver.resolveOne(
      tenantId,
      location,
      { parameter, unit: parameter.unit, maxAgeMs },
      asOf,
    );
    return parameterReadingOf(parameter, location, reading);
  }
}

@Injectable()
@QueryHandler(ResolveWaterChemistryInputsQuery)
export class ResolveWaterChemistryInputsHandler
  implements IQueryHandler<ResolveWaterChemistryInputsQuery, WaterChemistryInputsResult>
{
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly siteAuth: SiteAuthorizationService,
    private readonly resolver: ParameterReadingResolver,
  ) {}

  async execute(query: ResolveWaterChemistryInputsQuery): Promise<WaterChemistryInputsResult> {
    const { tenantId, point, set, caller } = query;
    const spec = WATER_CHEMISTRY_INPUT_SETS[set];
    if (point.kind !== spec.point) {
      throw new BadRequestException(`The ${set} inputs are read at a ${spec.point} point`);
    }
    const asOf = new Date();
    const { parameters, loop } = await runInTenantRead(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        const { manager } = queryRunner;
        await assertPointReadable(manager, this.siteAuth, tenantId, point, caller);
        // One active parameter per quantity (UQ on effectiveQuantity over active configs).
        const configs = await tenantManagerRepo(
          manager,
          WaterQualityParameterConfig,
          tenantId,
        ).find({
          where: {
            isActive: true,
            effectiveQuantity: In(spec.inputs.map((input) => input.quantity)),
          },
        });
        return {
          parameters: new Map(configs.map((config) => [config.effectiveQuantity, config])),
          loop: spec.needsLoopVolume ? await loopFacts(manager, tenantId, point.id) : null,
        };
      },
    );
    const asks = spec.inputs.flatMap((input) => {
      const parameter = parameters.get(input.quantity);
      return parameter === undefined
        ? []
        : [{ input, parameter, unit: engineUnit(input), maxAgeMs: inputWindowMs(input) }];
    });
    const answers = await this.resolver.resolveAt(
      tenantId,
      representativeLocation(point),
      asks,
      asOf,
    );
    const readingOf = new Map(answers.map(({ ask, reading }) => [ask.input, reading]));
    const inputs: InputFacts[] = spec.inputs.map((input) => {
      const parameter = parameters.get(input.quantity);
      const reading = readingOf.get(input);
      return {
        spec: input,
        parameter: parameter === undefined ? null : parameter,
        reading: reading === undefined ? null : reading,
      };
    });
    return waterChemistryInputsOf(point, asOf, evaluateInputSet(set, loop, inputs));
  }
}

/**
 * The loop a dosing recipe is scaled by: its type, its total volume and the
 * water its active tanks hold (each tank's water volume, else its volume).
 */
async function loopFacts(
  manager: EntityManager,
  tenantId: string,
  systemId: string,
): Promise<LoopFacts> {
  const system = await tenantManagerRepo(manager, System, tenantId).findOne({
    where: { id: systemId, isDeleted: false },
    select: { id: true, type: true, totalVolumeM3: true },
  });
  if (system === null) {
    // assertPointReadable proved it live in this read.
    throw new NotFoundException(`No active system '${systemId}' in this tenant`);
  }
  const tanks = await tenantManagerRepo(manager, Tank, tenantId).find({
    where: { systemId, isActive: true },
    select: { id: true, volume: true, waterVolume: true },
  });
  return {
    type: system.type,
    volumeM3: system.totalVolumeM3 ?? null,
    tankWaterM3: tanks.reduce((sum, tank) => sum + tankWaterM3(tank), 0),
  };
}

/** The water a tank holds: its water volume (by its water depth) when known, else its volume. */
function tankWaterM3(tank: Pick<Tank, 'volume' | 'waterVolume'>): number {
  return tank.waterVolume !== undefined && tank.waterVolume !== null && tank.waterVolume > 0
    ? tank.waterVolume
    : tank.volume;
}
