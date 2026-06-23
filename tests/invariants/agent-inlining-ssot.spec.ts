/**
 * Anti-Inlining SSoT Invariant (WS3 — make detectable / Tier-3)
 * ============================================================================
 *
 * Implements the rule that knowledge-ssot.spec.ts deferred (see its lines
 * 12-17): the knowledge layer (`.claude/knowledge/layer-*.md`) and the shared
 * review contract (`.claude/shared/*.md`) are the SINGLE SOURCE OF TRUTH for
 * tech versions, contract shapes, phase definitions, and architectural claims.
 * Agent files (`.claude/agents/**`) reference them via `@-include` bookmarks;
 * they MUST NOT inline-duplicate a chunk of SSoT content, because a buried copy
 * silently diverges the moment the SSoT is updated and the agent steers reviews
 * with a stale claim.
 *
 * This is the repo's own Tier-3 principle ("make the wrong behaviour detectable
 * at build/test time") applied to its own agent-steering layer. It is the
 * hash/shingle-based duplication test that knowledge-ssot.spec.ts named as
 * future work.
 *
 * # Detection algorithm
 *
 * SSoT files = `.claude/knowledge/layer-*.md` + `.claude/shared/*.md`, EXCEPT
 * `_conversion-template.md` (that file is a *template* whose section skeleton is
 * MEANT to be reproduced into every agent — treating it as SSoT would flag
 * every correctly-converted agent for the very structure the conversion
 * mandates).
 *
 * Candidates = `listActiveAgentFiles()` (frontmatter-bearing agent prompts).
 *
 * Step 0 — normalize. Lowercase, drop frontmatter, EXCLUDE fenced code blocks
 *   from the prose stream (they are compared as exact strings is out of scope
 *   here; the prose copy-paste signature is what we hunt), strip markdown
 *   decoration (`#`, `*`, `_`, `>`, backticks, table pipes, `--` rules), and
 *   collapse whitespace.
 *
 * Step 1 — SSoT heading registry (exact heading + body token overlap). Collect
 *   every `##`/`###` heading owned by an SSoT file (minus the GENERIC_HEADINGS
 *   set — universal document scaffolding like `References` / `Scope` / `Verdict`
 *   / severity buckets that every doc legitimately carries and that share only
 *   citation tokens, not copied content). Flag an agent that reproduces an
 *   SSoT-owned content heading AND whose section body shares >= K normalized
 *   tokens with the SSoT section. K = 8.
 *
 * Step 2 — longest contiguous shingle run (the copy-paste signature). Compute
 *   w-token shingles (w = 8) over normalized prose; flag when the LONGEST
 *   CONTIGUOUS run between an agent and an SSoT file is >= R shingles. R = 12.
 *   We use the longest-contiguous-run, NOT aggregate Jaccard: a long verbatim
 *   run is the copy-paste signature; scattered shared domain vocabulary is
 *   legitimate elaboration and must not trip the gate.
 *
 * Step 3 — allowlist gate. `ANTI_INLINING_ALLOWLIST` maps an agent relPath to a
 *   justified, contract-owned inline. A flag for a NON-allowlisted agent fails
 *   the spec with the agent path, the SSoT path, the verbatim run, and a fix
 *   hint. A flag whose (agent, ssot) is allowlisted passes.
 *
 * # Lane-divergence guard
 *
 * The Lane-A orchestrator-phases / routing files and the Lane-B
 * product-audit-orchestrator-phases / routing files are DELIBERATELY divergent
 * (two lanes, two phase models). This guard asserts they keep LOW contiguous
 * cross-file overlap, so a future accidental copy-paste between lanes (which
 * would re-couple the two pipelines) trips the test. The justified divergence
 * is recorded in `JUSTIFIED_DIVERGENCE`.
 *
 * # When this spec fails
 *
 *   - A new agent inlines an SSoT section / contract chunk → replace the inline
 *     with an `@.claude/...` bookmark + a one-line pointer, OR (if the inline is
 *     a deliberate, separately-enforced contract) add an ANTI_INLINING_ALLOWLIST
 *     entry citing the enforcing contract owner.
 *   - Two lane orchestrator files drift toward each other (copy-paste) → either
 *     the duplication is real debt (extract to a shared SSoT) or it is a true
 *     convergence (update JUSTIFIED_DIVERGENCE with the rationale).
 *
 * # References
 *
 *   - tests/invariants/knowledge-ssot.spec.ts (the deferred test, now here)
 *   - .claude/knowledge/layer-*.md + .claude/shared/*.md (the SSoT corpus)
 *   - CLAUDE.md "Knowledge SSoT" / "Agent system invocation" sections
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { listActiveAgentFiles, REPO_ROOT } from './lib/agent-files';

// ----------------------------------------------------------------------------
// Calibrated thresholds (tuned against the live corpus; see header rationale).
// ----------------------------------------------------------------------------
const K = 8; // Step-1 heading-section body token-overlap floor.
const W = 8; // shingle window width (tokens per shingle).
const R = 12; // Step-2 longest-contiguous-run floor (in shingles).
const LANE_DIVERGENCE_MAX_RUN = 6; // lane pairs must stay below this.

// ----------------------------------------------------------------------------
// SSoT corpus selection.
// ----------------------------------------------------------------------------
// `_conversion-template.md` matches the `.claude/shared/*.md` glob but is a
// TEMPLATE whose section skeleton is intentionally reproduced into agents — it
// is not SSoT prose. Excluding it is load-bearing: the WS3 STEP-5 fix adds the
// templated `## Canonical References` section to two agents, and every already-
// converted agent carries that same templated structure.
const SSOT_EXCLUDE = new Set<string>(['.claude/shared/_conversion-template.md']);

function listSsotFiles(): string[] {
  // git is the SSoT for which files are tracked; mirror agent-files.ts style by
  // reading the working tree at known paths. The knowledge/shared dirs are
  // small and fully enumerated by their globs.
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const out = execFileSync('git', ['ls-files', '.claude/knowledge', '.claude/shared'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  return out
    .filter(
      (rel) =>
        /^\.claude\/knowledge\/layer-.*\.md$/.test(rel) ||
        /^\.claude\/shared\/.*\.md$/.test(rel),
    )
    .filter((rel) => !SSOT_EXCLUDE.has(rel))
    .sort();
}

// ----------------------------------------------------------------------------
// Generic structural headings — universal document scaffolding. These appear in
// nearly every SSoT file AND every agent; their "shared tokens" are canonical
// path / ADR citations both legitimately reference, never copied content. A
// heading-exact-match on one of these is not an inline signal.
// ----------------------------------------------------------------------------
const GENERIC_HEADINGS = new Set<string>([
  'references',
  'scope',
  'verdict',
  'summary',
  'overview',
  'notes',
  'gotchas',
  'examples',
  'example',
  'critical',
  'high',
  'medium',
  'low',
  'finding id format',
  'finding id prefix',
  'operating modes',
  'operating mode',
  'domain rules',
  'review checklist',
  'prior work check',
  'cross-domain dependencies',
]);

// ----------------------------------------------------------------------------
// Allowlist (Step 3). Each entry documents a DELIBERATE, separately-enforced
// inline. `contractOwner` names the executable contract that keeps the inline
// honest, so a reviewer can verify the duplication is not free-floating drift.
// ----------------------------------------------------------------------------
interface AllowlistEntry {
  readonly ssot: string;
  readonly reason: string;
  readonly contractOwner: string;
}

const ANTI_INLINING_ALLOWLIST: Record<string, AllowlistEntry> = {
  // The ARIA convergent-gate envelope agents inline the envelope / risk field
  // NAMES that also appear in layer-2-aria-canonical-envelope.md. This is a
  // DELIBERATE belt-and-suspenders restatement: the kernel rejects any envelope
  // that drifts from the field set, so the agent prompt must carry the exact
  // field names to steer a conformant response. The kernel-side contract test
  // (created by the sibling envelope-contract workstream) is the enforcing
  // owner that keeps the inline byte-aligned with the SSoT table.
  '.claude/agents/aria-cross-reviewer.md': {
    ssot: '.claude/knowledge/layer-2-aria-canonical-envelope.md',
    reason:
      'Deliberate ARIA envelope inline — kernel-enforced cross_review risk[] + ' +
      'satisfaction_matrix field names; the envelope SSoT + kernel validators are ' +
      'the contract, the prompt restatement steers a conformant response.',
    contractOwner:
      'aria-kernel/tests/invariants/v11/test_envelope_contract_ssot.py',
  },
  '.claude/agents/aria-primary-planner.md': {
    ssot: '.claude/knowledge/layer-2-aria-canonical-envelope.md',
    reason:
      'Deliberate ARIA envelope inline — kernel-enforced plan_content seven-field ' +
      'set; restated in-prompt so the planner emits a CONVERGED-eligible envelope.',
    contractOwner:
      'aria-kernel/tests/invariants/v11/test_envelope_contract_ssot.py',
  },
  '.claude/agents/aria-challenger-planner.md': {
    ssot: '.claude/knowledge/layer-2-aria-canonical-envelope.md',
    reason:
      'Deliberate ARIA envelope inline — kernel-enforced plan_content / ' +
      'details.cross_review field sets restated so the challenger emits a ' +
      'conformant envelope in both run modes.',
    contractOwner:
      'aria-kernel/tests/invariants/v11/test_envelope_contract_ssot.py',
  },
  // Deliberate, mirror-enforced inline (resolved like the ARIA-envelope case).
  // root-cause-auditor is dispatched with only its own prompt as context and
  // must emit AUDIT-* sub-kind tags (OVER_CLAIMED, RULING_PARTIAL_APPLICATION,
  // RULING_MISSED_DEADLINE, OVERRIDE_UNSUPPORTED, BOUNDARY_EXPIRED,
  // BANNED_PHRASE_IN_CLAIM), so it restates the output-format.md SSoT list at
  // its reading surface (show > tell). output-format.md remains the SSoT; the
  // "AUDIT-* sub-kind mirror" describe-block below asserts the agent's inline
  // list stays byte-equal to the SSoT list, so the deliberate duplication
  // cannot drift. Same regime as the ARIA-envelope inlines above.
  '.claude/agents/root-cause-auditor.md': {
    ssot: '.claude/shared/output-format.md',
    reason:
      'Deliberate inline — root-cause-auditor emits AUDIT-* sub-kind tags and ' +
      'restates the output-format.md SSoT vocabulary at its prompt surface; the ' +
      'AUDIT-* sub-kind mirror invariant keeps the two lists byte-equal.',
    contractOwner:
      'tests/invariants/agent-inlining-ssot.spec.ts (AUDIT-* sub-kind mirror)',
  },
};

// ----------------------------------------------------------------------------
// Lane-divergence justification (the two-lane phase/routing split is correct).
// ----------------------------------------------------------------------------
interface DivergencePair {
  readonly laneA: string;
  readonly laneB: string;
  readonly reason: string;
}

const JUSTIFIED_DIVERGENCE: readonly DivergencePair[] = [
  {
    laneA: '.claude/shared/orchestrator-phases.md',
    laneB: '.claude/shared/product-audit-orchestrator-phases.md',
    reason:
      'Lane-A (code-quality) and Lane-B (product-quality) run distinct phase ' +
      'models; their phase docs must stay independent — a verbatim cross-lane ' +
      'run would re-couple the two pipelines.',
  },
  {
    laneA: '.claude/shared/orchestrator-routing-table.md',
    laneB: '.claude/shared/product-audit-orchestrator-routing.md',
    reason:
      'Lane-A and Lane-B route to disjoint agent rosters; their routing tables ' +
      'must stay independent.',
  },
];

// ----------------------------------------------------------------------------
// Normalization + shingle helpers.
// ----------------------------------------------------------------------------
function stripFrontmatter(body: string): string {
  if (!body.startsWith('---\n')) return body;
  const end = body.indexOf('\n---\n', 4);
  return end === -1 ? body : body.slice(end + 5);
}

/** Split into prose (fences removed) — fences are governed separately. */
function proseWithoutFences(body: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/`+/g, ' ')
    .replace(/[*_#>|]/g, ' ')
    .replace(/-{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(norm: string): string[] {
  return norm.split(' ').filter(Boolean);
}

function shingles(tokens: readonly string[], w: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + w <= tokens.length; i++) {
    out.push(tokens.slice(i, i + w).join(' '));
  }
  return out;
}

function buildShingleIndex(arr: readonly string[]): Map<string, number[]> {
  const idx = new Map<string, number[]>();
  arr.forEach((s, i) => {
    const at = idx.get(s);
    if (at) at.push(i);
    else idx.set(s, [i]);
  });
  return idx;
}

/**
 * Longest CONTIGUOUS run of matching shingles between `aShingles` and the
 * shingle index of B. Contiguous in shingle space (consecutive overlapping
 * windows) == a verbatim token run. Returns the run length (in shingles) and
 * the start index in A so the verbatim text can be reconstructed.
 */
function longestContiguousRun(
  aShingles: readonly string[],
  bIndex: Map<string, number[]>,
): { run: number; startA: number } {
  let best = 0;
  let bestStartA = -1;
  for (let i = 0; i < aShingles.length; i++) {
    const positions = bIndex.get(aShingles[i] as string);
    if (!positions) continue;
    for (const startB of positions) {
      let run = 1;
      let ia = i + 1;
      let ib = startB + 1;
      for (;;) {
        if (ia >= aShingles.length) break;
        const next = bIndex.get(aShingles[ia] as string);
        if (next && next.includes(ib)) {
          run++;
          ia++;
          ib++;
        } else break;
      }
      if (run > best) {
        best = run;
        bestStartA = i;
      }
    }
  }
  return { run: best, startA: bestStartA };
}

function verbatimRunText(tokens: readonly string[], startA: number, run: number): string {
  if (startA < 0 || run <= 0) return '';
  return tokens.slice(startA, startA + run + W - 1).join(' ');
}

// ----------------------------------------------------------------------------
// Heading extraction + per-section token sets.
// ----------------------------------------------------------------------------
function headings(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m && m[2]) out.push(normalize(m[2]));
  }
  return out;
}

function sectionTokens(body: string, headingNorm: string): Set<string> {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m && m[2] && normalize(m[2]) === headingNorm) {
      const sec: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{2,3}\s+/.test(lines[j] as string)) break;
        sec.push(lines[j] as string);
      }
      return new Set(tokenize(normalize(proseWithoutFences(sec.join('\n')))));
    }
  }
  return new Set();
}

// ----------------------------------------------------------------------------
// Pre-compute SSoT data once.
// ----------------------------------------------------------------------------
interface SsotDoc {
  readonly rel: string;
  readonly body: string;
  readonly tokens: string[];
  readonly shingleIndex: Map<string, number[]>;
  readonly headingSet: Set<string>;
}

const ssotDocs: SsotDoc[] = listSsotFiles().map((rel) => {
  const body = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const tokens = tokenize(normalize(proseWithoutFences(body)));
  return {
    rel,
    body,
    tokens,
    shingleIndex: buildShingleIndex(shingles(tokens, W)),
    headingSet: new Set(headings(body)),
  };
});

// SSoT-owned content-heading registry: heading -> owning SSoT rels.
const ssotHeadingOwners = new Map<string, string[]>();
for (const doc of ssotDocs) {
  for (const h of doc.headingSet) {
    if (GENERIC_HEADINGS.has(h)) continue;
    const at = ssotHeadingOwners.get(h);
    if (at) at.push(doc.rel);
    else ssotHeadingOwners.set(h, [doc.rel]);
  }
}

interface Flag {
  readonly agent: string;
  readonly ssot: string;
  readonly kind: 'heading-section' | 'contiguous-run';
  readonly detail: string;
  readonly verbatim: string;
}

function detectFlags(agentRel: string, agentBody: string): Flag[] {
  const flags: Flag[] = [];
  const prose = stripFrontmatter(agentBody);
  const tokens = tokenize(normalize(proseWithoutFences(prose)));
  const aShingles = shingles(tokens, W);

  // Step 1 — SSoT content heading + section body token overlap.
  for (const h of headings(prose)) {
    const owners = ssotHeadingOwners.get(h);
    if (!owners) continue;
    const agentSection = sectionTokens(prose, h);
    for (const owner of owners) {
      const ownerDoc = ssotDocs.find((d) => d.rel === owner);
      if (!ownerDoc) continue;
      const ssotSection = sectionTokens(ownerDoc.body, h);
      let shared = 0;
      for (const t of agentSection) if (ssotSection.has(t)) shared++;
      if (shared >= K) {
        flags.push({
          agent: agentRel,
          ssot: owner,
          kind: 'heading-section',
          detail: `heading "${h}" section shares ${shared} >= K(${K}) tokens with the SSoT section`,
          verbatim: `## ${h}`,
        });
      }
    }
  }

  // Step 2 — longest contiguous prose shingle run.
  for (const doc of ssotDocs) {
    const { run, startA } = longestContiguousRun(aShingles, doc.shingleIndex);
    if (run >= R) {
      flags.push({
        agent: agentRel,
        ssot: doc.rel,
        kind: 'contiguous-run',
        detail: `longest contiguous run ${run} >= R(${R}) shingles (w=${W})`,
        verbatim: verbatimRunText(tokens, startA, run),
      });
    }
  }

  return flags;
}

