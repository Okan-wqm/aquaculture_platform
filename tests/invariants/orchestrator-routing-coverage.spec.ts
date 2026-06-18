/**
 * Orchestrator Routing Coverage Invariant
 * ============================================================================
 *
 * Closes the loop on Phase 0.2 of /root/.claude/plans/abstract-brewing-mochi.md:
 *
 *   .claude/agents/orchestrator.md contains a routing table
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
 *   3. Retired prompt directories are NOT in the dispatch path. They should
 *      be absent rather than archived because stale prompt copies recreate
 *      duplicate names and obsolete ownership/output contracts.
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
 *   - Routing table still references a retired prompt directory → delete
 *     the route and migrate any still-needed guidance into the active owner.
 *
 * # References
 *
 *   - /root/.claude/plans/abstract-brewing-mochi.md#Phase-0.2
 *   - /var/aqua-saas/docs/reviews/orchestrator/2026-04-16-v2-audit.md#P0-2
 *   - /var/aqua-saas/.claude/agents/orchestrator.md (routing table)
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ORCHESTRATOR_MD = path.join(
  REPO_ROOT,
  '.claude',
  'agents',
  'orchestrator.md',
);
const ROUTING_TABLE_MD = path.join(
  REPO_ROOT,
  '.claude',
  'shared',
  'orchestrator-routing-table.md',
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

/**
 * Orchestrator was split into three files per
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md Phase 1
 * W3 Wave 3: orchestrator.md keeps the runtime roster + decision rules,
 * _shared/orchestrator-routing-table.md carries the glob → agent table,
 * _shared/orchestrator-phases.md carries Phase 2-6 details. Surface-
 * coverage + routing-primary-agent checks scan BOTH orchestrator.md and
 * the routing-table companion; roster checks remain orchestrator.md-only
 * (the table structure that extractRosterAgentNames parses lives there).
 */
