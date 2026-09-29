import type { CompletionProjection } from '../src/domain/progress-contracts';
import { renderCompletionProjection } from '../src/runtime/projection-renderer';

const projection: CompletionProjection = {
  schema_version: '1.0.0',
  contract_id: 'new-aria-completion-projection-v1',
  program_id: 'program-1',
  sprint_id: 'S01',
  state: 'DONE',
  status: 'OK',
  freshness: 'VALID_AT',
  verdict: 'ACCEPTED',
  verified_at: '2026-09-02T12:30:00.000Z',
  valid_from: '2026-09-02T12:30:00.000Z',
  valid_until: '2026-09-02T13:00:00.000Z',
  head_sha: 'a'.repeat(40),
  authority_sha256: 'b'.repeat(64),
  evidence_sha256: 'c'.repeat(64),
  event_chain_sha256: 'd'.repeat(64),
  attestation_sha256: 'e'.repeat(64),
  tail_event_hash: 'f'.repeat(64),
};

describe('completion projection rendering authority', () => {
  it('rejects a caller-authored DONE object even when its bytes are well formed', () => {
    expect(() => renderCompletionProjection(projection)).toThrow(/issued by admission/);
  });

  it('rejects frozen, reordered, copied, and mutated caller objects', () => {
    const reordered = Object.freeze({
      tail_event_hash: projection.tail_event_hash,
      attestation_sha256: projection.attestation_sha256,
      event_chain_sha256: projection.event_chain_sha256,
      evidence_sha256: projection.evidence_sha256,
      authority_sha256: projection.authority_sha256,
      head_sha: projection.head_sha,
      verdict: projection.verdict,
      freshness: projection.freshness,
      valid_until: projection.valid_until,
      valid_from: projection.valid_from,
      verified_at: projection.verified_at,
      status: projection.status,
      state: projection.state,
      sprint_id: projection.sprint_id,
      program_id: projection.program_id,
      contract_id: projection.contract_id,
      schema_version: projection.schema_version,
    });
    const candidates: readonly unknown[] = [
      Object.freeze({ ...projection }),
      reordered,
      { ...projection, state: 'READY' },
    ];
    for (const value of candidates) {
      expect(() => renderCompletionProjection(value)).toThrow(/issued by admission/);
    }
  });
});