// ----------------------------------------------------------------------------
// Specs.
// ----------------------------------------------------------------------------
describe('agent anti-inlining SSoT invariant (WS3 Tier-3)', () => {
  const agents = listActiveAgentFiles();

  it('discovers the SSoT corpus and the agent corpus', () => {
    // SSoT corpus: knowledge layer-* shards + shared contract files, minus the
    // conversion template. Floor guards against a broken glob.
    expect(ssotDocs.length).toBeGreaterThan(10);
    expect(ssotDocs.map((d) => d.rel)).toContain('.claude/knowledge/layer-2-patterns.md');
    expect(ssotDocs.map((d) => d.rel)).not.toContain(
      '.claude/shared/_conversion-template.md',
    );
    // Agent corpus floor — dozens of agents across Lane-A/Lane-B/ARIA.
    expect(agents.length).toBeGreaterThan(40);
  });

  it('every allowlist entry targets a real agent file and a real SSoT file', () => {
    const agentSet = new Set(agents.map((a) => a.relPath));
    const ssotSet = new Set(ssotDocs.map((d) => d.rel));
    for (const [agentRel, entry] of Object.entries(ANTI_INLINING_ALLOWLIST)) {
      expect({ agentRel, present: agentSet.has(agentRel) }).toEqual({
        agentRel,
        present: true,
      });
      expect({ ssot: entry.ssot, present: ssotSet.has(entry.ssot) }).toEqual({
        ssot: entry.ssot,
        present: true,
      });
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.contractOwner.length).toBeGreaterThan(0);
    }
  });

  describe('no agent inlines SSoT content (heading-section overlap + contiguous run)', () => {
    for (const agent of agents) {
      it(`${agent.relPath}: no non-allowlisted SSoT inline`, () => {
        const flags = detectFlags(agent.relPath, agent.content);
        const allowed = ANTI_INLINING_ALLOWLIST[agent.relPath];
        const violations = flags.filter(
          (f) => !(allowed && allowed.ssot === f.ssot),
        );
        if (violations.length > 0) {
          const lines = violations
            .map(
              (v) =>
                `  [${v.kind}] ${v.agent}\n` +
                `    duplicates SSoT: ${v.ssot}\n` +
                `    signal: ${v.detail}\n` +
                `    verbatim run: "${v.verbatim.slice(0, 240)}"`,
            )
            .join('\n\n');
          throw new Error(
            `Agent inlines SSoT content instead of @-referencing it:\n\n${lines}\n\n` +
              `Fix: replace the inlined chunk with an "@${''}.claude/..." bookmark + a ` +
              `one-line pointer to the SSoT section. If the inline is a deliberate, ` +
              `separately-enforced contract (e.g. an ARIA kernel envelope), add an ` +
              `ANTI_INLINING_ALLOWLIST entry naming the enforcing contractOwner.`,
          );
        }
        expect(violations).toEqual([]);
      });
    }
  });

  it('still detects the deliberate mirror-enforced inline so the allowlist stays load-bearing', () => {
    // Regression guard: the root-cause-auditor / output-format AUDIT-* sub-kind
    // restatement is a DELIBERATE, mirror-enforced inline (see the allowlist
    // entry + the "AUDIT-* sub-kind mirror" describe below). If that inline is
    // ever removed (agent switches to a pure @-reference), this assertion turns
    // red and the allowlist entry must be deleted — keeping the allowlist from
    // silently outliving the duplication it documents.
    const rca = agents.find((a) => basename(a.relPath) === 'root-cause-auditor.md');
    expect(rca).toBeDefined();
    if (!rca) return;
    const flags = detectFlags(rca.relPath, rca.content);
    expect(
      flags.some(
        (f) =>
          f.ssot === '.claude/shared/output-format.md' &&
          f.kind === 'contiguous-run',
      ),
    ).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// AUDIT-* sub-kind mirror (resolves the root-cause-auditor inline like the
// ARIA-envelope pattern): output-format.md is the SSoT for the AUDIT-* finding
// namespace sub-kind vocabulary; root-cause-auditor.md restates it inline
// because the agent emits those tags and is dispatched with only its prompt as
// context. This guard asserts the two lists are byte-equal so the deliberate,
// allowlisted inline cannot drift from the SSoT.
// ----------------------------------------------------------------------------
const OUTPUT_FORMAT_SSOT = '.claude/shared/output-format.md';
const ROOT_CAUSE_AUDITOR = '.claude/agents/root-cause-auditor.md';

/**
 * Extract the backtick-wrapped UPPER_SNAKE_CASE AUDIT-* sub-kind tokens from
 * the segment introduced by a "Sub-kind(s)..:" label. Both the SSoT and the
 * agent introduce the list that way; we read the same shape from each so the
 * comparison is symmetric.
 */
function auditSubkinds(body: string): string[] {
  const seg = body.match(/Sub-?kinds?\b[^\n]*?:\s*([^\n]*)/i);
  if (!seg || !seg[1]) return [];
  const tokens = seg[1].match(/`([A-Z][A-Z0-9_]+)`/g) ?? [];
  return tokens.map((t) => t.replace(/`/g, '')).sort();
}

describe('AUDIT-* sub-kind mirror (output-format SSoT <-> root-cause-auditor inline)', () => {
  it('the agent inline AUDIT-* sub-kind list is byte-equal to the output-format SSoT list', () => {
    const ssot = auditSubkinds(readFileSync(join(REPO_ROOT, OUTPUT_FORMAT_SSOT), 'utf8'));
    const agent = auditSubkinds(readFileSync(join(REPO_ROOT, ROOT_CAUSE_AUDITOR), 'utf8'));

    // Floor: the SSoT must actually declare the vocabulary (guards a broken
    // extraction / a renamed section silently emptying both sides).
    expect(ssot.length).toBeGreaterThanOrEqual(6);

    expect(agent).toEqual(ssot);
  });
});

describe('lane-divergence guard (Lane-A vs Lane-B orchestrator files)', () => {
  it('every justified-divergence pair points at real files', () => {
    for (const pair of JUSTIFIED_DIVERGENCE) {
      for (const rel of [pair.laneA, pair.laneB]) {
        const body = readFileSync(join(REPO_ROOT, rel), 'utf8');
        expect(body.length).toBeGreaterThan(0);
      }
      expect(pair.reason.length).toBeGreaterThan(0);
    }
  });

  for (const pair of JUSTIFIED_DIVERGENCE) {
    it(`${basename(pair.laneA)} <-> ${basename(pair.laneB)} stay below the cross-lane run floor`, () => {
      const aTokens = tokenize(
        normalize(proseWithoutFences(readFileSync(join(REPO_ROOT, pair.laneA), 'utf8'))),
      );
      const bTokens = tokenize(
        normalize(proseWithoutFences(readFileSync(join(REPO_ROOT, pair.laneB), 'utf8'))),
      );
      const aShingles = shingles(aTokens, W);
      const bIndex = buildShingleIndex(shingles(bTokens, W));
      const { run, startA } = longestContiguousRun(aShingles, bIndex);
      if (run >= LANE_DIVERGENCE_MAX_RUN) {
        throw new Error(
          `Lane-A and Lane-B files share a contiguous run of ${run} shingles ` +
            `(>= ${LANE_DIVERGENCE_MAX_RUN}) — the two lanes are copy-pasting toward ` +
            `each other:\n  ${pair.laneA}\n  ${pair.laneB}\n  verbatim: "${verbatimRunText(
              aTokens,
              startA,
              run,
            ).slice(0, 240)}"\n` +
            `Either extract the shared text to an SSoT file both reference, or — if ` +
            `this is a true convergence — update JUSTIFIED_DIVERGENCE.`,
        );
      }
      expect(run).toBeLessThan(LANE_DIVERGENCE_MAX_RUN);
    });
  }
});
