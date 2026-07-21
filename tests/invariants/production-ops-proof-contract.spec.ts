import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly permissions?: Record<string, string>;
  readonly environment?: string | { readonly name?: string; readonly deployment?: boolean };
  readonly if?: string;
  readonly secrets?: Record<string, string> | 'inherit';
  readonly steps?: readonly WorkflowStep[];
  readonly uses?: string;
}

interface WorkflowDocument {
  readonly on?: {
    readonly workflow_call?: { readonly secrets?: Record<string, unknown> };
  };
  readonly permissions?: Record<string, string>;
  readonly concurrency?: {
    readonly group?: string;
    readonly queue?: string;
    readonly 'cancel-in-progress'?: boolean;
  };
  readonly jobs?: Record<string, WorkflowJob>;
}

function workflow(path: string): WorkflowDocument {
  return yaml.load(read(path)) as WorkflowDocument;
}

function ledgerImageAttestationProgram(script: string): string {
  const match = script.match(
    /<<'LEDGER_IMAGE_ATTESTATION_PY'\n([\s\S]*?)\nLEDGER_IMAGE_ATTESTATION_PY/u,
  );
  const program = match?.[1];
  if (program === undefined) {
    throw new Error('post-deploy verifier has no ledger image attestation program');
  }
  return program;
}

