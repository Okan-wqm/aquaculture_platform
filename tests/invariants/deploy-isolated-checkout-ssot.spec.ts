import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/**
 * Strip shell comments + blank lines so assertions about EXECUTABLE behavior
 * are not satisfied (or false-tripped) by prose in comment blocks.
 */
function executableShell(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * Extract the inline `script: |` body of a named ssh-action SSH step from the
 * deploy workflow so we assert against what actually runs on the droplet, not
 * incidental matches elsewhere in the YAML.
 */
function extractSshScriptBlock(workflow: string, stepName: string): string {
  const idx = workflow.indexOf(stepName);
  if (idx < 0) return '';
  const after = workflow.slice(idx);
  const scriptMatch =
    /script: \|\n([\s\S]*?)(?=\n {6}- name:|\n {2}[a-zA-Z0-9_-]+:\n|\n {0,4}\S|$)/.exec(after);
  return scriptMatch?.[1] ?? '';
}

/**
 * SSoT contract for the deploy's isolated, SHA-pinned source checkout.
 *
 * The production deploy must run from a DEDICATED, deploy-owned git worktree
 * (DEPLOY_CHECKOUT_DIR) pinned to the exact deploy SHA — never from the shared,
 * session-mutated /var/aqua-saas interactive working tree. Sharing that tree
 * let the deploy's force-checkout fight live engineering/agent sessions and let
 * post-deploy-verify's `git rev-parse HEAD == TARGET_SHA` guard FALSE-FAIL when
 * a session had drifted HEAD onto a feature branch (real incident:
 * expected=<sha> actual=<feature-branch-sha> with correct images deployed).
 *
 * Tier-3 (detectable): if a future edit re-points the deploy at the shared
 * working tree, or duplicates the checkout-dir constant, this spec fails at PR
 * time.
 */
describe('deploy isolated SHA-pinned checkout SSOT', () => {
  const paths = read('scripts/deploy/deploy-paths.sh');
  const dropletUp = read('scripts/deploy/droplet-up.sh');
  const verify = read('scripts/deploy/post-deploy-verify.sh');
  const workflow = read('.github/workflows/deploy-digitalocean.yml');
  const capacityMaintenance = read('.github/workflows/deploy-capacity-maintenance.yml');

  it('defines the deploy-checkout path constant exactly once, in deploy-paths.sh', () => {
    // Single source of truth: the literal default path appears only in the SSoT
    // snippet. Every consumer reads ${DEPLOY_CHECKOUT_DIR}, never a duplicate.
    const corpus = [paths, dropletUp, verify, workflow];
    const literalHits = corpus
      .map((src) => (src.match(/\/var\/lib\/aqua\/deploy\/checkout/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(literalHits).toBe(1);
    expect(paths).toContain(
      'export DEPLOY_CHECKOUT_DIR="${DEPLOY_CHECKOUT_DIR:-/var/lib/aqua/deploy/checkout}"',
    );

    // The checkout dir is a sibling of the existing release-state root; the
    // deploy already owns /var/lib/aqua/deploy.
    expect(paths).toContain('/var/lib/aqua/deploy/');
  });

  it('declares the persistent secrets SSoT (env + certs) and the source repo, all in one place', () => {
    expect(paths).toContain('export DEPLOY_SOURCE_REPO="${DEPLOY_SOURCE_REPO:-/var/aqua-saas}"');
    expect(paths).toContain(
      'export DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-${DEPLOY_SOURCE_REPO}/.env}"',
    );
    expect(paths).toContain(
      'export DEPLOY_CERTS_DIR="${DEPLOY_CERTS_DIR:-${DEPLOY_SOURCE_REPO}/certs}"',
    );
  });

  it('pins COMPOSE_PROJECT_NAME=aqua-saas (data-loss guard: cwd change must not re-derive volumes)', () => {
    // Compose derives the project name — and therefore every named volume
    // (postgres data, NATS JetStream, MinIO, redis) — from the cwd basename by
    // default. The live droplet's volumes are `aqua-saas_*`; running compose from
    // the isolated checkout (basename `checkout`) WITHOUT this pin would create
    // empty `checkout_*` volumes = catastrophic data loss. Pin must live in the
    // SSoT snippet, exported, so every compose call inherits it.
    expect(paths).toContain('export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aqua-saas}"');
  });

  it('provides an idempotent worktree materializer that pins (detached) without touching the interactive tree', () => {
    const exec = executableShell(paths);
    expect(exec).toContain('materialize_deploy_checkout()');
    // Fetch goes into the SHARED object store of the source repo (refs/objects
    // only) — it never force-checkouts the interactive working tree's HEAD.
    expect(exec).toContain('git -C "${src}" fetch --force --prune origin');
    // Stale-state robustness: prune admin records before add/remove decisions.
    expect(exec).toContain('git -C "${src}" worktree prune');
    // Missing dir -> add detached/force; existing healthy -> re-pin detached.
    expect(exec).toContain('git -C "${src}" worktree add --detach --force "${dir}" "${sha}"');
    expect(exec).toContain('git -C "${dir}" checkout -f --detach "${sha}"');
    // Corrupt-dir branch removes + recreates so the deploy always runs clean.
    expect(exec).toContain('git -C "${src}" worktree remove --force "${dir}"');
    // Crashed-run lock is cleared so a re-deploy is never wedged.
    expect(exec).toContain('index.lock');
    // Persistent secrets are symlinked in (no migration), so cwd-relative
    // compose mounts + cert generation resolve to the stable location.
    expect(exec).toContain('ln -sfn "${DEPLOY_ENV_FILE}" "${dir}/.env"');
    expect(exec).toContain('ln -sfn "${DEPLOY_CERTS_DIR}" "${dir}/certs"');
    // Pin is asserted before returning success.
    expect(exec).toContain('failed to pin');
  });

  it('runs droplet-up.sh from the isolated checkout, never force-checking-out the shared tree', () => {
    const exec = executableShell(dropletUp);
    // Sources the SSoT snippet from the PERSISTENT source repo (the checkout it
    // creates may not exist yet on first deploy).
    expect(exec).toContain(
      'source "${DEPLOY_SOURCE_REPO:-/var/aqua-saas}/scripts/deploy/deploy-paths.sh"',
    );
    expect(exec).toContain('materialize_deploy_checkout "${DEPLOY_SHA}"');
    expect(exec).toContain('cd "${DEPLOY_CHECKOUT_DIR}"');

    // The deploy source must NOT be the interactive working tree anymore.
    expect(exec).not.toMatch(/\bcd\s+\/var\/aqua-saas\b/);
    // No force-checkout of any tree as the deploy-source step (the materializer
    // owns the detached pin via `checkout -f --detach`, which lives in
    // deploy-paths.sh, not here).
    expect(exec).not.toMatch(/git\s+checkout\s+-f\s+\$\{?DEPLOY_SHA/);
    expect(exec).not.toContain('git fetch --force --prune origin\ngit checkout -f');

    // Persistent secrets surface is read from the SSoT vars, not a hardcoded
    // interactive path.
    expect(exec).not.toMatch(/ENV_FILE="\/var\/aqua-saas\/\.env"/);
    expect(exec).not.toMatch(/JWT_KEY_DIR="\/var\/aqua-saas\/certs\/jwt"/);
    expect(exec).toContain('JWT_KEY_DIR="${DEPLOY_CERTS_DIR}/jwt"');
  });

  it('verifies from the isolated checkout so the HEAD == TARGET_SHA guard is a true invariant', () => {
    const exec = executableShell(verify);
    // Piped over SSH via `bash -s` -> source the SSoT from the persistent repo.
    expect(exec).toContain(
      'source "${DEPLOY_SOURCE_REPO:-/var/aqua-saas}/scripts/deploy/deploy-paths.sh"',
    );
    expect(exec).toContain('cd "${DEPLOY_CHECKOUT_DIR}"');
    expect(exec).not.toMatch(/\bcd\s+\/var\/aqua-saas\b/);
    // The HEAD check remains, now against the deploy-owned worktree.
    expect(exec).toContain('deployed_head="$(git rev-parse HEAD)"');
    expect(exec).toContain('"${deployed_head}" != "${TARGET_SHA}"');
  });

  it('materializes + cd-s into the checkout in BOTH deploy SSH blocks (capacity + deploy), under the 21K limit', () => {
    const capacityBlock = extractSshScriptBlock(
      workflow,
      'Capacity preflight on production droplet',
    );
    const deployBlock = extractSshScriptBlock(workflow, 'Deploy to DigitalOcean Droplet');

    for (const block of [capacityBlock, deployBlock]) {
      expect(block).not.toEqual('');
      const exec = executableShell(block);
      // deploy-paths.sh is read from the DEPLOY_SHA via `git show` (object store,
      // working-tree-independent — ORPHAN-211) then sourced from the extracted copy,
      // so a stale /var/aqua-saas checkout can never break the bootstrap.
      expect(exec).toContain('git show "${DEPLOY_SHA}:scripts/deploy/deploy-paths.sh"');
      expect(exec).toContain('source /var/lib/aqua/deploy/deploy-paths.sh');
      expect(exec).toContain('materialize_deploy_checkout "${DEPLOY_SHA}"');
      expect(exec).toContain('cd "${DEPLOY_CHECKOUT_DIR}"');
      // The deploy may `cd /var/aqua-saas` ONLY to fetch objects / `git show` a blob
      // (read-only); it must NEVER checkout or otherwise mutate that shared
      // interactive working tree.
      expect(exec).not.toMatch(/git\s+checkout\b/);
      // GitHub Actions hard-caps a single `${{ }}`/script expression at 21,000
      // chars; the thin-invoker form keeps each SSH block far under it.
      expect(block.length).toBeLessThan(21000);
    }

    // DEPLOY_CHECKOUT_DIR is forwarded into both remote sessions so an operator
    // override propagates from the workflow to the droplet scripts.
    expect(capacityBlock || workflow).toContain('DEPLOY_CHECKOUT_DIR');
    expect(workflow).toContain(
      'envs: DEPLOY_SERVICES,FULL_DEPLOY,DEPLOY_MODE,DEPLOY_SHA,IMAGE_PREFIX,DEPLOY_CHECKOUT_DIR',
    );
  });

  it('runs scheduled capacity maintenance from the same SHA-pinned checkout without mutating the source repo', () => {
    const block = extractSshScriptBlock(
      capacityMaintenance,
      'Run capacity operation through production deploy control plane',
    );
    const exec = executableShell(block);

    expect(block).not.toEqual('');
    expect(exec).toContain('git show "${TARGET_SHA}:scripts/deploy/deploy-paths.sh"');
    expect(exec).toContain('source /var/lib/aqua/deploy/deploy-paths.sh');
    expect(exec).toContain('materialize_deploy_checkout "${TARGET_SHA}"');
    expect(exec).toContain('cd "${DEPLOY_CHECKOUT_DIR}"');
    expect(exec).not.toMatch(/git\s+checkout\b/);
  });

  it('preserves the rollback + health-gate + public https smoke behavior (untouched by isolation)', () => {
    // Guard against an isolation refactor accidentally deleting the deploy's
    // safety gates. These remain in droplet-up.sh exactly as before.
    expect(dropletUp).toContain('rollback_and_record');
    expect(dropletUp).toContain('check-service-health.ts');
    expect(dropletUp).toContain('Public /graphql smoke through nginx');
    expect(dropletUp).toContain('https://${SMOKE_HOST}');
  });
});
