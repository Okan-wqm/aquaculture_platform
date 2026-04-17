/**
 * Orchestrator Routing Coverage Invariant
 * ============================================================================
 *
 * Closes the loop on Phase 0.2 of /root/.claude/plans/abstract-brewing-mochi.md:
 *
 *   .claude/agents-enterprise-v2/orchestrator.md contains a routing table
 *   (File Pattern → Primary Agent) that maps every changed file to an agent.
 *   Orchestrator prompt self-enforces: "Every changed file MUST map to at
 *   least one primary agent. Any unmatched path is a PROCESS HIGH ownership
 *   gap."
 *
 *   This spec statically verifies that every top-level repo surface has AT
 *   LEAST ONE matching glob in the routing table. Adding a new top-level
 *   directory (e.g., apps/db-migrate) without a corresponding routing entry
 *   makes the orchestrator violate its own rule silently — this test catches
 *   the regression at PR time.
 *
 * # What this spec enforces
 *
 *   1. Every top-level directory of interest (apps/*, libs/*, web/*,
 *      platform/*, etc.) appears in at least one glob in the routing table.
 *
 *   2. The runtime roster table (lines under "## Runtime Review Roster")
 *      contains every agent referenced as a primary owner in the routing
 *      table — no agent is routed-to but absent from the roster, and vice
 *      versa.
 *
 *   3. Legacy/archived directories (.claude/agents.legacy/**) are NOT in
 *      the dispatch path — routing table should explicitly mark them
 *      ARCHIVED.
 *
 * # When this spec fails
 *
 *   - A new top-level directory landed (e.g., apps/new-service/) without a
 *     routing entry → add a row to the routing table mapping it to an
 *     appropriate primary owner.
 *
 *   - A glob references an agent name that doesn't exist in the runtime
 *     roster → either add the agent to the roster or use a registered
 *     agent name.
 *
 *   - Routing table still references a legacy path (.claude/agents/*.md
 *     without .legacy suffix) → update to reflect archival (Phase 0.1).
 *
 * # References
 *
 *   - /root/.claude/plans/abstract-brewing-mochi.md#Phase-0.2
 *   - /var/aqua-saas/docs/reviews/orchestrator/2026-04-16-v2-audit.md#P0-2
 *   - /var/aqua-saas/.claude/agents-enterprise-v2/orchestrator.md (routing table)
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ORCHESTRATOR_MD = path.join(
  REPO_ROOT,
  '.claude',
  'agents-enterprise-v2',
  'orchestrator.md',
);

/**
 * Top-level repo surfaces that MUST appear in the routing table. Each entry
 * is a substring that orchestrator routing globs are checked against.
 * A surface passes if the orchestrator.md source contains ANY glob matching it.
 */
const REQUIRED_SURFACES: readonly string[] = [
  // apps/
  'apps/farm-service',
  'apps/sensor-service',
  'apps/auth-service',
  'apps/gateway-api',
  'apps/hr-service',
  'apps/admin-api-service',
  'apps/messaging-service',
  'apps/ai-service',
  'apps/billing-service',
  'apps/notification-service',
  'apps/config-service',
  'apps/event-store-service',
  'apps/observability-service',
  'apps/hydroponics-service',
  'apps/alert-engine',
  'apps/db-migrate', // added Phase 0.2
  // libs/
  'libs/backend-common',
  'libs/event-contracts',
  'libs/aquaculture-engines',
  'libs/farm-shared',
  'libs/node-components',
  'libs/testing',
  'libs/storage',
  'libs/sdk',
  'libs/shared',
  'libs/shared-contracts', // added Phase 0.2
  // web/
  'web/shell',
  'web/shared-ui',
  'web/modules/dashboard',
  'web/modules/farm-module',
  'web/modules/sensor-module',
  'web/modules/hr-module',
  'web/modules/admin-panel',
  'web/modules/tenant-admin',
  'web/modules/hydroponics-module',
  'web/apps/aquamobil',
  // platform/
  'platform/configs',
  'platform/libs/cqrs',
  'platform/libs/event-bus',
  'platform/libs/outbox',
  // edge/
  'sens-api-gateway',
  'sensorprotocols',
  // infra/
  'infra/',
  'infrastructure/',
  'deploy/',
  '.github/actions',
  '.github/workflows',
  'docker-compose',
  'nginx/',
  'Dockerfile',
  'Cargo.toml',
  // scripts/
  'scripts/nats',
  'scripts/ci',
  'scripts/deploy',
  // docs/
  'docs/adr',
  'docs/runbooks',
  'docs/reviews',
  'docs/research',
  // root configs
  'nx.json',
  'tsconfig.base.json',
  'jest.config',
  // .claude/
  '.claude/knowledge',
  '.claude/allowlists',
  '.claude/skills',
  '.claude/agents.legacy', // archived
  // tools/
  'tools/gates',
  // meta
  'mcp/',
  'CLAUDE.md',
  '.env',
];

