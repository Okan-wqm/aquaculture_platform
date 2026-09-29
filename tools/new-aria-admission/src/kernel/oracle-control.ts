import { canonicalJsonBytes } from './canonical-json';
import {
  hasExactKeys,
  isJsonRecord,
  JsonRecord,
  parseCanonicalEvidenceObject,
  requiredSha256,
  requiredText,
  verifyEvidenceObject,
} from './evidence-object';
import { validateExecutionWitness } from './execution-witness';
import { validateRejectionReceipt } from './negative-control-receipt';
import {
  canonicalRegisteredNegativeControl,
  NegativeControlReasonCode,
  OracleBaselineInput,
  requiredNegativeControlCount,
} from './negative-control-registry';
import {
  negativeControlDeclarationKeys,
  negativeControlMutantKeys,
  negativeControlReportKeys,
  negativeControlResultKeys,
} from './negative-control-schema';
import { JsonValue } from './strict-json';

interface OracleIdentity {
  readonly oracle_id: string;
  readonly implementation_sha256: string;
  readonly baseline_input_sha256: string;
  readonly baseline_input: OracleBaselineInput;
  readonly observed_at: string;
  readonly baseline_execution: JsonRecord;
}

interface ValidatedMutant {
  readonly inputSha256: string;
  readonly reasonCode: NegativeControlReasonCode;
}

function validateMutant(
  value: JsonRecord,
  declaration: JsonRecord,
  identity: OracleIdentity,
  objects: ReadonlyMap<string, Uint8Array>,
  index: number,
): ValidatedMutant {
  if (
    !hasExactKeys(value, negativeControlMutantKeys) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-negative-control-mutant-v1' ||
    value.oracle_id !== identity.oracle_id ||
    value.control_id !== declaration.id ||
    value.implementation_sha256 !== identity.implementation_sha256 ||
    value.mutation_kind !== declaration.mutation_kind ||
    value.run_context_sha256 !== identity.baseline_input.run_context_sha256 ||
    declaration.run_context_sha256 !== identity.baseline_input.run_context_sha256 ||
    value.baseline_input_sha256 !== identity.baseline_input_sha256
  ) {
    throw new TypeError('oracle negative control mutant does not match its declaration');
  }
  const control = canonicalRegisteredNegativeControl(
    index,
    requiredText(declaration.id, 'oracle negative control ID'),
    requiredText(declaration.mutation_kind, 'oracle mutation kind'),
    identity.baseline_input,
  );
  const mutatedInput = verifyEvidenceObject(value.mutated_input, objects, 'oracle mutated input');
  if (!Buffer.from(mutatedInput.bytes).equals(Buffer.from(control.bytes))) {
    throw new TypeError('oracle negative control mutant input is not the registered transform');
  }
  return { inputSha256: mutatedInput.sha256, reasonCode: control.reason_code };
}

function validateResult(
  value: JsonRecord,
  declaration: JsonRecord,
  mutantDocumentSha256: string,
  mutant: ValidatedMutant,
  identity: OracleIdentity,
  objects: ReadonlyMap<string, Uint8Array>,
): JsonRecord {
  if (
    !hasExactKeys(value, negativeControlResultKeys) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-negative-control-result-v1' ||
    value.oracle_id !== identity.oracle_id ||
    value.control_id !== declaration.id ||
    value.implementation_sha256 !== identity.implementation_sha256 ||
    value.mutation_kind !== declaration.mutation_kind ||
    value.run_context_sha256 !== identity.baseline_input.run_context_sha256 ||
    value.baseline_input_sha256 !== identity.baseline_input_sha256 ||
    value.mutant_document_sha256 !== mutantDocumentSha256 ||
    value.mutated_input_sha256 !== mutant.inputSha256 ||
    value.verdict !== 'REJECTED'
  ) {
    throw new TypeError('oracle negative control result does not match its mutant');
  }
  const execution = validateExecutionWitness(value.execution, objects, {
    run_context_sha256: identity.baseline_input.run_context_sha256,
    input_sha256: mutant.inputSha256,
    output_sha256: requiredSha256(
      isJsonRecord(value.execution) ? value.execution.output_sha256 : undefined,
      'oracle negative control output digest',
    ),
    semantic_verdict: 'REJECTED',
    observed_at: identity.observed_at,
  });
  validateRejectionReceipt(execution, objects, {
    oracle_id: identity.oracle_id,
    implementation_sha256: identity.implementation_sha256,
    control_id: requiredText(declaration.id, 'oracle negative control ID'),
    mutation_kind: requiredText(declaration.mutation_kind, 'oracle mutation kind'),
    reason_code: mutant.reasonCode,
    baseline_input_sha256: identity.baseline_input_sha256,
    mutant_document_sha256: mutantDocumentSha256,
    mutated_input_sha256: mutant.inputSha256,
    baseline: identity.baseline_input,
  });
  for (const field of [
    'tool_id',
    'tool_sha256',
    'runtime_id',
    'runtime_sha256',
    'cwd',
    'cwd_sha256',
  ]) {
    if (execution[field] !== identity.baseline_execution[field]) {
      throw new TypeError('oracle negative control execution environment drifted');
    }
  }
  if (!Array.isArray(identity.baseline_execution.argv)) {
    throw new TypeError('oracle baseline argv is invalid');
  }
  const expectedArgv = [...identity.baseline_execution.argv, '--negative-control', declaration.id];
  if (canonicalJsonBytes(execution.argv).compare(canonicalJsonBytes(expectedArgv)) !== 0) {
    throw new TypeError('oracle negative control argv is not derived from the authorized verifier');
  }
  const baselineFinishedAt = requiredText(
    identity.baseline_execution.finished_at,
    'oracle baseline execution finish',
  );
  const controlStartedAt = requiredText(execution.started_at, 'oracle control execution start');
  if (Date.parse(controlStartedAt) < Date.parse(baselineFinishedAt)) {
    throw new TypeError('oracle negative control execution predates the baseline execution');
  }
  return execution;
}

