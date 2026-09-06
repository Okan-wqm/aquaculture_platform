import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { captureCaseAuthority } from '../src/case-authority.ts';
import { loadConfig } from '../src/config.ts';
import { addPrincipal, revokePrincipal, tokenDigest } from '../src/principals.ts';

for (const change of ['none', 'revoke', 'scope', 'credential', 'role', 'registry', 'manifest', 'runtime', 'policy'] as const) {
  test(`inventory publication checks the authority captured at submission: ${change}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'legal-authority-'));
    try {
      const instanceManifest = join(root, 'instance.json');
      const approvalPolicy = join(root, 'approval.json');
      writeFileSync(instanceManifest, JSON.stringify({ id: 'test', runtime: { allow_actions: true }, policies: { approval: 'approval.json' } }));
      writeFileSync(approvalPolicy, JSON.stringify({ roles: [{ id: 'lawyer' }], gates: [{ action_class: 'corpus_inventory', auto: false, requires_role: 'lawyer' }] }));
      const config = loadConfig({ ARIA_INSTANCE_MANIFEST: instanceManifest, ARIA_TOOLS_DIR: join(root, 'tools'), ARIA_WORKSPACE_ROOT: root, ARIA_UI_PRINCIPALS_FILE: join(root, 'principals.json'), ARIA_UI_ALLOW_ACTIONS: '1' });
      assert.ok(config.principalsFile);
      mkdirSync(config.toolsDir, { recursive: true });
      const registry = join(config.toolsDir, 'registry.json');
      writeFileSync(registry, JSON.stringify({ tools: [{ tool_id: 'legal-document-inventory', status: 'SHADOW', version: '0.1.0' }] }));
      const manifest = join(root, 'packs/legal/adapters/legal-document-inventory.tool.json');
      mkdirSync(join(root, 'packs/legal/adapters'), { recursive: true });
      writeFileSync(manifest, '{"tool_id":"legal-document-inventory"}');
      const person = addPrincipal(config.principalsFile, { id: 'lawyer', displayName: 'Lawyer', role: 'lawyer', cases: ['case-001'] }, '2026-09-06T00:00:00.000Z');
      const assertCurrent = captureCaseAuthority(config, `Bearer ${person.token}`, 'case-001');
      assert.doesNotThrow(assertCurrent);
      if (change === 'revoke') revokePrincipal(config.principalsFile, person.record.id, '2026-09-06T00:01:00.000Z');
      if (change === 'scope' || change === 'credential' || change === 'role') {
        const directory = JSON.parse(readFileSync(config.principalsFile, 'utf8'));
        if (change === 'scope') directory.principals[0].cases = ['case-002'];
        else if (change === 'role') directory.principals[0].role = 'operator';
        else directory.principals[0].tokenSha256 = tokenDigest('changed-token');
        writeFileSync(config.principalsFile, JSON.stringify(directory));
      }
      if (change === 'runtime') writeFileSync(join(config.toolsDir, 'runtime-profile.json'), JSON.stringify({ profile: 'frozen' }));
      if (change === 'policy') writeFileSync(approvalPolicy, JSON.stringify({ roles: [{ id: 'operator' }], gates: [{ action_class: 'corpus_inventory', auto: false, requires_role: 'operator' }] }));
      if (change === 'registry') writeFileSync(registry, JSON.stringify({ tools: [{ tool_id: 'legal-document-inventory', status: 'QUARANTINED', version: '0.1.0' }] }));
      if (change === 'manifest') writeFileSync(manifest, '{"tool_id":"legal-document-inventory","version":"changed"}');
      if (change === 'none') {
        addPrincipal(config.principalsFile, { id: 'another', displayName: 'Another', role: 'lawyer', cases: ['case-002'] }, '2026-09-06T00:01:00.000Z');
        assert.doesNotThrow(assertCurrent, 'unrelated principal administration does not invalidate this case');
      } else assert.throws(assertCurrent, { code: 'legal_job_authority_changed' });
    } finally { rmSync(root, { recursive: true }); }
  });
}
