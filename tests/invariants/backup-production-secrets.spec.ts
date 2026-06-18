import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const WORKFLOW_PATH = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'backup-production.yml',
);
const SECRET_MANIFEST_PATH = join(
  REPO_ROOT,
  '.github',
  'manifests',
  'backup-secrets.json',
);
const POSTGRES_IMAGE_MANIFEST_PATH = join(
  REPO_ROOT,
  '.github',
  'manifests',
  'postgres-image.json',
);
const PREFLIGHT_HELPER_PATH = join(
  REPO_ROOT,
  'tools',
  'scripts',
  'database',
  'assert-backup-secrets.sh',
);
const BACKUP_SCRIPT_PATH = join(
  REPO_ROOT,
  'tools',
  'scripts',
  'database',
  'backup-databases.sh',
);
const RESTORE_RUNBOOK_PATH = join(
  REPO_ROOT,
  'docs',
  'runbooks',
  'database-restore-drill.md',
);
const ROTATION_RUNBOOK_PATH = join(
  REPO_ROOT,
  'docs',
  'runbooks',
  'secret-rotation.md',
);
const JEST_CONFIG_PATH = join(REPO_ROOT, 'tests', 'invariants', 'jest.config.ts');

const REQUIRED_SECRET_NAMES = [
  'DROPLET_HOST',
  'DROPLET_USER',
  'DROPLET_SSH_KEY',
  'SPACES_BUCKET',
  'SPACES_ENDPOINT',
  'SPACES_ACCESS_KEY_ID',
  'SPACES_SECRET_ACCESS_KEY',
  'BACKUP_POSTGRES_USER',
  'BACKUP_POSTGRES_DB',
  'BACKUP_POSTGRES_PASSWORD',
] as const;

interface BackupSecretContract {
  name: string;
  runtime: {
    remoteEnv?: string;
    sshActionInput?: string;
  };
}

interface BackupSecretManifest {
  githubEnvironment: {
    name: string;
    deployment: boolean;
  };
  requiredSecrets: BackupSecretContract[];
}

