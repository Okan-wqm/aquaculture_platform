import {
  CHANNEL_BINDING_PROBLEMS,
  PARAMETER_SOURCE_ERROR,
  channelProblems,
  parameterProblems,
  type DescribedChannel,
} from '../measurement/channel-binding';

/**
 * A channel feeds a parameter only when both name exactly the same measured
 * quantity, both units convert to it, and the channel is live. Each case
 * below would bind a wrong or dead source if the rule loosened.
 */
describe('channel binding rule', () => {
  const tan = { quantity: 'tan', unit: 'mg/L' } as const;
  const found: DescribedChannel = {
    presence: 'FOUND',
    sensorActive: true,
    enabled: true,
    quantity: 'tan',
    unit: 'mg/L',
  };

  it('accepts a live channel of the same quantity in a convertible unit', () => {
    expect(channelProblems(tan, found)).toEqual([]);
    expect(
      channelProblems(
        { quantity: 'temperature', unit: '°C' },
        { ...found, quantity: 'temperature', unit: '°F' },
      ),
    ).toEqual([]);
  });

  it('refuses a neighbouring quantity: NH3-N is not TAN, and nothing is derived at bind time', () => {
    expect(channelProblems(tan, { ...found, quantity: 'nh3' })).toEqual(['QUANTITY_MISMATCH']);
  });

  it('refuses a channel whose key names a family nobody declared, or an id it does not know', () => {
    expect(channelProblems(tan, { ...found, quantity: null })).toEqual(['CHANNEL_HAS_NO_QUANTITY']);
    expect(channelProblems(tan, { ...found, quantity: 'ammoniaish' })).toEqual([
      'CHANNEL_HAS_NO_QUANTITY',
    ]);
  });

  it('refuses a channel without a unit or in a unit its quantity cannot be reported in', () => {
    expect(channelProblems(tan, { ...found, unit: null })).toEqual(['CHANNEL_HAS_NO_UNIT']);
    expect(channelProblems(tan, { ...found, unit: 'NTU' })).toEqual([
      'CHANNEL_UNIT_NOT_CONVERTIBLE',
    ]);
  });

  it('refuses a dead source and stops at what is not there', () => {
    expect(channelProblems(tan, { ...found, sensorActive: false, enabled: false })).toEqual([
      'SENSOR_INACTIVE',
      'CHANNEL_DISABLED',
    ]);
    expect(
      channelProblems(tan, {
        presence: 'NO_CHANNEL',
        sensorActive: true,
        enabled: null,
        quantity: null,
        unit: null,
      }),
    ).toEqual(['NO_CHANNEL']);
    expect(
      channelProblems(tan, {
        presence: 'NO_SENSOR',
        sensorActive: null,
        enabled: null,
        quantity: null,
        unit: null,
      }),
    ).toEqual(['NO_SENSOR']);
  });

  it('reports the parameter first: no quantity, or a unit that is not one of its quantity', () => {
    expect(parameterProblems({ quantity: null, unit: 'mg/L' })).toEqual([
      'PARAMETER_HAS_NO_QUANTITY',
    ]);
    expect(parameterProblems({ quantity: 'tan', unit: '°C' })).toEqual([
      'PARAMETER_UNIT_NOT_CONVERTIBLE',
    ]);
    expect(channelProblems({ quantity: null, unit: 'mg/L' }, found)).toEqual([
      'PARAMETER_HAS_NO_QUANTITY',
    ]);
  });

  it('reports only codes of the published vocabulary, which the UI keys its messages on', () => {
    // Append-only: the UI keys its messages on these strings.
    expect(CHANNEL_BINDING_PROBLEMS).toEqual([
      'PARAMETER_HAS_NO_QUANTITY',
      'PARAMETER_UNIT_NOT_CONVERTIBLE',
      'NO_SENSOR',
      'NO_CHANNEL',
      'SENSOR_INACTIVE',
      'CHANNEL_DISABLED',
      'CHANNEL_HAS_NO_QUANTITY',
      'QUANTITY_MISMATCH',
      'CHANNEL_HAS_NO_UNIT',
      'CHANNEL_UNIT_NOT_CONVERTIBLE',
      'NOT_AT_POINT',
    ]);
  });

  it('publishes the API refusal codes the binding UI branches on', () => {
    // Append-only: GraphQL extensions.code of the parameter-source API.
    expect(Object.values(PARAMETER_SOURCE_ERROR)).toEqual([
      'CHANNEL_BINDING_REFUSED',
      'SOURCE_CONFLICT',
      'BACKUP_NEEDS_PRIMARY',
      'PARAMETER_CHANGED',
      'POINT_RETIRED',
      'SOURCE_UNBOUND',
      'PARAMETER_BOUND',
      'PARAMETER_HAS_MEASUREMENTS',
      'CONCURRENT_WRITE',
      'SENSOR_DIRECTORY_UNAVAILABLE',
    ]);
  });
});
