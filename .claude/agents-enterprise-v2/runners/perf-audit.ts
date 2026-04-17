#!/usr/bin/env node
/**
 * perf-audit — Phase 14.1 runner profile
 * ============================================================================
 *
 * Thin wrapper over `orchestrator-runner.ts` that fixes the review
 * profile to:
 *
 *   --topic   perf-audit-<YYYY-MM-DD>
 *   --agents  performance-expert,database-reviewer,observability-expert,data-expert
 *   --scope   '{apps,libs,platform,web}/**\/*.{ts,tsx,sql}'
 *   --mode    review
 *
 * Purpose: a one-command performance-surface sweep. The profile
 * dispatches the four agents whose mandates intersect on perf:
 *
 *   - performance-expert   — query plans, N+1 detection, hot paths,
 *                            resolver-level DataLoader coverage.
 *   - database-reviewer    — index coverage, column discipline,
 *                            TimescaleDB chunk-pruning correctness,
 *                            partition strategy.
 *   - observability-expert — Prometheus high-cardinality label
 *                            detection, tracing gaps on hot paths,
 *                            SLO coverage.
 *   - data-expert          — event publish path latency, outbox
 *                            worker backlog invariants, NATS
 *                            JetStream consumer backpressure.
 *
 * The runner is deliberately narrow: perf review is a cross-cutting
 * concern that touches every app. Rather than let each developer
 * guess which experts to dispatch, the profile IS the contract.
 *
 * Plan ref: docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.1
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const stamp = new Date().toISOString().slice(0, 10);
const topic = `perf-audit-${stamp}`;
const scope = '{apps,libs,platform,web}/**/*.{ts,tsx,sql}';
const agents = [
  'performance-expert',
  'database-reviewer',
  'observability-expert',
  'data-expert',
].join(',');

const runner = resolve(process.cwd(), 'tools/scripts/orchestrator-runner.ts');
const tsconfig = resolve(process.cwd(), 'tools/gates/tsconfig.json');
const cmd = `ts-node --project ${tsconfig} ${runner} --topic '${topic}' --scope '${scope}' --agents '${agents}' --mode review ${
  process.argv.slice(2).join(' ')
}`;

// eslint-disable-next-line no-console
console.log(`perf-audit → ${cmd}`);
execSync(cmd, { stdio: 'inherit' });
