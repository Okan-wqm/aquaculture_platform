import policy from '../jetstream-storage-policy.json';
import {
  getJetStreamStorageBudget,
  JETSTREAM_REQUIRED_FILE_STORE_BYTES,
} from '../jetstream-storage-policy';

describe('JetStream declared storage policy', () => {
  it('reserves the unchanged declared allocations plus the shared 25 percent reserve', () => {
    expect(getJetStreamStorageBudget('events')).toBe(1610612736);
    expect(getJetStreamStorageBudget('telemetry')).toBe(6442450944);
    expect(getJetStreamStorageBudget('dlq')).toBe(268435456);
    expect(JETSTREAM_REQUIRED_FILE_STORE_BYTES).toBe(10401873920);
  });

  it.each(['telemetry', 'dlq'] as const)('allows only bounded positive %s overrides', (stream) => {
    const allocation = policy.streams[stream].max_bytes;
    expect(getJetStreamStorageBudget(stream, 1)).toBe(1);
    expect(getJetStreamStorageBudget(stream, '1024')).toBe(1024);
    expect(getJetStreamStorageBudget(stream, String(allocation))).toBe(allocation);
    expect(() => getJetStreamStorageBudget(stream, allocation + 1)).toThrow(
      `NATS_${stream.toUpperCase()}_MAX_BYTES`,
    );
  });

  it.each([
    0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1,
    null, true, {}, [], '', ' ', ' 1', '1 ', '1.5', '1e3', '0x10', 'NaN',
  ].map((value) => ({ value })))('refuses malformed configured allocations: %p', ({ value }) => {
    expect(() => getJetStreamStorageBudget('telemetry', value)).toThrow(
      'positive safe integer no greater than',
    );
  });
});
