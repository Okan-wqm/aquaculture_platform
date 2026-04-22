/**
 * Settings Hook Coverage Invariant
 * ============================================================================
 *
 * Closes CLAUDE-MEDIUM-006 — .claude/settings.json lacked a PreToolUse gate
 * on the Agent tool. Tier-3 "make-it-detectable" for the hook wiring:
 * future edits that accidentally drop the hook (or rename the gate script
 * out from under settings.json) fail CI.
 *
 * Asserts:
 *   1. .claude/settings.json parses as JSON.
 *   2. Declares hooks.PreToolUse[] with at least one entry whose matcher
 *      is "Agent" and whose hook command references
 *      tools/gates/agent-dispatch-gate.ts.
 *   3. The referenced gate script exists on disk + is executable code
 *      (non-empty, has Node shebang or explicit node invocation).
 *   4. Gate script exports no symbols (it is a CLI entry point) and does
 *      not import any third-party npm dependency (Node built-ins only).
 *
 * Hook schema reference: https://code.claude.com/docs/en/hooks.md
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS_PATH = path.join(REPO_ROOT, '.claude', 'settings.json');
const GATE_PATH = path.join(REPO_ROOT, 'tools', 'gates', 'agent-dispatch-gate.ts');

interface HookCommand {
  readonly type: 'command';
  readonly command: string;
}

interface HookEntry {
  readonly matcher?: string;
  readonly hooks?: readonly HookCommand[];
}

interface Settings {
  readonly hooks?: {
    readonly PreToolUse?: readonly HookEntry[];
  };
}

describe('settings hook coverage invariant (CLAUDE-MEDIUM-006)', () => {
  it('.claude/settings.json exists and parses as JSON', () => {
    expect(fs.existsSync(SETTINGS_PATH)).toBe(true);
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    expect(() => JSON.parse(raw) as Settings).not.toThrow();
  });

  it('declares a PreToolUse hook with matcher "Agent"', () => {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw) as Settings;
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    const agentMatchers = preToolUse.filter((entry) => entry.matcher === 'Agent');
    expect(agentMatchers.length).toBeGreaterThan(0);
  });

  it('Agent hook command references tools/gates/agent-dispatch-gate.ts', () => {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw) as Settings;
    const agentEntry = (settings.hooks?.PreToolUse ?? []).find(
      (e) => e.matcher === 'Agent',
    );
    expect(agentEntry).toBeDefined();
    const commands = (agentEntry?.hooks ?? []).map((h) => h.command);
    const refsGate = commands.some((c) =>
      c.includes('tools/gates/agent-dispatch-gate.ts'),
    );
    expect(refsGate).toBe(true);
  });

  it('gate script exists and is a Node type-stripping entry point', () => {
    expect(fs.existsSync(GATE_PATH)).toBe(true);
    const content = fs.readFileSync(GATE_PATH, 'utf8');
    expect(content.length).toBeGreaterThan(100);
    const firstLine = content.split('\n')[0] ?? '';
    expect(firstLine).toMatch(/^#!/);
    expect(firstLine).toMatch(/node/);
    expect(firstLine).toMatch(/strip-types/);
  });

  it('gate script imports only Node built-ins (no third-party deps)', () => {
    const content = fs.readFileSync(GATE_PATH, 'utf8');
    const importLines = content.match(/^import .* from ['"](.+)['"];?$/gm) ?? [];
    const violations: string[] = [];
    for (const line of importLines) {
      const m = line.match(/from ['"](.+)['"]/);
      const spec = m?.[1] ?? '';
      if (!spec.startsWith('node:')) {
        violations.push(line);
      }
    }
    expect(violations).toEqual([]);
  });
});
