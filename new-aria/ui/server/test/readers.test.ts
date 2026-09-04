// SCENARIO: every core reader against a tools dir cut from a real kernel cycle.
// EXPECTS: rows fold into the contract shapes without invented fields; absent
// ledgers yield empty collections; the overview aggregates the same numbers.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ServerConfig } from '../src/config.ts';
import { readAgentRequests } from '../src/readers/agents.ts';
import { readCycleDetail, readCycles } from '../src/readers/cycles.ts';
import { readFindings } from '../src/readers/findings.ts';
import { readGovernance } from '../src/readers/governance.ts';
import { readHumanRequired } from '../src/readers/human-required.ts';
import { readLedgers } from '../src/readers/ledgers.ts';
import { readBeliefs } from '../src/readers/memory.ts';
import { readOverview } from '../src/readers/overview.ts';
import { readPlans } from '../src/readers/plans.ts';
import { readPressures } from '../src/readers/pressures.ts';
import { listDailyReports, readDailyReport } from '../src/readers/reports.ts';
import { readTools } from '../src/readers/tools.ts';

const FIXTURE_TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tools');

function configFor(toolsDir: string): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    token: 'unit-test-token-0123456789abcdef',
    toolsDir,
    workspaceRoot: null,
    workspaceBase: join(toolsDir, '..', 'workspaces'),
    kernelBin: '/bin/false',
    staticDir: join(toolsDir, '..', 'static'),
    allowActions: false,
    actionTimeoutMs: 1000,
    version: 'test',
  };
}

test('cycles fold started + terminal rows into one summary with a duration', async () => {
  const result = await readCycles(FIXTURE_TOOLS, 10);
  assert.equal(result.total, 1);
  const cycle = result.cycles[0];
  assert.ok(cycle);
  assert.equal(cycle.status, 'failed');
  assert.ok(cycle.startedAt && cycle.endedAt);
  assert.ok((cycle.durationSeconds ?? -1) >= 0);
  const detail = await readCycleDetail(FIXTURE_TOOLS, cycle.cycleId);
  assert.equal(detail.discovery.completionProof?.['complete'], true);
  assert.equal(typeof detail.discovery.repoFingerprint?.['language_histogram'], 'object');
  assert.ok(detail.runs.length >= 1);
  assert.ok(detail.runs.every((run) => typeof run['tool_id'] === 'string' && !('artifact_refs' in run)));
  assert.equal(detail.metrics?.['cycle_id'], cycle.cycleId);
});

test('governance rows expose kind as event and details as an object', async () => {
  const result = await readGovernance(FIXTURE_TOOLS, { limit: 5, since: null, event: null });
  assert.equal(result.rows.length, 5);
  assert.equal(result.total, 40);
  assert.ok(result.rows.every((row) => typeof row.event === 'string' && typeof row.details === 'object'));
  const filtered = await readGovernance(FIXTURE_TOOLS, { limit: 50, since: null, event: 'tool_registered_initial' });
  assert.ok(filtered.rows.length >= 1);
  assert.ok(filtered.rows.every((row) => row.event === 'tool_registered_initial'));
});

test('findings project the summary object and count severities', async () => {
  const result = await readFindings(FIXTURE_TOOLS, { limit: 100, severity: null, status: null, tool: null });
  assert.equal(result.total, 20);
  assert.equal(result.findings.length, 20);
  const knownTools = new Set(['agent-harness-security-adapter', 'doc-staleness-adapter']);
  assert.ok(result.findings.every((finding) => finding.id !== '' && finding.toolId !== null && knownTools.has(finding.toolId)));
  assert.equal(result.findings.filter((finding) => finding.toolId === 'doc-staleness-adapter').length, 7);
  assert.ok(result.findings.every((finding) => finding.feedback === null));
  const byTool = await readFindings(FIXTURE_TOOLS, { limit: 100, severity: null, status: null, tool: 'nope' });
  assert.equal(byTool.findings.length, 0);
});

