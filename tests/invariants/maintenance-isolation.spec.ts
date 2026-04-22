/**
 * Maintenance-Isolation Invariant
 * ============================================================================
 *
 * Closes CLAUDE-HIGH-012 — maintenance agents colocated with runtime agents.
 *
 * Post-Phase-4 of plan mutable-frolicking-yao.md, maintenance tooling lives
 * under `.claude/agents/_maintenance/`. These agents are intentionally NOT
 * part of the runtime review roster — they are invoked only by humans
 * explicitly (post-review planning, agent-prompt maintenance, WRITER
 * execution via `implement:` token).
 *
 * Tier-1 "make-it-impossible": filesystem subdirectory + this invariant
 * asserting the maintenance agent names never appear in the runtime-
 * dispatch surface (the orchestrator.md Runtime Review Roster table).
 *
 * Routing table primary cells are a different story — maintenance agents
 * legitimately own maintenance surfaces (prompt-writer owns agent-file
 * globs; gdpr-erasure-executor owns the GDPR cascade glob as a WRITER
 * dispatch target from compliance-expert). The invariant exempts those.
 *
 * # When this spec fails
 *
 *   - A maintenance agent name appears in a "Runtime Review Roster" table
 *     row → remove from roster OR move out of the maintenance subdir.
 *   - A maintenance file is missing from the filesystem check → the
 *     move-into-maintenance step of Phase 4 regressed.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAINTENANCE_DIR = path.join(REPO_ROOT, '.claude', 'agents', '_maintenance');
const ORCHESTRATOR_MD = path.join(REPO_ROOT, '.claude', 'agents', 'orchestrator.md');

function extractMaintenanceAgentNames(): string[] {
  if (!fs.existsSync(MAINTENANCE_DIR)) return [];
  const names: string[] = [];
  for (const entry of fs.readdirSync(MAINTENANCE_DIR)) {
    if (!entry.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(MAINTENANCE_DIR, entry), 'utf8');
    const nameMatch = content.match(/^name:\s*([a-z][a-z-]+)/m);
    if (nameMatch && nameMatch[1]) names.push(nameMatch[1]);
  }
  return names;
}

function extractRuntimeRosterRows(content: string): string[] {
  const start = content.indexOf('## Runtime Review Roster');
  const end = content.indexOf('## Auxiliary Maintenance Tooling');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'Could not bound Runtime Review Roster section in orchestrator.md',
    );
  }
  const section = content.slice(start, end);
  return section.split('\n').filter((l) => l.startsWith('|'));
}

describe('maintenance-isolation invariant (CLAUDE-HIGH-012)', () => {
  const maintenanceNames = extractMaintenanceAgentNames();
  const orchestratorContent = fs.existsSync(ORCHESTRATOR_MD)
    ? fs.readFileSync(ORCHESTRATOR_MD, 'utf8')
    : '';

  it('maintenance subdirectory is non-empty (regression guard)', () => {
    expect(maintenanceNames.length).toBeGreaterThanOrEqual(3);
  });

  it('every maintenance agent is absent from orchestrator Runtime Review Roster', () => {
    const rosterRows = extractRuntimeRosterRows(orchestratorContent);
    const violations: string[] = [];
    for (const name of maintenanceNames) {
      const rowRe = new RegExp(`^\\|\\s*${name}\\s*\\|`, 'm');
      for (const row of rosterRows) {
        if (rowRe.test(row)) {
          violations.push(`${name} appears in Runtime Review Roster row: ${row.trim()}`);
        }
      }
    }
    if (violations.length > 0) {
      const hint =
        'Move the row from "## Runtime Review Roster" to "## Auxiliary Maintenance Tooling" ' +
        'in .claude/agents/orchestrator.md, OR move the agent file out of _maintenance/.';
      throw new Error(`Maintenance-isolation violations:\n  - ${violations.join('\n  - ')}\n\n${hint}`);
    }
    expect(violations).toEqual([]);
  });

  it('maintenance agent presence is documented in Auxiliary Maintenance Tooling section', () => {
    // Soft-check: each maintenance agent should be mentioned in the
    // Auxiliary Maintenance Tooling section so operators can discover
    // them. This is documentation, not enforcement.
    const auxStart = orchestratorContent.indexOf('## Auxiliary Maintenance Tooling');
    const auxEnd = orchestratorContent.indexOf('## Invocation Examples');
    if (auxStart === -1 || auxEnd === -1 || auxEnd < auxStart) {
      throw new Error('Auxiliary Maintenance Tooling section not found in orchestrator.md');
    }
    const auxSection = orchestratorContent.slice(auxStart, auxEnd);
    const missing = maintenanceNames.filter((name) => !auxSection.includes(name));
    expect(missing).toEqual([]);
  });
});
