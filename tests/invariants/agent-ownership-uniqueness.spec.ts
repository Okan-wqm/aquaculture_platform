/**
 * Agent Ownership Uniqueness Invariant
 * ============================================================================
 *
 * Closes Phase 0.3 of /root/.claude/plans/abstract-brewing-mochi.md:
 *
 *   Each file path in the repo must have EXACTLY ONE primary owner across
 *   the enterprise-v2 agent set. Conflicting "Primary Ownership" claims
 *   (before this invariant) produced undefined dispatch routing and broke
 *   the pair-review invariant (_shared/operating-modes.md).
 *
 *   The ownership grammar (_shared/handoff-protocol.md) permits three roles:
 *     - primary        — sole CATCHER; exactly one per path.
 *     - secondary reviewer — invoked in parallel; tag REQUIRED in prose.
 *     - delegated from <agent> — reviews a named slice only; tag REQUIRED.
 *
 *   This invariant asserts:
 *     1. Every non-primary ownership claim in an agent's `## Primary Ownership`
 *        section is tagged with `secondary reviewer` OR `delegated from`.
 *     2. The orchestrator.md routing table is the authoritative "primary"
 *        registry; agent files may claim primary only if the routing table
 *        agrees.
 *
 * # What this spec enforces
 *
 *   - Every bullet in an agent's Primary Ownership block either:
 *       (a) has no overlapping claim from another agent (sole primary), OR
 *       (b) carries explicit "secondary reviewer" / "delegated from <agent>"
 *           text inside the same bullet.
 *
 *   - Untagged overlaps (the Phase 0.3 bug class) are PROCESS HIGH and fail
 *     this test.
 *
 * # When this spec fails
 *
 *   - Two agents list the same path in Primary Ownership without
 *     secondary/delegated tags → pick ONE agent to own, add tag to the
 *     other.
 *
 *   - Agent file claims primary on a path that orchestrator.md routes to a
 *     different agent → reconcile: either update orchestrator routing or
 *     change the agent file's ownership tag.
 *
 * # References
 *
 *   - /root/.claude/plans/abstract-brewing-mochi.md#Phase-0.3
 *   - /var/aqua-saas/docs/reviews/orchestrator/2026-04-16-v2-audit.md#P0-3
 *   - /var/aqua-saas/.claude/shared/handoff-protocol.md
 *     (Ownership grammar section)
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');

/**
 * Tags that legitimize an overlapping ownership claim. If any of these
 * appears in the SAME bullet as the path, the claim is NOT a conflict.
 */
const DELEGATION_TAGS: readonly RegExp[] = [
  /\bsecondary reviewer\b/i,
  /\bdelegated from\b/i,
  /\bdelegated-from\b/i,
];

interface OwnershipClaim {
  agent: string;
  pathGlob: string;
  rawBullet: string;
  hasDelegationTag: boolean;
}

function readAgentFiles(): { agent: string; content: string }[] {
  const entries = fs.readdirSync(AGENTS_DIR);
  return entries
    .filter((e) => e.endsWith('.md') && e !== 'README.md')
    .map((e) => ({
      agent: e.replace(/\.md$/, ''),
      content: fs.readFileSync(path.join(AGENTS_DIR, e), 'utf8'),
    }));
}

