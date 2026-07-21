import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');

const BACKUP_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'backup-production.yml');
const PITR_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'pitr-restore-production.yml');
const FRESHNESS_WORKFLOW_PATH = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'database-wal-archive-freshness.yml',
);
const CLOSURE_WORKFLOW_PATH = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'verify-backup-dr-closure.yml',
);
const SECRET_MANIFEST_PATH = join(REPO_ROOT, '.github', 'manifests', 'backup-secrets.json');
const POSTGRES_IMAGE_MANIFEST_PATH = join(REPO_ROOT, '.github', 'manifests', 'postgres-image.json');
const PREFLIGHT_HELPER_PATH = join(
  REPO_ROOT,
  'tools',
  'scripts',
  'database',
  'assert-backup-secrets.sh',
);
const BACKUP_SCRIPT_PATH = join(REPO_ROOT, 'tools', 'scripts', 'database', 'backup-databases.sh');
const PROTECTED_SSH_PATH = join(REPO_ROOT, 'tools', 'scripts', 'ci', 'run-protected-ssh.sh');
const EVIDENCE_VERIFIER_PATH = join(
  REPO_ROOT,
  'tools',
  'scripts',
  'database',
  'verify-walg-github-evidence.sh',
);
const EVIDENCE_MIRROR_VERIFIER_PATH = join(
  REPO_ROOT,
  'tools',
  'scripts',
  'database',
  'verify-walg-evidence-mirror.sh',
);
const SIGNED_TRANSFER_MATERIALIZER_PATH = join(
  REPO_ROOT,
  'tools',
  'scripts',
  'database',
  'materialize-walg-signed-transfer.sh',
);
const EVIDENCE_ATTESTATION_TOOL_PATH = join(
  REPO_ROOT,
  'tools',
  'scripts',
  'database',
  'walg-evidence-attestation.mjs',
);
const EVIDENCE_EVALUATOR_TOOL_PATH = join(
  REPO_ROOT,
  'tools',
  'scripts',
  'database',
  'evaluate-walg-evidence.mjs',
);
const PITR_CEREMONY_PATH = join(REPO_ROOT, 'tools', 'scripts', 'database', 'walg-pitr-ceremony.sh');
const RESTORE_RUNBOOK_PATH = join(REPO_ROOT, 'docs', 'runbooks', 'database-restore-drill.md');
const ROTATION_RUNBOOK_PATH = join(REPO_ROOT, 'docs', 'runbooks', 'secret-rotation.md');
const JEST_CONFIG_PATH = join(REPO_ROOT, 'tests', 'invariants', 'jest.config.ts');
const CODEOWNERS_PATH = join(REPO_ROOT, '.github', 'CODEOWNERS');

const PROFILE_NAMES = [
  'backup-runtime',
  'pitr-runtime',
  'evidence-publisher',
  'evidence-verifier',
  'archive-freshness',
] as const;

type ProfileName = (typeof PROFILE_NAMES)[number];

const REQUIRED_SECRET_NAMES = [
  'PRODUCTION_BACKUP_DROPLET_HOST',
  'PRODUCTION_BACKUP_DROPLET_USER',
  'PRODUCTION_BACKUP_DROPLET_SSH_KEY',
  'PRODUCTION_BACKUP_DROPLET_SSH_FINGERPRINT',
  'SPACES_ENDPOINT',
  'SPACES_REGION',
  'WALG_SPACES_ACCESS_KEY_ID',
  'WALG_SPACES_SECRET_ACCESS_KEY',
  'LOGICAL_BACKUP_SPACES_BUCKET',
  'LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID',
  'LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY',
  'LOGICAL_BACKUP_GPG_RECIPIENT',
  'EVIDENCE_SPACES_BUCKET',
  'EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID',
  'EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY',
  'EVIDENCE_VERIFIER_SPACES_ACCESS_KEY_ID',
  'EVIDENCE_VERIFIER_SPACES_SECRET_ACCESS_KEY',
  'BACKUP_POSTGRES_USER',
  'BACKUP_POSTGRES_DB',
  'BACKUP_POSTGRES_PASSWORD',
  'WALG_LIBSODIUM_KEY_B64',
  'PITR_SOURCE_SYSTEM_IDENTIFIER',
  'PITR_WALG_SPACES_ACCESS_KEY_ID',
  'PITR_WALG_SPACES_SECRET_ACCESS_KEY',
  'PITR_WALG_LIBSODIUM_KEY_B64',
] as const;

const REQUIRED_VARIABLE_NAMES = [
  'WALG_SPACES_BUCKET',
  'WALG_BACKUP_EPOCH',
  'PITR_WALG_SPACES_BUCKET',
  'PITR_WALG_BACKUP_EPOCH',
] as const;

const EXPECTED_PROFILE_SECRETS: Record<ProfileName, readonly string[]> = {
  'backup-runtime': [
    'PRODUCTION_BACKUP_DROPLET_HOST',
    'PRODUCTION_BACKUP_DROPLET_USER',
    'PRODUCTION_BACKUP_DROPLET_SSH_KEY',
    'PRODUCTION_BACKUP_DROPLET_SSH_FINGERPRINT',
    'SPACES_ENDPOINT',
    'SPACES_REGION',
    'WALG_SPACES_ACCESS_KEY_ID',
    'WALG_SPACES_SECRET_ACCESS_KEY',
    'LOGICAL_BACKUP_SPACES_BUCKET',
    'LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID',
    'LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY',
    'LOGICAL_BACKUP_GPG_RECIPIENT',
    'BACKUP_POSTGRES_USER',
    'BACKUP_POSTGRES_DB',
    'BACKUP_POSTGRES_PASSWORD',
    'WALG_LIBSODIUM_KEY_B64',
  ],
  'pitr-runtime': [
    'PRODUCTION_BACKUP_DROPLET_HOST',
    'PRODUCTION_BACKUP_DROPLET_USER',
    'PRODUCTION_BACKUP_DROPLET_SSH_KEY',
    'PRODUCTION_BACKUP_DROPLET_SSH_FINGERPRINT',
    'SPACES_ENDPOINT',
    'SPACES_REGION',
    'PITR_WALG_SPACES_ACCESS_KEY_ID',
    'PITR_WALG_SPACES_SECRET_ACCESS_KEY',
    'BACKUP_POSTGRES_USER',
    'BACKUP_POSTGRES_DB',
    'BACKUP_POSTGRES_PASSWORD',
    'PITR_WALG_LIBSODIUM_KEY_B64',
    'PITR_SOURCE_SYSTEM_IDENTIFIER',
  ],
  'evidence-publisher': [
    'SPACES_ENDPOINT',
    'SPACES_REGION',
    'EVIDENCE_SPACES_BUCKET',
    'EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID',
    'EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY',
  ],
  'evidence-verifier': [
    'SPACES_ENDPOINT',
    'SPACES_REGION',
    'EVIDENCE_SPACES_BUCKET',
    'EVIDENCE_VERIFIER_SPACES_ACCESS_KEY_ID',
    'EVIDENCE_VERIFIER_SPACES_SECRET_ACCESS_KEY',
  ],
  'archive-freshness': [
    'PRODUCTION_BACKUP_DROPLET_HOST',
    'PRODUCTION_BACKUP_DROPLET_USER',
    'PRODUCTION_BACKUP_DROPLET_SSH_KEY',
    'PRODUCTION_BACKUP_DROPLET_SSH_FINGERPRINT',
  ],
};

const EXPECTED_PROFILE_VARIABLES: Record<ProfileName, readonly string[]> = {
  'backup-runtime': ['WALG_SPACES_BUCKET', 'WALG_BACKUP_EPOCH'],
  'pitr-runtime': ['PITR_WALG_SPACES_BUCKET', 'PITR_WALG_BACKUP_EPOCH'],
  'evidence-publisher': [],
  'evidence-verifier': [],
  'archive-freshness': [],
};

const PROFILE_NAME_SET: ReadonlySet<string> = new Set(PROFILE_NAMES);
const ARCHIVE_FRESHNESS_SECRET_SET: ReadonlySet<string> = new Set(
  EXPECTED_PROFILE_SECRETS['archive-freshness'],
);

interface BackupSecretContract {
  name: string;
  profiles: ProfileName[];
  runtime: Record<string, string>;
  meaning: string;
  safeExample: string;
}

interface BackupSecretManifest {
  githubEnvironment: {
    name: string;
    deployment: boolean;
  };
  profiles: Record<ProfileName, string>;
  requiredVariables: BackupSecretContract[];
  requiredSecrets: BackupSecretContract[];
}

interface PostgresImageManifest {
  image: string;
}

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
}

interface WorkflowJob {
  if?: string;
  environment?: { name?: string };
  permissions?: Record<string, string>;
  outputs?: Record<string, unknown>;
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  jobs?: Record<string, WorkflowJob>;
}

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readManifest(): BackupSecretManifest {
  return JSON.parse(read(SECRET_MANIFEST_PATH)) as BackupSecretManifest;
}

function readPostgresImageManifest(): PostgresImageManifest {
  return JSON.parse(read(POSTGRES_IMAGE_MANIFEST_PATH)) as PostgresImageManifest;
}

function readWorkflow(path: string): WorkflowDocument {
  return yaml.load(read(path)) as WorkflowDocument;
}

function isProtectedStep(step: WorkflowStep): boolean {
  const environment = JSON.stringify(step.env ?? {});
  return (
    environment.includes('${{ secrets.') ||
    environment.includes('${{ github.token }}') ||
    environment.includes('evidence_b64') ||
    environment.includes('EVIDENCE_B64') ||
    environment.includes('evidence_gzip_b64') ||
    environment.includes('EVIDENCE_GZIP_B64')
  );
}

function secretExpression(secretName: string): string {
  return `\${{ secrets.${secretName} }}`;
}

function variableExpression(variableName: string): string {
  return `\${{ vars.${variableName} }}`;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function profileSecrets(manifest: BackupSecretManifest, profile: ProfileName): string[] {
  return manifest.requiredSecrets
    .filter((secret) => secret.profiles.includes(profile))
    .map((secret) => secret.name);
}

function profilePreflightSecrets(manifest: BackupSecretManifest, profile: ProfileName): string[] {
  return manifest.requiredSecrets
    .filter((secret) => secret.profiles.includes(profile))
    .map((secret) => secret.runtime.runnerEnv ?? secret.name);
}

function profileVariables(manifest: BackupSecretManifest, profile: ProfileName): string[] {
  return manifest.requiredVariables
    .filter((variable) => variable.profiles.includes(profile))
    .map((variable) => variable.name);
}

function runPreflight(
  profile: ProfileName | 'invalid-profile',
  secretNames: readonly string[],
): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [PREFLIGHT_HELPER_PATH], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      BACKUP_SECRET_PROFILE: profile,
      ...Object.fromEntries(secretNames.map((secretName) => [secretName, 'resolved-test-value'])),
    },
  });
}