interface PostgresImageManifest {
  image: string;
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

function secretExpression(secretName: string): string {
  return `\${{ secrets.${secretName} }}`;
}

function extractRequiredSecretsFromHelper(helper: string): string[] {
  const match = helper.match(
    /REQUIRED_BACKUP_SECRETS=\(\n(?<body>[\s\S]*?)\n\)/,
  );
  if (!match?.groups?.body) {
    throw new Error('Could not parse REQUIRED_BACKUP_SECRETS from helper');
  }

  return match.groups.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractSshRuntimeEnvList(workflow: string): string[] {
  const match = workflow.match(/^\s*envs:\s*([A-Z0-9_,]+)$/m);
  if (!match?.[1]) {
    throw new Error('Could not parse ssh-action envs list');
  }
  return match[1].split(',');
}

function extractBackupSshScript(workflow: string): string {
  const stepStart = workflow.indexOf(
    '- name: Run backup-databases.sh on the droplet',
  );
  if (stepStart < 0) {
    throw new Error('Could not find backup SSH step');
  }
  const scriptStart = workflow.indexOf('script: |', stepStart);
  if (scriptStart < 0) {
    throw new Error('Could not find backup SSH script block');
  }
  const nextStep = workflow.indexOf('\n      - name:', scriptStart + 1);
  return workflow.slice(
    scriptStart,
    nextStep > scriptStart ? nextStep : workflow.length,
  );
}

describe('production backup secret contract', () => {
  it('keeps the manifest as the canonical 10-secret contract', () => {
    const manifest = readManifest();

    expect(manifest.githubEnvironment).toMatchObject({
      name: 'production-backup',
      deployment: false,
    });

    expect(manifest.requiredSecrets.map((secret) => secret.name)).toEqual(
      REQUIRED_SECRET_NAMES,
    );

    for (const secret of manifest.requiredSecrets) {
      expect(
        Boolean(secret.runtime.remoteEnv) ||
          Boolean(secret.runtime.sshActionInput),
      ).toBe(true);
    }
  });

  it('uses production-backup without creating GitHub deployments', () => {
    const workflow = read(WORKFLOW_PATH);

    expect(workflow).toMatch(
      /environment:\n\s+name:\s+production-backup\n\s+deployment:\s+false/,
    );
    expect(workflow).toMatch(
      /dry_run:\n\s+description:.*\n\s+type:\s+boolean\n\s+required:\s+false\n\s+default:\s+false/,
    );
  });

  it('keeps workflow preflight and helper names aligned with the manifest', () => {
    const workflow = read(WORKFLOW_PATH);
    const helper = read(PREFLIGHT_HELPER_PATH);

    expect(workflow).toContain(
      'run: bash tools/scripts/database/assert-backup-secrets.sh',
    );
    expect(extractRequiredSecretsFromHelper(helper)).toEqual(
      REQUIRED_SECRET_NAMES,
    );

    for (const secretName of REQUIRED_SECRET_NAMES) {
      expect(workflow).toContain(`${secretName}: ${secretExpression(secretName)}`);
    }

    expect(helper).not.toContain('eval ');
    expect(helper).not.toContain('${#missing[@]:-0}');
    expect(helper).toContain(
      'resolved Actions secrets for production-backup environment',
    );
  });

  it('maps secrets to ssh-action inputs or forwarded remote env vars only', () => {
    const workflow = read(WORKFLOW_PATH);
    const manifest = readManifest();
    const forwardedEnv = extractSshRuntimeEnvList(workflow);

    for (const secret of manifest.requiredSecrets) {
      if (secret.runtime.sshActionInput) {
        expect(workflow).toContain(
          `${secret.runtime.sshActionInput}: ${secretExpression(secret.name)}`,
        );
      }

      if (secret.runtime.remoteEnv) {
        expect(workflow).toContain(
          `${secret.runtime.remoteEnv}: ${secretExpression(secret.name)}`,
        );
        expect(forwardedEnv).toContain(secret.runtime.remoteEnv);
      }
    }
  });

  it('does not interpolate GitHub secrets inside the remote SSH script', () => {
    const workflow = read(WORKFLOW_PATH);
    const remoteScript = extractBackupSshScript(workflow);

    expect(remoteScript).not.toMatch(/\${{\s*secrets\./);
  });

  it('keeps dry-run as dump-only without swallowing script failures', () => {
    const workflow = read(WORKFLOW_PATH);
    const remoteScript = extractBackupSshScript(workflow);
    const backupScript = read(BACKUP_SCRIPT_PATH);

    expect(remoteScript).toContain('export BACKUP_DUMP_ONLY=true');
    expect(remoteScript).toContain(
      'bash tools/scripts/database/backup-databases.sh',
    );
    expect(remoteScript).not.toMatch(/\|\|\s*echo.*dry-run/i);
    expect(workflow).not.toMatch(/backup-databases\.sh\s*\|\|\s*echo/);

    expect(backupScript).toContain('BACKUP_DUMP_ONLY');
    expect(backupScript).toContain('skipping upload');
  });

  it('keeps docs aligned with the manifest and real restore evidence', () => {
    const restoreRunbook = read(RESTORE_RUNBOOK_PATH);
    const rotationRunbook = read(ROTATION_RUNBOOK_PATH);
    const postgresImageManifest = readPostgresImageManifest();

    for (const secretName of REQUIRED_SECRET_NAMES) {
      expect(restoreRunbook).toContain(`\`${secretName}\``);
    }

    expect(restoreRunbook).toContain(
      '.github/manifests/backup-secrets.json',
    );
    expect(restoreRunbook).toContain('Metadata.sha256');
    expect(restoreRunbook).toContain(postgresImageManifest.image);

    expect(rotationRunbook).toContain('production-backup');
    expect(rotationRunbook).toContain('dry_run: false');
    expect(rotationRunbook).toContain('Metadata.sha256');
  });

  it('is wired into invariants:fast via a selected Jest project', () => {
    const jestConfig = read(JEST_CONFIG_PATH);
    const layer1Start = jestConfig.indexOf("displayName: 'layer-1'");
    const layer3Start = jestConfig.indexOf("displayName: 'layer-3'");

    expect(layer1Start).toBeGreaterThanOrEqual(0);
    expect(layer3Start).toBeGreaterThan(layer1Start);

    const layer1Block = jestConfig.slice(layer1Start, layer3Start);
    expect(layer1Block).toContain(
      '<rootDir>/backup-production-secrets.spec.ts',
    );
  });
});
