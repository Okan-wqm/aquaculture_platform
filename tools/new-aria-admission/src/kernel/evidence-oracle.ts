import { canonicalJsonBytes } from './canonical-json';
import { validateConflictReview } from './evidence-conflict-review';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  JsonRecord,
  parseCanonicalEvidenceObject,
  requiredSha256,
  requiredText,
} from './evidence-object';
import { validateExecutionWitness } from './execution-witness';
import { loadOracleBaselineInput, OracleBaselineInput } from './negative-control-registry';
import { validateNegativeControlEvidence } from './oracle-control';
import { JsonValue } from './strict-json';

const oracleKeys = [
  'principal_id',
  'oracle_id',
  'implementation_sha256',
  'report',
  'negative_controls',
];
const oracleReportKeys = [
  'schema_version',
  'contract_id',
  'oracle_id',
  'principal_id',
  'implementation_sha256',
  'run_context_sha256',
  'observed_at',
  'input_bundle_sha256',
  'output_sha256',
  'execution',
  'negative_controls',
  'verdict',
];
interface ValidatedOracleReport {
  readonly identifiers: readonly string[];
  readonly report_sha256: string;
  readonly observed_at: string;
}

function reportOutputSha256(manifest: JsonRecord): string {
  if (!isJsonRecord(manifest.report)) throw new TypeError('evidence report reference is invalid');
  return requiredSha256(manifest.report.sha256, 'evidence report digest');
}

function oracleBaselineInput(
  manifest: JsonRecord,
  objects: ReadonlyMap<string, Uint8Array>,
): OracleBaselineInput {
  if (!Array.isArray(manifest.inputs) || manifest.inputs.length !== 1) {
    throw new TypeError('oracle requires exactly one canonical baseline input');
  }
  return loadOracleBaselineInput(manifest.inputs[0], objects, manifest);
}

function validateOracleReport(
  manifest: JsonRecord,
  oracle: JsonRecord,
  objects: ReadonlyMap<string, Uint8Array>,
): ValidatedOracleReport {
  const report = parseCanonicalEvidenceObject(oracle.report, objects, 'oracle report');
  const document = report.document;
  const oracleId = requiredText(oracle.oracle_id, 'oracle ID');
  const principalId = requiredText(oracle.principal_id, 'oracle principal ID');
  const implementationSha256 = requiredSha256(
    oracle.implementation_sha256,
    'oracle implementation digest',
  );
  const inputBundleSha256 = digestBytes(canonicalJsonBytes(manifest.inputs));
  const outputSha256 = reportOutputSha256(manifest);
  const baselineInput = oracleBaselineInput(manifest, objects);
  const baselineReference = (manifest.inputs as JsonValue[])[0];
  if (!isJsonRecord(baselineReference)) {
    throw new TypeError('oracle baseline input reference is invalid');
  }
  const baselineInputSha256 = requiredSha256(
    baselineReference.sha256,
    'oracle baseline input digest',
  );
  if (
    !hasExactKeys(document, oracleReportKeys) ||
    document.schema_version !== '1.0.0' ||
    document.contract_id !== 'new-aria-evidence-oracle-report-v1' ||
    document.oracle_id !== oracleId ||
    document.principal_id !== principalId ||
    document.implementation_sha256 !== implementationSha256 ||
    document.run_context_sha256 !== baselineInput.run_context_sha256 ||
    document.observed_at !== manifest.observed_at ||
    document.input_bundle_sha256 !== inputBundleSha256 ||
    document.output_sha256 !== outputSha256 ||
    document.verdict !== 'PASSED'
  ) {
    throw new TypeError('oracle report does not match the admitted manifest');
  }
  const observedAt = requiredText(document.observed_at, 'oracle report observation timestamp');
  const execution = validateExecutionWitness(document.execution, objects, {
    run_context_sha256: baselineInput.run_context_sha256,
    input_sha256: baselineInputSha256,
    output_sha256: outputSha256,
    semantic_verdict: 'PASSED',
    observed_at: observedAt,
  });
  if (canonicalJsonBytes(execution).compare(canonicalJsonBytes(manifest.execution)) !== 0) {
    throw new TypeError('oracle report execution does not match the evidence manifest');
  }
  const identifiers = validateNegativeControlEvidence(
    oracle.negative_controls,
    document.negative_controls,
    {
      oracle_id: oracleId,
      implementation_sha256: implementationSha256,
      baseline_input_sha256: baselineInputSha256,
      baseline_input: baselineInput,
      observed_at: observedAt,
      baseline_execution: execution,
    },
    objects,
    [report.reference.sha256, inputBundleSha256, ...primaryReferenceDigests(manifest)],
  );
  return {
    identifiers,
    report_sha256: report.reference.sha256,
    observed_at: observedAt,
  };
}

function referenceDigest(value: JsonValue | undefined): string | undefined {
  return isJsonRecord(value) && typeof value.sha256 === 'string' ? value.sha256 : undefined;
}

function primaryReferenceDigests(manifest: JsonRecord): readonly string[] {
  const values: (JsonValue | undefined)[] = [manifest.report];
  if (Array.isArray(manifest.inputs)) values.push(...manifest.inputs);
  if (Array.isArray(manifest.artifacts)) values.push(...manifest.artifacts);
  return values.flatMap((value) => {
    const digest = referenceDigest(value);
    return digest === undefined ? [] : [digest];
  });
}

function reservedReviewDigests(manifest: JsonRecord, oracle: JsonRecord): readonly string[] {
  const values: (JsonValue | undefined)[] = [oracle.report];
  if (Array.isArray(oracle.negative_controls)) {
    for (const control of oracle.negative_controls) {
      if (isJsonRecord(control)) values.push(control.mutant, control.result);
    }
  }
  return [
    ...primaryReferenceDigests(manifest),
    ...values.flatMap((value) => {
      const digest = referenceDigest(value);
      return digest === undefined ? [] : [digest];
    }),
  ];
}

export function negativeControlSetSha256(value: unknown): string {
  return digestBytes(canonicalJsonBytes(value));
}

export function validateOracleEvidence(
  manifest: JsonRecord,
  objects: ReadonlyMap<string, Uint8Array>,
): readonly string[] {
  const oracle = manifest.oracle;
  if (!isJsonRecord(oracle) || !hasExactKeys(oracle, oracleKeys)) {
    throw new TypeError('evidence oracle schema is invalid');
  }
  const principal = requiredText(oracle.principal_id, 'oracle principal ID');
  if (!isJsonRecord(manifest.identities) || manifest.identities.oracle_principal_id !== principal) {
    throw new TypeError('oracle principal does not match evidence identities');
  }
  const report = validateOracleReport(manifest, oracle, objects);
  validateConflictReview(manifest, objects, {
    oracle_report_sha256: report.report_sha256,
    negative_controls_sha256: negativeControlSetSha256(oracle.negative_controls),
    oracle_observed_at: report.observed_at,
    reserved_digests: reservedReviewDigests(manifest, oracle),
  });
  if (manifest.admission_reason !== 'ALL_REQUIRED_CONTROLS_PASSED') {
    throw new TypeError('evidence admission reason is invalid');
  }
  return report.identifiers;
}
