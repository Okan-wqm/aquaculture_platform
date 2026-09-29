import { loadOracleBaselineDocument } from '../kernel/oracle-baseline';
import type { OracleBaselineInput } from '../kernel/oracle-baseline';

import { verifyS01VerificationDossier } from './verification-dossier';
import type { TrustedDossierScope, VerifiedDossierResult } from './verification-dossier';

export interface VerifiedVerifierBaseline {
  readonly baseline: OracleBaselineInput;
  readonly dossier: VerifiedDossierResult;
}

export const loadVerifierBaselineInput = loadOracleBaselineDocument;

export function verifyVerifierBaselineInput(
  bytes: Uint8Array,
  trustedScope: TrustedDossierScope,
): VerifiedVerifierBaseline {
  const baseline = loadOracleBaselineDocument(bytes);
  const dossier = verifyS01VerificationDossier(baseline.verification_dossier, trustedScope);
  return Object.freeze({ baseline, dossier });
}
