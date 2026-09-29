import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { loadProgressAuthority } from '../src/kernel/progress-authority';

import { authorityBytes, progressAuthority, sha256 } from './progress-fixture';

describe('progress authority', () => {
  it('loads a closed authority document and derives its canonical digest', () => {
    const authority = canonicalJsonBytes({
      ...progressAuthority(),
      execution_trust_root_sha256: '8'.repeat(64),
      execution_session_id: 'execution-session-s01-0001',
    });
    const loaded = loadProgressAuthority(authority);
    expect(loaded.sha256).toBe(sha256(authority));
    expect(loaded.document.sprint_id).toBe('S01');
    expect(loaded.document.execution_trust_root_sha256).toBe('8'.repeat(64));
    expect(loaded.document.execution_session_id).toBe('execution-session-s01-0001');
    expect(Object.isFrozen(loaded.document)).toBe(true);
    expect(Object.isFrozen(loaded.document.finding_ids)).toBe(true);
  });

  it.each([
    ['unknown field', () => ({ ...progressAuthority(), extra: true })],
    [
      'malformed event policy digest',
      () => ({ ...progressAuthority(), event_policy_sha256: 'short' }),
    ],
    [
      'malformed trust root digest',
      () => ({ ...progressAuthority(), evidence_trust_root_sha256: 'short' }),
    ],
    [
      'malformed checkpoint store identity',
      () => ({ ...progressAuthority(), checkpoint_store_id: '../other-store' }),
    ],
    [
      'malformed checkpoint store digest',
      () => ({ ...progressAuthority(), checkpoint_store_identity_sha256: 'short' }),
    ],
    [
      'malformed verifier argv digest',
      () => ({ ...progressAuthority(), verifier_argv_sha256: 'short' }),
    ],
    [
      'malformed execution cwd digest',
      () => ({ ...progressAuthority(), execution_cwd_sha256: 'short' }),
    ],
    [
      'malformed verifier identity',
      () => ({ ...progressAuthority(), verifier_tool_id: 'tool\u0000alias' }),
    ],
    [
      'malformed runtime identity',
      () => ({ ...progressAuthority(), runtime_id: 'runtime\u202ealias' }),
    ],
    [
      'malformed Git tool identity',
      () => ({ ...progressAuthority(), git_tool_id: 'git\u0000alias' }),
    ],
    ['malformed Git tool digest', () => ({ ...progressAuthority(), git_tool_sha256: 'short' })],
    ['malformed target head', () => ({ ...progressAuthority(), head_sha: 'short' })],
    ['empty target range', () => ({ ...progressAuthority(), head_sha: 'a'.repeat(40) })],
    [
      'duplicate acceptance',
      () => ({
        ...progressAuthority(),
        acceptance_ids: ['ACC-S01', 'ACC-S01'],
      }),
    ],
    [
      'unsorted findings',
      () => ({
        ...progressAuthority(),
        finding_ids: ['ARIA-AUDIT-067', 'ARIA-AUDIT-001'],
      }),
    ],
    ['malformed finding', () => ({ ...progressAuthority(), finding_ids: ['P0-1'] })],
    ['Bidi program ID', () => ({ ...progressAuthority(), program_id: 'aria-\u202eprogram' })],
  ])('rejects %s', (_name, mutate) => {
    expect(() => loadProgressAuthority(canonicalJsonBytes(mutate()))).toThrow();
  });

  it('rejects malformed UTF-8 before JSON parsing', () => {
    expect(() => loadProgressAuthority(Buffer.from([0x7b, 0xc3, 0x28, 0x7d]))).toThrow(/UTF-8/);
  });

  it.each([
    ['UTF-8 BOM', () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), authorityBytes()])],
    ['leading whitespace', () => Buffer.concat([Buffer.from(' '), authorityBytes()])],
    ['trailing newline', () => Buffer.concat([authorityBytes(), Buffer.from('\n')])],
  ])('rejects a non-canonical raw authority alias: %s', (_name, bytes) => {
    expect(() => loadProgressAuthority(bytes())).toThrow(/canonical/);
  });
});