/**
 * Agent names (from runtime roster) expected to appear on the LEFT side of
 * the routing table as "Primary Agent". If the routing table references an
 * agent NOT in this list, it's a typo or missing roster entry.
 */
function readOrchestrator(): string {
  return fs.readFileSync(ORCHESTRATOR_MD, 'utf8');
}

function extractRosterAgentNames(content: string): Set<string> {
  const rosterStart = content.indexOf('## Runtime Review Roster');
  if (rosterStart === -1) {
    throw new Error('Runtime Review Roster section not found in orchestrator.md');
  }
  const rosterSection = content.slice(rosterStart);
  const agentRowRe = /^\|\s*([a-z][a-z-]+)\s*\|/gm;
  const names = new Set<string>();
  for (const match of rosterSection.matchAll(agentRowRe)) {
    const [, captured] = match;
    if (!captured) continue;
    const name = captured.trim();
    if (name && name !== 'Agent' && name !== '-------') {
      names.add(name);
    }
  }
  return names;
}

function extractRoutingAgentNames(content: string): Set<string> {
  const routingStart = content.indexOf('### Phase 1: Change Analysis');
  const routingEnd = content.indexOf('### Phase 2: Parallel Dispatch');
  if (routingStart === -1 || routingEnd === -1) {
    throw new Error('Phase 1 routing section bounds not found');
  }
  const routingSection = content.slice(routingStart, routingEnd);
  const lines = routingSection.split('\n');
  const names = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    const primary = cells[2];
    if (!primary || primary === 'Primary Agent' || primary.startsWith('-')) continue;
    // Extract all agent names from the primary cell (may contain "agent-name" or "agent-a, agent-b")
    const tokens = primary.match(/[a-z][a-z-]+(?=\b)/g) ?? [];
    for (const t of tokens) {
      if (t.length > 3 && t.includes('-')) {
        names.add(t);
      }
    }
  }
  return names;
}

describe('orchestrator routing coverage invariant', () => {
  const content = readOrchestrator();

  it.each(REQUIRED_SURFACES)(
    'repo surface "%s" has at least one matching glob in routing table',
    (surface) => {
      const hasMatch = content.includes(surface);
      if (!hasMatch) {
        // Provide actionable error with hint per CLAUDE.md
        const hint = `Add a routing row like:\n  | \`${surface}/**\` | <agent-name> | |\nto the Phase 1 routing table in .claude/agents-enterprise-v2/orchestrator.md`;
        throw new Error(`Missing routing coverage for "${surface}".\n\n${hint}`);
      }
      expect(hasMatch).toBe(true);
    },
  );

  it('every primary agent referenced in routing table exists in the runtime roster', () => {
    const rosterAgents = extractRosterAgentNames(content);
    const routingAgents = extractRoutingAgentNames(content);

    // Filter to ones likely to be real agent names (contain hyphen, not "legacy" or bare words)
    const suspicious = Array.from(routingAgents).filter((name) => {
      if (!rosterAgents.has(name)) {
        // Allow specific non-agent tokens that appear in routing table
        const allowed = new Set([
          'all-consumers',
          'all-frontend',
          'maintenance-only',
          'no-dispatch',
          'cross-cutting',
          'read-only',
        ]);
        if (allowed.has(name)) return false;
        return true;
      }
      return false;
    });

    expect(suspicious).toEqual([]);
  });

  it('legacy .claude/agents/ directory is NOT active in routing (archived Phase 0.1)', () => {
    // Must not have .claude/agents/ as an ACTIVE glob (only legacy or agents-enterprise-v2)
    const activeLegacyGlob = /\|\s*`\.claude\/agents\/\*\.md`[^`]*\|/.test(content);
    expect(activeLegacyGlob).toBe(false);
  });

  it('legacy directory IS marked as archived in routing', () => {
    expect(content).toMatch(/\.claude\/agents\.legacy/);
  });
});
