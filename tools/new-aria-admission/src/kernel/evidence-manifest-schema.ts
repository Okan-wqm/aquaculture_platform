export const manifestKeys = [
  'schema_version',
  'contract_id',
  'evidence_id',
  'version',
  'previous_manifest_sha256',
  'observed_at',
  'observation_id',
  'authority_sha256',
  'claim',
  'freshness',
  'identities',
  'target',
  'execution',
  'inputs',
  'artifacts',
  'report',
  'oracle',
  'review',
  'admission_reason',
  'verdict',
  'unresolved_findings',
] as const;

export const transitionManifestKeys = [
  'schema_version',
  'contract_id',
  'evidence_id',
  'version',
  'previous_manifest_sha256',
  'observed_at',
  'observation_id',
  'authority_sha256',
  'claim',
  'identities',
  'target',
] as const;

export const identityKeys = [
  'producer_principal_id',
  'reviewer_principal_id',
  'oracle_principal_id',
  'appellate_principal_id',
] as const;

export const targetKeys = [
  'repository_id',
  'workspace_id',
  'base_sha',
  'head_sha',
  'deployed_sha',
] as const;

export const executionKeys = [
  'argv',
  'argv_sha256',
  'tool_id',
  'tool_sha256',
  'runtime_id',
  'runtime_sha256',
  'cwd',
  'cwd_sha256',
  'input_sha256',
  'output_sha256',
  'started_at',
  'finished_at',
  'exit_code',
  'stdout_sha256',
  'failure_reason_sha256',
  'semantic_verdict',
] as const;

export const referenceKeys = ['uri', 'sha256'] as const;
export const claimKeys = [
  'program_id',
  'sprint_id',
  'state',
  'acceptance_ids',
  'finding_ids',
] as const;

export const sha40 = /^[a-f0-9]{40}$/u;
export const sha64 = /^[a-f0-9]{64}$/u;
export const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
