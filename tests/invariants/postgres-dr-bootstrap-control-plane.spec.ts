import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const POLICY_PATH = '.github/manifests/postgres-dr-bootstrap-policy.json';
const WORKFLOW_PATH = '.github/workflows/postgres-dr-bootstrap-candidate.yml';
const PROVIDER_SCRIPT_PATH = 'infrastructure/scripts/provider-console-bootstrap-postgres-walg.sh';
const STATE_HELPER_PATH = 'infrastructure/scripts/postgres-dr-bootstrap-state.sh';
const COORDINATOR_PATH = 'infrastructure/scripts/postgres-dr-coordinator.sh';
const CHECK_SELECTOR_PATH = '.github/scripts/select-effective-required-check.jq';
const CHECK_FIXTURE_PATH =
  'tests/invariants/fixtures/postgres-dr-bootstrap/check-runs-older-success-newer-failure.json';
const CANDIDATE_PREDICATE_TYPE =
  'https://github.com/Okan-wqm/aquaculture_platform/attestations/postgres-dr-bootstrap-candidate/v1';
const AUTHORITY_PREDICATE_TYPE =
  'https://github.com/Okan-wqm/aquaculture_platform/attestations/postgres-dr-bootstrap-release-authority/v1';

function read(path: string): string {
  const source = readFileSync(join(REPO_ROOT, path), 'utf8');
  return path === PROVIDER_SCRIPT_PATH
    ? `${source}\n${readFileSync(join(REPO_ROOT, COORDINATOR_PATH), 'utf8')}`
    : source;
}

