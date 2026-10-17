import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { SensorChannelDescription, SensorChannelKey } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { bindingProblems } from './channel-binding-rules';
import { type FarmPlacement, loadFarmPlacement } from './channel-placement';
import type { SourceLocation } from './parameter-sources';
import {
  type ChannelSourceRow,
  gatherReadingFacts,
  type GatheredLevel,
  type ParameterReadAsk,
  type ReadingRequest,
} from './reading-facts';
import { type ReadingLevel, resolveReading, type ResolvedReading } from './reading-resolution';
import { SensorChannelDirectory } from './sensor-channel-directory.service';

/**
 * Gathers the facts `resolveReading` decides on (reading-resolution.ts) and
 * asks it — the one reader of "the value of a parameter at a point, now".
 *
 * 1. In a tenant read: the chain of places the value may come from (the
 *    location, then — for a loop-homogeneous quantity — the system and the
 *    site it belongs to, by farm's topology now), the live channel sources of
 *    each asked parameter there, and the latest manual sample — for every
 *    asked location at once, in a fixed number of statements
 *    (gatherReadingFacts, FARM-MEDIUM-447).
 * 2. Outside any connection: every bound channel described by the sensor
 *    service (SensorChannelDirectory: fail-closed, a 503 rather than a guess).
 * 3. In a tenant read: farm's placement of the described sensors, so each
 *    channel is judged by the bind's own rule at read time (D12,
 *    FARM-MEDIUM-378) — a sensor moved away, a channel disabled or
 *    re-declared since it was bound is skipped with its problem codes.
 *
 * Every read goes through one body (resolveMany): a single point is a batch
 * of one, so one point and a site's units are answered by the same code.
 * Callers authorize the points first (assertPointReadable, assertUnitsReadable).
 */
@Injectable()
export class ParameterReadingResolver {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly directory: SensorChannelDirectory,
  ) {}

  /** One parameter's answer, as of `asOf`. */
  async resolveOne(
    tenantId: string,
    location: SourceLocation,
    ask: ParameterReadAsk,
    asOf: Date,
  ): Promise<ResolvedReading> {
    const [answer] = await this.resolveAt(tenantId, location, [ask], asOf);
    if (answer === undefined) {
      throw new Error('The reading resolver answered no ask');
    }
    return answer.reading;
  }

  /** Each ask with its answer, in the asks' order, all as of `asOf`. */
  async resolveAt<Ask extends ParameterReadAsk>(
    tenantId: string,
    location: SourceLocation,
    asks: readonly Ask[],
    asOf: Date,
  ): Promise<{ ask: Ask; reading: ResolvedReading }[]> {
    if (asks.length === 0) {
      return [];
    }
    const [answers] = await this.resolveMany(tenantId, [{ location, asks }], asOf);
    if (answers === undefined) {
      throw new Error('The reading resolver answered no location');
    }
    return answers;
  }

  /**
   * One parameter's answer at each of many locations, in their order, all as
   * of `asOf` — the many-unit read (a site's units on the dashboard) in one
   * tenant read of a fixed number of statements, one directory request and
   * one placement read, never one round of each per location.
   */
  async resolveAcross(
    tenantId: string,
    locations: readonly SourceLocation[],
    ask: ParameterReadAsk,
    asOf: Date,
  ): Promise<ResolvedReading[]> {
    const answers = await this.resolveMany(
      tenantId,
      locations.map((location) => ({ location, asks: [ask] })),
      asOf,
    );
    return answers.map(([answer]) => {
      if (answer === undefined) {
        throw new Error('The reading resolver answered no ask at a location');
      }
      return answer.reading;
    });
  }

  /** Per location (in order), each of its asks with its answer — the one body of every read. */
  private async resolveMany<Ask extends ParameterReadAsk>(
    tenantId: string,
    requests: readonly ReadingRequest<Ask>[],
    asOf: Date,
  ): Promise<{ ask: Ask; reading: ResolvedReading }[][]> {
    const gathered = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      gatherReadingFacts(queryRunner.manager, tenantId, requests, asOf),
    );
    const keys = uniqueKeys(
      gathered.flat().flatMap(({ levels }) => levels.flatMap((level) => level.sources)),
    );
    const described = keys.length === 0 ? [] : await this.directory.describe(tenantId, keys);
    const descriptions = new Map<string, SensorChannelDescription>(
      described.map((description) => [keyOf(description), description]),
    );
    const farm =
      described.length === 0
        ? null
        : await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
            loadFarmPlacement(queryRunner.manager, tenantId, described),
          );
    return gathered.map((perLocation) =>
      perLocation.map(({ ask, levels }) => ({
        ask,
        reading: resolveReading(
          {
            parameter: { quantity: ask.parameter.effectiveQuantity, unit: ask.parameter.unit },
            unit: ask.unit,
            asOf,
            maxAgeMs: ask.maxAgeMs,
          },
          levels.map((level) => readingLevel(ask, level, descriptions, farm)),
        ),
      })),
    );
  }
}

function readingLevel(
  ask: ParameterReadAsk,
  level: GatheredLevel,
  descriptions: ReadonlyMap<string, SensorChannelDescription>,
  farm: FarmPlacement | null,
): ReadingLevel {
  return {
    point: level.location.point,
    inherited: level.inherited,
    manual: level.manual,
    channels: level.sources.map((source) => {
      const description = descriptions.get(keyOf(source));
      if (description === undefined || farm === null) {
        // The directory answered one description per asked key (describesRequest).
        throw new Error(`Channel ${keyOf(source)} was asked of the directory but not described`);
      }
      return {
        sourceId: source.id,
        priority: source.priority,
        description,
        bindingProblems: bindingProblems(ask.parameter, level.location.point, description, farm),
      };
    }),
  };
}

function keyOf(key: SensorChannelKey): string {
  return `${key.sensorId}|${key.channelKey}`;
}

function uniqueKeys(sources: readonly ChannelSourceRow[]): SensorChannelKey[] {
  const keys = new Map<string, SensorChannelKey>();
  for (const { sensorId, channelKey } of sources) {
    keys.set(keyOf({ sensorId, channelKey }), { sensorId, channelKey });
  }
  return [...keys.values()];
}
