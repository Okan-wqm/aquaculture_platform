import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const POLICY_PATH = join(REPO_ROOT, '.github/manifests/backup-ssh-broker-policy.json');
const BROKER_SOURCE_PATH = join(REPO_ROOT, 'tools/backup-ssh-broker/main.rs');
const BUILD_SCRIPT_PATH = join(REPO_ROOT, 'tools/scripts/ci/build-protected-ssh-broker.sh');
const PROVISIONER_PATH = join(REPO_ROOT, 'infrastructure/scripts/provision-backup-ssh-broker.sh');
const RESTORE_RUNBOOK_PATH = join(REPO_ROOT, 'docs/runbooks/database-restore-drill.md');
const RELEASE_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/backup-ssh-broker-release.yml');
const ATTEST_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/verify-backup-ssh-broker.yml');
const CI_AFFECTED_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/ci-affected.yml');
const REQUIRED_CHECKS_MANIFEST_PATH = join(
  REPO_ROOT,
  '.github/manifests/main-required-status-checks.json',
);
const BACKUP_SECRET_MANIFEST_PATH = join(REPO_ROOT, '.github/manifests/backup-secrets.json');

interface BrokerOperation {
  operation: string;
  account: string;
  forced_command: string;
  private_key_secret: string;
  public_key_fingerprint_variable: string;
}