function addUniqueMaterial(material: Set<string>, values: readonly string[]): void {
  for (const value of values) {
    if (material.has(value)) throw new TypeError('oracle negative control evidence is reused');
    material.add(value);
  }
}

export function validateNegativeControlEvidence(
  declarations: JsonValue | undefined,
  reportControls: JsonValue | undefined,
  identity: OracleIdentity,
  objects: ReadonlyMap<string, Uint8Array>,
  reservedDigests: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(declarations) ||
    declarations.length !== requiredNegativeControlCount ||
    !Array.isArray(reportControls) ||
    declarations.length !== reportControls.length
  ) {
    throw new TypeError('oracle negative control evidence set is incomplete');
  }
  const identifiers: string[] = [];
  const material = new Set(reservedDigests);
  declarations.forEach((declarationValue, index) => {
    const reportValue = reportControls[index];
    if (
      !isJsonRecord(declarationValue) ||
      !hasExactKeys(declarationValue, negativeControlDeclarationKeys) ||
      !isJsonRecord(reportValue) ||
      !hasExactKeys(reportValue, negativeControlReportKeys)
    ) {
      throw new TypeError('oracle negative control schema is invalid');
    }
    const id = requiredText(declarationValue.id, 'oracle negative control ID');
    const kind = requiredText(declarationValue.mutation_kind, 'oracle mutation kind');
    if (declarationValue.expected_verdict !== 'REJECTED') {
      throw new TypeError('oracle negative control declaration is invalid');
    }
    if (declarationValue.run_context_sha256 !== identity.baseline_input.run_context_sha256) {
      throw new TypeError('oracle negative control run context is invalid');
    }
    const mutant = parseCanonicalEvidenceObject(declarationValue.mutant, objects, 'oracle mutant');
    const result = parseCanonicalEvidenceObject(
      declarationValue.result,
      objects,
      'oracle control result',
    );
    const mutantResult = validateMutant(
      mutant.document,
      declarationValue,
      identity,
      objects,
      index,
    );
    const execution = validateResult(
      result.document,
      declarationValue,
      mutant.reference.sha256,
      mutantResult,
      identity,
      objects,
    );
    if (
      reportValue.id !== id ||
      reportValue.mutation_kind !== kind ||
      reportValue.run_context_sha256 !== identity.baseline_input.run_context_sha256 ||
      reportValue.mutant_sha256 !== mutant.reference.sha256 ||
      reportValue.result_sha256 !== result.reference.sha256 ||
      reportValue.observed_verdict !== 'REJECTED'
    ) {
      throw new TypeError('oracle negative control report binding is invalid');
    }
    addUniqueMaterial(material, [
      mutant.reference.sha256,
      mutantResult.inputSha256,
      result.reference.sha256,
      requiredSha256(execution.output_sha256, 'oracle control output digest'),
      requiredSha256(execution.stdout_sha256, 'oracle control stdout digest'),
      requiredSha256(execution.failure_reason_sha256, 'oracle control failure digest'),
    ]);
    identifiers.push(id);
  });
  return identifiers;
}