function extractBackupSshScript(workflow: string): string {
  const stepStart = workflow.indexOf('- name: Run backup-databases.sh on the droplet');
  if (stepStart < 0) {
    throw new Error('Could not find backup SSH step');
  }
  const scriptStart = workflow.indexOf('run: |', stepStart);
  if (scriptStart < 0) {
    throw new Error('Could not find backup protected-SSH run block');
  }
  const nextStep = workflow.indexOf('\n      - name:', scriptStart + 1);
  return workflow.slice(scriptStart, nextStep > scriptStart ? nextStep : workflow.length);
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function extractShellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

function extractPythonHeredoc(source: string, invocation: string): string {
  const invocationStart = source.indexOf(invocation);
  expect(invocationStart).toBeGreaterThanOrEqual(0);
  const heredocMarker = "<<'PY'\n";
  const scriptStart = source.indexOf(heredocMarker, invocationStart);
  expect(scriptStart).toBeGreaterThan(invocationStart);
  const bodyStart = scriptStart + heredocMarker.length;
  const bodyEnd = source.indexOf('\nPY', bodyStart);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return source.slice(bodyStart, bodyEnd);
}

describe('production backup secret contract', () => {
  it('keeps one canonical secret and non-secret coordinate manifest split across five profiles', () => {
    const manifest = readManifest();
    const names = manifest.requiredSecrets.map((secret) => secret.name);
    const variableNames = manifest.requiredVariables.map((variable) => variable.name);

    expect(manifest.githubEnvironment).toMatchObject({
      name: 'production-backup',
      deployment: false,
    });
    expect(REQUIRED_SECRET_NAMES).toHaveLength(25);
    expect(REQUIRED_VARIABLE_NAMES).toHaveLength(4);
    expect(PROFILE_NAMES).toHaveLength(5);
    expect(Object.keys(manifest.profiles).sort()).toEqual(sorted(PROFILE_NAMES));
    expect(names).toHaveLength(REQUIRED_SECRET_NAMES.length);
    expect(new Set(names).size).toBe(names.length);
    expect(sorted(names)).toEqual(sorted(REQUIRED_SECRET_NAMES));
    expect(variableNames).toHaveLength(REQUIRED_VARIABLE_NAMES.length);
    expect(new Set(variableNames).size).toBe(variableNames.length);
    expect(sorted(variableNames)).toEqual(sorted(REQUIRED_VARIABLE_NAMES));

    for (const profile of PROFILE_NAMES) {
      expect(sorted(profileSecrets(manifest, profile))).toEqual(
        sorted(EXPECTED_PROFILE_SECRETS[profile]),
      );
      expect(sorted(profileVariables(manifest, profile))).toEqual(
        sorted(EXPECTED_PROFILE_VARIABLES[profile]),
      );
    }

    for (const contract of [...manifest.requiredSecrets, ...manifest.requiredVariables]) {
      expect(contract.profiles.length).toBeGreaterThan(0);
      expect(contract.profiles.every((profile) => PROFILE_NAME_SET.has(profile))).toBe(true);
      expect(contract.meaning).not.toHaveLength(0);
      expect(contract.safeExample).not.toHaveLength(0);
      const mappings = Object.values(contract.runtime);
      expect(mappings).toHaveLength(1);
      expect(mappings.every((mapping) => mapping.length > 0)).toBe(true);
    }

    expect(
      manifest.requiredSecrets.find((secret) => secret.name === 'SPACES_REGION'),
    ).toMatchObject({
      profiles: ['backup-runtime', 'pitr-runtime', 'evidence-publisher', 'evidence-verifier'],
      runtime: { jobEnv: 'AWS_REGION' },
    });
    expect(
      manifest.requiredSecrets.find((secret) => secret.name === 'LOGICAL_BACKUP_GPG_RECIPIENT'),
    ).toMatchObject({
      profiles: ['backup-runtime'],
      runtime: { remoteEnv: 'BACKUP_GPG_RECIPIENT' },
    });
    expect(
      Object.fromEntries(
        manifest.requiredSecrets
          .filter((secret) => secret.name.startsWith('PRODUCTION_BACKUP_DROPLET_'))
          .map((secret) => [secret.name, secret.runtime.runnerEnv]),
      ),
    ).toEqual({
      PRODUCTION_BACKUP_DROPLET_HOST: 'DROPLET_HOST',
      PRODUCTION_BACKUP_DROPLET_USER: 'DROPLET_USER',
      PRODUCTION_BACKUP_DROPLET_SSH_KEY: 'DROPLET_SSH_KEY',
      PRODUCTION_BACKUP_DROPLET_SSH_FINGERPRINT: 'DROPLET_SSH_FINGERPRINT',
    });
  });

  it('makes every profile fail closed when any of its manifest secrets is absent', () => {
    const manifest = readManifest();

    for (const profile of PROFILE_NAMES) {
      const required = profilePreflightSecrets(manifest, profile);
      const variables = profileVariables(manifest, profile);
      const complete = runPreflight(profile, [...required, ...variables]);
      expect(`${complete.stdout}${complete.stderr}`).toContain(`required by ${profile} resolved`);
      expect(complete.status).toBe(0);

      for (const omitted of required) {
        const incomplete = runPreflight(profile, [
          ...required.filter((name) => name !== omitted),
          ...variables,
        ]);
        expect(incomplete.status).toBe(1);
        expect(`${incomplete.stdout}${incomplete.stderr}`).toContain(omitted);
      }
      for (const omitted of variables) {
        const incomplete = runPreflight(profile, [
          ...required,
          ...variables.filter((name) => name !== omitted),
        ]);
        expect(incomplete.status).toBe(1);
        expect(`${incomplete.stdout}${incomplete.stderr}`).toContain(omitted);
      }
    }

    expect(runPreflight('invalid-profile', []).status).toBe(2);
  });

  it('binds each workflow to only the least-privilege profiles it needs', () => {
    const backup = read(BACKUP_WORKFLOW_PATH);
    const pitr = read(PITR_WORKFLOW_PATH);
    const freshness = read(FRESHNESS_WORKFLOW_PATH);
    const closure = read(CLOSURE_WORKFLOW_PATH);
    const manifest = readManifest();

    expect(backup).toContain('BACKUP_SECRET_PROFILE: backup-runtime');
    expect(backup).toContain('BACKUP_SECRET_PROFILE: evidence-publisher');
    expect(backup).not.toContain('EVIDENCE_VERIFIER_SPACES_ACCESS_KEY_ID');
    expect(backup).not.toContain('EVIDENCE_VERIFIER_SPACES_SECRET_ACCESS_KEY');
    for (const secretName of profileSecrets(manifest, 'evidence-publisher')) {
      expect(backup).toContain(secretExpression(secretName));
    }

    expect(pitr).toContain('BACKUP_SECRET_PROFILE: pitr-runtime');
    expect(pitr).toContain('BACKUP_SECRET_PROFILE: evidence-publisher');
    expect(pitr).not.toContain('LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID');
    expect(pitr).not.toContain('LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY');
    expect(pitr).not.toContain('EVIDENCE_VERIFIER_SPACES_ACCESS_KEY_ID');
    expect(pitr).not.toContain('EVIDENCE_VERIFIER_SPACES_SECRET_ACCESS_KEY');
    for (const secretName of profileSecrets(manifest, 'pitr-runtime')) {
      expect(pitr).toContain(secretExpression(secretName));
    }
    for (const variableName of profileVariables(manifest, 'backup-runtime')) {
      expect(backup).toContain(variableExpression(variableName));
    }
    for (const variableName of profileVariables(manifest, 'pitr-runtime')) {
      expect(pitr).toContain(variableExpression(variableName));
    }
    for (const secretName of profileSecrets(manifest, 'evidence-publisher')) {
      expect(pitr).toContain(secretExpression(secretName));
    }

    expect(freshness).toContain('BACKUP_SECRET_PROFILE: archive-freshness');
    for (const secretName of REQUIRED_SECRET_NAMES.filter(
      (name) => !ARCHIVE_FRESHNESS_SECRET_SET.has(name),
    )) {
      expect(freshness).not.toContain(secretExpression(secretName));
    }

    expect(closure).toContain('BACKUP_SECRET_PROFILE: evidence-verifier');
    expect(closure).not.toContain('EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID');
    expect(closure).not.toContain('EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY');
    for (const secretName of profileSecrets(manifest, 'evidence-verifier')) {
      expect(closure).toContain(secretExpression(secretName));
    }
  });

  it('makes every production-backup job independently main-only before secrets or OIDC', () => {
    for (const workflowPath of [
      BACKUP_WORKFLOW_PATH,
      PITR_WORKFLOW_PATH,
      FRESHNESS_WORKFLOW_PATH,
      CLOSURE_WORKFLOW_PATH,
    ]) {
      const workflow = readWorkflow(workflowPath);
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        if (job.environment?.name !== 'production-backup') continue;

        expect(job.if).toMatch(/github[.]ref\s*==\s*'refs\/heads\/main'/);
        const steps = job.steps ?? [];
        const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
        const authorityIndex = steps.findIndex(
          (step) =>
            step.run?.includes('test "${GITHUB_REF}" = \'refs/heads/main\'') === true &&
            step.run.includes('test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"'),
        );
        const firstProtectedIndex = steps.findIndex(
          (step) => isProtectedStep(step) || step.uses?.startsWith('sigstore/cosign-installer@'),
        );

        expect({ workflowPath, jobName, checkoutIndex }).toMatchObject({ checkoutIndex: 0 });
        expect(steps[checkoutIndex]?.with).toMatchObject({
          ref: '${{ github.sha }}',
          'fetch-depth': 1,
          'persist-credentials': false,
        });
        expect(authorityIndex).toBeGreaterThan(checkoutIndex);
        expect(firstProtectedIndex).toBeGreaterThan(authorityIndex);

        for (const step of steps.filter(isProtectedStep)) {
          if (typeof step.run !== 'string') continue;
          expect(step.run.trimStart().split(/\r?\n/, 1)[0]).toBe('set +x');
        }
      }
    }
  });

  it('moves tenant-scale evidence only through immutable file artifacts', () => {
    const workflowCases = [
      {
        jobName: 'backup',
        path: BACKUP_WORKFLOW_PATH,
        rawFile: 'base-backup.json',
        workflowFile: 'backup-production.yml',
      },
      {
        jobName: 'restore',
        path: PITR_WORKFLOW_PATH,
        rawFile: 'timestamp-pitr.json',
        workflowFile: 'pitr-restore-production.yml',
      },
    ] as const;

    for (const workflowCase of workflowCases) {
      const document = readWorkflow(workflowCase.path);
      const transportJob = document.jobs?.[workflowCase.jobName];
      const remote = transportJob?.steps?.find((step) => step.id?.startsWith('remote_') === true);
      const rawUpload = transportJob?.steps?.find(
        (step) => step.name?.startsWith('Preserve immutable raw') === true,
      );
      const prepare = document.jobs?.['prepare-evidence']?.steps?.find(
        (step) => step.name === 'Create unsigned run-scoped records',
      );
      const unsignedUpload = document.jobs?.['prepare-evidence']?.steps?.find(
        (step) => step.id === 'preserve_unsigned',
      );
      const signer = document.jobs?.['sign-evidence']?.steps?.find((step) => step.id === 'sign');
      const transferJob = document.jobs?.['transfer-evidence'];
      const transferBuild = transferJob?.steps?.find(
        (step) => step.name === 'Rebuild and verify signed transfer payload',
      );
      const signerUpload = transferJob?.steps?.find((step) => step.id === 'preserve_signed');
      const publisherDownload = document.jobs?.['publish-evidence']?.steps?.find(
        (step) => step.name === 'Download exact signed evidence transfer artifact',
      );

      expect(transportJob?.outputs).toEqual({
        raw_evidence_artifact_id: '${{ steps.preserve_raw_evidence.outputs.artifact-id }}',
        raw_evidence_artifact_digest: '${{ steps.preserve_raw_evidence.outputs.artifact-digest }}',
      });
      expect(rawUpload?.uses).toContain('actions/upload-artifact@');
      expect(rawUpload?.with).toMatchObject({
        name: `walg-raw-evidence-v1-${workflowCase.workflowFile}-${'${{ github.run_id }}'}-${'${{ github.run_attempt }}'}`,
        path: `raw-evidence/${workflowCase.rawFile}`,
        overwrite: false,
        'retention-days': 90,
        'compression-level': 0,
        archive: true,
      });
      const evidenceProducer =
        workflowCase.workflowFile === 'pitr-restore-production.yml'
          ? read(PITR_CEREMONY_PATH)
          : remote?.run;
      expect(evidenceProducer).toContain('test "${EVIDENCE_BYTES}" -le 8388608');
      expect(remote?.run).toContain('test "${EVIDENCE_GZIP_BYTES}" -le 9437184');
      expect(remote?.run).toContain('EVIDENCE_MARKER_FILE=');
      expect(remote?.run).toContain('base64 --decode < "${EVIDENCE_MARKER_FILE}"');
      expect(remote?.run).toContain('if total > 8388608:');
      expect(remote?.run).toContain('os.O_EXCL | os.O_NOFOLLOW');
      expect(remote?.run).not.toContain('GITHUB_OUTPUT');
      expect(prepare?.env).toMatchObject({
        RAW_EVIDENCE_ARTIFACT_ID: `\${{ needs.${workflowCase.jobName}.outputs.raw_evidence_artifact_id }}`,
        RAW_EVIDENCE_ARTIFACT_DIGEST: `\${{ needs.${workflowCase.jobName}.outputs.raw_evidence_artifact_digest }}`,
      });
      expect(prepare?.run).toContain('/actions/artifacts/${RAW_EVIDENCE_ARTIFACT_ID}');
      expect(prepare?.run).toContain('stat.S_ISLNK(unix_mode)');
      expect(prepare?.run).toContain('--artifact-digest "sha256:${RAW_EVIDENCE_DIGEST}"');
      expect(prepare?.run).toContain('--artifact-created-at "${OBSERVED_CREATED_AT}"');
      expect(prepare?.run).not.toContain('EVIDENCE_GZIP_B64');
      expect(unsignedUpload?.with).toMatchObject({
        overwrite: false,
        'retention-days': 1,
        'compression-level': 0,
        archive: true,
      });
      expect(signer?.run).toContain('emit_hex_output run_record_hex');
      expect(signer?.run).toContain('emit_hex_output run_bundle_hex');
      expect(signer?.run).not.toContain('upload-artifact.cjs');
      expect(signer?.run).not.toContain('INPUT_PATH=evidence-artifact/');
      expect(transferJob?.permissions).toEqual({ actions: 'read', contents: 'read' });
      expect(JSON.stringify(transferJob)).not.toContain('id-token');
      expect(JSON.stringify(transferJob)).not.toContain('${{ secrets.');
      expect(transferBuild?.run).toContain(
        'bash tools/scripts/database/materialize-walg-signed-transfer.sh',
      );
      expect(transferBuild?.env).toMatchObject({
        SIGNED_RUN_RECORD_HEX: '${{ needs.sign-evidence.outputs.run_record_hex }}',
        SIGNED_RUN_BUNDLE_HEX: '${{ needs.sign-evidence.outputs.run_bundle_hex }}',
      });
      expect(signerUpload?.uses).toContain('actions/upload-artifact@');
      expect(signerUpload?.with).toMatchObject({
        overwrite: false,
        'retention-days': 1,
        'compression-level': 0,
        archive: true,
      });
      expect(publisherDownload?.run).toContain('/actions/artifacts/${SIGNED_TRANSFER_ARTIFACT_ID}');
      expect(publisherDownload?.run).toContain('stat.S_ISLNK(entry.external_attr >> 16)');
      expect(publisherDownload?.run).toContain(`'${workflowCase.rawFile}': 8388608`);
      expect(JSON.stringify(document)).not.toContain('evidence_gzip_b64');
      expect(JSON.stringify(document)).not.toContain('signed_evidence_b64');
    }
  });

  it('renders every embedded Python heredoc as an executable shell block', () => {
    for (const workflowPath of [BACKUP_WORKFLOW_PATH, PITR_WORKFLOW_PATH]) {
      const document = readWorkflow(workflowPath);
      for (const job of Object.values(document.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          const run = step.run ?? '';
          const openingCount = (run.match(/<<'PY'/gu) ?? []).length;
          if (openingCount === 0) continue;

          const syntax = spawnSync('/bin/bash', ['--noprofile', '--norc', '-n', '-c', run], {
            encoding: 'utf8',
          });
          expect({
            step: step.name,
            workflowPath,
            status: syntax.status,
            stderr: syntax.stderr,
          }).toEqual({
            step: step.name,
            workflowPath,
            status: 0,
            stderr: '',
          });
          const blocks = [...run.matchAll(/<<'PY'\n([\s\S]*?)\nPY(?=\n|$)/gu)];
          expect({ step: step.name, workflowPath, openingCount, blocks: blocks.length }).toEqual({
            step: step.name,
            workflowPath,
            openingCount,
            blocks: openingCount,
          });
          for (const block of blocks) {
            expect(block[1]).toMatch(/^import /u);
          }
          expect(run).not.toMatch(/^\s+PY$/mu);
        }
      }
    }
  });

  it('rejects a compressed evidence bomb before any immutable artifact can be uploaded', () => {
    const workflowCases = [
      { jobName: 'backup', path: BACKUP_WORKFLOW_PATH, rawFile: 'base-backup.json' },
      { jobName: 'restore', path: PITR_WORKFLOW_PATH, rawFile: 'timestamp-pitr.json' },
    ] as const;

    for (const workflowCase of workflowCases) {
      const transportJob = readWorkflow(workflowCase.path).jobs?.[workflowCase.jobName];
      const remoteRun = transportJob?.steps?.find(
        (step) => step.id?.startsWith('remote_') === true,
      )?.run;
      expect(remoteRun).toBeDefined();
      if (remoteRun === undefined) throw new Error('remote evidence transport step is missing');

      const decompressor = extractPythonHeredoc(
        remoteRun,
        `python3 - "\${EVIDENCE_GZIP_FILE}" raw-evidence/${workflowCase.rawFile}`,
      );
      const directory = mkdtempSync(join(tmpdir(), 'aqua-walg-evidence-bomb-'));
      const compressedPath = join(directory, 'evidence.json.gz');
      const outputPath = join(directory, workflowCase.rawFile);
      try {
        const compressedBomb = gzipSync(Buffer.alloc(8_388_609, 0x78), { level: 9 });
        expect(compressedBomb.byteLength).toBeLessThan(9_437_184);
        writeFileSync(compressedPath, compressedBomb);

        const result = spawnSync(
          '/usr/bin/python3',
          ['-c', decompressor, compressedPath, outputPath],
          { encoding: 'utf8' },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/expanded .*evidence exceeds its bound/u);
        expect(readFileSync(outputPath).byteLength).toBe(8_388_608);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('rejects path traversal in every signed evidence transfer artifact', () => {
    for (const workflowPath of [BACKUP_WORKFLOW_PATH, PITR_WORKFLOW_PATH]) {
      const publisherDownload = readWorkflow(workflowPath).jobs?.['publish-evidence']?.steps?.find(
        (step) => step.name === 'Download exact signed evidence transfer artifact',
      );
      expect(publisherDownload?.run).toBeDefined();
      if (publisherDownload?.run === undefined) {
        throw new Error('signed evidence transfer download step is missing');
      }
      const extractor = extractPythonHeredoc(
        publisherDownload.run,
        'python3 - signed-evidence-transfer.zip evidence-artifact',
      );
      const directory = mkdtempSync(join(tmpdir(), 'aqua-signed-evidence-traversal-'));
      const archivePath = join(directory, 'signed-evidence-transfer.zip');
      const destination = join(directory, 'evidence-artifact');
      const escapedPath = join(directory, 'escaped.json');
      try {
        const createArchive = spawnSync(
          '/usr/bin/python3',
          [
            '-c',
            [
              'import sys, zipfile',
              "with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_STORED) as archive:",
              "    archive.writestr('run-record.json', '{}\\n')",
              "    archive.writestr('run-record.sigstore.json', '{}\\n')",
              "    archive.writestr('../escaped.json', '{}\\n')",
            ].join('\n'),
            archivePath,
          ],
          { encoding: 'utf8' },
        );
        expect(createArchive.status).toBe(0);

        const result = spawnSync('/usr/bin/python3', ['-c', extractor, archivePath, destination], {
          encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('unexpected or duplicate file set');
        expect(existsSync(destination)).toBe(false);
        expect(existsSync(escapedPath)).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('revokes stale publish-evidence authority inside every protected write boundary', () => {
    for (const workflowPath of [BACKUP_WORKFLOW_PATH, PITR_WORKFLOW_PATH]) {
      const document = readWorkflow(workflowPath);
      const prepareJob = document.jobs?.['prepare-evidence'];
      const signJob = document.jobs?.['sign-evidence'];
      const transferJob = document.jobs?.['transfer-evidence'];
      const publishJob = document.jobs?.['publish-evidence'];
      const signSteps = signJob?.steps ?? [];
      const transferSteps = transferJob?.steps ?? [];
      const publishSteps = publishJob?.steps ?? [];
      const prepareRun = prepareJob?.steps?.find(
        (step) => step.name === 'Create unsigned run-scoped records',
      )?.run;
      const signedTransferDownloadIndex = publishSteps.findIndex(
        (step) => step.name === 'Download exact signed evidence transfer artifact',
      );
      const verificationIndex = publishSteps.findIndex(
        (step) =>
          step.name === 'Verify signed records and raw artifact before protected mirror access',
      );
      const profileIndex = publishSteps.findIndex(
        (step) => step.name === 'Assert evidence publisher secret profile',
      );
      const preProfileProofIndex = publishSteps.findIndex(
        (step) => step.name === 'Prove exact current main before protected evidence profile',
      );
      const preMirrorProofIndex = publishSteps.findIndex(
        (step) => step.name === 'Re-prove exact current main before evidence mirror write',
      );
      const postMirrorProofIndex = publishSteps.findIndex(
        (step) => step.name === 'Re-prove exact current main after evidence mirror write',
      );
      const signingIndex = signSteps.findIndex(
        (step) =>
          step.name === 'Sign and self-verify exact-current-main records in one isolated boundary',
      );
      const signedUploadIndex = publishSteps.findIndex(
        (step) => step.name === 'Preserve immutable signed evidence artifact',
      );
      const mirrorIndex = publishSteps.findIndex(
        (step) => step.name === 'Mirror signed records by content digest',
      );

      expect(prepareJob?.permissions).toEqual({ actions: 'read', contents: 'read' });
      expect(prepareJob?.environment).toBeUndefined();
      expect(JSON.stringify(prepareJob)).not.toContain('${{ secrets.');
      expect(JSON.stringify(prepareJob)).not.toContain('id-token');
      expect(JSON.stringify(prepareJob)).not.toContain('cosign sign-blob');
      expect(prepareJob?.outputs).toEqual({
        artifact_id: '${{ steps.preserve_unsigned.outputs.artifact-id }}',
        artifact_digest: '${{ steps.preserve_unsigned.outputs.artifact-digest }}',
      });
      expect(JSON.stringify(prepareJob)).toContain('Pin exact signer binary');
      expect(JSON.stringify(prepareJob)).toContain('sha256sum cosign > cosign.sha256');
      expect(JSON.stringify(prepareJob)).not.toContain('walg-evidence-attestation.sha256');
      expect(JSON.stringify(prepareJob)).not.toContain('evaluate-walg-evidence.sha256');
      expect(JSON.stringify(prepareJob)).not.toContain('upload-artifact.cjs');
      expect(prepareRun).toContain('[.run_started_at, .updated_at] | @tsv');
      expect(prepareRun).toContain(
        'test "${OBSERVED_CREATED_EPOCH}" -ge "${ATTEMPT_STARTED_EPOCH}"',
      );
      expect(prepareRun).toContain(
        'test "${OBSERVED_CREATED_EPOCH}" -le "${ATTEMPT_UPDATED_EPOCH}"',
      );

      expect(signJob?.permissions).toEqual({
        actions: 'read',
        contents: 'read',
        'id-token': 'write',
      });
      expect(signJob?.environment).toBeUndefined();
      expect(signSteps).toHaveLength(1);
      expect(signSteps[0]?.uses).toBeUndefined();
      expect(signSteps[0]?.id).toBe('sign');
      expect(signJob?.if).toContain("always() && needs.prepare-evidence.result == 'success'");
      expect(signJob?.outputs).toEqual({
        run_record_hex: '${{ steps.sign.outputs.run_record_hex }}',
        run_bundle_hex: '${{ steps.sign.outputs.run_bundle_hex }}',
        evidence_attestation_hex: '${{ steps.sign.outputs.evidence_attestation_hex }}',
        evidence_bundle_hex: '${{ steps.sign.outputs.evidence_bundle_hex }}',
      });
      expect(JSON.stringify(signJob)).not.toContain('${{ secrets.');
      expect(JSON.stringify(signJob)).not.toContain('AWS_ACCESS_KEY_ID');
      expect(JSON.stringify(signJob)).not.toContain('aws s3api put-object');
      expect(JSON.stringify(signJob)).not.toContain('upload-artifact.cjs');
      expect(JSON.stringify(signJob)).not.toContain('ACTIONS_RUNTIME_TOKEN');
      expect(JSON.stringify(signJob)).not.toContain('ACTIONS_RESULTS_URL');

      expect(transferJob?.permissions).toEqual({ actions: 'read', contents: 'read' });
      expect(transferJob?.environment).toBeUndefined();
      expect(JSON.stringify(transferJob)).not.toContain('id-token');
      expect(JSON.stringify(transferJob)).not.toContain('${{ secrets.');
      expect(transferJob?.outputs).toEqual({
        artifact_id: '${{ steps.preserve_signed.outputs.artifact-id }}',
        artifact_digest: '${{ steps.preserve_signed.outputs.artifact-digest }}',
      });
      const transferUpload = transferSteps.find((step) => step.id === 'preserve_signed');
      expect(transferUpload?.uses).toContain('actions/upload-artifact@');
      expect(transferUpload?.with).toMatchObject({
        overwrite: false,
        'retention-days': 1,
        'compression-level': 0,
        archive: true,
      });

      expect(publishJob?.permissions).toEqual({ actions: 'read', contents: 'read' });
      expect(publishJob?.environment).toMatchObject({
        name: 'production-backup',
        deployment: false,
      });
      expect(JSON.stringify(publishJob)).not.toContain('id-token');
      expect(JSON.stringify(publishJob)).not.toContain('cosign sign-blob');

      expect(signedTransferDownloadIndex).toBeGreaterThan(0);
      expect(verificationIndex).toBeGreaterThan(signedTransferDownloadIndex);
      expect(signedUploadIndex).toBeGreaterThan(verificationIndex);
      expect(preProfileProofIndex).toBeGreaterThan(signedUploadIndex);
      expect(profileIndex).toBeGreaterThan(signedUploadIndex);
      expect(profileIndex).toBeGreaterThan(preProfileProofIndex);
      expect(preMirrorProofIndex).toBeGreaterThan(profileIndex);
      expect(profileIndex).toBeGreaterThan(verificationIndex);
      expect(profileIndex).toBeGreaterThan(0);
      expect(signingIndex).toBe(0);
      expect(mirrorIndex).toBeGreaterThan(preMirrorProofIndex);
      expect(postMirrorProofIndex).toBeGreaterThan(mirrorIndex);

      const profile = publishSteps[profileIndex];
      const signing = signSteps[signingIndex];
      const verification = publishSteps[verificationIndex];
      const mirror = publishSteps[mirrorIndex];
      const proofSteps = [
        publishSteps[preProfileProofIndex],
        publishSteps[preMirrorProofIndex],
        publishSteps[postMirrorProofIndex],
      ];
      for (const boundary of [signing, ...proofSteps]) {
        expect(boundary?.env?.GH_TOKEN).toBe('${{ github.token }}');
        expect(boundary?.run?.trimStart().split(/\r?\n/, 1)[0]).toBe('set +x');
        expect(boundary?.run).toContain('gh api');
        expect(boundary?.run).toContain('repos/${GITHUB_REPOSITORY}/git/ref/heads/main');
        expect(boundary?.run).toMatch(
          /test "\$\{(?:REMOTE_MAIN_SHA|remote_main_sha)\}" = "\$\{GITHUB_SHA\}"/,
        );
      }

      expect(profile?.env?.GH_TOKEN).toBeUndefined();
      expect(profile?.run).not.toContain('gh api');
      expect(mirror?.env?.GH_TOKEN).toBeUndefined();
      expect(mirror?.run).not.toContain('gh api');
      for (const step of publishSteps) {
        const environment = JSON.stringify(step.env ?? {});
        if (environment.includes('${{ github.token }}')) {
          expect(environment).not.toContain('EVIDENCE_PUBLISHER_SPACES_');
          expect(environment).not.toContain('AWS_ACCESS_KEY_ID');
        }
        if (
          environment.includes('EVIDENCE_PUBLISHER_SPACES_') ||
          environment.includes('AWS_ACCESS_KEY_ID')
        ) {
          expect(environment).not.toContain('${{ github.token }}');
        }
      }

      const profileRun = profile?.run ?? '';
      const verificationRun = verification?.run ?? '';
      expect(verification?.env?.GH_TOKEN).toBe('${{ github.token }}');
      expect(verificationRun.trimStart().split(/\r?\n/, 1)[0]).toBe('set +x');
      expect(verificationRun).toContain('cosign verify-blob');
      expect(verificationRun).toContain('--certificate-identity "${IDENTITY}"');
      expect(verificationRun).toContain(
        "--certificate-oidc-issuer 'https://token.actions.githubusercontent.com'",
      );
      expect(verificationRun).toContain('--certificate-github-workflow-sha "${GITHUB_SHA}"');
      expect(verificationRun).toContain('find evidence-artifact -mindepth 1 -maxdepth 1 ! -type f');
      expect(verificationRun).toContain('$((2 * ${#RECORDS[@]} + RAW_EVIDENCE_COUNT))');
      expect(verificationRun).toContain('walg-evidence-attestation.mjs verify-binding');
      expect(verificationRun).toContain(
        'test "${OBSERVED_RAW_CREATED_AT}" = "${RAW_ARTIFACT_CREATED_AT}"',
      );
      expect(verificationRun).toContain('[.run_started_at, .updated_at] | @tsv');
      expect(verificationRun).toContain(
        'assert_current_attempt_artifact_time "${OBSERVED_RAW_CREATED_AT}"',
      );
      expect(verificationRun).toContain('--artifact-created-at "${RAW_ARTIFACT_CREATED_AT}"');
      expect(verificationRun).toContain('cmp -s raw-evidence-check/');
      expect(profileRun).toContain('bash tools/scripts/database/assert-backup-secrets.sh');
      expect(profileRun).toContain('evidence publisher preflight refuses ${forbidden_authority}');
      expect(signing?.run).toMatch(
        /assert_exact_current_main \|\| exit[\s\S]*?ACTIONS_ID_TOKEN_REQUEST_TOKEN="\$\{oidc_request_token_material\}"[\s\S]*?evidence-artifact\/cosign sign-blob --yes/u,
      );
      expect(signing?.run).toContain('AQUA_SIGNER_SANITIZED=github-oidc-read-only-v1');
      expect(signing?.run).toContain('exec /usr/bin/env -i');
      expect(signing?.run).toContain('/bin/bash --noprofile --norc -e -u -o pipefail');
      expect(signing?.run).toContain('unset GH_TOKEN GITHUB_TOKEN GITHUB_OUTPUT');
      expect(signing?.run).toContain(
        'unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL',
      );
      expect(signing?.run).toContain('GH_TOKEN="${github_token_material}" gh api');
      expect(signing?.run).toContain(
        'ACTIONS_ID_TOKEN_REQUEST_TOKEN="${oidc_request_token_material}"',
      );
      expect(signing?.run).toContain('ACTIONS_ID_TOKEN_REQUEST_URL="${oidc_request_url_material}"');
      expect(signing?.run).toContain('[.run_started_at, .updated_at] | @tsv');
      expect(signing?.run).toContain(
        'assert_current_attempt_artifact_time "${OBSERVED_RAW_CREATED_AT}"',
      );
      expect(signing?.run).toContain('python3 - unsigned-evidence.zip evidence-artifact');
      expect(signing?.run).toContain('set(names) not in (minimal, full)');
      expect(signing?.run).toContain('stat.S_ISLNK(unix_mode)');
      expect(signing?.run).toContain('chmod 0555 evidence-artifact/cosign');
      expect(signing?.run).toContain('fetch_exact_signer_tool');
      expect(signing?.run).toContain(
        'repos/${GITHUB_REPOSITORY}/contents/${REPOSITORY_PATH}?ref=${GITHUB_SHA}',
      );
      expect(signing?.run).toContain('EXPECTED_SHA256="${expected_sha256}"');
      expect(signing?.run).toContain(
        "test -z \"$(find evidence-artifact -maxdepth 1 -type f -name '*.mjs'",
      );
      expect(signing?.run).toContain(
        'run_trusted_node --check trusted-tools/walg-evidence-attestation.mjs',
      );
      expect(signing?.run).toContain('NODE_BIN="${SIGNER_NODE_BIN}"');
      expect(signing?.run).toContain('node_bin_material=${NODE_BIN:?NODE_BIN is required}');
      expect(signing?.run).toContain(sha256(EVIDENCE_ATTESTATION_TOOL_PATH));
      expect(signing?.run).toContain(
        'run_trusted_node trusted-tools/walg-evidence-attestation.mjs verify-local-run',
      );
      expect(signing?.run).toContain('--job-result "${');
      expect(signing?.run).toContain('--mode ');
      expect(signing?.run).toContain(
        'run_trusted_node trusted-tools/walg-evidence-attestation.mjs verify-binding',
      );
      expect(signing?.run).not.toContain(
        'node tools/scripts/database/walg-evidence-attestation.mjs',
      );
      expect(signing?.run).toContain('walg-evidence-attestation.mjs verify-binding');
      expect(signing?.run).toContain('cmp -s raw-evidence-check/');
      expect(signing?.run).not.toContain('SIGNED_EVIDENCE_B64');
      expect(signing?.run).toContain(
        'c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74',
      );
      expect(signing?.run).toContain(
        'github_output_path=${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}',
      );
      expect(signing?.run).toContain('emit_hex_output run_record_hex');
      expect(signing?.run).toContain('emit_hex_output run_bundle_hex');
      expect(signing?.run).toContain('test "${BUNDLE_BYTES}" -le 49152');
      expect(signing?.run).not.toContain('upload-artifact.cjs');
      const transferDownloadRun = publishSteps[signedTransferDownloadIndex]?.run ?? '';
      expect(transferDownloadRun).toContain("with zipfile.ZipFile(archive_path, 'r')");
      expect(transferDownloadRun).toContain('stat.S_ISLNK(entry.external_attr >> 16)');
      expect(transferDownloadRun).toContain('os.O_EXCL | os.O_NOFOLLOW');
      expect(transferDownloadRun).not.toContain('base64');
      expect(mirror?.run).toContain('set +a');
      expect(mirror?.run).toContain(
        'unset SPACES_ENDPOINT EVIDENCE_SPACES_BUCKET AWS_ACCESS_KEY_ID',
      );
      expect(mirror?.run).toContain('unset AWS_SECRET_ACCESS_KEY AWS_REGION AWS_DEFAULT_REGION');
      expect(mirror?.run).toMatch(
        /run_evidence_aws\(\) \{[\s\S]*?AWS_ACCESS_KEY_ID="\$\{publisher_access_key_material\}"[\s\S]*?aws "\$@"\n\}/u,
      );
      expect(mirror?.run).not.toContain('assert_exact_current_main');
      expect(mirror?.run).not.toContain('list-objects-v2');
      expect(mirror?.run).toContain('s3api list-object-versions');
      expect(mirror?.run).toContain('run_evidence_aws s3api put-object');
      expect(mirror?.run).not.toContain('--if-none-match');
      expect(mirror?.run).toContain('run_evidence_aws s3api get-object');
      expect(mirror?.run).toContain('"--version-id=${RECORD_VERSION_ID}"');
      expect(mirror?.run).toContain('cmp -s "${RECORD}" "${MIRROR_CHECK_FILE}"');
      expect(mirror?.run).not.toMatch(/(?:^|\n)\s*aws s3api/u);
    }
  });

  it('isolates signer credentials and revokes stale runs before artifact publication', () => {
    const currentMain = 'a'.repeat(40);
    const staleMain = 'b'.repeat(40);

    for (const workflowPath of [BACKUP_WORKFLOW_PATH, PITR_WORKFLOW_PATH]) {
      const document = readWorkflow(workflowPath);
      const signJob = document.jobs?.['sign-evidence'];
      const transferJob = document.jobs?.['transfer-evidence'];
      const signerRun = signJob?.steps?.find((step) => step.id === 'sign')?.run;
      const publishSteps = document.jobs?.['publish-evidence']?.steps ?? [];
      const transferDownload = publishSteps.find(
        (step) => step.name === 'Download exact signed evidence transfer artifact',
      );
      const finalUpload = publishSteps.find(
        (step) => step.name === 'Preserve immutable signed evidence artifact',
      );
      expect(signerRun).toBeDefined();
      if (signerRun === undefined) throw new Error('isolated signer run block is missing');

      expect(signJob?.environment).toBeUndefined();
      expect(JSON.stringify(signJob)).not.toContain('${{ secrets.');
      expect(JSON.stringify(signJob)).not.toContain('AWS_ACCESS_KEY_ID');
      expect(signerRun).toContain('exec /usr/bin/env -i');
      expect(signerRun).toContain('AQUA_SIGNER_SANITIZED=github-oidc-read-only-v1');
      expect(signerRun).toContain('unset GH_TOKEN GITHUB_TOKEN GITHUB_OUTPUT');
      expect(signerRun).toContain(
        'unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL',
      );
      expect(signerRun).toContain('assert_exact_current_main || exit');
      expect(signerRun).toContain('download_bounded_github_artifact_zip');
      expect(signerRun).toContain('"${RAW_ARTIFACT_ID}" raw-evidence.zip 9437184');
      expect(signerRun).toContain('cmp -s raw-evidence-check/');
      expect(signerRun).toContain('walg-evidence-attestation.mjs verify-binding');
      expect(signerRun).toContain(
        'ACTIONS_ID_TOKEN_REQUEST_TOKEN="${oidc_request_token_material}"',
      );
      expect(signerRun).toContain('evidence-artifact/cosign sign-blob --yes');
      expect(signerRun).not.toContain('SIGNED_EVIDENCE_B64');
      expect(signJob?.steps).toHaveLength(1);
      expect(signJob?.steps?.[0]?.uses).toBeUndefined();
      expect(signJob?.outputs).toEqual({
        run_record_hex: '${{ steps.sign.outputs.run_record_hex }}',
        run_bundle_hex: '${{ steps.sign.outputs.run_bundle_hex }}',
        evidence_attestation_hex: '${{ steps.sign.outputs.evidence_attestation_hex }}',
        evidence_bundle_hex: '${{ steps.sign.outputs.evidence_bundle_hex }}',
      });
      expect(signerRun).toContain('emit_hex_output run_record_hex');
      expect(signerRun).not.toContain('ACTIONS_RUNTIME_TOKEN');
      expect(signerRun).not.toContain('ACTIONS_RESULTS_URL');
      expect(signerRun).not.toContain('upload-artifact.cjs');
      expect(transferJob?.permissions).toEqual({ actions: 'read', contents: 'read' });
      expect(JSON.stringify(transferJob)).not.toContain('id-token');
      expect(JSON.stringify(transferJob)).not.toContain('${{ secrets.');
      expect(transferJob?.steps?.find((step) => step.id === 'preserve_signed')?.uses).toContain(
        'actions/upload-artifact@',
      );
      expect(transferDownload?.env).toMatchObject({
        GH_TOKEN: '${{ github.token }}',
        SIGNED_TRANSFER_ARTIFACT_ID: '${{ needs.transfer-evidence.outputs.artifact_id }}',
        SIGNED_TRANSFER_ARTIFACT_DIGEST: '${{ needs.transfer-evidence.outputs.artifact_digest }}',
      });
      expect(transferDownload?.run).toContain(
        'test "${OBSERVED_ID}" = "${SIGNED_TRANSFER_ARTIFACT_ID}"',
      );
      expect(transferDownload?.run).toContain('test "${OBSERVED_HEAD_SHA}" = "${GITHUB_SHA}"');
      expect(transferDownload?.run).toContain(
        '/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}',
      );
      expect(transferDownload?.run).toContain('.size_in_bytes, .created_at');
      expect(transferDownload?.run).toContain(
        'assert_current_attempt_artifact_time "${OBSERVED_CREATED_AT}"',
      );
      expect(transferDownload?.run).toContain('/usr/bin/head -c 10485761');
      expect(transferDownload?.run).toContain('os.O_EXCL | os.O_NOFOLLOW');
      expect(transferDownload?.run).toContain('stat.S_ISLNK(entry.external_attr >> 16)');
      expect(finalUpload?.with).toMatchObject({
        overwrite: false,
        'retention-days': 90,
        'compression-level': 0,
        archive: true,
      });

      const assertFunction = extractShellFunction(signerRun, 'assert_exact_current_main');
      const directory = mkdtempSync(join(tmpdir(), 'aqua-signer-stale-main-'));
      try {
        writeExecutable(
          join(directory, 'gh'),
          [
            'test "${GH_TOKEN}" = signer-token',
            'if [ "${RETURN_STALE}" = true ]; then',
            `  printf '%s\\n' '${staleMain}'`,
            'else',
            `  printf '%s\\n' '${currentMain}'`,
            'fi',
          ].join('\n'),
        );
        const probe = [
          assertFunction,
          'github_token_material=signer-token',
          `GITHUB_SHA=${currentMain}`,
          'GITHUB_REPOSITORY=aqua/example',
          'assert_exact_current_main',
        ].join('\n');
        const execute = (stale: boolean) =>
          spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', probe], {
            encoding: 'utf8',
            env: { PATH: `${directory}:/usr/bin:/bin`, RETURN_STALE: String(stale) },
          });
        expect(execute(false).status).toBe(0);
        expect(execute(true).status).not.toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('fetches exact-SHA signer validators in a GH-only child and executes them without credentials', () => {
    const mainSha = 'a'.repeat(40);
    const toolBytes = 'export const exactShaAuthority = true;\n';
    const toolSha256 = createHash('sha256').update(toolBytes).digest('hex');
    const credentialNames = [
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_OUTPUT',
    ];

    for (const workflowPath of [BACKUP_WORKFLOW_PATH, PITR_WORKFLOW_PATH]) {
      const signerRun = readWorkflow(workflowPath).jobs?.['sign-evidence']?.steps?.find(
        (step) => step.id === 'sign',
      )?.run;
      expect(signerRun).toBeDefined();
      if (signerRun === undefined) throw new Error('isolated signer run block is missing');

      const fetchFunction = extractShellFunction(signerRun, 'fetch_exact_signer_tool');
      const trustedNodeFunction = extractShellFunction(signerRun, 'run_trusted_node');
      const directory = mkdtempSync(join(tmpdir(), 'aqua-signer-exact-sha-tools-'));
      try {
        const fakeGh = join(directory, 'gh');
        const fakeNode = join(directory, 'node');
        const fetchedTool = join(directory, 'evaluate-walg-evidence.mjs');
        const nodeLog = join(directory, 'node.log');
        writeExecutable(
          fakeGh,
          [
            'test "${GH_TOKEN}" = exact-sha-gh-token',
            ...credentialNames.map((name) => `test "\${${name}+x}" != x`),
            'test "$1" = api',
            'case "$*" in',
            `  *"repos/aqua/example/contents/tools/scripts/database/evaluate-walg-evidence.mjs?ref=${mainSha}"*) ;;`,
            '  *) exit 91 ;;',
            'esac',
            `printf '%s' '${toolBytes.replace(/'/gu, `'\\''`)}'`,
          ].join('\n'),
        );
        writeExecutable(
          fakeNode,
          [
            'test "${GH_TOKEN+x}" != x',
            'test "${GITHUB_TOKEN+x}" != x',
            ...credentialNames.map((name) => `test "\${${name}+x}" != x`),
            `printf '%s\\n' "$*" >> '${nodeLog}'`,
          ].join('\n'),
        );

        const probe = [
          fetchFunction,
          trustedNodeFunction,
          'github_token_material=exact-sha-gh-token',
          `gh_bin_material='${fakeGh}'`,
          `node_bin_material='${fakeNode}'`,
          'GITHUB_REPOSITORY=aqua/example',
          `GITHUB_SHA=${mainSha}`,
          `fetch_exact_signer_tool tools/scripts/database/evaluate-walg-evidence.mjs '${fetchedTool}' ${toolSha256} 1024`,
          `run_trusted_node --check '${fetchedTool}'`,
          `run_trusted_node '${fetchedTool}' --evidence-dir evidence`,
        ].join('\n');
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-c', probe], {
          encoding: 'utf8',
          env: {
            PATH: '/usr/bin:/bin',
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-token-sentinel',
            ACTIONS_ID_TOKEN_REQUEST_URL: 'oidc-url-sentinel',
            AWS_ACCESS_KEY_ID: 'aws-id-sentinel',
            AWS_SECRET_ACCESS_KEY: 'aws-key-sentinel',
            GITHUB_OUTPUT: 'github-output-sentinel',
          },
        });
        expect({ stderr: result.stderr, status: result.status }).toEqual({ stderr: '', status: 0 });
        expect(read(fetchedTool)).toBe(toolBytes);
        expect(read(nodeLog)).toBe(
          `--check ${fetchedTool}\n${fetchedTool} --evidence-dir evidence\n`,
        );
        expect(`${result.stdout}${result.stderr}`).not.toContain('sentinel');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('bounds all four signer and publisher raw ZIP downloads before disk growth', () => {
    const rawDownloadRuns = [BACKUP_WORKFLOW_PATH, PITR_WORKFLOW_PATH].flatMap((workflowPath) => {
      const jobs = readWorkflow(workflowPath).jobs ?? {};
      const signer = jobs['sign-evidence']?.steps?.find((step) => step.id === 'sign')?.run;
      const publisher = jobs['publish-evidence']?.steps?.find(
        (step) =>
          step.name === 'Verify signed records and raw artifact before protected mirror access',
      )?.run;
      return [signer, publisher];
    });
    expect(rawDownloadRuns).toHaveLength(4);

    for (const [index, run] of rawDownloadRuns.entries()) {
      expect(run).toBeDefined();
      if (run === undefined) throw new Error('raw artifact download run block is missing');
      expect(run).toContain('"${RAW_ARTIFACT_ID}" raw-evidence.zip 9437184');
      const boundedDownload = extractShellFunction(run, 'download_bounded_github_artifact_zip');
      const directory = mkdtempSync(join(tmpdir(), `aqua-raw-zip-bound-${index}-`));
      try {
        const fakeGh = join(directory, 'gh');
        const output = join(directory, 'raw-evidence.zip');
        writeExecutable(
          fakeGh,
          [
            'test "${GH_TOKEN}" = raw-download-token',
            'test "$1" = api',
            '/usr/bin/head -c "${FAKE_BYTES}" /dev/zero',
          ].join('\n'),
        );
        const probe = [
          boundedDownload,
          'github_token_material=raw-download-token',
          `gh_bin_material='${fakeGh}'`,
          'GITHUB_REPOSITORY=aqua/example',
          `download_bounded_github_artifact_zip 7 '${output}' 4096`,
        ].join('\n');
        const execute = (bytes: number) =>
          spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', probe], {
            encoding: 'utf8',
            env: { PATH: '/usr/bin:/bin', FAKE_BYTES: String(bytes) },
          });

        const bounded = execute(4096);
        expect({ stderr: bounded.stderr, status: bounded.status }).toEqual({
          stderr: '',
          status: 0,
        });
        expect(readFileSync(output).byteLength).toBe(4096);
        rmSync(output);

        const oversized = execute(4097);
        expect(oversized.status).not.toBe(0);
        expect(existsSync(output)).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('moves bounded signed records through an OIDC-free transfer materializer', () => {
    const materializer = read(SIGNED_TRANSFER_MATERIALIZER_PATH);

    expect(materializer).toContain("re.fullmatch(r'[0-9a-f]+', value)");
    expect(materializer).toContain("('SIGNED_RUN_RECORD_HEX', 'run-record.json', 16384, True)");
    expect(materializer).toContain(
      "('SIGNED_RUN_BUNDLE_HEX', 'run-record.sigstore.json', 49152, True)",
    );
    expect(materializer).toContain('os.O_EXCL | os.O_NOFOLLOW');
    expect(materializer).toContain('node "${ATTESTATION_TOOL}" verify-local-run');
    expect(materializer).toContain('walg-evidence-attestation.mjs');
    expect(materializer).toContain('verify-binding');
    expect(materializer).toContain('[ "${OBSERVED_CREATED_AT}" = "${RAW_ARTIFACT_CREATED_AT}" ]');
    expect(materializer).toContain('--artifact-created-at "${RAW_ARTIFACT_CREATED_AT}"');
    expect(materializer).toContain('/usr/bin/head -c 9437185');
    expect(materializer).toContain(
      'c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74',
    );
    expect(materializer).toContain(sha256(EVIDENCE_ATTESTATION_TOOL_PATH));
    expect(materializer).toContain(sha256(EVIDENCE_EVALUATOR_TOOL_PATH));
    expect(materializer).not.toContain('ACTIONS_ID_TOKEN_REQUEST_');
    expect(materializer).not.toContain('AWS_ACCESS_KEY_ID');

    for (const workflowPath of [BACKUP_WORKFLOW_PATH, PITR_WORKFLOW_PATH]) {
      const document = readWorkflow(workflowPath);
      const signJob = document.jobs?.['sign-evidence'];
      const transferJob = document.jobs?.['transfer-evidence'];
      expect(signJob?.permissions?.['id-token']).toBe('write');
      expect(JSON.stringify(signJob)).not.toContain('actions/upload-artifact@');
      expect(JSON.stringify(signJob)).not.toContain('ACTIONS_RUNTIME_TOKEN');
      expect(transferJob?.permissions?.['id-token']).toBeUndefined();
      expect(JSON.stringify(transferJob)).not.toContain('ACTIONS_ID_TOKEN_REQUEST_');
      expect(JSON.stringify(transferJob)).not.toContain('${{ secrets.');
      for (const job of Object.values(document.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.run?.includes('raw-evidence.zip 9437184') === true) {
            expect(step.run).toContain('download_bounded_github_artifact_zip');
            expect(step.run).toContain('/usr/bin/head -c "$((max_bytes + 1))"');
          }
        }
      }
    }
  });

  const evidenceAuthorityChannels = [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'AWS_SESSION_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RUNTIME_URL',
    'ACTIONS_RESULTS_URL',
    'ACTIONS_CACHE_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'GITHUB_ENV',
    'GITHUB_OUTPUT',
    'GITHUB_PATH',
    'GITHUB_STATE',
    'GITHUB_STEP_SUMMARY',
  ] as const;

  it('keeps GitHub proof authority outside the evidence profile validator process', () => {
    const profileSentinel = 'AQUA_PROFILE_SPACES_SENTINEL_c44c2b7d';

    for (const workflowPath of [BACKUP_WORKFLOW_PATH, PITR_WORKFLOW_PATH]) {
      const publishSteps = readWorkflow(workflowPath).jobs?.['publish-evidence']?.steps ?? [];
      const proof = publishSteps.find(
        (step) => step.name === 'Prove exact current main before protected evidence profile',
      );
      const profile = publishSteps.find(
        (step) => step.name === 'Assert evidence publisher secret profile',
      );
      expect(proof?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
      expect(JSON.stringify(proof)).not.toContain('EVIDENCE_PUBLISHER_SPACES_');
      expect(profile?.env?.GH_TOKEN).toBeUndefined();
      expect(JSON.stringify(profile)).not.toContain('${{ github.token }}');
      const profileRun = profile?.run;
      expect(profileRun).toBeDefined();
      if (profileRun === undefined) throw new Error('evidence profile run block is missing');
      expect(profileRun).toContain('exec /usr/bin/env -i');
      expect(profileRun).toContain('AQUA_EVIDENCE_PUBLISHER_PREFLIGHT_SANITIZED=aws-write-only-v1');
      expect(profileRun).toContain('/bin/bash --noprofile --norc -e -u -o pipefail');
      for (const forbiddenAuthority of evidenceAuthorityChannels) {
        expect(profileRun).toContain(forbiddenAuthority);
      }

      const directory = mkdtempSync(join(tmpdir(), 'aqua-evidence-profile-authority-'));
      const callLog = join(directory, 'calls.log');
      try {
        writeFileSync(callLog, '');
        writeExecutable(
          join(directory, 'bash'),
          [
            ...evidenceAuthorityChannels.map((authority) => `test "\${${authority}+x}" != x`),
            `test "\${BACKUP_SECRET_PROFILE:-}" = '${profileSentinel}'`,
            `test "\${SPACES_ENDPOINT:-}" = '${profileSentinel}'`,
            `test "\${EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY:-}" = '${profileSentinel}'`,
            'printf \'validator\\n\' >> "${CALL_LOG}"',
          ].join('\n'),
        );

        const execute = (extraEnvironment: Record<string, string> = {}) => {
          writeFileSync(callLog, '');
          return spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', profileRun], {
            cwd: directory,
            encoding: 'utf8',
            env: {
              AQUA_EVIDENCE_PUBLISHER_PREFLIGHT_SANITIZED: 'aws-write-only-v1',
              PATH: `${directory}:/usr/bin:/bin`,
              BACKUP_SECRET_PROFILE: profileSentinel,
              SPACES_ENDPOINT: profileSentinel,
              SPACES_REGION: profileSentinel,
              EVIDENCE_SPACES_BUCKET: profileSentinel,
              EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID: profileSentinel,
              EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY: profileSentinel,
              CALL_LOG: callLog,
              ...extraEnvironment,
            },
          });
        };

        const result = execute();
        expect({ stderr: result.stderr, status: result.status }).toEqual({ stderr: '', status: 0 });
        expect(read(callLog)).toBe('validator\n');
        expect(`${result.stdout}${result.stderr}`).not.toContain(profileSentinel);

        for (const forbiddenAuthority of evidenceAuthorityChannels) {
          const rejected = execute({ [forbiddenAuthority]: profileSentinel });
          expect(rejected.status).toBe(2);
          expect(read(callLog)).toBe('');
          expect(`${rejected.stdout}${rejected.stderr}`).toContain(
            `evidence publisher preflight refuses ${forbiddenAuthority}`,
          );
          expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(profileSentinel);
        }

        const outerScript = join(directory, 'publisher-preflight-step.sh');
        writeExecutable(outerScript, profileRun);
        const sanitized = spawnSync('/bin/bash', ['--noprofile', '--norc', outerScript], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            PATH: `${directory}:/usr/bin:/bin`,
            BACKUP_SECRET_PROFILE: 'evidence-publisher',
            SPACES_ENDPOINT: profileSentinel,
            SPACES_REGION: profileSentinel,
            EVIDENCE_SPACES_BUCKET: profileSentinel,
            EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID: profileSentinel,
            EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY: profileSentinel,
            ACTIONS_RUNTIME_TOKEN: profileSentinel,
          },
        });
        expect({ stderr: sanitized.stderr, status: sanitized.status }).toEqual({
          stderr: '',
          status: 0,
        });
        expect(`${sanitized.stdout}${sanitized.stderr}`).not.toContain(profileSentinel);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('keeps the content-addressed mirror writer in an AWS-only process boundary', () => {
    const sentinel = 'AQUA_EVIDENCE_WRITE_SENTINEL_42d5968f';

    for (const workflowPath of [BACKUP_WORKFLOW_PATH, PITR_WORKFLOW_PATH]) {
      const mirror = readWorkflow(workflowPath).jobs?.['publish-evidence']?.steps?.find(
        (step) => step.name === 'Mirror signed records by content digest',
      );
      expect(mirror?.env?.GH_TOKEN).toBeUndefined();
      expect(JSON.stringify(mirror)).not.toContain('${{ github.token }}');
      expect(mirror?.run).not.toContain('gh api');
      const mirrorRun = mirror?.run;
      expect(mirrorRun).toBeDefined();
      if (mirrorRun === undefined) throw new Error('evidence mirror run block is missing');
      expect(mirrorRun).toContain('exec /usr/bin/env -i');
      expect(mirrorRun).toContain('AQUA_EVIDENCE_PUBLISHER_SANITIZED=aws-write-only-v1');
      expect(mirrorRun).toContain('/bin/bash --noprofile --norc -e -u -o pipefail');
      expect(mirrorRun).toContain('--max-keys 2');
      expect(mirrorRun).toContain('--no-paginate');
      expect(mirrorRun).toContain('head -c 65537');
      expect(mirrorRun).toContain('"--version-id=${RECORD_VERSION_ID}"');
      expect(mirrorRun).not.toContain('--version-id "${RECORD_VERSION_ID}"');
      expect(mirrorRun).toContain('FINAL_VERSIONING_STATUS');
      expect(mirrorRun).toContain('versions-final.json');
      for (const forbiddenAuthority of evidenceAuthorityChannels) {
        expect(mirrorRun).toContain(forbiddenAuthority);
      }

      const directory = mkdtempSync(join(tmpdir(), 'aqua-evidence-mirror-authority-'));
      try {
        const fakeBin = join(directory, 'bin');
        const evidenceDirectory = join(directory, 'evidence-artifact');
        const callLog = join(directory, 'calls.log');
        const versionCallState = join(directory, 'version-call-state');
        const versioningCallState = join(directory, 'versioning-call-state');
        const record = join(evidenceDirectory, 'run-record.json');
        mkdirSync(fakeBin, { recursive: true });
        mkdirSync(evidenceDirectory, { recursive: true });
        writeFileSync(record, '{"schema_version":1}\n');
        writeFileSync(callLog, '');
        writeExecutable(
          join(fakeBin, 'aws'),
          [
            ...evidenceAuthorityChannels.map((authority) => `test "\${${authority}+x}" != x`),
            `test "\${AWS_ACCESS_KEY_ID:-}" = '${sentinel}'`,
            `test "\${AWS_SECRET_ACCESS_KEY:-}" = '${sentinel}'`,
            `test "\${AWS_REGION:-}" = '${sentinel}'`,
            `test "\${AWS_DEFAULT_REGION:-}" = '${sentinel}'`,
            'printf \'aws:%s\\n\' "${2:-missing}" >> "${CALL_LOG}"',
            'case "${2:-}" in',
            '  get-bucket-versioning)',
            '    versioning_call=0',
            '    if [ -f "${VERSIONING_CALL_STATE}" ]; then read -r versioning_call < "${VERSIONING_CALL_STATE}"; fi',
            '    versioning_call=$((versioning_call + 1))',
            '    printf \'%s\\n\' "${versioning_call}" > "${VERSIONING_CALL_STATE}"',
            '    if [ "${MIRROR_MODE}" = suspension-after-read ] && [ "${versioning_call}" -ge 2 ]; then',
            "      printf 'Suspended\\n'",
            '    else',
            "      printf 'Enabled\\n'",
            '    fi',
            '    ;;',
            '  list-object-versions)',
            '    max_keys=false',
            '    no_paginate=false',
            '    previous=',
            '    for argument in "$@"; do',
            '      if [ "${previous}" = --max-keys ]; then test "${argument}" = 2; max_keys=true; fi',
            '      if [ "${argument}" = --no-paginate ]; then no_paginate=true; fi',
            '      previous=${argument}',
            '    done',
            '    test "${max_keys}" = true',
            '    test "${no_paginate}" = true',
            '    version_call=0',
            '    if [ -f "${VERSION_CALL_STATE}" ]; then read -r version_call < "${VERSION_CALL_STATE}"; fi',
            '    version_call=$((version_call + 1))',
            '    printf \'%s\\n\' "${version_call}" > "${VERSION_CALL_STATE}"',
            '    case "${MIRROR_MODE}:${version_call}" in',
            '      first-write:1|race:1)',
            '        printf \'{"Versions":[],"DeleteMarkers":[],"IsTruncated":false}\\n\'',
            '        ;;',
            '      race:2|duplicate-version:*)',
            '        printf \'{"Versions":[{"Key":"%s","VersionId":"v2","IsLatest":true},{"Key":"%s","VersionId":"v1","IsLatest":false}],"DeleteMarkers":[],"IsTruncated":false}\\n\' "${EXPECTED_KEY}" "${EXPECTED_KEY}"',
            '        ;;',
            '      race-after-read:3)',
            '        printf \'{"Versions":[{"Key":"%s","VersionId":"v2","IsLatest":true},{"Key":"%s","VersionId":"%s","IsLatest":false}],"DeleteMarkers":[],"IsTruncated":false}\\n\' "${EXPECTED_KEY}" "${EXPECTED_KEY}" "${EXPECTED_VERSION_ID}"',
            '        ;;',
            '      truncated:*)',
            '        printf \'{"Versions":[{"Key":"%s","VersionId":"%s","IsLatest":true}],"DeleteMarkers":[],"IsTruncated":true,"NextKeyMarker":"next"}\\n\' "${EXPECTED_KEY}" "${EXPECTED_VERSION_ID}"',
            '        ;;',
            '      continuation:*)',
            '        printf \'{"Versions":[{"Key":"%s","VersionId":"%s","IsLatest":true}],"DeleteMarkers":[],"IsTruncated":false,"NextVersionIdMarker":"next"}\\n\' "${EXPECTED_KEY}" "${EXPECTED_VERSION_ID}"',
            '        ;;',
            '      oversized-snapshot:*)',
            '        /usr/bin/python3 -c \'print("x" * 70000)\'',
            '        ;;',
            '      *)',
            '        printf \'{"Versions":[{"Key":"%s","VersionId":"%s","IsLatest":true}],"DeleteMarkers":[],"IsTruncated":false}\\n\' "${EXPECTED_KEY}" "${EXPECTED_VERSION_ID}"',
            '        ;;',
            '    esac',
            '    ;;',
            '  put-object)',
            '    case "${MIRROR_MODE}" in first-write|race) ;; *) exit 96 ;; esac',
            '    ;;',
            '  head-object)',
            '    pinned=false',
            '    for argument in "$@"; do',
            '      case "${argument}" in',
            '        --version-id=*) test "${argument#--version-id=}" = "${EXPECTED_VERSION_ID}"; pinned=true ;;',
            '        --version-id) exit 93 ;;',
            '      esac',
            '    done',
            '    test "${pinned}" = true',
            '    if [ "${MIRROR_MODE}" = preexisting-conflict ]; then',
            "      printf '%s\\t%s\\n' \"${EXPECTED_REMOTE_BYTES}\" '${'0'.repeat(64)}'",
            '    else',
            '      printf \'%s\\t%s\\n\' "${EXPECTED_REMOTE_BYTES}" "${EXPECTED_REMOTE_SHA256}"',
            '    fi',
            '    ;;',
            '  get-object)',
            '    pinned=false',
            '    for argument in "$@"; do',
            '      case "${argument}" in',
            '        --version-id=*) test "${argument#--version-id=}" = "${EXPECTED_VERSION_ID}"; pinned=true ;;',
            '        --version-id) exit 93 ;;',
            '      esac',
            '    done',
            '    test "${pinned}" = true',
            '    output_path=${!#}',
            '    /usr/bin/cp "${MIRROR_SOURCE}" "${output_path}"',
            "    printf '{}\\n'",
            '    ;;',
            '  *) exit 98 ;;',
            'esac',
          ].join('\n'),
        );

        const digestResult = spawnSync('/usr/bin/sha256sum', [record], { encoding: 'utf8' });
        expect(digestResult.status).toBe(0);
        const expectedDigest = digestResult.stdout.split(/\s+/u)[0] ?? '';
        const expectedKey = `wal-g-evidence/v3/sha256/${expectedDigest}/run-record.json`;
        const documentedOpaqueVersionId =
          '3sL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nr8X8gdRQBpUMLUo';
        const execute = (mode: string, extraEnvironment: Record<string, string> = {}) => {
          writeFileSync(callLog, '');
          rmSync(versionCallState, { force: true });
          rmSync(versioningCallState, { force: true });
          const expectedVersionId =
            mode === 'max-multibyte-version'
              ? 'é'.repeat(512)
              : mode === 'oversized-version'
                ? `${'é'.repeat(512)}v`
                : mode === 'leading-hyphen-version'
                  ? '-opaque/version+id'
                  : documentedOpaqueVersionId;
          return spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', mirrorRun], {
            cwd: directory,
            encoding: 'utf8',
            env: {
              AQUA_EVIDENCE_PUBLISHER_SANITIZED: 'aws-write-only-v1',
              PATH: `${fakeBin}:/usr/bin:/bin`,
              SPACES_ENDPOINT: sentinel,
              EVIDENCE_SPACES_BUCKET: sentinel,
              AWS_ACCESS_KEY_ID: sentinel,
              AWS_SECRET_ACCESS_KEY: sentinel,
              AWS_REGION: sentinel,
              AWS_DEFAULT_REGION: sentinel,
              GITHUB_RUN_ID: '101',
              GITHUB_RUN_ATTEMPT: '1',
              CALL_LOG: callLog,
              VERSION_CALL_STATE: versionCallState,
              VERSIONING_CALL_STATE: versioningCallState,
              EXPECTED_KEY: expectedKey,
              EXPECTED_VERSION_ID: expectedVersionId,
              EXPECTED_REMOTE_BYTES: String(Buffer.byteLength('{"schema_version":1}\n')),
              EXPECTED_REMOTE_SHA256: expectedDigest,
              MIRROR_SOURCE: record,
              MIRROR_MODE: mode,
              ...extraEnvironment,
            },
          });
        };
        for (const mode of [
          'first-write',
          'exact-replay',
          'leading-hyphen-version',
          'max-multibyte-version',
        ]) {
          const success = execute(mode);
          expect({ mode, stderr: success.stderr, status: success.status }).toEqual({
            mode,
            stderr: '',
            status: 0,
          });
          const expectedCalls =
            mode === 'first-write'
              ? 'aws:get-bucket-versioning\naws:list-object-versions\naws:put-object\naws:list-object-versions\naws:head-object\naws:get-object\naws:get-bucket-versioning\naws:list-object-versions\n'
              : 'aws:get-bucket-versioning\naws:list-object-versions\naws:list-object-versions\naws:head-object\naws:get-object\naws:get-bucket-versioning\naws:list-object-versions\n';
          expect(read(callLog)).toBe(expectedCalls);
          expect(`${success.stdout}${success.stderr}`).not.toContain(sentinel);
        }

        for (const mode of [
          'preexisting-conflict',
          'race',
          'duplicate-version',
          'oversized-version',
          'race-after-read',
          'suspension-after-read',
          'truncated',
          'continuation',
          'oversized-snapshot',
        ]) {
          const failure = execute(mode);
          expect(failure.status).not.toBe(0);
          expect(`${failure.stdout}${failure.stderr}`).not.toContain(sentinel);
        }

        for (const forbiddenAuthority of evidenceAuthorityChannels) {
          const rejected = execute('exact-replay', { [forbiddenAuthority]: sentinel });
          expect(rejected.status).toBe(2);
          expect(read(callLog)).toBe('');
          expect(`${rejected.stdout}${rejected.stderr}`).toContain(
            `evidence mirror publisher refuses ${forbiddenAuthority}`,
          );
          expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(sentinel);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('makes closure re-prove bounded immutable mirror versions after pinned reads', () => {
    const sentinel = 'AQUA_EVIDENCE_READ_SENTINEL_76de3a90';
    const directory = mkdtempSync(join(tmpdir(), 'aqua-evidence-mirror-versions-'));
    try {
      const fakeBin = join(directory, 'bin');
      const evidenceRoot = join(directory, 'walg-verified-evidence');
      const recordBytes = '{"schema_version":1}\n';
      const recordSha256 = createHash('sha256').update(recordBytes).digest('hex');
      const objectDirectory = join(evidenceRoot, 'objects', recordSha256);
      const record = join(objectDirectory, 'run-record.json');
      const manifest = join(evidenceRoot, 'mirror-manifest.sha256');
      const manifestBytes = `${recordSha256}  objects/${recordSha256}/run-record.json\n`;
      const expectedKey = `wal-g-evidence/v3/sha256/${recordSha256}/run-record.json`;
      const documentedOpaqueVersionId =
        '3sL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nr8X8gdRQBpUMLUo';
      const callLog = join(directory, 'calls.log');
      const versionCallState = join(directory, 'version-call-state');
      const versioningCallState = join(directory, 'versioning-call-state');
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(objectDirectory, { recursive: true });
      writeFileSync(record, recordBytes);
      writeFileSync(manifest, manifestBytes);
      writeFileSync(callLog, '');
      writeExecutable(
        join(fakeBin, 'aws'),
        [
          ...evidenceAuthorityChannels.map((authority) => `test "\${${authority}+x}" != x`),
          `test "\${AWS_ACCESS_KEY_ID:-}" = '${sentinel}'`,
          `test "\${AWS_SECRET_ACCESS_KEY:-}" = '${sentinel}'`,
          'printf \'aws:%s\\n\' "${2:-missing}" >> "${CALL_LOG}"',
          'case "${2:-}" in',
          '  get-bucket-versioning)',
          '    versioning_call=0',
          '    if [ -f "${VERSIONING_CALL_STATE}" ]; then read -r versioning_call < "${VERSIONING_CALL_STATE}"; fi',
          '    versioning_call=$((versioning_call + 1))',
          '    printf \'%s\\n\' "${versioning_call}" > "${VERSIONING_CALL_STATE}"',
          '    if [ "${MIRROR_VERSION_MODE}" = suspension-after-read ] && [ "${versioning_call}" -ge 2 ]; then',
          "      printf 'Suspended\\n'",
          '    else',
          "      printf 'Enabled\\n'",
          '    fi',
          '    ;;',
          '  list-object-versions)',
          '    max_keys=false',
          '    no_paginate=false',
          '    previous=',
          '    for argument in "$@"; do',
          '      if [ "${previous}" = --max-keys ]; then test "${argument}" = 2; max_keys=true; fi',
          '      if [ "${argument}" = --no-paginate ]; then no_paginate=true; fi',
          '      previous=${argument}',
          '    done',
          '    test "${max_keys}" = true',
          '    test "${no_paginate}" = true',
          '    version_call=0',
          '    if [ -f "${VERSION_CALL_STATE}" ]; then read -r version_call < "${VERSION_CALL_STATE}"; fi',
          '    version_call=$((version_call + 1))',
          '    printf \'%s\\n\' "${version_call}" > "${VERSION_CALL_STATE}"',
          '    case "${MIRROR_VERSION_MODE}:${version_call}" in',
          '      duplicate:*)',
          '        printf \'{"Versions":[{"Key":"%s","VersionId":"v2","IsLatest":true},{"Key":"%s","VersionId":"v1","IsLatest":false}],"DeleteMarkers":[],"IsTruncated":false}\\n\' "${EXPECTED_KEY}" "${EXPECTED_KEY}"',
          '        ;;',
          '      deleted:*)',
          '        printf \'{"Versions":[{"Key":"%s","VersionId":"v1","IsLatest":false}],"DeleteMarkers":[{"Key":"%s","VersionId":"d1","IsLatest":true}],"IsTruncated":false}\\n\' "${EXPECTED_KEY}" "${EXPECTED_KEY}"',
          '        ;;',
          '      race-after-read:2)',
          '        printf \'{"Versions":[{"Key":"%s","VersionId":"v2","IsLatest":true},{"Key":"%s","VersionId":"%s","IsLatest":false}],"DeleteMarkers":[],"IsTruncated":false}\\n\' "${EXPECTED_KEY}" "${EXPECTED_KEY}" "${EXPECTED_VERSION_ID}"',
          '        ;;',
          '      truncated:*)',
          '        printf \'{"Versions":[{"Key":"%s","VersionId":"%s","IsLatest":true}],"DeleteMarkers":[],"IsTruncated":true,"NextKeyMarker":"next"}\\n\' "${EXPECTED_KEY}" "${EXPECTED_VERSION_ID}"',
          '        ;;',
          '      continuation:*)',
          '        printf \'{"Versions":[{"Key":"%s","VersionId":"%s","IsLatest":true}],"DeleteMarkers":[],"IsTruncated":false,"NextVersionIdMarker":"next"}\\n\' "${EXPECTED_KEY}" "${EXPECTED_VERSION_ID}"',
          '        ;;',
          '      oversized-snapshot:*)',
          '        /usr/bin/python3 -c \'print("x" * 70000)\'',
          '        ;;',
          '      *)',
          '        printf \'{"Versions":[{"Key":"%s","VersionId":"%s","IsLatest":true}],"DeleteMarkers":[],"IsTruncated":false}\\n\' "${EXPECTED_KEY}" "${EXPECTED_VERSION_ID}"',
          '        ;;',
          '    esac',
          '    ;;',
          '  head-object)',
          '    pinned=false',
          '    for argument in "$@"; do',
          '      case "${argument}" in',
          '        --version-id=*) test "${argument#--version-id=}" = "${EXPECTED_VERSION_ID}"; pinned=true ;;',
          '        --version-id) exit 93 ;;',
          '      esac',
          '    done',
          '    test "${pinned}" = true',
          `    printf '%s\\n' '${Buffer.byteLength(recordBytes)}'`,
          '    ;;',
          '  get-object)',
          '    pinned=false',
          '    for argument in "$@"; do',
          '      case "${argument}" in',
          '        --version-id=*) test "${argument#--version-id=}" = "${EXPECTED_VERSION_ID}"; pinned=true ;;',
          '        --version-id) exit 93 ;;',
          '      esac',
          '    done',
          '    test "${pinned}" = true',
          '    output_path=${!#}',
          '    /usr/bin/cp "${MIRROR_SOURCE}" "${output_path}"',
          "    printf '{}\\n'",
          '    ;;',
          '  *) exit 95 ;;',
          'esac',
        ].join('\n'),
      );

      const execute = (mode: string, extraEnvironment: Record<string, string> = {}) => {
        writeFileSync(callLog, '');
        rmSync(versionCallState, { force: true });
        rmSync(versioningCallState, { force: true });
        const expectedVersionId =
          mode === 'max-multibyte-version'
            ? 'é'.repeat(512)
            : mode === 'oversized-version'
              ? `${'é'.repeat(512)}v`
              : mode === 'leading-hyphen-version'
                ? '-opaque/version+id'
                : documentedOpaqueVersionId;
        return spawnSync('/bin/bash', [EVIDENCE_MIRROR_VERIFIER_PATH], {
          cwd: directory,
          encoding: 'utf8',
          env: {
            PATH: `${fakeBin}:/usr/bin:/bin`,
            SPACES_ENDPOINT: sentinel,
            EVIDENCE_SPACES_BUCKET: sentinel,
            EXPECTED_EVIDENCE_MANIFEST_SHA256: createHash('sha256')
              .update(manifestBytes)
              .digest('hex'),
            AWS_ACCESS_KEY_ID: sentinel,
            AWS_SECRET_ACCESS_KEY: sentinel,
            AWS_REGION: 'test-region',
            AWS_DEFAULT_REGION: 'test-region',
            EVIDENCE_INPUT_DIR: evidenceRoot,
            EXPECTED_KEY: expectedKey,
            EXPECTED_VERSION_ID: expectedVersionId,
            MIRROR_SOURCE: record,
            MIRROR_VERSION_MODE: mode,
            CALL_LOG: callLog,
            VERSION_CALL_STATE: versionCallState,
            VERSIONING_CALL_STATE: versioningCallState,
            ...extraEnvironment,
          },
        });
      };

      for (const mode of ['exact', 'leading-hyphen-version', 'max-multibyte-version']) {
        const accepted = execute(mode);
        expect({ mode, stderr: accepted.stderr, status: accepted.status }).toEqual({
          mode,
          stderr: '',
          status: 0,
        });
        expect(read(callLog)).toBe(
          'aws:get-bucket-versioning\naws:list-object-versions\naws:head-object\naws:get-object\naws:get-bucket-versioning\naws:list-object-versions\n',
        );
        expect(`${accepted.stdout}${accepted.stderr}`).not.toContain(sentinel);
      }

      for (const mode of [
        'duplicate',
        'deleted',
        'oversized-version',
        'race-after-read',
        'suspension-after-read',
        'truncated',
        'continuation',
        'oversized-snapshot',
      ]) {
        const rejected = execute(mode);
        expect(rejected.status).not.toBe(0);
        expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(sentinel);
      }

      for (const mode of ['duplicate', 'deleted']) {
        const rejected = execute(mode);
        expect(`${rejected.stdout}${rejected.stderr}`).toContain(
          'exactly one live immutable version',
        );
      }

      for (const forbiddenAuthority of evidenceAuthorityChannels) {
        const rejected = execute('exact', { [forbiddenAuthority]: sentinel });
        expect(rejected.status).toBe(2);
        expect(read(callLog)).toBe('');
        expect(`${rejected.stdout}${rejected.stderr}`).toContain(
          `evidence mirror verifier refuses co-resident credential ${forbiddenAuthority}`,
        );
        expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(sentinel);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('suppresses inherited xtrace before the preflight expands any secret value', () => {
    const sentinel = 'AQUA_XTRACE_SECRET_SENTINEL_7f6d85c2';
    const manifest = readManifest();
    const requiredNames = [
      ...profilePreflightSecrets(manifest, 'backup-runtime'),
      ...EXPECTED_PROFILE_VARIABLES['backup-runtime'],
    ];
    const result = spawnSync('bash', ['-x', PREFLIGHT_HELPER_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        BACKUP_SECRET_PROFILE: 'backup-runtime',
        ...Object.fromEntries(requiredNames.map((name) => [name, sentinel])),
      },
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
  });

  it('keeps backup runtime secret forwarding explicit and out of the SSH script', () => {
    const workflow = read(BACKUP_WORKFLOW_PATH);
    const manifest = readManifest();
    const remoteScript = extractBackupSshScript(workflow);

    for (const secretName of profileSecrets(manifest, 'backup-runtime')) {
      expect(workflow).toContain(secretExpression(secretName));
    }
    expect(remoteScript).not.toMatch(/\${{\s*secrets\./);
    expect(workflow).toContain('bash tools/scripts/ci/run-protected-ssh.sh');
  });

  it('uses system OpenSSH with protected host-key authority and no unchecked client download', () => {
    const helper = read(PROTECTED_SSH_PATH);
    const backup = read(BACKUP_WORKFLOW_PATH);
    const pitr = read(PITR_WORKFLOW_PATH);
    const freshness = read(FRESHNESS_WORKFLOW_PATH);

    for (const workflow of [backup, pitr, freshness]) {
      expect(workflow).toContain('DROPLET_SSH_FINGERPRINT');
      expect(workflow).toContain('bash tools/scripts/ci/run-protected-ssh.sh');
      expect(workflow).not.toContain('appleboy/ssh-action@');
      expect(workflow).not.toContain('capture_stdout:');
    }
    expect(helper).toContain(': "${DROPLET_SSH_FINGERPRINT:?DROPLET_SSH_FINGERPRINT required}"');
    expect(helper).toContain(
      '"${SSH_KEYSCAN_BIN}" -T 15 -p "${DROPLET_PORT}" -t ed25519 "${DROPLET_HOST}"',
    );
    expect(helper).toContain('"${SSH_KEYGEN_BIN}" -lf - -E sha256');
    expect(helper).toContain('[ "${candidate_algorithm}" = \'ssh-ed25519\' ] || continue');
    expect(helper).toContain(
      'if [ "${candidate_fingerprint}" = "${DROPLET_SSH_FINGERPRINT}" ]; then',
    );
    expect(helper).toContain('StrictHostKeyChecking=yes');
    expect(helper).toContain('HostKeyAlgorithms=ssh-ed25519');
    expect(helper).toContain('UserKnownHostsFile="${KNOWN_HOSTS_PATH}"');
    expect(helper).toContain('GlobalKnownHostsFile=/dev/null');
    expect(helper).toContain('PasswordAuthentication=no');
    expect(helper).toContain('/usr/bin/env -i');
    expect(helper.startsWith('#!/bin/bash\n')).toBe(true);
    expect(helper).toContain('readonly SYSTEM_PATH=/usr/bin:/bin');
    expect(helper).not.toContain('PATH="${PATH}"');
    for (const binary of [
      '/usr/bin/awk',
      '/usr/bin/cat',
      '/usr/bin/chmod',
      '/usr/bin/env',
      '/usr/bin/head',
      '/usr/bin/mktemp',
      '/usr/bin/readlink',
      '/usr/bin/rm',
      '/usr/bin/ssh',
      '/usr/bin/ssh-keygen',
      '/usr/bin/ssh-keyscan',
      '/usr/bin/stat',
      '/usr/bin/timeout',
    ]) {
      expect(helper).toContain(binary);
    }
    expect(helper).toContain('HOME=/nonexistent');
    expect(helper).toContain('/bin/bash --noprofile --norc -s');
    expect(helper).toContain('require_canonical_absolute_path "${SSH_PAYLOAD_PATH}"');
    expect(helper).toContain('require_canonical_absolute_path "${SSH_STDOUT_PATH}"');
    expect(helper).toContain('exec {SSH_PAYLOAD_FD}< "${SSH_PAYLOAD_PATH}"');
    expect(helper).toContain('exec {SSH_STDOUT_FD}> "${SSH_STDOUT_PATH}"');
    expect(helper).toContain('exec {SSH_RUNTIME_DIR_FD}< "${SSH_RUNTIME_DIR}"');
    expect(helper).toContain('local descriptor_path="/proc/self/fd/${descriptor}"');
    expect(helper.match(/require_open_file_identity \\/g)).toHaveLength(6);
    expect(helper).toContain('runtime_directory_removed_from_namespace');
    expect(helper).toContain("--format='%h'");
    expect(helper).toContain('set -o noclobber');
    expect(helper).toContain('0<&${SSH_PAYLOAD_FD} |');
    expect(helper).toContain('"${HEAD_BIN}" -c "$((SSH_STDOUT_MAX_BYTES + 1))"');
    expect(helper).toContain("die 'Protected SSH stdout exceeded its streaming byte bound.'");
    expect(helper).toContain('pipeline_status=("${PIPESTATUS[@]}")');
    expect(helper).not.toMatch(/\|\s*tee\b/);
    expect(helper).not.toContain('StrictHostKeyChecking=no');
    expect(helper).not.toMatch(/curl|wget|drone-ssh/);
  });

  it('cuts an oversized remote producer before its stdout file can grow without bound', () => {
    const helper = read(PROTECTED_SSH_PATH);
    const directory = mkdtempSync(join(tmpdir(), 'aqua-protected-ssh-stdout-bound-'));
    const output = join(directory, 'stdout');
    const probe = [
      extractShellFunction(helper, 'die'),
      extractShellFunction(helper, 'assert_stdout_within_bound'),
      'SSH_STDOUT_MAX_BYTES=1024',
      '/usr/bin/head -c "$((SSH_STDOUT_MAX_BYTES + 1))" /dev/zero > "$1"',
      'observed=$(/usr/bin/stat -c %s -- "$1")',
      'assert_stdout_within_bound "${observed}"',
    ].join('\n');
    try {
      const result = spawnSync(
        '/bin/bash',
        ['--noprofile', '--norc', '-c', probe, 'probe', output],
        {
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Protected SSH stdout exceeded its streaming byte bound');
      expect(readFileSync(output).byteLength).toBe(1025);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serializes backup ceremonies with releases and rechecks exact main at the SSH edge', () => {
    const backup = read(BACKUP_WORKFLOW_PATH);
    const pitr = read(PITR_WORKFLOW_PATH);
    const freshness = read(FRESHNESS_WORKFLOW_PATH);

    for (const workflow of [backup, pitr]) {
      const document = yaml.load(workflow) as {
        concurrency?: { group?: string; queue?: string; 'cancel-in-progress'?: boolean };
      };
      expect(document.concurrency?.group).toContain('production-release-authority');
      expect(document.concurrency?.group).toContain("github.ref == 'refs/heads/main'");
      expect(document.concurrency?.queue).toBe('max');
      expect(document.concurrency?.['cancel-in-progress']).toBe(false);
    }

    const freshnessDocument = yaml.load(freshness) as {
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
    };
    expect(freshnessDocument.concurrency).toEqual({
      group: 'production-wal-archive-freshness',
      'cancel-in-progress': false,
    });

    for (const workflow of [backup, pitr, freshness]) {
      expect((workflow.match(/assert_exact_current_main/g) ?? []).length).toBeGreaterThanOrEqual(4);
      const finalAuthorityIndex = workflow.lastIndexOf('assert_exact_current_main');
      const keyOpenIndex = workflow.indexOf('exec {SSH_PRIVATE_KEY_FD}< "${SSH_KEY_STAGE}"');
      const sshIndex = workflow.indexOf('/bin/bash tools/scripts/ci/run-protected-ssh.sh');
      expect(keyOpenIndex).toBeGreaterThan(0);
      expect(keyOpenIndex).toBeGreaterThan(
        workflow.lastIndexOf('assert_exact_current_main', keyOpenIndex),
      );
      expect(sshIndex).toBeGreaterThan(keyOpenIndex);
      expect(finalAuthorityIndex).toBeGreaterThan(sshIndex);
      expect(workflow).not.toContain('DROPLET_SSH_KEY="${DROPLET_SSH_KEY}"');
    }

    for (const authorityScript of [backup, read(PITR_CEREMONY_PATH)]) {
      expect(authorityScript).toContain('source scripts/deploy/production-host-control-plane.sh');
      expect(authorityScript).toContain('aqua_control_plane_lock_acquire exclusive 5400');
      expect(authorityScript).toContain('aqua_control_plane_guard_dr_state');
    }
    expect(pitr).toContain('bash tools/scripts/database/walg-pitr-ceremony.sh');
    expect(freshness).toContain('aqua_control_plane_lock_acquire shared 100');
    expect(freshness).toContain('aqua_control_plane_guard_dr_state');
  });

  it('accepts only the exact ED25519 host key and rejects RSA-only or mixed RSA matches', () => {
    const helper = read(PROTECTED_SSH_PATH);
    const directory = mkdtempSync(join(tmpdir(), 'aqua-protected-ssh-host-authority-'));
    const ed25519Private = join(directory, 'host-ed25519');
    const rsaPrivate = join(directory, 'host-rsa');
    const candidates = join(directory, 'candidates');
    const knownHosts = join(directory, 'known-hosts');
    const generateKey = (algorithm: 'ed25519' | 'rsa', output: string): void => {
      const generated = spawnSync(
        '/usr/bin/ssh-keygen',
        ['-q', '-t', algorithm, '-N', '', '-f', output],
        { encoding: 'utf8' },
      );
      expect(generated.status).toBe(0);
    };
    const fingerprint = (publicKeyPath: string): string => {
      const result = spawnSync('/usr/bin/ssh-keygen', ['-lf', publicKeyPath, '-E', 'sha256'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      return result.stdout.trim().split(/\s+/u)[1] ?? '';
    };
    const advertisedKey = (publicKeyPath: string): string => {
      const [algorithm, key] = readFileSync(publicKeyPath, 'utf8').trim().split(/\s+/u);
      return `[127.0.0.1]:22 ${algorithm} ${key}`;
    };
    const probe = [
      'set -euo pipefail',
      'readonly AWK_BIN=/usr/bin/awk',
      'readonly SSH_KEYGEN_BIN=/usr/bin/ssh-keygen',
      extractShellFunction(helper, 'die'),
      extractShellFunction(helper, 'select_ed25519_host_key'),
      'CANDIDATE_HOST_KEYS=$1',
      'KNOWN_HOSTS_PATH=$2',
      'DROPLET_SSH_FINGERPRINT=$3',
      'select_ed25519_host_key',
    ].join('\n');
    const runProbe = (candidateText: string, expectedFingerprint: string) => {
      writeFileSync(candidates, candidateText);
      rmSync(knownHosts, { force: true });
      return spawnSync(
        '/bin/bash',
        ['-c', probe, 'host-authority-probe', candidates, knownHosts, expectedFingerprint],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    };

    try {
      generateKey('ed25519', ed25519Private);
      generateKey('rsa', rsaPrivate);
      const ed25519Public = `${ed25519Private}.pub`;
      const rsaPublic = `${rsaPrivate}.pub`;
      const ed25519Candidate = advertisedKey(ed25519Public);
      const rsaCandidate = advertisedKey(rsaPublic);
      const ed25519Fingerprint = fingerprint(ed25519Public);
      const rsaFingerprint = fingerprint(rsaPublic);

      const accepted = runProbe(`${ed25519Candidate}\n`, ed25519Fingerprint);
      expect(accepted.status).toBe(0);
      expect(readFileSync(knownHosts, 'utf8')).toBe(`${ed25519Candidate}\n`);

      const rsaOnly = runProbe(`${rsaCandidate}\n`, rsaFingerprint);
      expect(rsaOnly.status).toBe(2);
      expect(readFileSync(knownHosts, 'utf8')).toBe('');

      const mixedRsaMatch = runProbe(`${rsaCandidate}\n${ed25519Candidate}\n`, rsaFingerprint);
      expect(mixedRsaMatch.status).toBe(2);
      expect(readFileSync(knownHosts, 'utf8')).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts the private key only through an unlinked bounded inherited descriptor', () => {
    const helper = read(PROTECTED_SSH_PATH);
    const descriptorContractIndex = helper.indexOf(
      ': "${SSH_PRIVATE_KEY_FD:?SSH_PRIVATE_KEY_FD required}"',
    );
    const firstPathCheckIndex = helper.indexOf(
      'require_canonical_absolute_path "${SSH_PAYLOAD_PATH}"',
    );
    const materializationIndex = helper.indexOf(
      '"${CAT_BIN}" -- "/proc/self/fd/${SSH_PRIVATE_KEY_FD}" > "${KEY_PATH}"',
    );
    const descriptorCloseIndex = helper.indexOf(
      'exec {SSH_PRIVATE_KEY_FD}<&-',
      materializationIndex,
    );

    expect(descriptorContractIndex).toBeGreaterThan(0);
    expect(descriptorContractIndex).toBeLessThan(firstPathCheckIndex);
    expect(helper).toContain('[ "${descriptor_links}" = 0 ]');
    expect(helper).toContain('[ "${descriptor_mode}" = 600 ]');
    expect(helper).toContain('[ "${descriptor_size}" -le 65536 ]');
    expect(materializationIndex).toBeGreaterThan(firstPathCheckIndex);
    expect(descriptorCloseIndex).toBeGreaterThan(materializationIndex);
    expect(helper).not.toContain('DROPLET_SSH_KEY');
    expect(helper).not.toContain('SSH_PRIVATE_KEY_MATERIAL');
    const cleanupIndex = helper.indexOf('cleanup() {');
    const cleanupKeyCloseIndex = helper.indexOf('exec {SSH_PRIVATE_KEY_FD}<&-', cleanupIndex);
    const cleanupExternalIndex = helper.indexOf('runtime_directory_identity_matches', cleanupIndex);
    expect(cleanupKeyCloseIndex).toBeGreaterThan(cleanupIndex);
    expect(cleanupExternalIndex).toBeGreaterThan(cleanupKeyCloseIndex);
  });

  it('ignores runner PATH shadows and suppresses inherited xtrace around the key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aqua-protected-ssh-fixed-path-'));
    const fakeBin = join(directory, 'bin');
    const payloadPath = join(directory, 'payload.sh');
    const stdoutPath = join(directory, 'stdout');
    const invokedMarker = join(directory, 'path-shadow-invoked');
    const fingerprint = `SHA256:${'B'.repeat(43)}`;
    const keySentinel = 'AQUA_PRIVATE_SSH_KEY_6a035ea9';
    try {
      mkdirSync(fakeBin, { mode: 0o700 });
      for (const binary of [
        'awk',
        'cat',
        'chmod',
        'env',
        'mktemp',
        'readlink',
        'rm',
        'ssh',
        'ssh-keygen',
        'ssh-keyscan',
        'stat',
        'timeout',
      ]) {
        writeExecutable(join(fakeBin, binary), `printf 'invoked\\n' > '${invokedMarker}'\nexit 99`);
      }
      writeFileSync(payloadPath, 'exit 0\n', { mode: 0o600 });
      const privateKeyPath = join(directory, 'private-key.input');
      writeFileSync(privateKeyPath, keySentinel, { mode: 0o600 });
      const privateKeyFd = openSync(privateKeyPath, 'r');
      rmSync(privateKeyPath);

      const result = spawnSync('/bin/bash', ['-x', PROTECTED_SSH_PATH], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe', privateKeyFd],
        env: {
          PATH: fakeBin,
          TMPDIR: directory,
          DROPLET_HOST: '127.0.0.1',
          DROPLET_PORT: '1',
          DROPLET_USER: 'backup',
          SSH_PRIVATE_KEY_FD: '3',
          DROPLET_SSH_FINGERPRINT: fingerprint,
          SSH_PAYLOAD_PATH: payloadPath,
          SSH_STDOUT_PATH: stdoutPath,
        },
      });
      closeSync(privateKeyFd);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'ssh-keyscan could not retrieve the protected ED25519 host key',
      );
      expect(result.stderr).not.toContain('runtime cleanup failed');
      expect(result.stderr).not.toContain('runtime directory identity changed');
      expect(`${result.stdout}${result.stderr}`).not.toContain(keySentinel);
      expect(read(stdoutPath)).toBe('');
      expect(() => read(invokedMarker)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects symlinked or replaced payload and stdout path identities', () => {
    const helper = read(PROTECTED_SSH_PATH);
    const directory = mkdtempSync(join(tmpdir(), 'aqua-protected-ssh-path-identity-'));
    const payloadPath = join(directory, 'payload.sh');
    const replacementPath = join(directory, 'replacement.sh');
    const symlinkPath = join(directory, 'payload-link.sh');
    const probe = [
      'readonly STAT_BIN=/usr/bin/stat',
      extractShellFunction(helper, 'die'),
      extractShellFunction(helper, 'path_identity'),
      extractShellFunction(helper, 'require_regular_file_identity'),
      'require_regular_file_identity "$1" "$2" TEST_PATH',
    ].join('\n');
    const runProbe = (path: string, expectedIdentity: string) =>
      spawnSync('/bin/bash', ['-c', probe, 'path-identity-probe', path, expectedIdentity], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });

    try {
      writeFileSync(payloadPath, 'exit 0\n', { mode: 0o600 });
      writeFileSync(replacementPath, 'exit 99\n', { mode: 0o600 });
      const identity = spawnSync('/usr/bin/stat', ['-Lc', '%d:%i', payloadPath], {
        encoding: 'utf8',
      }).stdout.trim();
      expect(runProbe(payloadPath, identity).status).toBe(0);

      renameSync(replacementPath, payloadPath);
      expect(runProbe(payloadPath, identity).status).toBe(2);

      symlinkSync(payloadPath, symlinkPath);
      expect(runProbe(symlinkPath, identity).status).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when runtime cleanup cannot prove removal of the same directory', () => {
    const helper = read(PROTECTED_SSH_PATH);
    const directory = mkdtempSync(join(tmpdir(), 'aqua-protected-ssh-cleanup-'));
    const cleanupFunction = extractShellFunction(helper, 'cleanup');
    const runCleanupProbe = (
      identityResult: number,
      removalResult: number,
      removalProofResult: number,
    ) =>
      spawnSync(
        '/bin/bash',
        [
          '-c',
          [
            cleanupFunction,
            `runtime_directory_identity_matches() { return ${identityResult}; }`,
            `remove_runtime_directory() { return ${removalResult}; }`,
            `runtime_directory_removed_from_namespace() { return ${removalProofResult}; }`,
            'SSH_RUNTIME_DIR="$1"',
            'SSH_RUNTIME_DIR_ID=test-identity',
            'SSH_RUNTIME_DIR_FD=',
            'SSH_PAYLOAD_FD=',
            'SSH_STDOUT_FD=',
            'true',
            'cleanup',
          ].join('\n'),
          'cleanup-probe',
          directory,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );

    try {
      const mismatched = runCleanupProbe(1, 0, 1);
      expect(mismatched.status).toBe(1);
      expect(mismatched.stderr).toContain('runtime directory identity changed');

      const removalFailed = runCleanupProbe(0, 1, 1);
      expect(removalFailed.status).toBe(1);
      expect(removalFailed.stderr).toContain('runtime cleanup failed');

      const residue = runCleanupProbe(0, 0, 1);
      expect(residue.status).toBe(1);
      expect(residue.stderr).toContain('runtime cleanup failed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('makes every runner-owned SSH step cleanup status-preserving and fail-closed', () => {
    for (const workflow of [
      read(BACKUP_WORKFLOW_PATH),
      read(PITR_WORKFLOW_PATH),
      read(FRESHNESS_WORKFLOW_PATH),
    ]) {
      expect(workflow).toContain('trap - EXIT');
      expect(workflow).toContain('if ! rm -rf -- "${SSH_STEP_DIR}" || [ -e "${SSH_STEP_DIR}" ]');
      expect(workflow).toContain('if [ "${status}" -eq 0 ] && [ "${cleanup_status}" -ne 0 ]');
    }
  });

  it('keeps dry-run dump-only and propagates backup script failures', () => {
    const workflow = read(BACKUP_WORKFLOW_PATH);
    const remoteScript = extractBackupSshScript(workflow);
    const backupScript = read(BACKUP_SCRIPT_PATH);

    expect(remoteScript).toContain('export BACKUP_DUMP_ONLY=true');
    expect(remoteScript).toContain('bash tools/scripts/database/backup-databases.sh');
    expect(remoteScript).not.toMatch(/\|\|\s*echo.*dry-run/i);
    expect(workflow).not.toMatch(/backup-databases\.sh\s*\|\|\s*echo/);
    expect(workflow).toContain(
      'LOGICAL_BACKUP_GPG_RECIPIENT: ${{ secrets.LOGICAL_BACKUP_GPG_RECIPIENT }}',
    );
    expect(remoteScript).toContain('BACKUP_GPG_RECIPIENT="${LOGICAL_BACKUP_GPG_RECIPIENT}"');
    expect(backupScript).toContain('BACKUP_DUMP_ONLY');
    expect(backupScript).toContain('skipping upload');
    expect(backupScript).toContain('BACKUP_GPG_RECIPIENT required for client-encrypted upload');
    expect(backupScript).not.toMatch(/(?:--sse|--server-side-encryption)\b/);
    expect(workflow).not.toMatch(/(?:--sse|--server-side-encryption)\b/);
  });

  it('uses immutable GitHub artifacts and Cosign/Rekor as evidence authority', () => {
    const backup = read(BACKUP_WORKFLOW_PATH);
    const pitr = read(PITR_WORKFLOW_PATH);
    const closure = read(CLOSURE_WORKFLOW_PATH);
    const evidenceVerifier = read(EVIDENCE_VERIFIER_PATH);
    const mirrorVerifier = read(EVIDENCE_MIRROR_VERIFIER_PATH);

    for (const [workflow, file] of [
      [backup, 'backup-production.yml'],
      [pitr, 'pitr-restore-production.yml'],
    ] as const) {
      expect(workflow).toContain('id-token: write');
      expect(workflow).toContain('cosign sign-blob --yes');
      expect(workflow).toContain('cosign verify-blob');
      expect(workflow).toContain('actions/upload-artifact@');
      expect(workflow).toContain(`walg-evidence-v3-${file}-`);
      expect(workflow).toContain(`walg-raw-evidence-v1-${file}-`);
      expect(workflow).toContain('overwrite: false');
      expect(workflow).toContain('wal-g-evidence/v3/sha256/');
    }

    expect(closure).toContain('permissions:\n  actions: read\n  contents: read');
    expect(closure).toContain('bash tools/scripts/database/verify-walg-github-evidence.sh');
    expect(closure).toContain('cosign-release: v3.0.6');
    expect(closure).toContain('CLOSURE_MAIN_SHA: ${{ github.sha }}');
    expect(closure).toContain('bash tools/scripts/database/verify-walg-evidence-mirror.sh');
    expect(closure).not.toContain('id-token: write');
    expect(evidenceVerifier).toContain('github_token_material=${GH_TOKEN}');
    expect(evidenceVerifier).toContain('GH_TOKEN="${github_token_material}" gh api');
    expect(evidenceVerifier).toContain(
      "EXPECTED_COSIGN_SHA256='c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74'",
    );
    expect(evidenceVerifier).toContain('${EVIDENCE_OUTPUT_DIR}/objects');
    expect(evidenceVerifier).toContain('mirror-manifest.sha256');
    expect(evidenceVerifier).not.toContain('run_readonly_aws');
    expect(evidenceVerifier).not.toContain('AWS_ACCESS_KEY_ID="${');
    expect(mirrorVerifier).toContain('run_readonly_aws()');
    expect(mirrorVerifier).toContain('wal-g-evidence/v3/sha256/${expected_sha}/${file_name}');
    expect(mirrorVerifier).toContain('s3api list-object-versions');
    expect(mirrorVerifier).toContain('--max-keys 2');
    expect(mirrorVerifier).toContain('--no-paginate');
    expect(mirrorVerifier).toContain('MAX_VERSION_SNAPSHOT_BYTES=65536');
    expect(mirrorVerifier).toContain('head -c "$((MAX_VERSION_SNAPSHOT_BYTES + 1))"');
    expect(mirrorVerifier).toContain('"--version-id=${verified_version_id}"');
    expect(mirrorVerifier).not.toContain('--version-id "${version_id}"');
    expect(mirrorVerifier).toContain('s3api get-object');
    expect(mirrorVerifier).toContain('exactly one live immutable version');
    expect(mirrorVerifier).toContain('final_versioning_status=');
    expect(mirrorVerifier).toContain('final_version_snapshot=');
    expect(mirrorVerifier).toContain('mirror key changed after its pinned verification');
    expect(mirrorVerifier).toContain('mirror manifest count, order, or uniqueness is invalid');
    expect(mirrorVerifier).not.toContain('GH_TOKEN="${');
    expect(evidenceVerifier).toContain('assert_exact_current_main()');
    expect((evidenceVerifier.match(/assert_exact_current_main/g) ?? []).length).toBeGreaterThan(5);
    expect(evidenceVerifier).toContain('.created_at >= $run_started_at');
    expect(evidenceVerifier).toContain('.created_at <= $run_updated_at');
    expect(evidenceVerifier).toContain('.created_at == $artifact_created_at');
    expect(evidenceVerifier).toContain('--artifact-created-at "${raw_artifact_created_at}"');
    expect(evidenceVerifier).toContain('--max-filesize 10485760');
    expect(evidenceVerifier).toContain('--max-filesize 9437184');
    expect(evidenceVerifier).toContain('[ "${run_sha}" != "${CLOSURE_MAIN_SHA}" ]');
    expect(evidenceVerifier).toContain('--expected-main-sha "${CLOSURE_MAIN_SHA}"');
    expect(evidenceVerifier).toContain(
      '--expected-postgres-dr-contract-sha256 "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}"',
    );
    expect(evidenceVerifier).toContain('/compare/${source_revision}...${evidence_main}');
    expect(evidenceVerifier).toContain('(.status == "ahead" or .status == "identical")');
    expect(evidenceVerifier).toContain('.base_commit.sha == $source');
    expect(evidenceVerifier).toContain('.merge_base_commit.sha == $source');
    expect(evidenceVerifier).toContain('.behind_by == 0');
    expect(evidenceVerifier).not.toContain('/compare/${run_sha}...${CLOSURE_MAIN_SHA}');

    const closureJobs = readWorkflow(CLOSURE_WORKFLOW_PATH).jobs ?? {};
    const githubJob = closureJobs['verify-github'];
    const mirrorJob = closureJobs['verify-mirror'];
    const finalMainJob = closureJobs['verify-final-main'];
    const githubSteps = githubJob?.steps ?? [];
    const mirrorSteps = mirrorJob?.steps ?? [];
    const finalMainSteps = finalMainJob?.steps ?? [];
    const githubVerification = githubSteps.find(
      (step) => step.name === 'Verify GitHub and Rekor authority and stage mirror inputs',
    );
    const boundInputs = githubSteps.find(
      (step) => step.name === 'Bind staged evidence manifest to downstream authority',
    );
    const preservedInputs = githubSteps.find(
      (step) => step.name === 'Preserve bounded verified mirror inputs',
    );
    const downloadedInputs = mirrorSteps.find(
      (step) => step.name === 'Download exact verified mirror inputs',
    );
    const mirrorVerification = mirrorSteps.find(
      (step) => step.name === 'Verify AWS mirror in a sanitized process boundary',
    );
    const finalMainProof = finalMainSteps.find(
      (step) => step.name === 'Reassert exact protected main after mirror verification',
    );

    expect(Object.keys(closureJobs).sort()).toEqual(
      ['verify-final-main', 'verify-github', 'verify-mirror'].sort(),
    );
    expect(githubJob?.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(githubJob?.environment).toBeUndefined();
    expect(githubJob?.if).toBeUndefined();
    expect(JSON.stringify(githubJob)).not.toContain('${{ secrets.');
    expect(JSON.stringify(githubJob)).not.toContain('AWS_ACCESS_KEY_ID');
    expect(JSON.stringify(githubJob)).not.toContain('id-token');
    expect(githubVerification?.env).toMatchObject({
      GH_TOKEN: '${{ github.token }}',
      CLOSURE_MAIN_SHA: '${{ github.sha }}',
    });
    expect(JSON.stringify(githubVerification)).not.toContain('AWS_ACCESS_KEY_ID');
    expect(JSON.stringify(githubVerification)).not.toContain('SPACES_ENDPOINT');

    expect(preservedInputs?.uses).toContain('actions/upload-artifact@');
    expect(preservedInputs?.with).toMatchObject({
      path: 'walg-verified-evidence/',
      overwrite: false,
      'retention-days': 1,
      'compression-level': 0,
      archive: true,
    });
    expect(boundInputs?.run).toContain('mirror-manifest.sha256');
    expect(boundInputs?.run).toContain('manifest_sha256=${MANIFEST_SHA256}');
    expect(githubJob?.outputs).toEqual({
      artifact_id: '${{ steps.preserve_verified.outputs.artifact-id }}',
      manifest_sha256: '${{ steps.bind_verified.outputs.manifest_sha256 }}',
    });

    expect(mirrorJob?.environment).toMatchObject({
      name: 'production-backup',
      deployment: false,
    });
    expect(mirrorJob?.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(JSON.stringify(mirrorJob)).not.toContain('${{ github.token }}');
    expect(JSON.stringify(mirrorJob)).not.toContain('GH_TOKEN');
    expect(JSON.stringify(mirrorJob)).not.toContain('id-token');
    expect(downloadedInputs?.uses).toContain('actions/download-artifact@');
    expect(downloadedInputs?.with).toMatchObject({
      'artifact-ids': '${{ needs.verify-github.outputs.artifact_id }}',
      path: 'walg-verified-evidence',
      'merge-multiple': true,
    });
    expect(mirrorVerification?.env?.GH_TOKEN).toBeUndefined();
    expect(JSON.stringify(mirrorVerification)).not.toContain('${{ github.token }}');
    expect(JSON.stringify(mirrorVerification)).toContain('AWS_ACCESS_KEY_ID');
    expect(mirrorVerification?.env?.EXPECTED_EVIDENCE_MANIFEST_SHA256).toBe(
      '${{ needs.verify-github.outputs.manifest_sha256 }}',
    );
    expect(mirrorVerification?.run).toContain('exec /usr/bin/env -i');
    expect(mirrorVerification?.run).toContain('AQUA_MIRROR_SANITIZED=aws-read-only-v1');
    expect(mirrorVerification?.run).toContain('/bin/bash --noprofile --norc -e -u -o pipefail');
    expect(mirrorVerification?.run).toContain(
      'bash tools/scripts/database/assert-backup-secrets.sh',
    );
    expect(mirrorVerification?.run).toContain(
      'bash tools/scripts/database/verify-walg-evidence-mirror.sh',
    );

    expect(finalMainJob?.permissions).toEqual({ contents: 'read' });
    expect(finalMainJob?.environment).toBeUndefined();
    expect(JSON.stringify(finalMainJob)).not.toContain('${{ secrets.');
    expect(JSON.stringify(finalMainJob)).not.toContain('AWS_ACCESS_KEY_ID');
    expect(finalMainProof?.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      CLOSURE_MAIN_SHA: '${{ github.sha }}',
    });
    expect(JSON.stringify(finalMainProof)).not.toContain('AWS_ACCESS_KEY_ID');
    for (const forbiddenCredential of evidenceAuthorityChannels) {
      expect(mirrorVerifier).toContain(forbiddenCredential);
    }
    expect(mirrorVerifier).toContain(
      'mirror manifest differs from the GitHub-verified content binding',
    );
  });

  it('keeps runner bundle and SSH transport builders under control-plane ownership', () => {
    const codeowners = read(CODEOWNERS_PATH);

    expect(codeowners).toContain('tools/scripts/ci/prepare-protected-runtime-bundle.sh @Okan-wqm');
    expect(codeowners).toContain('tools/scripts/ci/run-protected-ssh.sh                 @Okan-wqm');
    expect(codeowners).toContain('tools/scripts/ci/                                     @Okan-wqm');
    expect(codeowners).toContain('tools/scripts/database/                               @Okan-wqm');
  });

  it('keeps both runbooks linked to the manifest and signed evidence model', () => {
    const restoreRunbook = read(RESTORE_RUNBOOK_PATH);
    const rotationRunbook = read(ROTATION_RUNBOOK_PATH);
    const postgresImageManifest = readPostgresImageManifest();

    for (const profile of PROFILE_NAMES) {
      expect(restoreRunbook).toContain(`\`${profile}\``);
    }

    expect(restoreRunbook).toContain('.github/manifests/backup-secrets.json');
    expect(restoreRunbook).toContain('Metadata.sha256');
    expect(restoreRunbook).toContain('exact 40-hex');
    expect(restoreRunbook).toContain('`.dump.gpg` and `.verification.json.gpg`');
    expect(restoreRunbook).toContain('ciphertext hashes reciprocally');
    expect(restoreRunbook).toContain('`BACKUP_GPG_KEY`');
    expect(restoreRunbook).toContain(postgresImageManifest.image);
    expect(restoreRunbook).toContain('GitHub Actions artifact');
    expect(restoreRunbook).toContain('Cosign/Rekor');
    expect(restoreRunbook).toContain('verify-backup-dr-closure.yml');
    expect(restoreRunbook).not.toContain('wal-g-evidence/v1/');
    expect(restoreRunbook).not.toContain('verify_enterprise_closure');

    expect(rotationRunbook).toContain('production-backup');
    expect(rotationRunbook).toContain('dry_run: false');
    expect(rotationRunbook).toContain('Metadata.sha256');
    expect(rotationRunbook).toContain('exact 40-hex primary-key');
    expect(rotationRunbook).toContain('`.verification.json.gpg`');
    expect(rotationRunbook).toContain('Plaintext dump');
    expect(rotationRunbook).toContain('EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID');
    expect(rotationRunbook).toContain('EVIDENCE_VERIFIER_SPACES_ACCESS_KEY_ID');
    expect(rotationRunbook).toContain('Cosign/Rekor');
  });

  it('is wired into invariants:fast via a selected Jest project', () => {
    const jestConfig = read(JEST_CONFIG_PATH);
    const layer1Start = jestConfig.indexOf("displayName: 'layer-1'");
    const layer3Start = jestConfig.indexOf("displayName: 'layer-3'");

    expect(layer1Start).toBeGreaterThanOrEqual(0);
    expect(layer3Start).toBeGreaterThan(layer1Start);

    const layer1Block = jestConfig.slice(layer1Start, layer3Start);
    expect(layer1Block).toContain('<rootDir>/backup-production-secrets.spec.ts');
  });
});
