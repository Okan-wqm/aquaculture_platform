import {
  isValidUUID,
  runInTenantRead,
  SENSOR_SOURCE_SCHEMA,
} from '@aquaculture/backend-common/database';
import { parseQuantityId } from '@aquaculture/shared-contracts';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  MAX_DESCRIBED_CHANNELS,
  type SensorChannelDescription,
  type SensorChannelKey,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { channelQuantity } from '../../registration/services/channel-quantity';
import { validateTenantId } from '../validation/input-sanitizer';

import { AS_OF_LOOKBACK, toNumberOrUndefined } from './metric-source';

interface DescriptionRow {
  ord: string;
  sensor_found: boolean;
  is_active: boolean | null;
  site_id: string | null;
  system_id: string | null;
  tank_id: string | null;
  channel_id: string | null;
  is_enabled: boolean | null;
  declared_quantity: string | null;
  unit: string | null;
  next_calibration_due: Date | null;
  value: string | number | null;
  time: Date | null;
  quality_code: number | null;
}

/**
 * What each sensor channel is, now, by its stable natural key
 * (sensorId, channelKey) — the one answer behind farm's channel bindings
 * (NATS `request.sensor.describeChannels`) and the `channelsByKey` query.
 *
 * Disabled channels and inactive sensors are described, not dropped: a
 * binding to a switched-off probe must say so, not vanish. The latest value
 * is the last sample inside the freshness window the readings page uses
 * (AS_OF_LOOKBACK); how fresh is fresh enough for a calculation is the
 * caller's decision.
 */
@Injectable()
export class ChannelDescriptionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async describe(
    tenantId: string,
    keys: readonly SensorChannelKey[],
  ): Promise<SensorChannelDescription[]> {
    if (keys.length > MAX_DESCRIBED_CHANNELS) {
      throw new BadRequestException(
        `At most ${MAX_DESCRIBED_CHANNELS} channels can be described at once`,
      );
    }
    if (keys.length === 0) {
      return [];
    }
    const validTenantId = validateTenantId(tenantId);
    // A sensor id that is not a uuid names no sensor; it is answered without a read.
    const asked = keys.filter((key) => isValidUUID(key.sensorId));
    const rows =
      asked.length === 0
        ? []
        : await runInTenantRead(
            this.dataSource,
            SENSOR_SOURCE_SCHEMA,
            validTenantId,
            (qr) =>
              qr.query(
                `SELECT k.ord, s.id IS NOT NULL AS sensor_found, s.is_active,
                        s.site_id, s.system_id, s.tank_id,
                        c.id AS channel_id, c.is_enabled, c.declared_quantity, c.unit,
                        c.next_calibration_due, lv.value, lv.time, lv.quality_code
                   FROM unnest($1::uuid[], $2::text[]) WITH ORDINALITY AS k(sensor_id, channel_key, ord)
                   LEFT JOIN sensors s
                     ON s.id = k.sensor_id AND s.tenant_id = $3
                   LEFT JOIN sensor_data_channels c
                     ON c.sensor_id = s.id AND c.tenant_id = $3 AND c.channel_key = k.channel_key
                   LEFT JOIN LATERAL (
                     SELECT m.value, m.time, m.quality_code
                       FROM sensor_metrics m
                      WHERE m.sensor_id = c.sensor_id AND m.channel_id = c.id AND m.tenant_id = $3
                        AND m.time >= NOW() - $4::interval
                      ORDER BY m.time DESC
                      LIMIT 1
                   ) lv ON true`,
                [
                  asked.map((key) => key.sensorId),
                  asked.map((key) => key.channelKey),
                  validTenantId,
                  AS_OF_LOOKBACK,
                ],
              ) as Promise<DescriptionRow[]>,
          );
    const rowByAsked = new Map(rows.map((row) => [Number(row.ord) - 1, row]));
    let askedIndex = 0;
    return keys.map((key) => {
      if (!isValidUUID(key.sensorId)) {
        return describeRow(key, undefined);
      }
      const row = rowByAsked.get(askedIndex);
      askedIndex += 1;
      return describeRow(key, row);
    });
  }
}

/** The description of a key: no sensor, a sensor without that channel, or the channel. */
function describeRow(
  key: SensorChannelKey,
  row: DescriptionRow | undefined,
): SensorChannelDescription {
  const absent: SensorChannelDescription = {
    sensorId: key.sensorId,
    channelKey: key.channelKey,
    presence: 'NO_SENSOR',
    sensorActive: null,
    siteId: null,
    systemId: null,
    tankId: null,
    channelId: null,
    enabled: null,
    quantity: null,
    quantityFamily: null,
    unit: null,
    calibrationDueAt: null,
    latestValue: null,
    latestAt: null,
    latestQualityCode: null,
  };
  if (row === undefined || !row.sensor_found) {
    return absent;
  }
  const sensor = {
    sensorActive: row.is_active,
    siteId: row.site_id,
    systemId: row.system_id,
    tankId: row.tank_id,
  };
  if (row.channel_id === null) {
    return { ...absent, ...sensor, presence: 'NO_CHANNEL' };
  }
  const view = channelQuantity(key.channelKey, parseQuantityId(row.declared_quantity));
  const value = toNumberOrUndefined(row.value);
  return {
    ...absent,
    ...sensor,
    presence: 'FOUND',
    channelId: row.channel_id,
    enabled: row.is_enabled,
    quantity: view.quantity,
    quantityFamily: view.family,
    unit: row.unit,
    calibrationDueAt:
      row.next_calibration_due === null ? null : row.next_calibration_due.toISOString(),
    latestValue: value ?? null,
    latestAt: value === undefined || row.time === null ? null : row.time.toISOString(),
    latestQualityCode: value === undefined ? null : row.quality_code,
  };
}