function shellRegion(script: string, name: string): string {
  const match = script.match(new RegExp(`# BEGIN ${name}\\n([\\s\\S]*?)\\n# END ${name}`, 'u'));
  const region = match?.[1];
  if (region === undefined) {
    throw new Error(`shell region is missing: ${name}`);
  }
  return region;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

describe('production operations proof contract', () => {
  it('persists and assigns incidents when a scheduled workflow is stale or failing', () => {
    const workflow = read('.github/workflows/scheduled-workflow-watchdog.yml');
    const manifest = JSON.parse(read('.github/manifests/scheduled-workflows.json')) as {
      incidentTitle: string;
      workflows: Array<{ workflow: string; maxAgeHours: number }>;
    };
    const scheduledWorkflows = readdirSync(join(REPO_ROOT, '.github/workflows'))
      .filter((name) => name.endsWith('.yml') && name !== 'scheduled-workflow-watchdog.yml')
      .filter((name) => /\n\s+schedule:/.test(read(`.github/workflows/${name}`)))
      .sort();

    expect(manifest.workflows.map((item) => item.workflow).sort()).toEqual(scheduledWorkflows);
    expect(manifest.workflows.every((item) => item.maxAgeHours > 0)).toBe(true);
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain("event: 'schedule'");
    expect(workflow).toContain("state: 'open'");
    expect(workflow).toContain('assignees: [owner]');
    expect(workflow).toContain('core.setFailed');
    expect(manifest.incidentTitle).toContain('scheduled-workflow-watchdog');
  });

  it('has a GitHub-Actions-owned post-deploy verification workflow', () => {
    const workflow = read('.github/workflows/production-post-deploy-verify.yml');
    const script = read('scripts/deploy/post-deploy-verify.sh');
    const payloadProducer = read('tools/scripts/ci/prepare-production-host-ssh-payload.sh');
    const controlPlane = read('scripts/deploy/production-host-control-plane.sh');

    expect(workflow).toContain('name: Production Post-Deploy Verify');
    const ciAffected = read('.github/workflows/ci-affected.yml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('workflow_call:');
    expect(workflow).not.toContain('workflow_run:');
    expect(workflow).toContain('environment: production');
    const deployWorkflow = read('.github/workflows/deploy-digitalocean.yml');
    // The deploy reusable workflow owns both automated and manual paths. Its
    // independent verifier runs before the sole baseline-write job, so neither
    // caller can accidentally advance a false release baseline.
    expect(deployWorkflow).toContain('production-post-deploy-verify:');
    expect(deployWorkflow).toContain('uses: ./.github/workflows/production-post-deploy-verify.yml');
    expect(deployWorkflow).toContain('expected_prior_deployed_sha:');
    expect(deployWorkflow).toContain('advance-production-baseline:');
    expect(ciAffected).toContain('uses: ./.github/workflows/deploy-digitalocean.yml');
    expect(ciAffected).not.toMatch(/^ {2}production-post-deploy-verify:/mu);
    expect(ciAffected).not.toContain("needs.deploy.result == 'success'");
    expect(workflow).toContain('deployed/production');
    expect(workflow).toContain('scripts/deploy/post-deploy-verify.sh');
    expect(workflow).toContain('production-post-deploy-evidence.json');
    expect(workflow).toContain('DROPLET_SSH_FINGERPRINT');
    expect(workflow).toContain('tools/scripts/ci/run-protected-ssh.sh');
    expect(workflow).toContain('/bin/bash --noprofile --norc "${PROTECTED_SSH}"');
    expect(workflow).toContain('prepare-production-host-runtime-bundle.sh');
    expect(workflow).toContain('prepare-production-host-ssh-payload.sh');
    expect(workflow).toContain('PRODUCTION_HOST_REMOTE_MODE=shared-exec');
    expect(workflow).not.toContain('PRODUCTION_HOST_REMOTE_MODE=hydrate-exec');
    expect(payloadProducer).toContain('scripts/deploy/post-deploy-verify.sh:shared-exec');
    expect(payloadProducer).not.toContain('scripts/deploy/post-deploy-verify.sh:hydrate-exec');
    const sharedModeGuard = controlPlane.indexOf('if [ "${command}" != shared-exec ]; then');
    const sharedModeElse = controlPlane.indexOf('\n      else\n', sharedModeGuard);
    const sharedModeEnd = controlPlane.indexOf('\n      fi\n', sharedModeElse);
    expect(sharedModeGuard).toBeGreaterThan(0);
    expect(sharedModeElse).toBeGreaterThan(sharedModeGuard);
    expect(sharedModeEnd).toBeGreaterThan(sharedModeElse);
    const sharedExecutionBranch = controlPlane.slice(sharedModeElse, sharedModeEnd);
    expect(sharedExecutionBranch).toContain('aqua_control_plane_guard_dr_state');
    expect(sharedExecutionBranch).toContain('aqua_control_plane_verify_source');
    expect(sharedExecutionBranch).not.toContain('aqua_control_plane_publish_bundle');
    expect(sharedExecutionBranch).not.toContain('aqua_control_plane_prune_sources');
    expect(workflow).not.toContain('StrictHostKeyChecking=accept-new');
    // WHY pattern, not an exact SHA: the invariant's intent is "evidence
    // upload uses actions/upload-artifact pinned by full commit SHA" —
    // asserting one specific SHA made every legitimate dependabot bump
    // fail this contract (it broke on the 4.6.0→7.0.1 bump). The 40-hex
    // requirement still forbids tag/branch pins; the version comment is
    // the human-audit surface and is required alongside.
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    expect(workflow).not.toMatch(/appleboy\/ssh-action/);

    expect(script).toContain('platform.release_ledger');
    expect(script).toContain('release_status');
    expect(script).toContain('imageDigestManifestSha256');
    expect(script).toContain('CATALOG_APPLICATION_IMAGE_SERVICES');
    expect(script).toContain('release ledger image_digests catalog mismatch');
    expect(script).toContain('db_migrate_state}');
    expect(script).toContain('release_ledger_full_image_parity');
    expect(script).toContain('db_migrate_image_parity');
    expect(script).toContain('sha256sum "${digest_manifest}"');
    expect(script).toContain('runtime/check-service-health.mjs');
    expect(script).toContain('/health/ready');
    expect(script).toContain('/health/live');
    expect(script).toContain('"status": "ok"');
    expect(script).toContain('service-catalog.deploy.vars');
    expect(script).toContain('CATALOG_READINESS_SERVICES');
    expect(script).toContain('aqua_control_plane_verify_source');
    expect(script).toContain('current_release_json="$(read_deploy_current_release)"');
    expect(script).toContain("WHERE release_id = :'release_id'");
    expect(shellRegion(script, 'release-ledger-read-only-query')).not.toContain(
      'ORDER BY updated_at DESC',
    );
    expect(script).not.toContain('git rev-parse HEAD');
  });

  it('loads no psql startup files before the read-only release-ledger query', () => {
    const script = read('scripts/deploy/post-deploy-verify.sh');
    const query = shellRegion(script, 'release-ledger-read-only-query');
    const root = mkdtempSync(join(tmpdir(), 'aqua-postverify-psqlrc-'));
    const psqlrc = join(root, 'hostile.psqlrc');
    const marker = join(root, 'psqlrc-ran');

    expect(query).toContain('PGOPTIONS=-c default_transaction_read_only=on');
    expect(query).toMatch(/\bpsql -X\b/u);
    expect(query).toContain("current_setting('transaction_read_only') = 'on'");

    const run = (queryUnderTest: string) => {
      rmSync(marker, { force: true });
      const harness = [
        'set -euo pipefail',
        'docker() {',
        '  [ "$1" = exec ] || return 91',
        '  local argument saw_psql=0 saw_no_psqlrc=0',
        '  for argument in "$@"; do',
        '    [ "${argument}" = psql ] && saw_psql=1',
        '    [ "${argument}" = -X ] && saw_no_psqlrc=1',
        '  done',
        '  [ "${saw_psql}" -eq 1 ] || return 92',
        '  if [ "${saw_no_psqlrc}" -eq 0 ]; then',
        '    . "${PSQLRC}"',
        '  fi',
        `  printf '%s\\n' '${JSON.stringify({ release_id: 'release-proof' })}'`,
        '}',
        `PSQLRC=${JSON.stringify(psqlrc)}`,
        "POSTGRES_USER='aquaculture'",
        "POSTGRES_DB='aquaculture'",
        "marker_release_id='release-proof'",
        `TARGET_SHA='${'a'.repeat(40)}'`,
        queryUnderTest,
        'printf \'%s\' "${release_json}"',
      ].join('\n');
      return spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      });
    };

    try {
      writeFileSync(psqlrc, `printf poison > ${JSON.stringify(marker)}\n`);

      const protectedQuery = run(query);
      expect(protectedQuery.status).toBe(0);
      expect(protectedQuery.stdout).toContain('release-proof');
      expect(existsSync(marker)).toBe(false);

      const unprotectedQuery = run(query.replace('psql -X', 'psql'));
      expect(unprotectedQuery.status).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes production release authority exact-main, least-privilege, and monotonic', () => {
    const deployText = read('.github/workflows/deploy-digitalocean.yml');
    const verifyText = read('.github/workflows/production-post-deploy-verify.yml');
    const rotationRunbook = read('docs/runbooks/secret-rotation.md');
    const deploy = workflow('.github/workflows/deploy-digitalocean.yml');
    const verify = workflow('.github/workflows/production-post-deploy-verify.yml');
    const ci = workflow('.github/workflows/ci-affected.yml');
    const manifest = JSON.parse(read('.github/manifests/production-deploy-secrets.json')) as {
      profiles: Record<string, string[]>;
      constraints: Record<string, string | null>;
    };

    expect(deploy.permissions).toEqual({});
    expect(deploy.concurrency?.group).toContain('production-release-authority');
    expect(deploy.concurrency?.group).toContain("github.ref == 'refs/heads/main'");
    expect(deploy.concurrency?.group).toContain('github.run_id');
    expect(deploy.concurrency?.queue).toBe('max');
    expect(deploy.concurrency?.['cancel-in-progress']).toBe(false);
    expect(deployText).not.toContain('id-token: write');
    expect(deploy.jobs?.['release-authority']?.if).toBe(
      "needs.production-deploy-lock.outputs.enabled == 'true'",
    );
    expect(verify.jobs?.['verify']?.if).toBeUndefined();
    expect(ci.jobs?.['deploy-production']?.permissions).toEqual({
      contents: 'write',
      packages: 'write',
    });
    expect(deploy.on?.workflow_call?.secrets).toBeUndefined();
    expect(verify.on?.workflow_call?.secrets).toBeUndefined();
    expect(deploy.jobs?.['production-post-deploy-verify']?.secrets).toBeUndefined();
    expect(ci.jobs?.['deploy-production']?.secrets).toBeUndefined();
    const imageWriterJobs = new Set([
      'build-backend-images',
      'build-frontend-images',
      'build-infra-images',
    ]);

    for (const [jobName, expectedPermissions] of Object.entries({
      'build-backend-images': { contents: 'read', packages: 'write' },
      'build-frontend-images': { contents: 'read', packages: 'write' },
      'build-infra-images': { contents: 'read', packages: 'write' },
      'verify-images': { contents: 'read', packages: 'read' },
      'capacity-preflight': { contents: 'read' },
      deploy: { contents: 'read' },
      'advance-production-baseline': { contents: 'write' },
    })) {
      const job = deploy.jobs?.[jobName];
      expect({ jobName, permissions: job?.permissions }).toEqual({
        jobName,
        permissions: expectedPermissions,
      });
      const steps = job?.steps ?? [];
      const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
      const contextIndex = steps.findIndex(
        (step) =>
          step.run?.includes('test "${GITHUB_REF}" = \'refs/heads/main\'') === true &&
          step.run.includes('git ls-remote --refs'),
      );
      const firstSecretIndex = steps.findIndex((step) =>
        /\$\{\{ (?:secrets[.]|github[.]token)/u.test(JSON.stringify(step.env ?? {})),
      );
      const checkedMainIndex = steps.findIndex((step) =>
        step.run?.includes('refs/remotes/origin/main'),
      );
      expect({ jobName, contextIndex }).toEqual({ jobName, contextIndex: 0 });
      expect(checkoutIndex).toBeGreaterThan(contextIndex);
      if (firstSecretIndex >= 0) {
        expect(firstSecretIndex).toBeGreaterThan(checkoutIndex);
      }
      if (jobName === 'capacity-preflight' || jobName === 'deploy') {
        expect(checkedMainIndex).toBeGreaterThan(checkoutIndex);
        expect(firstSecretIndex).toBeGreaterThan(checkedMainIndex);
      } else if (imageWriterJobs.has(jobName)) {
        expect(steps[firstSecretIndex]?.run).toContain('gh api');
        expect(steps[firstSecretIndex]?.run).toMatch(
          /assert_exact_current_main\s+unset github_token_material ghcr_username_material\s+DOCKER_CONFIG="\$\{docker_config_directory\}" docker push "\$\{IMAGE_REF\}"/u,
        );
      } else if (jobName === 'verify-images') {
        expect(steps[firstSecretIndex]?.run).toContain(
          'GH_TOKEN="${github_token_material}" gh api',
        );
        expect(steps[firstSecretIndex]?.run).toMatch(
          /DOCKER_CONFIG="\$\{docker_config_directory\}"\s+\\?\s*docker buildx imagetools inspect/u,
        );
      } else if (firstSecretIndex >= 0) {
        expect(steps[firstSecretIndex]?.run).toContain('git ls-remote --refs');
      }
      if (jobName === 'advance-production-baseline') {
        const mutationIndex = steps.findIndex((step) =>
          JSON.stringify(step.env ?? {}).includes('${{ github.token }}'),
        );
        expect(checkedMainIndex).toBeGreaterThan(checkoutIndex);
        expect(mutationIndex).toBeGreaterThan(checkedMainIndex);
      }
    }

    for (const jobName of imageWriterJobs) {
      const steps = deploy.jobs?.[jobName]?.steps ?? [];
      const build = steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
      const publish = steps.find((step) => step.run?.includes('docker push "${IMAGE_REF}"'));
      expect(build?.with).toMatchObject({ push: false, load: true });
      expect(JSON.stringify(build?.with ?? {})).not.toContain('type=registry');
      expect(publish?.env).toMatchObject({
        GITHUB_TOKEN_MATERIAL: '${{ github.token }}',
        GHCR_USERNAME_INPUT: '${{ github.actor }}',
      });
      expect(publish?.env).not.toHaveProperty('GHCR_PASSWORD');
      expect(publish?.run).toContain('unset GITHUB_TOKEN_MATERIAL GHCR_USERNAME_INPUT');
      expect(publish?.run).toContain('GH_TOKEN="${github_token_material}" gh api');
      expect(publish?.run).toContain('repos/${GITHUB_REPOSITORY}/git/ref/heads/main');
      expect(publish?.run).toContain('DOCKER_CONFIG="${docker_config_directory}" docker login');
      expect(publish?.run).toMatch(
        /assert_exact_current_main\s+unset github_token_material ghcr_username_material\s+DOCKER_CONFIG="\$\{docker_config_directory\}" docker push "\$\{IMAGE_REF\}"/u,
      );
    }
    expect(deployText).not.toContain('push: true');
    expect(deployText).not.toContain('cache-to: type=registry');
    expect(deployText).not.toContain('cache-from: type=registry');

    for (const document of [deploy, verify]) {
      for (const job of Object.values(document.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          expect(step.run ?? '').not.toMatch(/\$\{\{[^}]*\b(?:inputs|github[.]event[.]inputs)[.]/u);
        }
      }
    }

    const verifySteps = verify.jobs?.['verify']?.steps ?? [];
    expect(verifySteps[0]?.run).toContain('test "${GITHUB_REF}" = \'refs/heads/main\'');
    const verifyCheckoutIndex = verifySteps.findIndex((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    const verifyCheckedMainIndex = verifySteps.findIndex((step) =>
      step.run?.includes('refs/remotes/origin/main'),
    );
    const verifySecretIndex = verifySteps.findIndex((step) =>
      JSON.stringify(step.env ?? {}).includes('${{ secrets.'),
    );
    expect(verifyCheckoutIndex).toBe(1);
    expect(verifyCheckedMainIndex).toBeGreaterThan(verifyCheckoutIndex);
    expect(verifySecretIndex).toBeGreaterThan(verifyCheckedMainIndex);

    const remoteDeploy = deployText.slice(
      deployText.indexOf('- name: Deploy to DigitalOcean Droplet'),
      deployText.indexOf('- name: Mark deployment performed'),
    );
    expect(remoteDeploy).toContain('secrets.PRODUCTION_GHCR_READ_USERNAME');
    expect(remoteDeploy).toContain('secrets.PRODUCTION_GHCR_READ_TOKEN');
    expect(remoteDeploy).not.toContain('secrets.GITHUB_TOKEN');
    expect(manifest.profiles['image-pull']).toEqual([
      'PRODUCTION_GHCR_READ_USERNAME',
      'PRODUCTION_GHCR_READ_TOKEN',
    ]);
    expect(manifest.profiles['host-access']).toEqual([
      'PRODUCTION_DROPLET_HOST',
      'PRODUCTION_DROPLET_USER',
      'PRODUCTION_DROPLET_SSH_KEY',
      'PRODUCTION_DROPLET_SSH_FINGERPRINT',
    ]);
    expect(manifest.constraints).toMatchObject({
      imagePullTokenAuthority: 'packages:read',
      repositoryContentsAuthority: 'none',
      workflowAuthority: 'none',
      oidcAuthority: 'none',
      fallbackCredential: null,
    });
    expect(rotationRunbook).toContain('PRODUCTION_GHCR_READ_USERNAME');
    expect(rotationRunbook).toContain('PRODUCTION_GHCR_READ_TOKEN');
    expect(rotationRunbook).toMatch(/package-read\s+only/u);
    expect(rotationRunbook).toContain('must never be replaced by `GITHUB_TOKEN`');

    const verifierIndex = deployText.indexOf('  production-post-deploy-verify:');
    const baselineIndex = deployText.indexOf('  advance-production-baseline:');
    expect(verifierIndex).toBeGreaterThan(deployText.indexOf('  deploy:'));
    expect(baselineIndex).toBeGreaterThan(verifierIndex);
    expect(deployText).toContain(
      "value: ${{ jobs.advance-production-baseline.outputs.advanced == 'true' }}",
    );
    expect(deployText).toContain('updateRefs(input:');
    expect(deployText).toContain('beforeOid: $before_oid');
    expect(deployText).toContain('name: "refs/heads/main"');
    expect(deployText).toContain('beforeOid: $after_oid');
    expect(deployText).toContain('OBSERVED_MAIN_SHA=');
    expect(deployText).toContain('force: false');
    expect(deployText).not.toMatch(/git\s+(?:tag|push)[^\n]*(?:-f|--force)/u);
    expect(verifyText).toContain('expected_prior_deployed_sha:');
    expect(verifyText).toContain('production-postverify-nested-');
  });

  it('keeps the package-write token out of every registry child and revokes stale runs', () => {
    const deploy = workflow('.github/workflows/deploy-digitalocean.yml');
    const tokenSentinel = 'AQUA_GHCR_WRITE_SENTINEL_d79fe874';
    const currentMain = 'd'.repeat(40);
    const staleMain = 'e'.repeat(40);
    const writerJobs = ['build-backend-images', 'build-frontend-images', 'build-infra-images'];
    const writerRuns = writerJobs.map((jobName) => {
      const run = deploy.jobs?.[jobName]?.steps?.find((step) =>
        step.run?.includes('docker push "${IMAGE_REF}"'),
      )?.run;
      expect(run).toBeDefined();
      if (run === undefined) throw new Error(`registry publisher run block is missing: ${jobName}`);
      return { jobName, run };
    });
    const verifyRun = deploy.jobs?.['verify-images']?.steps?.find(
      (step) => step.name === 'Verify exact-current-main image manifests',
    )?.run;
    expect(verifyRun).toBeDefined();
    if (verifyRun === undefined) throw new Error('registry verifier run block is missing');

    const directory = mkdtempSync(join(tmpdir(), 'aqua-registry-authority-'));
    const callLog = join(directory, 'calls.log');
    const ghCount = join(directory, 'gh-count');
    const dockerLoginCount = join(directory, 'docker-login-count');
    const githubOutput = join(directory, 'github-output');
    const githubSummary = join(directory, 'github-summary');
    try {
      writeExecutable(
        join(directory, 'gh'),
        [
          `test "\${GH_TOKEN:-}" = '${tokenSentinel}'`,
          'for forbidden_name in GITHUB_TOKEN_MATERIAL GHCR_USERNAME_INPUT GHCR_PASSWORD github_token_material; do',
          '  test "${!forbidden_name+x}" != x',
          'done',
          'printf \'gh\\n\' >> "${CALL_LOG}"',
          'read -r count < "${GH_COUNT_FILE}"',
          'count=$((count + 1))',
          'printf \'%s\\n\' "${count}" > "${GH_COUNT_FILE}"',
          'if [ "${count}" -le "${GH_CURRENT_PROOFS}" ]; then',
          '  printf \'%s\\n\' "${GITHUB_SHA}"',
          'else',
          '  printf \'%s\\n\' "${STALE_MAIN_SHA}"',
          'fi',
        ].join('\n'),
      );
      writeExecutable(
        join(directory, 'docker'),
        [
          'for forbidden_name in GITHUB_TOKEN_MATERIAL GH_TOKEN GHCR_PASSWORD github_token_material; do',
          '  test "${!forbidden_name+x}" != x',
          'done',
          'case "${1:-}" in',
          '  image)',
          '    test "${2:-}" = inspect',
          '    printf \'docker:image-inspect\\n\' >> "${CALL_LOG}"',
          '    ;;',
          '  login)',
          '    IFS= read -r stdin_token',
          `    test "\${stdin_token}" = '${tokenSentinel}'`,
          '    test -n "${DOCKER_CONFIG:-}"',
          '    case "${DOCKER_CONFIG}" in "${RUNNER_TEMP}"/ghcr-*) ;; *) exit 96 ;; esac',
          `    printf '%s\\n' '${tokenSentinel}' > "\${DOCKER_CONFIG}/config.json"`,
          '    read -r login_count < "${DOCKER_LOGIN_COUNT_FILE}"',
          '    login_count=$((login_count + 1))',
          '    printf \'%s\\n\' "${login_count}" > "${DOCKER_LOGIN_COUNT_FILE}"',
          '    if [ "${login_count}" -le "${DOCKER_LOGIN_FAILURES}" ]; then',
          '      printf \'docker:login-failed\\n\' >> "${CALL_LOG}"',
          '      exit 1',
          '    fi',
          '    printf \'docker:login\\n\' >> "${CALL_LOG}"',
          '    ;;',
          '  push)',
          '    test -f "${DOCKER_CONFIG}/config.json"',
          '    printf \'docker:push\\n\' >> "${CALL_LOG}"',
          '    ;;',
          '  buildx)',
          '    test "${2:-}" = imagetools',
          '    test "${3:-}" = inspect',
          '    test -f "${DOCKER_CONFIG}/config.json"',
          '    printf \'docker:imagetools-inspect\\n\' >> "${CALL_LOG}"',
          `    printf 'Name: test\\nDigest: sha256:%064d\\n' 0`,
          '    ;;',
          '  *) exit 95 ;;',
          'esac',
        ].join('\n'),
      );

      const resetEvidence = (): void => {
        writeFileSync(callLog, '');
        writeFileSync(ghCount, '0\n');
        writeFileSync(dockerLoginCount, '0\n');
        writeFileSync(githubOutput, '');
        writeFileSync(githubSummary, '');
      };
      const baseEnvironment = {
        PATH: `${directory}:/usr/bin:/bin`,
        REGISTRY: 'ghcr.io',
        GITHUB_REPOSITORY: 'aqua/example',
        GITHUB_SHA: currentMain,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REF_PROTECTED: 'true',
        GITHUB_TOKEN_MATERIAL: tokenSentinel,
        GHCR_USERNAME_INPUT: 'release-broker',
        RUNNER_TEMP: directory,
        CALL_LOG: callLog,
        GH_COUNT_FILE: ghCount,
        DOCKER_LOGIN_COUNT_FILE: dockerLoginCount,
        DOCKER_LOGIN_FAILURES: '0',
        STALE_MAIN_SHA: staleMain,
        GITHUB_OUTPUT: githubOutput,
        GITHUB_STEP_SUMMARY: githubSummary,
      };
      const execute = (
        run: string,
        currentProofs: number,
        extraEnvironment: Record<string, string>,
      ): ReturnType<typeof spawnSync> =>
        spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', run], {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...baseEnvironment,
            ...extraEnvironment,
            GH_CURRENT_PROOFS: String(currentProofs),
          },
        });
      const expectNoCredentialDirectory = (): void => {
        expect(readdirSync(directory).filter((name) => name.startsWith('ghcr-'))).toEqual([]);
      };

      for (const { jobName, run } of writerRuns) {
        const imageName = jobName.replace('build-', '').replace('-images', '') || 'image';
        const writerEnvironment = {
          IMAGE_NAME: imageName,
          IMAGE_REF: `ghcr.io/aqua/example/${imageName}:${currentMain}`,
        };
        resetEvidence();
        const success = execute(run, 99, writerEnvironment);
        expect({ jobName, stderr: success.stderr, status: success.status }).toEqual({
          jobName,
          stderr: '',
          status: 0,
        });
        expect(readFileSync(callLog, 'utf8')).toBe(
          'gh\ndocker:image-inspect\ngh\ndocker:login\ngh\ndocker:push\n',
        );
        expect(`${success.stdout}${success.stderr}`).not.toContain(tokenSentinel);
        expectNoCredentialDirectory();

        resetEvidence();
        const staleBeforeLogin = execute(run, 1, writerEnvironment);
        expect(staleBeforeLogin.status).not.toBe(0);
        expect(readFileSync(callLog, 'utf8')).toBe('gh\ndocker:image-inspect\ngh\n');
        expectNoCredentialDirectory();
      }

      resetEvidence();
      const retryWriter = writerRuns[0];
      if (retryWriter === undefined) throw new Error('registry retry publisher is missing');
      const retryImageName = 'retry-image';
      const staleBetweenRetries = execute(retryWriter.run, 2, {
        IMAGE_NAME: retryImageName,
        IMAGE_REF: `ghcr.io/aqua/example/${retryImageName}:${currentMain}`,
        DOCKER_LOGIN_FAILURES: '1',
      });
      expect(staleBetweenRetries.status).not.toBe(0);
      expect(readFileSync(callLog, 'utf8')).toBe(
        'gh\ndocker:image-inspect\ngh\ndocker:login-failed\ngh\n',
      );
      expectNoCredentialDirectory();

      const verifierEnvironment = {
        DEPLOY_SERVICES_INPUT: 'gateway-api',
        IMAGE_PREFIX_INPUT: 'ghcr.io/aqua/example',
      };
      resetEvidence();
      const verifierSuccess = execute(verifyRun, 99, verifierEnvironment);
      expect({ stderr: verifierSuccess.stderr, status: verifierSuccess.status }).toEqual({
        stderr: '',
        status: 0,
      });
      expect(readFileSync(callLog, 'utf8')).toBe(
        'gh\ngh\ndocker:login\ngh\ndocker:imagetools-inspect\n',
      );
      expect(`${verifierSuccess.stdout}${verifierSuccess.stderr}`).not.toContain(tokenSentinel);
      expectNoCredentialDirectory();

      resetEvidence();
      const verifierStaleAfterLogin = execute(verifyRun, 2, verifierEnvironment);
      expect(verifierStaleAfterLogin.status).not.toBe(0);
      expect(readFileSync(callLog, 'utf8')).toBe('gh\ngh\ndocker:login\ngh\n');
      expectNoCredentialDirectory();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('makes production host secret identifiers Environment-specific with no generic fallback', () => {
    const workflowDirectory = join(REPO_ROOT, '.github', 'workflows');
    const workflowTexts = readdirSync(workflowDirectory)
      .filter((name) => name.endsWith('.yml'))
      .map((name) => [name, read(`.github/workflows/${name}`)] as const);
    const genericHostSecret =
      /\$\{\{\s*secrets[.]DROPLET_(?:HOST|USER|SSH_KEY|SSH_FINGERPRINT)\s*\}\}/u;

    for (const [name, text] of workflowTexts) {
      expect({ name, genericHostSecret: genericHostSecret.test(text) }).toEqual({
        name,
        genericHostSecret: false,
      });
    }

    for (const path of [
      '.github/workflows/deploy-digitalocean.yml',
      '.github/workflows/deploy-capacity-maintenance.yml',
      '.github/workflows/production-post-deploy-verify.yml',
    ]) {
      const text = read(path);
      expect(text).toContain('secrets.PRODUCTION_DROPLET_HOST');
      expect(text).toContain('secrets.PRODUCTION_DROPLET_USER');
      expect(text).toContain('secrets.PRODUCTION_DROPLET_SSH_KEY');
      expect(text).toContain('secrets.PRODUCTION_DROPLET_SSH_FINGERPRINT');
    }

    for (const path of [
      '.github/workflows/backup-production.yml',
      '.github/workflows/pitr-restore-production.yml',
      '.github/workflows/database-wal-archive-freshness.yml',
      '.github/workflows/verify-backup-ssh-broker.yml',
    ]) {
      const text = read(path);
      expect(text).toContain('secrets.PRODUCTION_BACKUP_DROPLET_HOST');
      expect(text).toContain('secrets.PRODUCTION_BACKUP_DROPLET_SSH_FINGERPRINT');
    }

    const e2e = workflow('.github/workflows/e2e-tests.yml');
    expect(e2e.jobs?.e2e?.environment).toEqual({ name: 'production', deployment: false });
    expect(read('.github/workflows/e2e-tests.yml')).toContain('secrets.PRODUCTION_DROPLET_SSH_KEY');
  });

  it('rechecks release authority at the final post-verify SSH edge without exporting secrets', () => {
    const verify = read('.github/workflows/production-post-deploy-verify.yml');
    const hostStep = verify.slice(
      verify.indexOf('- name: Run release-ledger, digest, and health proof on droplet'),
      verify.indexOf('- name: Upload verification evidence'),
    );
    const payloadIndex = hostStep.indexOf('/bin/bash --noprofile --norc "${PAYLOAD_PRODUCER}"');
    const finalAuthorityIndex = hostStep.indexOf(
      'assert_remote_release_authority',
      payloadIndex + 1,
    );
    const sshIndex = hostStep.indexOf('/bin/bash --noprofile --norc "${PROTECTED_SSH}"');

    expect(verify).toContain('[ "${TARGET_SHA}" != "${GITHUB_SHA}" ]');
    expect(hostStep).toContain(
      'unset DROPLET_HOST DROPLET_USER DROPLET_SSH_KEY DROPLET_SSH_FINGERPRINT',
    );
    expect(payloadIndex).toBeGreaterThan(0);
    expect(finalAuthorityIndex).toBeGreaterThan(payloadIndex);
    expect(sshIndex).toBeGreaterThan(finalAuthorityIndex);
    expect(hostStep).toContain('SSH_PRIVATE_KEY_FD="${SSH_PRIVATE_KEY_FD}"');
    expect(hostStep).toContain('unset ssh_private_key_material');
    expect(hostStep.indexOf('exec {SSH_PRIVATE_KEY_FD}< "${SSH_KEY_STAGE}"')).toBeGreaterThan(
      finalAuthorityIndex,
    );
    expect(hostStep).toContain('/usr/bin/rm -f -- "${SSH_KEY_STAGE}" {SSH_PRIVATE_KEY_FD}<&-');
    expect(hostStep).not.toContain('DROPLET_SSH_KEY="${ssh_private_key_material}"');
    expect(
      (hostStep.match(/assert_remote_release_authority/g) ?? []).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('executes all production-host producers from exact Git object bytes', () => {
    for (const path of [
      '.github/workflows/deploy-digitalocean.yml',
      '.github/workflows/production-post-deploy-verify.yml',
      '.github/workflows/deploy-capacity-maintenance.yml',
    ]) {
      const text = read(path);
      expect(text).toContain('/usr/bin/git --no-replace-objects');
      expect(text).toContain('-c protocol.allow=never');
      expect(text).toContain('PRODUCTION_HOST_REPO_ROOT="${GITHUB_WORKSPACE}"');
      expect(text).toContain('tools/scripts/ci/prepare-production-host-runtime-bundle.sh');
      expect(text).toContain('tools/scripts/ci/prepare-production-host-ssh-payload.sh');
      expect(text).toContain('tools/scripts/ci/run-protected-ssh.sh');
    }
    expect(read('.github/workflows/deploy-digitalocean.yml')).not.toContain(
      'bash tools/scripts/ci/run-protected-ssh.sh',
    );
  });

  it('starts every exact-object Bash producer behind an empty-environment interpreter boundary', () => {
    const contracts: ReadonlyArray<{
      path: string;
      variables: Readonly<Record<string, number>>;
    }> = [
      {
        path: '.github/workflows/deploy-digitalocean.yml',
        variables: { PRODUCER_PATH: 1, PAYLOAD_PRODUCER: 2, PROTECTED_SSH: 2 },
      },
      {
        path: '.github/workflows/production-post-deploy-verify.yml',
        variables: { PRODUCER_PATH: 1, PAYLOAD_PRODUCER: 1, PROTECTED_SSH: 1 },
      },
      {
        path: '.github/workflows/deploy-capacity-maintenance.yml',
        variables: { exact_producer: 1, EXACT_PAYLOAD_PRODUCER: 1, EXACT_SSH_HELPER: 1 },
      },
    ];

    for (const contract of contracts) {
      const text = read(contract.path);
      for (const [variable, expectedCount] of Object.entries(contract.variables)) {
        const invocation = new RegExp(`/bin/bash --noprofile --norc "\\$\\{${variable}\\}"`, 'g');
        const hermeticInvocation = new RegExp(
          `/usr/bin/env -i(?:(?!/bin/bash)[\\s\\S]){0,1800}` +
            `/bin/bash --noprofile --norc "\\$\\{${variable}\\}"`,
          'g',
        );
        expect({
          path: contract.path,
          variable,
          invocationCount: text.match(invocation)?.length ?? 0,
          hermeticCount: text.match(hermeticInvocation)?.length ?? 0,
        }).toEqual({
          path: contract.path,
          variable,
          invocationCount: expectedCount,
          hermeticCount: expectedCount,
        });
      }
    }

    const directory = mkdtempSync(join(tmpdir(), 'aqua-hermetic-bash-boundary-'));
    const poison = join(directory, 'poison.sh');
    const marker = join(directory, 'poison-ran');
    const producer = join(directory, 'producer.sh');
    try {
      writeFileSync(poison, `printf poison > "${marker}"\nexit 77\n`, { mode: 0o700 });
      writeFileSync(
        producer,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'test -z "${BASH_ENV:-}"',
          'test -z "${ENV:-}"',
          'test -z "${GIT_DIR:-}"',
          'test -z "${GIT_WORK_TREE:-}"',
          'test "$(type -t aqua_injected || true)" != \'function\'',
          'printf "%s" "${ALLOWLIST_SENTINEL}"',
        ].join('\n'),
        { mode: 0o700 },
      );

      const result = spawnSync(
        '/usr/bin/env',
        [
          '-i',
          'PATH=/usr/bin:/bin',
          'HOME=/nonexistent',
          'LC_ALL=C',
          'ALLOWLIST_SENTINEL=allowed',
          '/bin/bash',
          '--noprofile',
          '--norc',
          producer,
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            BASH_ENV: poison,
            ENV: poison,
            GIT_DIR: directory,
            GIT_WORK_TREE: directory,
            'BASH_FUNC_aqua_injected%%': '() { exit 88; }',
          },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('allowed');
      expect(result.stderr).toBe('');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects missing, extra, and malformed release-ledger image attestations', () => {
    const script = read('scripts/deploy/post-deploy-verify.sh');
    const program = ledgerImageAttestationProgram(script);
    const imageId = (character: string): string => `sha256:${character.repeat(64)}`;
    const run = (row: object) =>
      spawnSync('python3', ['-c', program], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CATALOG_APPLICATION_IMAGE_SERVICES: 'db-migrate gateway-api farm-service',
          CATALOG_APPLICATION_COMPOSE_IMAGE_MAP:
            'db-migrate:db-migrate tenant-schema-provisioner:db-migrate gateway-api:gateway-api farm-service:farm-service',
          RELEASE_JSON: JSON.stringify(row),
        },
      });

    const validRow = {
      image_digests: {
        'tenant-schema-provisioner': imageId('c'),
        'gateway-api': imageId('a'),
        'farm-service': imageId('b'),
      },
      db_migrate_image: imageId('c'),
    };
    const valid = run(validRow);
    expect(valid.status).toBe(0);
    expect(valid.stdout.trim().split('\n')).toEqual([
      `tenant-schema-provisioner\t${imageId('c')}`,
      `gateway-api\t${imageId('a')}`,
      `farm-service\t${imageId('b')}`,
      `db-migrate\t${imageId('c')}`,
    ]);

    for (const invalidRow of [
      {
        ...validRow,
        image_digests: { 'gateway-api': imageId('a') },
      },
      {
        ...validRow,
        image_digests: { ...validRow.image_digests, rogue: imageId('d') },
      },
      {
        ...validRow,
        image_digests: { ...validRow.image_digests, 'farm-service': 'sha256:short' },
      },
      { ...validRow, db_migrate_image: 'sha256:short' },
    ]) {
      expect(run(invalidRow).status).not.toBe(0);
    }
  });

  it('keeps production queues lossless and moves WAL freshness to a shared host read lock', () => {
    const losslessQueuePaths = [
      '.github/workflows/deploy-digitalocean.yml',
      '.github/workflows/backup-production.yml',
      '.github/workflows/pitr-restore-production.yml',
    ] as const;
    for (const path of losslessQueuePaths) {
      const document = workflow(path);
      expect({ path, concurrency: document.concurrency }).toMatchObject({
        concurrency: {
          queue: 'max',
          'cancel-in-progress': false,
        },
      });
      expect(document.concurrency?.group).toContain("github.ref == 'refs/heads/main'");
      expect(document.concurrency?.group).toContain('production-release-authority');
      expect(document.concurrency?.group).toContain('github.run_id');
    }

    const postverify = workflow('.github/workflows/production-post-deploy-verify.yml');
    expect(postverify.concurrency).toMatchObject({
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(postverify.concurrency?.group).toContain('production-postverify-nested-');
    expect(postverify.concurrency?.group).toContain('production-release-authority');
    expect(postverify.concurrency?.group).toContain('rejected-production-postverify-');

    const capacity = workflow('.github/workflows/deploy-capacity-maintenance.yml');
    expect(capacity.concurrency).toMatchObject({
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(capacity.concurrency?.group).toContain("github.ref == 'refs/heads/main'");
    expect(capacity.concurrency?.group).toContain('production-host-control-plane');
    expect(capacity.concurrency?.group).toContain('github.run_id');

    const freshnessPath = '.github/workflows/database-wal-archive-freshness.yml';
    const freshness = workflow(freshnessPath);
    const freshnessText = read(freshnessPath);
    expect(freshness.concurrency).toEqual({
      group: 'production-wal-archive-freshness',
      'cancel-in-progress': false,
    });
    expect(freshnessText).toContain('scripts/deploy/production-host-control-plane.sh');
    expect(freshnessText).toContain('aqua_control_plane_lock_acquire shared 100');
    expect(freshnessText).toContain('aqua_control_plane_guard_dr_state');
    expect(freshnessText).toContain('WAL freshness control-plane helper digest mismatch');
  });

  it('runs db-migrate through timeout as an external exact-override Compose command', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const start = deploy.indexOf('run_db_migrate_or_exit() {');
    const end = deploy.indexOf('\n}\n\nis_application_image_service()', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const migrateFunction = deploy.slice(start, end + 2);
    const root = mkdtempSync(join(tmpdir(), 'aqua-db-migrate-timeout-'));
    const timeoutCapture = join(root, 'timeout.argv');
    const dockerCapture = join(root, 'docker.argv');
    const override = join(root, 'immutable-images.override.yml');

    try {
      writeFileSync(override, 'services: {}\n', { mode: 0o600 });
      writeExecutable(
        join(root, 'timeout'),
        [
          'set -euo pipefail',
          'printf \'%s\\n\' "$*" > "${TIMEOUT_CAPTURE}"',
          '[ "$1" = --kill-after=30s ]',
          '[ "$2" = 7s ]',
          'shift 2',
          '[ "$1" = docker ]',
          'exec "$@"',
        ].join('\n'),
      );
      writeExecutable(
        join(root, 'docker'),
        [
          'set -euo pipefail',
          'printf \'%s\\n\' "$*" >> "${DOCKER_CAPTURE}"',
          'if [ "$1" = compose ]; then exit 0; fi',
          'if [ "$1" = logs ]; then printf \'{"totalAppliedMigrations":0}\\n\'; exit 0; fi',
          'exit 91',
        ].join('\n'),
      );
      const result = spawnSync(
        '/bin/bash',
        [
          '-c',
          [
            'set -euo pipefail',
            migrateFunction,
            'assert_deploy_compose_override() { printf verified > "${ASSERT_MARKER}"; }',
            'redact_sensitive() { cat; }',
            'record_release_ledger() { return 0; }',
            'run_db_migrate_or_exit executable-boundary',
            'printf \'%s\' "${MIGRATIONS_APPLIED_THIS_RELEASE}"',
          ].join('\n'),
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: `${root}:/usr/bin:/bin`,
            LC_ALL: 'C',
            ASSERT_MARKER: join(root, 'override-verified'),
            DB_MIGRATE_TIMEOUT_SECONDS: '7',
            DEPLOY_COMPOSE_OVERRIDE_FILE: override,
            DOCKER_CAPTURE: dockerCapture,
            TIMEOUT_CAPTURE: timeoutCapture,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Migrations applied this release: 0');
      expect(result.stdout.trimEnd()).toMatch(/0$/u);
      expect(readFileSync(join(root, 'override-verified'), 'utf8')).toBe('verified');
      expect(readFileSync(timeoutCapture, 'utf8').trim()).toBe(
        `--kill-after=30s 7s docker compose -f docker-compose.droplet.yml -f ${override} up --no-build --abort-on-container-exit --exit-code-from db-migrate db-migrate`,
      );
      expect(readFileSync(dockerCapture, 'utf8').trim().split('\n')).toEqual([
        `compose -f docker-compose.droplet.yml -f ${override} up --no-build --abort-on-container-exit --exit-code-from db-migrate db-migrate`,
        'logs aqua-db-migrate --tail 200',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('demotes the GHCR token before any child and exposes it only to Docker stdin', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const demotion = shellRegion(deploy, 'ghcr-credential-demotion');
    const login = shellRegion(deploy, 'ghcr-credential-login');
    const tokenSentinel = 'AQUA_GHCR_SENTINEL_081';
    const root = mkdtempSync(join(tmpdir(), 'aqua-ghcr-lifetime-'));
    const probeMarker = join(root, 'probe-ok');
    const loginCapture = join(root, 'login-stdin');

    expect(deploy.indexOf('# BEGIN ghcr-credential-demotion')).toBeLessThan(
      deploy.indexOf('DEPLOY_SCRIPT_DIR=$('),
    );
    expect(demotion).toContain('ghcr_read_token_material=${GHCR_TOKEN}');
    expect(demotion).toContain('unset GHCR_TOKEN');
    expect(login).toContain('builtin printf \'%s\\n\' "${ghcr_read_token_material}" |');
    expect(login).toContain('unset ghcr_read_token_material');
    expect(login).not.toContain('${GHCR_TOKEN}');

    try {
      for (const [name, content] of Object.entries({
        credential_env_probe: [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          '[ -z "${GHCR_TOKEN+x}" ]',
          '[ -z "${ghcr_read_token_material+x}" ]',
          'builtin printf ok > "${PROBE_MARKER}"',
          '',
        ].join('\n'),
        seq: [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          '[ -z "${GHCR_TOKEN+x}" ]',
          '[ -z "${ghcr_read_token_material+x}" ]',
          "builtin printf '1\\n'",
          '',
        ].join('\n'),
        docker: [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          '[ -z "${GHCR_TOKEN+x}" ]',
          '[ -z "${ghcr_read_token_material+x}" ]',
          'IFS= read -r credential',
          'builtin printf %s "${credential}" > "${LOGIN_CAPTURE}"',
          '',
        ].join('\n'),
      })) {
        const path = join(root, name);
        writeFileSync(path, content);
        chmodSync(path, 0o755);
      }

      const result = spawnSync(
        '/bin/bash',
        [
          '-c',
          [
            'set -euo pipefail',
            demotion,
            'credential_env_probe',
            login,
            '[ -z "${GHCR_TOKEN+x}" ]',
            '[ -z "${ghcr_read_token_material+x}" ]',
          ].join('\n'),
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: `${root}:/usr/bin:/bin`,
            LC_ALL: 'C',
            GHCR_TOKEN: tokenSentinel,
            GHCR_ACTOR: 'aqua-package-reader',
            GHCR_LOGIN_ATTEMPTS: '1',
            LOGIN_CAPTURE: loginCapture,
            PROBE_MARKER: probeMarker,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(tokenSentinel);
      expect(readFileSync(probeMarker, 'utf8')).toBe('ok');
      expect(readFileSync(loginCapture, 'utf8')).toBe(tokenSentinel);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(deploy).not.toContain('current_image_digest_json()');
    expect(deploy).toContain('capture_release_container_attestation');
    expect(deploy.trimEnd()).toMatch(/finalize_production_release$/u);
    expect(deploy).not.toContain('current_release_marker_assert');
  });

  it('captures promoted image evidence from exactly one canonical compose container', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const region = shellRegion(deploy, 'release-container-attestation');
    const root = mkdtempSync(join(tmpdir(), 'aqua-release-attestation-'));
    const manifest = join(root, 'image-digests.tsv');
    const prefix = 'ghcr.io/okan-wqm/aquaculture_platform';
    writeFileSync(
      manifest,
      [
        `gateway-api\t${prefix}/gateway-api\tsha256:${'a'.repeat(64)}`,
        `farm-service\t${prefix}/farm-service\tsha256:${'b'.repeat(64)}`,
        `db-migrate\t${prefix}/db-migrate\tsha256:${'c'.repeat(64)}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const harness = [
      region,
      'aqua_control_plane_lock_assert() { return 0; }',
      'assert_deploy_compose_override() { return 0; }',
      'docker() {',
      '  if [ "$1" = compose ]; then',
      '    local service="${!#}"',
      '    case "${ATTESTATION_CASE}:${service}" in',
      `      extra:gateway-api) printf '%s\\n%s\\n' '${'a'.repeat(64)}' '${'d'.repeat(64)}' ;;`,
      '      missing:farm-service) return 0 ;;',
      `      malformed:gateway-api) printf 'short\\n' ;;`,
      `      *:gateway-api) printf '${'a'.repeat(64)}\\n' ;;`,
      `      *:farm-service) printf '${'b'.repeat(64)}\\n' ;;`,
      `      *:db-migrate) printf '${'c'.repeat(64)}\\n' ;;`,
      `      *:tenant-schema-provisioner) printf '${'d'.repeat(64)}\\n' ;;`,
      '      *) return 1 ;;',
      '    esac',
      '    return 0',
      '  fi',
      '  if [ "$1" = image ] && [ "$2" = inspect ]; then',
      '    local image_ref="${!#}"',
      '    case "${image_ref}" in',
      `      */gateway-api@*) printf 'sha256:${'1'.repeat(64)}\\n' ;;`,
      `      */farm-service@*) printf 'sha256:${'2'.repeat(64)}\\n' ;;`,
      `      */db-migrate@*) printf 'sha256:${'3'.repeat(64)}\\n' ;;`,
      '      *) return 1 ;;',
      '    esac',
      '    return 0',
      '  fi',
      '  if [ "$1" = inspect ]; then',
      '    local container_id="${!#}"',
      '    case "${container_id}" in',
      `      ${'a'.repeat(64)})`,
      `        if [ "${'${ATTESTATION_CASE}'}" = stopped ]; then printf 'sha256:${'1'.repeat(64)}|false|exited|1|aqua-saas|gateway-api\\n'; elif [ "${'${ATTESTATION_CASE}'}" = digest-mismatch ]; then printf 'sha256:${'9'.repeat(64)}|true|running|0|aqua-saas|gateway-api\\n'; else printf 'sha256:${'1'.repeat(64)}|true|running|0|aqua-saas|gateway-api\\n'; fi ;;`,
      `      ${'b'.repeat(64)}) printf 'sha256:${'2'.repeat(64)}|true|running|0|aqua-saas|farm-service\\n' ;;`,
      `      ${'c'.repeat(64)})`,
      `        [ "${'${ATTESTATION_CASE}'}" = migrate-running ] && printf 'sha256:${'3'.repeat(64)}|true|running|0|aqua-saas|db-migrate\\n' || printf 'sha256:${'3'.repeat(64)}|false|exited|0|aqua-saas|db-migrate\\n' ;;`,
      `      ${'d'.repeat(64)})`,
      `        [ "${'${ATTESTATION_CASE}'}" = provisioner-mismatch ] && printf 'sha256:${'9'.repeat(64)}|true|running|0|aqua-saas|tenant-schema-provisioner\\n' || printf 'sha256:${'3'.repeat(64)}|true|running|0|aqua-saas|tenant-schema-provisioner\\n' ;;`,
      '      *) return 1 ;;',
      '    esac',
      '    return 0',
      '  fi',
      '  return 1',
      '}',
      "APPLICATION_COMPOSE_IMAGE_MAP='gateway-api:gateway-api farm-service:farm-service db-migrate:db-migrate tenant-schema-provisioner:db-migrate'",
      'application_compose_services() {',
      '  local binding',
      '  for binding in ${APPLICATION_COMPOSE_IMAGE_MAP}; do printf \'%s\\n\' "${binding%%:*}"; done',
      '}',
      'compose_image_target_for_service() {',
      '  local binding',
      '  for binding in ${APPLICATION_COMPOSE_IMAGE_MAP}; do',
      '    [ "${binding%%:*}" = "$1" ] && { printf \'%s\\n\' "${binding#*:}"; return; }',
      '  done',
      '  return 1',
      '}',
      'capture_release_container_attestation || exit $?',
      'printf \'%s\\n%s\\n\' "${RELEASE_CONTAINER_IMAGE_DIGESTS}" "${RELEASE_DB_MIGRATE_IMAGE}"',
    ].join('\n');
    const run = (attestationCase: string) =>
      spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          ATTESTATION_CASE: attestationCase,
          DEPLOY_IMAGE_DIGESTS_FILE: manifest,
          IMAGE_PREFIX: prefix,
        },
      });

    try {
      const valid = run('valid');
      expect(valid.status).toBe(0);
      expect(valid.stdout.trim().split('\n')).toEqual([
        `{"gateway-api":"sha256:${'1'.repeat(64)}","farm-service":"sha256:${'2'.repeat(64)}","tenant-schema-provisioner":"sha256:${'3'.repeat(64)}"}`,
        `sha256:${'3'.repeat(64)}`,
      ]);
      for (const invalidCase of [
        'missing',
        'extra',
        'malformed',
        'stopped',
        'migrate-running',
        'digest-mismatch',
        'provisioner-mismatch',
      ]) {
        expect(run(invalidCase).status).not.toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes only a bounded, prevalidated exact Compose project inventory', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const controlPlanePath = join(REPO_ROOT, 'scripts/deploy/production-host-control-plane.sh');
    const freshShell = spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        '. "$1"; declare -F aqua_control_plane_capture_docker_output >/dev/null',
        '_',
        controlPlanePath,
      ],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
    );
    expect(freshShell.status).toBe(0);
    const start = deploy.indexOf('remove_canonical_project_containers_after_down()');
    const end = deploy.indexOf('\nOWN_DOCKER_CONFIG=', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const cleanupFunction = deploy.slice(start, end);
    expect(cleanupFunction).not.toContain("grep -E 'aqua-'");
    expect(cleanupFunction).toContain('com.docker.compose.project');
    expect(cleanupFunction).toContain('com.docker.compose.service');
    const root = mkdtempSync(join(tmpdir(), 'aqua-project-container-cleanup-'));
    const removals = join(root, 'removals');
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    const harness = [
      'set -euo pipefail',
      cleanupFunction,
      'aqua_control_plane_lock_assert() { return 0; }',
      'assert_deploy_compose_override() { return 0; }',
      'AQUA_PRODUCTION_DOCKER_CAPTURE_TIMEOUT_SECONDS=30',
      "deploy_compose() { printf 'gateway-api\\npostgres\\n'; }",
      'aqua_control_plane_capture_docker_output() {',
      '  local output="$1"',
      '  shift 4',
      '  "$@" > "${output}"',
      '}',
      'docker() {',
      '  case "$1" in',
      '    ps)',
      '      case "${CLEANUP_CASE}" in',
      `        duplicate) printf '%s\\n%s\\n' '${first}' '${first}' ;;`,
      `        *) printf '%s\\n%s\\n' '${first}' '${second}' ;;`,
      '      esac',
      '      ;;',
      '    inspect)',
      '      local id="${!#}"',
      '      if [ "${id}" = "' + first + '" ]; then',
      '        printf "%s|aqua-saas|gateway-api\\n" "${id}"',
      '      elif [ "${CLEANUP_CASE}" = foreign ]; then',
      '        printf "%s|backup-proof|postgres\\n" "${id}"',
      '      elif [ "${CLEANUP_CASE}" = noncatalog ]; then',
      '        printf "%s|aqua-saas|attacker\\n" "${id}"',
      '      else',
      '        printf "%s|aqua-saas|postgres\\n" "${id}"',
      '      fi',
      '      ;;',
      '    rm) printf "%s\\n" "$3" >> "${REMOVALS}" ;;',
      '    *) return 64 ;;',
      '  esac',
      '}',
      "COMPOSE_PROJECT_NAME='aqua-saas'",
      'remove_canonical_project_containers_after_down',
    ].join('\n');
    const run = (cleanupCase: string): ReturnType<typeof spawnSync> => {
      rmSync(removals, { force: true });
      return spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          CLEANUP_CASE: cleanupCase,
          REMOVALS: removals,
        },
      });
    };
    try {
      expect(run('valid').status).toBe(0);
      expect(readFileSync(removals, 'utf8')).toBe(`${first}\n${second}\n`);
      for (const invalid of ['foreign', 'noncatalog', 'duplicate']) {
        expect(run(invalid).status).not.toBe(0);
        expect(existsSync(removals)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('converges every finalization failure to prior rollback or committed target state', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const transactionRegion = shellRegion(deploy, 'production-release-transaction');
    const finalizationRegion = shellRegion(deploy, 'production-release-finalization');
    expect(finalizationRegion.indexOf('record_release_ledger "promoted"')).toBeLessThan(
      finalizationRegion.indexOf('publish_deploy_current_release'),
    );
    expect(finalizationRegion).toContain(
      'release_transaction_transition FINALIZING LEDGER_PROMOTED',
    );
    expect(finalizationRegion).toContain(
      'release_transaction_transition LEDGER_PROMOTED COMMITTED',
    );
    const root = mkdtempSync(join(tmpdir(), 'aqua-release-finalization-'));
    const manifest = join(root, 'image-digests.tsv');
    const marker = join(root, 'marker');
    const ledger = join(root, 'ledger');
    const journal = join(root, 'journal');
    writeFileSync(manifest, 'gateway-api\timage\tdigest\n');
    try {
      const harness = [
        'set -euo pipefail',
        `AQUA_CONTROL_PLANE_ROOT=${JSON.stringify(root)}`,
        transactionRegion,
        finalizationRegion,
        'cleanup_docker_auth() { return 0; }',
        'capture_release_container_attestation() {',
        '  if [ "${FAIL_STEP:-}" = post-marker-attestation ] && [ "${ATTESTATION_FAILURE_USED}" -eq 0 ]; then ATTESTATION_FAILURE_USED=1; return 1; fi',
        '  return 0',
        '}',
        'verify_release_ledger_sql() { return 0; }',
        'record_release_ledger() {',
        '  if [ "$1" = promoted ] && [ "${FAIL_STEP:-}" = ledger ]; then return 1; fi',
        '  printf "%s" "$1" > "${LEDGER}"',
        '}',
        'publish_deploy_current_release() {',
        '  [ "${FAIL_STEP:-}" != marker ] || return 1',
        '  printf new > "${MARKER}"',
        '}',
        'assert_deploy_current_release() {',
        '  [ "$(cat "${MARKER}")" = new ] || return 1',
        '  if [ "${FAIL_STEP:-}" = post-marker-assert ] && [ "${ASSERT_FAILURE_USED}" -eq 0 ]; then ASSERT_FAILURE_USED=1; return 1; fi',
        '}',
        'deploy_transaction_marker_matches_prior() { [ "$(cat "${MARKER}")" = prior ]; }',
        'release_transaction_transition() {',
        '  local next="$2"',
        '  case "${FAIL_STEP:-}:${next}" in',
        '    journal-finalizing:FINALIZING|journal-ledger:LEDGER_PROMOTED) return 1 ;;',
        '    journal-committed:COMMITTED)',
        '      if [ "${COMMIT_FAILURE_USED}" -eq 0 ]; then COMMIT_FAILURE_USED=1; return 1; fi ;;',
        '  esac',
        '  DEPLOY_TRANSACTION_PHASE="${next}"',
        '  printf "%s" "${next}" > "${JOURNAL}"',
        '  case "${next}" in COMMITTED|ROLLED_BACK) DEPLOY_TRANSACTION_TERMINAL=true ;; esac',
        '}',
        'rollback_and_record() {',
        '  [ "$(cat "${MARKER}")" = prior ] || return 1',
        '  printf rolled_back > "${LEDGER}"',
        '  DEPLOY_TRANSACTION_PHASE=ROLLED_BACK',
        '  DEPLOY_TRANSACTION_TERMINAL=true',
        '  printf ROLLED_BACK > "${JOURNAL}"',
        '}',
        'DEPLOY_TRANSACTION_ACTIVE=true',
        'DEPLOY_TRANSACTION_TERMINAL=false',
        'DEPLOY_TRANSACTION_MUTATED=true',
        'DEPLOY_TRANSACTION_RECOVERING=false',
        'DEPLOY_TRANSACTION_PHASE=LIVE_VERIFIED',
        'ATTESTATION_FAILURE_USED=0',
        'ASSERT_FAILURE_USED=0',
        'COMMIT_FAILURE_USED=0',
        'trap deploy_transaction_exit_handler EXIT',
        'finalize_production_release',
      ].join('\n');
      const run = (failure: string): ReturnType<typeof spawnSync> => {
        writeFileSync(marker, 'prior');
        writeFileSync(ledger, 'prior');
        writeFileSync(journal, 'LIVE_VERIFIED');
        return spawnSync('/bin/bash', ['-c', harness], {
          encoding: 'utf8',
          env: {
            PATH: '/usr/bin:/bin',
            LC_ALL: 'C',
            DEPLOY_IMAGE_DIGESTS_FILE: manifest,
            DEPLOY_RELEASE_ID: `${'a'.repeat(40)}-20260719T010203Z`,
            DEPLOY_SHA: 'a'.repeat(40),
            FAIL_STEP: failure,
            MARKER: marker,
            LEDGER: ledger,
            JOURNAL: journal,
          },
        });
      };
      for (const failure of ['journal-finalizing', 'ledger', 'journal-ledger', 'marker']) {
        expect(run(failure).status).not.toBe(0);
        expect(readFileSync(marker, 'utf8')).toBe('prior');
        expect(readFileSync(ledger, 'utf8')).toBe('rolled_back');
        expect(readFileSync(journal, 'utf8')).toBe('ROLLED_BACK');
      }
      for (const recovery of [
        '',
        'post-marker-assert',
        'post-marker-attestation',
        'journal-committed',
      ]) {
        expect(run(recovery).status).toBe(0);
        expect(readFileSync(marker, 'utf8')).toBe('new');
        expect(readFileSync(ledger, 'utf8')).toBe('promoted');
        expect(readFileSync(journal, 'utf8')).toBe('COMMITTED');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('terminates every pre-mutation cleanup failure without entering live mutation', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const transactionRegion = shellRegion(deploy, 'production-release-transaction');
    const root = mkdtempSync(join(tmpdir(), 'aqua-release-pre-mutation-'));
    const journal = join(root, 'journal');
    const harness = [
      'set -euo pipefail',
      `AQUA_CONTROL_PLANE_ROOT=${JSON.stringify(root)}`,
      transactionRegion,
      'maybe_fail() { [ "${FAIL_STEP}" != "$1" ]; }',
      'release_capacity_gc() { maybe_fail gc; }',
      'release_capacity_report() { maybe_fail report; }',
      'release_container_status() { maybe_fail status; }',
      'cleanup_docker_auth() { maybe_fail auth; }',
      'release_transaction_transition() {',
      '  DEPLOY_TRANSACTION_PHASE="$2"',
      '  printf "%s" "$2" > "${JOURNAL}"',
      '  case "$2" in COMMITTED|ROLLED_BACK) DEPLOY_TRANSACTION_TERMINAL=true ;; esac',
      '}',
      'DEPLOY_TRANSACTION_ACTIVE=true',
      'DEPLOY_TRANSACTION_TERMINAL=false',
      'DEPLOY_TRANSACTION_MUTATED=false',
      'DEPLOY_TRANSACTION_RECOVERING=false',
      'DEPLOY_TRANSACTION_PHASE=PREPARED',
      'trap deploy_transaction_exit_handler EXIT',
      'prepare_deploy_mutation',
    ].join('\n');
    try {
      for (const failure of ['gc', 'report', 'status', 'auth']) {
        rmSync(journal, { force: true });
        const result = spawnSync('/bin/bash', ['-c', harness], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', FAIL_STEP: failure, JOURNAL: journal },
        });
        expect(result.status).not.toBe(0);
        expect(readFileSync(journal, 'utf8')).toBe('ROLLED_BACK');
      }
      rmSync(journal, { force: true });
      const forwardOnly = spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          FAIL_STEP: 'gc',
          JOURNAL: journal,
          AQUA_DEPLOY_ROLLBACK_POLICY: 'FORWARD_ONLY',
        },
      });
      expect(forwardOnly.status).not.toBe(0);
      expect(readFileSync(journal, 'utf8')).toBe('FORWARD_REQUIRED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists release transaction phases with compare-and-swap and exact journal mode', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const transactionRegion = shellRegion(deploy, 'production-release-transaction');
    const root = mkdtempSync(join(tmpdir(), 'aqua-release-transaction-cas-'));
    const manifest = join(root, 'image-digests.tsv');
    const checksum = join(root, 'rollback.sha256');
    const journal = join(root, 'active-release-transaction.json');
    const sha = 'd'.repeat(40);
    writeFileSync(manifest, 'candidate-manifest\n', { mode: 0o600 });
    writeFileSync(checksum, `${'e'.repeat(64)}\n`, { mode: 0o600 });
    writeFileSync(
      journal,
      `${JSON.stringify({
        candidate_sha: 'c'.repeat(40),
        deploy_services: ['db-migrate'],
        failure_phase: null,
        full_deploy: false,
        image_digest_manifest_sha256: 'a'.repeat(64),
        migrations_applied: 0,
        occurred_at: '2026-07-18T00:00:00Z',
        phase: 'COMMITTED',
        prior_release: null,
        release_id: `${'c'.repeat(40)}-20260718T000000Z`,
        rollback_manifest_sha256: 'b'.repeat(64),
        schema_version: 1,
      })}\n`,
      { mode: 0o400 },
    );
    const harness = [
      'set -euo pipefail',
      transactionRegion,
      'aqua_control_plane_lock_assert() { return 0; }',
      'assert_deploy_compose_override() { return 0; }',
      'assert_rollback_state() { return 0; }',
      'release_transaction_write START PREPARED preserve ""',
      'release_transaction_write PREPARED MUTATION_STARTED preserve ""',
      'release_transaction_write MUTATION_STARTED DB_COMPLETE 0 ""',
      'release_transaction_write DB_COMPLETE LIVE_CANDIDATE preserve ""',
      'release_transaction_write LIVE_CANDIDATE LIVE_VERIFIED preserve ""',
      'if release_transaction_write LIVE_VERIFIED COMMITTED preserve ""; then exit 91; fi',
    ].join('\n');
    try {
      const result = spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          AQUA_CONTROL_PLANE_ROOT: root,
          AQUA_CONTROL_PLANE_EXPECTED_UID: String(process.getuid?.() ?? 0),
          DEPLOY_IMAGE_DIGESTS_FILE: manifest,
          ROLLBACK_CHECKSUM: checksum,
          DEPLOY_RELEASE_ID: `${sha}-20260719T010203Z`,
          DEPLOY_SHA: sha,
          FULL_DEPLOY: 'false',
          DEPLOY_SERVICES: 'gateway-api db-migrate',
          DEPLOY_TRANSACTION_PRIOR_JSON: 'null',
        },
      });
      expect(result.status).toBe(0);
      const document = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, unknown>;
      expect(document).toMatchObject({
        candidate_sha: sha,
        migrations_applied: 0,
        phase: 'LIVE_VERIFIED',
        release_id: `${sha}-20260719T010203Z`,
      });
      expect(statSync(journal).mode & 0o777).toBe(0o400);
      expect(result.stderr).toContain('phase transition is illegal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('archives a forward-required predecessor and makes its successor structurally forward-only', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const transactionRegion = shellRegion(deploy, 'production-release-transaction');
    const root = mkdtempSync(join(tmpdir(), 'aqua-release-supersession-'));
    const releases = join(root, 'releases');
    const manifest = join(root, 'image-digests.tsv');
    const checksum = join(root, 'rollback.sha256');
    const oldSha = 'c'.repeat(40);
    const newSha = 'd'.repeat(40);
    const oldRelease = `${oldSha}-20260719T010203Z`;
    const newRelease = `${newSha}-20260719T020304Z`;
    const proof = 'e'.repeat(64);
    mkdirSync(releases, { mode: 0o700 });
    mkdirSync(join(releases, oldRelease), { mode: 0o700 });
    mkdirSync(join(releases, newRelease), { mode: 0o700 });
    writeFileSync(manifest, 'candidate-manifest\n', { mode: 0o600 });
    writeFileSync(checksum, `${'f'.repeat(64)}\n`, { mode: 0o600 });
    const harness = [
      'set -euo pipefail',
      transactionRegion,
      'aqua_control_plane_lock_assert() { return 0; }',
      'assert_deploy_compose_override() { return 0; }',
      'assert_rollback_state() { return 0; }',
      'aqua_control_plane_descendant_source_proof() { printf "%s\\n" "${PUBLISHED_SUPERSESSION_PROOF:?}"; }',
      `DEPLOY_RELEASE_ID=${oldRelease}`,
      `DEPLOY_SHA=${oldSha}`,
      'release_transaction_write START PREPARED preserve ""',
      'release_transaction_write PREPARED MUTATION_STARTED preserve ""',
      'release_transaction_write MUTATION_STARTED DB_COMPLETE 1 ""',
      'release_transaction_write DB_COMPLETE LIVE_CANDIDATE preserve ""',
      'release_transaction_write LIVE_CANDIDATE FORWARD_REQUIRED preserve migration_boundary_crossed',
      `DEPLOY_RELEASE_ID=${newRelease}`,
      `DEPLOY_SHA=${newSha}`,
      'AQUA_DEPLOY_ROLLBACK_POLICY=FORWARD_ONLY',
      `AQUA_DEPLOY_SUPERSEDES_RELEASE_ID=${oldRelease}`,
      `AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA=${oldSha}`,
      `AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256=${proof}`,
      `PUBLISHED_SUPERSESSION_PROOF=${'0'.repeat(64)}`,
      'if release_transaction_begin; then exit 92; fi',
      `PUBLISHED_SUPERSESSION_PROOF=${proof}`,
      'release_transaction_begin',
      'release_transaction_write PREPARED MUTATION_STARTED preserve ""',
      'release_transaction_write MUTATION_STARTED DB_COMPLETE 0 ""',
      'release_transaction_write DB_COMPLETE LIVE_CANDIDATE preserve ""',
      'release_transaction_write LIVE_CANDIDATE FORWARD_REQUIRED preserve forward_only_supersession',
      'if release_transaction_write FORWARD_REQUIRED ROLLBACK_STARTED preserve forbidden_rollback; then exit 91; fi',
      'release_transaction_write FORWARD_REQUIRED LIVE_VERIFIED preserve ""',
      'release_transaction_write LIVE_VERIFIED FINALIZING preserve ""',
      'release_transaction_write FINALIZING LEDGER_PROMOTED preserve ""',
      'release_transaction_write LEDGER_PROMOTED COMMITTED preserve ""',
    ].join('\n');
    try {
      const result = spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          AQUA_CONTROL_PLANE_ROOT: root,
          AQUA_CONTROL_PLANE_EXPECTED_UID: String(process.getuid?.() ?? 0),
          DEPLOY_IMAGE_DIGESTS_FILE: manifest,
          ROLLBACK_CHECKSUM: checksum,
          FULL_DEPLOY: 'false',
          DEPLOY_SERVICES: 'gateway-api db-migrate',
          DEPLOY_TRANSACTION_PRIOR_JSON: 'null',
        },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('phase transition is illegal');
      expect(result.stderr).toContain(
        'Forward-only successor proof does not match the published source ancestry',
      );
      const active = JSON.parse(
        readFileSync(join(root, 'active-release-transaction.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(active).toMatchObject({
        candidate_sha: newSha,
        phase: 'COMMITTED',
        rollback_policy: 'FORWARD_ONLY',
        supersedes_candidate_sha: oldSha,
        supersedes_release_id: oldRelease,
        supersession_proof_sha256: proof,
      });
      const archivePath = join(releases, oldRelease, 'superseded-transaction.json');
      const archive = JSON.parse(readFileSync(archivePath, 'utf8')) as Record<string, unknown>;
      expect(archive).toMatchObject({
        schema_version: 1,
        successor_candidate_sha: newSha,
        successor_release_id: newRelease,
        supersession_proof_sha256: proof,
        superseded_transaction: {
          candidate_sha: oldSha,
          phase: 'FORWARD_REQUIRED',
          release_id: oldRelease,
        },
      });
      expect(statSync(archivePath).mode & 0o777).toBe(0o400);
      const terminalPath = join(releases, newRelease, 'release-transaction-terminal.json');
      const terminal = JSON.parse(readFileSync(terminalPath, 'utf8')) as Record<string, unknown>;
      expect(terminal).toMatchObject({
        schema_version: 1,
        terminal_transaction: {
          candidate_sha: newSha,
          phase: 'COMMITTED',
          release_id: newRelease,
          rollback_policy: 'FORWARD_ONLY',
        },
      });
      expect(statSync(terminalPath).mode & 0o777).toBe(0o400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers forward-only supersession across both journal CAS power-cut boundaries', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const transactionRegion = shellRegion(deploy, 'production-release-transaction');
    const beforeCasNeedle = [
      '    if read_current() != current_before_cas:',
      '        raise SystemExit("release transaction journal authority changed before compare-and-swap")',
      '    os.replace(stage_path, path)',
    ].join('\n');
    const afterCasNeedle = [
      '    os.replace(stage_path, path)',
      '    fsync_directory(root)',
      '    if forward_start:',
    ].join('\n');
    expect(transactionRegion).toContain(beforeCasNeedle);
    expect(transactionRegion).toContain(afterCasNeedle);
    const cutBeforeCas = transactionRegion.replace(
      beforeCasNeedle,
      beforeCasNeedle.replace(
        '    os.replace(stage_path, path)',
        '    os._exit(97)\n    os.replace(stage_path, path)',
      ),
    );
    const cutAfterCas = transactionRegion.replace(
      afterCasNeedle,
      afterCasNeedle.replace('    if forward_start:', '    os._exit(98)\n    if forward_start:'),
    );
    const oldSha = 'c'.repeat(40);
    const oldRelease = `${oldSha}-20260719T010203Z`;
    const createFixture = (label: string) => {
      const root = mkdtempSync(join(tmpdir(), `aqua-release-power-cut-${label}-`));
      const releases = join(root, 'releases');
      const manifest = join(root, 'image-digests.tsv');
      const checksum = join(root, 'rollback.sha256');
      const journal = join(root, 'active-release-transaction.json');
      mkdirSync(releases, { mode: 0o700 });
      mkdirSync(join(releases, oldRelease), { mode: 0o700 });
      writeFileSync(manifest, 'candidate-manifest\n', { mode: 0o600 });
      writeFileSync(checksum, `${'f'.repeat(64)}\n`, { mode: 0o600 });
      const predecessor = {
        candidate_sha: oldSha,
        deploy_services: ['gateway-api', 'db-migrate'],
        failure_phase: 'migration_boundary_crossed',
        full_deploy: false,
        image_digest_manifest_sha256: 'a'.repeat(64),
        migrations_applied: 1,
        occurred_at: '2026-07-19T01:02:03Z',
        phase: 'FORWARD_REQUIRED',
        prior_release: null,
        release_id: oldRelease,
        rollback_manifest_sha256: 'b'.repeat(64),
        rollback_policy: 'ALLOW_ZERO_MIGRATION',
        schema_version: 2,
        supersedes_candidate_sha: null,
        supersedes_release_id: null,
        supersession_proof_sha256: null,
      };
      writeFileSync(journal, `${JSON.stringify(predecessor)}\n`, { mode: 0o400 });
      return { checksum, journal, manifest, predecessor, releases, root };
    };
    const runStart = (
      fixture: ReturnType<typeof createFixture>,
      region: string,
      candidateSha: string,
      releaseId: string,
      proof: string,
    ): ReturnType<typeof spawnSync> => {
      const harness = [
        'set -euo pipefail',
        region,
        'aqua_control_plane_lock_assert() { return 0; }',
        'assert_deploy_compose_override() { return 0; }',
        'assert_rollback_state() { return 0; }',
        'release_transaction_write START PREPARED preserve ""',
      ].join('\n');
      return spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          AQUA_CONTROL_PLANE_ROOT: fixture.root,
          AQUA_CONTROL_PLANE_EXPECTED_UID: String(process.getuid?.() ?? 0),
          AQUA_DEPLOY_ROLLBACK_POLICY: 'FORWARD_ONLY',
          AQUA_DEPLOY_SUPERSEDES_RELEASE_ID: oldRelease,
          AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA: oldSha,
          AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256: proof,
          DEPLOY_IMAGE_DIGESTS_FILE: fixture.manifest,
          ROLLBACK_CHECKSUM: fixture.checksum,
          DEPLOY_RELEASE_ID: releaseId,
          DEPLOY_SHA: candidateSha,
          FULL_DEPLOY: 'false',
          DEPLOY_SERVICES: 'gateway-api db-migrate',
        },
      });
    };

    const before = createFixture('before-cas');
    try {
      const firstSha = 'd'.repeat(40);
      const secondSha = 'e'.repeat(40);
      const firstRelease = `${firstSha}-20260719T020304Z`;
      const secondRelease = `${secondSha}-20260719T030405Z`;
      mkdirSync(join(before.releases, firstRelease), { mode: 0o700 });
      mkdirSync(join(before.releases, secondRelease), { mode: 0o700 });
      const interrupted = runStart(before, cutBeforeCas, firstSha, firstRelease, '1'.repeat(64));
      expect(interrupted.status).toBe(97);
      expect(JSON.parse(readFileSync(before.journal, 'utf8'))).toEqual(before.predecessor);
      const evidence = join(before.releases, oldRelease, 'superseded-transaction.json');
      const stage = join(before.releases, oldRelease, '.superseded-transaction.json.staging');
      expect(existsSync(evidence)).toBe(false);
      expect(existsSync(stage)).toBe(true);
      expect(statSync(stage).mode & 0o777).toBe(0o400);

      renameSync(stage, evidence);
      const replay = runStart(before, transactionRegion, secondSha, secondRelease, '2'.repeat(64));
      expect(replay.status).not.toBe(0);
      expect(replay.stderr).toContain('evidence precedes active journal authority');
      expect(JSON.parse(readFileSync(before.journal, 'utf8'))).toEqual(before.predecessor);
      renameSync(evidence, stage);

      const successor = runStart(
        before,
        transactionRegion,
        secondSha,
        secondRelease,
        '2'.repeat(64),
      );
      expect(successor.status).toBe(0);
      expect(existsSync(stage)).toBe(false);
      const active = JSON.parse(readFileSync(before.journal, 'utf8')) as Record<string, unknown>;
      expect(active).toMatchObject({ candidate_sha: secondSha, phase: 'PREPARED' });
      expect(JSON.parse(readFileSync(evidence, 'utf8'))).toMatchObject({
        successor_candidate_sha: secondSha,
        successor_release_id: secondRelease,
      });
    } finally {
      rmSync(before.root, { recursive: true, force: true });
    }

    const after = createFixture('after-cas');
    try {
      const successorSha = 'd'.repeat(40);
      const unrelatedSha = 'e'.repeat(40);
      const successorRelease = `${successorSha}-20260719T020304Z`;
      const unrelatedRelease = `${unrelatedSha}-20260719T030405Z`;
      mkdirSync(join(after.releases, successorRelease), { mode: 0o700 });
      mkdirSync(join(after.releases, unrelatedRelease), { mode: 0o700 });
      const interrupted = runStart(
        after,
        cutAfterCas,
        successorSha,
        successorRelease,
        '3'.repeat(64),
      );
      expect(interrupted.status).toBe(98);
      const active = JSON.parse(readFileSync(after.journal, 'utf8')) as Record<string, unknown>;
      expect(active).toMatchObject({ candidate_sha: successorSha, phase: 'PREPARED' });
      const evidence = join(after.releases, oldRelease, 'superseded-transaction.json');
      const stage = join(after.releases, oldRelease, '.superseded-transaction.json.staging');
      expect(existsSync(evidence)).toBe(false);
      const stagedPayload = readFileSync(stage);

      const stagedDocument = JSON.parse(stagedPayload.toString('utf8')) as Record<string, unknown>;
      stagedDocument.supersession_proof_sha256 = '9'.repeat(64);
      chmodSync(stage, 0o600);
      writeFileSync(stage, `${JSON.stringify(stagedDocument)}\n`);
      chmodSync(stage, 0o400);
      const tampered = runStart(
        after,
        transactionRegion,
        successorSha,
        successorRelease,
        '3'.repeat(64),
      );
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain('evidence is unrelated to active successor');
      expect(JSON.parse(readFileSync(after.journal, 'utf8'))).toEqual(active);

      chmodSync(stage, 0o600);
      writeFileSync(stage, stagedPayload);
      chmodSync(stage, 0o400);
      const recovered = runStart(
        after,
        transactionRegion,
        successorSha,
        successorRelease,
        '3'.repeat(64),
      );
      expect(recovered.status).toBe(0);
      expect(existsSync(stage)).toBe(false);
      expect(existsSync(evidence)).toBe(true);
      expect(
        runStart(after, transactionRegion, successorSha, successorRelease, '3'.repeat(64)).status,
      ).toBe(0);
      const unrelated = runStart(
        after,
        transactionRegion,
        unrelatedSha,
        unrelatedRelease,
        '4'.repeat(64),
      );
      expect(unrelated.status).not.toBe(0);
      expect(unrelated.stderr).toContain('recovery does not match the active successor');
    } finally {
      rmSync(after.root, { recursive: true, force: true });
    }
  });

  it('keeps new operation surfaces present on disk', () => {
    for (const rel of [
      '.github/workflows/production-post-deploy-verify.yml',
      'scripts/deploy/post-deploy-verify.sh',
    ]) {
      expect(existsSync(join(REPO_ROOT, rel))).toBe(true);
    }
  });
});
