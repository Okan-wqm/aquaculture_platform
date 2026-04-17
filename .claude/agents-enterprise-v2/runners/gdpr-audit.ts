#!/usr/bin/env node
/**
 * gdpr-audit — Phase 14.1 runner profile
 * ============================================================================
 *
 * Thin wrapper over `orchestrator-runner.ts` that fixes the review
 * profile to:
 *
 *   --topic   gdpr-audit-<YYYY-MM-DD>
 *   --agents  compliance-expert,gdpr-erasure-executor,security-reviewer,data-expert
 *   --scope   '{apps,libs,platform}/**\/*.{ts,sql}'
 *   --mode    review
 *
 * Purpose: a one-command quarterly (or ad-hoc) GDPR surface sweep so
 * compliance reviews don't require every developer to remember the
 * right agent list + scope. The profile IS the review contract.
 *
 * ## What it checks (delegates to the agents)
 *
 * - Data-subject rights — Art 15 (access), Art 17 (erasure),
 *   Art 20 (portability) pipelines exist + are tested.
 * - Consent + purpose-limitation — `shared.user_consents` + audit
 *   trail completeness.
 * - Cross-border transfer — no data flow outside contracted regions
 *   (detected via outbound network egress config + S3/MinIO bucket
 *   region pinning).
 * - Retention policies — time-series retention set per schema;
 *   policies not hiding GDPR deletion paths (see TimescaleDB layer-1
 *   knowledge: retention != deletion).
 * - Audit completeness — every personal-data read/write surface
 *   emits an immutable `shared.audit_logs` row.
 *
 * The runner does NOT perform the audit itself — it dispatches the
 * four agents and lets their unified report be the deliverable. The
 * runner's value is the stable invocation contract.
 *
 * Plan ref: docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.1
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const stamp = new Date().toISOString().slice(0, 10);
const topic = `gdpr-audit-${stamp}`;
const scope = '{apps,libs,platform}/**/*.{ts,sql}';
const agents = [
  'compliance-expert',
  'gdpr-erasure-executor',
  'security-reviewer',
  'data-expert',
].join(',');

const runner = resolve(process.cwd(), 'tools/scripts/orchestrator-runner.ts');
const tsconfig = resolve(process.cwd(), 'tools/gates/tsconfig.json');
const cmd = `ts-node --project ${tsconfig} ${runner} --topic '${topic}' --scope '${scope}' --agents '${agents}' --mode review ${
  process.argv.slice(2).join(' ')
}`;

// eslint-disable-next-line no-console
console.log(`gdpr-audit → ${cmd}`);
execSync(cmd, { stdio: 'inherit' });
