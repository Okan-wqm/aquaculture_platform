import { stub } from '@aquaculture/testing';
import type { SensorChannelDescription } from '@platform/event-contracts';

import {
  ChannelSourcePriority,
  type WaterQualityParamEquipment,
} from '../../entities/water-quality-param-equipment.entity';
import type { WaterQualityParameterConfig } from '../../entities/water-quality-parameter-config.entity';
import {
  assertParameterUnchanged,
  bindingProblems,
  priorityConflict,
  quantitySnapshot,
} from '../channel-binding-rules';
import type { FarmPlacement } from '../channel-placement';

describe('channel binding rules (farm side)', () => {
  const nowhere: FarmPlacement = {
    systemsOfUnit: new Map(),
    siteOfUnit: new Map(),
    siteOfSystem: new Map(),
  };
  const config = (facts: Partial<WaterQualityParameterConfig>): WaterQualityParameterConfig =>
    stub<WaterQualityParameterConfig>({
      code: 'ph',
      unit: 'pH',
      isActive: true,
      declaredQuantity: null,
      effectiveQuantity: 'ph',
      ...facts,
    });
  const ph = config({});
  const channel = (facts: Partial<SensorChannelDescription>): SensorChannelDescription => ({
    sensorId: 's-1',
    channelKey: 'ph',
    presence: 'FOUND',
    sensorActive: true,
    siteId: null,
    systemId: null,
    tankId: 'tank-1',
    equipmentId: null,
    channelId: 'c-1',
    enabled: true,
    quantity: 'ph',
    quantityFamily: null,
    unit: 'pH',
    calibrationDueAt: null,
    configuredAt: null,
    latestValue: null,
    latestAt: null,
    latestQuality: null,
    ...facts,
  });

  describe('bindingProblems', () => {
    it('adds NOT_AT_POINT to the shared rule when the sensor stands elsewhere', () => {
      expect(bindingProblems(ph, { kind: 'tank', id: 'tank-1' }, channel({}), nowhere)).toEqual([]);
      expect(
        bindingProblems(ph, { kind: 'tank', id: 'tank-2' }, channel({ unit: null }), nowhere),
      ).toEqual(['CHANNEL_HAS_NO_UNIT', 'NOT_AT_POINT']);
    });

    it('does not call a missing sensor misplaced: its place is unknown', () => {
      expect(
        bindingProblems(
          ph,
          { kind: 'tank', id: 'tank-2' },
          channel({ presence: 'NO_SENSOR', tankId: null }),
          nowhere,
        ),
      ).toEqual(['NO_SENSOR']);
    });
  });

  describe('priorityConflict', () => {
    const live = (
      priority: ChannelSourcePriority,
      channelKey: string,
    ): WaterQualityParamEquipment =>
      stub<WaterQualityParamEquipment>({ sensorId: 's-1', channelKey, priority });
    const key = { sensorId: 's-1', channelKey: 'ph_new' };

    it('takes a primary where there is none, and a backup behind a primary', () => {
      expect(priorityConflict([], key, ChannelSourcePriority.PRIMARY)).toBeNull();
      expect(
        priorityConflict(
          [live(ChannelSourcePriority.PRIMARY, 'ph')],
          key,
          ChannelSourcePriority.BACKUP,
        ),
      ).toBeNull();
    });

    it('refuses a second primary or backup, a backup alone, and a channel twice', () => {
      expect(
        priorityConflict(
          [live(ChannelSourcePriority.PRIMARY, 'ph')],
          key,
          ChannelSourcePriority.PRIMARY,
        ),
      ).toMatchObject({ code: 'SOURCE_CONFLICT' });
      expect(priorityConflict([], key, ChannelSourcePriority.BACKUP)).toMatchObject({
        code: 'BACKUP_NEEDS_PRIMARY',
      });
      expect(
        priorityConflict(
          [live(ChannelSourcePriority.PRIMARY, 'ph'), live(ChannelSourcePriority.BACKUP, 'ph_2')],
          key,
          ChannelSourcePriority.BACKUP,
        ),
      ).toMatchObject({ code: 'SOURCE_CONFLICT' });
      expect(
        priorityConflict(
          [live(ChannelSourcePriority.PRIMARY, 'ph_new')],
          key,
          ChannelSourcePriority.BACKUP,
        ),
      ).toMatchObject({ code: 'SOURCE_CONFLICT' });
    });
  });

  describe('assertParameterUnchanged', () => {
    it('passes an unchanged active parameter and refuses one that changed meaning or was deactivated', () => {
      const snapshot = quantitySnapshot(ph);
      const refusal = (changed: WaterQualityParameterConfig): unknown => {
        try {
          assertParameterUnchanged(changed, snapshot);
        } catch (error) {
          return error;
        }
        return null;
      };
      expect(refusal(ph)).toBeNull();
      for (const changed of [
        config({ unit: 'mV' }),
        config({ declaredQuantity: 'ph' }),
        config({ isActive: false }),
      ]) {
        expect(refusal(changed)).toMatchObject({ code: 'PARAMETER_CHANGED' });
      }
    });
  });
});
