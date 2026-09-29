import type { EvidenceManifest } from '../src/domain/evidence-contracts';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { manifestSha256 } from '../src/kernel/evidence-chain';
import type { JsonRecord } from '../src/kernel/evidence-object';
import type { VerifiedDossierResult } from '../src/verifier/verification-dossier';

import { attestationBytes, trustRootBytes } from './attestation-fixture';
import { MutableFixture } from './mutable-fixture';
import type {
  ExecutionAuthenticationMaterial,
  ExecutionReceiptFixtureIssuer,
} from './oracle-proof-contracts';
import * as oracleFixture from './oracle-proof-fixture';
import {
  authorityBytes,
  eventPolicyBytes,
  freshnessPolicyBytes,
  progressAuthority,
  requiredValue,
  sha256,
} from './progress-authority-fixture';
import type { CheckpointAuthorityFixture } from './progress-authority-fixture';
import type { CompletionEvent } from './progress-event-fixture';
import { completionEvents, eventBytes } from './progress-event-fixture';
import { progressEvidenceContext } from './progress-evidence-context-fixture';
import { transitionManifestBytes } from './progress-history-fixture';
import { defaultProgressTarget } from './progress-target-fixture';
import type { ProgressTargetFixture } from './progress-target-fixture';
import { conflictReviewProof } from './review-proof-fixture';
import { verifierReportBytes } from './verifier-report-fixture';

type EvidenceManifestFixture = MutableFixture<EvidenceManifest>;

export function evidenceManifestContract(value: EvidenceManifestFixture): EvidenceManifest {
  return value as unknown as EvidenceManifest;
}

export {
  authorityBytes,
  completionEvents,
  eventBytes,
  eventPolicyBytes,
  freshnessPolicyBytes,
  progressAuthority,
  requiredValue,
  sha256,
};

function referenceFor(bytes: Uint8Array): { readonly uri: string; readonly sha256: string } {
  const digest = sha256(bytes);
  return { uri: `aria-evidence://sha256/${digest}`, sha256: digest };
}

const artifactObject = Buffer.from('verified build artifact\n');
const artifactReference = referenceFor(artifactObject);
const placeholderReportReference = referenceFor(Buffer.from('verification-report-placeholder'));

export function evidenceBundle(
  authoritySha256: string,
  overrides: oracleFixture.OracleProofOverrides = {},
  metadata: Readonly<{
    version?: number;
    previous_manifest_sha256?: string | null;
    observation_id?: string;
    target?: ProgressTargetFixture;
    issue_receipt?: ExecutionReceiptFixtureIssuer;
    execution_tree_sha?: string;
    execution_authentication?: ExecutionAuthenticationMaterial;
    verification_dossier?: JsonRecord;
  }> = {},
  verifiedDossier?: VerifiedDossierResult,
): { manifest: EvidenceManifestFixture; objects: Map<string, Uint8Array> } {
  const version = metadata.version ?? 1;
  const observationId = metadata.observation_id ?? 'observation-0001';
  const context = progressEvidenceContext(
    authoritySha256,
    placeholderReportReference,
    artifactReference,
    version,
    observationId,
    metadata.target,
    metadata.verification_dossier,
  );
  const { claim, freshness, target, baseline, inputObject, inputReference } = context;
  const inputs = [inputReference];
  const reportObject = verifierReportBytes(baseline, verifiedDossier);
  const report = referenceFor(reportObject);
  const proof = oracleFixture.oracleProof(
    inputs,
    report,
    progressAuthority().required_negative_control_ids,
    baseline,
    '2026-09-02T12:00:00.000Z',
    overrides,
    metadata.issue_receipt,
    metadata.execution_tree_sha,
    metadata.execution_authentication,
  );
  const conflict = conflictReviewProof({
    authority_sha256: authoritySha256,
    target_head_sha: target.head_sha,
    oracle_report_sha256: proof.oracle.report.sha256,
    negative_controls: proof.oracle.negative_controls,
    reviewed_at: '2026-09-02T12:00:00.000Z',
  });
  const manifest: EvidenceManifestFixture = {
    schema_version: '1.0.0',
    contract_id: 'aria-evidence-manifest-v1',
    evidence_id: 'S01-code-proof',
    version,
    previous_manifest_sha256: metadata.previous_manifest_sha256 ?? null,
    observed_at: '2026-09-02T12:00:00.000Z',
    observation_id: observationId,
    authority_sha256: authoritySha256,
    claim,
    freshness,
    identities: {
      producer_principal_id: 'producer-1',
      reviewer_principal_id: 'reviewer-1',
      oracle_principal_id: 'oracle-1',
      appellate_principal_id: 'appellate-1',
    },
    target,
    execution: {
      ...proof.execution,
      failure_reason_sha256: null,
      semantic_verdict: 'PASSED',
    },
    inputs,
    artifacts: [artifactReference],
    report,
    oracle: proof.oracle,
    review: {
      conflict_verdict: 'NO_CONFLICT',
      conflict_evidence: conflict.reference,
    },
    admission_reason: 'ALL_REQUIRED_CONTROLS_PASSED',
    verdict: 'ACCEPTED',
    unresolved_findings: [],
  };
  return {
    manifest,
    objects: new Map<string, Uint8Array>([
      [inputReference.uri, inputObject],
      [artifactReference.uri, artifactObject],
      [report.uri, reportObject],
      [conflict.reference.uri, conflict.bytes],
      ...proof.objects,
    ]),
  };
}

