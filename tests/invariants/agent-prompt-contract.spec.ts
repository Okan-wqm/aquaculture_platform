import { readFileSync } from 'node:fs';
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

  it('every active prompt declares canonical references', () => {
    const missing = activeAgents
      .filter((file) => !file.content.includes('## Canonical References'))
      .map((file) => file.relPath);
    expect(missing).toEqual([]);
  });

  it('no active prompt mandates bare finding IDs', () => {
    const bareIdPattern = /format\s+`\{(?:severity|SEVERITY)\}-\{NNN\}`|original\s+`\{severity\}-\{NNN\}`/;
    const offenders = activeAgents
      .filter((file) => bareIdPattern.test(file.content))
      .map((file) => file.relPath);
    expect(offenders).toEqual([]);
  });

  it('architectural-arbiter uses the normalized ADR path and softened ADR scope', () => {
    const body = read('.claude/agents/architectural-arbiter.md');
    expect(body).toContain(
      'docs/recommendations/architectural-arbiter/{YYYY-MM-DD}-adr-{NNNN}-{topic}.md',
    );
    expect(body).toContain(
      'Every CRITICAL, HIGH, cross-context, ownership, event-contract, schema, or strategic arbitration MUST be persisted as an ADR',
    );
    expect(body).not.toContain('Every arbitration decision MUST be persisted as an ADR');
    expect(body).toContain('ARCH-{SEVERITY}-{NNN}');
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

  it('cross-cutting finding prefixes are unambiguous', () => {
    const securityReviewer = read('.claude/agents/security-reviewer.md');
    const testRunner = read('.claude/agents/test-runner.md');
    const outputFormat = read('.claude/shared/output-format.md');

    expect(securityReviewer).toContain('GSEC-{SEVERITY}-{NNN}');
    expect(securityReviewer).not.toContain('`SEC-{SEVERITY}-{NNN}`');
    expect(testRunner).toContain('TEST-{SEVERITY}-{NNN}');
    expect(outputFormat).toContain('GSEC-*');
    expect(outputFormat).toContain('TEST-*');
    expect(outputFormat).toContain('ARCH-*');
    expect(outputFormat).toContain('PRODUCT-{AGENT-PREFIX}-*');
  });

  it('test-runner does not claim unavailable web tools or primary build ownership', () => {
    const body = read('.claude/agents/test-runner.md');
    expect(body).not.toMatch(/WebSearch|WebFetch/);
    expect(body).toContain('Build and type-check execution is owned by `build-validator`');
    expect(body).not.toContain('Run `npm run build` or `npx nx run-many --target=build --all`');
  });

  it('edge-docs writers only own sens-api-gateway/docs outputs', () => {
    const readme = read('.claude/agents/edge-docs/README.md');
    expect(readme).toContain('WRITE only to `sens-api-gateway/docs/**`');
    expect(readme).toContain('`sensorprotocols/**`, root `docs/**`, source code, configs, and prompts are read-only evidence');
    expect(readme).toContain('Do not install dependencies, modify lockfiles/manifests, run network fetches');

    const outputPathPattern =
      /`docs\/(README|index|product|architecture|protocols|security|compliance|deployment|integration|operations|testing|api|commercial|siemens-rfp)(?:\/|\.md|`)/;
    const offenders = activeAgents
      .filter((file) => file.relPath.startsWith('.claude/agents/edge-docs/'))
      .filter((file) => outputPathPattern.test(file.content) || file.content.includes('Owns docs/'))
      .map((file) => file.relPath);
    expect(offenders).toEqual([]);
  });

  it('ARIA implementer branches before edits and scans secrets before push', () => {
    const body = read('.claude/agents/aria-implementer.md');
    expect(body).toMatch(/Mint and switch to the implementation branch[\s\S]*Apply key_changes/);
    expect(body).toMatch(/Stage and secret-scan before commit[\s\S]*Commit/);
    expect(body).toMatch(/Secret-scan committed patch[\s\S]*Open PR/);
    expect(body).not.toContain('17 refusal classes');
  });
});
