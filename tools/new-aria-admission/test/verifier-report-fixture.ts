import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import type { VerifiedDossierResult } from '../src/verifier/verification-dossier';
import { canonicalVerifyingProjection } from '../src/verifier/verifying-projection';

import type { OracleBaselineInput } from './negative-control-fixture';
import { sha256 } from './oracle-execution-fixture';

function fixtureDigest(label: string): string {
  return sha256(Buffer.from(`new-aria-s01-fixture:${label}`));
}

export function verifierReportBytes(
  baseline: OracleBaselineInput,
  verified?: VerifiedDossierResult,
): Buffer {
  const eventChainSha256 = verified?.event_chain_sha256 ?? fixtureDigest('event-chain');
  const historySha256 = verified?.history_sha256 ?? fixtureDigest('history');
  const objectClosureSha256 = verified?.object_closure_sha256 ?? fixtureDigest('object-closure');
  const projection = verified?.verifying_projection_bytes ?? canonicalVerifyingProjection({
    program_id: baseline.program_id,
    sprint_id: baseline.sprint_id,
    head_sha: baseline.head_sha,
    authority_sha256: baseline.authority_sha256,
    verification_time: '2026-09-02T12:00:00.000Z',
    valid_until: '2026-09-02T13:00:00.000Z',
    event_chain_sha256: eventChainSha256,
    history_sha256: historySha256,
    object_closure_sha256: objectClosureSha256,
    event_policy_sha256: baseline.event_policy_sha256,
    freshness_policy_sha256: baseline.freshness_policy_sha256,
    tail_event_hash: fixtureDigest('tail-event'),
  });
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-verifier-report-v1',
    result: {
      code: 'VERIFICATION_PASSED',
      event_chain_sha256: eventChainSha256,
      history_sha256: historySha256,
      object_closure_sha256: objectClosureSha256,
      summary: 'Canonical S01 admission verification passed',
      verification_plan_sha256:
        verified?.verification_plan_sha256 ?? baseline.verification_plan_sha256,
      verifying_projection: {
        bytes_base64: projection.toString('base64'),
        sha256: sha256(projection),
      },
    },
    verdict: 'PASSED',
  });
}