function readOrchestratorFamily(): string {
  const primary = fs.readFileSync(ORCHESTRATOR_MD, 'utf8');
  const routing = fs.existsSync(ROUTING_TABLE_MD)
    ? fs.readFileSync(ROUTING_TABLE_MD, 'utf8')
    : '';
  return primary + '\n' + routing;
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
  // Phase 1 routing lives either inline in orchestrator.md (pre-split shape)
  // OR in _shared/orchestrator-routing-table.md under a "## Routing Table"
  // header (post-split shape). Accept either — both contain a markdown
  // table whose second column is the Primary Agent.
  let routingSection: string;
  const inlineStart = content.indexOf('### Phase 1: Change Analysis');
  const inlineEnd = content.indexOf('### Phase 2: Parallel Dispatch');
  const companionStart = content.indexOf('## Routing Table');
  const companionEnd = content.indexOf('## Special dispatch rules');
  if (inlineStart !== -1 && inlineEnd !== -1 && inlineEnd > inlineStart) {
    routingSection = content.slice(inlineStart, inlineEnd);
  } else if (
    companionStart !== -1 &&
    companionEnd !== -1 &&
    companionEnd > companionStart
  ) {
    routingSection = content.slice(companionStart, companionEnd);
  } else {
    throw new Error(
      'Routing table bounds not found — checked inline "### Phase 1 … ### Phase 2" and companion "## Routing Table … ## Special dispatch rules"',
    );
  }
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
  // Surface + routing checks read BOTH orchestrator.md AND the routing-table
  // companion (post-split shape). Roster check reads orchestrator.md ONLY —
  // the runtime roster table structure that extractRosterAgentNames parses
  // lives there.
  const orchestratorOnly = readOrchestrator();
  const family = readOrchestratorFamily();

  it.each(REQUIRED_SURFACES)(
    'repo surface "%s" has at least one matching glob in routing table',
    (surface) => {
      const hasMatch = family.includes(surface);
      if (!hasMatch) {
        const hint = `Add a routing row like:\n  | \`${surface}/**\` | <agent-name> | |\nto the routing table in .claude/shared/orchestrator-routing-table.md`;
        throw new Error(`Missing routing coverage for "${surface}".\n\n${hint}`);
      }
      expect(hasMatch).toBe(true);
    },
  );

  it('every primary agent referenced in routing table exists in the runtime roster', () => {
    const rosterAgents = extractRosterAgentNames(orchestratorOnly);
    const routingAgents = extractRoutingAgentNames(family);

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

  it('retired prompt directories are NOT referenced as active in routing', () => {
    // After the 2026-04-18 flat-layout restructure, agents live at .claude/agents/
    // (Lane-A root) + .claude/agents/product-audit/ (Lane-B). Any routing glob
    // pointing to a retired prompt directory is drift from a pre-restructure
    // era and must not reappear.
    const oldEnterpriseGlob = /\|\s*`\.claude\/agents-enterprise-v2\/[^`]*`/.test(family);
    const oldTestAgentsGlob = /\|\s*`\.claude\/test-agents\/[^`]*`/.test(family);
    const oldLegacyGlob = /\|\s*`\.claude\/agents\.legacy\/[^`]*`/.test(family);
    expect(oldEnterpriseGlob).toBe(false);
    expect(oldTestAgentsGlob).toBe(false);
    expect(oldLegacyGlob).toBe(false);
  });

  /**
   * Phase 4.5 mechanical-trigger clause invariant (CLAUDE-MEDIUM-009).
   *
   * The orchestrator-phases.md § Phase 4.5 prose must contain an explicit
   * "MUST dispatch root-cause-auditor when" clause. Silent prose removal
   * is the CLAUDE-MEDIUM-009 failure mode — Phase 4.5 dispatch becomes
   * discretionary again and tier-claim verification degrades.
   */
  it('Phase 4.5 prose contains the mechanical root-cause-auditor dispatch clause', () => {
    const phasesPath = path.join(REPO_ROOT, '.claude', 'shared', 'orchestrator-phases.md');
    const content = fs.existsSync(phasesPath) ? fs.readFileSync(phasesPath, 'utf8') : '';
    const hasClause = /MUST dispatch\s+`?root-cause-auditor`?/i.test(content);
    if (!hasClause) {
      throw new Error(
        'orchestrator-phases.md is missing the "MUST dispatch root-cause-auditor when ..." clause. ' +
          'Restore the clause in § Phase 4.5; its removal turns mechanical trigger back into prose-only guidance.',
      );
    }
    expect(hasClause).toBe(true);
  });

  /**
   * Reverse coverage — every roster agent must be reachable from at least
   * one glob cell (primary OR also-notify) across Lane-A routing table
   * AND Lane-B product-audit/orchestrator.md Phase 1 table.
   *
   * Closes CLAUDE-HIGH-008 — routing-coverage reverse-check gap. Five
   * Lane-B agents (accessibility-auditor, edge-industrial-auditor,
   * billing-reconciliation-auditor, webhook-ingress-auditor,
   * job-queue-auditor) had zero dispatch globs until 2026-04-18 without
   * any CI failure.
   *
   * Exemptions:
   *   - Agents with `dispatch: cross-cutting` / `dispatch: ad-hoc` /
   *     `dispatch: maintenance` frontmatter are explicitly non-glob.
   *   - Maintenance agents at `.claude/agents/_maintenance/**` (Phase 4
   *     filesystem separation) never appear in the runtime roster, so
   *     they are outside this coverage check by construction.
   */
  it('every roster agent is reachable from at least one glob (primary OR also-notify)', () => {
    // Build combined roster (Lane-A + Lane-B specialists).
    const laneARoster = extractRosterAgentNames(orchestratorOnly);
    const productAuditOrchestratorPath = path.join(
      REPO_ROOT,
      '.claude',
      'agents',
      'product-audit',
      'orchestrator.md',
    );
    const productAuditRoutingPath = path.join(
      REPO_ROOT,
      '.claude',
      'shared',
      'product-audit-orchestrator-routing.md',
    );
    const laneBOrchestratorContent = fs.existsSync(productAuditOrchestratorPath)
      ? fs.readFileSync(productAuditOrchestratorPath, 'utf8')
      : '';
    // Post-Phase-3 split (plan mutable-frolicking-yao.md): the Phase 1
    // routing table lives in the companion shared fragment. Concat it so
    // this reverse-coverage check reads both halves.
    const laneBRoutingContent = fs.existsSync(productAuditRoutingPath)
      ? fs.readFileSync(productAuditRoutingPath, 'utf8')
      : '';
    // Lane-B roster = every agent file in .claude/agents/product-audit/*.md
    // that carries a `name:` frontmatter line.
    const laneBRoster = new Set<string>();
    const laneBDir = path.join(REPO_ROOT, '.claude', 'agents', 'product-audit');
    if (fs.existsSync(laneBDir)) {
      for (const f of fs.readdirSync(laneBDir)) {
        if (!f.endsWith('.md')) continue;
        if (f === 'README.md' || f === 'INVOCATION-PACK.md') continue;
        const fileContent = fs.readFileSync(path.join(laneBDir, f), 'utf8');
        const nameMatch = fileContent.match(/^name:\s*([a-z][a-z-]+)/m);
        if (nameMatch && nameMatch[1]) laneBRoster.add(nameMatch[1]);
      }
    }

    // Combined reachability set = every agent name that appears in ANY cell
    // of either routing table (primary OR also-notify).
    const reachable = new Set<string>();
    const combinedRouting =
      family + '\n' + laneBOrchestratorContent + '\n' + laneBRoutingContent;
    const agentNameRe = /[a-z][a-z0-9-]+-(expert|auditor|reviewer|executor|enforcer|planner|agent|writer|arbiter|manager|orchestrator|mapper|runner)\b/g;
    for (const match of combinedRouting.matchAll(agentNameRe)) {
      reachable.add(match[0]);
    }

    // Exemptions: agents with `dispatch: cross-cutting` / `ad-hoc` /
    // `maintenance` frontmatter are explicitly non-glob and exempt.
    const exempt = new Set<string>();
    const collectExempt = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          collectExempt(full);
          continue;
        }
        if (!f.endsWith('.md')) continue;
        const fileContent = fs.readFileSync(full, 'utf8');
        const nameMatch = fileContent.match(/^name:\s*([a-z][a-z-]+)/m);
        const dispatchMatch = fileContent.match(/^dispatch:\s*(cross-cutting|ad-hoc|maintenance)/m);
        if (nameMatch && nameMatch[1] && dispatchMatch) {
          exempt.add(nameMatch[1]);
        }
      }
    };
    collectExempt(path.join(REPO_ROOT, '.claude', 'agents'));

    const combinedRoster = new Set<string>([...laneARoster, ...laneBRoster]);
    const unreachable = [...combinedRoster].filter(
      (agent) => !reachable.has(agent) && !exempt.has(agent),
    );

    if (unreachable.length > 0) {
      const hint =
        'Every roster agent must appear in at least one glob cell (primary OR also-notify) ' +
        'across .claude/shared/orchestrator-routing-table.md and ' +
        '.claude/agents/product-audit/orchestrator.md Phase 1 table. Agents that are ' +
        'intentionally cross-cutting or ad-hoc must carry `dispatch: cross-cutting` or ' +
        '`dispatch: ad-hoc` in their frontmatter.';
      throw new Error(
        `Orphan agents (in roster, no dispatch glob):\n  - ${unreachable.join('\n  - ')}\n\n${hint}`,
      );
    }
    expect(unreachable).toEqual([]);
  });
});
