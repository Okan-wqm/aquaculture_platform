export const negativeControlDeclarationKeys = [
  'id',
  'mutation_kind',
  'run_context_sha256',
  'expected_verdict',
  'mutant',
  'result',
];

export const negativeControlReportKeys = [
  'id',
  'mutation_kind',
  'run_context_sha256',
  'mutant_sha256',
  'result_sha256',
  'observed_verdict',
];

export const negativeControlMutantKeys = [
  'schema_version',
  'contract_id',
  'oracle_id',
  'control_id',
  'implementation_sha256',
  'mutation_kind',
  'run_context_sha256',
  'baseline_input_sha256',
  'mutated_input',
];

export const negativeControlResultKeys = [
  'schema_version',
  'contract_id',
  'oracle_id',
  'control_id',
  'implementation_sha256',
  'mutation_kind',
  'run_context_sha256',
  'baseline_input_sha256',
  'mutant_document_sha256',
  'mutated_input_sha256',
  'execution',
  'verdict',
];
