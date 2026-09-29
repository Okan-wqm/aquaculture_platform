import { authorizeS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import { assertRepositoryTargetRequestAuthority } from '../src/runtime/verifier-invocation-authority';

import { authorizedExecutionAuthority } from './execution-receipt-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
  s01ProgressAuthorityBytes,
} from './operator-authority-fixture';

describe('signed reviewed-ref authority', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('rejects a malformed reviewed ref inside the signed authority', () => {
    const authorityBytes = s01ProgressAuthorityBytes({ reviewed_ref: 'refs/heads/main' });
    const trustRoot = operatorTrustRootBytes();

    expect(() =>
      authorizeS01ProgressAuthority({
        envelope_bytes: operatorEnvelopeBytes({ authorityBytes }),
        trust_root_bytes: trustRoot,
        expected_trust_root_sha256: digest(trustRoot),
      }),
    ).toThrow(/reviewed[_ ]ref/i);
  });

  it.each([
    'refs/remotes/origin/main/',
    'refs/remotes/origin/main//x',
    'refs/remotes/origin/main/.hidden',
    'refs/remotes/origin/main.lock',
    'refs/remotes/origin/main@{1}',
    'refs/remotes/origin/mäin',
  ])('rejects the Git-invalid signed reviewed ref %s', (reviewedRef) => {
    const authorityBytes = s01ProgressAuthorityBytes({ reviewed_ref: reviewedRef });
    const trustRoot = operatorTrustRootBytes();
    expect(() =>
      authorizeS01ProgressAuthority({
        envelope_bytes: operatorEnvelopeBytes({ authorityBytes }),
        trust_root_bytes: trustRoot,
        expected_trust_root_sha256: digest(trustRoot),
      }),
    ).toThrow(/reviewed[_ ]ref/i);
  });

  it.each([
    'refs/remotes/origin/release/v1.2.3',
    'refs/remotes/upstream/feature/topic-1',
    'refs/remotes/origin/a+b',
  ])('accepts the canonical Git reviewed ref %s', (reviewedRef) => {
    const authorityBytes = s01ProgressAuthorityBytes({ reviewed_ref: reviewedRef });
    const trustRoot = operatorTrustRootBytes();
    expect(() =>
      authorizeS01ProgressAuthority({
        envelope_bytes: operatorEnvelopeBytes({ authorityBytes }),
        trust_root_bytes: trustRoot,
        expected_trust_root_sha256: digest(trustRoot),
      }),
    ).not.toThrow();
  });

  it('rejects a valid frozen alias even when it resolves to the signed head', () => {
    const authority = authorizedExecutionAuthority({
      git_tool_id: 'git',
      reviewed_ref: 'refs/remotes/origin/main',
    });
    const document = authority.authority.document;

    expect(() =>
      assertRepositoryTargetRequestAuthority(
        authority,
        {
          repository_id: document.repository_id,
          workspace_id: document.workspace_id,
          repository_root: '/private/repository',
          reviewed_ref: 'refs/remotes/attacker/frozen',
          base_sha: document.base_sha,
          head_sha: document.head_sha,
        },
        document.git_tool_sha256,
      ),
    ).toThrow(/does not match signed progress authority/i);
  });
});
