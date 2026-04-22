/**
 * Skills Catalog Invariant
 * ============================================================================
 *
 * Closes Phase 3b of /root/.claude/plans/synthetic-dazzling-hippo.md
 * (finding CLAUDE-HIGH-001 + CLAUDE-MEDIUM-002 + CLAUDE-LOW-002).
 *
 * Asserts the five validation rules declared in .claude/skills/README.md:
 *
 *   1. Every .claude/skills/*.md (except README) has canonical frontmatter:
 *      name, description, type: skill, version, owners, handoff.
 *   2. Every skill with a `blocker:` field has an `## ADR Gate` section OR
 *      a section that names the BLOCKER-NN identifier.
 *   3. Every cited agent name in `handoff.on_complete_invoke` resolves to
 *      an existing agent in .claude/agents/.
 *   4. Every skill has a `## Validation checklist` section.
 *   5. No dangling skill references — any `use \`<name>\` skill` phrase in
 *      any skill body must name a file that exists under .claude/skills/.
 *
 * # When this spec fails
 *
 *   - Skill missing `handoff:` frontmatter → add the block per
 *     _shared/handoff-protocol.md § Skill frontmatter.
 *   - `on_complete_invoke` names a non-existent agent → typo or the
 *     agent was renamed; update the skill.
 *   - Dangling skill ref → either delete the reference or add the
 *     missing skill file.
 *
 * # References
 *
 *   - /root/.claude/plans/synthetic-dazzling-hippo.md#Phase-3b
 *   - .claude/skills/README.md § Validation (lines 105-111)
 *   - .claude/shared/handoff-protocol.md § Skill frontmatter
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills');
const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');

interface SkillFrontmatter {
  readonly file: string;
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly version: string;
  readonly owners: string;
  readonly handoff: string; // raw YAML block
  readonly blocker: string | null;
}

function listSkillFiles(): string[] {
  return fs
    .readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => path.join(SKILLS_DIR, f));
}

function extractFrontmatter(content: string): Record<string, string> | null {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return null;
  const [, block] = m;
  if (!block) return null;
  const result: Record<string, string> = {};
  // Simple YAML: parse `key: value` pairs and `key:\n  sub: value` blocks
  // into a flat `key` → raw-block string for presence checks.
  let currentKey: string | null = null;
  let currentBlock: string[] = [];
  for (const line of block.split('\n')) {
    const topLevel = line.match(/^([a-z_][a-z0-9_]*):\s*(.*)$/i);
    if (topLevel) {
      if (currentKey) {
        result[currentKey] = currentBlock.join('\n').trim();
      }
      const [, key, val] = topLevel;
      if (!key) continue;
      currentKey = key;
      currentBlock = val ? [val] : [];
    } else if (currentKey && /^\s+/.test(line)) {
      currentBlock.push(line);
    }
  }
  if (currentKey) {
    result[currentKey] = currentBlock.join('\n').trim();
  }
  return result;
}

function readSkill(file: string): SkillFrontmatter | null {
  const content = fs.readFileSync(file, 'utf8');
  const fm = extractFrontmatter(content);
  if (!fm) return null;
  return {
    file: path.relative(REPO_ROOT, file),
    name: fm['name'] ?? '',
    description: fm['description'] ?? '',
    type: fm['type'] ?? '',
    version: fm['version'] ?? '',
    owners: fm['owners'] ?? '',
    handoff: fm['handoff'] ?? '',
    blocker: fm['blocker'] ?? null,
  };
}

function listAgentNames(): Set<string> {
  const names = new Set<string>();
  if (!fs.existsSync(AGENTS_DIR)) return names;
  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith('.md') || entry === 'README.md') continue;
    const content = fs.readFileSync(path.join(AGENTS_DIR, entry), 'utf8');
    const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) continue;
    const [, block] = m;
    if (!block) continue;
    const nameLine = block.split('\n').find((l) => /^name:\s*/.test(l));
    if (!nameLine) continue;
    names.add(nameLine.replace(/^name:\s*/, '').trim());
  }
  return names;
}