interface BrokerPolicy {
  schema_version: number;
  finding_ids: string[];
  environment: string;
  release: {
    workflow: string;
    event: string;
    ref: string;
    signing_environment: string;
    signing_environment_protection: {
      can_admins_bypass: boolean;
      prevent_self_review: boolean;
      minimum_reviewers: number;
      deployment_branch: string;
    };
    required_checks_manifest: string;
    provenance_predicate_type: string;
    authority_predicate_type: string;
  };
  broker: {
    source: string;
    build_script: string;
    install_path: string;
    attestation_protocol: string;
    source_sha256: string;
  };
  shared_secrets: string[];
  operations: BrokerOperation[];
  cutover: {
    enabled: boolean;
    legacy_environment_secrets: string[];
    required_before_enable: string[];
  };
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function policy(): BrokerPolicy {
  return JSON.parse(read(POLICY_PATH)) as BrokerPolicy;
}

describe('protected backup SSH broker substrate', () => {
  it('pins one compiled broker source and three non-interchangeable authorities', () => {
    const contract = policy();

    expect(contract).toMatchObject({
      schema_version: 1,
      finding_ids: ['INFRA-CRITICAL-044'],
      environment: 'production-backup',
      shared_secrets: ['DROPLET_HOST', 'DROPLET_SSH_FINGERPRINT'],
      release: {
        workflow: '.github/workflows/backup-ssh-broker-release.yml',
        event: 'push',
        ref: 'refs/heads/main',
        signing_environment: 'production-backup-release',
        signing_environment_protection: {
          can_admins_bypass: false,
          prevent_self_review: true,
          minimum_reviewers: 2,
          deployment_branch: 'main',
        },
        required_checks_manifest: '.github/manifests/main-required-status-checks.json',
        provenance_predicate_type: 'aqua.protected-ssh-broker-build/v1',
        authority_predicate_type: 'aqua.protected-ssh-broker-release-authority/v1',
      },
      broker: {
        source: 'tools/backup-ssh-broker/main.rs',
        build_script: 'tools/scripts/ci/build-protected-ssh-broker.sh',
        install_path: '/usr/local/sbin/aqua-protected-ssh-broker',
        attestation_protocol: 'aqua-protected-ssh-attestation-v1',
      },
      cutover: {
        enabled: false,
        legacy_environment_secrets: ['DROPLET_USER', 'DROPLET_SSH_KEY'],
      },
    });
    expect(contract.broker.source_sha256).toBe(sha256(BROKER_SOURCE_PATH));
    expect(contract.operations).toEqual([
      {
        operation: 'backup',
        account: 'aqua-backup',
        forced_command: 'aqua-backup-v1',
        private_key_secret: 'BACKUP_BROKER_SSH_KEY',
        public_key_fingerprint_variable: 'BACKUP_BROKER_SSH_KEY_FINGERPRINT',
      },
      {
        operation: 'pitr',
        account: 'aqua-pitr',
        forced_command: 'aqua-pitr-v1',
        private_key_secret: 'PITR_BROKER_SSH_KEY',
        public_key_fingerprint_variable: 'PITR_BROKER_SSH_KEY_FINGERPRINT',
      },
      {
        operation: 'archive-freshness',
        account: 'aqua-wal-freshness',
        forced_command: 'aqua-wal-freshness-v1',
        private_key_secret: 'WAL_FRESHNESS_BROKER_SSH_KEY',
        public_key_fingerprint_variable: 'WAL_FRESHNESS_BROKER_SSH_KEY_FINGERPRINT',
      },
    ]);
    expect(new Set(contract.operations.map((item) => item.account)).size).toBe(3);
    expect(new Set(contract.operations.map((item) => item.forced_command)).size).toBe(3);
    expect(new Set(contract.operations.map((item) => item.private_key_secret)).size).toBe(3);
    expect(contract.cutover.required_before_enable).toContain(
      'signed release authority proving every required check succeeded on the exact merged pull request head SHA no later than its merge timestamp',
    );
    expect(contract.cutover.required_before_enable).toContain(
      'signed executable policy materials byte-identical to current protected main',
    );
    expect(contract.cutover.required_before_enable).toContain(
      'main-only signing environment with administrator bypass disabled, self-review prevention, and at least two eligible reviewers',
    );
  });

  it('keeps the substrate attestation-only until the atomic cutover contract is enabled', () => {
    const broker = read(BROKER_SOURCE_PATH);
    const backupSecrets = read(BACKUP_SECRET_MANIFEST_PATH);

    expect(broker).toContain('#![forbid(unsafe_code)]');
    expect(broker).toContain('broker accepts only login-shell -c mode');
    expect(broker).toContain('SSH_ORIGINAL_COMMAND');
    expect(broker).toContain('login account and fixed command do not map');
    expect(broker).toContain('aqua-protected-ssh-attestation-v1');
    expect(broker).toContain('/proc/self/status');
    expect(broker).toContain('/proc/self/fd/0');
    expect(broker).toContain('login-shell gid boundary is invalid');
    expect(broker).toContain('login account record does not match the protected boundary');
    expect(broker).not.toContain('Command::new("/bin/bash")');
    expect(broker).not.toContain('Command::new("/usr/bin/sudo")');
    expect(broker).not.toContain('/bin/bash --noprofile');
    expect(backupSecrets).not.toContain('BACKUP_BROKER_SSH_KEY');
    expect(backupSecrets).not.toContain('PITR_BROKER_SSH_KEY');
    expect(backupSecrets).not.toContain('WAL_FRESHNESS_BROKER_SSH_KEY');
  });

  it('builds a static ELF from a source snapshot and embeds both digests', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aqua-backup-ssh-broker-'));
    const outputPath = join(directory, 'broker');
    try {
      const result = spawnSync('bash', [BUILD_SCRIPT_PATH], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: directory,
          LC_ALL: 'C',
          OUTPUT_PATH: outputPath,
        },
      });
      expect(`${result.stdout}${result.stderr}`).toContain(
        `BROKER_SOURCE_SHA256=${sha256(BROKER_SOURCE_PATH)}`,
      );
      expect(`${result.stdout}${result.stderr}`).toMatch(/BROKER_BINARY_SHA256=[0-9a-f]{64}/);
      expect(result.status).toBe(0);

      const readelf = spawnSync('readelf', ['-l', '--', outputPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(readelf.status).toBe(0);
      expect(readelf.stdout).not.toContain('INTERP');
      const dynamic = spawnSync('readelf', ['-d', '--', outputPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(dynamic.status).toBe(0);
      expect(dynamic.stdout).not.toContain('(NEEDED)');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('provisions password-inert root-owned principals and no execution privilege', () => {
    const provisioner = read(PROVISIONER_PATH);
    const restoreRunbook = read(RESTORE_RUNBOOK_PATH);
    const bashEnvDirectory = mkdtempSync(join(tmpdir(), 'aqua-broker-bash-env-'));
    const bashEnvPath = join(bashEnvDirectory, 'probe.sh');
    writeFileSync(bashEnvPath, 'printf "BASH_ENV_EXECUTED\\n"; exit 99\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    const bashEnvProbe = spawnSync(PROVISIONER_PATH, [], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        BASH_ENV: bashEnvPath,
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      },
    });
    rmSync(bashEnvDirectory, { recursive: true, force: true });
    const inheritedFunctionProbe = spawnSync(PROVISIONER_PATH, [], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        'BASH_FUNC_unset%%': '() { printf "BASH_FUNCTION_EXECUTED\\n"; exit 98; }',
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      },
    });
    const commandPreflight = provisioner.indexOf('for required_command in');
    const cmpPreflight = provisioner.indexOf('cmp cp cut', commandPreflight);
    const inputSnapshot = provisioner.indexOf('# Each external input crosses the trust boundary');
    const mutationStart = provisioner.indexOf('MUTATION_STARTED=true');
    const maintenanceInstall = provisioner.indexOf(
      'mv -fT -- "${MAINTENANCE_DROPIN_PATH}.new" "${MAINTENANCE_DROPIN_PATH}"',
      mutationStart,
    );
    const maintenanceReload = provisioner.indexOf(
      'env -i PATH="${PATH}" LC_ALL=C systemctl reload ssh',
      maintenanceInstall,
    );
    const activeBrokerMutation = provisioner.indexOf(
      'create_protected_directory "${CONFIG_ROOT}"',
      maintenanceReload,
    );
    const maintenanceRemoval = provisioner.indexOf(
      'rm -f -- "${MAINTENANCE_DROPIN_PATH}"',
      activeBrokerMutation,
    );
    const finalPolicyValidation = provisioner.indexOf(
      'Final sshd policy still denies protected account',
      maintenanceRemoval,
    );
    const finalReload = provisioner.indexOf(
      'env -i PATH="${PATH}" LC_ALL=C systemctl reload ssh',
      maintenanceRemoval,
    );
    const committed = provisioner.indexOf('COMMITTED=true', finalReload);

    expect(provisioner.startsWith('#!/bin/bash -p\n')).toBe(true);
    expect(provisioner).toContain('invoke this root provisioner directly or with /bin/bash -p');
    expect(restoreRunbook).toContain('  /bin/bash -p \\\n');
    expect(restoreRunbook).toContain(
      'repository/infrastructure/scripts/provision-backup-ssh-broker.sh',
    );
    expect(bashEnvProbe.error).toBeUndefined();
    expect(bashEnvProbe.status).not.toBe(99);
    expect(`${bashEnvProbe.stdout}${bashEnvProbe.stderr}`).not.toContain('BASH_ENV_EXECUTED');
    expect(inheritedFunctionProbe.error).toBeUndefined();
    expect(inheritedFunctionProbe.status).not.toBe(98);
    expect(`${inheritedFunctionProbe.stdout}${inheritedFunctionProbe.stderr}`).not.toContain(
      'BASH_FUNCTION_EXECUTED',
    );
    expect(commandPreflight).toBeGreaterThan(0);
    expect(cmpPreflight).toBeGreaterThan(commandPreflight);
    expect(cmpPreflight).toBeLessThan(inputSnapshot);
    expect(cmpPreflight).toBeLessThan(mutationStart);
    expect(provisioner).toContain(
      'MAINTENANCE_DROPIN_PATH=/etc/ssh/sshd_config.d/89-aqua-protected-backup-maintenance.conf',
    );
    expect(provisioner).toContain('DenyUsers aqua-backup aqua-pitr aqua-wal-freshness');
    expect(provisioner).toContain('Reserved protected-account maintenance policy already exists');
    expect(provisioner).toContain('Maintenance sshd policy does not deny');
    expect(maintenanceInstall).toBeGreaterThan(mutationStart);
    expect(maintenanceReload).toBeGreaterThan(maintenanceInstall);
    expect(activeBrokerMutation).toBeGreaterThan(maintenanceReload);
    expect(maintenanceRemoval).toBeGreaterThan(activeBrokerMutation);
    expect(finalPolicyValidation).toBeGreaterThan(maintenanceRemoval);
    expect(finalReload).toBeGreaterThan(finalPolicyValidation);
    expect(committed).toBeGreaterThan(finalReload);
    expect(provisioner).toContain('EXPECTED_BROKER_SHA256');
    expect(provisioner).toContain('aqua-backup');
    expect(provisioner).toContain('aqua-pitr');
    expect(provisioner).toContain('aqua-wal-freshness');
    expect(provisioner).toContain('DisableForwarding yes');
    expect(provisioner).toContain('ForceCommand none');
    expect(provisioner).toContain("'forcecommand none'");
    expect(provisioner).toContain('ChrootDirectory none');
    expect(provisioner).toContain("'chrootdirectory none'");
    expect(provisioner).toContain("'allowtcpforwarding no'");
    expect(provisioner).toContain("'allowagentforwarding no'");
    expect(provisioner).toContain('PermitUserEnvironment no');
    expect(provisioner).toContain('PermitUserRC no');
    expect(provisioner).toContain('AuthorizedKeysCommand none');
    expect(provisioner).toContain('TrustedUserCAKeys none');
    expect(provisioner).toContain('MaxSessions 1');
    expect(provisioner).toContain('sshd -t');
    expect(provisioner).toContain('readelf');
    expect(provisioner).toContain("PASSWORD_SENTINEL='NP'");
    expect(provisioner).toContain('install -o root -g root -m 0644');
    expect(provisioner).toContain('env -i PATH="${PATH}" LC_ALL=C systemctl reload ssh');
    expect(provisioner).toContain('forbidden because it executes before the protected login shell');
    expect(provisioner).toContain('uses only these root-owned immutable snapshots');
    expect(provisioner).toContain('lookup_local_account_record');
    expect(provisioner).toContain('/etc/passwd /etc/group /etc/shadow');
    expect(provisioner).toContain('A non-local NSS identity collides');
    expect(provisioner).toContain('GID is not unique in local group');
    expect(provisioner).toContain('primary GID is shared in local passwd');
    expect(provisioner).not.toContain('passwd --lock');
    expect(provisioner).not.toMatch(/usermod\s+-aG\s+(?:docker|sudo)|NOPASSWD|\/etc\/sudoers/);
  });

  it('publishes a signed release and keeps every live attestation key isolated', () => {
    const release = read(RELEASE_WORKFLOW_PATH);
    const attest = read(ATTEST_WORKFLOW_PATH);
    const ciAffected = read(CI_AFFECTED_WORKFLOW_PATH);
    const requiredChecks = read(REQUIRED_CHECKS_MANIFEST_PATH);
    const contract = policy();

    expect(release).toContain('bash tools/scripts/ci/build-protected-ssh-broker.sh');
    expect(release).toContain('cosign sign-blob --yes');
    expect(release).toContain('cosign verify-blob');
    expect(release).toContain('overwrite: false');
    expect(release).toContain('id-token: write');
    expect(release).toContain('actions: read');
    expect(release).toContain('name: production-backup-release');
    expect(release).toContain('.can_admins_bypass == false');
    expect(release).toContain('(.reviewers | length) >= 2');
    expect(release).toContain('/commits/${GITHUB_SHA}/pulls?per_page=100');
    expect(release).toContain('/commits/${PR_HEAD_SHA}/check-runs?filter=all&per_page=100');
    expect(release).toContain(
      '(.completed_at | fromdateiso8601) <= ($merged_at | fromdateiso8601)',
    );
    expect(release).toContain('role: "release-workflow"');
    expect(release).toContain('.github/workflows/ci-affected.yml');
    expect(release).toContain('.github/workflows/aria-merge-authority.yml');
    expect(release).toContain('aqua.protected-ssh-broker-release-authority/v1');
    expect(attest).toContain('test "${GITHUB_REF}" = \'refs/heads/main\'');
    expect(attest).toContain('environment:');
    expect(attest).toContain('name: production-backup');
    expect(attest).toContain('aqua-protected-ssh-attestation-v1');
    expect(attest).toContain('inputs.release_run_id');
    expect(attest).toContain('inputs.release_artifact_id');
    expect(attest).toContain('inputs.release_artifact_digest');
    expect(attest).toContain('Verify signed provenance, authority, and exact materials');
    expect(attest).toContain('cosign verify-blob');
    expect(attest).toContain('Cross-account denial returned SSH exit ${ssh_status}');
    expect(attest).toContain('Wrong-token denial returned SSH exit ${ssh_status}');
    expect(attest).toContain('Ancestor status alone permits rollback');
    expect(attest).toContain('assert_boundary_denial 255 pty');
    expect(attest).toContain('assert_boundary_denial 2 subsystem');
    expect(attest).toContain('assert_boundary_denial 255 remote-forward');
    expect(attest).toContain('assert_boundary_denial 255 direct-stream');
    expect(attest).not.toContain('BACKUP_BROKER_SOURCE_SHA256');
    expect(attest).not.toContain('BACKUP_BROKER_BINARY_SHA256');
    for (const protectedPath of [
      '.github/workflows/**',
      'infrastructure/scripts/**',
      'tools/backup-ssh-broker/**',
      'tests/**',
    ]) {
      expect(ciAffected).toContain(`'${protectedPath}'`);
      expect(requiredChecks).toContain(`"${protectedPath}"`);
    }

    for (const operation of contract.operations) {
      expect(attest).toContain(`secrets.${operation.private_key_secret}`);
      expect(attest).toContain(`vars.${operation.public_key_fingerprint_variable}`);
      expect(attest).toContain(operation.account);
      expect(attest).toContain(operation.forced_command);
    }
    expect(attest).not.toContain('DROPLET_SSH_KEY');
    expect(attest).not.toContain('appleboy/ssh-action');
    expect(attest).not.toContain('/bin/bash -s');
  });
});
