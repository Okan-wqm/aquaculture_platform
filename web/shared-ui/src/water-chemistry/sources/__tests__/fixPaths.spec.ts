import { describe, expect, it } from 'vitest';

import { problemFixPath } from '../fixPaths';

const TANK = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const SENSOR = '6f9619ff-8b86-4011-b42d-00cf4fc964ff';
const CONTEXT = {
  point: { kind: 'tank' as const, id: TANK },
  sensorId: SENSOR,
  channelKey: 'nh3 total',
};

describe('problemFixPath', () => {
  it('opens the farm tabs for parameter and source fixes, at the point', () => {
    expect(problemFixPath('parameter', CONTEXT)).toBe('/sites/water-chemistry?tab=parameters');
    expect(problemFixPath('source', CONTEXT)).toBe(
      `/sites/water-chemistry?tab=sources&point=tank:${TANK}`,
    );
  });

  it("opens the sensor's channel manager on the channel, and the sensor page", () => {
    expect(problemFixPath('channel', CONTEXT)).toBe(
      `/sensor/devices/${SENSOR}?tab=channels&channel=nh3%20total`,
    );
    expect(problemFixPath('sensor', CONTEXT)).toBe(`/sensor/devices/${SENSOR}`);
  });

  it('has no path for a sensor fix when no sensor is named', () => {
    expect(problemFixPath('channel', { ...CONTEXT, sensorId: null })).toBeNull();
    expect(problemFixPath('system', CONTEXT)).toBe('/sites/setup');
  });
});
