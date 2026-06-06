import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

describe('production operations proof contract', () => {
  it('has a GitHub-Actions-owned post-deploy verification workflow', () => {
    const workflow = read('.github/workflows/production-post-deploy-verify.yml');
    const script = read('scripts/deploy/post-deploy-verify.sh');

    expect(workflow).toContain('name: Production Post-Deploy Verify');
    const ciAffected = read('.github/workflows/ci-affected.yml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('workflow_call:');
    expect(workflow).not.toContain('workflow_run:');
    expect(workflow).toContain('environment: production');
    expect(ciAffected).toContain('production-post-deploy-verify:');
    expect(ciAffected).toContain("needs.deploy.result == 'success'");
    expect(ciAffected).toContain('uses: ./.github/workflows/production-post-deploy-verify.yml');
    expect(ciAffected).toContain('target_sha: ${{ github.sha }}');
    expect(workflow).toContain('deployed/production');
    expect(workflow).toContain('scripts/deploy/post-deploy-verify.sh');
    expect(workflow).toContain('production-post-deploy-evidence.json');
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(workflow).not.toMatch(/appleboy\/ssh-action/);

    expect(script).toContain('platform.release_ledger');
    expect(script).toContain("release_status");
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
