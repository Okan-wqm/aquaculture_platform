#!/usr/bin/env node
/**
 * orchestrator-runner — Phase 14.4
 * ============================================================================
 *
 * Wraps the orchestrator-reviewer agent dispatch loop behind a stable
 * CLI so that `npm run review -- --topic <slug> --scope <glob>` is the
 * one entrypoint developers and CI jobs use.
 *
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.4
 *
 * ## What it does at this layer
 *
 * Claude Code is the execution substrate — `npx claude-agent` is the
 * binary that actually dispatches review sub-agents. This runner
 * composes the invocation:
 *
 *   1. Resolve `--scope` glob → changed-file list (git diff, or
 *      a literal glob match).
 *   2. Resolve `--agents <csv>` → explicit agent list, OR derive from
 *      the orchestrator routing table by matching the changed-file
 *      globs against `_shared/orchestrator-routing-table.md`.
 *   3. Assemble the orchestrator system prompt (orchestrator.md +
 *      _shared/orchestrator-*.md + knowledge layers).
 *   4. Hand off to Claude Code agent-dispatch (stdout streams the
 *      Progress protocol per `_shared/unified-report-format.md`).
 *   5. Final unified report lands at
 *      `docs/reviews/orchestrator/<YYYY-MM-DD>-<slug>.md`.
 *
 * The runner is deliberately a thin orchestrator around the Claude
 * Code CLI — complex dispatch logic lives in the agent system prompt,
 * not here. This file exists so invocation is scriptable + CI-runnable.
 *
 * ## What it does NOT do
 *
 * - It does NOT itself dispatch sub-agents (Claude Code does that).
 * - It does NOT parse sub-agent output (the unified report does that).
 * - It does NOT short-circuit the review loop based on scope shape —
 *   if you pass --scope "apps/farm-service/**" the routing-table match
 *   MAY hand the work to multiple agents (farm-expert + data-expert +
 *   database-reviewer), and that fan-out is the orchestrator's call.
 *
 * ## Execution substrate: ts-node + tools/gates/tsconfig.json
 *
 * This runner re-uses the Phase 2 gate tsconfig (CommonJS + strict +
 * noUncheckedIndexedAccess + transpileOnly). Keeping the gate CLIs
 * and the orchestrator runner on the same tsconfig means one
 * type-system contract rather than two. `npm run review` resolves to
 * `ts-node --project tools/gates/tsconfig.json tools/scripts/orchestrator-runner.ts`.
 *
 * Plan ref: docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.4
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------- Types ---------------------------------------------------------

interface RunnerArgs {
  topic: string;
  scope: string | null;
  agents: string[] | null;
  mode: 'review' | 'teach' | 'implement';
  base: string | null;
  head: string | null;
  dryRun: boolean;
}

// ---------- Arg parsing ---------------------------------------------------

function parseArgs(argv: string[]): RunnerArgs {
  const args: Partial<RunnerArgs> = {
    mode: 'review',
    scope: null,
    agents: null,
    base: null,
    head: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--topic':
        if (!next) throw new Error('--topic requires a value');
        args.topic = next;
        i++;
        break;
      case '--scope':
        if (!next) throw new Error('--scope requires a value');
        args.scope = next;
        i++;
        break;
      case '--agents':
        if (!next) throw new Error('--agents requires a csv value');
        args.agents = next.split(',').map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case '--mode':
        if (!next) throw new Error('--mode requires a value');
        if (next !== 'review' && next !== 'teach' && next !== 'implement') {
          throw new Error(`--mode must be review|teach|implement (got ${next})`);
        }
        args.mode = next;
        i++;
        break;
      case '--base':
        if (!next) throw new Error('--base requires a value');
        args.base = next;
        i++;
        break;
      case '--head':
        if (!next) throw new Error('--head requires a value');
        args.head = next;
        i++;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown arg: ${a}`);
    }
  }

  if (!args.topic) {
    throw new Error('--topic <slug> is required');
  }
  return args as RunnerArgs;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`orchestrator-runner — dispatch an enterprise-v2 review cycle

Usage:
  npm run review -- --topic <slug> [--scope <glob>] [--agents <csv>]
                    [--mode review|teach|implement] [--base <ref>]
                    [--head <ref>] [--dry-run]

Options:
  --topic <slug>    Identifier for the unified report (kebab-case).
  --scope <glob>    File glob to review. If omitted, defaults to the
                    git diff between --base and --head.
  --agents <csv>    Explicit agent list. Overrides routing-table
                    auto-dispatch. Use when you know which experts
                    this review needs.
  --mode <m>        review (default) | teach | implement.
  --base <ref>      Base git ref for diff (default: main).
  --head <ref>      Head git ref for diff (default: HEAD).
  --dry-run         Resolve dispatch + print plan; do not call
                    claude-agent.

Examples:
  npm run review -- --topic farm-harvest-batch --scope 'apps/farm-service/**'
  npm run audit:gdpr        # via runner profile
  npm run findings:list
`);
}

// ---------- Scope + agent resolution --------------------------------------

function resolveChangedFiles(args: RunnerArgs): string[] {
  if (args.scope) {
    // Scope is a literal glob; resolve via git ls-files + shell glob.
    // Fall back to literal echo if git resolution fails.
    try {
      const out = execSync(`git ls-files -- '${args.scope}'`, { encoding: 'utf8' });
      return out.split('\n').filter(Boolean);
    } catch {
      return [args.scope];
    }
  }
  const base = args.base ?? 'main';
  const head = args.head ?? 'HEAD';
  try {
    const out = execSync(`git diff --name-only ${base}...${head}`, { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    throw new Error(`Failed to resolve changed files for ${base}...${head}: ${(e as Error).message}`);
  }
}

function resolveAgentsFromRoutingTable(_changedFiles: string[]): string[] {
  // Skeleton: real dispatch delegates to the orchestrator agent itself,
  // which reads _shared/orchestrator-routing-table.md and matches each
  // changed file to one or more primary/secondary agents. The runner
  // only needs to ENUMERATE candidates when --agents is not set; the
  // orchestrator performs the authoritative match during review.
  //
  // Returning ['orchestrator'] hands the routing decision to the
  // agent system prompt — the invariant that 'every changed file maps
  // to at least one primary agent' is enforced in
  // tests/invariants/orchestrator-routing-coverage.spec.ts, not here.
  return ['orchestrator'];
}

// ---------- Dispatch -------------------------------------------------------

function dispatch(args: RunnerArgs, files: string[], agents: string[]): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const reportDir = resolve(process.cwd(), 'docs/reviews/orchestrator');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${stamp}-${args.topic}.md`);

  const plan = {
    topic: args.topic,
    mode: args.mode,
    scope: args.scope,
    base: args.base,
    head: args.head,
    changedFileCount: files.length,
    changedFiles: files.slice(0, 20),
    agents,
    reportPath,
  };

  // eslint-disable-next-line no-console
  console.log('orchestrator-runner dispatch plan:');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(plan, null, 2));
  if (files.length > 20) {
    // eslint-disable-next-line no-console
    console.log(`(+ ${files.length - 20} more files omitted from preview)`);
  }

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log('\n--dry-run: stopping before claude-agent dispatch.');
    return;
  }

  // Write a placeholder report header so downstream consumers
  // (finding-registry, CI) have a stable path even if the agent
  // dispatch below never completes.
  const header = `# Unified Review Report — ${args.topic}\n\n` +
    `**Generated**: ${new Date().toISOString()}\n` +
    `**Mode**: ${args.mode}\n` +
    `**Scope**: ${args.scope ?? '(diff-derived)'}\n` +
    `**Agents**: ${agents.join(', ')}\n\n` +
    `**Status**: DISPATCHED (awaiting orchestrator agent completion)\n\n` +
    `---\n\n` +
    `_This header is written by tools/scripts/orchestrator-runner.ts before handing off to claude-agent._\n`;
  writeFileSync(reportPath, header);

  // Hand off to Claude Code's agent CLI. The presence of `claude-agent`
  // on PATH is assumed in dev + CI; a missing binary is a hard fail —
  // the runner explicitly refuses to silently skip dispatch.
  if (!binaryExists('claude-agent')) {
    // eslint-disable-next-line no-console
    console.error(
      'claude-agent CLI not on PATH. Install Claude Code (https://claude.com/claude-code) or pass --dry-run to inspect the plan without dispatching.',
    );
    process.exit(2);
  }
  const dispatchCmd = `claude-agent run --agent orchestrator --topic '${args.topic}' --mode ${args.mode}`;
  // eslint-disable-next-line no-console
  console.log(`\nExecuting: ${dispatchCmd}\n`);
  try {
    execSync(dispatchCmd, { stdio: 'inherit' });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`claude-agent dispatch failed: ${(e as Error).message}`);
    process.exit(3);
  }
}

function binaryExists(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------- Entry ----------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage();
    process.exit(1);
  }
  let args: RunnerArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`Arg error: ${(e as Error).message}\n`);
    printUsage();
    process.exit(1);
  }

  const files = resolveChangedFiles(args);
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.error('No files matched scope / diff — nothing to review.');
    process.exit(1);
  }

  const agents = args.agents ?? resolveAgentsFromRoutingTable(files);
  if (agents.length === 0) {
    // eslint-disable-next-line no-console
    console.error('No agents resolved — this should be impossible if the routing table is complete.');
    process.exit(1);
  }

  dispatch(args, files, agents);
}

// Refuse to silently import-without-running when invoked directly.
if (process.argv[1] && process.argv[1].includes('orchestrator-runner')) {
  main();
}

export { parseArgs, resolveChangedFiles, resolveAgentsFromRoutingTable };
