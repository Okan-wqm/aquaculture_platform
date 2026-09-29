import { rmSync } from 'node:fs';

import { verifyHistoricalCurrentEpochSnapshot } from '../src/kernel/current-epoch-provider';
import {
  authorizeS01ProgressAuthority,
  verifyHistoricalS01ProgressAuthority,
} from '../src/kernel/operator-progress-authority';

import {
  currentEpochProviderId,
  currentEpochSnapshotBytes,
  currentEpochStoreFixture,
} from './current-epoch-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
  s01ProgressAuthorityBytes,
} from './operator-authority-fixture';

describe('historical current-epoch snapshot verification', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('validates the signed epoch fact at a receipt-bound historical read instant', () => {
    const operatorRoot = operatorTrustRootBytes();
    const store = currentEpochStoreFixture(operatorRoot);
    try {
      const authorityBytes = s01ProgressAuthorityBytes(store.authority);
      const envelopeBytes = operatorEnvelopeBytes({
        authorityBytes,
        observedAt: '2026-09-02T12:00:00.000Z',
        validUntil: '2026-09-02T14:00:00.000Z',
      });
      const authorityInput = {
        envelope_bytes: envelopeBytes,
        trust_root_bytes: operatorRoot,
        expected_trust_root_sha256: digest(operatorRoot),
      };
      const current = authorizeS01ProgressAuthority(authorityInput);
      const snapshotBytes = currentEpochSnapshotBytes(current);
      jest.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
      const historical = verifyHistoricalS01ProgressAuthority({
        ...authorityInput,
        envelope_bytes: Buffer.from(envelopeBytes),
      });
      const input = {
        snapshot_bytes: snapshotBytes,
        operator_trust_root_bytes: operatorRoot,
        expected_operator_trust_root_sha256: digest(operatorRoot),
        provider_id: currentEpochProviderId,
        provider_identity_sha256:
          current.authority.document.invalidation_epoch_provider_identity_sha256,
        authority: historical,
        receipt_epoch_read_at: '2026-09-02T12:30:00.000Z',
      };

      expect(verifyHistoricalCurrentEpochSnapshot(input).revision).toBe(1);
      expect(() =>
        verifyHistoricalCurrentEpochSnapshot({
          ...input,
          receipt_epoch_read_at: '2026-09-02T14:00:00.001Z',
        }),
      ).toThrow(/authority window/);
    } finally {
      rmSync(store.root, { recursive: true, force: true });
    }
  });
});