describe('skills catalog invariant', () => {
  const files = listSkillFiles();
  const skills = files
    .map((f) => readSkill(f))
    .filter((s): s is SkillFrontmatter => s !== null);

  it('at least one skill file exists (otherwise this invariant is a no-op regression)', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  describe.each(skills)('skill $name ($file)', (skill) => {
    it('has required frontmatter fields (name, description, type, version, owners, handoff)', () => {
      expect(skill.name).not.toBe('');
      expect(skill.description).not.toBe('');
      expect(skill.type).toBe('skill');
      expect(skill.version).not.toBe('');
      expect(skill.owners).not.toBe('');
      expect(skill.handoff).not.toBe('');
    });

    it('handoff.on_complete_invoke references only existing agents', () => {
      const agentNames = listAgentNames();
      const match = skill.handoff.match(/on_complete_invoke:\s*\[([^\]]*)\]/);
      if (!match) {
        throw new Error(
          `${skill.file}: handoff.on_complete_invoke field is missing or malformed. ` +
            'Expected "on_complete_invoke: [agent-name, ...]" per _shared/handoff-protocol.md.',
        );
      }
      const [, rawList] = match;
      const invokees = (rawList ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(invokees.length).toBeGreaterThan(0);

      // Allowlist: "respective-domain-expert" / "respective-producer-agent" are
      // dynamic placeholders that resolve at skill-invocation time. Accept
      // them literally even though no matching file exists.
      const dynamic = new Set(['respective-domain-expert', 'respective-producer-agent']);
      const unknown = invokees.filter((name) => !agentNames.has(name) && !dynamic.has(name));
      if (unknown.length > 0) {
        throw new Error(
          `${skill.file}: handoff.on_complete_invoke references unknown agent(s): ${unknown.join(', ')}. ` +
            'Either fix the typo, rename the skill, or add the agent to .claude/agents/.',
        );
      }
    });

    it('has a Validation checklist section', () => {
      const content = fs.readFileSync(path.join(REPO_ROOT, skill.file), 'utf8');
      expect(content).toMatch(/## Validation checklist/);
    });

    if (skill.blocker) {
      it(`blocker-gated skill (${skill.blocker}) names the BLOCKER in a section heading`, () => {
        const content = fs.readFileSync(path.join(REPO_ROOT, skill.file), 'utf8');
        const blockerPattern = new RegExp(skill.blocker ?? '');
        // Either an "## ADR Gate" section OR a section heading naming
        // the BLOCKER id is acceptable — existing skills use both forms.
        const hasGateSection = /^## ADR Gate/m.test(content);
        const hasBlockerInHeading = content
          .split('\n')
          .some((l) => /^##/.test(l) && blockerPattern.test(l));
        expect(hasGateSection || hasBlockerInHeading).toBe(true);
      });
    }
  });

  it('no dangling "use `<name>` skill" reference names a file that does not exist', () => {
    const skillNames = new Set(files.map((f) => path.basename(f, '.md')));
    const danglingRefs: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      // Pattern: "use `<name>` skill" — the dangling-ref form the audit
      // flagged (CLAUDE-LOW-002 cited add-entity-field.md "use `create-entity` skill").
      const matches = content.matchAll(/use `([a-z][a-z0-9-]*)` skill/g);
      for (const m of matches) {
        const [, ref] = m;
        if (!ref || skillNames.has(ref)) continue;
        danglingRefs.push(`${path.relative(REPO_ROOT, file)} → "use \`${ref}\` skill" (no such file)`);
      }
    }
    if (danglingRefs.length > 0) {
      throw new Error(`Dangling skill references:\n  - ${danglingRefs.join('\n  - ')}`);
    }
    expect(danglingRefs).toEqual([]);
  });
});
