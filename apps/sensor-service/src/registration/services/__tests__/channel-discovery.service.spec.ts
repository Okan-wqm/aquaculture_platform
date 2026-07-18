/**
 * ChannelDiscoveryService — locks the discovery behavior after it was refactored
 * onto the shared sensor-payload engine (SENSOR-HIGH-082), so discovery and
 * runtime reads traverse payloads identically.
 */
import { ChannelDiscoveryService } from '../channel-discovery.service';

describe('ChannelDiscoveryService', () => {
  const svc = new ChannelDiscoveryService();

  it('discovers dot-path channels from nested JSON and skips metadata', () => {
    const channels = svc.discoverFromJson({
      timestamp: 't',
      temperature: 25.5,
      nested: { humidity: 60 },
      series: [1, 2, 3],
    });
    const byKey = Object.fromEntries(
      channels.map((c) => [c.channelKey, { value: c.sampleValue, path: c.dataPath }]),
    );

    expect(byKey['temperature']).toEqual({ value: 25.5, path: 'temperature' });
    expect(byKey['humidity']).toEqual({ value: 60, path: 'nested.humidity' });
    expect(byKey['series']).toEqual({ value: 1, path: 'series' });
    expect(byKey['timestamp']).toBeUndefined();
  });

  it('discovers CSV channels with numeric coercion', () => {
    const channels = svc.discoverFromCsv('temp,ph\n25.5,7.2');
    expect(channels.map((c) => c.channelKey)).toEqual(['temp', 'ph']);
    expect(channels.map((c) => c.sampleValue)).toEqual([25.5, 7.2]);
  });

  it('discovers text key=value channels with numeric coercion', () => {
    const channels = svc.discoverFromText('do=8.1;temp=24');
    expect(channels.map((c) => [c.channelKey, c.sampleValue])).toEqual([
      ['do', 8.1],
      ['temp', 24],
    ]);
  });

  it('normalizes channel keys consistently', () => {
    const channels = svc.discoverFromJson({ 'Output Frequency': 50 });
    expect(channels[0]?.channelKey).toBe('output_frequency');
  });
});