test('beliefs fold to the latest revision and report status counts', async () => {
  const result = await readBeliefs(FIXTURE_TOOLS, { status: null, limit: 100 });
  assert.equal(result.beliefs.length, 1);
  assert.equal(result.beliefs[0]?.beliefId, 'repo-has-node-package-manifest');
  assert.equal(result.beliefs[0]?.confidence, 1);
  assert.deepEqual(result.byStatus, { supported: 1 });
  assert.equal(result.uncertainties, 3);
  assert.equal(result.contradictions, 0);
});

test('pressures come from the newest pressure-log row sorted by score', async () => {
  const result = await readPressures(FIXTURE_TOOLS, 10);
  assert.equal(result.total, 1);
  assert.equal(result.pressures[0]?.source, 'tool_quarantine');
  assert.equal(result.pressures[0]?.score, 90);
  assert.ok(typeof result.pressures[0]?.score === 'number');
});

test('human-required files become items with SLA state', async () => {
  const result = await readHumanRequired(FIXTURE_TOOLS, new Date('2026-09-03T17:00:00Z'));
  assert.equal(result.items.length, 2);
  assert.equal(result.open, 2);
  assert.ok(result.items.every((item) => item.requestId.startsWith('genesis-') && item.slaDeadline !== null));
});

test('agent requests fold by request id with a closed state vocabulary', async () => {
  const result = await readAgentRequests(FIXTURE_TOOLS, { state: null, limit: 100 });
  assert.equal(result.requests.length, 5);
  assert.ok(result.requests.every((request) => request.state === 'pending' && request.role !== null));
  assert.deepEqual(result.byState, { pending: 5 });
});

test('plans, tools, reports and ledgers read their surfaces', async () => {
  const plans = await readPlans(FIXTURE_TOOLS, 100);
  assert.deepEqual(plans.plans, []);
  const tools = await readTools(FIXTURE_TOOLS);
  assert.ok(tools.tools.length >= 10);
  const harness = tools.tools.find((tool) => tool.toolId === 'agent-harness-security-adapter');
  assert.equal(harness?.runCount, 1);
  assert.equal(harness?.lastRunStatus, 'evidence_error');
  const reports = await listDailyReports(FIXTURE_TOOLS);
  assert.deepEqual(
    reports.reports.map((report) => report.date),
    ['2026-09-03'],
  );
  assert.ok((await readDailyReport(FIXTURE_TOOLS, '2026-09-03')).markdown.length > 10);
  const ledgers = await readLedgers(FIXTURE_TOOLS);
  const cycles = ledgers.surfaces.find((surface) => surface.name === 'cycles');
  assert.equal(cycles?.present, true);
  assert.equal(cycles?.rows, 2);
  assert.equal(cycles?.indexed, true);
  assert.ok(cycles?.lastHash?.startsWith('sha256:'));
});

test('overview aggregates the same numbers and treats a missing profile file as standard', async () => {
  const overview = await readOverview(configFor(FIXTURE_TOOLS));
  assert.equal(overview.profile.current, 'standard');
  assert.equal(overview.killSwitch.engaged, false);
  assert.equal(overview.counts.cycles, 1);
  assert.equal(overview.counts.rawFindings, 20);
  assert.equal(overview.counts.humanRequiredOpen, 2);
  assert.equal(overview.counts.agentRequests, 5);
  assert.equal(overview.lastCycle?.status, 'failed');
  assert.equal(overview.gateway, null);
});

test('an empty tools dir yields empty collections, never errors', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'aria-ui-empty-'));
  assert.deepEqual((await readCycles(empty, 10)).cycles, []);
  assert.deepEqual((await readGovernance(empty, { limit: 5, since: null, event: null })).rows, []);
  assert.deepEqual((await readTools(empty)).tools, []);
  assert.deepEqual((await readHumanRequired(empty)).items, []);
  const overview = await readOverview(configFor(empty));
  assert.equal(overview.lastCycle, null);
  assert.equal(overview.counts.governanceRows, 0);
});
