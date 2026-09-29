'use strict';

const { createHash } = require('node:crypto');
const { readSync } = require('node:fs');

const MAX_STDIN_BYTES = 24 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const count = readSync(0, chunk, 0, chunk.length, null);
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > MAX_STDIN_BYTES) throw new Error('INPUT_TOO_LARGE');
    chunks.push(chunk.subarray(0, count));
  }
}

function decodeEnvelope(bytes) {
  const envelope = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(envelope)) throw new Error('INPUT_SCHEMA_INVALID');
  return envelope.map((entry) => {
    const object = Buffer.from(entry.object_base64, 'base64');
    if (
      Object.keys(entry).sort().join(',') !== 'object_base64,reference' ||
      Object.keys(entry.reference).sort().join(',') !== 'sha256,uri' ||
      sha256(object) !== entry.reference.sha256 ||
      entry.reference.uri !== `aria-evidence://sha256/${entry.reference.sha256}`
    ) {
      throw new Error('INPUT_DIGEST_INVALID');
    }
    return object;
  });
}

function alteredDigest(value) {
  return `${value.startsWith('0') ? '1' : '0'}${value.slice(1)}`;
}

function expectedMutation(controlId, baseline) {
  const mutated = { ...baseline };
  if (controlId === 'NC-S01-EVENT-HASH-TAMPER') {
    mutated.event_context_probe_sha256 = alteredDigest(baseline.event_context_probe_sha256);
  } else if (controlId === 'NC-S01-EVIDENCE-DIGEST-TAMPER') {
    mutated.evidence_context_probe_sha256 = alteredDigest(baseline.evidence_context_probe_sha256);
  } else if (controlId === 'NC-S01-STALE-EVIDENCE') {
    mutated.freshness_valid_until = new Date(
      Date.parse(baseline.freshness_observed_at) - 1,
    ).toISOString();
  } else if (controlId === 'NC-S01-UNAUTHORIZED-TARGET') {
    mutated.head_sha = alteredDigest(baseline.head_sha);
  } else {
    throw new Error('CONTROL_ID_UNREGISTERED');
  }
  return mutated;
}

function baseline() {
  process.stdout.write(
    `${canonical({
      contract_id: 'new-aria-verifier-report-v1',
      result: { code: 'VERIFICATION_PASSED', summary: 'five-run session baseline' },
      schema_version: '1.0.0',
      verdict: 'PASSED',
    })}\n`,
  );
}

function reject(controlId, objects) {
  if (objects.length !== 3) throw new Error('NEGATIVE_INPUT_ROSTER_INVALID');
  const baseline = JSON.parse(objects[0].toString('utf8'));
  const declaration = JSON.parse(objects[1].toString('utf8'));
  const mutated = JSON.parse(objects[2].toString('utf8'));
  const reasons = {
    'NC-S01-EVENT-HASH-TAMPER': 'EVENT_CONTEXT_PROBE_MISMATCH',
    'NC-S01-EVIDENCE-DIGEST-TAMPER': 'EVIDENCE_CONTEXT_PROBE_MISMATCH',
    'NC-S01-STALE-EVIDENCE': 'FRESHNESS_CONTEXT_STALE',
    'NC-S01-UNAUTHORIZED-TARGET': 'TARGET_HEAD_NOT_AUTHORIZED',
  };
  const mutationKinds = {
    'NC-S01-EVENT-HASH-TAMPER': 'EVENT-CONTEXT-PROBE-TAMPER',
    'NC-S01-EVIDENCE-DIGEST-TAMPER': 'EVIDENCE-CONTEXT-PROBE-TAMPER',
    'NC-S01-STALE-EVIDENCE': 'STALE-EVIDENCE',
    'NC-S01-UNAUTHORIZED-TARGET': 'UNAUTHORIZED-TARGET',
  };
  const reasonCode = reasons[controlId];
  const mutationKind = mutationKinds[controlId];
  const mutantKeys = [
    'baseline_input_sha256',
    'contract_id',
    'control_id',
    'implementation_sha256',
    'mutated_input',
    'mutation_kind',
    'oracle_id',
    'run_context_sha256',
    'schema_version',
  ];
  if (
    reasonCode === undefined ||
    mutationKind === undefined ||
    Object.keys(declaration).sort().join(',') !== mutantKeys.join(',') ||
    declaration.schema_version !== '1.0.0' ||
    declaration.contract_id !== 'new-aria-negative-control-mutant-v1' ||
    declaration.control_id !== controlId ||
    declaration.mutation_kind !== mutationKind ||
    declaration.run_context_sha256 !== baseline.run_context_sha256 ||
    declaration.baseline_input_sha256 !== sha256(objects[0]) ||
    declaration.mutated_input.sha256 !== sha256(objects[2]) ||
    declaration.mutated_input.uri !==
      `aria-evidence://sha256/${declaration.mutated_input.sha256}` ||
    canonical(mutated) !== canonical(expectedMutation(controlId, baseline))
  ) {
    throw new Error('NEGATIVE_CONTROL_INVALID');
  }
  const receipt = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-negative-control-rejection-receipt-v1',
    oracle_id: declaration.oracle_id,
    implementation_sha256: declaration.implementation_sha256,
    control_id: controlId,
    mutation_kind: declaration.mutation_kind,
    reason_code: reasonCode,
    run_context_sha256: declaration.run_context_sha256,
    baseline_input_sha256: declaration.baseline_input_sha256,
    mutant_document_sha256: sha256(objects[1]),
    mutated_input_sha256: sha256(objects[2]),
    scope: {
      authority_sha256: baseline.authority_sha256,
      repository_id: baseline.repository_id,
      workspace_id: baseline.workspace_id,
      base_sha: baseline.base_sha,
      head_sha: baseline.head_sha,
      evidence_id: baseline.evidence_id,
      evidence_version: baseline.evidence_version,
      observation_id: baseline.observation_id,
      program_id: baseline.program_id,
      sprint_id: baseline.sprint_id,
      manifest_observed_at: baseline.manifest_observed_at,
      freshness_observed_at: baseline.freshness_observed_at,
      freshness_valid_until: baseline.freshness_valid_until,
      freshness_sha256: baseline.freshness_sha256,
      claim_sha256: baseline.claim_sha256,
      report_sha256: baseline.report_sha256,
      artifacts_sha256: baseline.artifacts_sha256,
      event_context_probe_sha256: baseline.event_context_probe_sha256,
      evidence_context_probe_sha256: baseline.evidence_context_probe_sha256,
    },
    verdict: 'REJECTED',
  };
  const reason = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-negative-control-failure-reason-v1',
    control_id: controlId,
    reason_code: reasonCode,
    run_context_sha256: declaration.run_context_sha256,
    verdict: 'REJECTED',
  };
  process.stdout.write(`${canonical(receipt)}\n`);
  process.stderr.write(`${canonical(reason)}\n`);
  process.exitCode = 1;
}

try {
  const objects = decodeEnvelope(readBoundedStdin());
  const marker = process.argv.indexOf('--negative-control');
  if (marker < 0) baseline();
  else reject(process.argv[marker + 1], objects);
} catch {
  process.stderr.write('VERIFIER_INPUT_REJECTED\n');
  process.exitCode = 2;
}
