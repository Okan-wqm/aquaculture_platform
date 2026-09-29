import type { CompletionProjection } from '../src/domain/progress-contracts';
import {
  assertCompletionProjectionCurrent,
  loadCompletionProjectionArtifact,
  serializeCompletionProjectionArtifact,
} from '../src/kernel/completion-projection-artifact';

const projection = (): CompletionProjection => ({
  schema_version: '1.0.0',
  contract_id: 'new-aria-completion-projection-v1',
  program_id: 'new-aria-autonomous-engineering',
  sprint_id: 'S01',
  state: 'DONE',
  status: 'OK',
  freshness: 'VALID_AT',
  verdict: 'ACCEPTED',
  verified_at: '2026-09-02T12:00:00.000Z',
  valid_from: '2026-09-02T12:30:00.000Z',
  valid_until: '2026-09-02T13:00:00.000Z',
  head_sha: 'a'.repeat(40),
  authority_sha256: 'b'.repeat(64),
  evidence_sha256: 'c'.repeat(64),
  event_chain_sha256: 'd'.repeat(64),
  attestation_sha256: 'e'.repeat(64),
  tail_event_hash: 'f'.repeat(64),
});

describe('completion projection artifact', () => {
  it('round-trips one exact closed canonical JSON line', () => {
    const expected = projection();
    const bytes = serializeCompletionProjectionArtifact(expected);

    expect(bytes.at(-1)).toBe(0x0a);
    expect(loadCompletionProjectionArtifact(bytes)).toEqual(expected);
    expect(() => loadCompletionProjectionArtifact(bytes.subarray(0, -1))).toThrow(/framing/);
    expect(() =>
      loadCompletionProjectionArtifact(Buffer.concat([bytes, Buffer.from('\n')])),
    ).toThrow();
  });

  it('uses the proof validity floor rather than its earlier observation time', () => {
    const value = projection();

    expect(() =>
      assertCompletionProjectionCurrent(value, Date.parse(value.valid_from)),
    ).not.toThrow();
    expect(() =>
      assertCompletionProjectionCurrent(value, Date.parse(value.valid_from) - 1),
    ).toThrow(/no longer current/);
  });
});