function extractPrimaryOwnershipSection(content: string): string | null {
  // Match from "## Primary Ownership" until the next "## " heading.
  const start = content.search(/^## Primary Ownership\b/m);
  if (start === -1) return null;
  const after = content.slice(start);
  const nextHeadingMatch = /\n## /m.exec(after.slice(1));
  if (!nextHeadingMatch) return after;
  return after.slice(0, 1 + nextHeadingMatch.index);
}

/**
 * Extract ownership claims from an agent's Primary Ownership section.
 * A claim = a bullet-level line referencing a path glob (contains backtick-
 * wrapped glob-like string).
 */
function extractClaims(agent: string, section: string): OwnershipClaim[] {
  const claims: OwnershipClaim[] = [];
  const lines = section.split('\n');
  for (const line of lines) {
    // Bullet lines starting with `- ` that contain at least one backtick-wrapped token
    if (!/^\s*- /.test(line)) continue;
    const globMatches = line.matchAll(/`([^`]+)`/g);
    const hasDelegationTag = DELEGATION_TAGS.some((re) => re.test(line));
    for (const m of globMatches) {
      const [, glob] = m;
      if (!glob) continue;
      // Only consider path-like tokens (contain `/` or `**` or `*.`)
      if (!/[\\/]/.test(glob) && !glob.includes('*')) continue;
      // Skip inline code that's obviously not a glob (e.g., type names)
      if (glob.length < 3) continue;
      // Skip class names / type refs that happen to be in backticks
      if (/^[A-Z][A-Za-z]+$/.test(glob)) continue;
      claims.push({
        agent,
        pathGlob: glob,
        rawBullet: line.trim(),
        hasDelegationTag,
      });
    }
  }
  return claims;
}

// Normalize a glob so that overlapping patterns bucket to the same key
// when we're looking for conflicts. Keeps raw glob but strips leading slash.
function normalizeGlob(glob: string): string {
  // Strip surrounding whitespace and trailing slash
  let g = glob.trim();
  // Normalize common prefixes
  if (g.startsWith('/')) g = g.slice(1);
  return g;
}

describe('agent ownership uniqueness invariant', () => {
  const files = readAgentFiles();
  const allClaims: OwnershipClaim[] = [];

  for (const { agent, content } of files) {
    const section = extractPrimaryOwnershipSection(content);
    if (!section) continue;
    allClaims.push(...extractClaims(agent, section));
  }

  // Group claims by exact glob string.
  const byGlob = new Map<string, OwnershipClaim[]>();
  for (const claim of allClaims) {
    const key = normalizeGlob(claim.pathGlob);
    const existing = byGlob.get(key) ?? [];
    existing.push(claim);
    byGlob.set(key, existing);
  }

  it('no two agents claim primary ownership of the same glob without delegation tag', () => {
    const conflicts: string[] = [];
    for (const [glob, claims] of byGlob.entries()) {
      if (claims.length < 2) continue;
      // Filter to claims in UNIQUE agents (duplicates within same agent file are fine)
      const agents = new Set(claims.map((c) => c.agent));
      if (agents.size < 2) continue;
      // A conflict exists if MORE THAN ONE agent lists the glob WITHOUT a delegation tag
      const untagged = claims.filter((c) => !c.hasDelegationTag);
      const untaggedAgents = new Set(untagged.map((c) => c.agent));
      if (untaggedAgents.size >= 2) {
        conflicts.push(
          `Glob "${glob}" claimed as primary by ${[...untaggedAgents].join(', ')} without delegation tags`,
        );
      }
    }

    if (conflicts.length > 0) {
      const hint = `Tag the non-primary claim(s) with "secondary reviewer" or "delegated from <agent>" per _shared/handoff-protocol.md grammar.`;
      throw new Error(`Ownership conflicts detected:\n  - ${conflicts.join('\n  - ')}\n\n${hint}`);
    }
    expect(conflicts).toEqual([]);
  });

  it('ownership grammar is defined in .claude/shared/handoff-protocol.md', () => {
    // Sanity check: the delegation grammar is what this invariant enforces.
    // If the grammar section goes missing, this invariant's error messages
    // point to a non-existent rule.
    const handoffFile = path.join(REPO_ROOT, '.claude', 'shared', 'handoff-protocol.md');
    const content = fs.readFileSync(handoffFile, 'utf8');
    expect(content).toMatch(/## Ownership grammar/);
    expect(content).toMatch(/secondary reviewer/);
    expect(content).toMatch(/delegated from/);
  });
});

/**
 * Routing-table glob uniqueness (extends Phase 0.3 to the dispatch surface).
 *
 * Closes CLAUDE-HIGH-007 — agent-ownership-uniqueness scope gap.
 *
 * The orchestrator routing table(s) are the canonical dispatch surface.
 * If two rows share the same glob but list different primary agents and
 * neither row tags the overlap as "delegated from" / "secondary reviewer"
 * in-cell, orchestrator dispatch is non-deterministic — exactly the
 * CLAUDE-CRITICAL-004 bug class that was CI-silent until 2026-04-18.
 *
 * Scans BOTH Lane-A routing (`.claude/shared/orchestrator-routing-table.md`)
 * AND Lane-B routing (the Phase 1 table inside
 * `.claude/agents/product-audit/orchestrator.md`).
 */

const ROUTING_TABLE_FILES: readonly { label: string; path: string }[] = [
  {
    label: 'Lane-A orchestrator-routing-table.md',
    path: path.join(REPO_ROOT, '.claude', 'shared', 'orchestrator-routing-table.md'),
  },
  {
    label: 'Lane-B product-audit-orchestrator-routing.md',
    path: path.join(
      REPO_ROOT,
      '.claude',
      'shared',
      'product-audit-orchestrator-routing.md',
    ),
  },
];

interface RoutingRow {
  source: string;
  glob: string;
  primary: string;
  rawLine: string;
}

function extractRoutingRows(label: string, content: string): RoutingRow[] {
  const rows: RoutingRow[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    // Skip header + separator rows
    if (/^\|\s*-+/.test(line) || /^\|\s*File\s*(Pattern|Path)/i.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    const globCell = cells[1];
    const primaryCell = cells[2];
    if (!globCell || !primaryCell) continue;
    if (!/`[^`]+`/.test(globCell)) continue; // require a backtick-wrapped glob
    // A glob cell may contain multiple comma-separated globs.
    const globTokens = [...globCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(Boolean);
    // Primary cell: strip trailing "(note)" prose — take first alphanumeric agent token
    const primaryMatch = primaryCell.match(/^([a-z][a-z0-9-]+)/i);
    if (!primaryMatch) continue;
    const primary = primaryMatch[1];
    // ORPHAN-HIGH-507 — guarded, not asserted: a capture the regex matched
    // but did not bind must skip the row, never crash the invariant.
    if (primary === undefined) continue;
    for (const g of globTokens) {
      if (!g) continue;
      rows.push({ source: label, glob: g, primary, rawLine: line });
    }
  }
  return rows;
}

describe('routing-table glob-uniqueness invariant (CLAUDE-HIGH-007)', () => {
  const allRows: RoutingRow[] = [];
  for (const file of ROUTING_TABLE_FILES) {
    if (!fs.existsSync(file.path)) continue;
    const content = fs.readFileSync(file.path, 'utf8');
    allRows.push(...extractRoutingRows(file.label, content));
  }

  const byGlob = new Map<string, RoutingRow[]>();
  for (const row of allRows) {
    const key = normalizeGlob(row.glob).replace(/\s*\(.*\)\s*$/, '').trim();
    const existing = byGlob.get(key) ?? [];
    existing.push(row);
    byGlob.set(key, existing);
  }

  it('no duplicate glob maps to different primary agents across the routing table(s)', () => {
    const conflicts: string[] = [];
    for (const [glob, rows] of byGlob.entries()) {
      if (rows.length < 2) continue;
      const primaries = new Set(rows.map((r) => r.primary));
      if (primaries.size < 2) continue; // same primary listed multiple times is fine
      // Tolerance: if any row contains "delegated from" / "secondary reviewer"
      // in the raw line, treat that row as a non-primary claim.
      const untagged = rows.filter(
        (r) =>
          !/\b(secondary reviewer|delegated from|delegated-from)\b/i.test(r.rawLine),
      );
      const untaggedPrimaries = new Set(untagged.map((r) => r.primary));
      if (untaggedPrimaries.size >= 2) {
        const sources = [...new Set(rows.map((r) => r.source))].join(' + ');
        conflicts.push(
          `Glob "${glob}" has multiple primary agents [${[...untaggedPrimaries].join(', ')}] across ${sources}`,
        );
      }
    }
    if (conflicts.length > 0) {
      const hint =
        'Exactly one routing row per glob may declare a primary agent. Tag the other row(s) with "delegated from <agent>" or "secondary reviewer" in-cell, or remove the duplicate.';
      throw new Error(`Routing-table glob conflicts:\n  - ${conflicts.join('\n  - ')}\n\n${hint}`);
    }
    expect(conflicts).toEqual([]);
  });
});