export const evidenceManifest = (authoritySha256: string): EvidenceManifestFixture =>
  evidenceBundle(authoritySha256).manifest;

export const evidenceBytes = (value: ReturnType<typeof evidenceManifest>): Buffer =>
  Buffer.from(`${canonicalJsonBytes(value).toString()}\n`);

type CompletionFixture = ReturnType<typeof evidenceBundle> & {
  authority: Buffer;
  authoritySha256: string;
  manifestBytes: Buffer;
  manifestBytesChain: readonly Buffer[];
  manifestSha256: string;
  events: CompletionEvent[];
  eventBytes: Buffer;
  trustRoot: Buffer;
  attestation: Buffer;
};

export function completionFixture(
  overrides: oracleFixture.OracleProofOverrides = {},
  checkpointAuthority?: CheckpointAuthorityFixture,
  target?: ProgressTargetFixture,
  issueReceipt?: ExecutionReceiptFixtureIssuer,
  executionTreeSha?: string,
  executionAuthentication?: ExecutionAuthenticationMaterial,
  verificationDossier?: JsonRecord,
  verifiedDossier?: VerifiedDossierResult,
): CompletionFixture {
  const sourceTarget = target ?? defaultProgressTarget();
  const authority = authorityBytes(checkpointAuthority, sourceTarget);
  const authoritySha256 = sha256(authority);
  const transitionBytes: Buffer[] =
    verifiedDossier?.manifest_chain_bytes.map((bytes) => Buffer.from(bytes)) ?? [];
  let predecessor = verifiedDossier?.manifest_chain_sha256s.at(-1) ?? null;
  if (verifiedDossier === undefined) {
    for (const [index, state] of (['READY', 'IN_PROGRESS', 'VERIFYING'] as const).entries()) {
      const bytes = transitionManifestBytes(
        authoritySha256,
        state,
        index + 1,
        predecessor,
        sourceTarget,
        placeholderReportReference,
        artifactReference,
      );
      transitionBytes.push(bytes);
      predecessor = manifestSha256(bytes);
    }
  }
  const bundle = evidenceBundle(
    authoritySha256,
    overrides,
    {
      version: 4,
      previous_manifest_sha256: predecessor,
      observation_id: 'observation-0004',
      target: sourceTarget,
      issue_receipt: issueReceipt,
      execution_tree_sha: executionTreeSha,
      execution_authentication: executionAuthentication,
      verification_dossier: verificationDossier,
    },
    verifiedDossier,
  );
  const manifest = bundle.manifest;
  const manifestBytes = evidenceBytes(manifest);
  const trustRoot = trustRootBytes();
  const manifestDigest = manifestSha256(manifestBytes);
  const manifestBytesChain = [...transitionBytes, manifestBytes];
  const events = completionEvents(
    authoritySha256,
    manifestBytesChain.map(manifestSha256),
    sourceTarget.head_sha,
    verifiedDossier,
  );
  const eventsBytes = eventBytes(events);
  const tail = requiredValue(events.at(-1), 'completion tail event');
  return {
    authority,
    authoritySha256,
    manifest,
    manifestBytes,
    manifestBytesChain: Object.freeze(manifestBytesChain),
    manifestSha256: manifestDigest,
    events,
    eventBytes: eventsBytes,
    trustRoot,
    attestation: attestationBytes(
      manifestBytes,
      authoritySha256,
      eventsBytes,
      tail.event_hash,
      manifest.target.head_sha,
    ),
    objects: bundle.objects,
  };
}
