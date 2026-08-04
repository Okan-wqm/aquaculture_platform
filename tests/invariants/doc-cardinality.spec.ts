/**
 * Documentation Cardinality Invariant
 * ============================================================================
 *
 * Faz 5 of /root/.claude/plans/parallel-jumping-ladybug.md.
 *
 * Agent-system docs historically drifted on cardinality claims:
 *   .claude/README.md  — "34 domain + cross-cutting" when real was 36
 *   .claude/README.md  — "24 active … + 4 DEPRECATED" when real was 22+4 legacy
 *   knowledge/README   — "22 agents" when real was 58 (36 Lane-A + 22 Lane-B)
 *   prompt-writer.md   — "~30 agents" when real was 36 Lane-A
 *
 * Plan-agent recommendation (over regex extraction): use explicit
 * HTML-comment markers inside prose so docs can be proof-checked:
 *
 *   <!-- cardinality:lane-a-agents -->36<!-- /cardinality -->
 *
 * Each marker names a canonical count key; the spec computes the
 * corresponding fs-count and asserts equality.
 *
 * # Canonical keys
 *
 *   lane-a-agents        — .claude/agents/*.md minus NON_AGENT_FILES
 *   lane-b-active-agents — .claude/agents/product-audit/*.md minus NON_AGENT_FILES
 *   total-active         — lane-a-agents + lane-b-active-agents
 *
 * # When this spec fails
 *
 *   - A doc's marker disagrees with fs reality → update the marker
 *     value OR add/remove an agent file to match intent.
 *   - No marker found for a known count key → wrap the claim in a
 *     marker so this spec covers it (prevents future drift).
 *
 * # References
 *
 *   - /root/.claude/plans/parallel-jumping-ladybug.md#Faz-5
 *   - tests/invariants/_constants.ts § NON_AGENT_FILES
 */

import * as fs from 'fs';
import * as path from 'path';

import { NON_AGENT_FILES } from './_constants';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MARKER_RE = /<!--\s*cardinality:([a-z][a-z0-9-]*)\s*-->(\d+)<!--\s*\/cardinality\s*-->/g;

function countMdFiles(relDir: string): number {
  const abs = path.join(REPO_ROOT, relDir);
  if (!fs.existsSync(abs)) return 0;
  if (!fs.statSync(abs).isDirectory()) return 0;
  return fs
    .readdirSync(abs)
    .filter(
      (f) =>
        f.endsWith('.md') &&
        !(NON_AGENT_FILES as readonly string[]).includes(f),
    ).length;
}

function countDirs(relDir: string): number {
  const abs = path.join(REPO_ROOT, relDir);
  if (!fs.existsSync(abs)) return 0;
  if (!fs.statSync(abs).isDirectory()) return 0;
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory()).length;
}

interface MarkerHit {
  readonly file: string;
  readonly line: number;
  readonly key: string;
  readonly claimed: number;
}

function scanMarkers(relFile: string): MarkerHit[] {
  const abs = path.join(REPO_ROOT, relFile);
  if (!fs.existsSync(abs)) return [];
  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split('\n');
  const hits: MarkerHit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const re = new RegExp(MARKER_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const [, key, countStr] = m;
      if (!key || !countStr) continue;
      hits.push({
        file: relFile,
        line: i + 1,
        key,
        claimed: parseInt(countStr, 10),
      });
    }
  }
  return hits;
}

const COUNT_SOURCES: Record<string, () => number> = {
  // `lane-a-agents` counts agents in the runtime dispatch surface. Post-
  // Phase-4 of plan mutable-frolicking-yao.md, maintenance agents live
  // under .claude/agents/_maintenance/ and are intentionally non-runtime;
  // they are counted separately via `lane-a-maintenance` so the runtime
  // roster cardinality reflects dispatch reality.
  'lane-a-agents': () => countMdFiles('.claude/agents'),
  'lane-a-maintenance': () => countMdFiles('.claude/agents/_maintenance'),
  'lane-b-active-agents': () => countMdFiles('.claude/agents/product-audit'),
  // 3 Lane-B meta agents (product-audit-orchestrator, -context-manager,
  // -arbiter) carry the product-audit-* name prefix and live alongside
  // specialists. lane-b-specialists counts the dispatchable UI auditors
  // only, for prose that distinguishes meta vs specialist.
  'lane-b-specialists': () =>
    countMdFiles('.claude/agents/product-audit') - 3,
  'total-active': () =>
    countMdFiles('.claude/agents') + countMdFiles('.claude/agents/product-audit'),
  // Module Federation remotes under web/modules/. This count drifted twice
  // unguarded: messaging-module landed in #904 (2026-07-06) and both the root
  // CLAUDE.md and web/CLAUDE.md kept claiming 7 for a month. Directory count
  // is the SSoT — web/shell/vite.config.ts registers one remote per directory.
  'federated-remotes': () => countDirs('web/modules'),
};

const DOC_FILES: readonly string[] = [
  '.claude/README.md',
  '.claude/knowledge/README.md',
  '.claude/agents/_maintenance/prompt-writer.md',
  '.claude/shared/orchestrator-phases.md',
  '.claude/agents/product-audit/README.md',
  'CLAUDE.md',
  'web/CLAUDE.md',
];

describe('doc-cardinality invariant', () => {
  const allHits: MarkerHit[] = [];
  for (const doc of DOC_FILES) {
    allHits.push(...scanMarkers(doc));
  }

  it('at least one cardinality marker exists (regression guard)', () => {
    expect(allHits.length).toBeGreaterThan(0);
  });

  it('every marker key maps to a known count source', () => {
    const unknown = allHits.filter((h) => !(h.key in COUNT_SOURCES));
    if (unknown.length > 0) {
      const listing = unknown
        .map((h) => `  ${h.file}:${h.line} — unknown key "${h.key}"`)
        .join('\n');
      throw new Error(
        `Unknown cardinality keys:\n${listing}\n\nAdd the key to COUNT_SOURCES in doc-cardinality.spec.ts or fix the typo.`,
      );
    }
    expect(unknown).toEqual([]);
  });

  describe('claim matches fs reality', () => {
    if (allHits.length === 0) {
      it.todo('no markers to validate — seed cardinality markers');
      return;
    }
    it.each(allHits)(
      '$file:$line "$key" = $claimed',
      ({ file, line, key, claimed }) => {
        const counter = COUNT_SOURCES[key];
        if (!counter) {
          throw new Error(
            `Unknown key "${key}" — should have been caught by previous test`,
          );
        }
        const actual = counter();
        if (actual !== claimed) {
          throw new Error(
            `${file}:${line} marker "${key}" claims ${claimed} but fs count is ${actual}.\n` +
              `Either update the claim or add/remove an agent file.`,
          );
        }
        expect(actual).toBe(claimed);
      },
    );
  });
});
