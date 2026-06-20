import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listActiveAgentFiles, REPO_ROOT } from './lib/agent-files';

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

const activeAgents = listActiveAgentFiles();

describe('agent prompt contract invariants', () => {
  it('discovers the active prompt corpus recursively', () => {
    expect(activeAgents.length).toBeGreaterThan(60);
    expect(activeAgents.map((file) => file.relPath)).toContain(
      '.claude/agents/edge-docs/edge-docs-orchestrator.md',
    );
    expect(activeAgents.map((file) => file.relPath)).toContain(
      '.claude/agents/_maintenance/aria-prompt-writer.md',
    );
  });

  it('retired prompt folders stay absent from active prompt discovery and disk', () => {
    const discovered = activeAgents.map((file) => file.relPath);
    expect(
      discovered.filter(
        (path) =>
          path.startsWith('.claude/test-agents/') ||
          path.startsWith('.claude/agents-enterprise-v2/') ||
          path.startsWith('.claude/agents.legacy/'),
      ),
    ).toEqual([]);

    for (const relPath of [
      '.claude/test-agents',
      '.claude/agents-enterprise-v2',
      '.claude/agents.legacy',
    ]) {
      expect(existsSync(join(REPO_ROOT, relPath))).toBe(false);
    }
  });

  it('ARIA prompts carry the canonical ARIA reference set', () => {
    const ariaAgents = activeAgents.filter(
      (file) =>
        file.filenameStem.startsWith('aria-') ||
        file.relPath.includes('/_maintenance/aria-'),
    );

    for (const file of ariaAgents) {
      expect(file.content).toContain('@.claude/knowledge/layer-1-aria.md');
      expect(file.content).toContain('@.claude/knowledge/layer-2-aria-canonical-envelope.md');
      expect(file.content).toContain('@docs/aria/SPEC.md');
      expect(file.content).toContain('@docs/aria/CONTRACTS.md');
    }
  });

  it('architectural-arbiter uses normalized ADR path and scoped ADR persistence', () => {
    const body = read('.claude/agents/architectural-arbiter.md');
    expect(body).toContain(
      'docs/recommendations/architectural-arbiter/{YYYY-MM-DD}-adr-{NNNN}-{topic}.md',
    );
    expect(body).toContain(
      'Every CRITICAL, HIGH, cross-context, ownership, event-contract, schema, strategic, prior-ADR-superseding, or agent-recommendation-superseding arbitration MUST be persisted as an ADR',
    );
    expect(body).not.toContain('Every arbitration decision is persisted as an ADR');
    expect(body).toContain('ARCH-{SEVERITY}-{NNN}');
  });

  it('prompt-writing rules require rationale and consequence, not bare commands', () => {
    const template = read('.claude/shared/_conversion-template.md');
    const promptWriter = read('.claude/agents/_maintenance/prompt-writer.md');

    expect(template).toContain('Rule / Why this exists / Protected invariant / Consequence if ignored');
    expect(template).toContain("No bare do/don't bullets");
    expect(promptWriter).toContain('why the rule exists, the invariant it protects, and the breakage caused by violation');
    expect(promptWriter).toContain('Explain consequence, not only prohibition');
  });

  it('cross-agent supersession requires coordination', () => {
    const handoff = read('.claude/shared/handoff-protocol.md');
    const modes = read('.claude/shared/operating-modes.md');
    const arbiter = read('.claude/agents/architectural-arbiter.md');

    expect(handoff).toContain('Supersession / destructive overlap');
    expect(handoff).toContain('MUST NOT silently overwrite');
    expect(modes).toContain("WRITER must not silently overwrite another agent's open work");
    expect(arbiter).toContain('coordinate supersession');
  });

  it('cross-cutting finding prefixes are unambiguous', () => {
    const securityReviewer = read('.claude/agents/security-reviewer.md');
    const testRunner = read('.claude/agents/test-runner.md');
    const outputFormat = read('.claude/shared/output-format.md');

    expect(securityReviewer).toContain('GSEC-{SEVERITY}-{NNN}');
    expect(testRunner).toContain('TEST-{SEVERITY}-{NNN}');
    expect(outputFormat).toContain('GSEC-*');
    expect(outputFormat).toContain('TEST-*');
    expect(outputFormat).toContain('ARCH-*');
    expect(outputFormat).toContain('PRODUCT-{AGENT-PREFIX}-*');
  });

  it('shared output prefixes map retired platform lanes to active owners', () => {
    const outputFormat = read('.claude/shared/output-format.md');

    expect(outputFormat).toContain('`PLAT-*` — platform-kernel-expert only');
    expect(outputFormat).toContain('`BILLING-*` — billing-expert');
    expect(outputFormat).toContain('`ALERT-*` — alert-engine-expert');
    expect(outputFormat).toContain('`OBS-*` — observability-expert');
    expect(outputFormat).toContain('`MSG-*` — messaging-expert');
    expect(outputFormat).not.toContain('platform-services');
    expect(outputFormat).not.toContain('billing/notification/config/event-store/observability');
    expect(outputFormat).not.toContain('`FARM-*`, `SENSOR-*`, `HR-*`, `MSG-*`, `ADMIN-*`');
  });

  it('Lane-B product-audit prompts use product-audit recommendation paths and PRODUCT sub-prefixes', () => {
    const laneB = activeAgents.filter((file) =>
      file.relPath.startsWith('.claude/agents/product-audit/'),
    );
    const legacyPath = laneB
      .filter((file) => file.content.includes('docs/recommendations/test-audits'))
      .map((file) => file.relPath);
    expect(legacyPath).toEqual([]);

    const missingProductPrefix = laneB
      .filter((file) => file.content.includes('Report finding ID format'))
      .filter((file) => !/PRODUCT-[A-Z0-9]+-\{SEVERITY\}-\{NNN\}/.test(file.content))
      .map((file) => file.relPath);
    expect(missingProductPrefix).toEqual([]);
  });

  it('test-runner does not claim unavailable web tools or primary build ownership', () => {
    const body = read('.claude/agents/test-runner.md');
    expect(body).not.toMatch(/WebSearch|WebFetch/);
    expect(body).toContain('Build and type-check execution is owned by `build-validator`');
    expect(body).not.toContain('Run `npm run build` or `npx nx run-many --target=build --all`');
  });

  it('ARIA implementer branches before edits and scans secrets before push', () => {
    const body = read('.claude/agents/aria-implementer.md');
    expect(body).toMatch(/Mint and switch to the implementation branch[\s\S]*Apply key_changes/);
    expect(body).toMatch(/Stage and secret-scan before commit[\s\S]*Commit/);
    expect(body).toMatch(/Secret-scan committed patch[\s\S]*Open PR/);
    expect(body).not.toContain('17 refusal classes');
  });
});
