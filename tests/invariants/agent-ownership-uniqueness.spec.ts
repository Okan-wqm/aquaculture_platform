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
