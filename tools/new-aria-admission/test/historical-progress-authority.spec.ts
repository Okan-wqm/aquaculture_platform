import {
  authorizeS01ProgressAuthority,
  verifyHistoricalS01ProgressAuthority,
} from '../src/kernel/operator-progress-authority';

import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
} from './operator-authority-fixture';

describe('historical progress authority verification', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('verifies expired signed integrity without issuing current authority', () => {
    const trustRoot = operatorTrustRootBytes();
    const envelope = operatorEnvelopeBytes({
      observedAt: '2026-09-02T12:00:00.000Z',
      validUntil: '2026-09-02T14:00:00.000Z',
    });
    const input = {
      envelope_bytes: envelope,
      trust_root_bytes: trustRoot,
      expected_trust_root_sha256: digest(trustRoot),
    };

    expect(() => authorizeS01ProgressAuthority(input)).toThrow(/stale/i);
    expect(verifyHistoricalS01ProgressAuthority(input)).toMatchObject({
      authorization_kind: 'HISTORICAL',
      observed_at: '2026-09-02T12:00:00.000Z',
      valid_until: '2026-09-02T14:00:00.000Z',
    });
  });

  it('does not accept a tampered envelope as historical authority', () => {
    const trustRoot = operatorTrustRootBytes();
    const envelope = operatorEnvelopeBytes();
    const tampered = Buffer.from(envelope);
    const index = tampered.length - 2;
    const byte = tampered[index];
    if (byte === undefined) throw new TypeError('operator envelope fixture is truncated');
    tampered[index] = byte ^ 1;

    expect(() =>
      verifyHistoricalS01ProgressAuthority({
        envelope_bytes: tampered,
        trust_root_bytes: trustRoot,
        expected_trust_root_sha256: digest(trustRoot),
      }),
    ).toThrow();
  });
});
