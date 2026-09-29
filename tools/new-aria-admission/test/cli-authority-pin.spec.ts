import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { parseCliArguments } from '../src/runtime/cli-arguments';
import { parseCompletionAdmissionDescriptor } from '../src/runtime/completion-admission-request';
import { assertGitToolAuthority } from '../src/runtime/verifier-invocation-authority';
import { parseVerifierInvocationDescriptor } from '../src/runtime/verifier-invocation-request';

import { authorizedExecutionAuthority } from './execution-receipt-fixture';

const operatorRootSha256 = 'a'.repeat(64);

describe('CLI operator trust-root pin', () => {
  it.each([
    [
      'run-verifier',
      [
        'run-verifier',
        '--request',
        '/request.json',
        '--operator-trust-root-sha256',
        operatorRootSha256,
        '--current-epoch-root',
        '/epoch-root',
        '--bundle',
        '/bundle',
      ],
    ],
    [
      'admit-completion',
      [
        'admit-completion',
        '--request',
        '/request.json',
        '--operator-trust-root-sha256',
        operatorRootSha256,
        '--current-epoch-root',
        '/epoch-root',
        '--output',
        '/projection.json',
        '--bundle',
        '/completion-bundle',
      ],
    ],
    [
      'verify-bundle',
      [
        'verify-bundle',
        '--request',
        '/bundle-request.json',
        '--operator-trust-root-sha256',
        operatorRootSha256,
        '--current-epoch-root',
        '/epoch-root',
        '--bundle',
        '/bundle',
      ],
    ],
    [
      'verify-bundle-history',
      [
        'verify-bundle-history',
        '--request',
        '/bundle-request.json',
        '--operator-trust-root-sha256',
        operatorRootSha256,
        '--bundle',
        '/bundle',
      ],
    ],
    [
      'verify-completion-bundle',
      [
        'verify-completion-bundle',
        '--bundle',
        '/completion-bundle',
        '--operator-trust-root-sha256',
        operatorRootSha256,
        '--current-epoch-root',
        '/epoch-root',
        '--checkpoint-root',
        '/checkpoint-root',
        '--repository-root',
        '/repository',
        '--projection',
        '/projection.json',
        '--git',
        '/usr/bin/git',
      ],
    ],
    [
      'verify-completion-bundle-history',
      [
        'verify-completion-bundle-history',
        '--bundle',
        '/completion-bundle',
        '--operator-trust-root-sha256',
        operatorRootSha256,
        '--repository-root',
        '/repository',
        '--projection',
        '/projection.json',
        '--git',
        '/usr/bin/git',
      ],
    ],
  ] as const)('requires an external pin for %s', (kind, args) => {
    expect(parseCliArguments(args)).toMatchObject({
      kind,
      operator_trust_root_sha256: operatorRootSha256,
    });
  });

  it.each([
    ['run-verifier', '--bundle', '/bundle'],
    ['admit-completion', '--bundle', '/completion-bundle'],
    ['verify-bundle', '--bundle', '/bundle'],
    ['verify-bundle-history', '--bundle', '/bundle'],
    ['verify-completion-bundle', '--bundle', '/completion-bundle'],
    ['verify-completion-bundle-history', '--bundle', '/completion-bundle'],
  ])('rejects %s without an external pin', (kind, finalFlag, finalPath) => {
    expect(() =>
      parseCliArguments([kind, '--request', '/request.json', finalFlag, finalPath]),
    ).toThrow(/canonical|arguments/);
  });

  it('rejects a malformed external pin before command execution', () => {
    expect(() =>
      parseCliArguments([
        'run-verifier',
        '--request',
        '/request.json',
        '--operator-trust-root-sha256',
        'not-a-digest',
        '--current-epoch-root',
        '/epoch-root',
        '--bundle',
        '/bundle',
      ]),
    ).toThrow(/digest|arguments/);
  });

  it.each([2, 6, 8])('rejects a relative run-verifier path at argv index %i', (index) => {
    const args = [
      'run-verifier',
      '--request',
      '/request.json',
      '--operator-trust-root-sha256',
      operatorRootSha256,
      '--current-epoch-root',
      '/epoch-root',
      '--bundle',
      '/bundle',
    ];
    args[index] = 'relative-path';
    expect(() => parseCliArguments(args)).toThrow(/canonical|arguments|incomplete/);
  });

  it('rejects completion admission without a distinct absolute proof-bundle destination', () => {
    const prefix = [
      'admit-completion',
      '--request',
      '/request.json',
      '--operator-trust-root-sha256',
      operatorRootSha256,
      '--current-epoch-root',
      '/epoch-root',
      '--output',
      '/projection.json',
    ];
    expect(() => parseCliArguments(prefix)).toThrow(/canonical|arguments/);
    expect(() => parseCliArguments([...prefix, '--bundle', 'relative-bundle'])).toThrow(
      /canonical|arguments/,
    );
  });

  it('rejects a verifier request that attempts to self-pin its operator root', () => {
    const runs = Array.from({ length: 5 }, (_, index) => ({
      input_envelope_path: `/missing-${index.toString()}.json`,
      run_context_sha256: 'b'.repeat(64),
      run_id: index === 0 ? 'BASELINE' : `NC-${index.toString()}`,
    }));
    const bytes = canonicalJsonBytes({
      args: ['--mode', 'full'],
      contract_id: 'new-aria-verifier-invocation-v2',
      evidence_trust_root_path: '/missing-evidence-root.json',
      execution_private_key_path: '/missing-private.der',
      execution_trust_root_path: '/missing-execution-root.json',
      git_path: '/usr/bin/git',
      git_sha256: 'c'.repeat(64),
      operator_envelope_path: '/missing-envelope.json',
      operator_trust_root_path: '/missing-operator-root.json',
      operator_trust_root_sha256: operatorRootSha256,
      runs,
      runtime_sha256: 'd'.repeat(64),
      schema_version: '1.0.0',
      target_request_path: '/missing-target.json',
      tool_id: 'new-aria-admission-verifier',
      tool_path: '/missing-verifier.cjs',
      tool_sha256: 'e'.repeat(64),
    });

    expect(() => parseVerifierInvocationDescriptor(bytes)).toThrow(/schema|closed/);
  });

  it('rejects a completion request that attempts to self-pin its operator root', () => {
    const bytes = canonicalJsonBytes({
      contract_id: 'new-aria-completion-admission-request-v1',
      event_chain_path: '/missing-events.jsonl',
      event_policy_path: '/missing-event-policy.json',
      evidence_attestation_path: '/missing-attestation.json',
      evidence_trust_root_path: '/missing-evidence-root.json',
      execution_trust_root_path: '/missing-execution-root.json',
      freshness_policy_path: '/missing-freshness-policy.json',
      git_path: '/usr/bin/git',
      git_sha256: 'c'.repeat(64),
      manifest_paths: ['/missing-manifest.json'],
      objects: [{ path: '/missing-object.json', uri: `aria-evidence://sha256/${'f'.repeat(64)}` }],
      operator_envelope_path: '/missing-envelope.json',
      operator_trust_root_path: '/missing-operator-root.json',
      operator_trust_root_sha256: operatorRootSha256,
      schema_version: '1.0.0',
      target_request_path: '/missing-target.json',
    });

    expect(() => parseCompletionAdmissionDescriptor(bytes)).toThrow(/schema|closed/);
  });

  it('rejects request-selected Git bytes outside signed authority', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
    try {
      const authority = authorizedExecutionAuthority({ git_tool_sha256: '1'.repeat(64) });

      expect(() => assertGitToolAuthority(authority, '2'.repeat(64))).toThrow(
        'request-selected Git executable does not match signed authority',
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
