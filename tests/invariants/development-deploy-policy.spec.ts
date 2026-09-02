import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '..', '..');
const POLICY_PATH = join(REPO_ROOT, 'scripts', 'deploy', 'lib', 'deployment-mode-policy.sh');

interface PolicyResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runPolicy(command: string, env: Record<string, string>): PolicyResult {
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nsource "$POLICY_PATH"\n${command}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      POLICY_PATH,
      ...env,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('development deployment mode policy', () => {
  it('plans a full development image selection as an application-only rollout', () => {
    const result = runPolicy(
      [
        'validate_data_infrastructure_policy',
        'configure_preserved_compose_interpolation',
        'if deploy_uses_full_stack_path; then full_stack=true; else full_stack=false; fi',
        `printf 'full_stack=%s\n' "$full_stack"`,
        `printf 'pull=%s\n' "$(rollout_image_services | xargs)"`,
        `printf 'restart=%s\n' "$(restartable_deploy_services | xargs)"`,
        `printf 'walg=%s|%s|%s|%s\n' "$WALG_BACKUP_EPOCH" "$WALG_SPACES_BUCKET" "$SPACES_ENDPOINT" "$SPACES_REGION"`,
      ].join('\n'),
      {
        DEPLOY_MODE: 'development',
        PRESERVE_DATA_INFRASTRUCTURE: 'true',
        FULL_DEPLOY: 'true',
        DEPLOY_SERVICES: 'postgres db-migrate farm-service shell mosquitto',
        INFRA_IMAGE_SERVICES: 'postgres mosquitto',
        WALG_BACKUP_EPOCH: '',
        WALG_SPACES_BUCKET: '',
        SPACES_ENDPOINT: '',
        SPACES_REGION: '',
      },
    );

    expect(result).toEqual({
      status: 0,
      stderr: '',
      stdout: [
        'full_stack=false',
        'pull=db-migrate farm-service shell',
        'restart=farm-service shell',
        'walg=development-preserved|development-preserved|https://development-preserved.invalid|development-preserved',
        '',
      ].join('\n'),
    });
  });

  it('retains the destructive full-stack path for an explicit production full deploy', () => {
    const result = runPolicy(
      [
        'validate_data_infrastructure_policy',
        'if deploy_uses_full_stack_path; then full_stack=true; else full_stack=false; fi',
        `printf 'full_stack=%s\n' "$full_stack"`,
        `printf 'pull=%s\n' "$(rollout_image_services | xargs)"`,
      ].join('\n'),
      {
        DEPLOY_MODE: 'production',
        PRESERVE_DATA_INFRASTRUCTURE: 'false',
        FULL_DEPLOY: 'true',
        DEPLOY_SERVICES: 'postgres db-migrate farm-service mosquitto',
        INFRA_IMAGE_SERVICES: 'postgres mosquitto',
      },
    );

    expect(result).toEqual({
      status: 0,
      stderr: '',
      stdout: 'full_stack=true\npull=postgres db-migrate farm-service mosquitto\n',
    });
  });

  it.each([
    {
      name: 'development without preservation',
      env: { DEPLOY_MODE: 'development', PRESERVE_DATA_INFRASTRUCTURE: 'false' },
      error: 'development deploys must preserve data infrastructure',
    },
    {
      name: 'production with preservation',
      env: { DEPLOY_MODE: 'production', PRESERVE_DATA_INFRASTRUCTURE: 'true' },
      error: 'data infrastructure preservation is restricted to development deploys',
    },
    {
      name: 'invalid boolean',
      env: { DEPLOY_MODE: 'development', PRESERVE_DATA_INFRASTRUCTURE: 'sometimes' },
      error: 'PRESERVE_DATA_INFRASTRUCTURE must be exactly true or false',
    },
  ])('rejects unsafe mode pairing: $name', ({ env, error }) => {
    const result = runPolicy('validate_data_infrastructure_policy', {
      FULL_DEPLOY: 'true',
      DEPLOY_SERVICES: 'farm-service',
      INFRA_IMAGE_SERVICES: 'postgres mosquitto',
      ...env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });

  it('does not replace provisioned WAL-G coordinates in production or development', () => {
    const result = runPolicy(
      [
        'validate_data_infrastructure_policy',
        'configure_preserved_compose_interpolation',
        `printf '%s|%s|%s|%s\n' "$WALG_BACKUP_EPOCH" "$WALG_SPACES_BUCKET" "$SPACES_ENDPOINT" "$SPACES_REGION"`,
      ].join('\n'),
      {
        DEPLOY_MODE: 'development',
        PRESERVE_DATA_INFRASTRUCTURE: 'true',
        FULL_DEPLOY: 'false',
        DEPLOY_SERVICES: 'farm-service',
        INFRA_IMAGE_SERVICES: 'postgres mosquitto',
        WALG_BACKUP_EPOCH: 'epoch-20260716-001',
        WALG_SPACES_BUCKET: 'aqua-backups',
        SPACES_ENDPOINT: 'https://ams3.digitaloceanspaces.com',
        SPACES_REGION: 'ams3',
      },
    );

    expect(result).toEqual({
      status: 0,
      stderr: '',
      stdout: 'epoch-20260716-001|aqua-backups|https://ams3.digitaloceanspaces.com|ams3\n',
    });
  });

  it('retains WAL-G coordinates provisioned only in the persistent env file', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aqua-walg-coordinates-'));
    const envFile = join(fixture, '.env');
    writeFileSync(
      envFile,
      [
        'WALG_BACKUP_EPOCH=epoch-from-file',
        'WALG_SPACES_BUCKET=file-backups',
        'SPACES_ENDPOINT=https://fra1.digitaloceanspaces.com',
        'SPACES_REGION=fra1',
        '',
      ].join('\n'),
    );

    try {
      const result = runPolicy(
        [
          'validate_data_infrastructure_policy',
          'configure_preserved_compose_interpolation "$ENV_FILE"',
          `printf '%s|%s|%s|%s\n' "$WALG_BACKUP_EPOCH" "$WALG_SPACES_BUCKET" "$SPACES_ENDPOINT" "$SPACES_REGION"`,
        ].join('\n'),
        {
          DEPLOY_MODE: 'development',
          PRESERVE_DATA_INFRASTRUCTURE: 'true',
          FULL_DEPLOY: 'false',
          DEPLOY_SERVICES: 'farm-service',
          INFRA_IMAGE_SERVICES: 'postgres mosquitto',
          WALG_BACKUP_EPOCH: '',
          WALG_SPACES_BUCKET: '',
          SPACES_ENDPOINT: '',
          SPACES_REGION: '',
          ENV_FILE: envFile,
        },
      );

      expect(result).toEqual({
        status: 0,
        stderr: '',
        stdout: 'epoch-from-file|file-backups|https://fra1.digitaloceanspaces.com|fra1\n',
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('proves preserved migration infrastructure healthy using read-only inspect calls', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aqua-preserved-infra-'));
    const dockerLog = join(fixture, 'docker.log');
    const docker = join(fixture, 'docker');
    writeFileSync(
      docker,
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\ncontainer="\${!#}"\nif [ "\${UNHEALTHY_CONTAINER:-}" = "$container" ]; then\n  printf 'true unhealthy\\n'\nelse\n  printf 'true healthy\\n'\nfi\n`,
    );
    chmodSync(docker, 0o755);

    try {
      const result = runPolicy('assert_preserved_migration_infrastructure', {
        DEPLOY_MODE: 'development',
        PRESERVE_DATA_INFRASTRUCTURE: 'true',
        FULL_DEPLOY: 'true',
        DEPLOY_SERVICES: 'db-migrate farm-service',
        INFRA_IMAGE_SERVICES: 'postgres mosquitto',
        DOCKER_LOG: dockerLog,
        PATH: `${fixture}:${process.env.PATH ?? ''}`,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(readFileSync(dockerLog, 'utf8').trim().split('\n')).toEqual([
        'inspect --format={{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} aqua-postgres',
        'inspect --format={{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} aqua-redis',
        'inspect --format={{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} aqua-minio',
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('fails before rollout when a preserved dependency is unhealthy', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aqua-unhealthy-infra-'));
    const docker = join(fixture, 'docker');
    writeFileSync(
      docker,
      `#!/usr/bin/env bash\nset -euo pipefail\ncontainer="\${!#}"\nif [ "$container" = aqua-redis ]; then\n  printf 'true unhealthy\\n'\nelse\n  printf 'true healthy\\n'\nfi\n`,
    );
    chmodSync(docker, 0o755);

    try {
      const result = runPolicy('assert_preserved_migration_infrastructure', {
        DEPLOY_MODE: 'development',
        PRESERVE_DATA_INFRASTRUCTURE: 'true',
        FULL_DEPLOY: 'true',
        DEPLOY_SERVICES: 'db-migrate farm-service',
        INFRA_IMAGE_SERVICES: 'postgres mosquitto',
        PATH: `${fixture}:${process.env.PATH ?? ''}`,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Preserved infrastructure container aqua-redis is not healthy',
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
