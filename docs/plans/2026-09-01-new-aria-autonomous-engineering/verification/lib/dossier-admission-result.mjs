import { publicKeySha256 } from './verify-signature.mjs';

function reviewCredentials(bundle) {
  return [...bundle.reviewers, bundle.oracle, bundle.conflict];
}

function verifiedKeyRoster(admission, resolved, reviewerBundle) {
  const reviewerKeys = reviewCredentials(reviewerBundle).map((credential) =>
    publicKeySha256(credential.public_key_spki_base64),
  );
  const allKeys = [
    admission.signer.public_key_sha256,
    resolved.targetSigner.public_key_sha256,
    ...reviewerKeys,
  ];
  if (reviewerKeys.length !== 14 || new Set(allKeys).size !== 16) {
    throw new Error('verified dossier public key alias detected');
  }
  return reviewerKeys;
}

export function createDossierAdmissionResult(resources) {
  const { dossier, admission, resolved, verified, dossierSha256 } = resources;
  const credentials = reviewCredentials(verified.reviewer.bundle);
  return {
    accepted: true,
    dossier_sha256: dossierSha256,
    review_admission_sha256: admission.envelopeSha256,
    reviewed_base_sha: dossier.reviewed_target.base_sha,
    reviewed_head_sha: dossier.reviewed_target.head_sha,
    review_count: verified.reviews.reportArtifacts.length,
    reviewer_authority_bundle_sha256: verified.reviewer.sha256,
    admission_principal_id: admission.signer.principalId,
    producer_principal_id: dossier.producer.principal_id,
    target_operator_principal_id: dossier.reviewed_target.target_operator_principal_id,
    reviewer_principal_ids: credentials.map((credential) => credential.principal_id),
    admission_public_key_sha256: admission.signer.public_key_sha256,
    target_operator_public_key_sha256: resolved.targetSigner.public_key_sha256,
    reviewer_public_key_sha256s: verifiedKeyRoster(admission, resolved, verified.reviewer.bundle),
  };
}