function jobBlock(workflow: string, job: string, nextJob?: string): string {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  const end = nextJob === undefined ? workflow.length : workflow.indexOf(`\n  ${nextJob}:\n`);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

function selectEffectiveCheck(checks: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'aqua-check-selector-'));
  const inputPath = join(directory, 'checks.json');
  writeFileSync(inputPath, JSON.stringify(checks));
  try {
    return spawnSync(
      'jq',
      [
        '--from-file',
        join(REPO_ROOT, CHECK_SELECTOR_PATH),
        '--exit-status',
        '--arg',
        'context',
        'merge-gate',
        '--arg',
        'head_sha',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '--arg',
        'merged_at',
        '2026-07-17T10:30:00Z',
        '--arg',
        'details_prefix',
        'https://github.com/Okan-wqm/aquaculture_platform/actions/runs/',
        '--argjson',
        'app_id',
        '15368',
        inputPath,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('PostgreSQL DR bootstrap control plane', () => {
  it('declares one provider-console, postgres-only authority', () => {
    const policy = JSON.parse(read(POLICY_PATH)) as {
      schema_version: number;
      finding_ids: string[];
      does_not_close_findings: string[];
      release: Record<string, unknown>;
      build_boundary: Record<string, unknown>;
      bootstrap: Record<string, unknown>;
    };

    expect(policy).toEqual(
      expect.objectContaining({
        schema_version: 2,
        finding_ids: ['INFRA-HIGH-073'],
        does_not_close_findings: ['INFRA-HIGH-033'],
        release: expect.objectContaining({
          workflow: WORKFLOW_PATH,
          event: 'workflow_dispatch',
          ref: 'refs/heads/main',
          explicit_main_sha_input: 'main_sha',
          protected_ref_signal: 'github.ref_protected',
          signing_environment: 'production-backup-release',
          live_environment_authority_snapshot_required: true,
          live_branch_protection_snapshot_required: true,
          required_check_selector: CHECK_SELECTOR_PATH,
          required_check_effective_order: 'created_at_then_id_as_of_merge',
          required_check_creation_authority: 'actions_job.created_at',
          required_check_workflow_path_binding: true,
          required_check_job_attempt_binding: true,
          cosign_version: 'v3.0.6',
          cosign_linux_amd64_sha256:
            'c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74',
          required_checks_manifest: '.github/manifests/main-required-status-checks.json',
          image_repository: 'ghcr.io/okan-wqm/aquaculture_platform/postgres',
          immutable_tag_template: '<main_sha>-<run_id>-<run_attempt>',
          mutable_tags: [],
        }),
        build_boundary: {
          environment: null,
          production_secrets: [],
          ssh_enabled: false,
          deployment_enabled: false,
        },
        bootstrap: expect.objectContaining({
          channel: 'provider-console',
          script: PROVIDER_SCRIPT_PATH,
          compose_file: 'docker-compose.droplet.yml',
          rollback_compose_override:
            'infrastructure/deploy/postgres-dr-bootstrap-rollback.override.yml',
          compose_project: 'aqua-saas',
          compose_interpolation_tag_source: 'expected_main_sha',
          allowed_compose_services: ['postgres'],
          legacy_github_ssh_enabled: false,
          requires_production_deploy_unlock: false,
          repository_variable_mutation_enabled: false,
          tag_mutation_enabled: false,
          pre_execution_signature_verification_required: true,
          global_nonblocking_lock_required: true,
          pinned_host_paths: {
            deploy_root: '<release_root>/repository',
            config_generations_root: '/var/lib/aqua/deploy/config-generations',
            deploy_env_file: '/var/aqua-saas/.env',
            state_root: '/var/lib/aqua/deploy/dr-bootstrap',
            control_plane_lock: '/var/lib/aqua/deploy/control-plane.lock',
          },
          shared_control_plane_lock: {
            mode: 'exclusive-nonblocking',
            held_from_before_supply_chain_pull_through_terminal_state: true,
          },
          state_machine: {
            helper: STATE_HELPER_PATH,
            schema_version: 2,
            modes: ['healthy_upgrade', 'degraded_legacy_recovery'],
            recovery_helper: 'infrastructure/scripts/postgres-dr-recovery.sh',
            coordinator_helper: 'infrastructure/scripts/postgres-dr-coordinator.sh',
            verified_cold_copy_required: true,
            baseline: 'signed_candidate_walg_disabled_on_isolated_copy',
            writer_quiescence: 'record_and_stop_existing_compose_containers',
            durable_phases: [
              'VERIFYING',
              'PREPARED',
              'FORWARD_STARTED',
              'ROLLBACK_STARTED',
              'ROLLED_BACK',
              'COMMITTED',
              'RECOVERY_REQUIRED',
              'FINALIZING',
              'ROLLBACK_FINALIZING',
            ],
            exact_prior_recovery_required: true,
            power_loss_reentry_required: true,
            reentry_after_rollback: 'require_new_signed_run_attempt',
          },
          signed_init_directory: 'infrastructure/docker/init-scripts',
          release_root_safe_path_pattern: '^/[A-Za-z0-9._/-]+$',
          rendered_init_mount_assertion_required: true,
          registry_pull: {
            mode: 'anonymous-public-only',
            docker_config_path: '/etc/aqua/dr-bootstrap-public-registry/config.json',
            credential_entries_allowed: false,
          },
          provider_cosign: {
            path: '/usr/local/bin/cosign',
            version: 'v3.0.6',
            sha256: 'c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74',
            root_owned_nonwritable: true,
          },
        }),
      }),
    );
    expect(policy.release).toEqual(
      expect.objectContaining({
        signing_environment_protection: {
          can_admins_bypass: false,
          prevent_self_review: true,
          minimum_reviewers: 2,
          deployment_branch: 'main',
        },
        candidate_predicate_type: CANDIDATE_PREDICATE_TYPE,
        authority_predicate_type: AUTHORITY_PREDICATE_TYPE,
      }),
    );
    const requiredChecks = JSON.parse(
      read('.github/manifests/main-required-status-checks.json'),
    ) as {
      required_status_checks: {
        contexts: string[];
        checks: Array<{ context: string; app_id: number }>;
      };
    };
    // What this workflow depends on is that every required check is produced by
    // one known app, so `select-effective-required-check.jq` can pick the
    // effective run by producer identity rather than by name. Asserting the
    // exact list instead would re-pin a snapshot: adding a fourth context
    // (`build-status`, commit 39bc9471b) already invalidated the previous one,
    // even though the property the workflow relies on never changed.
    expect(requiredChecks.required_status_checks.checks.length).toBeGreaterThan(0);
    expect(
      requiredChecks.required_status_checks.checks.every(({ app_id }) => app_id === 15368),
    ).toBe(true);
    expect(
      requiredChecks.required_status_checks.checks.map(({ context }) => context).sort(),
    ).toEqual([...requiredChecks.required_status_checks.contexts].sort());
  });

  it('allows only an explicit dispatch for the exact current protected main SHA', () => {
    const workflow = read(WORKFLOW_PATH);
    const trigger = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));
    const authorize = jobBlock(workflow, 'authorize-main', 'build');
    const build = jobBlock(workflow, 'build', 'sign');
    const sign = jobBlock(workflow, 'sign');

    expect(trigger).toContain('workflow_dispatch:');
    expect(trigger).toContain('main_sha:');
    expect(trigger).not.toMatch(/\n\s+(push|schedule|workflow_call|pull_request):/);
    for (const block of [authorize, build, sign]) {
      expect(block).toContain('test "${GITHUB_REF}" = refs/heads/main');
      expect(block).toContain('test "${REF_PROTECTED}" = true');
      expect(block).toContain('"${GITHUB_REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main"');
      expect(block).toContain('test "${GITHUB_WORKFLOW_SHA}" = "${REQUESTED_MAIN_SHA}"');
      expect(block).toContain('refs/heads/main:refs/remotes/origin/main');
      expect(block).toContain(
        'test "$(git rev-parse refs/remotes/origin/main)" = "${REQUESTED_MAIN_SHA}"',
      );
    }
    expect(authorize).toContain('REF_PROTECTED: ${{ github.ref_protected }}');
    expect(authorize).toContain('.commit.verification.verified == true');
    expect(authorize).toContain('/check-runs?filter=all&per_page=100');
    expect(sign).toContain('/environments/production-backup-release');
    expect(sign).toContain('(.reviewers | length) >= 2');
    expect(sign).toContain('.prevent_self_review == true');
    expect(workflow.match(/jq --from-file "\$\{REQUIRED_CHECK_SELECTOR\}"/g)).toHaveLength(2);
    expect(workflow.match(/\/branches\/main\/protection/g)?.length).toBeGreaterThanOrEqual(3);
    expect(workflow).toContain('/actions/jobs/${WORKFLOW_JOB_ID}');
    expect(workflow.match(/\/actions\/jobs\/\$\{CANDIDATE_JOB_ID\}/g)).toHaveLength(2);
    expect(workflow.match(/\.created_at == \$check\[0\]\.created_at/g)).toHaveLength(2);
    expect(workflow).toContain('/actions/runs/${WORKFLOW_RUN_ID}/attempts/${WORKFLOW_RUN_ATTEMPT}');
    expect(workflow).toContain('test "${CHECK_RUN_ID}" = "${WORKFLOW_JOB_ID}"');
    expect(workflow).toContain('sort_by(.context, .app_id)');
    expect(workflow).toContain('checks: ([.required_status_checks.checks[] | {context, app_id}]');
    expect(workflow).not.toContain('.required_status_checks.contexts +');
    expect(
      workflow.match(/contexts: \(\.required_status_checks\.contexts \| sort\)/g),
    ).toHaveLength(3);
    expect(read(CHECK_SELECTOR_PATH)).toContain('.app.id == $app_id');
    expect(sign).toContain("'.required_status_checks.contexts | sort'");
    expect(sign).toContain("'[.[].name] | sort'");
    expect(sign).toContain('signing_environment_protection: $environment_authority[0]');
    expect(sign).toContain('required_checks_manifest:');
    expect(sign).toContain('dispatch_workflow:');
    expect(sign).not.toContain('test "$(jq \'length\' "${VERIFIED_CHECKS}")" -eq 3');
  });

  it('keeps the build non-production and publishes one immutable image coordinate', () => {
    const workflow = read(WORKFLOW_PATH);
    const build = jobBlock(workflow, 'build', 'sign');

    expect(build).not.toMatch(/\n\s{4}environment:/);
    expect(build).not.toContain('${{ secrets.');
    expect(build).not.toContain('DROPLET_');
    expect(build).not.toContain('ssh-action');
    expect(build).not.toContain('run-protected-ssh');
    expect(build).toContain('file: infrastructure/docker/Dockerfile.postgres-walg');
    expect(build).toContain(
      'tags: ${{ env.IMAGE_REPOSITORY }}:${{ steps.coordinates.outputs.immutable_tag }}',
    );
    expect(build).toContain('"${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"');
    expect(build).toContain('image_digest: ${{ steps.build.outputs.digest }}');
    expect(build).not.toContain(':latest');
    expect(build).not.toContain('cache-to:');
  });

  it('signs and attests after protected review without deploying', () => {
    const workflow = read(WORKFLOW_PATH);
    const sign = jobBlock(workflow, 'sign');

    expect(sign).toContain('name: production-backup-release');
    expect(sign).toContain('deployment: false');
    expect(sign).toContain('id-token: write');
    expect(sign).toContain('cosign sign --yes "${IMAGE_REF}"');
    expect(sign).toContain('cosign attest --yes');
    expect(sign).toContain('cosign-release: v3.0.6');
    expect(sign).toContain('c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74');
    expect(sign).toContain(
      'test "$(cosign version 2>/dev/null | awk \'$1 == "GitVersion:" {print $2}\')" = v3.0.6',
    );
    expect(sign).toContain('--type "${CANDIDATE_PREDICATE_TYPE}"');
    expect(sign).toContain('require_current_main()');
    expect(sign).toContain('"/repos/${GITHUB_REPOSITORY}/git/ref/heads/main"');
    expect(sign.match(/require_current_main\n/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sign.indexOf('require_current_main\n          cosign sign --yes')).toBeGreaterThan(0);
    expect(workflow).toContain(`CANDIDATE_PREDICATE_TYPE: ${CANDIDATE_PREDICATE_TYPE}`);
    expect(workflow).not.toContain('aqua.postgres-dr-bootstrap-candidate/v1');
    expect(sign).toContain('--bundle "${SUBJECT}.sigstore.json"');
    expect(sign).toContain('release-signed/candidate.json');
    expect(sign).toContain('release-signed/release-authority.json');
    expect(sign).not.toContain('docker compose');
    expect(sign).not.toContain('docker exec');
    expect(sign).not.toContain('ssh-action');
    expect(sign).not.toContain('PRODUCTION_DEPLOY_ENABLED');
  });

  it('verifies the signed candidate before one digest-only postgres recreation', () => {
    const script = read(PROVIDER_SCRIPT_PATH);
    const rollbackCompose = read(
      'infrastructure/deploy/postgres-dr-bootstrap-rollback.override.yml',
    );
    const verification = script.indexOf('cosign verify-blob');
    const imageVerification = script.indexOf('cosign verify \\');
    const mutation = script.indexOf('PREPARED FORWARD_STARTED');

    expect(script.startsWith('#!/bin/bash -p\n')).toBe(true);
    expect(statSync(join(REPO_ROOT, PROVIDER_SCRIPT_PATH)).mode & 0o111).toBe(0o111);
    expect(verification).toBeGreaterThan(0);
    expect(imageVerification).toBeGreaterThan(verification);
    expect(mutation).toBeGreaterThan(imageVerification);
    expect(script).toContain('IMAGE_REF="${IMAGE_REPOSITORY}@${EXPECTED_IMAGE_DIGEST}"');
    expect(script).toContain('render_image_override "${FORWARD_OVERRIDE}" "${IMAGE_REF}"');
    expect(script).toContain('${SIGNED_INIT_DIRECTORY}');
    expect(script).toContain('allowed_compose_services == ["postgres"]');
    expect(
      script.match(/up -d --no-deps --no-build --force-recreate --pull never postgres/g),
    ).toHaveLength(2);
    expect(script).toContain('PRIOR_IMAGE_ID=$(docker inspect --format');
    expect(script).toContain(
      'rollback_container_id=$(verify_active_exact_image "${prior_image_id}" false)',
    );
    expect(script).toContain('-f "${SIGNED_ROLLBACK_COMPOSE_PATH}"');
    expect(script).not.toContain('-f "${DEPLOY_ROOT}/docker-compose.droplet.yml"');
    expect(script).toContain('unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG');
    expect(script).toContain('unset COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES');
    expect(script).toContain('export DOCKER_HOST=unix:///var/run/docker.sock');
    expect(script).toContain('export TAG="${EXPECTED_MAIN_SHA}"');
    expect(script).toContain('DEPLOY_ROOT="${RELEASE_ROOT}/repository"');
    expect(script).toContain('DEPLOY_ENV_FILE=/var/aqua-saas/.env');
    expect(script).toContain('STATE_ROOT=/var/lib/aqua/deploy/dr-bootstrap');
    expect(script).toContain('CONTROL_PLANE_LOCK_PATH=/var/lib/aqua/deploy/control-plane.lock');
    expect(script).toContain('require_compose_safe_absolute_path "${RELEASE_ROOT}"');
    expect(script).toContain('^/[A-Za-z0-9._/-]+$');
    expect(script).toContain('assert_rendered_signed_init_mount()');
    expect(script).toContain('$init_mounts[0].source == $signed_init_directory');
    expect(script).toContain('.target | startswith($init_target + "/")');
    expect(script).toContain('$init_mounts[0].target == $init_target');
    expect(script).toContain('$init_mounts[0].read_only == true');
    expect(script.match(/config --format json/g)).toHaveLength(2);
    expect(script).not.toMatch(/^DEPLOY_ROOT=\$\{/m);
    expect(script).not.toMatch(/^DEPLOY_ENV_FILE=\$\{/m);
    expect(script).not.toMatch(/^STATE_ROOT=\$\{/m);
    expect(script).not.toMatch(/^CONTROL_PLANE_LOCK_PATH=\$\{/m);
    expect(script).not.toContain('export DOCKER_CONTEXT=default');
    expect(script).toContain('exec /usr/bin/env -i');
    expect(script).toContain('Unexpected inherited environment variable');
    expect(script).toContain('[ "${COSIGN_PATH}" = /usr/local/bin/cosign ]');
    expect(script).toContain('= v3.0.6 ] || \\');
    expect(script).toContain('c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74');
    expect(script).toContain('\'type == "object" and keys == ["auths"] and .auths == {}\'');
    expect(script).toContain('export DOCKER_CONFIG="${PUBLIC_DOCKER_CONFIG_ROOT}"');
    expect(script).toContain('require_root_owned_nonwritable_file "${DEPLOY_ENV_FILE}"');
    expect(script).toContain('REQUESTED_DEPLOY_ENV_FILE=${DEPLOY_ENV_FILE}');
    expect(script).toContain('[ "${DEPLOY_ENV_FILE}" = "${REQUESTED_DEPLOY_ENV_FILE}" ]');
    expect(script).toContain('require_root_owned_nonwritable_file "${secret_path}"');
    expect(script).toContain('resolve_root_owned_nonwritable_directory_chain()');
    expect(script).toContain('DEPLOY_ROOT_ID=$(stat -c');
    expect(script).toContain('RELEASE_ROOT_ID=$(stat -c');
    expect(script).toContain('WALG_SECRET_DIR_ID=$(stat -c');
    expect(script).toContain('STATE_ROOT_ID=$(stat -c');
    expect(script).toContain('require_unchanged_symlink_target()');
    expect(script).toContain(
      'require_unchanged_directory_identity "${CERTS_REAL_ROOT}" "${CERTS_REAL_ROOT_ID}" CERTS_ROOT',
    );
    expect(
      script.match(/require_unchanged_directory_identity "\$\{[^}]+\}"/g)?.length,
    ).toBeGreaterThanOrEqual(6);
    expect(script).toContain('cmp --silent "${EXECUTING_SCRIPT}" "${SIGNED_EXECUTOR_PATH}"');
    expect(script.match(/cmp --silent "\$\{EXECUTING_SCRIPT\}"/g)).toHaveLength(2);
    expect(script).toContain('matching_attestations=$((matching_attestations + 1))');
    expect(script).toContain('--slurpfile required_manifest "${REQUIRED_CHECKS_PATH}"');
    expect(script).toContain('([.required_checks[].name] | sort) ==');
    expect(script).not.toContain('(.required_checks | length) == 3');
    expect(script).toContain('.signing_environment_protection.reviewers');
    expect(script).toContain(CANDIDATE_PREDICATE_TYPE);
    expect(script).toContain(AUTHORITY_PREDICATE_TYPE);
    expect(script).toContain('/usr/local/bin/postgres-walg-healthcheck.sh >/dev/null');
    expect(script).toContain('dr_state_validate_any "${recorded_state_path}"');
    expect(script).toContain('dr_state_transition \\');
    expect(script).toContain('recover_exact_prior');
    expect(script).toContain(
      "die 'Exact-prior recovery completed; a new signed run attempt is required.'",
    );
    expect(script).toContain('sync -f "${STATE_DIR}"');
    expect(script.indexOf('flock --exclusive --nonblock "${CONTROL_PLANE_LOCK_FD}"')).toBeLessThan(
      script.lastIndexOf('verify_candidate_supply_chain'),
    );
    expect(script).not.toContain('MUTATION_STARTED=');
    expect(script).not.toContain('COMMITTED=true');
    expect(script).not.toContain('docker tag');
    expect(script).not.toContain('docker login');
    expect(script).not.toContain(':latest');
    expect(script).not.toContain('db-migrate');
    expect(script).not.toContain('PRODUCTION_DEPLOY_ENABLED');
    expect(script).not.toContain('DROPLET_SSH_KEY');
    expect(script).not.toMatch(/\b(ssh|scp|sftp|curl|wget|gh)\b/);
    expect(rollbackCompose).toContain("WALG_ENABLED: 'off'");
    expect(rollbackCompose).toContain('${DR_BOOTSTRAP_RELEASE_ROOT:?');
    expect(rollbackCompose).toContain('target: /docker-entrypoint-initdb.d');
    expect(rollbackCompose.match(/read_only: true/g)).toHaveLength(1);
    expect(rollbackCompose).not.toContain('target: /usr/local/bin/postgres-ssl-entrypoint.sh');
    expect(rollbackCompose).not.toContain('db-migrate');
    expect(rollbackCompose).not.toContain('gateway-api');
  });

  it('rejects unsafe release roots and every nested init-mount injection', () => {
    const provider = read(PROVIDER_SCRIPT_PATH);
    const pathProbe = [
      shellFunction(provider, 'die'),
      shellFunction(provider, 'require_canonical_absolute_path'),
      shellFunction(provider, 'require_compose_safe_absolute_path'),
      'require_compose_safe_absolute_path "$1"',
    ].join('\n');
    const runPathProbe = (path: string) =>
      spawnSync('bash', ['-c', pathProbe, 'release-root-probe', path], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });

    expect(runPathProbe('/root/postgres-dr-bootstrap/release_1.0').status).toBe(0);
    for (const unsafePath of [
      '/root/release with-space',
      '/root/release#comment',
      '/root/release$variable',
      '/root/release:alternate',
      '/root/release,alternate',
    ]) {
      const probe = runPathProbe(unsafePath);
      expect(probe.status).toBe(2);
      expect(probe.stderr).toContain('forbidden metacharacter');
    }

    const directory = mkdtempSync(join(tmpdir(), 'aqua-rendered-compose-'));
    const configPath = join(directory, 'config.json');
    const signedInit = '/root/signed/repository/infrastructure/docker/init-scripts';
    const mountProbe = [
      shellFunction(provider, 'assert_rendered_signed_init_mount'),
      'SIGNED_INIT_DIRECTORY="$1"',
      'assert_rendered_signed_init_mount "$2"',
    ].join('\n');
    const runMountProbe = (volumes: Array<Record<string, unknown>>) => {
      writeFileSync(configPath, JSON.stringify({ services: { postgres: { volumes } } }));
      return spawnSync('bash', ['-c', mountProbe, 'rendered-mount-probe', signedInit, configPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
    };
    const exactSignedMount = {
      type: 'bind',
      source: signedInit,
      target: '/docker-entrypoint-initdb.d',
      read_only: true,
    };
    try {
      expect(runMountProbe([exactSignedMount]).status).toBe(0);
      expect(
        runMountProbe([
          exactSignedMount,
          {
            type: 'bind',
            source: '/var/lib/aqua/deploy/checkout/evil.sql',
            target: '/docker-entrypoint-initdb.d/99-evil.sql',
            read_only: true,
          },
        ]).status,
      ).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reconciles an incomplete first phase render and refuses unrelated pre-journal files', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-pre-mutation-journal-'));
    const current = join(root, 'current');
    const runRecovery = (): ReturnType<typeof spawnSync> =>
      spawnSync(
        'bash',
        [
          '-c',
          `
      set -euo pipefail
      source "$1"
      dr_state_reconcile_staging "$2/phase.json" Okan-wqm/aquaculture_platform "$3" 10 1 "$4"
    `,
          '--',
          join(REPO_ROOT, STATE_HELPER_PATH),
          current,
          'a'.repeat(40),
          `sha256:${'b'.repeat(64)}`,
        ],
        { encoding: 'utf8' },
      );
    try {
      mkdirSync(current, { mode: 0o700 });
      expect(runRecovery().status).toBe(0);
      const phaseTemp = join(current, '.phase.Ab12Cd34');
      writeFileSync(phaseTemp, '{"partial":', { mode: 0o600 });
      expect(runRecovery().status).toBe(0);
      expect(existsSync(phaseTemp)).toBe(false);
      writeFileSync(join(current, 'unexpected.json'), '{}\n');
      expect(runRecovery().status).not.toBe(0);
      expect(existsSync(join(current, 'unexpected.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects concurrent candidates and proves the exact rollback image', () => {
    const script = read(PROVIDER_SCRIPT_PATH);
    const lock = script.indexOf('flock --exclusive --nonblock "${GLOBAL_LOCK_FD}"');
    const observation = script.indexOf('PRIOR_CONTAINER_ID=$(active_postgres_container)');
    const mutation = script.indexOf('PREPARED FORWARD_STARTED');
    const committed = script.indexOf('FINALIZING COMMITTED', mutation);

    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(observation);
    expect(observation).toBeLessThan(mutation);
    expect(mutation).toBeLessThan(committed);
    expect(script).toContain(
      "die 'Another PostgreSQL DR bootstrap candidate holds the global lock.'",
    );
    expect(script).not.toContain('flock --unlock');
    expect(script).toContain(
      'rollback_container_id=$(verify_active_exact_image "${prior_image_id}" false)',
    );
    expect(script.indexOf('"${STATE_PATH}" "${phase}" ROLLBACK_STARTED')).toBeLessThan(
      script.indexOf('up -d --no-deps --no-build --force-recreate --pull never postgres'),
    );
  });

  it('selects the effective latest check as of merge and rejects stale success evidence', () => {
    const fixture = JSON.parse(read(CHECK_FIXTURE_PATH)) as Array<Record<string, unknown>>;

    const queuedLatest = selectEffectiveCheck(fixture);
    expect(queuedLatest.status).not.toBe(0);
    expect(queuedLatest.stderr).toContain(
      'effective latest required check is not a completed success as of merge',
    );

    const newerFailure = selectEffectiveCheck(fixture.filter((check) => check.id !== 103));
    expect(newerFailure.status).not.toBe(0);

    const completedAfterMerge = selectEffectiveCheck(
      fixture.map((check) =>
        check.id === 103
          ? {
              ...check,
              status: 'completed',
              conclusion: 'success',
              started_at: '2026-07-17T10:21:00Z',
              completed_at: '2026-07-17T10:31:00Z',
            }
          : check,
      ),
    );
    expect(completedAfterMerge.status).not.toBe(0);

    const effectiveSuccess = selectEffectiveCheck(
      fixture.map((check) =>
        check.id === 103
          ? {
              ...check,
              status: 'completed',
              conclusion: 'success',
              started_at: '2026-07-17T10:21:00Z',
              completed_at: '2026-07-17T10:25:00Z',
            }
          : check,
      ),
    );
    expect(effectiveSuccess.status).toBe(0);
    expect(JSON.parse(effectiveSuccess.stdout)).toEqual(
      expect.objectContaining({ id: 103, created_at: '2026-07-17T10:20:00Z' }),
    );
  });

  it('reconciles only safe same-attempt unpublished phase, result and override files beside an existing journal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aqua-dr-state-reconcile-'));
    try {
      const state = join(directory, 'phase.json');
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
        set -euo pipefail
        source "$1"
        chmod 0700 "$2"
        dr_state_initialize "$2/phase.json" Okan-wqm/aquaculture_platform "$3" 10 1 "$4" 2026-07-18T00:00:00Z
        cp "$2/phase.json" "$2/.phase.ABCDEFGH"
        printf '{partial' > "$2/.result.ABCDEFGH"
        printf 'services:' > "$2/.override.ABCDEFGH"
        chmod 0600 "$2/.result.ABCDEFGH" "$2/.override.ABCDEFGH"
        dr_state_reconcile_staging "$2/phase.json" Okan-wqm/aquaculture_platform "$3" 10 1 "$4"
        dr_state_validate "$2/phase.json" Okan-wqm/aquaculture_platform "$3" 10 1 "$4"
        printf '%s' "$(dr_state_phase "$2/phase.json")"
      `,
          '--',
          join(REPO_ROOT, STATE_HELPER_PATH),
          directory,
          'a'.repeat(40),
          `sha256:${'b'.repeat(64)}`,
        ],
        { encoding: 'utf8' },
      );
      expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
        status: 0,
        stderr: '',
        stdout: 'VERIFYING',
      });
      expect(readdirSync(directory)).toEqual(['phase.json']);
      expect(existsSync(state)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists monotonic phases across SIGKILL and preserves exact-prior recovery intent', () => {
    const helper = join(REPO_ROOT, STATE_HELPER_PATH);
    const root = mkdtempSync(join(tmpdir(), 'aqua-dr-state-'));
    const prior = `sha256:${'1'.repeat(64)}`;
    const candidate = `sha256:${'2'.repeat(64)}`;
    const digest = `sha256:${'b'.repeat(64)}`;
    const sha = 'a'.repeat(40);
    const expectedActions: Record<string, string> = {
      VERIFYING: 'resume-verification',
      PREPARED: 'resume-forward',
      FORWARD_STARTED: 'recover-exact-prior',
      ROLLBACK_STARTED: 'recover-exact-prior',
      ROLLED_BACK: 'require-new-signed-candidate',
      COMMITTED: 'verify-committed',
      FINALIZING: 'finish-forward',
      ROLLBACK_FINALIZING: 'finish-rollback',
      RECOVERY_REQUIRED: 'recover-exact-prior',
    };
    const killedStates = new Map<string, string>();

    try {
      for (const phase of Object.keys(expectedActions)) {
        const stateDirectory = join(root, phase.toLowerCase());
        const statePath = join(stateDirectory, 'phase.json');
        const killed = spawnSync(
          'bash',
          [
            '-c',
            `
              set -euo pipefail
              source "$1"
              mkdir -m 0700 "$2"
              state="$2/phase.json"
              dr_state_initialize "$state" Okan-wqm/aquaculture_platform "$4" 10 1 "$5" 2026-07-18T00:00:00Z
              if [ "$3" != VERIFYING ]; then
                printf '%s' '{"fixture":"verified-recovery-point"}' > "$2/recovery-point.json"
                dr_state_bind_recovery "$state" "$2/recovery-point.json"
                dr_state_transition "$state" VERIFYING PREPARED "$6" "$7" 2026-07-18T00:01:00Z
              fi
              case "$3" in
                FORWARD_STARTED|ROLLBACK_STARTED|ROLLED_BACK|COMMITTED|FINALIZING|ROLLBACK_FINALIZING|RECOVERY_REQUIRED)
                  dr_state_transition "$state" PREPARED FORWARD_STARTED "$6" "$7" 2026-07-18T00:02:00Z
                  ;;
              esac
              case "$3" in
                ROLLBACK_STARTED|ROLLED_BACK|ROLLBACK_FINALIZING)
                  dr_state_transition "$state" FORWARD_STARTED ROLLBACK_STARTED "$6" "$7" 2026-07-18T00:03:00Z
                  ;;
              esac
              if [ "$3" = ROLLED_BACK ] || [ "$3" = ROLLBACK_FINALIZING ]; then
                dr_state_transition "$state" ROLLBACK_STARTED ROLLBACK_FINALIZING "$6" "$7" 2026-07-18T00:04:00Z
                if [ "$3" = ROLLED_BACK ]; then
                  dr_state_transition "$state" ROLLBACK_FINALIZING ROLLED_BACK "$6" "$7" 2026-07-18T00:04:00Z
                fi
              elif [ "$3" = COMMITTED ] || [ "$3" = FINALIZING ]; then
                dr_state_transition "$state" FORWARD_STARTED FINALIZING "$6" "$7" 2026-07-18T00:04:00Z
                if [ "$3" = COMMITTED ]; then
                  dr_state_transition "$state" FINALIZING COMMITTED "$6" "$7" 2026-07-18T00:04:00Z
                fi
              elif [ "$3" = RECOVERY_REQUIRED ]; then
                dr_state_transition "$state" FORWARD_STARTED RECOVERY_REQUIRED "$6" "$7" 2026-07-18T00:04:00Z
              fi
              case "$3" in
                FORWARD_STARTED|ROLLBACK_STARTED)
                  printf '%s' "$7" > "$2/active-image"
                  sync -f "$2/active-image"
                  sync -f "$2"
                  ;;
              esac
              kill -KILL "$$"
            `,
            'state-phase-test',
            helper,
            stateDirectory,
            phase,
            sha,
            digest,
            prior,
            candidate,
          ],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        expect(killed.signal).toBe('SIGKILL');
        killedStates.set(phase, statePath);

        const reentry = spawnSync(
          'bash',
          [
            '-c',
            `
              set -euo pipefail
              source "$1"
              dr_state_validate "$2" Okan-wqm/aquaculture_platform "$3" 10 1 "$4"
              printf '%s|%s|%s' \
                "$(dr_state_reentry_action "$(dr_state_phase "$2")")" \
                "$(dr_state_prior_image_id "$2")" \
                "$(dr_state_candidate_image_id "$2")"
            `,
            'state-reentry-test',
            helper,
            statePath,
            sha,
            digest,
          ],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        expect(reentry.status).toBe(0);
        const [action, persistedPrior, persistedCandidate] = reentry.stdout.split('|');
        expect(action).toBe(expectedActions[phase]);
        if (phase === 'VERIFYING') {
          expect(persistedPrior).toBe('');
          expect(persistedCandidate).toBe('');
        } else {
          expect(persistedPrior).toBe(prior);
          expect(persistedCandidate).toBe(candidate);
        }
      }

      for (const phase of ['FORWARD_STARTED', 'ROLLBACK_STARTED']) {
        const recoveryLog = join(root, `${phase.toLowerCase()}-recovery.log`);
        const recovered = spawnSync(
          'bash',
          [
            '-c',
            `
              set -euo pipefail
              source "$1"
              STATE_PATH="$3"
              STATE_DIR="$4"
              ROLLBACK_OVERRIDE="$4/rollback.override.yml"
              DEPLOY_ROOT=/fixed/deploy
              DEPLOY_ENV_FILE=/fixed/deploy.env
              SIGNED_COMPOSE_PATH=/fixed/compose.yml
              SIGNED_ROLLBACK_COMPOSE_PATH=/fixed/rollback.yml
              EXPECTED_PRIOR="$5"
              EXPECTED_CANDIDATE="$6"
              RECOVERY_LOG="$7"
              ACTIVE_IMAGE_FILE="$4/active-image"
              eval "$(awk '
                /^recover_exact_prior\\(\\) \\{/ { capture=1 }
                capture { print }
                capture && /^}/ { exit }
              ' "$2")"
              require_execution_boundaries() { :; }
              render_image_override() {
                [ "$1" = "\${ROLLBACK_OVERRIDE}" ]
                [ "$2" = "${prior}" ]
              }
              configure_rollback_compose() { :; }
              restore_postgres_recovery_point() { :; }
              resume_postgres_recovery_writers() { :; }
              RUN_KEY=fixture
              docker() {
                if [ "$1" = image ] && [ "$2" = inspect ] && [ "$3" = "${prior}" ]; then
                  return 0
                fi
                if [ "$1" = compose ]; then
                  [ "$(dr_state_phase "\${STATE_PATH}")" = ROLLBACK_STARTED ]
                  printf '%s' "${prior}" > "\${ACTIVE_IMAGE_FILE}"
                  printf 'compose:%s' "${prior}" > "\${RECOVERY_LOG}"
                  return 0
                fi
                return 90
              }
              verify_active_exact_image() {
                [ "$1" = "${prior}" ]
                [ "$2" = false ]
                [ "$(< "\${ACTIVE_IMAGE_FILE}")" = "$1" ]
                printf '%s' "${'f'.repeat(64)}"
              }
              write_rollback_result() {
                [ "$1" = "${prior}" ]
                [ "$2" = "${candidate}" ]
                [ "$3" = "${'f'.repeat(64)}" ]
              }
              recover_exact_prior
              printf '%s' "$(dr_state_phase "\${STATE_PATH}")"
            `,
            'state-recovery-test',
            helper,
            join(REPO_ROOT, COORDINATOR_PATH),
            killedStates.get(phase)!,
            join(root, phase.toLowerCase()),
            prior,
            candidate,
            recoveryLog,
          ],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        expect({ status: recovered.status, stderr: recovered.stderr }).toEqual({
          status: 0,
          stderr: '',
        });
        expect(recovered.stdout).toBe('ROLLED_BACK');
        expect(readFileSync(recoveryLog, 'utf8')).toBe(`compose:${prior}`);
        expect(readFileSync(join(root, phase.toLowerCase(), 'active-image'), 'utf8')).toBe(prior);
      }

      const immutableIds = spawnSync(
        'bash',
        [
          '-c',
          `
            set -euo pipefail
            source "$1"
            dr_state_transition "$2" PREPARED FORWARD_STARTED "$3" "$4" 2026-07-18T01:00:00Z
          `,
          'state-immutable-test',
          helper,
          killedStates.get('PREPARED')!,
          `sha256:${'9'.repeat(64)}`,
          candidate,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(immutableIds.status).not.toBe(0);

      const illegalJump = spawnSync(
        'bash',
        [
          '-c',
          `
            set -euo pipefail
            source "$1"
            dr_state_transition "$2" VERIFYING COMMITTED "$3" "$4" 2026-07-18T01:00:00Z
          `,
          'state-illegal-jump-test',
          helper,
          killedStates.get('VERIFYING')!,
          prior,
          candidate,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(illegalJump.status).not.toBe(0);

      const terminalTransition = spawnSync(
        'bash',
        [
          '-c',
          `
            set -euo pipefail
            source "$1"
            dr_state_transition "$2" COMMITTED ROLLBACK_STARTED "$3" "$4" 2026-07-18T01:00:00Z
          `,
          'state-terminal-test',
          helper,
          killedStates.get('COMMITTED')!,
          prior,
          candidate,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(terminalTransition.status).not.toBe(0);

      const corruptPath = join(root, 'partial-phase.json');
      writeFileSync(corruptPath, '{"phase":"FORWARD_STARTED"', { mode: 0o400 });
      const corrupt = spawnSync(
        'bash',
        [
          '-c',
          'source "$1"; dr_state_validate_any "$2"',
          'state-corrupt-test',
          helper,
          corruptPath,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(corrupt.status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('durably records mutation phases before Compose and recovers before registry access', () => {
    const script = read(PROVIDER_SCRIPT_PATH);
    const stateHelper = read(STATE_HELPER_PATH);
    const reentryCase = script.indexOf('case "${REENTRY_ACTION}" in');
    const recoveryCall = script.indexOf('recover_exact_prior ||', reentryCase);
    const supplyChainCall = script.indexOf('\nverify_candidate_supply_chain\n', reentryCase);
    const forwardTransition = script.lastIndexOf('PREPARED FORWARD_STARTED');
    const forwardMutation = script.lastIndexOf(
      'up -d --no-deps --no-build --force-recreate --pull never postgres',
    );
    const rollbackTransition = script.indexOf('"${STATE_PATH}" "${phase}" ROLLBACK_STARTED');
    const rollbackMutation = script.indexOf(
      'up -d --no-deps --no-build --force-recreate --pull never postgres',
      rollbackTransition,
    );

    expect(recoveryCall).toBeGreaterThan(reentryCase);
    expect(recoveryCall).toBeLessThan(supplyChainCall);
    expect(forwardTransition).toBeGreaterThan(0);
    expect(forwardTransition).toBeLessThan(forwardMutation);
    expect(rollbackTransition).toBeGreaterThan(0);
    expect(rollbackTransition).toBeLessThan(rollbackMutation);
    expect(stateHelper).toContain('sync -f "${temporary_path}"');
    expect(stateHelper).toContain('sync -f "${state_dir}"');
    expect(stateHelper).toContain('FORWARD_STARTED:FINALIZING');
    expect(stateHelper).toContain('FINALIZING:COMMITTED');
    expect(stateHelper).not.toContain('FORWARD_HEALTHY');
    expect(script).toContain(
      "die 'A different PostgreSQL DR bootstrap candidate has unresolved state.'",
    );
  });

  it('keeps the general production stop-line unchanged and owner-gates the new surfaces', () => {
    const deploy = read('.github/workflows/deploy-digitalocean.yml');
    const codeowners = read('.github/CODEOWNERS');
    const runbook = read('docs/runbooks/database-restore-drill.md');

    expect(deploy).toContain('production-deploy-lock:');
    expect(deploy).toContain('PRODUCTION_DEPLOY_ENABLED: ${{ vars.PRODUCTION_DEPLOY_ENABLED }}');
    expect(deploy).toContain("needs.production-deploy-lock.outputs.enabled == 'true'");
    expect(codeowners).toContain('.github/workflows/               @Okan-wqm');
    expect(codeowners).toContain('.github/manifests/               @Okan-wqm');
    expect(codeowners).toContain('tests/invariants/                @Okan-wqm');
    expect(codeowners).toContain(
      'infrastructure/scripts/provider-console-bootstrap-postgres-walg.sh @Okan-wqm',
    );
    expect(codeowners).toContain(
      'infrastructure/deploy/postgres-dr-bootstrap-rollback.override.yml @Okan-wqm',
    );
    expect(runbook).toContain(
      'Before executing\nartifact code as root, verify both signed records',
    );
    expect(runbook).toContain("--certificate-github-workflow-trigger 'workflow_dispatch'");
    expect(runbook).toContain('EXECUTOR_SHA256=$(jq --raw-output');
    expect(runbook).toContain('sudo env -i \\');
    expect(runbook).toContain('Two independent eligible reviewer identities');
    expect(runbook).toContain('`INFRA-HIGH-073`; it does not close `INFRA-HIGH-033`');
    expect(runbook).toContain('`{"auths":{}}`');
    expect(runbook).toMatch(/no application service,\s+schema migration, mutable image tag/);
  });
});
