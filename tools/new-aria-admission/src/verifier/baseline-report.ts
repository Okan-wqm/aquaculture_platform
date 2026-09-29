import { canonicalJsonBytes } from '../kernel/canonical-json';
import type { VerifiedDossierResult } from './verification-dossier';

export function canonicalVerifierBaselineReport(verification: VerifiedDossierResult): Buffer {
  return Buffer.concat([
    canonicalJsonBytes({
      contract_id: 'new-aria-verifier-report-v1',
      result: {
        code: 'VERIFICATION_PASSED',
        summary: 'Canonical S01 admission verification passed',
        event_chain_sha256: verification.event_chain_sha256,
        history_sha256: verification.history_sha256,
        object_closure_sha256: verification.object_closure_sha256,
        verification_plan_sha256: verification.verification_plan_sha256,
        verifying_projection: {
          bytes_base64: verification.verifying_projection_bytes.toString('base64'),
          sha256: verification.verifying_projection_sha256,
        },
      },
      schema_version: '1.0.0',
      verdict: 'PASSED',
    }),
    Buffer.from('\n'),
  ]);
}
