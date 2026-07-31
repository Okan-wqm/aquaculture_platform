import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  'DROPLET_HOST',
  'DROPLET_USER',
  'DROPLET_SSH_KEY',
  'DROPLET_SSH_FINGERPRINT',
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
    'DROPLET_HOST',
    'DROPLET_USER',
    'DROPLET_SSH_KEY',
    'DROPLET_SSH_FINGERPRINT',
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
    'DROPLET_HOST',
    'DROPLET_USER',
    'DROPLET_SSH_KEY',
    'DROPLET_SSH_FINGERPRINT',
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
    'DROPLET_HOST',
    'DROPLET_USER',
    'DROPLET_SSH_KEY',
    'DROPLET_SSH_FINGERPRINT',
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
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
}

interface WorkflowJob {
  if?: string;
  environment?: { name?: string };
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  jobs?: Record<string, WorkflowJob>;
}

function read(path: string): string {
  return readFileSync(path, 'utf-8');
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
    environment.includes('EVIDENCE_B64')
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
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
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
  });

  it('makes every profile fail closed when any of its manifest secrets is absent', () => {
    const manifest = readManifest();

    for (const profile of PROFILE_NAMES) {
      const required = profileSecrets(manifest, profile);
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
            step.run?.includes("test \"${GITHUB_REF}\" = 'refs/heads/main'") === true &&
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

  it('suppresses inherited xtrace before the preflight expands any secret value', () => {
    const sentinel = 'AQUA_XTRACE_SECRET_SENTINEL_7f6d85c2';
    const requiredNames = [
      ...EXPECTED_PROFILE_SECRETS['backup-runtime'],
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
    expect(helper).toContain('ssh-keyscan');
    expect(helper).toContain('ssh-keygen -lf - -E sha256');
    expect(helper).toContain(
      'if [ "${candidate_fingerprint}" = "${DROPLET_SSH_FINGERPRINT}" ]; then',
    );
    expect(helper).toContain('StrictHostKeyChecking=yes');
    expect(helper).toContain('UserKnownHostsFile="${KNOWN_HOSTS_PATH}"');
    expect(helper).toContain('GlobalKnownHostsFile=/dev/null');
    expect(helper).toContain('PasswordAuthentication=no');
    expect(helper).toContain('/usr/bin/env -i');
    expect(helper).toContain('HOME=/nonexistent');
    expect(helper).toContain('/bin/bash --noprofile --norc -s');
    expect(helper).toContain('< "${SSH_PAYLOAD_PATH}" > "${SSH_STDOUT_PATH}"');
    expect(helper).not.toMatch(/\|\s*tee\b/);
    expect(helper).not.toContain('StrictHostKeyChecking=no');
    expect(helper).not.toMatch(/curl|wget|drone-ssh/);
  });

  it('keeps protected SSH stdout private and suppresses inherited xtrace around the key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aqua-protected-ssh-private-output-'));
    const fakeBin = join(directory, 'bin');
    const payloadPath = join(directory, 'payload.sh');
    const stdoutPath = join(directory, 'stdout');
    const fingerprint = `SHA256:${'B'.repeat(43)}`;
    const evidenceSentinel = 'AQUA_PRIVATE_TENANT_EVIDENCE_18c675d4';
    const keySentinel = 'AQUA_PRIVATE_SSH_KEY_6a035ea9';
    try {
      mkdirSync(fakeBin, { mode: 0o700 });
      writeExecutable(
        join(fakeBin, 'ssh-keyscan'),
        "printf '%s\\n' 'host.example ssh-ed25519 test-public-key'",
      );
      writeExecutable(
        join(fakeBin, 'ssh-keygen'),
        `printf '%s\\n' '256 ${fingerprint} host.example (ED25519)'`,
      );
      writeExecutable(join(fakeBin, 'timeout'), `printf '%s\\n' '${evidenceSentinel}'`);
      writeFileSync(payloadPath, 'exit 0\n', { mode: 0o600 });

      const result = spawnSync('bash', ['-x', PROTECTED_SSH_PATH], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          TMPDIR: directory,
          DROPLET_HOST: 'host.example',
          DROPLET_USER: 'backup',
          DROPLET_SSH_KEY: keySentinel,
          DROPLET_SSH_FINGERPRINT: fingerprint,
          SSH_PAYLOAD_PATH: payloadPath,
          SSH_STDOUT_PATH: stdoutPath,
        },
      });

      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(evidenceSentinel);
      expect(`${result.stdout}${result.stderr}`).not.toContain(keySentinel);
      expect(read(stdoutPath)).toContain(evidenceSentinel);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails a successful SSH execution when its private runtime cleanup leaves residue', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aqua-protected-ssh-cleanup-'));
    const fakeBin = join(directory, 'bin');
    const payloadPath = join(directory, 'payload.sh');
    const stdoutPath = join(directory, 'stdout');
    const fingerprint = `SHA256:${'A'.repeat(43)}`;
    try {
      mkdirSync(fakeBin, { mode: 0o700 });
      writeExecutable(
        join(fakeBin, 'ssh-keyscan'),
        "printf '%s\\n' 'host.example ssh-ed25519 test-public-key'",
      );
      writeExecutable(
        join(fakeBin, 'ssh-keygen'),
        `printf '%s\\n' '256 ${fingerprint} host.example (ED25519)'`,
      );
      writeExecutable(join(fakeBin, 'timeout'), 'exit 0');
      writeExecutable(join(fakeBin, 'rm'), 'exit 1');
      writeFileSync(payloadPath, 'exit 0\n', { mode: 0o600 });

      const result = spawnSync('bash', [PROTECTED_SSH_PATH], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          TMPDIR: directory,
          DROPLET_HOST: 'host.example',
          DROPLET_USER: 'backup',
          DROPLET_SSH_KEY: 'test-private-key',
          DROPLET_SSH_FINGERPRINT: fingerprint,
          SSH_PAYLOAD_PATH: payloadPath,
          SSH_STDOUT_PATH: stdoutPath,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('protected SSH runtime cleanup failed');
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

    for (const [workflow, file] of [
      [backup, 'backup-production.yml'],
      [pitr, 'pitr-restore-production.yml'],
    ] as const) {
      expect(workflow).toContain('id-token: write');
      expect(workflow).toContain('cosign sign-blob --yes');
      expect(workflow).toContain('cosign verify-blob');
      expect(workflow).toContain('actions/upload-artifact@');
      expect(workflow).toContain(`walg-evidence-v2-${file}-`);
      expect(workflow).toContain('overwrite: false');
      expect(workflow).toContain('wal-g-evidence/v2/sha256/');
    }

    expect(closure).toContain('permissions:\n  actions: read\n  contents: read');
    expect(closure).toContain('bash tools/scripts/database/verify-walg-github-evidence.sh');
    expect(closure).not.toContain('id-token: write');
    expect(evidenceVerifier).toContain('[ "${run_sha}" != "${CLOSURE_MAIN_SHA}" ]');
    expect(evidenceVerifier).toContain('--expected-main-sha "${CLOSURE_MAIN_SHA}"');
    expect(evidenceVerifier).toContain(
      '--expected-postgres-dr-contract-sha256 "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}"',
    );
    expect(evidenceVerifier).toContain(
      '/compare/${source_revision}...${evidence_main}',
    );
    expect(evidenceVerifier).toContain('(.status == "ahead" or .status == "identical")');
    expect(evidenceVerifier).toContain('.base_commit.sha == $source');
    expect(evidenceVerifier).toContain('.merge_base_commit.sha == $source');
    expect(evidenceVerifier).toContain('.behind_by == 0');
    expect(evidenceVerifier).not.toContain('/compare/${run_sha}...${CLOSURE_MAIN_SHA}');
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
    // The property is that THIS spec runs in the fast suite. It used to be
    // spelled as "the layer-1 block of the config text names this file", which
    // held only while shard membership was an enumeration. Membership is a glob
    // now — a spec runs unless the dormancy manifest excludes it — so the
    // filename is correctly absent from the config and the property is
    // unchanged. Asserting the spelling would report a coverage improvement as
    // a coverage regression, and the obvious way to make that failure go away
    // is to put this file back in a list, which is the wrong direction.
    const jestConfig = read(JEST_CONFIG_PATH);
    expect(jestConfig).toContain("testMatch: ['<rootDir>/*.spec.ts']");

    const dormant = JSON.parse(
      read(join(REPO_ROOT, 'tests', 'invariants', 'invariant-reachability.dormant.json')),
    ) as Record<string, unknown>;
    expect(Object.keys(dormant)).not.toContain('backup-production-secrets.spec.ts');

    // And the fast script must still select the project this spec lands in.
    const pkg = JSON.parse(read(join(REPO_ROOT, 'package.json'))) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['invariants:fast']).toContain('layer-1');
  });
});
