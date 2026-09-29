import { createTrustedCompletionContext } from '../src/application/trusted-completion-context';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { authorizeS01ProgressAuthority } from '../src/kernel/operator-progress-authority';

import { admissionInput, cleanupAdmissionFixtures } from './admission-fixture';
import { trustedExecutionSigner } from './execution-key-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
} from './operator-authority-fixture';

describe('trusted completion identity separation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanupAdmissionFixtures();
  });

  it('rejects execution key reuse under an evidence identity alias', () => {
    const scenario = admissionInput();
    const document = JSON.parse(scenario.fixture.trustRoot.toString()) as {
      keys: { principal_id: string; public_key_spki_der_base64: string }[];
    };
    const producer = document.keys[0];
    if (producer === undefined) throw new Error('producer trust key fixture is missing');
    producer.public_key_spki_der_base64 = trustedExecutionSigner.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
    const evidenceTrustRoot = canonicalJsonBytes(document);
    const authorityBytes = canonicalJsonBytes({
      ...scenario.context_input.progress_authority.authority.document,
      evidence_trust_root_sha256: digest(evidenceTrustRoot),
    });
    const operatorRoot = operatorTrustRootBytes();
    const authority = authorizeS01ProgressAuthority({
      envelope_bytes: operatorEnvelopeBytes({
        authorityBytes,
        observedAt: '2026-09-02T11:30:00.000Z',
        validUntil: '2026-09-02T14:00:00.000Z',
      }),
      trust_root_bytes: operatorRoot,
      expected_trust_root_sha256: digest(operatorRoot),
    });

    expect(() =>
      createTrustedCompletionContext({
        ...scenario.context_input,
        progress_authority: authority,
        evidence_trust_root_bytes: evidenceTrustRoot,
      }),
    ).toThrow(/separation/);
  });
});
