import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
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

    // The watchdog judges the newest COMPLETED run. An in-progress run's
    // conclusion is null, and judging per_page:1 turned every mid-run poll
    // into a "missing" incident — a */5-cron workflow with a 1h threshold
    // tripped it every hour. Pinned both ways: the completed filter must be
    // present, and the single-run fetch must not come back.
    expect(workflow).toContain("candidate.status === 'completed'");
    expect(workflow).not.toContain('per_page: 1,');
  });

  it('has a GitHub-Actions-owned post-deploy verification workflow', () => {
    const workflow = read('.github/workflows/production-post-deploy-verify.yml');
    const script = read('scripts/deploy/post-deploy-verify.sh');

    expect(workflow).toContain('name: Production Post-Deploy Verify');
    const ciAffected = read('.github/workflows/ci-affected.yml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('workflow_call:');
    expect(workflow).not.toContain('workflow_run:');
    expect(workflow).toContain('environment: production');
    // CI-Affected is the release orchestration SSoT on push-to-main. The
    // verifier must run only after the production reusable workflow reports
    // that a droplet mutation actually happened, not merely because a called
    // workflow returned success.
    expect(ciAffected).toContain('production-post-deploy-verify:');
    expect(ciAffected).toContain("needs.deploy-production.outputs.deployed == 'true'");
    expect(ciAffected).toContain('uses: ./.github/workflows/production-post-deploy-verify.yml');
    expect(ciAffected).toContain('target_sha: ${{ github.sha }}');
    expect(ciAffected).not.toContain("needs.deploy.result == 'success'");
    expect(workflow).toContain('deployed/production');
    expect(workflow).toContain('scripts/deploy/post-deploy-verify.sh');
    expect(workflow).toContain('production-post-deploy-evidence.json');
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
    expect(script).toContain('sha256sum "${digest_manifest}"');
    expect(script).toContain('node scripts/deploy/check-service-health.ts');
    expect(script).toContain('/health/ready');
    expect(script).toContain('/health/live');
    expect(script).toContain('"status": "ok"');
    expect(script).toContain('service-catalog.deploy.vars');
    expect(script).toContain('CATALOG_READINESS_SERVICES');
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
