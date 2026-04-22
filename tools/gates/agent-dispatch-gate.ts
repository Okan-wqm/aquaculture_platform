#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
/**
 * agent-dispatch-gate — PreToolUse hook for the Claude Code `Agent` tool.
 *
 * Closes CLAUDE-MEDIUM-006 — .claude/settings.json had no PreToolUse gate,
 * leaving Agent() dispatch un-audited and unbounded. This gate:
 *
 *   1. Validates the requested agent name against the live roster
 *      (Lane-A runtime + Lane-B specialists + Lane-A _maintenance/).
 *      Unknown name → deny with reason.
 *   2. Enforces a per-session fan-out cap (AGENT_FANOUT_CAP, default 12).
 *      Prevents accidental runaway cycles that blow through per-tenant
 *      rate limits and cost budgets.
 *   3. Appends an append-only JSONL row to the dispatch audit log at
 *      .claude/agents/.dispatch-log.jsonl (gitignored).
 *
 * Invocation contract (Claude Code PreToolUse hook):
 *   - stdin: JSON object with Agent tool invocation payload.
 *   - exit 0: dispatch approved.
 *   - exit non-zero: dispatch denied; stderr explains reason.
 *   - stdout is transparent to Claude Code; stderr surfaces to operator.
 *
 * The payload shape Claude Code emits for a PreToolUse hook is documented
 * at https://code.claude.com/docs/en/hooks.md. We read `tool_input.subagent_type`
 * as the requested agent name and `session_id` / `cwd` as identifiers.
 * Unknown payload shape is treated as "approve + log WARNING" — the gate
 * never hard-blocks on shape drift alone.
 *
 * Dispatch log row schema:
 *   { ts, session_id, cwd, agent, cycle_id, approved, reason? }
 *
 * Environment overrides:
 *   AGENT_FANOUT_CAP — integer cap on agents dispatched in the same
 *     5-minute window for a given session_id. Default 12. Unset or 0 →
 *     no cap (log-only mode, useful during onboarding of the gate).
 *
 * TypeScript per user preference: Node 22 type-stripping (shebang uses
 * --experimental-strip-types). No build step, no bundler, no dependencies
 * beyond `node:*`.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd());
const AGENTS_ROOT = join(REPO_ROOT, '.claude', 'agents');
const DISPATCH_LOG = join(REPO_ROOT, '.claude', 'agents', '.dispatch-log.jsonl');
const DEFAULT_FANOUT_CAP = 12;
const FANOUT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

interface HookPayload {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
}

interface LogRow {
  readonly ts: string;
  readonly session_id: string;
  readonly cwd: string;
  readonly agent: string;
  readonly cycle_id: string;
  readonly approved: boolean;
  readonly reason?: string;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function collectKnownAgentNames(): Set<string> {
  const names = new Set<string>();
  if (!existsSync(AGENTS_ROOT)) return names;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.md')) continue;
      if (entry === 'README.md' || entry === 'INVOCATION-PACK.md') continue;
      const content = readFileSync(full, 'utf8');
      const m = content.match(/^name:\s*([a-z][a-z-]+)/m);
      if (m && m[1]) names.add(m[1]);
    }
  };
  walk(AGENTS_ROOT);
  return names;
}

function ensureLogDir(): void {
  const dir = dirname(DISPATCH_LOG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function recentDispatchCount(sessionId: string): number {
  if (!existsSync(DISPATCH_LOG)) return 0;
  const now = Date.now();
  let count = 0;
  const lines = readFileSync(DISPATCH_LOG, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as LogRow;
      if (row.session_id !== sessionId) continue;
      if (!row.approved) continue;
      const ts = Date.parse(row.ts);
      if (Number.isNaN(ts)) continue;
      if (now - ts <= FANOUT_WINDOW_MS) count += 1;
    } catch {
      // Corrupt line — skip without failing the whole gate.
    }
  }
  return count;
}

function writeLog(row: LogRow): void {
  ensureLogDir();
  appendFileSync(DISPATCH_LOG, JSON.stringify(row) + '\n', 'utf8');
}

function main(): number {
  const stdinRaw = readStdin();
  let payload: HookPayload = {};
  try {
    payload = stdinRaw.trim() === '' ? {} : (JSON.parse(stdinRaw) as HookPayload);
  } catch {
    // Shape drift — approve + log WARNING rather than hard-block.
    console.error('agent-dispatch-gate: unparseable stdin, approving with WARNING');
    return 0;
  }

  const toolName = payload.tool_name ?? '';
  // Only gate Agent-tool invocations; approve everything else silently.
  if (toolName !== 'Agent') return 0;

  const agent = String(payload.tool_input?.subagent_type ?? '').trim();
  const sessionId = String(payload.session_id ?? 'unknown');
  const cwd = String(payload.cwd ?? REPO_ROOT);
  const cycleId = process.env.AGENT_CYCLE_ID ?? sessionId;
  const ts = new Date().toISOString();

  if (agent === '') {
    console.error('agent-dispatch-gate: Agent tool invocation missing subagent_type');
    writeLog({
      ts,
      session_id: sessionId,
      cwd,
      agent: '',
      cycle_id: cycleId,
      approved: false,
      reason: 'missing-subagent-type',
    });
    return 2;
  }

  const known = collectKnownAgentNames();
  // Built-in Claude Code sub-agents (general-purpose, Explore, Plan, etc.)
  // are not project-defined but are legitimate; only deny on the project-
  // dispatch surface. Built-ins have distinguishable capitalization /
  // naming conventions; our project roster is all lowercase-kebab with a
  // known suffix. Deny only if the name LOOKS like a project agent
  // (matches kebab shape AND has a known suffix) but does not resolve.
  const projectAgentShape =
    /^[a-z][a-z0-9-]+-(expert|auditor|reviewer|executor|planner|writer|enforcer|arbiter|manager|orchestrator|mapper|agent|validator)$/;
  const looksProject = projectAgentShape.test(agent);
  const resolved = known.has(agent);

  if (looksProject && !resolved) {
    console.error(
      `agent-dispatch-gate: unknown project agent "${agent}" — not in runtime roster under .claude/agents/**`,
    );
    writeLog({
      ts,
      session_id: sessionId,
      cwd,
      agent,
      cycle_id: cycleId,
      approved: false,
      reason: 'agent-not-in-roster',
    });
    return 1;
  }

  const cap = Number(process.env.AGENT_FANOUT_CAP ?? DEFAULT_FANOUT_CAP);
  if (cap > 0) {
    const recent = recentDispatchCount(sessionId);
    if (recent >= cap) {
      console.error(
        `agent-dispatch-gate: fan-out cap reached (${recent}/${cap} dispatches in last ${FANOUT_WINDOW_MS / 60_000}min for session ${sessionId}). ` +
          'Set AGENT_FANOUT_CAP=0 to disable, or wait for window to expire.',
      );
      writeLog({
        ts,
        session_id: sessionId,
        cwd,
        agent,
        cycle_id: cycleId,
        approved: false,
        reason: 'fanout-cap-exceeded',
      });
      return 1;
    }
  }

  writeLog({ ts, session_id: sessionId, cwd, agent, cycle_id: cycleId, approved: true });
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error('agent-dispatch-gate: unexpected error', err);
  // Fail-open on unexpected error — do not block work on gate bugs.
  process.exit(0);
}
