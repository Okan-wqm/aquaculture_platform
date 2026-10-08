import { BadRequestException } from '@nestjs/common';

import {
  ChannelSourcePriority,
  MeasurementPosition,
} from '../../entities/water-quality-param-equipment.entity';
import { channelSourceTargetOf, measurementPointOf } from '../parameter-channel-binding.input';

describe('parameter channel-binding inputs', () => {
  it('names exactly one measurement point', () => {
    expect(measurementPointOf({ systemId: 'loop-a' })).toEqual({ kind: 'system', id: 'loop-a' });
    expect(measurementPointOf({ tankId: 'tank-1', siteId: null })).toEqual({
      kind: 'tank',
      id: 'tank-1',
    });
    expect(() => measurementPointOf({})).toThrow(BadRequestException);
    expect(() => measurementPointOf({ tankId: 'tank-1', equipmentId: 'filter-1' })).toThrow(
      BadRequestException,
    );
  });

  it('defaults to the representative position at no particular depth', () => {
    expect(
      channelSourceTargetOf({
        parameterConfigId: 'p-1',
        point: { equipmentId: 'filter-1' },
        sensorId: 's-1',
        channelKey: 'ph',
        priority: ChannelSourcePriority.BACKUP,
      }),
    ).toEqual({
      parameterConfigId: 'p-1',
      location: {
        point: { kind: 'equipment', id: 'filter-1' },
        position: MeasurementPosition.REPRESENTATIVE,
        depthM: null,
      },
      channel: { sensorId: 's-1', channelKey: 'ph' },
    });
  });
});
